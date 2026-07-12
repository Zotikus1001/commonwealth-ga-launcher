import { execFile } from 'child_process';
import { readFile, readdir } from 'fs/promises';
import type { Log } from './Log';

export const FALLBACK_TEXTURE_POOL_MB = 512;
export const MAX_TEXTURE_POOL_MB = 2_048;
const TEXTURE_POOL_GRANULARITY_MB = 64;

export interface GpuMemoryDependencies {
  run(command: string, args: string[]): Promise<string>;
  readText(path: string): Promise<string>;
  listDirectory(path: string): Promise<string[]>;
}

export interface GpuMemorySelection {
  adapterIndex: number;
  vramMb: number | null;
  texturePoolMb: number;
  source: 'windows' | 'linux-drm' | 'linux-nvidia' | 'fallback';
}

const WINDOWS_GPU_QUERY = String.raw`
$classPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
$registry = @(
  Get-ChildItem -LiteralPath $classPath -ErrorAction SilentlyContinue | ForEach-Object {
    Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
  }
)
$controllers = @(Get-CimInstance Win32_VideoController -ErrorAction Stop | Sort-Object DeviceID)
$result = foreach ($controller in $controllers) {
  [uint64]$bytes = 0
  if ($null -ne $controller.AdapterRAM) { $bytes = [uint64]$controller.AdapterRAM }
  $pnp = [string]$controller.PNPDeviceID
  foreach ($entry in $registry) {
    $matching = [string]$entry.MatchingDeviceId
    if (-not $matching -or -not $pnp.StartsWith($matching, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    $qword = $entry.'HardwareInformation.qwMemorySize'
    $dword = $entry.'HardwareInformation.MemorySize'
    if ($null -ne $qword -and [uint64]$qword -gt $bytes) { $bytes = [uint64]$qword }
    if ($null -ne $dword -and [uint64]$dword -gt $bytes) { $bytes = [uint64]$dword }
  }
  [pscustomobject]@{ bytes = $bytes.ToString() }
}
@($result) | ConvertTo-Json -Compress
`;

const defaultDependencies: GpuMemoryDependencies = {
  run: (command, args) =>
    new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        {
          encoding: 'utf-8',
          timeout: 5_000,
          windowsHide: true,
          maxBuffer: 256 * 1_024
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout))
      );
    }),
  readText: (path) => readFile(path, { encoding: 'utf-8' }),
  listDirectory: (path) => readdir(path)
};

function finitePositive(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function selectTexturePoolMb(vramMb: number | null): number {
  if (!vramMb || !Number.isFinite(vramMb) || vramMb <= 0) return FALLBACK_TEXTURE_POOL_MB;
  const quarter = Math.floor(vramMb / 4 / TEXTURE_POOL_GRANULARITY_MB) * TEXTURE_POOL_GRANULARITY_MB;
  return Math.max(FALLBACK_TEXTURE_POOL_MB, Math.min(MAX_TEXTURE_POOL_MB, quarter));
}

export function parseWindowsGpuBytes(output: string, adapterIndex: number): number | null {
  try {
    const parsed = JSON.parse(output) as unknown;
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const entry = entries[adapterIndex];
    if (!entry || typeof entry !== 'object') return null;
    return finitePositive((entry as { bytes?: unknown }).bytes);
  } catch {
    return null;
  }
}

function parseMemoryMb(output: string): number | null {
  return finitePositive(output.match(/\d+(?:\.\d+)?/)?.[0]);
}

function cardNumber(name: string): number {
  return Number(name.slice(4));
}

async function linuxGpuBytes(
  adapterIndex: number,
  dependencies: GpuMemoryDependencies
): Promise<{ bytes: number; source: GpuMemorySelection['source'] } | null> {
  let cards: string[] = [];
  try {
    cards = (await dependencies.listDirectory('/sys/class/drm'))
      .filter((name) => /^card\d+$/.test(name))
      .sort((left, right) => cardNumber(left) - cardNumber(right));
  } catch {
    // Some containers do not expose DRM sysfs; nvidia-smi and fallback remain available.
  }

  const card = cards[adapterIndex];
  if (card) {
    const devicePath = `/sys/class/drm/${card}/device`;
    try {
      const bytes = finitePositive((await dependencies.readText(`${devicePath}/mem_info_vram_total`)).trim());
      if (bytes) return { bytes, source: 'linux-drm' };
    } catch {
      // Proprietary NVIDIA drivers do not expose mem_info_vram_total.
    }
    try {
      const uevent = await dependencies.readText(`${devicePath}/uevent`);
      const pciAddress = uevent.match(/^PCI_SLOT_NAME=(.+)$/m)?.[1]?.trim();
      if (pciAddress) {
        const output = await dependencies.run('nvidia-smi', [
          `--id=${pciAddress}`,
          '--query-gpu=memory.total',
          '--format=csv,noheader,nounits'
        ]);
        const memoryMb = parseMemoryMb(output);
        if (memoryMb) return { bytes: memoryMb * 1_024 * 1_024, source: 'linux-nvidia' };
      }
    } catch {
      // Non-NVIDIA adapters and systems without nvidia-smi continue to fallback.
    }
  }

  try {
    const output = await dependencies.run('nvidia-smi', [
      `--id=${adapterIndex}`,
      '--query-gpu=memory.total',
      '--format=csv,noheader,nounits'
    ]);
    const memoryMb = parseMemoryMb(output);
    return memoryMb
      ? { bytes: memoryMb * 1_024 * 1_024, source: 'linux-nvidia' }
      : null;
  } catch {
    return null;
  }
}

export class GpuMemoryDetector {
  constructor(
    private readonly platform: NodeJS.Platform,
    private readonly log: Pick<Log, 'info' | 'warn'>,
    private readonly dependencies: GpuMemoryDependencies = defaultDependencies
  ) {}

  async select(adapterIndex: number): Promise<GpuMemorySelection> {
    const selectedAdapter = Number.isInteger(adapterIndex) && adapterIndex >= 0 ? adapterIndex : 0;
    let bytes: number | null = null;
    let source: GpuMemorySelection['source'] = 'fallback';
    try {
      if (this.platform === 'win32') {
        const output = await this.dependencies.run('powershell.exe', [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          WINDOWS_GPU_QUERY
        ]);
        bytes = parseWindowsGpuBytes(output, selectedAdapter);
        if (bytes) source = 'windows';
      } else if (this.platform === 'linux') {
        const detected = await linuxGpuBytes(selectedAdapter, this.dependencies);
        bytes = detected?.bytes ?? null;
        source = detected?.source ?? 'fallback';
      }
    } catch (error) {
      this.log.warn(`GPU memory detection failed: ${(error as Error).message}`);
    }

    const vramMb = bytes ? Math.floor(bytes / (1_024 * 1_024)) : null;
    const texturePoolMb = selectTexturePoolMb(vramMb);
    this.log.info(
      `client performance: adapter ${selectedAdapter}, VRAM ${vramMb ?? 'unavailable'} MB, ` +
        `texture pool ${texturePoolMb} MB (${source})`
    );
    return { adapterIndex: selectedAdapter, vramMb, texturePoolMb, source };
  }
}

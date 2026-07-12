import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from 'fs/promises';
import { join } from 'path';
import { x as extractTar } from 'tar';
import { LAUNCHER_CONFIG } from '@shared/generatedLauncherConfig';
import type { DxvkRendererSetting, DxvkState } from '@shared/types';
import { downloadToFile, type DownloadProgress } from './Download';
import {
  ensureDxvkRenderer,
  isDxvkRendererSnapshot,
  readDxvkRendererSnapshot,
  restoreDxvkRenderer,
  type DxvkRendererSnapshot
} from './IniFixes';
import type { GameInstall } from './InstallLocator';
import type { Log } from './Log';

export const DXVK_ARCHIVE_DLL_NAMES = [
  'd3d9.dll',
  'd3d10core.dll',
  'd3d11.dll',
  'dxgi.dll'
] as const;

export const DXVK_ACTIVE_DLL_NAMES = ['d3d9.dll'] as const;

// GA's native-Windows D3D10 frontend mixes system DXGI adapters with DXVK's D3D11 device and
// fails CreateSwapChain with E_NOINTERFACE. Only the self-contained D3D9 wrapper is safe to test.

export type DxvkDllName = (typeof DXVK_ARCHIVE_DLL_NAMES)[number];
export type DxvkActiveDllName = (typeof DXVK_ACTIVE_DLL_NAMES)[number];

export interface DxvkDefinition {
  version: string;
  archiveUrl: string;
  archiveSha256: string;
  dllSha256: Record<DxvkActiveDllName, string>;
}

interface MarkerFile {
  originalSha256: string | null;
  dxvkSha256: string;
  backupName: string;
}

interface DxvkMarker {
  schemaVersion: 1 | 2 | 3;
  owner: 'commonwealth-ga-launcher';
  version: string;
  phase: 'activating' | 'active' | 'restoring';
  files: Partial<Record<DxvkDllName, MarkerFile>>;
  originalRenderer?: {
    setting: DxvkRendererSetting;
    snapshot: DxvkRendererSnapshot;
  };
}

const MARKER_NAME = '.commonwealth-dxvk.json';
const MARKER_TEMP_NAME = '.commonwealth-dxvk.json.tmp';
const BACKUP_SUFFIX = '.commonwealth-original';
const PAYLOAD_DIRECTORY = 'payload';
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const DEFAULT_DEFINITION: DxvkDefinition = {
  version: LAUNCHER_CONFIG.dxvk.version,
  archiveUrl: LAUNCHER_CONFIG.dxvk.archiveUrl,
  archiveSha256: LAUNCHER_CONFIG.dxvk.archiveSha256,
  dllSha256: { ...LAUNCHER_CONFIG.dxvk.dllSha256 }
};

function backupName(name: DxvkDllName): string {
  return `${name}${BACKUP_SUFFIX}`;
}

function markerDllNames(marker: DxvkMarker): readonly DxvkDllName[] {
  return marker.schemaVersion === 1 ? DXVK_ARCHIVE_DLL_NAMES : DXVK_ACTIVE_DLL_NAMES;
}

function markerFile(marker: DxvkMarker, name: DxvkDllName): MarkerFile {
  const file = marker.files[name];
  if (!file) throw new Error(`DXVK/Vulkan recovery marker is missing ${name} metadata`);
  return file;
}

function rendererSettingFromSnapshot(snapshot: DxvkRendererSnapshot): DxvkRendererSetting {
  if (!snapshot.hadSystemSettings) return 'unknown';
  return detectConfiguredRenderer(`[SystemSettings]\n${snapshot.directives.join('\n')}`);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function launchSafeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    (error as NodeJS.ErrnoException).code ?? message.match(/\b(EACCES|EPERM|EBUSY)\b/)?.[1];
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
    return new Error(
      `The game or another tool is using its graphics files. Close it and try again (${code}).`
    );
  }
  return error instanceof Error ? error : new Error(message);
}

async function exists(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile()) throw new Error(`${path} is not a regular file`);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function sha256File(path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(path);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('error', reject);
    input.once('end', () => resolve(hash.digest('hex')));
  });
}

export function detectConfiguredRenderer(text: string): DxvkRendererSetting {
  let section = '';
  let allowD3d10: boolean | null = null;
  for (const line of text.split(/\r\n|\n|\r/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('//')) continue;
    const sectionMatch = trimmed.match(/^\[([^\]]+)]\s*(?:[;#].*)?$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      continue;
    }
    if (section !== 'systemsettings') continue;
    if (/^-AllowD3D10(?:\s*=.*)?$/i.test(trimmed)) {
      allowD3d10 = null;
      continue;
    }
    const assignment = trimmed.match(
      /^[+.]?AllowD3D10\s*=\s*(True|False)\s*(?:[;#].*)?$/i
    );
    if (assignment) allowD3d10 = assignment[1].toLowerCase() === 'true';
  }
  return allowD3d10 === true ? 'directx-10' : allowD3d10 === false ? 'directx-9' : 'unknown';
}

function parseMarker(value: unknown): DxvkMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('DXVK/Vulkan recovery marker is not an object');
  }
  const marker = value as Partial<DxvkMarker>;
  if (
    (marker.schemaVersion !== 1 && marker.schemaVersion !== 2 && marker.schemaVersion !== 3) ||
    marker.owner !== 'commonwealth-ga-launcher' ||
    typeof marker.version !== 'string' ||
    !['activating', 'active', 'restoring'].includes(marker.phase ?? '') ||
    !marker.files ||
    typeof marker.files !== 'object' ||
    Array.isArray(marker.files)
  ) {
    throw new Error('DXVK/Vulkan recovery marker has unsupported metadata');
  }
  const names = marker.schemaVersion === 1 ? DXVK_ARCHIVE_DLL_NAMES : DXVK_ACTIVE_DLL_NAMES;
  if (
    marker.schemaVersion !== 1 &&
    DXVK_ARCHIVE_DLL_NAMES.some(
      (name) =>
        !(DXVK_ACTIVE_DLL_NAMES as readonly string[]).includes(name) && marker.files?.[name]
    )
  ) {
    throw new Error('DXVK/Vulkan recovery marker contains unexpected graphics files');
  }
  for (const name of names) {
    const file = marker.files[name];
    if (
      !file ||
      typeof file !== 'object' ||
      file.backupName !== backupName(name) ||
      !SHA256_PATTERN.test(file.dxvkSha256) ||
      !(file.originalSha256 === null || SHA256_PATTERN.test(file.originalSha256))
    ) {
      throw new Error(`DXVK/Vulkan recovery marker has invalid ${name} metadata`);
    }
  }
  if (marker.schemaVersion === 3) {
    const renderer = marker.originalRenderer;
    if (
      !renderer ||
      !['directx-9', 'directx-10', 'unknown'].includes(renderer.setting) ||
      !isDxvkRendererSnapshot(renderer.snapshot) ||
      rendererSettingFromSnapshot(renderer.snapshot) !== renderer.setting
    ) {
      throw new Error('DXVK/Vulkan recovery marker has invalid renderer metadata');
    }
  }
  return marker as DxvkMarker;
}

async function readRendererSetting(configDir: string): Promise<DxvkRendererSetting> {
  try {
    const text = await readFile(join(configDir, 'TgEngine.ini'), { encoding: 'utf-8' });
    return detectConfiguredRenderer(text);
  } catch (error) {
    if (isMissing(error)) return 'unknown';
    throw error;
  }
}

export function unavailableDxvkState(platform: NodeJS.Platform): DxvkState {
  return {
    status: platform === 'win32' ? 'native' : 'unsupported',
    version: DEFAULT_DEFINITION.version,
    rendererSetting: 'unknown',
    detail:
      platform === 'win32'
        ? 'No valid game installation is available for DXVK/Vulkan inspection.'
        : 'DXVK/Vulkan is currently available only on Windows.',
    canRestore: false
  };
}

export class DxvkManager {
  private readonly root: string;
  private readonly payloadDir: string;
  readonly logDir: string;
  readonly stateCacheDir: string;

  constructor(
    userDataDir: string,
    private readonly log: Pick<Log, 'info' | 'warn' | 'error'>,
    private readonly definition: DxvkDefinition = DEFAULT_DEFINITION
  ) {
    this.root = join(userDataDir, 'dxvk', definition.version);
    this.payloadDir = join(this.root, PAYLOAD_DIRECTORY);
    this.logDir = join(userDataDir, 'logs', 'dxvk');
    this.stateCacheDir = join(userDataDir, 'dxvk', 'state-cache');
  }

  launchEnvironment(): NodeJS.ProcessEnv {
    return {
      DXVK_LOG_PATH: this.logDir,
      DXVK_STATE_CACHE_PATH: this.stateCacheDir
    };
  }

  private markerPath(install: GameInstall): string {
    return join(install.binariesDir, MARKER_NAME);
  }

  private async readMarker(install: GameInstall): Promise<DxvkMarker | null> {
    try {
      const raw = await readFile(this.markerPath(install), { encoding: 'utf-8' });
      return parseMarker(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private async writeMarker(install: GameInstall, marker: DxvkMarker): Promise<void> {
    const temp = join(install.binariesDir, MARKER_TEMP_NAME);
    await writeFile(temp, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf-8' });
    await rename(temp, this.markerPath(install));
  }

  private async hasAnyBackups(install: GameInstall): Promise<boolean> {
    for (const name of DXVK_ARCHIVE_DLL_NAMES) {
      if (await exists(join(install.binariesDir, backupName(name)))) return true;
    }
    return false;
  }

  private async hasAnyLocalGraphicsDlls(install: GameInstall): Promise<boolean> {
    for (const name of DXVK_ACTIVE_DLL_NAMES) {
      if (await exists(join(install.binariesDir, name))) return true;
    }
    return false;
  }

  private async activeFilesMatch(install: GameInstall, marker: DxvkMarker): Promise<boolean> {
    for (const name of markerDllNames(marker)) {
      const record = markerFile(marker, name);
      const target = join(install.binariesDir, name);
      if (!(await exists(target)) || (await sha256File(target)) !== record.dxvkSha256) {
        return false;
      }
      const backup = join(install.binariesDir, record.backupName);
      const originalHash = record.originalSha256;
      if (originalHash === null) {
        if (await exists(backup)) return false;
      } else if (!(await exists(backup)) || (await sha256File(backup)) !== originalHash) {
        return false;
      }
    }
    return true;
  }

  async inspect(install: GameInstall): Promise<DxvkState> {
    let rendererSetting: DxvkRendererSetting = 'unknown';
    try {
      rendererSetting = await readRendererSetting(install.configDir);
    } catch (error) {
      return {
        status: 'error',
        version: this.definition.version,
        rendererSetting,
        detail: `Could not inspect the game renderer setting: ${(error as Error).message}`,
        canRestore: false
      };
    }
    let marker: DxvkMarker | null;
    try {
      marker = await this.readMarker(install);
    } catch (error) {
      return {
        status: 'error',
        version: this.definition.version,
        rendererSetting,
        detail: `DXVK/Vulkan recovery metadata is invalid: ${(error as Error).message}`,
        canRestore: false
      };
    }
    if (marker) {
      let activeFilesMatch = false;
      try {
        activeFilesMatch = await this.activeFilesMatch(install, marker);
      } catch (error) {
        return {
          status: 'error',
          version: marker.version,
          rendererSetting,
          detail: `Could not inspect the managed DXVK/Vulkan files: ${(error as Error).message}`,
          canRestore: true
        };
      }
      if (marker.phase !== 'active' || !activeFilesMatch) {
        return {
          status: 'needs-restore',
          version: marker.version,
          rendererSetting,
          detail: 'A DXVK/Vulkan file change was interrupted or modified. The launcher will recover on the next launch attempt.',
          canRestore: true
        };
      }
      return {
        status: 'active',
        version: marker.version,
        rendererSetting,
        detail: `DXVK/Vulkan ${marker.version} is active for game launches.`,
        canRestore: true
      };
    }
    let hasBackups: boolean;
    let hasGraphicsDlls: boolean;
    try {
      [hasBackups, hasGraphicsDlls] = await Promise.all([
        this.hasAnyBackups(install),
        this.hasAnyLocalGraphicsDlls(install)
      ]);
    } catch (error) {
      return {
        status: 'error',
        version: this.definition.version,
        rendererSetting,
        detail: `Could not inspect the game graphics files: ${(error as Error).message}`,
        canRestore: false
      };
    }
    if (hasBackups) {
      return {
        status: 'error',
        version: this.definition.version,
        rendererSetting,
        detail: 'Unowned Commonwealth graphics backups were found. They were left untouched.',
        canRestore: false
      };
    }
    if (hasGraphicsDlls) {
      return {
        status: 'external',
        version: this.definition.version,
        rendererSetting,
        detail: 'An existing graphics wrapper is present. DXVK/Vulkan will preserve and restore it.',
        canRestore: false
      };
    }
    return {
      status: 'native',
      version: this.definition.version,
      rendererSetting,
      detail: 'The game is using its existing Direct3D configuration.',
      canRestore: false
    };
  }

  private async payloadIsValid(): Promise<boolean> {
    for (const name of DXVK_ACTIVE_DLL_NAMES) {
      const path = join(this.payloadDir, name);
      if (!(await exists(path)) || (await sha256File(path)) !== this.definition.dllSha256[name]) {
        return false;
      }
    }
    return true;
  }

  private async pruneInactivePayloadFiles(): Promise<void> {
    for (const name of DXVK_ARCHIVE_DLL_NAMES) {
      if ((DXVK_ACTIVE_DLL_NAMES as readonly string[]).includes(name)) continue;
      await rm(join(this.payloadDir, name), { force: true });
    }
  }

  private async ensurePayload(onProgress: (progress: DownloadProgress) => void): Promise<void> {
    if (await this.payloadIsValid()) {
      await this.pruneInactivePayloadFiles();
      return;
    }
    await mkdir(this.root, { recursive: true });
    await rm(this.payloadDir, { recursive: true, force: true });
    const token = `${process.pid}-${Date.now()}`;
    const staging = join(this.root, `staging-${token}`);
    const archive = join(this.root, `download-${token}.tar.gz`);
    await mkdir(staging, { recursive: true });
    try {
      this.log.info(`DXVK/Vulkan ${this.definition.version}: downloading pinned official archive`);
      await downloadToFile(this.definition.archiveUrl, archive, onProgress, {
        idleTimeoutMs: 30_000,
        maxBytes: MAX_ARCHIVE_BYTES
      });
      const archiveHash = await sha256File(archive);
      if (archiveHash !== this.definition.archiveSha256) {
        throw new Error('downloaded DXVK/Vulkan archive failed SHA-256 verification');
      }
      const wanted = new Set(
        DXVK_ACTIVE_DLL_NAMES.map((name) => `dxvk-${this.definition.version}/x32/${name}`)
      );
      await extractTar({
        file: archive,
        cwd: staging,
        gzip: true,
        strip: 2,
        preservePaths: false,
        filter: (path) => wanted.has(path.replace(/\\/g, '/'))
      });
      for (const name of DXVK_ACTIVE_DLL_NAMES) {
        const path = join(staging, name);
        if (!(await exists(path)) || (await sha256File(path)) !== this.definition.dllSha256[name]) {
          throw new Error(`extracted ${name} failed SHA-256 verification`);
        }
      }
      await rename(staging, this.payloadDir);
      this.log.info(`DXVK/Vulkan ${this.definition.version}: verified x32 renderer payload cached`);
    } finally {
      await rm(archive, { force: true }).catch(() => {});
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  private definitionMatches(marker: DxvkMarker): boolean {
    return (
      marker.schemaVersion === 3 &&
      marker.version === this.definition.version &&
      DXVK_ACTIVE_DLL_NAMES.every(
        (name) => markerFile(marker, name).dxvkSha256 === this.definition.dllSha256[name]
      )
    );
  }

  private async activate(
    install: GameInstall,
    originalRenderer: NonNullable<DxvkMarker['originalRenderer']>
  ): Promise<void> {
    if (await this.hasAnyBackups(install)) {
      throw new Error('existing Commonwealth graphics backups prevent safe DXVK/Vulkan activation');
    }
    const files: DxvkMarker['files'] = {};
    for (const name of DXVK_ACTIVE_DLL_NAMES) {
      const target = join(install.binariesDir, name);
      files[name] = {
        originalSha256: (await exists(target)) ? await sha256File(target) : null,
        dxvkSha256: this.definition.dllSha256[name],
        backupName: backupName(name)
      };
    }
    const marker: DxvkMarker = {
      schemaVersion: 3,
      owner: 'commonwealth-ga-launcher',
      version: this.definition.version,
      phase: 'activating',
      files,
      originalRenderer
    };
    await this.writeMarker(install, marker);
    try {
      await ensureDxvkRenderer(install, this.log);
      if ((await readRendererSetting(install.configDir)) !== 'directx-9') {
        throw new Error('Global Agenda could not be switched to DirectX 9 for DXVK/Vulkan.');
      }
      for (const name of DXVK_ACTIVE_DLL_NAMES) {
        const target = join(install.binariesDir, name);
        const record = markerFile(marker, name);
        if (record.originalSha256 !== null) {
          await rename(target, join(install.binariesDir, record.backupName));
        }
      }
      for (const name of DXVK_ACTIVE_DLL_NAMES) {
        const target = join(install.binariesDir, name);
        const temp = `${target}.commonwealth-dxvk.tmp`;
        await copyFile(join(this.payloadDir, name), temp);
        if ((await sha256File(temp)) !== markerFile(marker, name).dxvkSha256) {
          throw new Error(`copied ${name} failed verification`);
        }
        await rename(temp, target);
      }
      marker.phase = 'active';
      await this.writeMarker(install, marker);
      await mkdir(this.logDir, { recursive: true });
      await mkdir(this.stateCacheDir, { recursive: true });
      this.log.info(`DXVK/Vulkan ${this.definition.version}: activated for Windows game launches`);
    } catch (error) {
      for (const name of DXVK_ACTIVE_DLL_NAMES) {
        await rm(join(install.binariesDir, `${name}.commonwealth-dxvk.tmp`), { force: true }).catch(
          () => {}
        );
      }
      try {
        await this.restoreManaged(install);
      } catch (restoreError) {
        throw new Error(
          `${(error as Error).message}; automatic restoration also failed: ${(restoreError as Error).message}`
        );
      }
      throw error;
    }
  }

  private async restoreManaged(install: GameInstall): Promise<boolean> {
    const marker = await this.readMarker(install);
    if (!marker) return false;
    marker.phase = 'restoring';
    await this.writeMarker(install, marker);
    for (const name of markerDllNames(marker)) {
      const record = markerFile(marker, name);
      const target = join(install.binariesDir, name);
      const backup = join(install.binariesDir, record.backupName);
      if (await exists(target)) {
        const targetHash = await sha256File(target);
        if (targetHash === record.dxvkSha256) {
          await rm(target);
        } else if (targetHash !== record.originalSha256) {
          throw new Error(`${name} changed after DXVK/Vulkan activation; it was left untouched`);
        }
      }
      if (record.originalSha256 === null) {
        if (await exists(backup)) {
          throw new Error(`${record.backupName} was not expected and was left untouched`);
        }
        continue;
      }
      if (await exists(target)) {
        if ((await sha256File(target)) !== record.originalSha256) {
          throw new Error(`${name} no longer matches its recorded original`);
        }
        if (await exists(backup)) {
          throw new Error(`${record.backupName} conflicts with the restored original`);
        }
        continue;
      }
      if (!(await exists(backup)) || (await sha256File(backup)) !== record.originalSha256) {
        throw new Error(`${record.backupName} is missing or no longer matches the original`);
      }
      await rename(backup, target);
    }
    for (const name of markerDllNames(marker)) {
      await rm(join(install.binariesDir, `${name}.commonwealth-dxvk.tmp`), { force: true });
    }
    if (marker.schemaVersion === 3) {
      await restoreDxvkRenderer(install, marker.originalRenderer!.snapshot, this.log);
    }
    await rm(this.markerPath(install));
    await rm(join(install.binariesDir, MARKER_TEMP_NAME), { force: true });
    this.log.info('DXVK/Vulkan: restored the previous Windows graphics and renderer state');
    return true;
  }

  async prepareForLaunch(
    install: GameInstall,
    useDxvk: boolean,
    onProgress: (progress: DownloadProgress) => void = () => {}
  ): Promise<DxvkState> {
    try {
      const marker = await this.readMarker(install);
      if (!useDxvk) {
        if (marker) await this.restoreManaged(install);
        return this.inspect(install);
      }
      if (marker) {
        if (
          marker.phase === 'active' &&
          this.definitionMatches(marker) &&
          (await this.activeFilesMatch(install, marker))
        ) {
          await ensureDxvkRenderer(install, this.log);
          return this.inspect(install);
        }
        await this.restoreManaged(install);
      }
      await this.ensurePayload(onProgress);
      const snapshot = await readDxvkRendererSnapshot(install);
      await this.activate(install, {
        setting: rendererSettingFromSnapshot(snapshot),
        snapshot
      });
      return this.inspect(install);
    } catch (error) {
      throw launchSafeError(error);
    }
  }

  async restore(install: GameInstall): Promise<DxvkState> {
    try {
      await this.restoreManaged(install);
      return this.inspect(install);
    } catch (error) {
      throw launchSafeError(error);
    }
  }
}

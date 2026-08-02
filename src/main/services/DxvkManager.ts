import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm
} from 'fs/promises';
import { dirname, join } from 'path';
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
import {
  managedInstallStateDirectory,
  managedInstallStatePath,
  managedIniBackupDirectory,
  readMigratedManagedState,
  writeManagedState
} from './ManagedInstallState';

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

export interface DxvkProgress extends DownloadProgress {
  version: string;
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

interface RestoreFilePlan {
  name: DxvkDllName;
  record: MarkerFile;
  target: string;
  backup: string;
  recovery: string;
  targetSha256: string | null;
  backupSha256: string | null;
  recoverySha256: string | null;
  originalIsSameDxvk: boolean;
  restoreSource: string | null;
}

const LEGACY_MARKER_NAME = '.commonwealth-dxvk.json';
const LEGACY_MARKER_TEMP_NAME = '.commonwealth-dxvk.json.tmp';
const STATE_FILE_NAME = 'dxvk.json';
const BACKUP_SUFFIX = '.commonwealth-original';
const RECOVERY_DIRECTORY = 'dxvk-originals';
const PAYLOAD_DIRECTORY = 'payload';
const MAX_ARCHIVE_BYTES = 24 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const DEFAULT_DXVK_VERSION = LAUNCHER_CONFIG.dxvk.defaultVersion;
const DEFAULT_DEFINITIONS: readonly DxvkDefinition[] = LAUNCHER_CONFIG.dxvk.versions.map(
  (definition) => ({
    version: definition.version,
    archiveUrl: definition.archiveUrl,
    archiveSha256: definition.archiveSha256,
    dllSha256: { ...definition.dllSha256 }
  })
);

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

async function sha256IfPresent(path: string): Promise<string | null> {
  return (await exists(path)) ? sha256File(path) : null;
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

export function unavailableDxvkState(
  platform: NodeJS.Platform,
  version: string = DEFAULT_DXVK_VERSION
): DxvkState {
  return {
    status: platform === 'win32' ? 'native' : 'unsupported',
    version,
    rendererSetting: 'unknown',
    detail:
      platform === 'win32'
        ? 'No valid game installation is available for DXVK/Vulkan inspection.'
        : 'DXVK/Vulkan is currently available only on Windows.',
    canRestore: false
  };
}

export class DxvkManager {
  private readonly definitions: readonly DxvkDefinition[];
  private readonly defaultVersion: string;
  readonly logDir: string;
  readonly stateCacheDir: string;

  constructor(
    private readonly userDataDir: string,
    private readonly log: Pick<Log, 'info' | 'warn' | 'error'>,
    definitions: DxvkDefinition | readonly DxvkDefinition[] = DEFAULT_DEFINITIONS
  ) {
    const configured = Array.isArray(definitions) ? definitions : [definitions];
    if (configured.length === 0) throw new Error('At least one DXVK/Vulkan version is required.');
    if (new Set(configured.map(({ version }) => version)).size !== configured.length) {
      throw new Error('DXVK/Vulkan versions must be unique.');
    }
    this.definitions = configured.map((definition) => ({
      ...definition,
      dllSha256: { ...definition.dllSha256 }
    }));
    this.defaultVersion = this.definitions.some(({ version }) => version === DEFAULT_DXVK_VERSION)
      ? DEFAULT_DXVK_VERSION
      : this.definitions[0].version;
    this.logDir = join(userDataDir, 'logs', 'dxvk');
    this.stateCacheDir = join(userDataDir, 'dxvk', 'state-cache');
  }

  private definitionFor(version = this.defaultVersion): DxvkDefinition {
    const definition = this.definitions.find((candidate) => candidate.version === version);
    if (!definition) throw new Error(`Unsupported DXVK/Vulkan version: ${version}`);
    return definition;
  }

  private root(definition: DxvkDefinition): string {
    return join(this.userDataDir, 'dxvk', definition.version);
  }

  private payloadDir(definition: DxvkDefinition): string {
    return join(this.root(definition), PAYLOAD_DIRECTORY);
  }

  launchEnvironment(): NodeJS.ProcessEnv {
    return {
      DXVK_LOG_PATH: this.logDir,
      DXVK_STATE_CACHE_PATH: this.stateCacheDir
    };
  }

  private markerPath(install: GameInstall): string {
    return managedInstallStatePath(this.userDataDir, install, STATE_FILE_NAME);
  }

  private legacyMarkerPath(install: GameInstall): string {
    return join(install.binariesDir, LEGACY_MARKER_NAME);
  }

  private recoveryDirectory(install: GameInstall): string {
    return join(managedInstallStateDirectory(this.userDataDir, install), RECOVERY_DIRECTORY);
  }

  private recoveryBackupPath(install: GameInstall, name: DxvkDllName): string {
    return join(this.recoveryDirectory(install), backupName(name));
  }

  private async readMarker(install: GameInstall): Promise<DxvkMarker | null> {
    const raw = await readMigratedManagedState(
      this.markerPath(install),
      this.legacyMarkerPath(install)
    );
    return raw === null ? null : parseMarker(JSON.parse(raw) as unknown);
  }

  private async writeMarker(install: GameInstall, marker: DxvkMarker): Promise<void> {
    await writeManagedState(
      this.markerPath(install),
      `${JSON.stringify(marker, null, 2)}\n`
    );
  }

  private async hasAnyBackups(install: GameInstall): Promise<boolean> {
    for (const name of DXVK_ARCHIVE_DLL_NAMES) {
      if (
        (await exists(join(install.binariesDir, backupName(name)))) ||
        (await exists(this.recoveryBackupPath(install, name)))
      ) {
        return true;
      }
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
      const recovery = this.recoveryBackupPath(install, name);
      const originalHash = record.originalSha256;
      if (originalHash === null) {
        if ((await exists(backup)) || (await exists(recovery))) return false;
      } else {
        const [backupHash, recoveryHash] = await Promise.all([
          sha256IfPresent(backup),
          sha256IfPresent(recovery)
        ]);
        if (
          (backupHash !== null && backupHash !== originalHash) ||
          (recoveryHash !== null && recoveryHash !== originalHash) ||
          (backupHash === null && recoveryHash === null)
        ) {
          return false;
        }
      }
    }
    return true;
  }

  async inspect(install: GameInstall, selectedVersion = this.defaultVersion): Promise<DxvkState> {
    const definition = this.definitionFor(selectedVersion);
    let rendererSetting: DxvkRendererSetting = 'unknown';
    try {
      rendererSetting = await readRendererSetting(install.configDir);
    } catch (error) {
      return {
        status: 'error',
        version: definition.version,
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
        version: definition.version,
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
        version: definition.version,
        rendererSetting,
        detail: `Could not inspect the game graphics files: ${(error as Error).message}`,
        canRestore: false
      };
    }
    if (hasBackups) {
      return {
        status: 'error',
        version: definition.version,
        rendererSetting,
        detail: 'Unowned Commonwealth graphics backups were found. They were left untouched.',
        canRestore: false
      };
    }
    if (hasGraphicsDlls) {
      return {
        status: 'external',
        version: definition.version,
        rendererSetting,
        detail: 'An existing graphics wrapper is present. DXVK/Vulkan will preserve and restore it.',
        canRestore: false
      };
    }
    return {
      status: 'native',
      version: definition.version,
      rendererSetting,
      detail: 'The game is using its existing Direct3D configuration.',
      canRestore: false
    };
  }

  private async payloadIsValid(definition: DxvkDefinition): Promise<boolean> {
    const payloadDir = this.payloadDir(definition);
    for (const name of DXVK_ACTIVE_DLL_NAMES) {
      const path = join(payloadDir, name);
      if (!(await exists(path)) || (await sha256File(path)) !== definition.dllSha256[name]) {
        return false;
      }
    }
    return true;
  }

  private async pruneInactivePayloadFiles(definition: DxvkDefinition): Promise<void> {
    const payloadDir = this.payloadDir(definition);
    for (const name of DXVK_ARCHIVE_DLL_NAMES) {
      if ((DXVK_ACTIVE_DLL_NAMES as readonly string[]).includes(name)) continue;
      await rm(join(payloadDir, name), { force: true });
    }
  }

  private async ensurePayload(
    definition: DxvkDefinition,
    onProgress: (progress: DxvkProgress) => void
  ): Promise<void> {
    const root = this.root(definition);
    const payloadDir = this.payloadDir(definition);
    if (await this.payloadIsValid(definition)) {
      await this.pruneInactivePayloadFiles(definition);
      return;
    }
    await mkdir(root, { recursive: true });
    await rm(payloadDir, { recursive: true, force: true });
    const token = `${process.pid}-${Date.now()}`;
    const staging = join(root, `staging-${token}`);
    const archive = join(root, `download-${token}.tar.gz`);
    await mkdir(staging, { recursive: true });
    try {
      this.log.info(`DXVK/Vulkan ${definition.version}: downloading pinned official archive`);
      await downloadToFile(
        definition.archiveUrl,
        archive,
        (progress) => onProgress({ ...progress, version: definition.version }),
        {
          idleTimeoutMs: 30_000,
          maxBytes: MAX_ARCHIVE_BYTES
        }
      );
      const archiveHash = await sha256File(archive);
      if (archiveHash !== definition.archiveSha256) {
        throw new Error('downloaded DXVK/Vulkan archive failed SHA-256 verification');
      }
      const wanted = new Set(
        DXVK_ACTIVE_DLL_NAMES.map((name) => `dxvk-${definition.version}/x32/${name}`)
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
        if (!(await exists(path)) || (await sha256File(path)) !== definition.dllSha256[name]) {
          throw new Error(`extracted ${name} failed SHA-256 verification`);
        }
      }
      await rename(staging, payloadDir);
      this.log.info(`DXVK/Vulkan ${definition.version}: verified x32 renderer payload cached`);
    } finally {
      await rm(archive, { force: true }).catch(() => {});
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  private definitionMatches(marker: DxvkMarker, definition: DxvkDefinition): boolean {
    return (
      marker.schemaVersion === 3 &&
      marker.version === definition.version &&
      DXVK_ACTIVE_DLL_NAMES.every(
        (name) => markerFile(marker, name).dxvkSha256 === definition.dllSha256[name]
      )
    );
  }

  private async copyVerified(
    source: string,
    destination: string,
    expectedSha256: string,
    label: string
  ): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    const temp = `${destination}.${process.pid}-${Date.now()}.tmp`;
    try {
      await copyFile(source, temp);
      if ((await sha256File(temp)) !== expectedSha256) {
        throw new Error(`${label} failed SHA-256 verification`);
      }
      await rename(temp, destination);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  private async activate(
    install: GameInstall,
    definition: DxvkDefinition,
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
        dxvkSha256: definition.dllSha256[name],
        backupName: backupName(name)
      };
    }
    const marker: DxvkMarker = {
      schemaVersion: 3,
      owner: 'commonwealth-ga-launcher',
      version: definition.version,
      phase: 'activating',
      files,
      originalRenderer
    };
    await this.writeMarker(install, marker);
    try {
      await ensureDxvkRenderer(
        install,
        this.log,
        managedIniBackupDirectory(this.userDataDir, install)
      );
      if ((await readRendererSetting(install.configDir)) !== 'directx-9') {
        throw new Error('Global Agenda could not be switched to DirectX 9 for DXVK/Vulkan.');
      }
      for (const name of DXVK_ACTIVE_DLL_NAMES) {
        const target = join(install.binariesDir, name);
        const record = markerFile(marker, name);
        if (record.originalSha256 !== null) {
          const backup = join(install.binariesDir, record.backupName);
          await this.copyVerified(
            target,
            this.recoveryBackupPath(install, name),
            record.originalSha256,
            `${name} recovery backup`
          );
          await rename(target, backup);
          if ((await sha256File(backup)) !== record.originalSha256) {
            throw new Error(`${record.backupName} failed SHA-256 verification`);
          }
        }
      }
      for (const name of DXVK_ACTIVE_DLL_NAMES) {
        const target = join(install.binariesDir, name);
        await this.copyVerified(
          join(this.payloadDir(definition), name),
          target,
          markerFile(marker, name).dxvkSha256,
          `copied ${name}`
        );
      }
      marker.phase = 'active';
      await this.writeMarker(install, marker);
      await mkdir(this.logDir, { recursive: true });
      await mkdir(this.stateCacheDir, { recursive: true });
      this.log.info(`DXVK/Vulkan ${definition.version}: activated for Windows game launches`);
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

  private definitionForOriginalHash(
    name: DxvkDllName,
    sha256: string
  ): DxvkDefinition | null {
    if (!(DXVK_ACTIVE_DLL_NAMES as readonly string[]).includes(name)) return null;
    const activeName = name as DxvkActiveDllName;
    return (
      this.definitions.find((definition) => definition.dllSha256[activeName] === sha256) ?? null
    );
  }

  private async buildRestorePlans(
    install: GameInstall,
    marker: DxvkMarker,
    onProgress: (progress: DxvkProgress) => void
  ): Promise<RestoreFilePlan[]> {
    const plans: RestoreFilePlan[] = [];
    for (const name of markerDllNames(marker)) {
      const record = markerFile(marker, name);
      const target = join(install.binariesDir, name);
      const backup = join(install.binariesDir, record.backupName);
      const recovery = this.recoveryBackupPath(install, name);
      const [targetSha256, backupSha256, recoverySha256] = await Promise.all([
        sha256IfPresent(target),
        sha256IfPresent(backup),
        sha256IfPresent(recovery)
      ]);
      const originalIsSameDxvk = record.originalSha256 === record.dxvkSha256;
      if (
        targetSha256 !== null &&
        targetSha256 !== record.dxvkSha256 &&
        targetSha256 !== record.originalSha256
      ) {
        throw new Error(`${name} changed after DXVK/Vulkan activation; it was left untouched`);
      }
      if (record.originalSha256 === null) {
        if (backupSha256 !== null || recoverySha256 !== null) {
          throw new Error(`${record.backupName} was not expected and was left untouched`);
        }
        plans.push({
          name,
          record,
          target,
          backup,
          recovery,
          targetSha256,
          backupSha256,
          recoverySha256,
          originalIsSameDxvk,
          restoreSource: null
        });
        continue;
      }
      if (backupSha256 !== null && backupSha256 !== record.originalSha256) {
        throw new Error(
          `${record.backupName} no longer matches the recorded original; it was left untouched`
        );
      }
      if (recoverySha256 !== null && recoverySha256 !== record.originalSha256) {
        throw new Error(`${name} launcher recovery copy no longer matches the recorded original`);
      }
      let restoreSource: string | null = null;
      if (!originalIsSameDxvk && targetSha256 !== record.originalSha256) {
        restoreSource = backupSha256 === record.originalSha256
          ? backup
          : recoverySha256 === record.originalSha256
            ? recovery
            : null;
        if (!restoreSource) {
          const originalDefinition = this.definitionForOriginalHash(name, record.originalSha256);
          if (!originalDefinition) {
            throw new Error(
              `${record.backupName} is missing and no verified recovery copy is available`
            );
          }
          await this.ensurePayload(originalDefinition, onProgress);
          restoreSource = join(this.payloadDir(originalDefinition), name);
          if ((await sha256File(restoreSource)) !== record.originalSha256) {
            throw new Error(`${name} official recovery payload failed SHA-256 verification`);
          }
        }
      }
      plans.push({
        name,
        record,
        target,
        backup,
        recovery,
        targetSha256,
        backupSha256,
        recoverySha256,
        originalIsSameDxvk,
        restoreSource
      });
    }
    return plans;
  }

  private async removeVerified(path: string, expectedSha256: string, label: string): Promise<void> {
    const actualSha256 = await sha256IfPresent(path);
    if (actualSha256 === null) return;
    if (actualSha256 !== expectedSha256) {
      throw new Error(`${label} changed during DXVK/Vulkan restoration; it was left untouched`);
    }
    await rm(path);
  }

  private async restoreManaged(
    install: GameInstall,
    onProgress: (progress: DxvkProgress) => void = () => {}
  ): Promise<boolean> {
    const marker = await this.readMarker(install);
    if (!marker) return false;
    const plans = await this.buildRestorePlans(install, marker, onProgress);
    marker.phase = 'restoring';
    await this.writeMarker(install, marker);
    for (const plan of plans) {
      if (plan.targetSha256 === plan.record.dxvkSha256) {
        await this.removeVerified(plan.target, plan.record.dxvkSha256, plan.name);
      }
      if (plan.record.originalSha256 === null || plan.originalIsSameDxvk) {
        if (plan.backupSha256 !== null) {
          await this.removeVerified(plan.backup, plan.backupSha256, plan.record.backupName);
        }
        if (plan.recoverySha256 !== null) {
          await this.removeVerified(
            plan.recovery,
            plan.recoverySha256,
            `${plan.name} launcher recovery copy`
          );
        }
        continue;
      }
      if (plan.targetSha256 !== plan.record.originalSha256) {
        if (!plan.restoreSource) {
          throw new Error(`${plan.name} has no verified original available for restoration`);
        }
        if (await exists(plan.target)) {
          throw new Error(
            `${plan.name} changed during DXVK/Vulkan restoration; it was left untouched`
          );
        }
        if (plan.restoreSource === plan.backup) {
          if ((await sha256File(plan.backup)) !== plan.record.originalSha256) {
            throw new Error(`${plan.record.backupName} changed during DXVK/Vulkan restoration`);
          }
          await rename(plan.backup, plan.target);
        } else {
          await this.copyVerified(
            plan.restoreSource,
            plan.target,
            plan.record.originalSha256,
            `${plan.name} original restoration`
          );
        }
      }
      if ((await sha256File(plan.target)) !== plan.record.originalSha256) {
        throw new Error(`${plan.name} did not restore to its recorded original`);
      }
      await this.removeVerified(plan.backup, plan.record.originalSha256, plan.record.backupName);
      await this.removeVerified(
        plan.recovery,
        plan.record.originalSha256,
        `${plan.name} launcher recovery copy`
      );
    }
    for (const name of markerDllNames(marker)) {
      await rm(join(install.binariesDir, `${name}.commonwealth-dxvk.tmp`), { force: true });
    }
    if (marker.schemaVersion === 3) {
      await restoreDxvkRenderer(
        install,
        marker.originalRenderer!.snapshot,
        this.log,
        managedIniBackupDirectory(this.userDataDir, install)
      );
    }
    await rm(this.markerPath(install));
    await rm(join(install.binariesDir, LEGACY_MARKER_TEMP_NAME), { force: true });
    this.log.info('DXVK/Vulkan: restored the previous Windows graphics and renderer state');
    return true;
  }

  async prepareForLaunch(
    install: GameInstall,
    useDxvk: boolean,
    selectedVersion = this.defaultVersion,
    onProgress: (progress: DxvkProgress) => void = () => {}
  ): Promise<DxvkState> {
    try {
      const definition = this.definitionFor(selectedVersion);
      const marker = await this.readMarker(install);
      if (!useDxvk) {
        if (marker) await this.restoreManaged(install, onProgress);
        return this.inspect(install, definition.version);
      }
      let payloadReady = false;
      if (marker) {
        if (
          marker.phase === 'active' &&
          this.definitionMatches(marker, definition) &&
          (await this.activeFilesMatch(install, marker))
        ) {
          await ensureDxvkRenderer(
            install,
            this.log,
            managedIniBackupDirectory(this.userDataDir, install)
          );
          return this.inspect(install, definition.version);
        }
        await this.ensurePayload(definition, onProgress);
        payloadReady = true;
        await this.restoreManaged(install, onProgress);
      }
      if (!payloadReady) await this.ensurePayload(definition, onProgress);
      const snapshot = await readDxvkRendererSnapshot(install);
      await this.activate(
        install,
        definition,
        {
          setting: rendererSettingFromSnapshot(snapshot),
          snapshot
        }
      );
      return this.inspect(install, definition.version);
    } catch (error) {
      throw launchSafeError(error);
    }
  }

  async restore(install: GameInstall, selectedVersion = this.defaultVersion): Promise<DxvkState> {
    try {
      await this.restoreManaged(install);
      return this.inspect(install, selectedVersion);
    } catch (error) {
      throw launchSafeError(error);
    }
  }
}

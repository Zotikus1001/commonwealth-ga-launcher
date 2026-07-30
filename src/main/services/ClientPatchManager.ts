import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat
} from 'fs/promises';
import { join } from 'path';
import { LAUNCHER_CONFIG } from '@shared/generatedLauncherConfig';
import type { GameClientDllState } from '@shared/types';
import type { GameInstall } from './InstallLocator';
import type { Log } from './Log';
import { downloadToFile, fetchJson, type DownloadProgress } from './Download';
import {
  managedInstallStatePath,
  readMigratedManagedState,
  writeManagedState
} from './ManagedInstallState';

const DLL_NAME = 'dinput8.dll';
const LEGACY_MARKER_NAME = '.commonwealth-client-patches.json';
const STATE_FILE_NAME = 'client-patches.json';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ASSET_NAME = 'Commonwealth-GA-Client-Patches-x86.dll';
const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024;
const IMAGE_FILE_MACHINE_I386 = 0x014c;
const IMAGE_FILE_DLL = 0x2000;
const PE32_MAGIC = 0x010b;

export interface ClientPatchDefinition {
  enabled: boolean;
  revision: string;
  url: string;
  size: number;
  sha256: string;
  publishedAt: string | null;
}

interface ClientPatchMarker {
  schemaVersion: 1;
  owner: 'commonwealth-ga-launcher';
  phase: 'installing' | 'active';
  revision: string;
  publishedAt: string | null;
  installedSha256: string | null;
  pendingSha256: string | null;
}

type Downloader = typeof downloadToFile;
type ReleaseFetcher = (url: string) => Promise<unknown>;

interface GitHubReleaseAsset {
  name?: unknown;
  size?: unknown;
  digest?: unknown;
  browser_download_url?: unknown;
}

interface GitHubRelease {
  id?: unknown;
  draft?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function sha256File(path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(path);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('error', reject);
    input.once('end', () => resolve(hash.digest('hex')));
  });
}

function parseMarker(value: unknown): ClientPatchMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('client patch ownership marker is not an object');
  }
  const marker = value as Partial<ClientPatchMarker>;
  if (
    marker.schemaVersion !== 1 ||
    marker.owner !== 'commonwealth-ga-launcher' ||
    (marker.phase !== 'installing' && marker.phase !== 'active') ||
    typeof marker.revision !== 'string' ||
    !(
      marker.publishedAt === null ||
      (typeof marker.publishedAt === 'string' && Number.isFinite(Date.parse(marker.publishedAt)))
    ) ||
    !(marker.installedSha256 === null || SHA256_PATTERN.test(marker.installedSha256 ?? '')) ||
    !(marker.pendingSha256 === null || SHA256_PATTERN.test(marker.pendingSha256 ?? '')) ||
    (marker.phase === 'active' && marker.pendingSha256 !== null) ||
    (marker.phase === 'installing' && !marker.pendingSha256)
  ) {
    throw new Error('client patch ownership marker has unsupported metadata');
  }
  return marker as ClientPatchMarker;
}

function releaseRepository(definition: ClientPatchDefinition): {
  owner: string;
  repo: string;
} {
  const url = new URL(definition.url);
  const [, owner, repo] = url.pathname.split('/');
  if (!owner || !repo) throw new Error('client patch release URL has no repository');
  return { owner, repo };
}

function parseReleaseDefinition(
  value: GitHubRelease,
  owner: string,
  repo: string
): ClientPatchDefinition | null {
  if (value.draft === true || typeof value.id !== 'number' || !Number.isInteger(value.id)) return null;
  if (typeof value.published_at !== 'string' || !Number.isFinite(Date.parse(value.published_at))) {
    return null;
  }
  if (!Array.isArray(value.assets)) return null;
  const asset = (value.assets as GitHubReleaseAsset[]).find((candidate) => candidate.name === ASSET_NAME);
  if (
    !asset ||
    typeof asset.size !== 'number' ||
    !Number.isInteger(asset.size) ||
    asset.size < 1 ||
    asset.size > MAX_PAYLOAD_BYTES ||
    typeof asset.digest !== 'string' ||
    !asset.digest.startsWith('sha256:') ||
    !SHA256_PATTERN.test(asset.digest.slice(7)) ||
    typeof asset.browser_download_url !== 'string'
  ) {
    return null;
  }
  const url = new URL(asset.browser_download_url);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    !url.pathname.startsWith(`/${owner}/${repo}/releases/download/`) ||
    !url.pathname.endsWith(`/${ASSET_NAME}`) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    return null;
  }
  return {
    enabled: true,
    revision: String(value.id),
    url: url.toString(),
    size: asset.size,
    sha256: asset.digest.slice(7),
    publishedAt: new Date(value.published_at).toISOString()
  };
}

function mergeWineOverride(existing: string | undefined): string {
  const retained: string[] = [];
  for (const rawEntry of existing?.split(';') ?? []) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const separator = entry.indexOf('=');
    if (separator < 0) {
      retained.push(entry);
      continue;
    }
    const libraries = entry
      .slice(0, separator)
      .split(',')
      .map((library) => library.trim())
      .filter(Boolean);
    const remaining = libraries.filter(
      (library) => !/^dinput8(?:\.dll)?$/i.test(library)
    );
    if (remaining.length > 0) {
      retained.push(`${remaining.join(',')}=${entry.slice(separator + 1).trim()}`);
    }
  }
  retained.push('dinput8=n,b');
  return retained.join(';');
}

async function inspectX86PeDll(path: string): Promise<string | null> {
  const handle = await open(path, 'r');
  try {
    const file = await handle.stat();
    if (file.size < 90) return 'Local dinput8.dll is too small to be a valid Windows DLL.';

    const dosHeader = Buffer.alloc(64);
    if ((await handle.read(dosHeader, 0, dosHeader.length, 0)).bytesRead !== dosHeader.length) {
      return 'Local dinput8.dll has a truncated DOS header.';
    }
    if (dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) {
      return 'Local dinput8.dll is not a Windows PE file.';
    }

    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeaderSize = 26;
    if (peOffset < dosHeader.length || peOffset + peHeaderSize > file.size) {
      return 'Local dinput8.dll has an invalid PE header offset.';
    }

    const peHeader = Buffer.alloc(peHeaderSize);
    if ((await handle.read(peHeader, 0, peHeader.length, peOffset)).bytesRead !== peHeader.length) {
      return 'Local dinput8.dll has a truncated PE header.';
    }
    if (
      peHeader[0] !== 0x50 ||
      peHeader[1] !== 0x45 ||
      peHeader[2] !== 0 ||
      peHeader[3] !== 0
    ) {
      return 'Local dinput8.dll has an invalid PE signature.';
    }
    if (peHeader.readUInt16LE(4) !== IMAGE_FILE_MACHINE_I386) {
      return 'Local dinput8.dll must be a 32-bit x86 build for Global Agenda.';
    }
    const optionalHeaderSize = peHeader.readUInt16LE(20);
    if (
      peHeader.readUInt16LE(6) === 0 ||
      optionalHeaderSize < 2 ||
      peOffset + 24 + optionalHeaderSize > file.size
    ) {
      return 'Local dinput8.dll has an incomplete PE image header.';
    }
    if ((peHeader.readUInt16LE(22) & IMAGE_FILE_DLL) === 0) {
      return 'Local dinput8.dll is a Windows executable, not a DLL.';
    }
    if (peHeader.readUInt16LE(24) !== PE32_MAGIC) {
      return 'Local dinput8.dll must use the 32-bit PE32 format.';
    }
    return null;
  } finally {
    await handle.close();
  }
}

export function unavailableGameClientDllState(): GameClientDllState {
  return {
    status: 'unavailable',
    detail: 'Set a valid game installation to inspect dinput8.dll.',
    hasManagedMarker: false
  };
}

export class ClientPatchManager {
  constructor(
    private readonly userDataDir: string,
    private readonly log: Log,
    private readonly definition: ClientPatchDefinition = LAUNCHER_CONFIG.clientPatch,
    private readonly downloader: Downloader = downloadToFile,
    private readonly releaseFetcher: ReleaseFetcher = (url) => fetchJson<unknown>(url)
  ) {}

  private markerPath(install: GameInstall): string {
    return managedInstallStatePath(this.userDataDir, install, STATE_FILE_NAME);
  }

  private legacyMarkerPath(install: GameInstall): string {
    return join(install.binariesDir, LEGACY_MARKER_NAME);
  }

  private async readMarker(install: GameInstall): Promise<ClientPatchMarker | null> {
    const raw = await readMigratedManagedState(
      this.markerPath(install),
      this.legacyMarkerPath(install)
    );
    return raw === null ? null : parseMarker(JSON.parse(raw) as unknown);
  }

  private async writeMarker(install: GameInstall, marker: ClientPatchMarker): Promise<void> {
    await writeManagedState(
      this.markerPath(install),
      `${JSON.stringify(marker, null, 2)}\n`
    );
  }

  private async resolveTarget(install: GameInstall): Promise<string> {
    const matches = (await readdir(install.binariesDir)).filter(
      (entry) => entry.toLowerCase() === DLL_NAME
    );
    if (matches.length > 1) {
      throw new Error('multiple dinput8.dll files with conflicting filename casing are present');
    }
    return join(install.binariesDir, matches[0] ?? DLL_NAME);
  }

  private async cleanupTransactionFiles(install: GameInstall): Promise<void> {
    const names = await readdir(install.binariesDir);
    await Promise.all(
      names
        .filter(
          (name) =>
            name.startsWith('.commonwealth-client-patches-') && name.endsWith('.tmp')
        )
        .map((name) => rm(join(install.binariesDir, name), { force: true }).catch(() => {}))
    );
  }

  private async validPayload(path: string, definition: ClientPatchDefinition): Promise<boolean> {
    if (!(await isFile(path))) return false;
    return (await stat(path)).size === definition.size &&
      (await sha256File(path)) === definition.sha256;
  }

  private async ensureCached(
    definition: ClientPatchDefinition,
    onProgress: (progress: DownloadProgress) => void
  ): Promise<string> {
    const cacheDir = join(this.userDataDir, 'client-patches', definition.revision);
    await mkdir(cacheDir, { recursive: true });
    const payload = join(cacheDir, DLL_NAME);
    if (await this.validPayload(payload, definition)) return payload;

    await rm(payload, { force: true });
    const temp = join(cacheDir, `download-${randomUUID()}.tmp`);
    try {
      this.log.info(`client patches ${definition.revision}: downloading verified release payload`);
      await this.downloader(definition.url, temp, onProgress, {
        idleTimeoutMs: 30_000,
        maxBytes: definition.size
      });
      if (!(await this.validPayload(temp, definition))) {
        throw new Error('downloaded client patch DLL failed size or SHA-256 verification');
      }
      await rename(temp, payload);
      this.log.info(`client patches ${definition.revision}: verified payload cached`);
      return payload;
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async installManaged(
    install: GameInstall,
    payload: string,
    definition: ClientPatchDefinition
  ): Promise<void> {
    const target = await this.resolveTarget(install);
    const marker = await this.readMarker(install);
    const targetExists = await isFile(target);
    const targetHash = targetExists ? await sha256File(target) : null;
    if (targetHash === definition.sha256) {
      await this.writeMarker(install, {
        schemaVersion: 1,
        owner: 'commonwealth-ga-launcher',
        phase: 'active',
        revision: definition.revision,
        publishedAt: definition.publishedAt,
        installedSha256: definition.sha256,
        pendingSha256: null
      });
      await this.cleanupTransactionFiles(install);
      return;
    }

    const previousWasManaged =
      marker !== null &&
      targetHash !== null &&
      (targetHash === marker.installedSha256 || targetHash === marker.pendingSha256);
    const transaction: ClientPatchMarker = {
      schemaVersion: 1,
      owner: 'commonwealth-ga-launcher',
      phase: 'installing',
      revision: definition.revision,
      publishedAt: definition.publishedAt,
      installedSha256: previousWasManaged ? targetHash : null,
      pendingSha256: definition.sha256
    };
    const incoming = join(install.binariesDir, `.commonwealth-client-patches-${randomUUID()}.tmp`);
    const previous = targetExists
      ? join(install.binariesDir, `.commonwealth-client-patches-previous-${randomUUID()}.tmp`)
      : null;

    await copyFile(payload, incoming);
    if (!(await this.validPayload(incoming, definition))) {
      await rm(incoming, { force: true });
      throw new Error('copied client patch DLL failed verification');
    }
    await this.writeMarker(install, transaction);
    let committed = false;
    try {
      if (previous) await rename(target, previous);
      await rename(incoming, target);
      if ((await sha256File(target)) !== definition.sha256) {
        throw new Error('installed client patch DLL failed verification');
      }
      await this.writeMarker(install, {
        ...transaction,
        phase: 'active',
        installedSha256: definition.sha256,
        pendingSha256: null
      });
      committed = true;
      if (previous) await rm(previous, { force: true });
      await this.cleanupTransactionFiles(install);
      this.log.info(`client patches ${definition.revision}: installed for game launches`);
    } catch (error) {
      if (committed) {
        await this.cleanupTransactionFiles(install).catch(() => {});
        throw error;
      }
      await rm(incoming, { force: true }).catch(() => {});
      if (await isFile(target)) await rm(target, { force: true }).catch(() => {});
      if (previous && (await isFile(previous))) {
        if (previousWasManaged) await rename(previous, target).catch(() => {});
        else await rm(previous, { force: true }).catch(() => {});
      }
      if (previousWasManaged && marker) await this.writeMarker(install, marker).catch(() => {});
      else await rm(this.markerPath(install), { force: true }).catch(() => {});
      await this.cleanupTransactionFiles(install).catch(() => {});
      throw error;
    }
  }

  private async removeAnyInstalledDll(install: GameInstall): Promise<boolean> {
    const target = await this.resolveTarget(install);
    let removed = false;
    try {
      const targetInfo = await lstat(target);
      if (!targetInfo.isFile()) {
        throw new Error('dinput8.dll is not a regular file; it was left untouched');
      }
      await rm(target);
      removed = true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await Promise.all([
      rm(this.markerPath(install), { force: true }),
      rm(this.legacyMarkerPath(install), { force: true })
    ]);
    await this.cleanupTransactionFiles(install);
    this.log.info(
      removed
        ? 'client patches: existing DLL removed'
        : 'client patches: no DLL was installed'
    );
    return removed;
  }

  private async removeOwned(install: GameInstall): Promise<boolean> {
    const marker = await this.readMarker(install);
    if (!marker) {
      await this.cleanupTransactionFiles(install);
      this.log.info('client patches: no launcher-managed DLL to remove');
      return false;
    }
    const target = await this.resolveTarget(install);
    const targetExists = await isFile(target);
    if (!targetExists) {
      try {
        await lstat(target);
        throw new Error('dinput8.dll is not a regular file; it was left untouched');
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    const targetHash = targetExists ? await sha256File(target) : null;

    if (targetHash) {
      const ownedHashes = new Set<string>();
      if (marker?.installedSha256) ownedHashes.add(marker.installedSha256);
      if (marker?.pendingSha256) ownedHashes.add(marker.pendingSha256);
      if (!ownedHashes.has(targetHash)) {
        throw new Error('an unmanaged or modified dinput8.dll is installed; it was left untouched');
      }
      await rm(target);
    }
    if (marker) await rm(this.markerPath(install));
    await this.cleanupTransactionFiles(install);
    this.log.info('client patches: launcher-managed DLL removed');
    return true;
  }

  async disable(install: GameInstall): Promise<void> {
    await this.removeAnyInstalledDll(install);
  }

  async removeManaged(install: GameInstall): Promise<boolean> {
    return this.removeOwned(install);
  }

  private async validManagedMarker(install: GameInstall): Promise<ClientPatchMarker | null> {
    const marker = await this.readMarker(install);
    const target = await this.resolveTarget(install);
    if (!marker) {
      if (!this.definition.enabled || !(await this.validPayload(target, this.definition))) {
        return null;
      }
      const claimed: ClientPatchMarker = {
        schemaVersion: 1,
        owner: 'commonwealth-ga-launcher',
        phase: 'active',
        revision: this.definition.revision,
        publishedAt: this.definition.publishedAt,
        installedSha256: this.definition.sha256,
        pendingSha256: null
      };
      await this.writeMarker(install, claimed);
      await this.cleanupTransactionFiles(install);
      return claimed;
    }
    if (!(await isFile(target))) return null;
    const hash = await sha256File(target);
    if (marker.phase === 'installing' && hash === marker.pendingSha256) {
      const finalized: ClientPatchMarker = {
        ...marker,
        phase: 'active',
        installedSha256: marker.pendingSha256,
        pendingSha256: null
      };
      await this.writeMarker(install, finalized);
      await this.cleanupTransactionFiles(install);
      return finalized;
    }
    return hash === marker.installedSha256 ? marker : null;
  }

  private async installedFileMatches(
    install: GameInstall,
    definition: ClientPatchDefinition
  ): Promise<boolean> {
    const target = await this.resolveTarget(install);
    return (await isFile(target)) && (await sha256File(target)) === definition.sha256;
  }

  private async latestReleaseDefinition(): Promise<ClientPatchDefinition> {
    const { owner, repo } = releaseRepository(this.definition);
    const response = await this.releaseFetcher(
      `https://api.github.com/repos/${owner}/${repo}/releases?per_page=20`
    );
    if (!Array.isArray(response)) throw new Error('GitHub returned invalid client patch release data');
    const candidates = response
      .map((release) => parseReleaseDefinition(release as GitHubRelease, owner, repo))
      .filter((release): release is ClientPatchDefinition => release !== null)
      .sort(
        (left, right) =>
          Date.parse(right.publishedAt ?? '') - Date.parse(left.publishedAt ?? '')
      );
    if (candidates.length === 0) {
      throw new Error('no verified client patch release asset is available');
    }
    return candidates[0];
  }

  private launchEnvironment(platform: NodeJS.Platform): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    if (platform === 'linux') {
      environment.WINEDLLOVERRIDES = mergeWineOverride(process.env.WINEDLLOVERRIDES);
    }
    return environment;
  }

  async inspect(install: GameInstall): Promise<GameClientDllState> {
    let marker: ClientPatchMarker | null;
    try {
      marker = await this.readMarker(install);
    } catch (error) {
      return {
        status: 'invalid',
        detail: `Client DLL ownership metadata is invalid: ${(error as Error).message}`,
        hasManagedMarker: true
      };
    }

    let target: string;
    try {
      target = await this.resolveTarget(install);
    } catch (error) {
      return {
        status: 'invalid',
        detail: (error as Error).message,
        hasManagedMarker: marker !== null
      };
    }

    try {
      const targetInfo = await lstat(target);
      if (!targetInfo.isFile()) {
        return {
          status: 'invalid',
          detail: 'dinput8.dll is not a regular file and cannot be used.',
          hasManagedMarker: marker !== null
        };
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      return {
        status: 'missing',
        detail: marker
          ? 'The launcher-managed Game Client Patch file is missing.'
          : 'No dinput8.dll is present in the game Binaries folder.',
        hasManagedMarker: marker !== null
      };
    }

    const validationError = await inspectX86PeDll(target);
    if (validationError) {
      return {
        status: 'invalid',
        detail: validationError,
        hasManagedMarker: marker !== null
      };
    }

    const targetHash = await sha256File(target);
    const markerHashes = new Set(
      [marker?.installedSha256, marker?.pendingSha256].filter(
        (hash): hash is string => typeof hash === 'string'
      )
    );
    const knownPinnedRelease =
      this.definition.enabled &&
      SHA256_PATTERN.test(this.definition.sha256) &&
      targetHash === this.definition.sha256;
    if (markerHashes.has(targetHash) || knownPinnedRelease) {
      return {
        status: 'managed',
        detail: marker
          ? 'Launcher-managed Game Client Patch release detected.'
          : 'Known Game Client Patch release detected; ownership will be restored on Apply or Play.',
        hasManagedMarker: marker !== null
      };
    }

    return {
      status: 'local',
      detail: marker
        ? 'Valid local x86 DLL detected. Move it out before Reset so stale managed ownership can be recovered safely.'
        : 'Valid local x86 client patch DLL detected.',
      hasManagedMarker: marker !== null
    };
  }

  async prepareLocalForLaunch(
    install: GameInstall,
    platform: NodeJS.Platform
  ): Promise<NodeJS.ProcessEnv> {
    const inspection = await this.inspect(install);
    if (inspection.status !== 'local') {
      if (inspection.status === 'managed') {
        throw new Error(
          'The existing dinput8.dll is the launcher-managed release, not a local build. ' +
            'Copy your local x86 DLL into the game Binaries folder first.'
        );
      }
      throw new Error(inspection.detail);
    }
    this.log.info('local client DLL mode: using the existing dinput8.dll without update checks');
    return this.launchEnvironment(platform);
  }

  async prepareForLaunch(
    install: GameInstall,
    platform: NodeJS.Platform,
    onProgress: (progress: DownloadProgress) => void = () => {}
  ): Promise<NodeJS.ProcessEnv> {
    if (!this.definition.enabled) return {};
    let installedBeforeCheck: ClientPatchMarker | null = null;
    try {
      installedBeforeCheck = await this.validManagedMarker(install);
    } catch (error) {
      this.log.warn(
        `client patch ownership could not be verified; resetting it: ${(error as Error).message}`
      );
    }
    if (!installedBeforeCheck) await this.removeAnyInstalledDll(install);
    let desired = this.definition;
    try {
      desired = await this.latestReleaseDefinition();
      this.log.info(
        `client patches: newest published release is ${desired.revision} (${desired.publishedAt})`
      );
    } catch (error) {
      this.log.warn(`client patch update check failed: ${(error as Error).message}`);
      if (installedBeforeCheck?.publishedAt) {
        await this.cleanupTransactionFiles(install);
        return this.launchEnvironment(platform);
      }
    }

    if (
      installedBeforeCheck?.phase === 'active' &&
      installedBeforeCheck?.publishedAt &&
      desired.publishedAt &&
      Date.parse(installedBeforeCheck.publishedAt) >= Date.parse(desired.publishedAt)
    ) {
      await this.cleanupTransactionFiles(install);
      return this.launchEnvironment(platform);
    }

    if (await this.installedFileMatches(install, desired)) {
      await this.installManaged(install, '', desired);
      return this.launchEnvironment(platform);
    }

    try {
      const payload = await this.ensureCached(desired, onProgress);
      await this.installManaged(install, payload, desired);
    } catch (error) {
      const stillManaged = await this.validManagedMarker(install).catch(() => null);
      if (!stillManaged) {
        try {
          await this.removeAnyInstalledDll(install);
        } catch (cleanupError) {
          throw new Error(
            `${(error as Error).message}; could not remove the uncontrolled dinput8.dll: ` +
              (cleanupError as Error).message
          );
        }
        throw error;
      }
      await this.cleanupTransactionFiles(install);
      this.log.warn(
        `client patch update failed; keeping installed release ${stillManaged.revision}: ` +
          (error as Error).message
      );
    }
    return this.launchEnvironment(platform);
  }
}

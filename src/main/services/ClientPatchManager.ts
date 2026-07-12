import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat
} from 'fs/promises';
import { join } from 'path';
import { LAUNCHER_CONFIG } from '@shared/generatedLauncherConfig';
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
  if (!existing?.trim()) return 'dinput8=n,b';
  if (/(^|;)\s*dinput8\s*=/.test(existing.toLowerCase())) return existing;
  return `${existing};dinput8=n,b`;
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

    if (!marker && targetExists && targetHash !== definition.sha256) {
      throw new Error('an unmanaged dinput8.dll is already installed; it was left untouched');
    }
    if (
      marker &&
      targetHash &&
      targetHash !== marker.installedSha256 &&
      targetHash !== marker.pendingSha256
    ) {
      throw new Error('the launcher-managed dinput8.dll was modified; it was left untouched');
    }
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

    const transaction: ClientPatchMarker = {
      schemaVersion: 1,
      owner: 'commonwealth-ga-launcher',
      phase: 'installing',
      revision: definition.revision,
      publishedAt: definition.publishedAt,
      installedSha256: targetHash,
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
      if (previous) await rm(previous, { force: true });
      await this.cleanupTransactionFiles(install);
      this.log.info(`client patches ${definition.revision}: installed for game launches`);
    } catch (error) {
      await rm(incoming, { force: true }).catch(() => {});
      if (previous && !(await isFile(target)) && (await isFile(previous))) {
        await rename(previous, target).catch(() => {});
      }
      throw error;
    }
  }

  async disable(install: GameInstall): Promise<void> {
    const target = await this.resolveTarget(install);
    const marker = await this.readMarker(install);
    const targetExists = await isFile(target);
    const targetHash = targetExists ? await sha256File(target) : null;

    if (targetHash) {
      const ownedHashes = new Set<string>([this.definition.sha256]);
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
  }

  private async validManagedMarker(install: GameInstall): Promise<ClientPatchMarker | null> {
    const marker = await this.readMarker(install);
    if (!marker) return null;
    const target = await this.resolveTarget(install);
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

  async prepareLocalForLaunch(
    install: GameInstall,
    platform: NodeJS.Platform
  ): Promise<NodeJS.ProcessEnv> {
    const target = await this.resolveTarget(install);
    if (!(await isFile(target))) {
      throw new Error('Local client DLL not found in the game Binaries folder.');
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
    const installedBeforeCheck = await this.validManagedMarker(install);
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
      if (!stillManaged) throw error;
      await this.cleanupTransactionFiles(install);
      this.log.warn(
        `client patch update failed; keeping installed release ${stillManaged.revision}: ` +
          (error as Error).message
      );
    }
    return this.launchEnvironment(platform);
  }
}

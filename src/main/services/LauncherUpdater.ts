import { app, net } from 'electron';
import { autoUpdater } from 'electron-updater';
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import type { LauncherUpdateStatus, UpdateProgress } from '@shared/types';
import type { Log } from './Log';
import {
  comparePublishedReleases,
  latestStableRelease,
  type PublishedRelease,
  UPDATE_REPOSITORIES,
  type UpdateRepository
} from './ReleaseChannels';

export interface LauncherUpdateEvents {
  onStatus(status: LauncherUpdateStatus, version: string | null, error: string | null): void;
  onProgress(progress: UpdateProgress | null): void;
}

interface InstalledReleaseState {
  schemaVersion: 1;
  repository: string;
  version: string;
  publishedAt: number;
}

function asReleaseState(raw: unknown): InstalledReleaseState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (
    value.schemaVersion !== 1 ||
    typeof value.repository !== 'string' ||
    typeof value.version !== 'string' ||
    typeof value.publishedAt !== 'number' ||
    !Number.isFinite(value.publishedAt)
  ) {
    return null;
  }
  return value as unknown as InstalledReleaseState;
}

async function readReleaseState(path: string): Promise<InstalledReleaseState | null> {
  try {
    return asReleaseState(JSON.parse(await readFile(path, { encoding: 'utf-8' })));
  } catch {
    return null;
  }
}

async function writeReleaseState(path: string, state: InstalledReleaseState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8' });
  await rm(path, { force: true });
  await rename(temporary, path);
}

async function latestRelease(source: UpdateRepository): Promise<PublishedRelease | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await net.fetch(
      `https://api.github.com/repos/${source.owner}/${source.repo}/releases?per_page=100`,
      {
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Commonwealth-GA-Launcher',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    const raw = await response.json();
    return latestStableRelease(raw, source);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mandatory launcher self-update gate for packaged Windows NSIS and Linux AppImage builds.
 * Every configured source is required; the newest stable release wins by publication time.
 */
export class LauncherUpdater {
  private status: LauncherUpdateStatus = 'idle';
  private checkInFlight: Promise<boolean> | null = null;
  private readonly latestByRepository = new Map<string, PublishedRelease | null>();
  private nextRepositoryIndex = 0;
  private selectedRelease: PublishedRelease | null = null;
  private readonly installedStatePath = join(app.getPath('userData'), 'launcher-release.json');
  private readonly pendingStatePath = join(app.getPath('userData'), 'launcher-release.pending.json');

  constructor(
    private readonly log: Log,
    private readonly events: LauncherUpdateEvents
  ) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = true;

    autoUpdater.on('update-available', (info) => {
      this.log.info(`self-update: ${info.version} available, downloading`);
      this.setStatus('downloading', info.version);
    });
    autoUpdater.on('update-not-available', () => this.setStatus('up-to-date'));
    autoUpdater.on('download-progress', (progress) => {
      this.events.onProgress({
        kind: 'launcher',
        percent: Math.round(progress.percent),
        transferred: progress.transferred,
        total: progress.total
      });
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.events.onProgress(null);
      this.log.info(`self-update: ${info.version} downloaded, installing now`);
      this.setStatus('installing', info.version);
      void this.queueSelectedRelease().then(
        () => setTimeout(() => autoUpdater.quitAndInstall(false, true), 250),
        (error: Error) => {
          this.log.warn(`self-update: could not persist pending release state: ${error.message}`);
          this.setStatus('error', null, error.message);
        }
      );
    });
    autoUpdater.on('error', (error) => {
      this.events.onProgress(null);
      this.log.warn(`self-update: ${error.message}`);
      this.setStatus('error', null, error.message);
    });
  }

  private setStatus(
    status: LauncherUpdateStatus,
    version: string | null = null,
    error: string | null = null
  ): void {
    this.status = status;
    this.events.onStatus(status, version, error);
  }

  private toState(release: PublishedRelease): InstalledReleaseState {
    return {
      schemaVersion: 1,
      repository: `${release.owner}/${release.repo}`,
      version: release.version,
      publishedAt: release.publishedAt
    };
  }

  private async queueSelectedRelease(): Promise<void> {
    if (!this.selectedRelease) throw new Error('downloaded update has no selected release metadata');
    await writeReleaseState(this.pendingStatePath, this.toState(this.selectedRelease));
  }

  private async installedPublishedAt(releases: PublishedRelease[]): Promise<number> {
    const pending = await readReleaseState(this.pendingStatePath);
    if (pending) {
      await rm(this.pendingStatePath, { force: true });
      if (pending.version === app.getVersion()) {
        await writeReleaseState(this.installedStatePath, pending);
        return pending.publishedAt;
      }
    }

    const stored = await readReleaseState(this.installedStatePath);
    if (stored?.version === app.getVersion()) return stored.publishedAt;
    if (stored) await rm(this.installedStatePath, { force: true });

    let embeddedRepository = '';
    try {
      const packageJson = JSON.parse(
        await readFile(join(app.getAppPath(), 'package.json'), { encoding: 'utf-8' })
      ) as Record<string, unknown>;
      if (typeof packageJson.launcherReleaseRepository === 'string') {
        embeddedRepository = packageJson.launcherReleaseRepository;
      }
    } catch (error) {
      this.log.warn(`self-update: packaged release metadata unavailable: ${(error as Error).message}`);
    }

    const currentVersion = app.getVersion();
    const exact = releases.find(
      (release) =>
        `${release.owner}/${release.repo}`.toLowerCase() === embeddedRepository.toLowerCase() &&
        release.version === currentVersion
    );
    if (!exact) return 0;

    await writeReleaseState(this.installedStatePath, this.toState(exact));
    return exact.publishedAt;
  }

  /** Returns true only when this packaged build is confirmed current. */
  ensureCurrent(): Promise<boolean> {
    if (!app.isPackaged) {
      this.log.info('self-update: local development output; online release checks disabled');
      this.setStatus('disabled');
      return Promise.resolve(true);
    }
    if (this.status === 'downloading' || this.status === 'installing') {
      return Promise.resolve(false);
    }
    if (this.checkInFlight) return this.checkInFlight;

    this.checkInFlight = this.runCheck(UPDATE_REPOSITORIES).finally(() => {
      this.checkInFlight = null;
    });
    return this.checkInFlight;
  }

  /** Refreshes one repository per call while still comparing the newest cached release from both. */
  ensureCurrentFromNextSource(): Promise<boolean> {
    if (!app.isPackaged) return Promise.resolve(true);
    if (this.status === 'downloading' || this.status === 'installing') {
      return Promise.resolve(false);
    }
    if (this.checkInFlight) return this.checkInFlight;

    const source = UPDATE_REPOSITORIES[this.nextRepositoryIndex];
    this.nextRepositoryIndex = (this.nextRepositoryIndex + 1) % UPDATE_REPOSITORIES.length;
    this.checkInFlight = this.runCheck([source]).finally(() => {
      this.checkInFlight = null;
    });
    return this.checkInFlight;
  }

  private async runCheck(sources: readonly UpdateRepository[]): Promise<boolean> {
    this.events.onProgress(null);
    this.selectedRelease = null;
    this.setStatus('checking');
    try {
      const settled = await Promise.allSettled(sources.map((source) => latestRelease(source)));
      const discoveryErrors: string[] = [];
      for (let i = 0; i < settled.length; i++) {
        const result = settled[i];
        const source = sources[i];
        const key = `${source.owner}/${source.repo}`.toLowerCase();
        if (result.status === 'fulfilled') {
          this.latestByRepository.set(key, result.value);
        } else {
          const message = `${source.owner}/${source.repo}: ${result.reason}`;
          discoveryErrors.push(message);
          this.log.warn(`self-update discovery ${message}`);
        }
      }
      if (discoveryErrors.length > 0) {
        throw new Error(`could not verify every launcher release feed (${discoveryErrors.join('; ')})`);
      }
      const releases: PublishedRelease[] = [];
      const unchecked: string[] = [];
      for (const source of UPDATE_REPOSITORIES) {
        const key = `${source.owner}/${source.repo}`.toLowerCase();
        if (!this.latestByRepository.has(key)) {
          unchecked.push(`${source.owner}/${source.repo}`);
          continue;
        }
        const release = this.latestByRepository.get(key);
        if (release) releases.push(release);
      }
      if (unchecked.length > 0) {
        throw new Error(`launcher release feeds not checked yet (${unchecked.join('; ')})`);
      }
      if (releases.length === 0) throw new Error('no launcher release feed is reachable');

      const installedPublishedAt = await this.installedPublishedAt(releases);
      const candidates = releases.filter((release) => release.publishedAt > installedPublishedAt);
      if (candidates.length === 0) {
        this.setStatus('up-to-date');
        return true;
      }
      candidates.sort(comparePublishedReleases);
      const selected = candidates[0];
      this.selectedRelease = selected;
      this.log.info(
        `self-update: selected ${selected.owner}/${selected.repo} v${selected.version} ` +
          `(published ${new Date(selected.publishedAt).toISOString()})`
      );
      autoUpdater.setFeedURL({
        provider: 'generic',
        url:
          `https://github.com/${selected.owner}/${selected.repo}/releases/download/` +
          encodeURIComponent(selected.tag)
      });
      const result = await autoUpdater.checkForUpdates();
      if (result?.isUpdateAvailable) return false;
      throw new Error(
        selected.version === app.getVersion()
          ? 'Please download and install the latest launcher release.'
          : `electron-updater rejected the selected release ${selected.version}`
      );
    } catch (error) {
      const message = (error as Error).message;
      this.log.warn(`self-update check failed: ${message}`);
      this.setStatus('error', null, message);
      return false;
    }
  }
}

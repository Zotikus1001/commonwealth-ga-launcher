import { randomUUID } from 'crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import type { LauncherChangelogStatus } from '@shared/types';
import type { Log } from './Log';

interface StoredChangelogState {
  schemaVersion: 1;
  acknowledgedVersion: string;
}

function parseStoredState(raw: unknown): StoredChangelogState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const state = raw as Record<string, unknown>;
  if (
    state.schemaVersion !== 1 ||
    typeof state.acknowledgedVersion !== 'string' ||
    state.acknowledgedVersion.length === 0 ||
    state.acknowledgedVersion.length > 64
  ) {
    return null;
  }
  return state as unknown as StoredChangelogState;
}

export class LauncherChangelogStore {
  private readonly file: string;
  private loaded = false;
  private acknowledged = false;
  private acknowledgeInFlight: Promise<void> | null = null;

  constructor(
    userDataDir: string,
    private readonly launcherVersion: string,
    private readonly log: Log
  ) {
    this.file = join(userDataDir, 'launcher-changelog-state.json');
  }

  async load(): Promise<void> {
    let state: StoredChangelogState | null = null;
    try {
      state = parseStoredState(JSON.parse(await readFile(this.file, { encoding: 'utf-8' })));
      if (!state) this.log.warn('launcher changelog acknowledgement is invalid; showing changelog');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        this.log.warn(`launcher changelog acknowledgement read failed: ${err.message}`);
      }
    }
    this.acknowledged = state?.acknowledgedVersion === this.launcherVersion;
    this.loaded = true;
  }

  getStatus(): LauncherChangelogStatus {
    if (!this.loaded) throw new Error('Launcher changelog state has not loaded.');
    return { showOnStartup: !this.acknowledged };
  }

  acknowledge(): Promise<void> {
    if (!this.loaded) return Promise.reject(new Error('Launcher changelog state has not loaded.'));
    if (this.acknowledged) return Promise.resolve();
    if (this.acknowledgeInFlight) return this.acknowledgeInFlight;

    this.acknowledgeInFlight = this.writeAcknowledgement()
      .then(() => {
        this.acknowledged = true;
        this.log.info(`launcher changelog v${this.launcherVersion} acknowledged`);
      })
      .catch((error) => {
        this.log.error(`launcher changelog acknowledgement save failed: ${error.message}`);
        throw error;
      })
      .finally(() => {
        this.acknowledgeInFlight = null;
      });
    return this.acknowledgeInFlight;
  }

  private async writeAcknowledgement(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const state: StoredChangelogState = {
      schemaVersion: 1,
      acknowledgedVersion: this.launcherVersion
    };
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8' });
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}

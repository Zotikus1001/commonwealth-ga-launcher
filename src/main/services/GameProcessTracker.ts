import { randomUUID } from 'crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import type { Log } from './Log';

const TRACKER_SCHEMA_VERSION = 1;
const MAX_TRACKED_GAME_PROCESSES = 64;
const MAX_TRACKER_FILE_BYTES = 64 * 1024;

interface TrackedGameProcess {
  pid: number;
  startedAt: string;
}

interface StoredProcessTracker {
  schemaVersion: number;
  processes: TrackedGameProcess[];
}

export type ProcessExists = (pid: number) => boolean;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProcessRecord(value: unknown): value is TrackedGameProcess {
  return (
    isPlainObject(value) &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.startedAt === 'string' &&
    Number.isFinite(Date.parse(value.startedAt))
  );
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), { encoding: 'utf-8' });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export class GameProcessTracker {
  private readonly file: string;
  private loaded = false;
  private processes = new Map<number, TrackedGameProcess>();
  private operation: Promise<void> = Promise.resolve();

  constructor(
    userDataDir: string,
    private readonly log: Log,
    private readonly exists: ProcessExists = processExists
  ) {
    this.file = join(userDataDir, 'active-game-processes.json');
  }

  async refresh(): Promise<number> {
    return this.enqueue(async () => {
      await this.loadInternal();
      const remaining = new Map(
        [...this.processes].filter(([pid]) => this.exists(pid))
      );
      if (remaining.size !== this.processes.size) {
        await this.save(remaining);
        this.processes = remaining;
        this.log.info(`cleared ${this.processes.size === 0 ? 'stale game process tracking' : 'exited game processes'}`);
      }
      return this.processes.size;
    });
  }

  async add(pid: number): Promise<number> {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Game process identifier is invalid.');
    return this.enqueue(async () => {
      await this.loadInternal();
      const next = new Map(this.processes);
      if (!next.has(pid) && next.size >= MAX_TRACKED_GAME_PROCESSES) {
        throw new Error('Too many game processes are being tracked.');
      }
      next.set(pid, { pid, startedAt: new Date().toISOString() });
      await this.save(next);
      this.processes = next;
      return this.processes.size;
    });
  }

  async remove(pid: number): Promise<number> {
    return this.enqueue(async () => {
      await this.loadInternal();
      if (!this.processes.has(pid)) return this.processes.size;
      const next = new Map(this.processes);
      next.delete(pid);
      await this.save(next);
      this.processes = next;
      return this.processes.size;
    });
  }

  async reset(): Promise<void> {
    await this.enqueue(async () => {
      await rm(this.file, { force: true });
      this.processes.clear();
      this.loaded = true;
    });
  }

  getPids(): number[] {
    return [...this.processes.keys()];
  }

  private async loadInternal(): Promise<void> {
    if (this.loaded) return;
    let raw: string;
    try {
      const details = await stat(this.file);
      if (!details.isFile() || details.size > MAX_TRACKER_FILE_BYTES) {
        throw new Error('process tracker file is invalid or too large');
      }
      raw = await readFile(this.file, { encoding: 'utf-8' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn(`game process tracking could not be read: ${(error as Error).message}`);
      }
      this.loaded = true;
      return;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        !isPlainObject(parsed) ||
        parsed.schemaVersion !== TRACKER_SCHEMA_VERSION ||
        !Array.isArray(parsed.processes) ||
        parsed.processes.length > MAX_TRACKED_GAME_PROCESSES ||
        !parsed.processes.every(isProcessRecord)
      ) {
        throw new Error('invalid process tracker schema');
      }
      const pids = parsed.processes.map((entry) => entry.pid);
      if (new Set(pids).size !== pids.length) throw new Error('duplicate process identifiers');
      this.processes = new Map(parsed.processes.map((entry) => [entry.pid, entry]));
    } catch (error) {
      this.log.warn(`game process tracking was ignored: ${(error as Error).message}`);
      this.processes.clear();
    }
    this.loaded = true;
  }

  private async save(processes: Map<number, TrackedGameProcess>): Promise<void> {
    if (processes.size === 0) {
      await rm(this.file, { force: true });
      return;
    }
    const stored: StoredProcessTracker = {
      schemaVersion: TRACKER_SCHEMA_VERSION,
      processes: [...processes.values()]
    };
    await writeJsonAtomic(this.file, stored);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

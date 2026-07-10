import { appendFile, mkdir, rename, stat, rm } from 'fs/promises';
import { join } from 'path';

// Launcher log: userData/logs/launcher.log + an in-memory ring buffer for the Diagnostics tab.
// Never throws — logging must not take the launcher down.
export class Log {
  private readonly dir: string;
  private readonly file: string;
  private readonly ring: string[] = [];
  private readonly ringMax = 500;
  private listeners: ((line: string) => void)[] = [];
  private writeQueue: Promise<void>;

  constructor(userDataDir: string) {
    this.dir = join(userDataDir, 'logs');
    this.file = join(this.dir, 'launcher.log');
    this.writeQueue = this.init();
  }

  private async init(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      // Simple rotation: >2 MB at startup -> keep one .old generation.
      const s = await stat(this.file).catch(() => null);
      if (s && s.size > 2 * 1024 * 1024) {
        await rm(this.file + '.old', { force: true });
        await rename(this.file, this.file + '.old');
      }
    } catch {
      /* logging stays best-effort */
    }
  }

  get logDir(): string {
    return this.dir;
  }

  onLine(cb: (line: string) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  tail(): string[] {
    return [...this.ring];
  }

  info(msg: string): void {
    this.write('INFO', msg);
  }
  warn(msg: string): void {
    this.write('WARN', msg);
  }
  error(msg: string): void {
    this.write('ERROR', msg);
  }

  private write(level: string, msg: string): void {
    const line = `${new Date().toISOString()} [${level}] ${msg}`;
    this.ring.push(line);
    if (this.ring.length > this.ringMax) this.ring.shift();
    for (const l of this.listeners) {
      try {
        l(line);
      } catch {
        /* listener errors are not ours */
      }
    }
    this.writeQueue = this.writeQueue
      .then(() => appendFile(this.file, line + '\n', { encoding: 'utf-8' }))
      .catch(() => {});
  }
}

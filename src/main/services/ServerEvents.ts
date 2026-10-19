import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { LAUNCHER_CONFIG } from '@shared/generatedLauncherConfig';
import { BUNDLED_SERVER_EVENTS } from '@shared/generatedServerEvents';
import { parseServerEvents, MAX_EVENT_BYTES } from '@shared/serverEventsParser.cjs';
import type { PvpEventDefinition } from '@shared/pvpEvents';
import type { Log } from './Log';

interface EventCache {
  schemaVersion: 1;
  url: string;
  source: string;
  etag?: string;
  lastModified?: string;
}

export class ServerEvents {
  private readonly cachePath: string;
  private loadPromise?: Promise<readonly PvpEventDefinition[]>;

  constructor(
    private readonly userDataDir: string,
    private readonly log: Log,
    private readonly url: string = LAUNCHER_CONFIG.serverEventsUrl,
    private readonly request: typeof fetch = fetch
  ) {
    this.cachePath = join(userDataDir, 'server-events-cache.json');
  }

  load(): Promise<readonly PvpEventDefinition[]> {
    return this.loadPromise ??= this.loadOnce();
  }

  private async loadOnce(): Promise<readonly PvpEventDefinition[]> {
    let cache: EventCache | undefined;
    let events: readonly PvpEventDefinition[] = BUNDLED_SERVER_EVENTS;
    try {
      if ((await stat(this.cachePath)).size > MAX_EVENT_BYTES * 8) throw new Error('Event cache is too large');
      const raw = JSON.parse(await readFile(this.cachePath, 'utf8')) as EventCache;
      if (raw.schemaVersion !== 1 || raw.url !== this.url || typeof raw.source !== 'string') {
        throw new Error('Event cache does not match the current feed');
      }
      events = parseServerEvents(raw.source);
      cache = raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn(`Server event cache ignored: ${(error as Error).message}`);
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const headers: Record<string, string> = { Accept: 'text/plain' };
      const validHeader = (value: unknown): value is string =>
        typeof value === 'string' && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value);
      if (validHeader(cache?.etag)) headers['If-None-Match'] = cache.etag;
      if (validHeader(cache?.lastModified)) headers['If-Modified-Since'] = cache.lastModified;
      const response = await this.request(this.url, { headers, signal: controller.signal, redirect: 'error' });
      if (response.status === 304 && cache) return events;
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      if (Number(response.headers.get('content-length')) > MAX_EVENT_BYTES) {
        await response.body?.cancel();
        throw new Error('Event file exceeds 128 KiB');
      }
      if (!response.body) throw new Error('Empty event response');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > MAX_EVENT_BYTES) throw new Error('Event file exceeds 128 KiB');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const source = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      const updated = parseServerEvents(source);
      const next: EventCache = {
        schemaVersion: 1, url: this.url, source,
        etag: response.headers.get('etag') ?? undefined,
        lastModified: response.headers.get('last-modified') ?? undefined
      };
      if (JSON.stringify(next) !== JSON.stringify(cache)) {
        const temporary = `${this.cachePath}.tmp`;
        try {
          await mkdir(this.userDataDir, { recursive: true });
          await writeFile(temporary, JSON.stringify(next), 'utf8');
          await rename(temporary, this.cachePath);
        } catch (error) {
          await rm(temporary, { force: true }).catch(() => {});
          this.log.warn(`Server events could not be cached: ${(error as Error).message}`);
        }
      }
      return updated;
    } catch (error) {
      this.log.warn(`Server events unavailable; using saved schedule: ${(error as Error).message}`);
      return events;
    } finally {
      clearTimeout(timeout);
    }
  }
}

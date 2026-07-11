import { net } from 'electron';
import { createWriteStream } from 'fs';
import { rm } from 'fs/promises';

export interface DownloadProgress {
  transferred: number;
  total: number; // 0 when the server sent no Content-Length
}

export interface DownloadOptions {
  idleTimeoutMs?: number;
  maxBytes?: number;
}

// electron net.fetch: follows redirects (GitHub release assets 302 to a CDN) and honors system proxy.
// Idle timeout (no bytes for `idleTimeoutMs`) aborts — a stalled CDN connection must not hang the
// update flow forever.
export async function downloadToFile(
  url: string,
  destPath: string,
  onProgress: (p: DownloadProgress) => void,
  options: DownloadOptions = {}
): Promise<void> {
  const idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const controller = new AbortController();
  let idleTimer: NodeJS.Timeout | null = null;
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error('download stalled (idle timeout)')), idleTimeoutMs);
  };

  armIdle();
  let out: ReturnType<typeof createWriteStream> | null = null;
  try {
    const res = await net.fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    if (!res.body) throw new Error(`empty response body for ${url}`);

    const total = Number(res.headers.get('content-length') ?? 0) || 0;
    if (total > maxBytes) {
      throw new Error(`download is larger than the ${maxBytes}-byte limit`);
    }
    let transferred = 0;
    out = createWriteStream(destPath);
    const reader = res.body.getReader();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      transferred += value.byteLength;
      if (transferred > maxBytes) {
        throw new Error(`download exceeded the ${maxBytes}-byte limit`);
      }
      onProgress({ transferred, total });
      const okToContinue = out.write(Buffer.from(value));
      if (!okToContinue) {
        await new Promise<void>((resolve, reject) => {
          out!.once('drain', () => resolve());
          out!.once('error', reject);
        });
      }
    }

    await new Promise<void>((resolve, reject) => {
      out!.end(() => resolve());
      out!.once('error', reject);
    });
    out = null;
  } catch (e) {
    if (out) out.destroy();
    await rm(destPath, { force: true }).catch(() => {});
    throw e;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

export async function fetchJson<T>(url: string, timeoutMs = 10_000): Promise<T> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await net.fetch(url, {
      signal: controller.signal,
      headers: { 'cache-control': 'no-cache' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

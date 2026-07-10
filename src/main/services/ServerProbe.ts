import { Socket } from 'net';

export const GAME_TCP_PORT = 9000;

/**
 * Server reachability = a plain TCP connect to the game port (9000). No HTTP version endpoint
 * exists in this pass (plan §11b decision #3 — a future launcher-version query rides the existing
 * TCP protocol); connect success is the online/offline signal.
 */
export function probeServer(host: string, port = GAME_TCP_PORT, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    if (!host) {
      resolve(false);
      return;
    }
    const sock = new Socket();
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}

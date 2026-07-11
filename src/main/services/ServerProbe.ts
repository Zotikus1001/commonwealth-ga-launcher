import { lookup, type LookupAddress } from 'dns';
import { isIP, Socket } from 'net';

export const GAME_TCP_PORT = 9000;
export const SERVER_PROBE_TIMEOUT_MS = 5_000;

export type ServerProbeStatus = 'online' | 'offline' | 'invalid';

const INVALID_DNS_ERRORS = new Set(['ENODATA', 'ENOTFOUND', 'EINVAL']);

function dnsFailureStatus(error: NodeJS.ErrnoException): ServerProbeStatus {
  return error.code && INVALID_DNS_ERRORS.has(error.code) ? 'invalid' : 'offline';
}

/** Resolves the host and attempts every returned address within one hard deadline. */
export function probeServer(
  host: string,
  port = GAME_TCP_PORT,
  timeoutMs = SERVER_PROBE_TIMEOUT_MS
): Promise<ServerProbeStatus> {
  return new Promise((resolve) => {
    const normalizedHost = host.trim();
    if (!normalizedHost) {
      resolve('invalid');
      return;
    }

    const sockets = new Set<Socket>();
    let settled = false;
    let timer: NodeJS.Timeout;
    const done = (status: ServerProbeStatus): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      resolve(status);
    };

    const connect = (addresses: LookupAddress[]): void => {
      if (settled) return;
      const unique = addresses.filter(
        (candidate, index) =>
          addresses.findIndex(
            (item) => item.family === candidate.family && item.address === candidate.address
          ) === index
      );
      if (unique.length === 0) {
        done('invalid');
        return;
      }

      let pending = unique.length;
      const failed = (): void => {
        if (settled) return;
        pending -= 1;
        if (pending === 0) done('offline');
      };
      for (const address of unique) {
        const socket = new Socket();
        sockets.add(socket);
        socket.once('connect', () => done('online'));
        socket.once('error', failed);
        socket.connect({ host: address.address, port, family: address.family });
      }
    };

    timer = setTimeout(() => done('offline'), Math.max(1, timeoutMs));
    const family = isIP(normalizedHost);
    if (family !== 0) {
      connect([{ address: normalizedHost, family }]);
      return;
    }

    lookup(normalizedHost, { all: true, verbatim: true }, (error, addresses) => {
      if (settled) return;
      if (error) {
        done(dnsFailureStatus(error));
        return;
      }
      connect(addresses);
    });
  });
}

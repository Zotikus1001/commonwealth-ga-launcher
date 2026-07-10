import type { DeveloperServer } from './types';

export const DEFAULT_SERVER_ID = 'default';
export const MAX_DEVELOPER_SERVERS = 20;
export const DEVELOPER_MIN_WIDTH = 640;
export const DEVELOPER_MAX_WIDTH = 7680;
export const DEVELOPER_MIN_HEIGHT = 480;
export const DEVELOPER_MAX_HEIGHT = 4320;

export function isDeveloperResolution(width: unknown, height: unknown): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    (width as number) >= DEVELOPER_MIN_WIDTH &&
    (width as number) <= DEVELOPER_MAX_WIDTH &&
    (height as number) >= DEVELOPER_MIN_HEIGHT &&
    (height as number) <= DEVELOPER_MAX_HEIGHT
  );
}

export function isValidServerHost(value: string): boolean {
  const host = value.trim();
  const colonCount = (host.match(/:/g) ?? []).length;
  return (
    host.length > 0 &&
    host.length <= 253 &&
    !host.includes('://') &&
    colonCount !== 1 &&
    !/[\s\\/]/.test(host) &&
    /^[A-Za-z0-9._:-]+$/.test(host)
  );
}

export function validateDeveloperServers(value: unknown): string | null {
  if (!Array.isArray(value)) return 'Server profiles must be a list.';
  if (value.length > MAX_DEVELOPER_SERVERS) {
    return `Developer mode supports up to ${MAX_DEVELOPER_SERVERS} server profiles.`;
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, item] of value.entries()) {
    const row = `Server ${index + 1}`;
    if (typeof item !== 'object' || item === null) return `${row} is invalid.`;
    const server = item as Partial<DeveloperServer>;
    const id = typeof server.id === 'string' ? server.id.trim() : '';
    const name = typeof server.name === 'string' ? server.name.trim() : '';
    const host = typeof server.host === 'string' ? server.host.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || id === DEFAULT_SERVER_ID) {
      return `${row} has an invalid internal identifier. Remove it and add it again.`;
    }
    if (!name || name.length > 48 || /[\u0000-\u001f]/.test(name)) {
      return `${row} needs a name containing 1 to 48 characters.`;
    }
    if (!isValidServerHost(host)) {
      return `${row} (“${name}”) needs a valid IP address or hostname without a port.`;
    }
    const normalizedName = name.toLocaleLowerCase();
    if (ids.has(id)) return `${row} duplicates another internal identifier. Remove it and add it again.`;
    if (names.has(normalizedName)) return `${row} uses the duplicate name “${name}”.`;
    ids.add(id);
    names.add(normalizedName);
  }
  return null;
}

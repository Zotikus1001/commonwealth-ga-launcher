import type { CustomServer } from './types';

export const DEFAULT_SERVER_ID = 'default';
export const DEFAULT_BUILT_IN_SERVER_NAME = 'CommonWealth';
export const MAX_CUSTOM_SERVERS = 20;
export const MAX_SERVER_NAME_LENGTH = 48;
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

export function isValidServerName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_SERVER_NAME_LENGTH &&
    !/[\u0000-\u001f]/.test(value)
  );
}

export function validateServerSettings(builtInName: unknown, value: unknown): string | null {
  if (!isValidServerName(builtInName)) {
    return `The built-in server needs a name containing 1 to ${MAX_SERVER_NAME_LENGTH} characters.`;
  }
  if (!Array.isArray(value)) return 'Server profiles must be a list.';
  if (value.length > MAX_CUSTOM_SERVERS) {
    return `You can add up to ${MAX_CUSTOM_SERVERS} custom servers.`;
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, item] of value.entries()) {
    const row = `Custom server ${index + 1}`;
    if (typeof item !== 'object' || item === null) return `${row} is invalid.`;
    const server = item as Partial<CustomServer>;
    const id = typeof server.id === 'string' ? server.id.trim() : '';
    const name = typeof server.name === 'string' ? server.name.trim() : '';
    const host = typeof server.host === 'string' ? server.host.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || id === DEFAULT_SERVER_ID) {
      return `${row} has an invalid internal identifier. Remove it and add it again.`;
    }
    if (!isValidServerName(name)) {
      return `${row} needs a name containing 1 to ${MAX_SERVER_NAME_LENGTH} characters.`;
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

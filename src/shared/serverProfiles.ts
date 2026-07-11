import type { CustomServer } from './types';

export const DEFAULT_SERVER_ID = 'default';
export const DEFAULT_BUILT_IN_SERVER_NAME = 'Commonwealth';
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

function isValidIpv4(host: string): boolean {
  const parts = host.split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

function isValidIpv6(host: string): boolean {
  let address = host;
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    if (lastColon < 0 || !isValidIpv4(address.slice(lastColon + 1))) return false;
    address = `${address.slice(0, lastColon + 1)}0:0`;
  }
  if (!/^[A-Fa-f0-9:]+$/.test(address) || address.includes(':::')) return false;
  const compressedAt = address.indexOf('::');
  if (compressedAt !== -1 && compressedAt !== address.lastIndexOf('::')) return false;
  const compressed = compressedAt !== -1;
  const [left = '', right = ''] = compressed ? address.split('::') : [address, ''];
  const leftGroups = left ? left.split(':') : [];
  const rightGroups = right ? right.split(':') : [];
  const groups = [...leftGroups, ...rightGroups];
  if (groups.some((group) => !/^[A-Fa-f0-9]{1,4}$/.test(group))) return false;
  return compressed ? groups.length < 8 : groups.length === 8;
}

export function isValidServerHost(value: string): boolean {
  const host = value.trim();
  const colonCount = (host.match(/:/g) ?? []).length;
  if (
    host.length === 0 ||
    host.length > 253 ||
    host.includes('://') ||
    colonCount === 1 ||
    /[\s\\/]/.test(host) ||
    !/^[A-Za-z0-9._:-]+$/.test(host)
  ) {
    return false;
  }
  if (colonCount > 1) return isValidIpv6(host);
  if (/^[0-9.]+$/.test(host)) return isValidIpv4(host);
  return host.split('.').every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
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

import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import { promisify } from 'util';
import type { SteamLaunchIntegrationStatus } from '@shared/types';
import type { Log } from './Log';

const execFileP = promisify(execFile);
const MARKER_SCHEMA_VERSION = 1;
const MAX_VDF_BYTES = 64 * 1024 * 1024;

interface VdfToken {
  kind: 'string' | 'open' | 'close';
  value: string;
  start: number;
  end: number;
}

interface VdfEntry {
  key: string;
  keyToken: VdfToken;
  value: string | null;
  valueToken: VdfToken | null;
  child: VdfObject | null;
}

interface VdfObject {
  entries: VdfEntry[];
  closeToken: VdfToken | null;
}

interface SteamLaunchMarker {
  schemaVersion: number;
  configPath: string;
  appliedLaunchOptions: string;
  originalLaunchOptions: string | null;
}

interface SteamLaunchIntegrationTestOptions {
  steamRoots?: string[];
  steamRunning?: () => Promise<boolean | null>;
}

function decodeEscape(character: string): string {
  switch (character) {
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    case '\\':
    case '"':
      return character;
    default:
      return `\\${character}`;
  }
}

function tokenizeVdf(source: string): VdfToken[] {
  const tokens: VdfToken[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2);
      if (index < 0) break;
      continue;
    }
    if (character === '{' || character === '}') {
      tokens.push({
        kind: character === '{' ? 'open' : 'close',
        value: character,
        start: index,
        end: index + 1
      });
      index += 1;
      continue;
    }
    if (character === '"') {
      const start = index;
      let value = '';
      index += 1;
      let closed = false;
      while (index < source.length) {
        const current = source[index];
        if (current === '"') {
          index += 1;
          closed = true;
          break;
        }
        if (current === '\\') {
          if (index + 1 >= source.length) throw new Error('Steam settings contain an incomplete escape.');
          value += decodeEscape(source[index + 1]);
          index += 2;
          continue;
        }
        value += current;
        index += 1;
      }
      if (!closed) throw new Error('Steam settings contain an unterminated value.');
      tokens.push({ kind: 'string', value, start, end: index });
      continue;
    }

    const start = index;
    while (index < source.length && !/[\s{}]/.test(source[index])) index += 1;
    tokens.push({ kind: 'string', value: source.slice(start, index), start, end: index });
  }
  return tokens;
}

function parseVdfObject(
  tokens: readonly VdfToken[],
  startIndex = 0,
  expectsClose = false
): { object: VdfObject; nextIndex: number } {
  const entries: VdfEntry[] = [];
  let index = startIndex;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.kind === 'close') {
      if (!expectsClose) throw new Error('Steam settings contain an unexpected closing brace.');
      return { object: { entries, closeToken: token }, nextIndex: index + 1 };
    }
    if (token.kind !== 'string') throw new Error('Steam settings contain an unexpected opening brace.');
    const next = tokens[index + 1];
    if (!next) throw new Error('Steam settings contain a key without a value.');
    if (next.kind === 'string') {
      entries.push({
        key: token.value,
        keyToken: token,
        value: next.value,
        valueToken: next,
        child: null
      });
      index += 2;
      continue;
    }
    if (next.kind !== 'open') throw new Error('Steam settings contain an invalid object.');
    const parsed = parseVdfObject(tokens, index + 2, true);
    entries.push({
      key: token.value,
      keyToken: token,
      value: null,
      valueToken: null,
      child: parsed.object
    });
    index = parsed.nextIndex;
  }
  if (expectsClose) throw new Error('Steam settings contain an unclosed object.');
  return { object: { entries, closeToken: null }, nextIndex: index };
}

function parseVdf(source: string): VdfObject {
  return parseVdfObject(tokenizeVdf(source)).object;
}

function matchingEntries(object: VdfObject, key: string): VdfEntry[] {
  const normalized = key.toLowerCase();
  return object.entries.filter((entry) => entry.key.toLowerCase() === normalized);
}

function childAt(object: VdfObject, path: readonly string[]): VdfObject | null {
  let current = object;
  for (const key of path) {
    const matches = matchingEntries(current, key);
    if (matches.length !== 1 || !matches[0].child) return null;
    current = matches[0].child;
  }
  return current;
}

function quoteVdf(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

function lineStart(source: string, position: number): number {
  return source.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
}

function indentationAt(source: string, position: number): string {
  const start = lineStart(source, position);
  const indentation = source.slice(start, position);
  return /^[\t ]*$/.test(indentation) ? indentation : '';
}

function insertionPoint(source: string, position: number): number {
  const start = lineStart(source, position);
  return /^[\t ]*$/.test(source.slice(start, position)) ? start : position;
}

function newlineOf(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

function steamAppsObject(root: VdfObject): VdfObject {
  const apps = childAt(root, ['UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps']);
  if (!apps?.closeToken) throw new Error('Steam settings do not contain the expected apps section.');
  return apps;
}

export function readSteamLaunchOptions(source: string, appId: string): string | null {
  const appMatches = matchingEntries(steamAppsObject(parseVdf(source)), appId);
  if (appMatches.length === 0) return null;
  if (appMatches.length !== 1 || !appMatches[0].child) {
    throw new Error('Steam settings contain an ambiguous Global Agenda entry.');
  }
  const launchOptions = matchingEntries(appMatches[0].child, 'LaunchOptions');
  if (launchOptions.length === 0) return null;
  if (launchOptions.length !== 1 || launchOptions[0].value === null) {
    throw new Error('Steam settings contain ambiguous Global Agenda launch options.');
  }
  return launchOptions[0].value;
}

export function replaceSteamLaunchOptions(
  source: string,
  appId: string,
  launchOptions: string | null
): string {
  const root = parseVdf(source);
  const apps = steamAppsObject(root);
  const appMatches = matchingEntries(apps, appId);
  if (appMatches.length > 1 || (appMatches.length === 1 && !appMatches[0].child)) {
    throw new Error('Steam settings contain an ambiguous Global Agenda entry.');
  }
  const newline = newlineOf(source);

  if (appMatches.length === 0) {
    if (launchOptions === null) return source;
    const close = apps.closeToken!;
    const parentIndent = indentationAt(source, close.start);
    const appIndent = `${parentIndent}\t`;
    const optionIndent = `${appIndent}\t`;
    const block =
      `${appIndent}${quoteVdf(appId)}${newline}` +
      `${appIndent}{${newline}` +
      `${optionIndent}${quoteVdf('LaunchOptions')}\t\t${quoteVdf(launchOptions)}${newline}` +
      `${appIndent}}${newline}`;
    const insertAt = insertionPoint(source, close.start);
    return source.slice(0, insertAt) + block + source.slice(insertAt);
  }

  const app = appMatches[0].child!;
  const options = matchingEntries(app, 'LaunchOptions');
  if (options.length > 1 || (options.length === 1 && options[0].valueToken === null)) {
    throw new Error('Steam settings contain ambiguous Global Agenda launch options.');
  }
  if (options.length === 0) {
    if (launchOptions === null) return source;
    if (!app.closeToken) throw new Error('Steam settings contain an unclosed Global Agenda entry.');
    const close = app.closeToken;
    const indent = `${indentationAt(source, close.start)}\t`;
    const addition = `${indent}${quoteVdf('LaunchOptions')}\t\t${quoteVdf(launchOptions)}${newline}`;
    const insertAt = insertionPoint(source, close.start);
    return source.slice(0, insertAt) + addition + source.slice(insertAt);
  }

  const option = options[0];
  if (launchOptions !== null) {
    const value = option.valueToken!;
    return source.slice(0, value.start) + quoteVdf(launchOptions) + source.slice(value.end);
  }

  const keyStart = lineStart(source, option.keyToken.start);
  const removableFromLineStart = /^[\t ]*$/.test(source.slice(keyStart, option.keyToken.start));
  const afterValue = option.valueToken!.end;
  const nextLine = source.indexOf('\n', afterValue);
  const lineEnd = nextLine < 0 ? source.length : nextLine + 1;
  const removableToLineEnd = source.slice(afterValue, nextLine < 0 ? source.length : nextLine).trim() === '';
  const removeStart = removableFromLineStart ? keyStart : option.keyToken.start;
  const removeEnd = removableToLineEnd ? lineEnd : afterValue;
  return source.slice(0, removeStart) + source.slice(removeEnd);
}

function normalizePath(path: string, platform: NodeJS.Platform): string {
  const normalized = resolve(path).replace(/\\/g, '/');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isMarker(value: unknown): value is SteamLaunchMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as Partial<SteamLaunchMarker>;
  return (
    marker.schemaVersion === MARKER_SCHEMA_VERSION &&
    typeof marker.configPath === 'string' &&
    typeof marker.appliedLaunchOptions === 'string' &&
    (marker.originalLaunchOptions === null || typeof marker.originalLaunchOptions === 'string')
  );
}

async function readTextFile(path: string): Promise<string> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error('Steam user settings are not a regular file.');
  }
  if (details.size > MAX_VDF_BYTES) throw new Error('Steam user settings are unexpectedly large.');
  return readFile(path, { encoding: 'utf-8' });
}

async function writeTextAtomic(path: string, contents: string): Promise<void> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error('Steam user settings are not a regular file.');
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: 'utf-8', mode: details.mode });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function registryValue(key: string, value: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('reg', ['query', key, '/v', value]);
    return stdout.match(/REG_(?:SZ|DWORD)\s+(.+)/)?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

async function steamRoots(platform: NodeJS.Platform): Promise<string[]> {
  if (platform === 'win32') {
    const roots = await Promise.all([
      registryValue('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
      registryValue('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath')
    ]);
    return roots.filter((root): root is string => Boolean(root));
  }
  if (platform !== 'linux') return [];
  const home = homedir();
  return [
    join(home, '.steam', 'steam'),
    join(home, '.steam', 'root'),
    join(home, '.local', 'share', 'Steam'),
    join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam')
  ];
}

function mostRecentAccountId(loginUsers: string): string | null {
  const root = parseVdf(loginUsers);
  const users = childAt(root, ['users']);
  if (!users) return null;
  for (const entry of users.entries) {
    if (!/^\d{17}$/.test(entry.key) || !entry.child) continue;
    const mostRecent = matchingEntries(entry.child, 'MostRecent');
    if (mostRecent.length !== 1 || mostRecent[0].value !== '1') continue;
    return (BigInt(entry.key) & 0xffffffffn).toString();
  }
  return null;
}

async function activeAccountId(platform: NodeJS.Platform, root: string): Promise<string | null> {
  if (platform === 'win32') {
    const active =
      (await registryValue('HKCU\\Software\\Valve\\Steam\\ActiveProcess', 'ActiveUser')) ??
      (await registryValue('HKCU\\Software\\Valve\\Steam', 'ActiveUser'));
    if (active && /^0x[0-9a-f]+$/i.test(active)) {
      const account = Number.parseInt(active.slice(2), 16);
      if (Number.isSafeInteger(account) && account > 0) return String(account);
    }
  }
  try {
    return mostRecentAccountId(
      await readFile(join(root, 'config', 'loginusers.vdf'), { encoding: 'utf-8' })
    );
  } catch {
    return null;
  }
}

async function newestLocalConfig(root: string): Promise<string | null> {
  const userdata = join(root, 'userdata');
  let newest: { path: string; modified: number } | null = null;
  try {
    for (const entry of await readdir(userdata, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const candidate = join(userdata, entry.name, 'config', 'localconfig.vdf');
      try {
        const details = await lstat(candidate);
        if (!details.isFile() || details.isSymbolicLink()) continue;
        if (!newest || details.mtimeMs > newest.modified) {
          newest = { path: candidate, modified: details.mtimeMs };
        }
      } catch {
        /* not a configured Steam user */
      }
    }
  } catch {
    return null;
  }
  return newest?.path ?? null;
}

async function locateLocalConfig(platform: NodeJS.Platform, roots: readonly string[]): Promise<string | null> {
  const seen = new Set<string>();
  for (const root of roots) {
    const normalizedRoot = normalizePath(root, platform);
    if (seen.has(normalizedRoot)) continue;
    seen.add(normalizedRoot);
    const account = await activeAccountId(platform, root);
    if (account) {
      const candidate = join(root, 'userdata', account, 'config', 'localconfig.vdf');
      try {
        await readTextFile(candidate);
        return realpath(candidate);
      } catch {
        /* fall back to the most recently updated local user */
      }
    }
    const fallback = await newestLocalConfig(root);
    if (fallback) return realpath(fallback);
  }
  return null;
}

async function detectSteamRunning(platform: NodeJS.Platform): Promise<boolean | null> {
  try {
    if (platform === 'win32') {
      const { stdout } = await execFileP('tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH']);
      return /(^|\s)steam\.exe(?:\s|$)/im.test(stdout);
    }
    if (platform === 'linux') {
      const { stdout } = await execFileP('ps', ['-A', '-o', 'comm=']);
      return stdout.split(/\r?\n/).some((name) => name.trim().toLowerCase() === 'steam');
    }
    return false;
  } catch {
    return null;
  }
}

export function buildSteamLaunchOptions(
  platform: NodeJS.Platform,
  launcherPath: string,
  flatpakSteam = false
): string {
  if (/[\r\n\0]/.test(launcherPath)) throw new Error('The launcher path contains unsupported characters.');
  if (platform === 'linux') {
    const command = `'${launcherPath.replace(/'/g, `'"'"'`)}' %command%`;
    return flatpakSteam ? `flatpak-spawn --host ${command}` : command;
  }
  if (launcherPath.includes('"')) throw new Error('The launcher path contains unsupported characters.');
  return `"${launcherPath}" %command%`;
}

export class SteamLaunchIntegration {
  private readonly markerPath: string;
  private readonly onboardingPath: string;
  private mutationInProgress = false;

  constructor(
    userDataDir: string,
    private readonly appId: string,
    private readonly launcherPath: string | null,
    private readonly platform: NodeJS.Platform,
    private readonly log: Log,
    private readonly testOptions: SteamLaunchIntegrationTestOptions = {}
  ) {
    this.markerPath = join(userDataDir, 'steam-launch-integration.json');
    this.onboardingPath = join(userDataDir, 'steam-launch-integration-offer.json');
  }

  async shouldOfferOnboarding(): Promise<boolean> {
    if ((this.platform !== 'win32' && this.platform !== 'linux') || !this.launcherPath) return false;
    try {
      if (!(await stat(this.launcherPath)).isFile()) return false;
    } catch {
      return false;
    }
    try {
      const parsed: unknown = JSON.parse(await readFile(this.onboardingPath, { encoding: 'utf-8' }));
      return !(
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>).schemaVersion === 1 &&
        (parsed as Record<string, unknown>).acknowledged === true
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn(`Steam launch offer state unavailable: ${(error as Error).message}`);
      }
      return true;
    }
  }

  async acknowledgeOnboarding(): Promise<void> {
    await mkdir(dirname(this.onboardingPath), { recursive: true });
    const temporary = `${this.onboardingPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ schemaVersion: 1, acknowledged: true }, null, 2)}\n`,
        { encoding: 'utf-8' }
      );
      await rename(temporary, this.onboardingPath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async readMarker(): Promise<SteamLaunchMarker | null> {
    try {
      const details = await lstat(this.markerPath);
      if (!details.isFile() || details.isSymbolicLink() || details.size > 64 * 1024) {
        throw new Error('Saved Steam launch backup is invalid.');
      }
      const parsed: unknown = JSON.parse(await readFile(this.markerPath, { encoding: 'utf-8' }));
      if (!isMarker(parsed) || !isAbsolute(parsed.configPath)) {
        throw new Error('Saved Steam launch backup is invalid.');
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async writeMarker(marker: SteamLaunchMarker): Promise<void> {
    await mkdir(dirname(this.markerPath), { recursive: true });
    const temporary = `${this.markerPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf-8' });
      await rename(temporary, this.markerPath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async resolveTarget(): Promise<{ configPath: string; expected: string }> {
    if ((this.platform !== 'win32' && this.platform !== 'linux') || !this.launcherPath) {
      throw new Error('Steam launch integration is available only in an installed Windows or Linux launcher.');
    }
    if (!isAbsolute(this.launcherPath)) throw new Error('The installed launcher path is invalid.');
    const launcherDetails = await stat(this.launcherPath).catch(() => null);
    if (!launcherDetails) throw new Error('The installed launcher could not be found.');
    if (!launcherDetails.isFile()) throw new Error('The installed launcher could not be found.');
    const roots = this.testOptions.steamRoots ?? (await steamRoots(this.platform));
    const configPath = await locateLocalConfig(this.platform, roots);
    if (!configPath) {
      throw new Error('Steam user settings were not found. Install or open Global Agenda in Steam first.');
    }
    const flatpakSteam =
      this.platform === 'linux' &&
      normalizePath(configPath, this.platform).includes('/.var/app/com.valvesoftware.steam/');
    return {
      configPath,
      expected: buildSteamLaunchOptions(this.platform, this.launcherPath, flatpakSteam)
    };
  }

  private async steamRunning(): Promise<boolean | null> {
    return this.testOptions.steamRunning?.() ?? detectSteamRunning(this.platform);
  }

  private async requireSteamClosed(): Promise<void> {
    const running = await this.steamRunning();
    if (running !== false) {
      throw new Error(
        running
          ? 'Close Steam completely before changing its Global Agenda launch options.'
          : "Steam's running state could not be checked. Close Steam and try again."
      );
    }
  }

  private status(
    state: SteamLaunchIntegrationStatus['state'],
    detail: string,
    steamRunning: boolean | null,
    canApply: boolean,
    canRemove: boolean
  ): SteamLaunchIntegrationStatus {
    return {
      state,
      detail:
        steamRunning === true
          ? `${detail} Close Steam before applying or removing.`
          : steamRunning === null
            ? `${detail} Steam's running state could not be checked.`
            : detail,
      steamRunning,
      canApply: canApply && steamRunning !== null,
      canRemove: canRemove && steamRunning !== null
    };
  }

  async inspect(): Promise<SteamLaunchIntegrationStatus> {
    const steamRunning = await this.steamRunning();
    try {
      const { configPath, expected } = await this.resolveTarget();
      const [contents, marker] = await Promise.all([readTextFile(configPath), this.readMarker()]);
      const current = readSteamLaunchOptions(contents, this.appId);
      if (marker && normalizePath(marker.configPath, this.platform) !== normalizePath(configPath, this.platform)) {
        return this.status(
          'unavailable',
          'This was applied to another Steam user. Switch back to that Steam user to remove it.',
          steamRunning,
          false,
          false
        );
      }
      if (current === expected) {
        return this.status(
          'enabled',
          'Steam launches Global Agenda through Commonwealth GA Launcher.',
          steamRunning,
          false,
          true
        );
      }
      if (marker && current === marker.appliedLaunchOptions) {
        return this.status(
          'needs-repair',
          'Steam points to an older launcher location.',
          steamRunning,
          true,
          true
        );
      }
      if (marker) {
        return this.status(
          'conflict',
          'Steam launch options changed after this was applied. Apply again to replace and save them.',
          steamRunning,
          true,
          false
        );
      }
      return this.status(
        'disabled',
        current === null
          ? 'Global Agenda currently launches directly from Steam.'
          : 'Existing Steam launch options will be saved before they are replaced.',
        steamRunning,
        true,
        false
      );
    } catch (error) {
      this.log.warn(`Steam launch integration unavailable: ${(error as Error).message}`);
      return this.status('unavailable', (error as Error).message, steamRunning, false, false);
    }
  }

  private async writeAndVerify(
    configPath: string,
    previousContents: string,
    value: string | null
  ): Promise<void> {
    const updated = replaceSteamLaunchOptions(previousContents, this.appId, value);
    try {
      await writeTextAtomic(configPath, updated);
      const verified = await readTextFile(configPath);
      if (readSteamLaunchOptions(verified, this.appId) !== value) {
        throw new Error('Steam did not retain the requested launch options.');
      }
    } catch (error) {
      await writeTextAtomic(configPath, previousContents).catch((rollbackError) => {
        this.log.error(`Steam settings rollback failed: ${(rollbackError as Error).message}`);
      });
      throw error;
    }
  }

  async setEnabled(enabled: boolean): Promise<SteamLaunchIntegrationStatus> {
    if (this.mutationInProgress) {
      throw new Error('Steam launch options are already being changed.');
    }
    this.mutationInProgress = true;
    try {
      return await this.changeEnabled(enabled);
    } finally {
      this.mutationInProgress = false;
    }
  }

  private async changeEnabled(enabled: boolean): Promise<SteamLaunchIntegrationStatus> {
    await this.requireSteamClosed();
    const { configPath, expected } = await this.resolveTarget();
    const [contents, marker] = await Promise.all([readTextFile(configPath), this.readMarker()]);
    if (marker && normalizePath(marker.configPath, this.platform) !== normalizePath(configPath, this.platform)) {
      throw new Error('This was applied to another Steam user. Switch back to that user to remove it first.');
    }
    const current = readSteamLaunchOptions(contents, this.appId);

    if (enabled) {
      if (current === expected) return this.inspect();
      const nextMarker: SteamLaunchMarker = {
        schemaVersion: MARKER_SCHEMA_VERSION,
        configPath: resolve(configPath),
        appliedLaunchOptions: expected,
        originalLaunchOptions:
          marker && current === marker.appliedLaunchOptions
            ? marker.originalLaunchOptions
            : current
      };
      const previousMarker = marker;
      await this.requireSteamClosed();
      await this.writeMarker(nextMarker);
      try {
        await this.writeAndVerify(configPath, contents, expected);
      } catch (error) {
        if (previousMarker) await this.writeMarker(previousMarker).catch(() => {});
        else await rm(this.markerPath, { force: true }).catch(() => {});
        throw error;
      }
      this.log.info('Steam Global Agenda launch integration applied');
      return this.inspect();
    }

    if (!marker) {
      if (current !== expected) return this.inspect();
      await this.requireSteamClosed();
      await this.writeAndVerify(configPath, contents, null);
      this.log.info('manual Steam Global Agenda launcher override removed');
      return this.inspect();
    }
    if (current === marker.originalLaunchOptions) {
      await rm(this.markerPath, { force: true });
      return this.inspect();
    }
    if (current !== marker.appliedLaunchOptions && current !== expected) {
      throw new Error('Steam launch options changed after Apply, so they were left untouched.');
    }
    await this.requireSteamClosed();
    await this.writeAndVerify(configPath, contents, marker.originalLaunchOptions);
    await rm(this.markerPath, { force: true });
    this.log.info('previous Steam Global Agenda launch options restored');
    return this.inspect();
  }
}

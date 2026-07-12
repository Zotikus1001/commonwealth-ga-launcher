import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { constants } from 'fs';
import { access, mkdir, readFile, readdir, realpath, stat } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'path';
import { homedir } from 'os';
import type {
  ActionResult,
  LinuxRunnerOption,
  LinuxRuntimeOptions,
  LinuxRuntimeStatus,
  Settings
} from '@shared/types';
import type { Log } from './Log';

const execFileP = promisify(execFile);
const GLOBAL_AGENDA_STEAM_APP_ID = '17020';

export interface LinuxRuntimeInspection {
  status: LinuxRuntimeStatus;
  prefixPath: string;
  winePath: string;
  protonPath: string;
  umuPath: string;
  gameModePath: string;
  steamPrefixPath: string;
  suggestedPrefixPath: string;
}

export function defaultLinuxPrefix(): string {
  return join(homedir(), '.local', 'share', 'commonwealth-ga', 'prefix');
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function validateExecutable(path: string): Promise<boolean> {
  if (!path) return false;
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function resolveChildDirectory(parent: string, expectedName: string): Promise<string | null> {
  const exact = join(parent, expectedName);
  if (await isDirectory(exact)) return exact;
  try {
    const matches = (await readdir(parent)).filter(
      (entry) => entry.toLowerCase() === expectedName.toLowerCase()
    );
    if (matches.length !== 1) return null;
    const resolved = join(parent, matches[0]);
    return (await isDirectory(resolved)) ? resolved : null;
  } catch {
    return null;
  }
}

export async function resolveExistingPrefix(input: string): Promise<string | null> {
  const selected = input.trim();
  if (!selected) return null;
  if (await resolveChildDirectory(selected, 'drive_c')) return selected;
  const pfx = await resolveChildDirectory(selected, 'pfx');
  if (pfx && (await resolveChildDirectory(pfx, 'drive_c'))) return pfx;
  return null;
}

function isSteamCompatDataPath(path: string): boolean {
  return (
    /^\d+$/.test(basename(path)) &&
    basename(dirname(path)).toLowerCase() === 'compatdata' &&
    basename(dirname(dirname(path))).toLowerCase() === 'steamapps'
  );
}

export async function resolvePrefixTarget(input: string): Promise<string> {
  const selected = input.trim();
  if (!selected) return '';
  const existing = await resolveExistingPrefix(selected);
  if (existing) return existing;
  return isSteamCompatDataPath(selected) ? join(selected, 'pfx') : selected;
}

export async function resolveProtonPath(input: string): Promise<string | null> {
  const selected = input.trim();
  if (!selected) return null;
  if (await validateExecutable(join(selected, 'proton'))) return selected;
  if (basename(selected).toLowerCase() === 'proton' && (await validateExecutable(selected))) {
    return dirname(selected);
  }
  return null;
}

function linuxSteamRoots(): string[] {
  const home = homedir();
  return [
    join(home, '.steam', 'root'),
    join(home, '.steam', 'steam'),
    join(home, '.local', 'share', 'Steam'),
    join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam')
  ];
}

async function steamLibraries(root: string): Promise<string[]> {
  const libraries = [root];
  try {
    const vdf = await readFile(join(root, 'steamapps', 'libraryfolders.vdf'), {
      encoding: 'utf-8'
    });
    for (const match of vdf.matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/g)) {
      libraries.push(match[1].replace(/\\\\/g, '\\'));
    }
  } catch {
    // A Steam root without additional libraries is still valid.
  }
  return libraries;
}

async function listSteamLibraries(gameExePath: string): Promise<string[]> {
  const libraries: string[] = [];
  const seen = new Set<string>();
  for (const root of linuxSteamRoots()) {
    if (!(await isDirectory(root))) continue;
    for (const library of await steamLibraries(root)) {
      if (seen.has(library) || !(await isDirectory(library))) continue;
      seen.add(library);
      libraries.push(library);
    }
  }
  const belongsToLibrary = (library: string): boolean => {
    if (!gameExePath) return false;
    const child = relative(library, gameExePath);
    return child !== '' && !child.startsWith('..') && !isAbsolute(child);
  };
  return libraries.sort(
    (left, right) => Number(belongsToLibrary(right)) - Number(belongsToLibrary(left))
  );
}

async function discoverSteamPrefix(gameExePath: string): Promise<string> {
  for (const library of await listSteamLibraries(gameExePath)) {
    const compatData = join(
      library,
      'steamapps',
      'compatdata',
      GLOBAL_AGENDA_STEAM_APP_ID
    );
    const prefix = await resolveExistingPrefix(compatData);
    if (prefix) return prefix;
  }
  return '';
}

async function commandPath(command: string, candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    if (await validateExecutable(candidate)) return candidate;
  }
  try {
    const { stdout } = await execFileP('which', [command]);
    const path = stdout.trim();
    return (await validateExecutable(path)) ? path : '';
  } catch {
    return '';
  }
}

async function resolveUmuPath(configuredPath: string): Promise<string> {
  if (configuredPath.trim()) {
    return (await validateExecutable(configuredPath.trim())) ? configuredPath.trim() : '';
  }
  return commandPath('umu-run', [
    join(homedir(), '.local', 'bin', 'umu-run'),
    '/usr/bin/umu-run',
    '/usr/local/bin/umu-run'
  ]);
}

async function resolveGameModePath(): Promise<string> {
  return commandPath('gamemoderun', ['/usr/bin/gamemoderun', '/usr/local/bin/gamemoderun']);
}

async function listWineRunners(settings: Settings): Promise<LinuxRunnerOption[]> {
  const runners: LinuxRunnerOption[] = [];
  const seen = new Set<string>();
  const push = (label: string, path: string): void => {
    if (!seen.has(path)) {
      seen.add(path);
      runners.push({ label, path });
    }
  };

  if (settings.linux.winePath) {
    push(`Configured: ${settings.linux.winePath}`, settings.linux.winePath);
  }
  const lutrisDir = join(homedir(), '.local', 'share', 'lutris', 'runners', 'wine');
  try {
    for (const entry of await readdir(lutrisDir)) {
      const path = join(lutrisDir, entry, 'bin', 'wine');
      if (await validateExecutable(path)) push(`Lutris: ${entry}`, path);
    }
  } catch {
    // Lutris is optional.
  }
  const systemWine = await commandPath('wine', []);
  if (systemWine) push(`System: ${systemWine}`, systemWine);
  return runners;
}

async function listProtonRunners(settings: Settings): Promise<LinuxRunnerOption[]> {
  const runners: LinuxRunnerOption[] = [];
  const seen = new Set<string>();
  const push = async (label: string | null, path: string): Promise<void> => {
    const resolved = await resolveProtonPath(path);
    if (!resolved) return;
    let identity: string;
    try {
      identity = await realpath(join(resolved, 'proton'));
    } catch {
      identity = join(resolved, 'proton');
    }
    if (seen.has(identity)) return;
    seen.add(identity);
    runners.push({ label: label ?? basename(resolved), path: resolved });
  };

  if (settings.linux.protonPath) {
    await push(null, settings.linux.protonPath);
  }
  const compatibilityParents = linuxSteamRoots().map((root) => join(root, 'compatibilitytools.d'));
  const steamToolParents = (await listSteamLibraries(settings.gameExePath)).map((library) =>
    join(library, 'steamapps', 'common')
  );
  for (const [parent, filterNames] of [
    ...compatibilityParents.map((path) => [path, false] as const),
    ...steamToolParents.map((path) => [path, true] as const)
  ]) {
    try {
      for (const entry of await readdir(parent)) {
        if (filterNames && !/^(?:GE-|UMU-)?Proton/i.test(entry)) continue;
        await push(entry, join(parent, entry));
      }
    } catch {
      // Steam and custom compatibility tools are optional.
    }
  }
  return runners;
}

export async function listLinuxRuntimeOptions(
  settings: Settings,
  log: Log
): Promise<LinuxRuntimeOptions> {
  const [wineRunners, protonRunners, umuPath, gameModePath, steamPrefixPath] =
    await Promise.all([
      listWineRunners(settings),
      listProtonRunners(settings),
      resolveUmuPath(settings.linux.umuPath),
      resolveGameModePath(),
      discoverSteamPrefix(settings.gameExePath)
    ]);
  log.info(
    `linux discovery: ${wineRunners.length} Wine, ${protonRunners.length} Proton, ` +
      `UMU=${umuPath ? 'yes' : 'no'}, GameMode=${gameModePath ? 'yes' : 'no'}`
  );
  return { wineRunners, protonRunners, umuPath, gameModePath, steamPrefixPath };
}

export async function inspectLinuxRuntime(
  settings: Settings,
  log: Log
): Promise<LinuxRuntimeInspection> {
  const [existingPrefix, options, wineValid, protonPath] = await Promise.all([
    resolveExistingPrefix(settings.linux.winePrefix),
    listLinuxRuntimeOptions(settings, log),
    validateExecutable(settings.linux.winePath),
    resolveProtonPath(settings.linux.protonPath)
  ]);
  const suggestedPrefixPath =
    settings.linux.runner === 'proton' &&
    !existingPrefix &&
    options.steamPrefixPath &&
    settings.linux.winePrefix === defaultLinuxPrefix()
      ? options.steamPrefixPath
      : '';
  const prefixPath =
    suggestedPrefixPath ||
    existingPrefix ||
    (settings.linux.runner === 'proton'
      ? await resolvePrefixTarget(settings.linux.winePrefix)
      : '');

  let status: LinuxRuntimeStatus;
  if (settings.linux.runner === 'wine') {
    status = !wineValid
      ? 'wine-runner-missing'
      : !prefixPath
        ? 'wine-prefix-missing'
        : 'ready';
  } else {
    status = !options.umuPath
      ? 'umu-missing'
      : !protonPath
        ? 'proton-missing'
        : !prefixPath
          ? 'wine-prefix-missing'
          : 'ready';
  }

  return {
    status,
    prefixPath,
    winePath: wineValid ? settings.linux.winePath : '',
    protonPath: protonPath ?? '',
    umuPath: options.umuPath,
    gameModePath: options.gameModePath,
    steamPrefixPath: options.steamPrefixPath,
    suggestedPrefixPath
  };
}

export async function createWinePrefix(
  winePath: string,
  prefix: string,
  log: Log
): Promise<ActionResult> {
  if (!winePath || !(await validateExecutable(winePath))) {
    return { ok: false, message: 'Pick an executable Wine runner first.' };
  }
  const existing = await resolveExistingPrefix(prefix);
  if (existing) return { ok: true, message: `Prefix is ready at ${existing}.` };
  const target = prefix.trim();
  if (!target) return { ok: false, message: 'Enter a prefix location first.' };
  if (isSteamCompatDataPath(target)) {
    return {
      ok: false,
      message: 'Launch this Steam compatibility folder with Proton so it can create its pfx prefix.'
    };
  }

  try {
    await mkdir(target, { recursive: true });
  } catch (error) {
    return { ok: false, message: `Cannot create ${target}: ${(error as Error).message}` };
  }
  log.info(`creating wine prefix ${target} with ${winePath}`);
  return new Promise((resolve) => {
    const child = spawn(winePath, ['wineboot', '-u'], {
      env: { ...process.env, WINEPREFIX: target, WINEDEBUG: '-all' },
      stdio: 'ignore'
    });
    const timeout = setTimeout(() => {
      child.kill();
      resolve({ ok: false, message: 'wineboot timed out after 5 minutes.' });
    }, 5 * 60 * 1000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, message: `wineboot failed to start: ${error.message}` });
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(
        code === 0
          ? { ok: true, message: `Prefix created at ${target} (${basename(winePath)}).` }
          : { ok: false, message: `wineboot exited with code ${code ?? 'unknown'}.` }
      );
    });
  });
}

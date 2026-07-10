import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, access, stat } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { homedir } from 'os';
import type { Log } from './Log';

const execFileP = promisify(execFile);

export interface GameInstall {
  exePath: string;
  binariesDir: string;
  rootDir: string;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Validation triple carried from the frozen Win32 launcher (CommonwealthLauncher.cpp): the exe is
 * <root>/Binaries/GlobalAgenda.exe with sibling <root>/Engine and <root>/TgGame directories.
 */
export async function validateGameExe(exePath: string): Promise<GameInstall | null> {
  if (!exePath) return null;
  if (basename(exePath).toLowerCase() !== 'globalagenda.exe') return null;
  if (!(await isFile(exePath))) return null;
  const binariesDir = dirname(exePath);
  if (basename(binariesDir).toLowerCase() !== 'binaries') return null;
  const rootDir = dirname(binariesDir);
  if (!(await isDir(join(rootDir, 'Engine')))) return null;
  if (!(await isDir(join(rootDir, 'TgGame')))) return null;
  return { exePath, binariesDir, rootDir };
}

// GA shipped under two Steam folder names ('Global Agenda Live' is the shape on the maintainer's
// install); loose copies are common since the game is delisted, so Steam detection is an assist only.
const GAME_DIR_NAMES = ['Global Agenda Live', 'Global Agenda'];

async function steamRootWindows(log: Log): Promise<string[]> {
  const roots: string[] = [];
  const queries: [string, string][] = [
    ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath']
  ];
  for (const [key, value] of queries) {
    try {
      const { stdout } = await execFileP('reg', ['query', key, '/v', value]);
      const m = stdout.match(/REG_SZ\s+(.+)/);
      if (m) roots.push(m[1].trim());
    } catch {
      /* key absent — fine */
    }
  }
  if (roots.length === 0) log.info('auto-detect: no Steam registry keys found');
  return roots;
}

async function steamLibraries(steamRoot: string): Promise<string[]> {
  const libs = [steamRoot];
  try {
    const vdf = await readFile(join(steamRoot, 'steamapps', 'libraryfolders.vdf'), { encoding: 'utf-8' });
    for (const m of vdf.matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/g)) {
      libs.push(m[1].replace(/\\\\/g, '\\'));
    }
  } catch {
    /* old steam / no extra libraries */
  }
  return libs;
}

export async function autoDetectGame(platform: NodeJS.Platform, winePrefix: string, log: Log): Promise<GameInstall | null> {
  const steamRoots: string[] = [];
  const candidates: string[] = [];

  if (platform === 'win32') {
    steamRoots.push(...(await steamRootWindows(log)));
  } else {
    const h = homedir();
    for (const p of [
      join(h, '.steam', 'steam'),
      join(h, '.local', 'share', 'Steam'),
      join(h, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam')
    ]) {
      if (await isDir(p)) steamRoots.push(p);
    }
    // Loose install inside the configured Wine prefix (game path native, prefix maps it via Z:/C:).
    if (winePrefix) {
      for (const name of GAME_DIR_NAMES) {
        candidates.push(join(winePrefix, 'drive_c', 'Games', name, 'Binaries', 'GlobalAgenda.exe'));
        candidates.push(join(winePrefix, 'drive_c', 'Program Files (x86)', name, 'Binaries', 'GlobalAgenda.exe'));
      }
    }
  }

  for (const root of steamRoots) {
    for (const lib of await steamLibraries(root)) {
      for (const name of GAME_DIR_NAMES) {
        candidates.push(join(lib, 'steamapps', 'common', name, 'Binaries', 'GlobalAgenda.exe'));
      }
    }
  }

  for (const exe of candidates) {
    try {
      await access(exe);
    } catch {
      continue;
    }
    const valid = await validateGameExe(exe);
    if (valid) {
      log.info(`auto-detect: found ${exe}`);
      return valid;
    }
  }
  log.info(`auto-detect: no install found (checked ${candidates.length} candidates)`);
  return null;
}

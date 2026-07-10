import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { constants } from 'fs';
import { readdir, mkdir, access } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';
import type { ActionResult, Settings, WineRunner } from '@shared/types';
import type { Log } from './Log';

const execFileP = promisify(execFile);

export async function validateWineRunner(winePath: string): Promise<boolean> {
  if (!winePath) return false;
  try {
    await access(winePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wine discovery order (plan §4): config-pinned path -> Lutris runners (the project owner's
 * known-good shape is a Lutris GE-Proton runner) -> wine on PATH.
 */
export async function listWineRunners(settings: Settings, log: Log): Promise<WineRunner[]> {
  const runners: WineRunner[] = [];
  const seen = new Set<string>();
  const push = (label: string, path: string): void => {
    if (!seen.has(path)) {
      seen.add(path);
      runners.push({ label, path });
    }
  };

  if (settings.linux.winePath) {
    push(`configured: ${settings.linux.winePath}`, settings.linux.winePath);
  }

  const lutrisDir = join(homedir(), '.local', 'share', 'lutris', 'runners', 'wine');
  try {
    for (const entry of await readdir(lutrisDir)) {
      const bin = join(lutrisDir, entry, 'bin', 'wine');
      try {
        if (!(await validateWineRunner(bin))) continue;
        push(`Lutris: ${entry}`, bin);
      } catch {
        /* runner without bin/wine */
      }
    }
  } catch {
    /* no lutris */
  }

  try {
    const { stdout } = await execFileP('which', ['wine']);
    const p = stdout.trim();
    if (p) push(`system: ${p}`, p);
  } catch {
    /* no system wine */
  }

  log.info(`wine discovery: ${runners.length} runner(s) found`);
  return runners;
}

/**
 * First-run prefix creation: WINEPREFIX=<prefix> wine wineboot -u. Can take minutes on first boot
 * (wine installs its prefix skeleton) — 5 min timeout, surfaced as a plain failure, not a hang.
 */
export function createWinePrefix(winePath: string, prefix: string, log: Log): Promise<ActionResult> {
  return new Promise((resolve) => {
    if (!winePath) {
      resolve({ ok: false, message: 'Pick a Wine runner first.' });
      return;
    }
    void (async () => {
      try {
        await mkdir(prefix, { recursive: true });
      } catch (e) {
        resolve({ ok: false, message: `Cannot create ${prefix}: ${(e as Error).message}` });
        return;
      }
      log.info(`creating wine prefix ${prefix} with ${winePath}`);
      const child = spawn(winePath, ['wineboot', '-u'], {
        env: { ...process.env, WINEPREFIX: prefix, WINEDEBUG: '-all' },
        stdio: 'ignore'
      });
      const timeout = setTimeout(() => {
        child.kill();
        resolve({ ok: false, message: 'wineboot timed out after 5 minutes.' });
      }, 5 * 60 * 1000);
      child.once('error', (e) => {
        clearTimeout(timeout);
        resolve({ ok: false, message: `wineboot failed to start: ${e.message}` });
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          log.info(`wine prefix ready: ${prefix}`);
          resolve({ ok: true, message: `Prefix created at ${prefix} (${basename(winePath)})` });
        } else {
          resolve({ ok: false, message: `wineboot exited with code ${code ?? 'unknown'}.` });
        }
      });
    })();
  });
}

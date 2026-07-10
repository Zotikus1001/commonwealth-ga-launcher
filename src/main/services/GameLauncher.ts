import { spawn, execFile, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import type { Settings } from '@shared/types';
import type { Log } from './Log';

const execFileP = promisify(execFile);

/**
 * Builds the GA connection args. Always-passed baseline: -host/-hostdns (resolved server, hidden from the UI),
 * -seekfreeloading, -tcp=300. -nostartupmovies / -nosplash are opt-in toggles. -graphicsadapter only when a
 * non-primary GPU ordinal is set. Extra args are appended verbatim (the one user-editable arg field).
 */
export function buildGameArgs(
  settings: Settings,
  host: string,
  developerLaunch = false
): string[] {
  const args = [`-host=${host}`, `-hostdns=${host}`, '-seekfreeloading', '-tcp=300'];
  if (settings.launch.noStartupMovies) args.push('-nostartupmovies');
  if (settings.launch.noSplash) args.push('-nosplash');
  const gpu = Number.isFinite(settings.launch.gpuAdapter) ? settings.launch.gpuAdapter : 0;
  if (gpu > 0) args.push(`-graphicsadapter=${gpu}`);
  if (settings.launch.extraArgs.trim()) {
    args.push(...settings.launch.extraArgs.trim().split(/\s+/));
  }
  if (developerLaunch) {
    args.push(
      settings.developer.windowed ? '-windowed' : '-fullscreen',
      `-ResX=${settings.developer.resolutionWidth}`,
      `-ResY=${settings.developer.resolutionHeight}`
    );
  }
  return args;
}

export class GameLauncher {
  private readonly children = new Set<ChildProcess>();

  constructor(private readonly log: Log) {}

  activeInstanceCount(): number {
    return this.children.size;
  }

  /** Our own spawned child OR any system-wide GlobalAgenda.exe (a player may launch by hand). */
  async isGameRunning(platform: NodeJS.Platform): Promise<boolean> {
    if (this.children.size > 0) return true;
    try {
      if (platform === 'win32') {
        const { stdout } = await execFileP('tasklist', ['/FI', 'IMAGENAME eq GlobalAgenda.exe', '/NH', '/FO', 'CSV']);
        return stdout.toLowerCase().includes('globalagenda.exe');
      }
      // Under Wine the process cmdline contains the exe path — pgrep -f matches it.
      await execFileP('pgrep', ['-f', 'GlobalAgenda.exe']);
      return true; // pgrep exit 0 = at least one match
    } catch (e) {
      const err = e as { code?: number | string };
      if (err.code === 1) return false; // pgrep: no match
      // tasklist/pgrep unavailable or errored — fall back to what we know for sure.
      return this.children.size > 0;
    }
  }

  /**
   * Platform split (fragile, keep both branches in sync with intent):
   *  - Windows: spawn GlobalAgenda.exe directly, detached — the game outlives the launcher
   *    (matches CommonwealthLauncher.cpp CloseHandle semantics).
   *  - Linux: spawn <wine> <exePath> <args> with WINEPREFIX from settings and quiet Wine logging.
   *    No dinput8 override is set while client-DLL distribution is disabled.
   *    The exe path stays NATIVE — Wine maps it via the Z: drive; no winepath translation.
   *    With wineDebug on, Wine keeps default logging and stderr is piped into the launcher log
   *    (that requires staying attached, so debug runs are not detached).
   */
  launch(
    settings: Settings,
    host: string,
    binariesDir: string,
    platform: NodeJS.Platform,
    developerLaunch: boolean,
    onInstancesChanged: (count: number) => void,
    onStarted: () => void
  ): void {
    const args = buildGameArgs(settings, host, developerLaunch);
    let child: ChildProcess;

    if (platform === 'win32') {
      this.log.info(`launching ${settings.gameExePath} with managed connection arguments`);
      child = spawn(settings.gameExePath, args, {
        cwd: binariesDir,
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
    } else if (platform === 'linux') {
      if (!settings.linux.winePath) throw new Error('no Wine runner configured (Settings -> Game)');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        WINEPREFIX: settings.linux.winePrefix
      };
      if (!settings.linux.wineDebug) env.WINEDEBUG = '-all';
      this.log.info(
        `launching ${settings.gameExePath} with ${settings.linux.winePath} ` +
          `(prefix ${settings.linux.winePrefix}) and managed connection arguments`
      );
      child = spawn(settings.linux.winePath, [settings.gameExePath, ...args], {
        cwd: binariesDir,
        env,
        detached: !settings.linux.wineDebug,
        stdio: settings.linux.wineDebug ? ['ignore', 'pipe', 'pipe'] : 'ignore'
      });
      if (settings.linux.wineDebug) {
        child.stdout?.on('data', (d: Buffer) => this.log.info(`[wine] ${d.toString('utf-8').trimEnd()}`));
        child.stderr?.on('data', (d: Buffer) => this.log.warn(`[wine] ${d.toString('utf-8').trimEnd()}`));
      } else {
        child.unref();
      }
    } else {
      throw new Error(`unsupported launcher platform: ${platform}`);
    }

    this.children.add(child);
    onInstancesChanged(this.children.size);
    child.once('spawn', onStarted);
    let completed = false;
    const complete = (): void => {
      if (completed) return;
      completed = true;
      if (this.children.delete(child)) onInstancesChanged(this.children.size);
    };
    child.once('error', (e) => {
      this.log.error(`game process error: ${e.message}`);
      complete();
    });
    child.once('exit', (code) => {
      this.log.info(`game exited (code ${code ?? 'unknown'})`);
      complete();
    });
  }
}

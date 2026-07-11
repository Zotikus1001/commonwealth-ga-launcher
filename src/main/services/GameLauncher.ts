import { spawn, type ChildProcess } from 'child_process';
import type { Settings } from '@shared/types';
import type { Log } from './Log';
import type { LinuxRuntimeInspection } from './LinuxRuntime';

export interface LinuxLaunchCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function buildLinuxLaunchCommand(
  settings: Settings,
  runtime: LinuxRuntimeInspection,
  gameArgs: string[]
): LinuxLaunchCommand {
  const env: NodeJS.ProcessEnv = { WINEPREFIX: runtime.prefixPath };
  let command: string;
  let args: string[];
  if (settings.linux.runner === 'proton') {
    command = runtime.umuPath;
    args = [settings.gameExePath, ...gameArgs];
    env.PROTONPATH = runtime.protonPath;
    if (settings.linux.wineDebug) {
      env.UMU_LOG = '1';
      env.PROTON_LOG = '1';
    }
  } else {
    command = runtime.winePath;
    args = [settings.gameExePath, ...gameArgs];
    if (!settings.linux.wineDebug) env.WINEDEBUG = '-all';
  }
  if (settings.linux.gameMode && runtime.gameModePath) {
    args = [command, ...args];
    command = runtime.gameModePath;
  }
  return { command, args, env };
}

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
  constructor(private readonly log: Log) {}

  /**
   * Platform split (fragile, keep both branches in sync with intent):
   *  - Windows: spawn GlobalAgenda.exe directly, detached — the game outlives the launcher
   *    (matches CommonwealthLauncher.cpp CloseHandle semantics).
   *  - Linux/Wine: spawn <wine> <exePath> with the resolved prefix.
   *  - Linux/Proton: spawn <umu-run> <exePath> with WINEPREFIX and PROTONPATH.
   *    Optional GameMode wraps either runner without changing its arguments.
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
    linuxRuntime: LinuxRuntimeInspection | null = null
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
      if (!linuxRuntime || linuxRuntime.status !== 'ready') {
        throw new Error('Linux compatibility runtime is not ready (Settings -> Game)');
      }
      if (settings.linux.gameMode && !linuxRuntime.gameModePath) {
        this.log.warn('GameMode was requested but gamemoderun is unavailable; launching without it');
      }
      const launch = buildLinuxLaunchCommand(settings, linuxRuntime, args);
      this.log.info(
        `launching ${settings.gameExePath} with ${settings.linux.runner} ` +
          `(prefix ${linuxRuntime.prefixPath}, GameMode=${settings.linux.gameMode && !!linuxRuntime.gameModePath}) ` +
          'and managed connection arguments'
      );
      child = spawn(launch.command, launch.args, {
        cwd: binariesDir,
        env: { ...process.env, ...launch.env },
        detached: !settings.linux.wineDebug,
        stdio: settings.linux.wineDebug ? ['ignore', 'pipe', 'pipe'] : 'ignore'
      });
      if (settings.linux.wineDebug) {
        child.stdout?.on('data', (d: Buffer) => this.log.info(`[runtime] ${d.toString('utf-8').trimEnd()}`));
        child.stderr?.on('data', (d: Buffer) => this.log.warn(`[runtime] ${d.toString('utf-8').trimEnd()}`));
      } else {
        child.unref();
      }
    } else {
      throw new Error(`unsupported launcher platform: ${platform}`);
    }

    child.once('error', (e) => {
      this.log.error(`game process error: ${e.message}`);
    });
  }
}

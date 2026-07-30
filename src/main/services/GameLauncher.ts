import { spawn, type ChildProcess } from 'child_process';
import { accessSync, constants, statSync } from 'fs';
import { delimiter, isAbsolute, join, resolve } from 'path';
import { expandLinuxCommandTemplate } from '@shared/linuxCommandTemplate';
import type { Settings } from '@shared/types';
import type { Log } from './Log';
import type { LinuxRuntimeInspection } from './LinuxRuntime';

export interface LinuxLaunchCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function assertLinuxWrapperExecutable(
  command: string,
  baseCommand: string,
  environment: NodeJS.ProcessEnv,
  cwd: string
): void {
  if (command === baseCommand) return;

  const hasPathSeparator = command.includes('/') || command.includes('\\');
  const candidates = hasPathSeparator
    ? [isAbsolute(command) ? command : resolve(cwd, command)]
    : (environment.PATH ?? '')
        .split(delimiter)
        .map((entry) =>
          join(entry && isAbsolute(entry) ? entry : resolve(cwd, entry || '.'), command)
        );
  if (candidates.some(isExecutableFile)) return;
  throw new Error(
    `Linux command wrapper executable was not found or is not executable: ${command}`
  );
}

export function buildLinuxLaunchCommand(
  settings: Settings,
  runtime: LinuxRuntimeInspection,
  gameArgs: string[],
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
  launchEnvironment: NodeJS.ProcessEnv = {}
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
  const wrapped = expandLinuxCommandTemplate(
    settings.linux.commandTemplate,
    command,
    args,
    { ...inheritedEnvironment, ...env, ...launchEnvironment }
  );
  return { ...wrapped, env };
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
   *    The saved command template can then wrap that final command without invoking a shell.
   *    Wine receives the dinput8 override only after a managed or local DLL passes preparation,
   *    without changing the user's prefix configuration globally.
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
    linuxRuntime: LinuxRuntimeInspection | null = null,
    launchEnvironment: NodeJS.ProcessEnv = {}
  ): ChildProcess {
    const args = buildGameArgs(settings, host, developerLaunch);
    let child: ChildProcess;

    if (platform === 'win32') {
      this.log.info(`launching ${settings.gameExePath} with managed connection arguments`);
      child = spawn(settings.gameExePath, args, {
        cwd: binariesDir,
        env: { ...process.env, ...launchEnvironment },
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
      const launch = buildLinuxLaunchCommand(
        settings,
        linuxRuntime,
        args,
        process.env,
        launchEnvironment
      );
      const baseCommand =
        settings.linux.gameMode && linuxRuntime.gameModePath
          ? linuxRuntime.gameModePath
          : settings.linux.runner === 'proton'
            ? linuxRuntime.umuPath
            : linuxRuntime.winePath;
      const environment = { ...process.env, ...launch.env, ...launchEnvironment };
      assertLinuxWrapperExecutable(launch.command, baseCommand, environment, binariesDir);
      this.log.info(
        `launching ${settings.gameExePath} with ${settings.linux.runner} ` +
          `(prefix ${linuxRuntime.prefixPath}, GameMode=${settings.linux.gameMode && !!linuxRuntime.gameModePath}) ` +
          'and managed connection arguments'
      );
      child = spawn(launch.command, launch.args, {
        cwd: binariesDir,
        env: environment,
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
    return child;
  }
}

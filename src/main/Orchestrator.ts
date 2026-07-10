import { app } from 'electron';
import type {
  LauncherState,
  LauncherUpdateStatus,
  ServerChoice,
  Settings,
  UpdateProgress
} from '@shared/types';
import { DEFAULT_SERVER_ID } from '@shared/serverProfiles';
import type { ConfigStore } from './services/ConfigStore';
import type { Log } from './services/Log';
import { validateGameExe, autoDetectGame, type GameInstall } from './services/InstallLocator';
import { GameLauncher } from './services/GameLauncher';
import { probeServer } from './services/ServerProbe';
import { LauncherUpdater } from './services/LauncherUpdater';
import { fetchServerCommits } from './services/ServerCommits';
import { validateWineRunner } from './services/WineEnv';
import {
  ensureClientConfiguration,
  inspectClientPatches,
  unavailableClientPatches
} from './services/IniFixes';

const PLATFORM = process.platform as LauncherState['platform'];
const SERVER_PROBE_REFRESH_MS = 65_000;
const SERVER_CHECKING_STATUS = 'Checking server availability…';
const COMMIT_REFRESH_MS = 5 * 60_000;
const AUTO_CLOSE_DELAY_MS = 5_000;

interface ServerSelection {
  id: string;
  name: string;
  host: string;
  choices: ServerChoice[];
}

/** Owns launcher state and keeps the renderer as a pure state consumer. */
export class Orchestrator {
  private state: LauncherState;
  private install: GameInstall | null = null;
  private readonly gameLauncher: GameLauncher;
  private readonly launcherUpdater: LauncherUpdater;
  private broadcast: (state: LauncherState) => void = () => {};
  private busy = false;
  private refreshPending = false;
  private probeTimer: NodeJS.Timeout | null = null;
  private readonly probesInFlight = new Map<string, Promise<boolean>>();
  private offlineRefreshInFlight = false;
  private commitTimer: NodeJS.Timeout | null = null;
  private commitRefreshInFlight = false;
  private autoCloseTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigStore,
    private readonly log: Log,
    private readonly defaultServerHost: string,
    private readonly fallbackServerHost: string,
    private readonly defaultServerName: string
  ) {
    this.gameLauncher = new GameLauncher(log);
    this.launcherUpdater = new LauncherUpdater(log, {
      onStatus: (status: LauncherUpdateStatus, version, error) => {
        const patch: Partial<LauncherState> = {
          launcherUpdate: status,
          launcherUpdateVersion: version,
          launcherUpdateError: error
        };
        if (status === 'checking') {
          patch.phase = 'checking';
          patch.statusLine = 'Checking for launcher updates…';
          patch.errorDetails = null;
        } else if (status === 'downloading') {
          patch.phase = 'checking';
          patch.statusLine = `Downloading launcher ${version ? `v${version}` : 'update'}…`;
        } else if (status === 'installing') {
          patch.phase = 'checking';
          patch.statusLine = `Installing launcher ${version ? `v${version}` : 'update'}…`;
        } else if (status === 'error') {
          patch.phase = 'error';
          patch.statusLine = 'Launcher update check failed. Retry before playing.';
          patch.errorDetails = error;
        }
        this.patch(patch);
      },
      onProgress: (progress: UpdateProgress | null) => this.patch({ progress })
    });
    this.state = {
      phase: 'init',
      statusLine: 'Starting…',
      errorDetails: null,
      resolvedHost: defaultServerHost,
      serverName: defaultServerName,
      serverChoices: [{ id: DEFAULT_SERVER_ID, name: defaultServerName }],
      selectedServerId: DEFAULT_SERVER_ID,
      serverOnline: null,
      gamePathValid: false,
      validatedGameExePath: '',
      winePathValid: PLATFORM === 'linux' ? false : null,
      gameRunning: false,
      activeGameInstances: 0,
      developerMode: false,
      progress: null,
      launcherVersion: app.getVersion(),
      launcherUpdate: 'idle',
      launcherUpdateVersion: null,
      launcherUpdateError: null,
      clientPatches: unavailableClientPatches(),
      serverCommits: [],
      serverCommitsStatus: 'loading',
      platform: PLATFORM,
      accountTabEnabled: false
    };
  }

  setBroadcast(fn: (state: LauncherState) => void): void {
    this.broadcast = fn;
  }

  getState(): LauncherState {
    return this.state;
  }

  private patch(patch: Partial<LauncherState>): void {
    this.state = { ...this.state, ...patch };
    this.broadcast(this.state);
  }

  private resolveServer(settings: Settings): ServerSelection {
    const defaultChoice = {
      id: DEFAULT_SERVER_ID,
      name: this.defaultServerName
    };
    const choices = [
      defaultChoice,
      ...settings.developer.servers.map(({ id, name }) => ({ id, name }))
    ];
    if (settings.developer.enabled) {
      const selected = settings.developer.servers.find(
        (server) => server.id === settings.developer.selectedServerId
      );
      if (selected) return { ...selected, choices };
    }
    return {
      ...defaultChoice,
      host: this.defaultServerHost,
      choices
    };
  }

  private hostCandidates(selection: ServerSelection): string[] {
    const hosts = [selection.host];
    if (selection.id === DEFAULT_SERVER_ID && this.fallbackServerHost) {
      hosts.push(this.fallbackServerHost);
    }
    return hosts.filter(
      (host, index) =>
        host.length > 0 &&
        hosts.findIndex((candidate) => candidate.toLowerCase() === host.toLowerCase()) === index
    );
  }

  private applyServerSelection(settings: Settings): ServerSelection {
    const selection = this.resolveServer(settings);
    const candidates = this.hostCandidates(selection);
    const activeHost = candidates.find(
      (candidate) => candidate.toLowerCase() === this.state.resolvedHost.toLowerCase()
    );
    const resolvedHost = activeHost ?? selection.host;
    const hostChanged = resolvedHost !== this.state.resolvedHost;
    this.patch({
      resolvedHost,
      serverName: selection.name,
      serverChoices: selection.choices,
      selectedServerId: selection.id,
      developerMode: settings.developer.enabled,
      serverOnline: hostChanged ? null : this.state.serverOnline
    });
    void this.reprobe();
    return selection;
  }

  async start(): Promise<void> {
    await this.refresh();
    void this.refreshServerCommits();
    if (!this.probeTimer) {
      this.probeTimer = setInterval(
        () => void this.refreshWhileServerOffline(),
        SERVER_PROBE_REFRESH_MS
      );
    }
    if (!this.commitTimer) {
      this.commitTimer = setInterval(() => void this.refreshServerCommits(), COMMIT_REFRESH_MS);
    }
  }

  private async refreshServerCommits(): Promise<void> {
    if (this.commitRefreshInFlight) return;
    this.commitRefreshInFlight = true;
    if (this.state.serverCommits.length === 0) this.patch({ serverCommitsStatus: 'loading' });
    try {
      const commits = await fetchServerCommits();
      this.patch({ serverCommits: commits, serverCommitsStatus: 'ready' });
    } catch (error) {
      this.log.warn(`server commit history unavailable: ${(error as Error).message}`);
      this.patch({ serverCommitsStatus: 'error' });
    } finally {
      this.commitRefreshInFlight = false;
    }
  }

  private async refreshWhileServerOffline(): Promise<void> {
    if (this.offlineRefreshInFlight) return;
    const shouldCheckLauncher =
      app.isPackaged &&
      !this.state.developerMode &&
      this.state.serverOnline === false &&
      !this.state.gameRunning &&
      !this.busy &&
      (this.state.phase === 'ready' || this.state.launcherUpdate === 'error');
    if (!shouldCheckLauncher) {
      await this.reprobe();
      return;
    }

    this.offlineRefreshInFlight = true;
    const recoveringFromUpdateError = this.state.launcherUpdate === 'error';
    const resume = {
      phase: this.state.phase,
      statusLine: this.state.statusLine,
      errorDetails: this.state.errorDetails
    };
    try {
      if (!(await this.launcherUpdater.ensureCurrentFromNextSource())) return;
      if (recoveringFromUpdateError) {
        await this.refreshRuntimeState(false);
      } else {
        this.patch(resume);
        await this.reprobe();
      }
    } finally {
      this.offlineRefreshInFlight = false;
    }
  }

  private probeHost(host: string): Promise<boolean> {
    const existing = this.probesInFlight.get(host);
    if (existing) return existing;
    const pending = (async () => {
      try {
        return await probeServer(host);
      } finally {
        this.probesInFlight.delete(host);
      }
    })();
    this.probesInFlight.set(host, pending);
    return pending;
  }

  private async reprobe(): Promise<boolean> {
    const settings = this.config.get();
    const selection = this.resolveServer(settings);
    const candidates = this.hostCandidates(selection);
    if (candidates.length === 0) {
      if (this.state.serverOnline !== false) this.patch({ serverOnline: false });
      return false;
    }
    const showOfflineRetry =
      !this.state.developerMode &&
      this.state.phase === 'ready' &&
      this.state.gamePathValid &&
      (PLATFORM !== 'linux' || this.state.winePathValid === true) &&
      this.state.serverOnline === false;
    if (showOfflineRetry) {
      this.patch({ serverOnline: null, statusLine: SERVER_CHECKING_STATUS });
    }
    let reachableHost = candidates[0];
    let online = false;
    for (const candidate of candidates) {
      if (await this.probeHost(candidate)) {
        reachableHost = candidate;
        online = true;
        break;
      }
    }
    const currentSettings = this.config.get();
    const currentSelection = this.resolveServer(currentSettings);
    if (
      currentSelection.id !== selection.id ||
      currentSelection.host.toLowerCase() !== selection.host.toLowerCase()
    ) {
      return false;
    }
    const patch: Partial<LauncherState> = {};
    const resolvedHost = online ? reachableHost : candidates[0];
    if (resolvedHost !== this.state.resolvedHost) patch.resolvedHost = resolvedHost;
    if (online !== this.state.serverOnline) patch.serverOnline = online;
    if (this.state.statusLine === SERVER_CHECKING_STATUS) {
      patch.statusLine = 'Ready.';
    }
    if (Object.keys(patch).length > 0) this.patch(patch);
    return online;
  }

  async refresh(): Promise<void> {
    if (this.busy) {
      this.refreshPending = true;
      return;
    }
    this.refreshPending = false;
    const inGame = this.state.gameRunning;
    this.busy = true;
    try {
      if (!inGame) {
        this.patch({ phase: 'checking', statusLine: 'Checking for launcher updates…', errorDetails: null });
        if (!(await this.launcherUpdater.ensureCurrent())) return;
      }
      await this.refreshRuntimeState(inGame);
    } catch (error) {
      const message = (error as Error).message;
      this.log.error(`refresh failed: ${message}`);
      this.patch({ phase: 'error', statusLine: 'Startup check failed.', errorDetails: message });
    } finally {
      this.busy = false;
      if (this.refreshPending) void this.refresh();
    }
  }

  private async refreshRuntimeState(preserveGamePhase: boolean): Promise<void> {
    if (!preserveGamePhase) {
      this.patch({ phase: 'checking', statusLine: 'Checking local configuration…', errorDetails: null });
    }
    const settings = this.config.get();
    const [install, winePathValid, gameRunning]: [
      GameInstall | null,
      boolean | null,
      boolean
    ] = await Promise.all([
      validateGameExe(settings.gameExePath),
      PLATFORM === 'linux' ? validateWineRunner(settings.linux.winePath) : Promise.resolve(null),
      this.gameLauncher.isGameRunning(PLATFORM)
    ]);
    this.install = install;
    const clientPatches = await inspectClientPatches(install);
    this.log.info(`game install validation: ${install ? 'valid' : 'invalid or unset'}`);
    const selection = this.applyServerSelection(settings);
    this.patch({
      gamePathValid: install !== null,
      validatedGameExePath: settings.gameExePath,
      winePathValid,
      gameRunning,
      activeGameInstances: this.gameLauncher.activeInstanceCount(),
      clientPatches
    });
    if (preserveGamePhase) return;

    if (!selection.host) {
      this.patch({
        phase: 'error',
        serverOnline: false,
        statusLine: 'Server address unavailable. Retry after updating the launcher.',
        errorDetails: 'No default server address is configured for this build.'
      });
      return;
    }
    if (!install) {
      this.patch({
        phase: 'ready',
        statusLine: settings.gameExePath
          ? 'Game path is not a valid Global Agenda install — fix it in Settings.'
          : 'Set your Global Agenda install path in Settings.'
      });
      return;
    }
    if (PLATFORM === 'linux' && !winePathValid) {
      this.patch({ phase: 'ready', statusLine: 'Configure an executable Wine runner in Settings.' });
      return;
    }
    if (gameRunning) {
      this.patch({ phase: 'running', statusLine: 'Game process detected.' });
      return;
    }
    this.patch({ phase: 'ready', statusLine: 'Ready.' });
  }

  private gameInstancesChanged(count: number): void {
    if (count > 0) {
      const suffix = count === 1 ? 'instance' : 'instances';
      this.patch({
        phase: 'running',
        gameRunning: true,
        activeGameInstances: count,
        statusLine: `${count} game ${suffix} running.`
      });
      return;
    }
    void this.gameLauncher.isGameRunning(PLATFORM).then((running) => {
      if (this.gameLauncher.activeInstanceCount() > 0) return;
      this.patch({
        phase: running ? 'running' : 'ready',
        gameRunning: running,
        activeGameInstances: 0,
        statusLine: running ? 'Game process detected.' : 'Game closed.'
      });
    });
  }

  private shouldAutoClose(settings: Settings): boolean {
    return (
      settings.launch.closeAfterLaunch &&
      !settings.developer.enabled &&
      !(PLATFORM === 'linux' && settings.linux.wineDebug)
    );
  }

  private scheduleAutoCloseAfterLaunch(): void {
    if (!this.shouldAutoClose(this.config.get())) return;
    if (this.autoCloseTimer) clearTimeout(this.autoCloseTimer);
    this.log.info('auto-close: launcher will close in 5 seconds');
    this.patch({ statusLine: 'Game launched. Closing launcher in 5 seconds…' });
    this.autoCloseTimer = setTimeout(() => {
      this.autoCloseTimer = null;
      if (!this.shouldAutoClose(this.config.get())) {
        this.log.info('auto-close: canceled by current settings');
        this.patch({ statusLine: 'Game is running.' });
        return;
      }
      this.log.info('auto-close: closing launcher');
      app.quit();
    }, AUTO_CLOSE_DELAY_MS);
  }

  async play(developerLaunch = false): Promise<void> {
    const initialSettings = this.config.get();
    if (developerLaunch && !initialSettings.developer.enabled) {
      this.patch({ phase: 'ready', statusLine: 'Enable developer mode before using Dev Launch.' });
      return;
    }
    if (
      this.busy ||
      this.state.phase === 'launching' ||
      (this.state.phase === 'running' && !initialSettings.developer.enabled)
    ) {
      return;
    }
    this.busy = true;
    try {
      this.patch({ phase: 'checking', statusLine: 'Checking for launcher updates…', errorDetails: null });
      if (!(await this.launcherUpdater.ensureCurrent())) return;

      const settings = this.config.get();
      const selection = this.applyServerSelection(settings);
      if (!settings.developer.enabled && (await this.gameLauncher.isGameRunning(PLATFORM))) {
        this.patch({ phase: 'running', gameRunning: true, statusLine: 'Game is already running.' });
        return;
      }
      if (!this.install) {
        this.patch({ phase: 'ready', statusLine: 'Set your Global Agenda install path in Settings first.' });
        return;
      }
      if (!selection.host) {
        this.patch({
          phase: 'error',
          statusLine: 'Server address unavailable. Retry after updating the launcher.',
          errorDetails: 'Play is blocked until a server address can be resolved.'
        });
        return;
      }
      if (!settings.developer.enabled) {
        this.patch({
          phase: 'checking',
          statusLine: SERVER_CHECKING_STATUS,
          errorDetails: null
        });
        if (!(await this.reprobe())) {
          this.patch({
            phase: 'ready',
            serverOnline: false,
            statusLine: 'Ready.',
            errorDetails: null
          });
          return;
        }
      }
      const launchHost =
        this.hostCandidates(selection).find(
          (candidate) => candidate.toLowerCase() === this.state.resolvedHost.toLowerCase()
        ) ?? selection.host;

      this.patch({ phase: 'checking', statusLine: 'Checking client configuration…', errorDetails: null });
      await ensureClientConfiguration(
        this.install,
        settings.loginMap,
        settings.showOverhealing,
        this.log
      );
      this.patch({ clientPatches: await inspectClientPatches(this.install) });

      this.patch({
        phase: 'launching',
        statusLine: `Launching ${selection.name}${developerLaunch ? ' with developer display settings' : ''}…`
      });
      this.gameLauncher.launch(
        settings,
        launchHost,
        this.install.binariesDir,
        PLATFORM,
        developerLaunch,
        (count) => this.gameInstancesChanged(count),
        () => this.scheduleAutoCloseAfterLaunch()
      );
    } catch (error) {
      const message = (error as Error).message;
      const count = this.gameLauncher.activeInstanceCount();
      this.log.error(`launch failed: ${message}`);
      this.patch({
        phase: count > 0 ? 'running' : 'ready',
        gameRunning: count > 0,
        activeGameInstances: count,
        statusLine: `Launch failed: ${message}`,
        errorDetails: message
      });
    } finally {
      this.busy = false;
      if (this.refreshPending) void this.refresh();
    }
  }

  async selectDeveloperServer(id: string): Promise<void> {
    const settings = this.config.get();
    if (!settings.developer.enabled) throw new Error('Developer mode is not enabled.');
    if (
      id !== DEFAULT_SERVER_ID &&
      !settings.developer.servers.some((server) => server.id === id)
    ) {
      throw new Error('Unknown developer server.');
    }
    await this.config.update({ developer: { selectedServerId: id } });
    await this.refreshRuntimeState(this.state.gameRunning);
  }

  async settingsChanged(): Promise<void> {
    await this.refresh();
  }

  async autoDetect(): Promise<string | null> {
    const settings = this.config.get();
    const found = await autoDetectGame(PLATFORM, settings.linux.winePrefix, this.log);
    if (!found) return null;
    await this.config.update({ gameExePath: found.exePath });
    await this.refresh();
    return found.exePath;
  }
}

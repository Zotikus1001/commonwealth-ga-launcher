import { app } from 'electron';
import type {
  ActionResult,
  ClientPatchId,
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
import { probeServer, type ServerProbeStatus } from './services/ServerProbe';
import { LauncherUpdater } from './services/LauncherUpdater';
import { fetchAgendaStatsStatus } from './services/AgendaStats';
import { fetchServerCommits } from './services/ServerCommits';
import { validateWineRunner } from './services/WineEnv';
import {
  applyClientPatch as applyIniClientPatch,
  ensureClientConfiguration,
  inspectClientPatches,
  unavailableClientPatches
} from './services/IniFixes';

const PLATFORM = process.platform as LauncherState['platform'];
const SERVER_PROBE_REFRESH_MS = 65_000;
const SERVER_CHECKING_STATUS = 'Checking server availability…';
const SERVER_OFFLINE_STATUS = 'Selected server is offline.';
const SERVER_INVALID_STATUS = 'Selected server address is invalid or cannot be resolved.';
const COMMIT_REFRESH_MS = 5 * 60_000;
const AGENDA_STATS_REFRESH_MS = 60_000;
const AUTO_CLOSE_DELAY_MS = 5_000;
const LAUNCH_COOLDOWN_MS = 5_000;

interface ServerSelection {
  id: string;
  name: string;
  host: string;
  choices: ServerChoice[];
}

interface CandidateProbeResult {
  host: string;
  status: ServerProbeStatus;
}

/** Owns launcher state and keeps the renderer as a pure state consumer. */
export class Orchestrator {
  private state: LauncherState;
  private install: GameInstall | null = null;
  private readonly gameLauncher: GameLauncher;
  private broadcast: (state: LauncherState) => void = () => {};
  private busy = false;
  private refreshPending = false;
  private probeTimer: NodeJS.Timeout | null = null;
  private readonly probesInFlight = new Map<string, Promise<ServerProbeStatus>>();
  private offlineRefreshInFlight = false;
  private commitTimer: NodeJS.Timeout | null = null;
  private commitRefreshInFlight = false;
  private agendaStatsTimer: NodeJS.Timeout | null = null;
  private agendaStatsRefreshInFlight = false;
  private autoCloseTimer: NodeJS.Timeout | null = null;
  private launchCooldownTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigStore,
    private readonly log: Log,
    private readonly defaultServerHost: string,
    private readonly fallbackServerHost: string,
    private readonly launcherUpdater: LauncherUpdater
  ) {
    this.gameLauncher = new GameLauncher(log);
    const launcherUpdate = launcherUpdater.getSnapshot();
    this.state = {
      phase: 'init',
      statusLine: 'Starting…',
      errorDetails: null,
      resolvedHost: defaultServerHost,
      serverName: config.get().servers.builtInName,
      serverChoices: [{ id: DEFAULT_SERVER_ID, name: config.get().servers.builtInName }],
      selectedServerId: DEFAULT_SERVER_ID,
      serverStatus: 'checking',
      gamePathValid: false,
      validatedGameExePath: '',
      winePathValid: PLATFORM === 'linux' ? false : null,
      launchCoolingDown: false,
      developerMode: false,
      progress: launcherUpdate.progress,
      launcherVersion: app.getVersion(),
      launcherUpdate: launcherUpdate.status,
      launcherUpdateVersion: launcherUpdate.version,
      launcherUpdateError: launcherUpdate.error,
      clientPatches: unavailableClientPatches(),
      serverCommits: [],
      serverCommitsStatus: 'loading',
      agendaStatsText: null,
      agendaStatsStatus: 'loading',
      platform: PLATFORM,
      accountTabEnabled: false
    };
    launcherUpdater.setEvents({
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
      name: settings.servers.builtInName
    };
    const choices = [
      defaultChoice,
      ...settings.servers.custom.map(({ id, name }) => ({ id, name }))
    ];
    const selected = settings.servers.custom.find(
      (server) => server.id === settings.servers.selectedServerId
    );
    if (selected) return { ...selected, choices };
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
    const selectedServerChanged = selection.id !== this.state.selectedServerId;
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
      serverStatus: hostChanged ? 'checking' : this.state.serverStatus
    });
    void this.reprobe();
    if (selectedServerChanged && selection.id === DEFAULT_SERVER_ID) {
      void this.refreshAgendaStats(true);
    }
    return selection;
  }

  async start(startupUpdateChecked = false): Promise<void> {
    if (startupUpdateChecked) {
      await this.refreshRuntimeState();
    } else {
      await this.refresh();
    }
    void this.refreshServerCommits();
    void this.refreshAgendaStats(true);
    if (!this.probeTimer) {
      this.probeTimer = setInterval(
        () => void this.refreshWhileServerOffline(),
        SERVER_PROBE_REFRESH_MS
      );
    }
    if (!this.commitTimer) {
      this.commitTimer = setInterval(() => void this.refreshServerCommits(), COMMIT_REFRESH_MS);
    }
    if (!this.agendaStatsTimer) {
      this.agendaStatsTimer = setInterval(
        () => void this.refreshAgendaStats(),
        AGENDA_STATS_REFRESH_MS
      );
    }
  }

  private async refreshAgendaStats(showLoading = false): Promise<void> {
    if (this.state.selectedServerId !== DEFAULT_SERVER_ID) return;
    if (showLoading) this.patch({ agendaStatsText: null, agendaStatsStatus: 'loading' });
    if (this.agendaStatsRefreshInFlight) return;
    this.agendaStatsRefreshInFlight = true;
    try {
      const text = await fetchAgendaStatsStatus();
      if (this.state.selectedServerId === DEFAULT_SERVER_ID) {
        this.patch({ agendaStatsText: text, agendaStatsStatus: 'ready' });
      }
    } catch (error) {
      this.log.warn(`Agenda Stats unavailable: ${(error as Error).message}`);
      if (this.state.selectedServerId === DEFAULT_SERVER_ID) {
        this.patch({ agendaStatsStatus: 'error' });
      }
    } finally {
      this.agendaStatsRefreshInFlight = false;
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
      (this.state.serverStatus === 'offline' || this.state.serverStatus === 'invalid') &&
      !this.state.launchCoolingDown &&
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
        await this.refreshRuntimeState();
      } else {
        this.patch(resume);
        await this.reprobe();
      }
    } finally {
      this.offlineRefreshInFlight = false;
    }
  }

  private probeHost(host: string): Promise<ServerProbeStatus> {
    const existing = this.probesInFlight.get(host);
    if (existing) return existing;
    const pending = (async () => {
      try {
        return await probeServer(host);
      } catch (error) {
        this.log.warn(`server probe failed unexpectedly for ${host}: ${(error as Error).message}`);
        return 'offline' as const;
      } finally {
        this.probesInFlight.delete(host);
      }
    })();
    this.probesInFlight.set(host, pending);
    return pending;
  }

  private probeCandidates(candidates: string[]): Promise<CandidateProbeResult> {
    return new Promise((resolve) => {
      let remaining = candidates.length;
      let sawOffline = false;
      let settled = false;
      const finish = (result: CandidateProbeResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      for (const host of candidates) {
        void this.probeHost(host).then((status) => {
          if (settled) return;
          if (status === 'online') {
            finish({ host, status });
            return;
          }
          if (status === 'offline') sawOffline = true;
          remaining -= 1;
          if (remaining === 0) {
            finish({
              host: candidates[0],
              status: sawOffline ? 'offline' : 'invalid'
            });
          }
        });
      }
    });
  }

  private async reprobe(): Promise<boolean> {
    const settings = this.config.get();
    const selection = this.resolveServer(settings);
    const candidates = this.hostCandidates(selection);
    if (candidates.length === 0) {
      if (this.state.serverStatus !== 'invalid') this.patch({ serverStatus: 'invalid' });
      return false;
    }
    const showServerStatus =
      !this.state.developerMode &&
      this.state.phase === 'ready' &&
      this.state.gamePathValid &&
      (PLATFORM !== 'linux' || this.state.winePathValid === true);
    this.patch({
      serverStatus: 'checking',
      ...(showServerStatus ? { statusLine: SERVER_CHECKING_STATUS } : {})
    });
    const result = await this.probeCandidates(candidates);
    const currentSettings = this.config.get();
    const currentSelection = this.resolveServer(currentSettings);
    if (
      currentSelection.id !== selection.id ||
      currentSelection.host.toLowerCase() !== selection.host.toLowerCase()
    ) {
      return false;
    }
    const patch: Partial<LauncherState> = {};
    const resolvedHost = result.status === 'online' ? result.host : candidates[0];
    if (resolvedHost !== this.state.resolvedHost) patch.resolvedHost = resolvedHost;
    if (result.status !== this.state.serverStatus) patch.serverStatus = result.status;
    const canShowTerminalStatus =
      !this.state.developerMode &&
      this.state.phase === 'ready' &&
      this.state.gamePathValid &&
      (PLATFORM !== 'linux' || this.state.winePathValid === true) &&
      (this.state.statusLine === 'Ready.' ||
        this.state.statusLine === SERVER_CHECKING_STATUS ||
        this.state.statusLine === SERVER_OFFLINE_STATUS ||
        this.state.statusLine === SERVER_INVALID_STATUS);
    if (canShowTerminalStatus) {
      patch.statusLine =
        result.status === 'online'
          ? 'Ready.'
          : result.status === 'invalid'
            ? SERVER_INVALID_STATUS
            : SERVER_OFFLINE_STATUS;
    }
    if (Object.keys(patch).length > 0) this.patch(patch);
    return result.status === 'online';
  }

  async refresh(): Promise<void> {
    if (this.busy) {
      this.refreshPending = true;
      return;
    }
    this.refreshPending = false;
    this.busy = true;
    try {
      this.patch({ phase: 'checking', statusLine: 'Checking for launcher updates…', errorDetails: null });
      if (!(await this.launcherUpdater.ensureCurrent())) return;
      await this.refreshRuntimeState();
    } catch (error) {
      const message = (error as Error).message;
      this.log.error(`refresh failed: ${message}`);
      this.patch({ phase: 'error', statusLine: 'Startup check failed.', errorDetails: message });
    } finally {
      this.busy = false;
      if (this.refreshPending) void this.refresh();
    }
  }

  private async refreshRuntimeState(): Promise<void> {
    this.patch({ phase: 'checking', statusLine: 'Checking local configuration…', errorDetails: null });
    const settings = this.config.get();
    const [install, winePathValid]: [GameInstall | null, boolean | null] = await Promise.all([
      validateGameExe(settings.gameExePath),
      PLATFORM === 'linux' ? validateWineRunner(settings.linux.winePath) : Promise.resolve(null)
    ]);
    this.install = install;
    const clientPatches = await inspectClientPatches(install);
    this.log.info(`game install validation: ${install ? 'valid' : 'invalid or unset'}`);
    const selection = this.applyServerSelection(settings);
    this.patch({
      gamePathValid: install !== null,
      validatedGameExePath: settings.gameExePath,
      winePathValid,
      clientPatches
    });

    if (!selection.host) {
      this.patch({
        phase: 'error',
        serverStatus: 'invalid',
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
    this.patch({ phase: 'ready', statusLine: 'Ready.' });
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
    this.patch({ statusLine: 'Closing launcher in 5 seconds…' });
    this.autoCloseTimer = setTimeout(() => {
      this.autoCloseTimer = null;
      if (!this.shouldAutoClose(this.config.get())) {
        this.log.info('auto-close: canceled by current settings');
        this.patch({ statusLine: 'Ready.' });
        return;
      }
      this.log.info('auto-close: closing launcher');
      app.quit();
    }, AUTO_CLOSE_DELAY_MS);
  }

  private scheduleLaunchCooldown(): void {
    if (this.launchCooldownTimer) clearTimeout(this.launchCooldownTimer);
    this.log.info('launch attempt: Play is locked for 5 seconds');
    this.launchCooldownTimer = setTimeout(() => {
      this.launchCooldownTimer = null;
      if (this.state.phase === 'launching') {
        this.patch({
          phase: 'ready',
          launchCoolingDown: false,
          statusLine: 'Ready.',
          errorDetails: null
        });
      } else {
        this.patch({ launchCoolingDown: false });
      }
    }, LAUNCH_COOLDOWN_MS);
  }

  async play(developerLaunch = false): Promise<void> {
    const initialSettings = this.config.get();
    if (developerLaunch && !initialSettings.developer.enabled) {
      this.patch({ phase: 'ready', statusLine: 'Enable developer mode before using Dev Launch.' });
      return;
    }
    if (
      this.busy ||
      this.state.launchCoolingDown ||
      this.state.phase === 'launching'
    ) {
      return;
    }
    this.busy = true;
    try {
      this.patch({ phase: 'checking', statusLine: 'Checking for launcher updates…', errorDetails: null });
      if (!(await this.launcherUpdater.ensureCurrent())) return;

      const settings = this.config.get();
      const selection = this.applyServerSelection(settings);
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
            statusLine:
              this.state.serverStatus === 'invalid'
                ? SERVER_INVALID_STATUS
                : SERVER_OFFLINE_STATUS,
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
        settings.fpsLimit.enabled,
        settings.fpsLimit.value,
        this.log
      );
      this.patch({ clientPatches: await inspectClientPatches(this.install) });

      this.patch({
        phase: 'launching',
        launchCoolingDown: true,
        statusLine: `Launching ${selection.name}${developerLaunch ? ' with developer display settings' : ''}…`
      });
      this.gameLauncher.launch(
        settings,
        launchHost,
        this.install.binariesDir,
        PLATFORM,
        developerLaunch
      );
      this.scheduleAutoCloseAfterLaunch();
      this.scheduleLaunchCooldown();
    } catch (error) {
      const message = (error as Error).message;
      this.log.error(`launch failed: ${message}`);
      this.patch({
        phase: 'ready',
        launchCoolingDown: false,
        statusLine: `Launch failed: ${message}`,
        errorDetails: message
      });
    } finally {
      this.busy = false;
      if (this.refreshPending) void this.refresh();
    }
  }

  async applyClientPatch(id: ClientPatchId): Promise<ActionResult> {
    if (this.state.launcherUpdate !== 'up-to-date' && this.state.launcherUpdate !== 'disabled') {
      return { ok: false, message: 'Update the launcher before changing client files.' };
    }
    if (this.busy) return { ok: false, message: 'The launcher is busy. Try again shortly.' };
    this.busy = true;
    try {
      if (this.state.launchCoolingDown) {
        return { ok: false, message: 'Wait for the current game launch to finish.' };
      }
      const settings = this.config.get();
      const install = await validateGameExe(settings.gameExePath);
      this.install = install;
      if (!install) {
        this.patch({
          gamePathValid: false,
          validatedGameExePath: settings.gameExePath,
          clientPatches: unavailableClientPatches()
        });
        return { ok: false, message: 'Set a valid Global Agenda install path first.' };
      }

      const result = await applyIniClientPatch(install, id, this.log);
      const clientPatches = await inspectClientPatches(install);
      this.patch({
        gamePathValid: true,
        validatedGameExePath: settings.gameExePath,
        clientPatches
      });
      if (!clientPatches.find((patch) => patch.id === id)?.applied) {
        throw new Error('The patch could not be verified after writing it.');
      }
      return {
        ok: true,
        message: result.changedFiles.length > 0 ? 'Patch applied.' : 'Patch is already applied.'
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`manual client patch failed: ${message}`);
      this.patch({ clientPatches: await inspectClientPatches(this.install) });
      return { ok: false, message: `Could not apply patch: ${message}` };
    } finally {
      this.busy = false;
      if (this.refreshPending) void this.refresh();
    }
  }

  async selectServer(id: string): Promise<void> {
    const settings = this.config.get();
    if (
      id !== DEFAULT_SERVER_ID &&
      !settings.servers.custom.some((server) => server.id === id)
    ) {
      throw new Error('Unknown server.');
    }
    await this.config.update({ servers: { selectedServerId: id } });
    await this.refreshRuntimeState();
  }

  async checkServer(): Promise<void> {
    if (
      this.busy ||
      this.state.developerMode ||
      this.state.launchCoolingDown ||
      this.state.phase !== 'ready' ||
      this.state.serverStatus !== 'offline'
    ) {
      return;
    }
    this.busy = true;
    try {
      await this.reprobe();
    } catch (error) {
      this.log.warn(`manual server check failed: ${(error as Error).message}`);
      this.patch({ serverStatus: 'offline', statusLine: SERVER_OFFLINE_STATUS });
    } finally {
      this.busy = false;
      if (this.refreshPending) void this.refresh();
    }
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

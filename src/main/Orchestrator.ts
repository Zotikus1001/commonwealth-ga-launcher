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
import {
  inspectLinuxRuntime,
  resolveExistingPrefix,
  type LinuxRuntimeInspection
} from './services/LinuxRuntime';
import {
  applyClientPatch as applyIniClientPatch,
  ensureClientConfiguration,
  inspectClientPatches,
  inspectGameIniSettings,
  unavailableClientPatches
} from './services/IniFixes';
import { DxvkManager, unavailableDxvkState } from './services/DxvkManager';

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
  private linuxRuntime: LinuxRuntimeInspection | null = null;
  private readonly gameLauncher: GameLauncher;
  private readonly dxvkManager: DxvkManager;
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
    this.dxvkManager = new DxvkManager(app.getPath('userData'), log);
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
      linuxRuntimeStatus: PLATFORM === 'linux' ? 'wine-runner-missing' : null,
      resolvedLinuxPrefix: '',
      gameModeAvailable: PLATFORM === 'linux' ? false : null,
      dxvk: unavailableDxvkState(PLATFORM),
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
    this.offlineRefreshInFlight = true;
    try {
      await this.reprobe();
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
      (PLATFORM !== 'linux' || this.state.linuxRuntimeStatus === 'ready');
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
      (PLATFORM !== 'linux' || this.state.linuxRuntimeStatus === 'ready') &&
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

  async checkLauncherUpdates(): Promise<void> {
    await this.launcherUpdater.ensureCurrent();
  }

  private async refreshRuntimeState(): Promise<void> {
    this.patch({ phase: 'checking', statusLine: 'Checking local configuration…', errorDetails: null });
    let settings = this.config.get();
    const [install, linuxRuntime] = await Promise.all([
      validateGameExe(settings.gameExePath),
      PLATFORM === 'linux' ? inspectLinuxRuntime(settings, this.log) : Promise.resolve(null)
    ]);
    this.install = install;
    this.linuxRuntime = linuxRuntime;
    if (linuxRuntime?.suggestedPrefixPath) {
      settings = await this.config.update({
        linux: { winePrefix: linuxRuntime.suggestedPrefixPath }
      });
    }
    let clientPatches = unavailableClientPatches();
    let dxvk = unavailableDxvkState(PLATFORM);
    if (install) {
      const [patches, gameIniSettings, inspectedDxvk] = await Promise.all([
        inspectClientPatches(install),
        inspectGameIniSettings(install),
        PLATFORM === 'win32'
          ? this.dxvkManager.inspect(install)
          : Promise.resolve(unavailableDxvkState(PLATFORM))
      ]);
      clientPatches = patches;
      dxvk = inspectedDxvk;
      settings = await this.config.syncGameIniSettings(settings.gameExePath, gameIniSettings);
    }
    this.log.info(`game install validation: ${install ? 'valid' : 'invalid or unset'}`);
    const selection = this.applyServerSelection(settings);
    this.patch({
      gamePathValid: install !== null,
      validatedGameExePath: settings.gameExePath,
      linuxRuntimeStatus: linuxRuntime?.status ?? null,
      resolvedLinuxPrefix: linuxRuntime?.prefixPath ?? '',
      gameModeAvailable: linuxRuntime ? !!linuxRuntime.gameModePath : null,
      clientPatches,
      dxvk
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
    if (PLATFORM === 'linux' && linuxRuntime?.status !== 'ready') {
      this.patch({ phase: 'ready', statusLine: 'Complete your Linux game setup in Settings.' });
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
    if (this.launcherUpdater.getSnapshot().status === 'downloading') return;
    if (
      this.busy ||
      this.state.launchCoolingDown ||
      this.state.phase === 'launching'
    ) {
      return;
    }
    this.busy = true;
    try {
      void this.launcherUpdater.ensureCurrent();

      const settings = this.config.get();
      const selection = this.applyServerSelection(settings);
      if (!this.install) {
        this.patch({ phase: 'ready', statusLine: 'Set your Global Agenda install path in Settings first.' });
        return;
      }
      if (PLATFORM === 'linux' && this.linuxRuntime?.status !== 'ready') {
        this.patch({ phase: 'ready', statusLine: 'Complete your Linux game setup in Settings.' });
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

      let useDxvk = false;
      if (PLATFORM === 'win32') {
        useDxvk = settings.developer.useDxvk;
        this.patch({
          dxvk: {
            ...this.state.dxvk,
            status: 'preparing',
            detail: useDxvk
              ? `Preparing DXVK/Vulkan ${this.state.dxvk.version} for launch…`
              : 'Restoring the previous Direct3D configuration…'
          },
          statusLine: useDxvk
            ? `Preparing DXVK/Vulkan ${this.state.dxvk.version}…`
            : 'Checking native graphics configuration…'
        });
        const dxvk = await this.dxvkManager.prepareForLaunch(
          this.install,
          useDxvk,
          ({ transferred, total }) => {
            const percent = total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : -1;
            this.patch({
              statusLine:
                percent >= 0
                  ? `Downloading DXVK/Vulkan ${this.state.dxvk.version}… ${percent}%`
                  : `Downloading DXVK/Vulkan ${this.state.dxvk.version}…`
            });
          }
        );
        this.patch({ dxvk });
      }

      if (this.launcherUpdater.getSnapshot().status === 'downloading') {
        this.patch({ phase: 'ready', statusLine: 'Launcher update is downloading…' });
        return;
      }

      this.patch({
        phase: 'launching',
        launchCoolingDown: true,
        statusLine:
          `Launching ${selection.name}` +
          (developerLaunch ? ' with developer settings' : '') +
          (useDxvk ? `${developerLaunch ? ' and' : ' with'} DXVK/Vulkan` : '') +
          '…'
      });
      this.gameLauncher.launch(
        settings,
        launchHost,
        this.install.binariesDir,
        PLATFORM,
        developerLaunch,
        this.linuxRuntime,
        useDxvk ? this.dxvkManager.launchEnvironment() : {}
      );
      this.scheduleAutoCloseAfterLaunch();
      this.scheduleLaunchCooldown();
    } catch (error) {
      const message = (error as Error).message;
      this.log.error(`launch failed: ${message}`);
      let dxvk = this.state.dxvk;
      if (PLATFORM === 'win32' && this.install) {
        try {
          dxvk = await this.dxvkManager.inspect(this.install);
        } catch (inspectError) {
          dxvk = {
            ...dxvk,
            status: 'error',
            detail: `DXVK/Vulkan inspection failed after launch error: ${(inspectError as Error).message}`
          };
        }
      }
      this.patch({
        phase: 'ready',
        launchCoolingDown: false,
        statusLine: `Launch failed: ${message}`,
        errorDetails: message,
        dxvk
      });
    } finally {
      this.busy = false;
      if (this.refreshPending) void this.refresh();
    }
  }

  async applyClientPatch(id: ClientPatchId): Promise<ActionResult> {
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

  private async configureDxvkVulkan(enabled: boolean): Promise<ActionResult> {
    if (PLATFORM !== 'win32') {
      return { ok: false, message: 'DXVK/Vulkan is currently available only on Windows.' };
    }
    if (this.busy || this.state.launchCoolingDown) {
      return { ok: false, message: 'The launcher is busy. Try again shortly.' };
    }
    this.busy = true;
    try {
      const install = await validateGameExe(this.config.get().gameExePath);
      this.install = install;
      if (!install) return { ok: false, message: 'Set a valid Global Agenda installation first.' };
      const initialDetail = enabled
        ? `Preparing DXVK/Vulkan ${this.state.dxvk.version}…`
        : 'Restoring the previous Direct3D configuration…';
      this.patch({
        dxvk: { ...this.state.dxvk, status: 'preparing', detail: initialDetail },
        phase: 'checking',
        statusLine: initialDetail
      });
      const dxvk = await this.dxvkManager.prepareForLaunch(
        install,
        enabled,
        ({ transferred, total }) => {
          const percent = total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : -1;
          const detail =
            percent >= 0
              ? `Downloading DXVK/Vulkan ${this.state.dxvk.version}… ${percent}%`
              : `Downloading DXVK/Vulkan ${this.state.dxvk.version}…`;
          this.patch({
            dxvk: { ...this.state.dxvk, status: 'preparing', detail },
            statusLine: detail
          });
        }
      );
      const statusLine = enabled
        ? `DXVK/Vulkan ${dxvk.version} is ready.`
        : 'Native graphics configuration restored.';
      this.patch({ dxvk, phase: 'ready', statusLine });
      return {
        ok: true,
        message: enabled
          ? `DXVK/Vulkan ${dxvk.version} is ready.`
          : 'The previous graphics and DirectX configuration was restored.'
      };
    } catch (error) {
      const message = (error as Error).message;
      const action = enabled ? 'activation' : 'restoration';
      this.log.error(`DXVK/Vulkan ${action} failed: ${message}`);
      let dxvk = this.state.dxvk;
      if (this.install) {
        try {
          dxvk = await this.dxvkManager.inspect(this.install);
        } catch (inspectError) {
          dxvk = {
            ...dxvk,
            status: 'error',
            detail: `DXVK/Vulkan inspection failed after ${action} error: ${(inspectError as Error).message}`
          };
        }
      }
      const failure = enabled
        ? `Could not prepare DXVK/Vulkan: ${message}`
        : `Could not restore graphics configuration: ${message}`;
      this.patch({ dxvk, phase: 'ready', statusLine: failure });
      return { ok: false, message: failure };
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

  async settingsChanged(dxvkEnabled: boolean | null = null): Promise<void> {
    if (dxvkEnabled !== null) {
      const result = await this.configureDxvkVulkan(dxvkEnabled);
      if (!result.ok) throw new Error(result.message);
    }
    await this.refresh();
  }

  async autoDetect(): Promise<string | null> {
    const settings = this.config.get();
    const existingPrefix =
      PLATFORM === 'linux'
        ? await resolveExistingPrefix(settings.linux.winePrefix)
        : settings.linux.winePrefix;
    const found = await autoDetectGame(
      PLATFORM,
      existingPrefix ?? settings.linux.winePrefix,
      this.log
    );
    if (!found) return null;
    await this.config.update({ gameExePath: found.exePath });
    await this.refresh();
    return found.exePath;
  }
}

import { app } from 'electron';
import type { ChildProcess } from 'child_process';
import {
  DLC_SETTING_KEY_BY_ID,
  type ActionResult,
  type ClientPatchId,
  type DlcId,
  type DlcStatus,
  type GameClientDllState,
  type LauncherState,
  type LauncherUpdateStatus,
  type ProfilePlayDecision,
  type ProfilePlayPrompt,
  type ProfileSwitchDecision,
  type ProfileSwitchPrompt,
  type ServerChoice,
  type Settings,
  type UpdateProgress
} from '@shared/types';
import { LAUNCHER_CONFIG } from '@shared/generatedLauncherConfig';
import { DEFAULT_SERVER_ID } from '@shared/serverProfiles';
import { DEFAULT_GAME_PROFILES_ENABLED } from '@shared/gameProfiles';
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
  removeClientPatch as removeIniClientPatch,
  unavailableClientPatches
} from './services/IniFixes';
import { DxvkManager, unavailableDxvkState } from './services/DxvkManager';
import { GpuMemoryDetector } from './services/GpuMemory';
import {
  ClientPatchManager,
  unavailableGameClientDllState
} from './services/ClientPatchManager';
import { managedIniBackupDirectory } from './services/ManagedInstallState';
import { GameProfileManager } from './services/GameProfileManager';
import { GameProcessTracker } from './services/GameProcessTracker';
import {
  DlcManager,
  failedDlcStatus,
  unavailableDlcStatuses
} from './services/DlcManager';

const PLATFORM = process.platform as LauncherState['platform'];
const SERVER_PROBE_REFRESH_MS = 65_000;
const SERVER_CHECKING_STATUS = 'Checking server availability…';
const SERVER_OFFLINE_STATUS = 'Selected server is offline.';
const SERVER_INVALID_STATUS = 'Selected server address is invalid or cannot be resolved.';
const COMMIT_REFRESH_MS = 5 * 60_000;
const AGENDA_STATS_REFRESH_MS = 60_000;
const AUTO_CLOSE_DELAY_MS = 5_000;
const LAUNCH_COOLDOWN_MS = 5_000;
const GAME_PROCESS_REFRESH_MS = 3_000;
function sameGameExecutable(left: string, right: string): boolean {
  return left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase();
}

function dlcPhasePercent(completed: number, total: number): number {
  if (total <= 0) return -1;
  return Math.min(100, Math.max(0, Math.round((completed / total) * 100)));
}

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

function enabledDlcDefinitions(settings: Settings) {
  return LAUNCHER_CONFIG.dlcs.filter(
    (definition) => settings.dlcs[DLC_SETTING_KEY_BY_ID[definition.id]]
  );
}

/** Owns launcher state and keeps the renderer as a pure state consumer. */
export class Orchestrator {
  private state: LauncherState;
  private install: GameInstall | null = null;
  private dlcsPreparedGameExePath = '';
  private linuxRuntime: LinuxRuntimeInspection | null = null;
  private readonly gameLauncher: GameLauncher;
  private readonly dxvkManager: DxvkManager;
  private readonly gpuMemoryDetector: GpuMemoryDetector;
  private readonly clientPatchManager: ClientPatchManager;
  private readonly gameProfileManager: GameProfileManager;
  private readonly gameProcessTracker: GameProcessTracker;
  private readonly dlcManager: DlcManager;
  private broadcast: (state: LauncherState) => void = () => {};
  private busy = false;
  private refreshPending = false;
  private patchStatusRefreshInFlight: Promise<void> | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private readonly probesInFlight = new Map<string, Promise<ServerProbeStatus>>();
  private offlineRefreshInFlight = false;
  private commitTimer: NodeJS.Timeout | null = null;
  private commitRefreshInFlight = false;
  private agendaStatsTimer: NodeJS.Timeout | null = null;
  private agendaStatsRefreshInFlight = false;
  private autoCloseTimer: NodeJS.Timeout | null = null;
  private launchCooldownTimer: NodeJS.Timeout | null = null;
  private readonly activeGameProcesses = new Set<ChildProcess>();
  private gameProcessTimer: NodeJS.Timeout | null = null;
  private gameProcessRefreshInFlight: Promise<number> | null = null;

  constructor(
    private readonly config: ConfigStore,
    private readonly log: Log,
    private readonly defaultServerHost: string,
    private readonly fallbackServerHost: string,
    private readonly launcherUpdater: LauncherUpdater
  ) {
    this.gameLauncher = new GameLauncher(log);
    this.dxvkManager = new DxvkManager(app.getPath('userData'), log);
    this.gpuMemoryDetector = new GpuMemoryDetector(PLATFORM, log);
    this.clientPatchManager = new ClientPatchManager(app.getPath('userData'), log);
    this.gameProfileManager = new GameProfileManager(app.getPath('userData'), log);
    this.gameProcessTracker = new GameProcessTracker(app.getPath('userData'), log);
    this.dlcManager = new DlcManager(app.getPath('userData'), log);
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
      dxvk: unavailableDxvkState(PLATFORM, config.get().developer.dxvkVersion),
      launchCoolingDown: false,
      activeGameInstances: 0,
      developerMode: false,
      progress: launcherUpdate.progress,
      launcherVersion: app.getVersion(),
      launcherUpdate: launcherUpdate.status,
      launcherUpdateVersion: launcherUpdate.version,
      launcherUpdateError: launcherUpdate.error,
      gameClientDll: unavailableGameClientDllState(),
      clientPatches: unavailableClientPatches(),
      dlcs: unavailableDlcStatuses(),
      gameProfilesEnabled: DEFAULT_GAME_PROFILES_ENABLED,
      gameProfiles: [],
      selectedGameProfileId: null,
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

  private patchDlcStatus(status: DlcStatus): void {
    const existing = this.state.dlcs;
    const next = existing.some((candidate) => candidate.id === status.id)
      ? existing.map((candidate) => (candidate.id === status.id ? status : candidate))
      : [...existing, status];
    this.patch({ dlcs: next });
  }

  private showDlcProgress(
    id: DlcId,
    status: 'installing' | 'removing',
    detail: string,
    progressPercent = -1,
    progressPhase?: DlcStatus['progressPhase']
  ): void {
    const current =
      this.state.dlcs.find((candidate) => candidate.id === id)
      ?? unavailableDlcStatuses().find((candidate) => candidate.id === id)!;
    this.patchDlcStatus({
      ...current,
      status,
      detail,
      progressPhase,
      progressPercent
    });
  }

  private async ensureDlcInstalled(install: GameInstall, id: DlcId): Promise<DlcStatus> {
    return this.dlcManager.ensureInstalled(install, id, ({ phase, completed, total }) => {
      const progressPercent = dlcPhasePercent(completed, total);
      const progressPhase = phase === 'download' ? 'download' : 'install';
      const detail =
        phase === 'download'
          ? 'Downloading verified DLC…'
          : 'Installing and verifying DLC files…';
      this.showDlcProgress(id, 'installing', detail, progressPercent, progressPhase);
    });
  }

  private async removeDlc(install: GameInstall, id: DlcId): Promise<DlcStatus> {
    this.showDlcProgress(id, 'removing', 'Preparing verified DLC removal…');
    return this.dlcManager.remove(install, id, ({ phase, completed, total }) => {
      const progressPercent = dlcPhasePercent(completed, total);
      const progressPhase = phase === 'download' ? 'download' : 'remove';
      const detail =
        phase === 'download'
          ? 'Downloading verified restore data…'
          : 'Removing DLC and restoring files…';
      this.showDlcProgress(id, 'removing', detail, progressPercent, progressPhase);
    });
  }

  private async inspectGameClientDll(install: GameInstall): Promise<GameClientDllState> {
    try {
      return await this.clientPatchManager.inspect(install);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`client DLL inspection failed: ${message}`);
      return {
        status: 'invalid',
        detail: `Could not inspect dinput8.dll: ${message}`,
        hasManagedMarker: false
      };
    }
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
    this.applyServerSelection(this.config.get());
    void this.refreshServerCommits();
    void this.refreshAgendaStats(true);
    if (startupUpdateChecked) {
      await this.refreshRuntimeState();
    } else {
      await this.refresh();
    }
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
    if (!this.gameProcessTimer) {
      this.gameProcessTimer = setInterval(
        () => void this.refreshTrackedGameProcesses(),
        GAME_PROCESS_REFRESH_MS
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

  async refreshPatchStatuses(): Promise<void> {
    if (this.patchStatusRefreshInFlight) return this.patchStatusRefreshInFlight;
    const refresh = this.runPatchStatusRefresh();
    this.patchStatusRefreshInFlight = refresh;
    try {
      await refresh;
    } finally {
      if (this.patchStatusRefreshInFlight === refresh) this.patchStatusRefreshInFlight = null;
    }
  }

  private async runPatchStatusRefresh(): Promise<void> {
    if (this.busy) {
      this.refreshPending = true;
      return;
    }
    this.busy = true;
    try {
      const settings = this.config.get();
      const install = await validateGameExe(settings.gameExePath);
      if (!sameGameExecutable(settings.gameExePath, this.config.get().gameExePath)) {
        this.refreshPending = true;
        return;
      }
      this.install = install;
      if (!install) {
        this.patch({
          gamePathValid: false,
          validatedGameExePath: settings.gameExePath,
          clientPatches: unavailableClientPatches(),
          gameClientDll: unavailableGameClientDllState()
        });
        return;
      }
      const [clientPatches, gameClientDll] = await Promise.all([
        inspectClientPatches(install),
        this.inspectGameClientDll(install)
      ]);
      this.patch({
        gamePathValid: true,
        validatedGameExePath: settings.gameExePath,
        clientPatches,
        gameClientDll
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`patch status refresh failed: ${message}`);
      this.patch({
        clientPatches: unavailableClientPatches(),
        gameClientDll: {
          status: 'invalid',
          detail: `Could not refresh patch status: ${message}`,
          hasManagedMarker: false
        }
      });
    } finally {
      this.busy = false;
      if (this.refreshPending) void this.refresh();
    }
  }

  private async refreshRuntimeState(): Promise<void> {
    this.patch({ phase: 'checking', statusLine: 'Checking local configuration…', errorDetails: null });
    await this.gameProfileManager.load();
    await this.refreshTrackedGameProcesses();
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
    const profileSnapshot = this.gameProfileManager.getSnapshot();
    this.patch({
      gamePathValid: install !== null,
      validatedGameExePath: settings.gameExePath,
      linuxRuntimeStatus: linuxRuntime?.status ?? null,
      resolvedLinuxPrefix: linuxRuntime?.prefixPath ?? '',
      gameModeAvailable: linuxRuntime ? !!linuxRuntime.gameModePath : null,
      gameProfilesEnabled: profileSnapshot.enabled,
      gameProfiles: profileSnapshot.profiles,
      selectedGameProfileId: profileSnapshot.selectedProfileId
    });
    const selection = this.applyServerSelection(settings);
    if (!install) {
      this.dlcsPreparedGameExePath = '';
      this.log.info('game install validation: invalid or unset');
      this.patch({
        gameClientDll: unavailableGameClientDllState(),
        clientPatches: unavailableClientPatches(),
        dlcs: unavailableDlcStatuses(),
        dxvk: unavailableDxvkState(PLATFORM, settings.developer.dxvkVersion)
      });
      if (!selection.host) {
        this.patch({
          phase: 'error',
          serverStatus: 'invalid',
          statusLine: 'Server address unavailable. Retry after updating the launcher.',
          errorDetails: 'No default server address is configured for this build.'
        });
      } else {
        this.patch({
          phase: 'ready',
          statusLine: settings.gameExePath
            ? 'Game path is not a valid Global Agenda install — fix it in Settings.'
            : 'Set your Global Agenda install path in Settings.'
        });
      }
      return;
    }

    const dlcPreparationErrors = new Map<DlcId, string>();
    if (
      !this.dlcsPreparedGameExePath ||
      !sameGameExecutable(this.dlcsPreparedGameExePath, install.exePath)
    ) {
      for (const definition of enabledDlcDefinitions(settings)) {
        try {
          this.patchDlcStatus(await this.ensureDlcInstalled(install, definition.id));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          dlcPreparationErrors.set(definition.id, message);
          this.log.warn(`automatic ${definition.name} install failed: ${message}`);
        }
      }
      this.dlcsPreparedGameExePath = install.exePath;
    }
    const [clientPatches, gameIniSettings, gameClientDll, dxvk, inspectedDlcs] = await Promise.all([
      inspectClientPatches(install),
      inspectGameIniSettings(install),
      this.inspectGameClientDll(install),
      PLATFORM === 'win32'
        ? this.dxvkManager.inspect(install, settings.developer.dxvkVersion)
        : Promise.resolve(unavailableDxvkState(PLATFORM, settings.developer.dxvkVersion)),
      this.dlcManager.inspectAll(install)
    ]);
    let dlcs = inspectedDlcs;
    if (dlcPreparationErrors.size > 0) {
      dlcs = dlcs.map((dlc) =>
        dlcPreparationErrors.has(dlc.id)
          ? failedDlcStatus(dlc.id, dlcPreparationErrors.get(dlc.id)!)
          : dlc
      );
    }
    await this.config.syncGameIniSettings(settings.gameExePath, gameIniSettings);
    this.log.info('game install validation: valid');
    this.patch({
      gameClientDll,
      clientPatches,
      dlcs,
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

  private trackedGameProcessCount(): number {
    const pids = new Set(this.gameProcessTracker.getPids());
    let withoutPid = 0;
    for (const child of this.activeGameProcesses) {
      if (child.pid && child.pid > 0) pids.add(child.pid);
      else withoutPid += 1;
    }
    return pids.size + withoutPid;
  }

  private refreshTrackedGameProcesses(): Promise<number> {
    if (this.gameProcessRefreshInFlight) return this.gameProcessRefreshInFlight;
    this.gameProcessRefreshInFlight = (async () => {
      await this.gameProcessTracker.refresh();
      const count = this.trackedGameProcessCount();
      if (count !== this.state.activeGameInstances) {
        this.patch({ activeGameInstances: count });
      }
      return count;
    })().finally(() => {
      this.gameProcessRefreshInFlight = null;
    });
    return this.gameProcessRefreshInFlight;
  }

  private async trackGameProcess(child: ChildProcess): Promise<void> {
    this.activeGameProcesses.add(child);
    this.patch({ activeGameInstances: this.trackedGameProcessCount() });
    let tracked = true;
    const release = (): void => {
      if (!tracked) return;
      tracked = false;
      child.removeListener('exit', release);
      child.removeListener('error', release);
      this.activeGameProcesses.delete(child);
      if (!child.pid) {
        this.patch({ activeGameInstances: this.trackedGameProcessCount() });
        return;
      }
      void this.gameProcessTracker.remove(child.pid).then(
        () => this.patch({ activeGameInstances: this.trackedGameProcessCount() }),
        (error) => {
          this.log.warn(`game process exit tracking could not be saved: ${(error as Error).message}`);
          void this.refreshTrackedGameProcesses();
        }
      );
    };
    child.once('exit', release);
    child.once('error', release);
    if (child.pid) {
      try {
        await this.gameProcessTracker.add(child.pid);
      } catch (error) {
        this.log.warn(`game process launch tracking could not be saved: ${(error as Error).message}`);
      }
    } else {
      this.log.warn('game process launch returned no process identifier; tracking is session-only');
    }
    if (child.exitCode !== null || child.signalCode !== null) release();
    else if (tracked) this.patch({ activeGameInstances: this.trackedGameProcessCount() });
  }

  async play(
    developerLaunch = false,
    profileDecision?: ProfilePlayDecision
  ): Promise<ProfilePlayPrompt | null> {
    const initialSettings = this.config.get();
    if (developerLaunch && !initialSettings.developer.enabled) {
      this.patch({ phase: 'ready', statusLine: 'Enable developer mode before using Dev Launch.' });
      return null;
    }
    if (this.launcherUpdater.getSnapshot().status === 'downloading') return null;
    if (
      this.busy ||
      this.state.launchCoolingDown ||
      this.state.phase === 'launching'
    ) {
      return null;
    }
    this.busy = true;
    try {
      const settings = this.config.get();
      const selection = this.applyServerSelection(settings);
      if (!this.install) {
        this.patch({ phase: 'ready', statusLine: 'Set your Global Agenda install path in Settings first.' });
        return null;
      }
      if (PLATFORM === 'linux' && this.linuxRuntime?.status !== 'ready') {
        this.patch({ phase: 'ready', statusLine: 'Complete your Linux game setup in Settings.' });
        return null;
      }
      if (!selection.host) {
        this.patch({
          phase: 'error',
          statusLine: 'Server address unavailable. Retry after updating the launcher.',
          errorDetails: 'Play is blocked until a server address can be resolved.'
        });
        return null;
      }

      const gameAlreadyRunning =
        this.activeGameProcesses.size > 0 || this.state.activeGameInstances > 0;
      const ignoreDxvkRenderer =
        PLATFORM === 'win32' &&
        (settings.developer.useDxvk || this.state.dxvk.canRestore);
      const decisionMatches = (prompt: ProfilePlayPrompt): boolean =>
        profileDecision?.profileId === prompt.profileId &&
        profileDecision.comparisonToken === prompt.comparisonToken;
      if (!gameAlreadyRunning) {
        const profilePrompt = await this.gameProfileManager.inspectSelectedChanges(
          this.install,
          ignoreDxvkRenderer
        );
        if (profilePrompt) {
          if (!decisionMatches(profilePrompt)) return profilePrompt;
          if (profileDecision?.action === 'save-current') {
            await this.gameProfileManager.overwrite(profilePrompt.profileId, this.install);
            const snapshot = this.gameProfileManager.getSnapshot();
            this.patch({
              gameProfilesEnabled: snapshot.enabled,
              gameProfiles: snapshot.profiles,
              selectedGameProfileId: snapshot.selectedProfileId
            });
          }
        }
      }

      void this.launcherUpdater.ensureCurrent();
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
          return null;
        }
      }
      const launchHost =
        this.hostCandidates(selection).find(
          (candidate) => candidate.toLowerCase() === this.state.resolvedHost.toLowerCase()
        ) ?? selection.host;

      this.patch({ phase: 'checking', statusLine: 'Preparing launch…', errorDetails: null });
      for (const definition of enabledDlcDefinitions(settings)) {
        try {
          this.patchDlcStatus(await this.ensureDlcInstalled(this.install, definition.id));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log.warn(`${definition.name} unavailable; continuing launch: ${message}`);
          this.patchDlcStatus(failedDlcStatus(definition.id, message));
        }
      }

      const activeProfile = this.gameProfileManager.getSnapshot().enabled
        ? this.gameProfileManager.getSelectedSummary()
        : null;
      if (activeProfile && !gameAlreadyRunning) {
        const latestProfilePrompt = await this.gameProfileManager.inspectSelectedChanges(
          this.install,
          ignoreDxvkRenderer
        );
        if (latestProfilePrompt && !decisionMatches(latestProfilePrompt)) {
          return latestProfilePrompt;
        }
        this.patch({
          phase: 'checking',
          statusLine: `Applying game profile ${activeProfile.name}…`,
          errorDetails: null
        });
        await this.gameProfileManager.applySelected(this.install);
        const backupDirectory = managedIniBackupDirectory(app.getPath('userData'), this.install);
        if (!settings.patches.highFpsMovementStability) {
          await removeIniClientPatch(
            this.install,
            'high-fps-movement-stability',
            this.log,
            backupDirectory
          );
        }
        if (!settings.patches.adaptiveClientPerformance) {
          await removeIniClientPatch(
            this.install,
            'adaptive-client-performance',
            this.log,
            backupDirectory
          );
        }
      } else if (activeProfile) {
        this.log.info('game profile restore skipped because a launcher-started game is still running');
      }

      this.patch({ phase: 'checking', statusLine: 'Checking client configuration…', errorDetails: null });
      const gpuMemory = await this.gpuMemoryDetector.select(settings.launch.gpuAdapter);
      await ensureClientConfiguration(
        this.install,
        settings.loginMap,
        settings.showOverhealing,
        settings.fpsLimit.enabled,
        settings.fpsLimit.value,
        gpuMemory.texturePoolMb,
        settings.patches,
        this.log,
        managedIniBackupDirectory(app.getPath('userData'), this.install)
      );
      this.patch({ clientPatches: await inspectClientPatches(this.install) });

      let clientPatchEnvironment: NodeJS.ProcessEnv = {};
      const localClientDll = settings.developer.useLocalClientDll;
      this.patch({
        statusLine: localClientDll
          ? 'Preparing local client DLL…'
          : settings.patches.gameClientPatch
            ? 'Checking Game Client Patch…'
            : 'Removing Game Client Patch…'
      });
      let clientPatchError: string | null = null;
      try {
        if (localClientDll) {
          clientPatchEnvironment = await this.clientPatchManager.prepareLocalForLaunch(
            this.install,
            PLATFORM
          );
        } else if (settings.patches.gameClientPatch) {
          clientPatchEnvironment = await this.clientPatchManager.prepareForLaunch(
            this.install,
            PLATFORM,
            ({ transferred, total }) => {
              const percent = total > 0
                ? Math.min(100, Math.round((transferred / total) * 100))
                : -1;
              this.patch({
                statusLine: percent >= 0
                  ? `Downloading Game Client Patch… ${percent}%`
                  : 'Downloading Game Client Patch…'
              });
            }
          );
        } else {
          await this.clientPatchManager.disable(this.install);
        }
      } catch (error) {
        clientPatchError = error instanceof Error ? error.message : String(error);
        this.log.warn(`client patch reconciliation failed: ${clientPatchError}`);
      }
      const gameClientDll = await this.inspectGameClientDll(this.install);
      this.patch({ gameClientDll });
      if (
        !localClientDll &&
        clientPatchError &&
        (settings.patches.gameClientPatch
          ? gameClientDll.status === 'local' || gameClientDll.status === 'invalid'
          : gameClientDll.status !== 'missing')
      ) {
        this.patch({
          phase: 'ready',
          statusLine: 'Could not replace or remove the existing client DLL.',
          errorDetails: clientPatchError
        });
        return null;
      }

      let useDxvk = false;
      if (PLATFORM === 'win32') {
        useDxvk = settings.developer.useDxvk;
        const dxvkVersion = settings.developer.dxvkVersion;
        this.patch({
          dxvk: {
            ...this.state.dxvk,
            status: 'preparing',
            detail: useDxvk
              ? `Preparing DXVK/Vulkan ${dxvkVersion} for launch…`
              : 'Restoring the previous Direct3D configuration…'
          },
          statusLine: useDxvk
            ? `Preparing DXVK/Vulkan ${dxvkVersion}…`
            : 'Checking native graphics configuration…'
        });
        const dxvk = await this.dxvkManager.prepareForLaunch(
          this.install,
          useDxvk,
          dxvkVersion,
          ({ transferred, total, version }) => {
            const percent = total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : -1;
            this.patch({
              statusLine:
                percent >= 0
                  ? `Downloading DXVK/Vulkan ${version}… ${percent}%`
                  : `Downloading DXVK/Vulkan ${version}…`
            });
          }
        );
        this.patch({ dxvk });
      }

      if (this.launcherUpdater.getSnapshot().status === 'downloading') {
        this.patch({ phase: 'ready', statusLine: 'Launcher update is downloading…' });
        return null;
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
      const child = this.gameLauncher.launch(
        settings,
        launchHost,
        this.install.binariesDir,
        PLATFORM,
        developerLaunch,
        this.linuxRuntime,
        {
          ...clientPatchEnvironment,
          ...(useDxvk ? this.dxvkManager.launchEnvironment() : {})
        }
      );
      await this.trackGameProcess(child);
      this.scheduleAutoCloseAfterLaunch();
      this.scheduleLaunchCooldown();
      return null;
    } catch (error) {
      const message = (error as Error).message;
      this.log.error(`launch failed: ${message}`);
      let dxvk = this.state.dxvk;
      if (PLATFORM === 'win32' && this.install) {
        try {
          dxvk = await this.dxvkManager.inspect(
            this.install,
            this.config.get().developer.dxvkVersion
          );
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
      return null;
    } finally {
      this.busy = false;
      if (this.refreshPending) void this.refresh();
    }
  }

  private async changeIniClientPatch(
    id: ClientPatchId,
    enabled: boolean
  ): Promise<ActionResult> {
    if (this.busy) return { ok: false, message: 'The launcher is busy. Try again shortly.' };
    this.busy = true;
    let previousEnabled: boolean | null = null;
    let preferenceChanged = false;
    try {
      if (this.state.launchCoolingDown) {
        return { ok: false, message: 'Wait for the current game launch to finish.' };
      }
      const settings = this.config.get();
      const preferenceKey =
        id === 'high-fps-movement-stability'
          ? 'highFpsMovementStability'
          : 'adaptiveClientPerformance';
      previousEnabled = settings.patches[preferenceKey];
      if (previousEnabled !== enabled) {
        await this.config.update({
          patches:
            preferenceKey === 'highFpsMovementStability'
              ? { highFpsMovementStability: enabled }
              : { adaptiveClientPerformance: enabled }
        });
        preferenceChanged = true;
      }

      const install = await validateGameExe(settings.gameExePath);
      this.install = install;
      if (!install) {
        this.patch({
          gamePathValid: false,
          validatedGameExePath: settings.gameExePath,
          clientPatches: unavailableClientPatches()
        });
        return {
          ok: true,
          message: enabled
            ? 'Patch enabled. It will apply after a valid game location is set.'
            : 'Patch removed.'
        };
      }

      const backupDirectory = managedIniBackupDirectory(app.getPath('userData'), install);
      const result = enabled
        ? await applyIniClientPatch(
            install,
            id,
            this.log,
            backupDirectory,
            id === 'adaptive-client-performance'
              ? (await this.gpuMemoryDetector.select(settings.launch.gpuAdapter)).texturePoolMb
              : undefined
          )
        : await removeIniClientPatch(install, id, this.log, backupDirectory);
      const clientPatches = await inspectClientPatches(install);
      this.patch({
        gamePathValid: true,
        validatedGameExePath: settings.gameExePath,
        clientPatches
      });
      if (enabled && clientPatches.find((patch) => patch.id === id)?.applied !== true) {
        throw new Error('The patch could not be verified after writing it.');
      }
      return {
        ok: true,
        message:
          result.changedFiles.length > 0
            ? enabled
              ? 'Patch applied.'
              : 'Patch removed.'
            : enabled
              ? 'Patch is already applied.'
              : 'Patch is already removed.'
      };
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      if (enabled && preferenceChanged && previousEnabled === false && this.install) {
        try {
          await removeIniClientPatch(
            this.install,
            id,
            this.log,
            managedIniBackupDirectory(app.getPath('userData'), this.install)
          );
        } catch (cleanupError) {
          message += `; could not clean up the partial patch: ${(cleanupError as Error).message}`;
        }
      }
      if (preferenceChanged && previousEnabled !== null) {
        try {
          await this.config.update({
            patches:
              id === 'high-fps-movement-stability'
                ? { highFpsMovementStability: previousEnabled }
                : { adaptiveClientPerformance: previousEnabled }
          });
        } catch (rollbackError) {
          message += `; could not restore the previous patch preference: ${(rollbackError as Error).message}`;
        }
      }
      this.log.warn(`manual client patch ${enabled ? 'apply' : 'remove'} failed: ${message}`);
      this.patch({ clientPatches: await inspectClientPatches(this.install) });
      return {
        ok: false,
        message: `Could not ${enabled ? 'apply' : 'remove'} patch: ${message}`
      };
    } finally {
      this.busy = false;
      if (this.refreshPending) void this.refresh();
    }
  }

  async applyClientPatch(id: ClientPatchId): Promise<ActionResult> {
    return this.changeIniClientPatch(id, true);
  }

  async removeClientPatch(id: ClientPatchId): Promise<ActionResult> {
    return this.changeIniClientPatch(id, false);
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
      const settings = this.config.get();
      const dxvkVersion = settings.developer.dxvkVersion;
      const install = await validateGameExe(settings.gameExePath);
      this.install = install;
      if (!install) return { ok: false, message: 'Set a valid Global Agenda installation first.' };
      const initialDetail = enabled
        ? `Preparing DXVK/Vulkan ${dxvkVersion}…`
        : 'Restoring the previous Direct3D configuration…';
      this.patch({
        dxvk: { ...this.state.dxvk, status: 'preparing', detail: initialDetail },
        phase: 'checking',
        statusLine: initialDetail
      });
      const dxvk = await this.dxvkManager.prepareForLaunch(
        install,
        enabled,
        dxvkVersion,
        ({ transferred, total, version }) => {
          const percent = total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : -1;
          const detail =
            percent >= 0
              ? `Downloading DXVK/Vulkan ${version}… ${percent}%`
              : `Downloading DXVK/Vulkan ${version}…`;
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
          dxvk = await this.dxvkManager.inspect(
            this.install,
            this.config.get().developer.dxvkVersion
          );
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

  private async configureClientPatches(enabled: boolean): Promise<ActionResult> {
    if (this.busy || this.state.launchCoolingDown) {
      return { ok: false, message: 'The launcher is busy. Try again shortly.' };
    }
    this.busy = true;
    try {
      const settings = this.config.get();
      const install = await validateGameExe(settings.gameExePath);
      this.install = install;
      if (!install) {
        return {
          ok: true,
          message: enabled
            ? 'Game Client Patch enabled. It will apply after a valid game location is set.'
            : 'Game Client Patch removed.'
        };
      }
      const localDll = settings.developer.useLocalClientDll;
      if (localDll) {
        this.patch({
          gameClientDll: await this.inspectGameClientDll(install),
          phase: 'ready',
          statusLine: 'Ready.'
        });
        return {
          ok: true,
          message: 'Managed Game Client Patch preference saved; local DLL override unchanged.'
        };
      }
      this.patch({
        phase: 'checking',
        statusLine: enabled ? 'Checking Game Client Patch…' : 'Removing Game Client Patch…'
      });
      if (enabled) {
        await this.clientPatchManager.prepareForLaunch(
          install,
          PLATFORM,
          ({ transferred, total }) => {
            const percent = total > 0
              ? Math.min(100, Math.round((transferred / total) * 100))
              : -1;
            this.patch({
              statusLine: percent >= 0
                ? `Downloading Game Client Patch… ${percent}%`
                : 'Downloading Game Client Patch…'
            });
          }
        );
      } else {
        await this.clientPatchManager.disable(install);
      }
      this.patch({
        gameClientDll: await this.inspectGameClientDll(install),
        phase: 'ready',
        statusLine: 'Ready.'
      });
      return {
        ok: true,
        message: enabled ? 'Game Client Patch applied.' : 'Game Client Patch removed.'
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`client patch change failed: ${message}`);
      this.patch({
        ...(this.install
          ? { gameClientDll: await this.inspectGameClientDll(this.install) }
          : {}),
        phase: 'ready',
        statusLine: `Game Client Patch change failed: ${message}`
      });
      return { ok: false, message };
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

  private async beginProfileAction(): Promise<ActionResult | null> {
    if (this.activeGameProcesses.size > 0 || this.state.activeGameInstances > 0) {
      return {
        ok: false,
        message: 'Close every game instance launched by this launcher before changing profiles.'
      };
    }
    if (this.busy || this.state.launchCoolingDown || this.state.phase === 'launching') {
      return { ok: false, message: 'The launcher is busy. Try again shortly.' };
    }
    this.busy = true;
    try {
      if ((await this.refreshTrackedGameProcesses()) > 0) {
        this.busy = false;
        return {
          ok: false,
          message: 'Close every game instance launched by this launcher before changing profiles.'
        };
      }
    } catch (error) {
      this.busy = false;
      const message = `Could not verify whether the game is still running: ${(error as Error).message}`;
      this.log.warn(message);
      return { ok: false, message };
    }
    return null;
  }

  private patchProfileSnapshot(statusLine: string): void {
    const snapshot = this.gameProfileManager.getSnapshot();
    this.patch({
      phase: 'ready',
      statusLine,
      errorDetails: null,
      gameProfilesEnabled: snapshot.enabled,
      gameProfiles: snapshot.profiles,
      selectedGameProfileId: snapshot.selectedProfileId
    });
  }

  async createGameProfile(name: string): Promise<ActionResult> {
    const unavailable = await this.beginProfileAction();
    if (unavailable) return unavailable;
    try {
      const install = await validateGameExe(this.config.get().gameExePath);
      if (!install) return { ok: false, message: 'Set a valid Global Agenda installation first.' };
      this.install = install;
      this.patch({ phase: 'checking', statusLine: 'Saving current game settings…' });
      const profile = await this.gameProfileManager.create(name, install);
      const enabled = this.gameProfileManager.getSnapshot().enabled;
      this.patchProfileSnapshot(
        enabled
          ? `Profile ${profile.name} saved and selected.`
          : `Profile ${profile.name} saved and selected. Profiles remain off.`
      );
      return {
        ok: true,
        message: enabled
          ? `Profile ${profile.name} saved.`
          : `Profile ${profile.name} saved. Profiles remain off.`
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`game profile creation failed: ${message}`);
      this.patch({ phase: 'ready', statusLine: `Could not save game profile: ${message}` });
      return { ok: false, message };
    } finally {
      this.busy = false;
      if (this.refreshPending) void this.refresh();
    }
  }

  async updateGameProfile(id: string): Promise<ActionResult> {
    const unavailable = await this.beginProfileAction();
    if (unavailable) return unavailable;
    try {
      const install = await validateGameExe(this.config.get().gameExePath);
      if (!install) return { ok: false, message: 'Set a valid Global Agenda installation first.' };
      this.install = install;
      this.patch({ phase: 'checking', statusLine: 'Updating saved game settings…' });
      const profile = await this.gameProfileManager.overwrite(id, install);
      this.patchProfileSnapshot(`Profile ${profile.name} updated.`);
      return { ok: true, message: `Profile ${profile.name} updated from the current game settings.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`game profile update failed: ${message}`);
      this.patch({ phase: 'ready', statusLine: `Could not update game profile: ${message}` });
      return { ok: false, message };
    } finally {
      this.busy = false;
      if (this.refreshPending) void this.refresh();
    }
  }

  async renameGameProfile(id: string, name: string): Promise<ActionResult> {
    const unavailable = await this.beginProfileAction();
    if (unavailable) return unavailable;
    try {
      const profile = await this.gameProfileManager.renameProfile(id, name);
      this.patchProfileSnapshot(`Profile renamed to ${profile.name}.`);
      return { ok: true, message: `Profile renamed to ${profile.name}.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message };
    } finally {
      this.busy = false;
      if (this.refreshPending) void this.refresh();
    }
  }

  async deleteGameProfile(id: string): Promise<ActionResult> {
    const unavailable = await this.beginProfileAction();
    if (unavailable) return unavailable;
    try {
      await this.gameProfileManager.deleteProfile(id);
      this.patchProfileSnapshot('Game profile removed.');
      return { ok: true, message: 'Game profile removed.' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message };
    } finally {
      this.busy = false;
      if (this.refreshPending) void this.refresh();
    }
  }

  async setGameProfilesEnabled(enabled: boolean): Promise<ActionResult> {
    const unavailable = await this.beginProfileAction();
    if (unavailable) return unavailable;
    try {
      await this.gameProfileManager.setEnabled(enabled);
      const profile = this.gameProfileManager.getSelectedSummary();
      const message = enabled
        ? profile
          ? `Profiles are on. ${profile.name} will be used when you press Play.`
          : 'Profiles are on. Save a profile to use it when you press Play.'
        : 'Profiles are off. Your saved profiles were kept.';
      this.patchProfileSnapshot(message);
      return { ok: true, message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`game profile toggle failed: ${message}`);
      return { ok: false, message };
    } finally {
      this.busy = false;
      if (this.refreshPending) void this.refresh();
    }
  }

  async selectGameProfile(
    id: string,
    decision?: ProfileSwitchDecision
  ): Promise<ProfileSwitchPrompt | null> {
    const unavailable = await this.beginProfileAction();
    if (unavailable) throw new Error(unavailable.message);
    try {
      const snapshot = this.gameProfileManager.getSnapshot();
      if (snapshot.selectedProfileId === id) return null;
      const targetIndex = snapshot.profiles.findIndex((profile) => profile.id === id);
      if (targetIndex < 0) throw new Error('Unknown game profile.');
      const target = snapshot.profiles[targetIndex];
      if (this.install && snapshot.enabled) {
        const settings = this.config.get();
        const ignoreDxvkRenderer =
          PLATFORM === 'win32' &&
          (settings.developer.useDxvk || this.state.dxvk.canRestore);
        const changes = await this.gameProfileManager.inspectAppliedChanges(
          this.install,
          ignoreDxvkRenderer
        );
        if (changes) {
          const prompt: ProfileSwitchPrompt = {
            ...changes,
            targetProfileId: target.id,
            targetProfileNumber: targetIndex + 1
          };
          const decisionMatches =
            decision?.profileId === prompt.profileId &&
            decision.targetProfileId === prompt.targetProfileId &&
            decision.comparisonToken === prompt.comparisonToken;
          if (!decisionMatches) return prompt;
          if (decision.action === 'save-current') {
            await this.gameProfileManager.overwrite(prompt.profileId, this.install);
          }
        }
      }
      await this.gameProfileManager.select(id);
      const profile = this.gameProfileManager.getSelectedSummary();
      const enabled = this.gameProfileManager.getSnapshot().enabled;
      this.patchProfileSnapshot(
        profile
          ? enabled
            ? `Profile ${profile.name} selected.`
            : `Profile ${profile.name} selected. Profiles remain off.`
          : 'Ready.'
      );
      return null;
    } finally {
      this.busy = false;
      if (this.refreshPending) void this.refresh();
    }
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

  developerModeChanged(): void {
    this.applyServerSelection(this.config.get());
  }

  async localClientDllChanged(enabled: boolean): Promise<void> {
    if (
      enabled &&
      (this.busy || this.state.launchCoolingDown || this.state.phase === 'launching')
    ) {
      throw new Error('The launcher is busy. Try again shortly.');
    }
    const settings = this.config.get();
    this.applyServerSelection(settings);
    if (enabled && !settings.developer.enabled) {
      throw new Error('Enable Developer Mode before using a local client DLL.');
    }
    const install = await validateGameExe(settings.gameExePath);
    this.install = install;
    if (!install) {
      this.dlcsPreparedGameExePath = '';
      this.patch({
        gamePathValid: false,
        validatedGameExePath: settings.gameExePath,
        gameClientDll: unavailableGameClientDllState()
      });
      if (enabled) {
        throw new Error('Set a valid Global Agenda installation before enabling local DLL mode.');
      }
      return;
    }

    const inspection = await this.inspectGameClientDll(install);
    this.patch({
      gamePathValid: true,
      validatedGameExePath: settings.gameExePath,
      gameClientDll: inspection
    });
    if (enabled && inspection.status !== 'local') {
      throw new Error(
        inspection.status === 'managed'
          ? 'The installed dinput8.dll is the managed release. Replace it with your local 32-bit x86 build first.'
          : inspection.detail
      );
    }
  }

  async gameClientPatchChanged(enabled: boolean): Promise<void> {
    const result = await this.configureClientPatches(enabled);
    if (!result.ok) throw new Error(result.message);
    await this.refresh();
  }

  async dlcChanged(id: DlcId, enabled: boolean): Promise<void> {
    if (this.busy || this.state.launchCoolingDown || this.state.phase === 'launching') {
      throw new Error('The launcher is busy. Try again shortly.');
    }
    if (this.state.activeGameInstances > 0) {
      throw new Error('Close every game instance launched by this launcher before changing DLCs.');
    }

    this.busy = true;
    let activeInstall: GameInstall | null = null;
    try {
      if ((await this.refreshTrackedGameProcesses()) > 0) {
        throw new Error('Close every game instance launched by this launcher before changing DLCs.');
      }
      const settings = this.config.get();
      const install = await validateGameExe(settings.gameExePath);
      activeInstall = install;
      this.install = install;
      if (!install) {
        this.patch({
          gamePathValid: false,
          validatedGameExePath: settings.gameExePath,
          dlcs: unavailableDlcStatuses()
        });
        return;
      }

      const definition = LAUNCHER_CONFIG.dlcs.find((candidate) => candidate.id === id);
      const dlcName = definition?.name ?? 'DLC';
      this.patch({
        phase: 'checking',
        statusLine: `${enabled ? 'Installing' : 'Removing'} ${dlcName}…`,
        errorDetails: null
      });
      const status = enabled
        ? await this.ensureDlcInstalled(install, id)
        : await this.removeDlc(install, id);
      this.patchDlcStatus(status);
      this.patch({
        phase: 'ready',
        statusLine: 'Ready.',
        gamePathValid: true,
        validatedGameExePath: settings.gameExePath
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`DLC ${enabled ? 'install' : 'removal'} failed: ${message}`);
      let status = failedDlcStatus(id, message);
      if (activeInstall) {
        const inspected = await this.dlcManager.inspectAll(activeInstall);
        status = inspected.find((candidate) => candidate.id === id) ?? status;
      }
      this.patchDlcStatus(status);
      this.patch({ phase: 'ready', statusLine: 'Ready.' });
      throw error;
    } finally {
      this.busy = false;
      if (this.refreshPending) void this.refresh();
    }
  }

  async resetLauncher(): Promise<ActionResult> {
    const updateBusy =
      this.state.launcherUpdate === 'checking' ||
      this.state.launcherUpdate === 'downloading' ||
      this.state.launcherUpdate === 'installing';
    if (this.busy || this.state.launchCoolingDown || updateBusy) {
      return { ok: false, message: 'The launcher is busy. Try the reset again shortly.' };
    }

    this.busy = true;
    let completed = false;
    try {
      if ((await this.refreshTrackedGameProcesses()) > 0) {
        return {
          ok: false,
          message: 'Close every game instance launched by this launcher before resetting it.'
        };
      }
      this.patch({ phase: 'checking', statusLine: 'Resetting launcher settings…' });
      const settings = this.config.get();
      const gameExePath = typeof settings.gameExePath === 'string' ? settings.gameExePath : '';
      const install = await validateGameExe(gameExePath);
      if (install) {
        await this.clientPatchManager.removeManaged(install);
        if (PLATFORM === 'win32') {
          await this.dxvkManager.restore(install, settings.developer.dxvkVersion);
        }
      } else if (gameExePath.trim()) {
        this.log.warn('launcher reset: configured game install is unavailable; game cleanup skipped');
      }

      await this.gameProfileManager.reset();
      await this.gameProcessTracker.reset();
      await this.config.resetToDefaults();
      completed = true;
      this.log.info('launcher reset complete; restarting');
      return { ok: true, message: 'Launcher settings reset. Restarting…' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`launcher reset failed: ${message}`);
      this.patch({ phase: 'ready', statusLine: `Launcher reset failed: ${message}` });
      return { ok: false, message: `Could not reset the launcher: ${message}` };
    } finally {
      this.busy = false;
      if (!completed && this.refreshPending) void this.refresh();
    }
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

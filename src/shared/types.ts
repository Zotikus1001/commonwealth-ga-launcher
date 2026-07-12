// Shared contracts between main / preload / renderer. Types only — no runtime imports of
// Electron or Node here (this file is compiled into all three targets).
import type { LoginMap } from './loginMaps';
import type { UiScale } from './uiScale';

export interface CustomServer {
  id: string;
  name: string;
  host: string;
}

export interface ServerChoice {
  id: string;
  name: string;
}

export interface ServerCommit {
  sha: string;
  message: string;
  committedAt: string;
}

export interface GameIniSettings {
  loginMap: LoginMap | null;
  showOverhealing: boolean | null;
  fpsLimit: {
    enabled: boolean | null;
    value: number | null;
  };
}

export interface GameIniBaseline extends GameIniSettings {
  gameExePath: string;
}

export type LinuxRunnerType = 'wine' | 'proton';

export type DxvkRendererSetting = 'directx-9' | 'directx-10' | 'unknown';

export type DxvkStatus =
  | 'unsupported'
  | 'native'
  | 'preparing'
  | 'active'
  | 'external'
  | 'needs-restore'
  | 'error';

export interface DxvkState {
  status: DxvkStatus;
  version: string;
  rendererSetting: DxvkRendererSetting;
  detail: string;
  canRestore: boolean;
}

export type LinuxRuntimeStatus =
  | 'ready'
  | 'wine-runner-missing'
  | 'wine-prefix-missing'
  | 'umu-missing'
  | 'proton-missing';

export interface Settings {
  schemaVersion: number;
  /** Renderer zoom controlled only through Launcher UI scale settings. */
  uiScale: UiScale;
  /** Absolute path to <GA root>/Binaries/GlobalAgenda.exe */
  gameExePath: string;
  /** Login map written to both [URL] Map and LocalMap before launch. */
  loginMap: LoginMap;
  /** Shows heal/repair feedback on full-health targets when enabled. */
  showOverhealing: boolean;
  /** Frame smoothing limiter applied to [Engine.GameEngine] before launch. */
  fpsLimit: {
    enabled: boolean;
    value: number;
  };
  /** Last observed active INI values, used to preserve newer launcher choices. */
  gameIniBaseline: GameIniBaseline;
  servers: {
    builtInName: string;
    selectedServerId: string;
    custom: CustomServer[];
  };
  launch: {
    closeAfterLaunch: boolean;
    gpuAdapter: number;
    noStartupMovies: boolean;  // -nostartupmovies (opt-in)
    noSplash: boolean;         // -nosplash (opt-in)
    extraArgs: string;
  };
  linux: {
    runner: LinuxRunnerType;
    winePath: string;
    protonPath: string;
    umuPath: string;
    winePrefix: string;
    gameMode: boolean;
    wineDebug: boolean;
  };
  developer: {
    enabled: boolean;
    windowed: boolean;
    resolutionWidth: number;
    resolutionHeight: number;
    /** Experimental Windows option configured in Dev but applied to every launch mode. */
    useDxvk: boolean;
    /** Experimental launcher-managed client patches, applied to every launch mode when enabled. */
    useClientPatches: boolean;
  };
}

export type Phase =
  | 'init'
  | 'checking'
  | 'ready'
  | 'launching'
  | 'error';

export type LauncherUpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'installing'
  | 'up-to-date'
  | 'check-failed'
  | 'error';

export interface UpdateProgress {
  kind: 'launcher';
  percent: number;      // 0..100, -1 when indeterminate
  transferred: number;  // bytes
  total: number;        // bytes, 0 when unknown
}

export type ClientPatchId =
  | 'high-fps-movement-stability'
  | 'adaptive-client-performance';

export interface ClientPatchStatus {
  id: ClientPatchId;
  /** null when no valid game install is available for inspection. */
  applied: boolean | null;
}

export type ServerStatus = 'checking' | 'online' | 'offline' | 'invalid';

export interface LauncherState {
  phase: Phase;
  statusLine: string;
  errorDetails: string | null;
  resolvedHost: string;
  serverName: string;
  serverChoices: ServerChoice[];
  selectedServerId: string;
  serverStatus: ServerStatus;
  gamePathValid: boolean;
  /** Exact saved path represented by gamePathValid. */
  validatedGameExePath: string;
  /** null off Linux; otherwise whether the selected compatibility runtime can launch. */
  linuxRuntimeStatus: LinuxRuntimeStatus | null;
  resolvedLinuxPrefix: string;
  gameModeAvailable: boolean | null;
  dxvk: DxvkState;
  /** True only during the five-second window after a Play launch attempt. */
  launchCoolingDown: boolean;
  developerMode: boolean;
  progress: UpdateProgress | null;
  launcherVersion: string;
  launcherUpdate: LauncherUpdateStatus;
  launcherUpdateVersion: string | null;
  launcherUpdateError: string | null;
  clientPatches: ClientPatchStatus[];
  serverCommits: ServerCommit[];
  serverCommitsStatus: 'loading' | 'ready' | 'error';
  agendaStatsText: string | null;
  agendaStatsStatus: 'loading' | 'ready' | 'error';
  platform: 'win32' | 'linux' | 'darwin';
  /** Account tab stays hidden until Phase 4 auto-login lands (plan §11b decision #4). */
  accountTabEnabled: boolean;
}

export interface LinuxRunnerOption {
  label: string;
  path: string;
}

export interface LinuxRuntimeOptions {
  wineRunners: LinuxRunnerOption[];
  protonRunners: LinuxRunnerOption[];
  umuPath: string;
  gameModePath: string;
  steamPrefixPath: string;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[]
    ? U[]
    : T[K] extends object | null
      ? DeepPartial<NonNullable<T[K]>> | null
      : T[K];
};

// The surface preload exposes as window.api.
export interface LauncherApi {
  platform: 'win32' | 'linux' | 'darwin';
  getState(): Promise<LauncherState>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>;
  browseForGame(): Promise<string | null>;
  autoDetectGame(): Promise<string | null>;
  play(): Promise<void>;
  playDeveloper(): Promise<void>;
  applyClientPatch(id: ClientPatchId): Promise<ActionResult>;
  selectServer(id: string): Promise<void>;
  checkServer(): Promise<void>;
  refresh(): Promise<void>;
  checkLauncherUpdates(): Promise<void>;
  listLinuxRuntimeOptions(): Promise<LinuxRuntimeOptions>;
  createWinePrefix(): Promise<ActionResult>;
  openDiscord(): Promise<ActionResult>;
  openAgendaStats(): Promise<ActionResult>;
  openSteamStore(): Promise<ActionResult>;
  openSteamInstall(): Promise<ActionResult>;
  openLauncherLogs(): Promise<ActionResult>;
  copyDiagnostics(): Promise<ActionResult>;
  getLogTail(): Promise<string[]>;
  onState(cb: (state: LauncherState) => void): () => void;
  onLogLine(cb: (line: string) => void): () => void;
}

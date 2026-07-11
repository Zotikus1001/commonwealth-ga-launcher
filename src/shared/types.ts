// Shared contracts between main / preload / renderer. Types only — no runtime imports of
// Electron or Node here (this file is compiled into all three targets).
import type { LoginMap } from './loginMaps';

export interface DeveloperServer {
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

export interface Settings {
  schemaVersion: number;
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
  launch: {
    closeAfterLaunch: boolean;
    gpuAdapter: number;
    noStartupMovies: boolean;  // -nostartupmovies (opt-in)
    noSplash: boolean;         // -nosplash (opt-in)
    extraArgs: string;
  };
  linux: {
    winePath: string;
    winePrefix: string;
    wineDebug: boolean;
  };
  developer: {
    enabled: boolean;
    selectedServerId: string;
    servers: DeveloperServer[];
    windowed: boolean;
    resolutionWidth: number;
    resolutionHeight: number;
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
  | 'error';

export interface UpdateProgress {
  kind: 'launcher';
  percent: number;      // 0..100, -1 when indeterminate
  transferred: number;  // bytes
  total: number;        // bytes, 0 when unknown
}

export type ClientPatchId = 'high-fps-movement-stability';

export interface ClientPatchStatus {
  id: ClientPatchId;
  /** null when no valid game install is available for inspection. */
  applied: boolean | null;
}

export interface LauncherState {
  phase: Phase;
  statusLine: string;
  errorDetails: string | null;
  resolvedHost: string;
  serverName: string;
  serverChoices: ServerChoice[];
  selectedServerId: string;
  serverOnline: boolean | null; // null = not probed yet
  gamePathValid: boolean;
  /** Exact saved path represented by gamePathValid. */
  validatedGameExePath: string;
  /** null off Linux; otherwise whether the configured Wine runner is executable. */
  winePathValid: boolean | null;
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
  platform: 'win32' | 'linux' | 'darwin';
  /** Account tab stays hidden until Phase 4 auto-login lands (plan §11b decision #4). */
  accountTabEnabled: boolean;
}

export interface WineRunner {
  label: string;
  path: string;
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
  selectDeveloperServer(id: string): Promise<void>;
  refresh(): Promise<void>;
  listWineRunners(): Promise<WineRunner[]>;
  createWinePrefix(): Promise<ActionResult>;
  openDiscord(): Promise<ActionResult>;
  openSteamStore(): Promise<ActionResult>;
  openLauncherLogs(): Promise<ActionResult>;
  copyDiagnostics(): Promise<ActionResult>;
  getLogTail(): Promise<string[]>;
  onState(cb: (state: LauncherState) => void): () => void;
  onLogLine(cb: (line: string) => void): () => void;
}

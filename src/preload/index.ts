import { contextBridge, ipcRenderer } from 'electron';
import type {
  ClientPatchId,
  DeepPartial,
  DlcId,
  LauncherApi,
  LauncherState,
  ProfilePlayDecision,
  ProfileSwitchDecision,
  RendererErrorReport,
  Settings
} from '@shared/types';
import { IPC } from '@shared/ipc';

// contextIsolation is ON and this preload is sandboxed: the renderer sees ONLY this typed surface,
// no Node, no raw ipcRenderer (plan §2 state-ownership rule).
const api: LauncherApi = {
  platform: process.platform as LauncherApi['platform'],
  getState: () => ipcRenderer.invoke(IPC.getState),
  getLauncherChangelogStatus: () => ipcRenderer.invoke(IPC.getLauncherChangelogStatus),
  acknowledgeLauncherChangelog: () => ipcRenderer.invoke(IPC.acknowledgeLauncherChangelog),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch: DeepPartial<Settings>) => ipcRenderer.invoke(IPC.updateSettings, patch),
  setGameClientPatch: (enabled: boolean) =>
    ipcRenderer.invoke(IPC.setGameClientPatch, enabled),
  setDlcEnabled: (id: DlcId, enabled: boolean) =>
    ipcRenderer.invoke(IPC.setDlcEnabled, id, enabled),
  browseForGame: () => ipcRenderer.invoke(IPC.browseForGame),
  autoDetectGame: () => ipcRenderer.invoke(IPC.autoDetectGame),
  play: (decision?: ProfilePlayDecision) => ipcRenderer.invoke(IPC.play, decision),
  playDeveloper: (decision?: ProfilePlayDecision) =>
    ipcRenderer.invoke(IPC.playDeveloper, decision),
  applyClientPatch: (id: ClientPatchId) => ipcRenderer.invoke(IPC.applyClientPatch, id),
  removeClientPatch: (id: ClientPatchId) => ipcRenderer.invoke(IPC.removeClientPatch, id),
  createGameProfile: (name: string) => ipcRenderer.invoke(IPC.createGameProfile, name),
  updateGameProfile: (id: string) => ipcRenderer.invoke(IPC.updateGameProfile, id),
  renameGameProfile: (id: string, name: string) =>
    ipcRenderer.invoke(IPC.renameGameProfile, id, name),
  deleteGameProfile: (id: string) => ipcRenderer.invoke(IPC.deleteGameProfile, id),
  setGameProfilesEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(IPC.setGameProfilesEnabled, enabled),
  selectGameProfile: (id: string, decision?: ProfileSwitchDecision) =>
    ipcRenderer.invoke(IPC.selectGameProfile, id, decision),
  selectServer: (id: string) => ipcRenderer.invoke(IPC.selectServer, id),
  checkServer: () => ipcRenderer.invoke(IPC.checkServer),
  refresh: () => ipcRenderer.invoke(IPC.refresh),
  refreshPatchStatuses: () => ipcRenderer.invoke(IPC.refreshPatchStatuses),
  checkLauncherUpdates: () => ipcRenderer.invoke(IPC.checkLauncherUpdates),
  listLinuxRuntimeOptions: () => ipcRenderer.invoke(IPC.listLinuxRuntimeOptions),
  createWinePrefix: () => ipcRenderer.invoke(IPC.createWinePrefix),
  openDiscord: () => ipcRenderer.invoke(IPC.openDiscord),
  openDiscordSupport: () => ipcRenderer.invoke(IPC.openDiscordSupport),
  openAgendaStats: () => ipcRenderer.invoke(IPC.openAgendaStats),
  openGaCards: () => ipcRenderer.invoke(IPC.openGaCards),
  openSteamStore: () => ipcRenderer.invoke(IPC.openSteamStore),
  openSteamInstall: () => ipcRenderer.invoke(IPC.openSteamInstall),
  getSteamLaunchIntegration: () => ipcRenderer.invoke(IPC.getSteamLaunchIntegration),
  setSteamLaunchIntegration: (enabled: boolean) =>
    ipcRenderer.invoke(IPC.setSteamLaunchIntegration, enabled),
  shouldOfferSteamLaunchIntegration: () =>
    ipcRenderer.invoke(IPC.shouldOfferSteamLaunchIntegration),
  acknowledgeSteamLaunchIntegrationOffer: () =>
    ipcRenderer.invoke(IPC.acknowledgeSteamLaunchIntegrationOffer),
  openLauncherLogs: () => ipcRenderer.invoke(IPC.openLauncherLogs),
  copyChatCommand: (command: string) => ipcRenderer.invoke(IPC.copyChatCommand, command),
  copyDiagnostics: () => ipcRenderer.invoke(IPC.copyDiagnostics),
  reportRendererError: (report: RendererErrorReport) =>
    ipcRenderer.invoke(IPC.reportRendererError, report),
  reloadRenderer: () => ipcRenderer.invoke(IPC.reloadRenderer),
  getLogTail: () => ipcRenderer.invoke(IPC.getLogTail),
  resetLauncher: () => ipcRenderer.invoke(IPC.resetLauncher),
  onState: (cb: (state: LauncherState) => void) => {
    const handler = (_e: unknown, state: LauncherState): void => cb(state);
    ipcRenderer.on(IPC.evState, handler);
    return () => ipcRenderer.removeListener(IPC.evState, handler);
  },
  onLogLine: (cb: (line: string) => void) => {
    const handler = (_e: unknown, line: string): void => cb(line);
    ipcRenderer.on(IPC.evLog, handler);
    return () => ipcRenderer.removeListener(IPC.evLog, handler);
  }
};

contextBridge.exposeInMainWorld('api', api);

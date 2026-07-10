import { contextBridge, ipcRenderer } from 'electron';
import type { DeepPartial, LauncherApi, LauncherState, Settings } from '@shared/types';
import { IPC } from '@shared/ipc';

// contextIsolation is ON and this preload is sandboxed: the renderer sees ONLY this typed surface,
// no Node, no raw ipcRenderer (plan §2 state-ownership rule).
const api: LauncherApi = {
  platform: process.platform as LauncherApi['platform'],
  getState: () => ipcRenderer.invoke(IPC.getState),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch: DeepPartial<Settings>) => ipcRenderer.invoke(IPC.updateSettings, patch),
  browseForGame: () => ipcRenderer.invoke(IPC.browseForGame),
  autoDetectGame: () => ipcRenderer.invoke(IPC.autoDetectGame),
  play: () => ipcRenderer.invoke(IPC.play),
  playDeveloper: () => ipcRenderer.invoke(IPC.playDeveloper),
  selectDeveloperServer: (id: string) => ipcRenderer.invoke(IPC.selectDeveloperServer, id),
  refresh: () => ipcRenderer.invoke(IPC.refresh),
  listWineRunners: () => ipcRenderer.invoke(IPC.listWineRunners),
  createWinePrefix: () => ipcRenderer.invoke(IPC.createWinePrefix),
  openDiscord: () => ipcRenderer.invoke(IPC.openDiscord),
  openSteamStore: () => ipcRenderer.invoke(IPC.openSteamStore),
  openLauncherLogs: () => ipcRenderer.invoke(IPC.openLauncherLogs),
  copyDiagnostics: () => ipcRenderer.invoke(IPC.copyDiagnostics),
  getLogTail: () => ipcRenderer.invoke(IPC.getLogTail),
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

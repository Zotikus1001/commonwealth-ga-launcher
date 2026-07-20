import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import type { DeepPartial, Settings } from '@shared/types';
import { IPC } from '@shared/ipc';
import type { Orchestrator } from './Orchestrator';
import type { ConfigStore } from './services/ConfigStore';
import type { Log } from './services/Log';
import { createWinePrefix, listLinuxRuntimeOptions } from './services/LinuxRuntime';
import { buildDiagnosticsReport } from './services/Diagnostics';
import { LAUNCHER_CONFIG } from '@shared/generatedLauncherConfig';
import { DEFAULT_SERVER_ID } from '@shared/serverProfiles';

export function registerIpc(
  getWindow: () => BrowserWindow | null,
  orchestrator: Orchestrator,
  config: ConfigStore,
  log: Log
): void {
  let resetInProgress = false;

  // main -> renderer pushes
  orchestrator.setBroadcast((state) => {
    getWindow()?.webContents.send(IPC.evState, state);
  });
  log.onLine((line) => {
    getWindow()?.webContents.send(IPC.evLog, line);
  });

  ipcMain.handle(IPC.getState, () => orchestrator.getState());
  ipcMain.handle(IPC.getSettings, () => config.get());

  ipcMain.handle(IPC.updateSettings, async (_e, patch: DeepPartial<Settings>) => {
    const previous = config.get();
    const updated = await config.update(patch);
    getWindow()?.webContents.setZoomFactor(updated.uiScale);
    const uiScaleOnly =
      typeof patch === 'object' &&
      patch !== null &&
      Object.keys(patch).length === 1 &&
      'uiScale' in patch;
    if (!uiScaleOnly) {
      const gamePathChanged = previous.gameExePath !== updated.gameExePath;
      const dxvkChanged = previous.developer.useDxvk !== updated.developer.useDxvk;
      const gameClientPatchChanged =
        previous.patches.gameClientPatch !== updated.patches.gameClientPatch;
      if (dxvkChanged) {
        try {
          await orchestrator.settingsChanged(updated.developer.useDxvk);
        } catch (error) {
          try {
            await config.update({ developer: { useDxvk: previous.developer.useDxvk } });
          } catch (rollbackError) {
            throw new Error(
              `${(error as Error).message}; could not restore the previous DXVK/Vulkan setting: ` +
                (rollbackError as Error).message
            );
          }
          throw error;
        }
      }
      if (gameClientPatchChanged) {
        try {
          await orchestrator.gameClientPatchChanged(updated.patches.gameClientPatch);
        } catch (error) {
          try {
            await config.update({
              patches: { gameClientPatch: previous.patches.gameClientPatch }
            });
          } catch (rollbackError) {
            throw new Error(
              `${(error as Error).message}; could not restore the previous client-patch setting: ` +
                (rollbackError as Error).message
            );
          }
          throw error;
        }
      }
      if (!dxvkChanged && !gameClientPatchChanged) {
        if (gamePathChanged) await orchestrator.settingsChanged();
        else void orchestrator.settingsChanged();
      }
    }
    return updated;
  });

  ipcMain.handle(IPC.browseForGame, async () => {
    const win = getWindow();
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      title: "Select GlobalAgenda.exe (in the game's Binaries folder)",
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'GlobalAgenda.exe', extensions: ['exe'] }]
          : [{ name: 'GlobalAgenda.exe', extensions: ['exe', '*'] }]
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const exePath = res.filePaths[0];
    await config.update({ gameExePath: exePath });
    await orchestrator.settingsChanged();
    return exePath;
  });

  ipcMain.handle(IPC.autoDetectGame, () => orchestrator.autoDetect());
  ipcMain.handle(IPC.play, () => orchestrator.play());
  ipcMain.handle(IPC.playDeveloper, () => orchestrator.play(true));
  ipcMain.handle(IPC.applyClientPatch, (_event, id: unknown) => {
    if (id !== 'high-fps-movement-stability' && id !== 'adaptive-client-performance') {
      throw new Error('Unknown client patch.');
    }
    return orchestrator.applyClientPatch(id);
  });

  ipcMain.handle(IPC.removeClientPatch, (_event, id: unknown) => {
    if (id !== 'high-fps-movement-stability' && id !== 'adaptive-client-performance') {
      throw new Error('Unknown client patch.');
    }
    return orchestrator.removeClientPatch(id);
  });
  ipcMain.handle(IPC.selectServer, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Server identifier must be a string.');
    return orchestrator.selectServer(id);
  });
  ipcMain.handle(IPC.checkServer, () => orchestrator.checkServer());
  ipcMain.handle(IPC.refresh, () => orchestrator.refresh());
  ipcMain.handle(IPC.checkLauncherUpdates, () => orchestrator.checkLauncherUpdates());
  ipcMain.handle(IPC.listLinuxRuntimeOptions, () =>
    listLinuxRuntimeOptions(config.get(), log)
  );
  ipcMain.handle(IPC.createWinePrefix, async () => {
    const s = config.get();
    if (s.linux.runner !== 'wine') {
      return { ok: false, message: 'UMU creates Proton prefixes automatically when Play runs.' };
    }
    const result = await createWinePrefix(s.linux.winePath, s.linux.winePrefix, log);
    if (result.ok) await orchestrator.settingsChanged();
    return result;
  });
  ipcMain.handle(IPC.openDiscord, async () => {
    try {
      await shell.openExternal(LAUNCHER_CONFIG.discordInviteUrl);
      return { ok: true, message: 'Discord invite opened.' };
    } catch (error) {
      return { ok: false, message: `Could not open Discord: ${(error as Error).message}` };
    }
  });

  ipcMain.handle(IPC.openAgendaStats, async () => {
    if (orchestrator.getState().selectedServerId !== DEFAULT_SERVER_ID) {
      return { ok: false, message: 'Agenda Stats is available only for the Commonwealth server.' };
    }
    try {
      await shell.openExternal(LAUNCHER_CONFIG.agendaStatsUrl);
      return { ok: true, message: 'Agenda Stats opened.' };
    } catch (error) {
      return { ok: false, message: `Could not open Agenda Stats: ${(error as Error).message}` };
    }
  });

  ipcMain.handle(IPC.openSteamStore, async () => {
    try {
      await shell.openExternal(LAUNCHER_CONFIG.steamStoreUrl);
      return { ok: true, message: 'Steam page opened.' };
    } catch (error) {
      return { ok: false, message: `Could not open Steam: ${(error as Error).message}` };
    }
  });

  ipcMain.handle(IPC.openSteamInstall, async () => {
    try {
      await shell.openExternal(LAUNCHER_CONFIG.steamInstallUrl);
      return { ok: true, message: 'Steam install opened.' };
    } catch (error) {
      return { ok: false, message: `Could not open Steam: ${(error as Error).message}` };
    }
  });

  ipcMain.handle(IPC.openLauncherLogs, async () => {
    const error = await shell.openPath(log.logDir);
    return error
      ? { ok: false, message: `Could not open logs folder: ${error}` }
      : { ok: true, message: 'Logs folder opened.' };
  });

  ipcMain.handle(IPC.copyDiagnostics, () => {
    const report = buildDiagnosticsReport(orchestrator.getState(), config.get(), log.tail());
    clipboard.writeText(report);
    return { ok: true, message: 'Diagnostics copied to clipboard.' };
  });

  ipcMain.handle(IPC.getLogTail, () => log.tail());

  ipcMain.handle(IPC.resetLauncher, async () => {
    if (resetInProgress) {
      return { ok: false, message: 'Launcher reset is already in progress.' };
    }
    resetInProgress = true;
    let resetCompleted = false;
    try {
      const result = await orchestrator.resetLauncher();
      if (!result.ok) {
        resetInProgress = false;
        return result;
      }
      resetCompleted = true;
      app.relaunch();
      setTimeout(() => app.exit(0), 100);
      return result;
    } catch (error) {
      resetInProgress = false;
      const message = error instanceof Error ? error.message : String(error);
      log.error(
        `${resetCompleted ? 'launcher restart after reset' : 'launcher reset request'} failed: ${message}`
      );
      return {
        ok: false,
        message: resetCompleted
          ? 'Settings were reset, but automatic restart failed. Close and reopen the launcher.'
          : `Could not reset the launcher: ${message}`
      };
    }
  });
}

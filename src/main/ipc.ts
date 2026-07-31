import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import {
  DLC_SETTING_KEY_BY_ID,
  isDlcId,
  type DeepPartial,
  type Settings
} from '@shared/types';
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

  const commitGameClientPatchChange = async (
    previousEnabled: boolean,
    updated: Settings
  ): Promise<void> => {
    try {
      await orchestrator.gameClientPatchChanged(updated.patches.gameClientPatch);
    } catch (error) {
      try {
        await config.update({
          patches: { gameClientPatch: previousEnabled }
        });
      } catch (rollbackError) {
        throw new Error(
          `${(error as Error).message}; could not restore the previous client-patch setting: ` +
            (rollbackError as Error).message
        );
      }
      throw error;
    }
  };

  ipcMain.handle(IPC.updateSettings, async (_e, patch: DeepPartial<Settings>) => {
    const previous = config.get();
    const updated = await config.update(patch);
    getWindow()?.webContents.setZoomFactor(updated.uiScale);
    const uiScaleOnly =
      typeof patch === 'object' &&
      patch !== null &&
      Object.keys(patch).length === 1 &&
      'uiScale' in patch;
    const developerModeOnly =
      typeof patch === 'object' &&
      patch !== null &&
      Object.keys(patch).length === 1 &&
      typeof patch.developer === 'object' &&
      patch.developer !== null &&
      !Array.isArray(patch.developer) &&
      Object.keys(patch.developer).length === 1 &&
      'enabled' in patch.developer;
    if (!uiScaleOnly) {
      const gamePathChanged = previous.gameExePath !== updated.gameExePath;
      const dxvkChanged = previous.developer.useDxvk !== updated.developer.useDxvk;
      const localClientDllChanged =
        previous.developer.useLocalClientDll !== updated.developer.useLocalClientDll;
      const gameClientPatchChanged =
        previous.patches.gameClientPatch !== updated.patches.gameClientPatch;
      if (localClientDllChanged) {
        try {
          await orchestrator.localClientDllChanged(updated.developer.useLocalClientDll);
        } catch (error) {
          try {
            await config.update({
              developer: { useLocalClientDll: previous.developer.useLocalClientDll }
            });
          } catch (rollbackError) {
            throw new Error(
              `${(error as Error).message}; could not restore the previous local DLL setting: ` +
                (rollbackError as Error).message
            );
          }
          throw error;
        }
      }
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
        await commitGameClientPatchChange(previous.patches.gameClientPatch, updated);
      }
      if (developerModeOnly && !localClientDllChanged) {
        orchestrator.developerModeChanged();
      }
      if (
        !localClientDllChanged &&
        !dxvkChanged &&
        !gameClientPatchChanged &&
        !developerModeOnly
      ) {
        if (gamePathChanged) await orchestrator.settingsChanged();
        else void orchestrator.settingsChanged();
      }
    }
    return updated;
  });

  ipcMain.handle(IPC.setGameClientPatch, async (_e, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Game Client Patch state is invalid.');
    const previousEnabled = config.get().patches.gameClientPatch;
    const updated = await config.update({ patches: { gameClientPatch: enabled } });
    await commitGameClientPatchChange(previousEnabled, updated);
    return updated;
  });

  ipcMain.handle(IPC.setDlcEnabled, async (_event, id: unknown, enabled: unknown) => {
    if (!isDlcId(id)) throw new Error('Unknown DLC.');
    if (typeof enabled !== 'boolean') throw new Error('DLC state is invalid.');
    const settingKey = DLC_SETTING_KEY_BY_ID[id];
    const previousDlcs = config.get().dlcs;
    const updated = await config.update({
      dlcs: { ...previousDlcs, [settingKey]: enabled }
    });
    try {
      await orchestrator.dlcChanged(id, enabled);
    } catch (error) {
      try {
        await config.update({ dlcs: previousDlcs });
      } catch (rollbackError) {
        throw new Error(
          `${(error as Error).message}; could not restore the previous DLC setting: ` +
            (rollbackError as Error).message
        );
      }
      throw error;
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
  ipcMain.handle(IPC.createGameProfile, (_event, name: unknown) => {
    if (typeof name !== 'string') throw new Error('Profile name must be a string.');
    return orchestrator.createGameProfile(name);
  });
  ipcMain.handle(IPC.updateGameProfile, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Profile identifier must be a string.');
    return orchestrator.updateGameProfile(id);
  });
  ipcMain.handle(IPC.renameGameProfile, (_event, id: unknown, name: unknown) => {
    if (typeof id !== 'string') throw new Error('Profile identifier must be a string.');
    if (typeof name !== 'string') throw new Error('Profile name must be a string.');
    return orchestrator.renameGameProfile(id, name);
  });
  ipcMain.handle(IPC.deleteGameProfile, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Profile identifier must be a string.');
    return orchestrator.deleteGameProfile(id);
  });
  ipcMain.handle(IPC.selectGameProfile, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Profile identifier must be a string.');
    return orchestrator.selectGameProfile(id);
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

  ipcMain.handle(IPC.copyChatCommand, (_event, command: unknown) => {
    if (
      typeof command !== 'string' ||
      command.length > 128 ||
      !/^-[a-z][a-z0-9]*(?: [a-z0-9][a-z0-9-]*)?$/.test(command)
    ) {
      return { ok: false, message: 'Invalid chat command.' };
    }
    try {
      clipboard.writeText(command);
      return { ok: true, message: 'Command copied to clipboard.' };
    } catch (error) {
      return { ok: false, message: `Could not copy command: ${(error as Error).message}` };
    }
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

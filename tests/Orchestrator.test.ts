import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

const serviceMocks = vi.hoisted(() => ({
  validateGameExe: vi.fn(),
  applyIniClientPatch: vi.fn(),
  removeIniClientPatch: vi.fn(),
  inspectClientPatches: vi.fn(),
  inspectGameIniSettings: vi.fn(),
  ensureClientConfiguration: vi.fn(),
  gpuSelect: vi.fn(),
  clientPrepare: vi.fn(),
  clientPrepareLocal: vi.fn(),
  clientInspect: vi.fn(),
  clientDisable: vi.fn(),
  clientRemoveManaged: vi.fn(),
  dlcEnsure: vi.fn(),
  dlcInspectAll: vi.fn(),
  dlcRemove: vi.fn(),
  probeServer: vi.fn(),
  profileLoad: vi.fn(),
  profileSnapshot: vi.fn(),
  profileSelected: vi.fn(),
  profileApply: vi.fn(),
  profileSelect: vi.fn(),
  processRefresh: vi.fn(),
  processAdd: vi.fn(),
  processRemove: vi.fn(),
  processReset: vi.fn(),
  processPids: vi.fn(),
  dxvkPrepare: vi.fn(),
  gameLaunch: vi.fn()
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:\\LauncherData'),
    getVersion: vi.fn(() => '0.1.0'),
    quit: vi.fn()
  }
}));

vi.mock('../src/main/services/InstallLocator', () => ({
  validateGameExe: serviceMocks.validateGameExe,
  autoDetectGame: vi.fn()
}));

vi.mock('../src/main/services/ServerProbe', () => ({
  probeServer: serviceMocks.probeServer
}));

vi.mock('../src/main/services/IniFixes', () => ({
  applyClientPatch: serviceMocks.applyIniClientPatch,
  ensureClientConfiguration: serviceMocks.ensureClientConfiguration,
  inspectClientPatches: serviceMocks.inspectClientPatches,
  inspectGameIniSettings: serviceMocks.inspectGameIniSettings,
  removeClientPatch: serviceMocks.removeIniClientPatch,
  unavailableClientPatches: () => [
    { id: 'high-fps-movement-stability', applied: null },
    { id: 'adaptive-client-performance', applied: null }
  ]
}));

vi.mock('../src/main/services/DxvkManager', () => ({
  DxvkManager: class {
    inspect = vi.fn().mockResolvedValue({
      status: 'native',
      version: '2.6.2',
      rendererSetting: 'unknown',
      detail: 'Native Direct3D is active.',
      canRestore: false
    });
    prepareForLaunch = serviceMocks.dxvkPrepare;
    launchEnvironment = vi.fn(() => ({}));
  },
  unavailableDxvkState: () => ({
    status: 'native',
    version: '2.6.2',
    rendererSetting: 'unknown',
    detail: 'No valid game installation is available.',
    canRestore: false
  })
}));

vi.mock('../src/main/services/GameProfileManager', () => ({
  GameProfileManager: class {
    load = serviceMocks.profileLoad;
    getSnapshot = serviceMocks.profileSnapshot;
    getSelectedSummary = serviceMocks.profileSelected;
    applySelected = serviceMocks.profileApply;
    select = serviceMocks.profileSelect;
  }
}));

vi.mock('../src/main/services/GameLauncher', () => ({
  GameLauncher: class {
    launch = serviceMocks.gameLaunch;
  }
}));

vi.mock('../src/main/services/GameProcessTracker', () => ({
  GameProcessTracker: class {
    refresh = serviceMocks.processRefresh;
    add = serviceMocks.processAdd;
    remove = serviceMocks.processRemove;
    reset = serviceMocks.processReset;
    getPids = serviceMocks.processPids;
  }
}));

vi.mock('../src/main/services/GpuMemory', () => ({
  GpuMemoryDetector: class {
    select = serviceMocks.gpuSelect;
  }
}));

vi.mock('../src/main/services/ClientPatchManager', () => ({
  ClientPatchManager: class {
    prepareForLaunch = serviceMocks.clientPrepare;
    prepareLocalForLaunch = serviceMocks.clientPrepareLocal;
    inspect = serviceMocks.clientInspect;
    disable = serviceMocks.clientDisable;
    removeManaged = serviceMocks.clientRemoveManaged;
  },
  unavailableGameClientDllState: () => ({
    status: 'unavailable',
    detail: 'Set a valid game installation to inspect dinput8.dll.',
    hasManagedMarker: false
  })
}));

vi.mock('../src/main/services/DlcManager', () => ({
  DlcManager: class {
    ensureInstalled = serviceMocks.dlcEnsure;
    inspectAll = serviceMocks.dlcInspectAll;
    remove = serviceMocks.dlcRemove;
  },
  unavailableDlcStatuses: () => [
    {
      id: 'surfside-atoll-pvp-maps',
      name: 'Surfside-Atoll PvP Maps',
      status: 'unavailable',
      detail: 'Set a valid game installation to manage this DLC.',
      installedFiles: 0,
      totalFiles: 4
    }
  ],
  failedDlcStatus: (_id: string, message: string) => ({
    id: 'surfside-atoll-pvp-maps',
    name: 'Surfside-Atoll PvP Maps',
    status: 'error',
    detail: message,
    installedFiles: 0,
    totalFiles: 4
  })
}));

import { Orchestrator } from '../src/main/Orchestrator';
import { defaultSettings, type ConfigStore } from '../src/main/services/ConfigStore';
import type { LauncherUpdater } from '../src/main/services/LauncherUpdater';
import type { Log } from '../src/main/services/Log';

beforeEach(() => {
  vi.clearAllMocks();
  serviceMocks.applyIniClientPatch.mockResolvedValue({
    checkedFiles: [],
    changedFiles: [],
    backupFiles: []
  });
  serviceMocks.inspectClientPatches.mockResolvedValue([
    { id: 'high-fps-movement-stability', applied: true },
    { id: 'adaptive-client-performance', applied: true }
  ]);
  serviceMocks.inspectGameIniSettings.mockResolvedValue({
    loginMap: null,
    showOverhealing: null,
    fpsLimit: { enabled: null, value: null }
  });
  serviceMocks.gpuSelect.mockResolvedValue({ texturePoolMb: 1_024 });
  serviceMocks.clientPrepare.mockResolvedValue({});
  serviceMocks.clientPrepareLocal.mockResolvedValue({});
  serviceMocks.clientInspect.mockResolvedValue({
    status: 'managed',
    detail: 'Launcher-managed Game Client Patch release detected.',
    hasManagedMarker: true
  });
  serviceMocks.clientDisable.mockResolvedValue(undefined);
  serviceMocks.clientRemoveManaged.mockResolvedValue(true);
  serviceMocks.dlcEnsure.mockResolvedValue({
    id: 'surfside-atoll-pvp-maps',
    name: 'Surfside-Atoll PvP Maps',
    status: 'installed',
    detail: 'All 4 verified map files are installed.',
    installedFiles: 4,
    totalFiles: 4
  });
  serviceMocks.dlcInspectAll.mockResolvedValue([
    {
      id: 'surfside-atoll-pvp-maps',
      name: 'Surfside-Atoll PvP Maps',
      status: 'installed',
      detail: 'All 4 verified map files are installed.',
      installedFiles: 4,
      totalFiles: 4
    }
  ]);
  serviceMocks.dlcRemove.mockResolvedValue({
    id: 'surfside-atoll-pvp-maps',
    name: 'Surfside-Atoll PvP Maps',
    status: 'missing',
    detail: 'The map files are not installed.',
    installedFiles: 0,
    totalFiles: 4
  });
  serviceMocks.probeServer.mockResolvedValue('online');
  serviceMocks.profileLoad.mockResolvedValue(undefined);
  serviceMocks.profileSnapshot.mockReturnValue({ profiles: [], selectedProfileId: null });
  serviceMocks.profileSelected.mockReturnValue(null);
  serviceMocks.profileApply.mockResolvedValue(null);
  serviceMocks.profileSelect.mockResolvedValue(undefined);
  serviceMocks.processRefresh.mockResolvedValue(0);
  serviceMocks.processAdd.mockResolvedValue(1);
  serviceMocks.processRemove.mockResolvedValue(0);
  serviceMocks.processReset.mockResolvedValue(undefined);
  serviceMocks.processPids.mockReturnValue([]);
  serviceMocks.dxvkPrepare.mockResolvedValue({
    status: 'native',
    version: '2.6.2',
    rendererSetting: 'unknown',
    detail: 'Native Direct3D is active.',
    canRestore: false
  });
  serviceMocks.gameLaunch.mockImplementation(() => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { exitCode: null, signalCode: null });
    return child;
  });
});

describe('game setup patch preparation', () => {
  it('applies every enabled patch as soon as a game install becomes valid', async () => {
    const install = {
      exePath: 'C:\\Games\\Global Agenda\\Binaries\\GlobalAgenda.exe',
      binariesDir: 'C:\\Games\\Global Agenda\\Binaries',
      rootDir: 'C:\\Games\\Global Agenda',
      configDir: 'C:\\Games\\Global Agenda\\TgGame\\Config'
    };
    serviceMocks.validateGameExe.mockImplementation(async (exePath: string) =>
      exePath ? install : null
    );
    let settings = defaultSettings();
    const config = {
      get: vi.fn(() => settings),
      update: vi.fn(async () => settings),
      syncGameIniSettings: vi.fn(async () => settings)
    } as unknown as ConfigStore;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as unknown as Log;
    const updater = {
      getSnapshot: vi.fn(() => ({
        status: 'disabled',
        version: null,
        error: null,
        progress: null
      })),
      setEvents: vi.fn()
    } as unknown as LauncherUpdater;
    const orchestrator = new Orchestrator(config, log, '127.0.0.1', '', updater);

    await orchestrator.refresh();

    expect(serviceMocks.applyIniClientPatch).not.toHaveBeenCalled();
    expect(serviceMocks.clientPrepare).not.toHaveBeenCalled();
    expect(serviceMocks.dlcEnsure).not.toHaveBeenCalled();

    settings = { ...settings, gameExePath: install.exePath };
    await orchestrator.refresh();

    expect(serviceMocks.applyIniClientPatch).toHaveBeenCalledTimes(2);
    expect(serviceMocks.applyIniClientPatch).toHaveBeenCalledWith(
      install,
      'high-fps-movement-stability',
      log,
      expect.any(String)
    );
    expect(serviceMocks.applyIniClientPatch).toHaveBeenCalledWith(
      install,
      'adaptive-client-performance',
      log,
      expect.any(String),
      1_024
    );
    expect(serviceMocks.clientPrepare).toHaveBeenCalledWith(
      install,
      process.platform,
      expect.any(Function)
    );
    expect(serviceMocks.dlcEnsure).toHaveBeenCalledWith(
      install,
      'surfside-atoll-pvp-maps',
      expect.any(Function)
    );

    await orchestrator.refresh();

    expect(serviceMocks.applyIniClientPatch).toHaveBeenCalledTimes(2);
    expect(serviceMocks.clientPrepare).toHaveBeenCalledTimes(1);
    expect(serviceMocks.dlcEnsure).toHaveBeenCalledTimes(1);
  });

  it('checks an enabled DLC before every Play and honors its saved opt-out', async () => {
    vi.useFakeTimers();
    const install = {
      exePath: 'C:\\Games\\Global Agenda\\Binaries\\GlobalAgenda.exe',
      binariesDir: 'C:\\Games\\Global Agenda\\Binaries',
      rootDir: 'C:\\Games\\Global Agenda',
      configDir: 'C:\\Games\\Global Agenda\\TgGame\\Config'
    };
    serviceMocks.validateGameExe.mockResolvedValue(install);
    const settings = defaultSettings();
    settings.gameExePath = install.exePath;
    settings.developer.enabled = true;
    settings.patches.gameClientPatch = false;
    settings.launch.closeAfterLaunch = false;
    const config = {
      get: vi.fn(() => settings),
      update: vi.fn(async () => settings),
      syncGameIniSettings: vi.fn(async () => settings)
    } as unknown as ConfigStore;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as unknown as Log;
    const updater = {
      getSnapshot: vi.fn(() => ({
        status: 'disabled',
        version: null,
        error: null,
        progress: null
      })),
      setEvents: vi.fn(),
      ensureCurrent: vi.fn()
    } as unknown as LauncherUpdater;
    const orchestrator = new Orchestrator(config, log, '127.0.0.1', '', updater);

    await orchestrator.refresh();
    expect(serviceMocks.dlcEnsure).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();

    await orchestrator.play();
    expect(serviceMocks.dlcEnsure).toHaveBeenCalledTimes(1);
    expect(serviceMocks.gameLaunch).toHaveBeenCalledTimes(1);
    vi.runOnlyPendingTimers();

    settings.dlcs.surfsideAtollPvpMaps = false;
    await orchestrator.play();
    expect(serviceMocks.dlcEnsure).toHaveBeenCalledTimes(1);
    expect(serviceMocks.gameLaunch).toHaveBeenCalledTimes(2);

    for (const result of serviceMocks.gameLaunch.mock.results) {
      (result.value as ChildProcess).emit('exit', 0, null);
    }
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('restores the selected profile before disabled-patch cleanup and every launch INI mutation', async () => {
    vi.useFakeTimers();
    const install = {
      exePath: 'C:\\Games\\Global Agenda\\Binaries\\GlobalAgenda.exe',
      binariesDir: 'C:\\Games\\Global Agenda\\Binaries',
      rootDir: 'C:\\Games\\Global Agenda',
      configDir: 'C:\\Games\\Global Agenda\\TgGame\\Config'
    };
    serviceMocks.validateGameExe.mockResolvedValue(install);
    const profile = {
      id: '7dc38cb8-6514-4e23-9b31-56fe2f81703d',
      name: 'Competitive',
      createdAt: '2026-07-20T12:00:00.000Z',
      updatedAt: '2026-07-20T12:00:00.000Z',
      fileCount: 4
    };
    serviceMocks.profileSnapshot.mockReturnValue({
      profiles: [profile],
      selectedProfileId: profile.id
    });
    serviceMocks.profileSelected.mockReturnValue(profile);
    serviceMocks.profileApply.mockResolvedValue({ ...profile, totalBytes: 4_096 });

    const settings = defaultSettings();
    settings.gameExePath = install.exePath;
    settings.developer.enabled = true;
    settings.patches.gameClientPatch = false;
    settings.patches.highFpsMovementStability = false;
    settings.launch.closeAfterLaunch = false;
    const config = {
      get: vi.fn(() => settings),
      update: vi.fn(async () => settings),
      syncGameIniSettings: vi.fn(async () => settings)
    } as unknown as ConfigStore;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as unknown as Log;
    const updater = {
      getSnapshot: vi.fn(() => ({
        status: 'disabled',
        version: null,
        error: null,
        progress: null
      })),
      setEvents: vi.fn(),
      ensureCurrent: vi.fn()
    } as unknown as LauncherUpdater;
    const orchestrator = new Orchestrator(config, log, '127.0.0.1', '', updater);
    await orchestrator.refresh();
    vi.clearAllMocks();
    serviceMocks.profileSelected.mockReturnValue(profile);
    serviceMocks.profileApply.mockResolvedValue({ ...profile, totalBytes: 4_096 });
    serviceMocks.gpuSelect.mockResolvedValue({ texturePoolMb: 1_024 });
    serviceMocks.inspectClientPatches.mockResolvedValue([]);
    serviceMocks.dxvkPrepare.mockResolvedValue({
      status: 'native',
      version: '2.6.2',
      rendererSetting: 'unknown',
      detail: 'Native Direct3D is active.',
      canRestore: false
    });

    await orchestrator.play();

    expect(serviceMocks.profileApply).toHaveBeenCalledWith(install);
    expect(serviceMocks.removeIniClientPatch).toHaveBeenCalledWith(
      install,
      'high-fps-movement-stability',
      log,
      expect.any(String)
    );
    expect(serviceMocks.profileApply.mock.invocationCallOrder[0]).toBeLessThan(
      serviceMocks.removeIniClientPatch.mock.invocationCallOrder[0]
    );
    expect(serviceMocks.removeIniClientPatch.mock.invocationCallOrder[0]).toBeLessThan(
      serviceMocks.ensureClientConfiguration.mock.invocationCallOrder[0]
    );
    expect(serviceMocks.ensureClientConfiguration.mock.invocationCallOrder[0]).toBeLessThan(
      serviceMocks.dxvkPrepare.mock.invocationCallOrder[0]
    );
    expect(serviceMocks.dxvkPrepare.mock.invocationCallOrder[0]).toBeLessThan(
      serviceMocks.gameLaunch.mock.invocationCallOrder[0]
    );
    expect(orchestrator.getState().activeGameInstances).toBe(1);
    await expect(orchestrator.selectGameProfile(profile.id)).rejects.toThrow(
      'Close every game instance'
    );

    vi.runOnlyPendingTimers();
    await orchestrator.play();
    expect(serviceMocks.profileApply).toHaveBeenCalledTimes(1);
    expect(serviceMocks.gameLaunch).toHaveBeenCalledTimes(2);
    expect(orchestrator.getState().activeGameInstances).toBe(2);

    for (const result of serviceMocks.gameLaunch.mock.results) {
      (result.value as ChildProcess).emit('exit', 0, null);
    }
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    expect(orchestrator.getState().activeGameInstances).toBe(0);
    await expect(orchestrator.selectGameProfile(profile.id)).resolves.toBeUndefined();
    expect(serviceMocks.profileSelect).toHaveBeenCalledWith(profile.id);
    vi.useRealTimers();
  });

  it('uses a validated local DLL independently of the managed patch preference', async () => {
    vi.useFakeTimers();
    const install = {
      exePath: 'C:\\Games\\Global Agenda\\Binaries\\GlobalAgenda.exe',
      binariesDir: 'C:\\Games\\Global Agenda\\Binaries',
      rootDir: 'C:\\Games\\Global Agenda',
      configDir: 'C:\\Games\\Global Agenda\\TgGame\\Config'
    };
    serviceMocks.validateGameExe.mockResolvedValue(install);
    serviceMocks.clientInspect.mockResolvedValue({
      status: 'local',
      detail: 'Valid local x86 client patch DLL detected.',
      hasManagedMarker: false
    });
    serviceMocks.clientPrepareLocal.mockResolvedValue({
      WINEDLLOVERRIDES: 'dinput8=n,b'
    });
    const settings = defaultSettings();
    settings.gameExePath = install.exePath;
    settings.developer.enabled = true;
    settings.developer.useLocalClientDll = true;
    settings.patches.gameClientPatch = false;
    settings.launch.closeAfterLaunch = false;
    const config = {
      get: vi.fn(() => settings),
      update: vi.fn(async () => settings),
      syncGameIniSettings: vi.fn(async () => settings)
    } as unknown as ConfigStore;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as unknown as Log;
    const updater = {
      getSnapshot: vi.fn(() => ({
        status: 'disabled',
        version: null,
        error: null,
        progress: null
      })),
      setEvents: vi.fn(),
      ensureCurrent: vi.fn()
    } as unknown as LauncherUpdater;
    const orchestrator = new Orchestrator(config, log, '127.0.0.1', '', updater);

    await orchestrator.refresh();

    expect(serviceMocks.clientPrepareLocal).toHaveBeenCalledWith(install, process.platform);
    expect(serviceMocks.clientPrepare).not.toHaveBeenCalled();
    vi.clearAllMocks();

    await orchestrator.play();

    expect(serviceMocks.clientPrepareLocal).toHaveBeenCalledWith(install, process.platform);
    expect(serviceMocks.clientPrepare).not.toHaveBeenCalled();
    expect(serviceMocks.gameLaunch).toHaveBeenCalledWith(
      settings,
      '127.0.0.1',
      install.binariesDir,
      process.platform,
      false,
      null,
      { WINEDLLOVERRIDES: 'dinput8=n,b' }
    );
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('rejects local mode immediately when the installed DLL is the managed release', async () => {
    const install = {
      exePath: 'C:\\Games\\Global Agenda\\Binaries\\GlobalAgenda.exe',
      binariesDir: 'C:\\Games\\Global Agenda\\Binaries',
      rootDir: 'C:\\Games\\Global Agenda',
      configDir: 'C:\\Games\\Global Agenda\\TgGame\\Config'
    };
    serviceMocks.validateGameExe.mockResolvedValue(install);
    serviceMocks.clientInspect.mockResolvedValue({
      status: 'managed',
      detail: 'Launcher-managed Game Client Patch release detected.',
      hasManagedMarker: true
    });
    const settings = defaultSettings();
    settings.gameExePath = install.exePath;
    settings.developer.enabled = true;
    settings.developer.useLocalClientDll = true;
    const config = {
      get: vi.fn(() => settings),
      update: vi.fn(async () => settings),
      syncGameIniSettings: vi.fn(async () => settings)
    } as unknown as ConfigStore;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as unknown as Log;
    const updater = {
      getSnapshot: vi.fn(() => ({
        status: 'disabled',
        version: null,
        error: null,
        progress: null
      })),
      setEvents: vi.fn()
    } as unknown as LauncherUpdater;
    const orchestrator = new Orchestrator(config, log, '127.0.0.1', '', updater);

    await expect(orchestrator.localClientDllChanged(true)).rejects.toThrow('managed release');
    expect(orchestrator.getState().gameClientDll.status).toBe('managed');
    expect(serviceMocks.clientPrepareLocal).not.toHaveBeenCalled();
  });

  it('updates Developer Mode state without importing active game INI values', () => {
    const settings = defaultSettings();
    settings.loginMap = 'LoginElvish_P.ut3';
    settings.developer.enabled = true;
    const syncGameIniSettings = vi.fn(async () => {
      settings.loginMap = 'Login_FreeAgent.ut3';
      return settings;
    });
    const config = {
      get: vi.fn(() => settings),
      update: vi.fn(async () => settings),
      syncGameIniSettings
    } as unknown as ConfigStore;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as unknown as Log;
    const updater = {
      getSnapshot: vi.fn(() => ({
        status: 'disabled',
        version: null,
        error: null,
        progress: null
      })),
      setEvents: vi.fn()
    } as unknown as LauncherUpdater;
    const orchestrator = new Orchestrator(config, log, '127.0.0.1', '', updater);

    orchestrator.developerModeChanged();

    expect(orchestrator.getState().developerMode).toBe(true);
    expect(syncGameIniSettings).not.toHaveBeenCalled();
    expect(settings.loginMap).toBe('LoginElvish_P.ut3');
  });

  it('disables local DLL mode without refreshing unrelated INI patch or login state', async () => {
    vi.useFakeTimers();
    const install = {
      exePath: 'C:\\Games\\Global Agenda\\Binaries\\GlobalAgenda.exe',
      binariesDir: 'C:\\Games\\Global Agenda\\Binaries',
      rootDir: 'C:\\Games\\Global Agenda',
      configDir: 'C:\\Games\\Global Agenda\\TgGame\\Config'
    };
    serviceMocks.validateGameExe.mockResolvedValue(install);
    serviceMocks.clientInspect.mockResolvedValue({
      status: 'local',
      detail: 'Valid local x86 client patch DLL detected.',
      hasManagedMarker: false
    });
    const settings = defaultSettings();
    settings.gameExePath = install.exePath;
    settings.loginMap = 'LoginElvish_P.ut3';
    settings.developer.enabled = false;
    settings.developer.useLocalClientDll = false;
    settings.launch.closeAfterLaunch = false;
    const syncGameIniSettings = vi.fn(async () => settings);
    const config = {
      get: vi.fn(() => settings),
      update: vi.fn(async () => settings),
      syncGameIniSettings
    } as unknown as ConfigStore;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as unknown as Log;
    const updater = {
      getSnapshot: vi.fn(() => ({
        status: 'disabled',
        version: null,
        error: null,
        progress: null
      })),
      setEvents: vi.fn(),
      ensureCurrent: vi.fn()
    } as unknown as LauncherUpdater;
    const orchestrator = new Orchestrator(config, log, '127.0.0.1', '', updater);

    await orchestrator.localClientDllChanged(false);

    expect(orchestrator.getState()).toMatchObject({
      developerMode: false,
      gamePathValid: true,
      gameClientDll: { status: 'local' }
    });
    expect(serviceMocks.inspectGameIniSettings).not.toHaveBeenCalled();
    expect(serviceMocks.inspectClientPatches).not.toHaveBeenCalled();
    expect(syncGameIniSettings).not.toHaveBeenCalled();
    expect(settings.loginMap).toBe('LoginElvish_P.ut3');

    await orchestrator.play();

    expect(serviceMocks.ensureClientConfiguration.mock.calls.at(-1)?.[1]).toBe(
      'LoginElvish_P.ut3'
    );
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });
});

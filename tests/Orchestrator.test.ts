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
  }
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

    await orchestrator.refresh();

    expect(serviceMocks.applyIniClientPatch).toHaveBeenCalledTimes(2);
    expect(serviceMocks.clientPrepare).toHaveBeenCalledTimes(1);
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

    const child = serviceMocks.gameLaunch.mock.results[0].value as ChildProcess;
    child.emit('exit', 0, null);
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    expect(orchestrator.getState().activeGameInstances).toBe(0);
    await expect(orchestrator.selectGameProfile(profile.id)).resolves.toBeUndefined();
    expect(serviceMocks.profileSelect).toHaveBeenCalledWith(profile.id);
    vi.useRealTimers();
  });
});

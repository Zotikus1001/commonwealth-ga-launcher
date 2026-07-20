import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  validateGameExe: vi.fn(),
  applyIniClientPatch: vi.fn(),
  inspectClientPatches: vi.fn(),
  inspectGameIniSettings: vi.fn(),
  ensureClientConfiguration: vi.fn(),
  gpuSelect: vi.fn(),
  clientPrepare: vi.fn(),
  probeServer: vi.fn()
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
  removeClientPatch: vi.fn(),
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
  },
  unavailableDxvkState: () => ({
    status: 'native',
    version: '2.6.2',
    rendererSetting: 'unknown',
    detail: 'No valid game installation is available.',
    canRestore: false
  })
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
});

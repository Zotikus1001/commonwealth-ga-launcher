import { beforeEach, describe, expect, it, vi } from 'vitest';

type IpcHandler = (...args: unknown[]) => unknown;

const ipcMocks = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    })
  };
});

vi.mock('electron', () => ({
  app: {
    relaunch: vi.fn(),
    exit: vi.fn()
  },
  clipboard: {
    writeText: vi.fn()
  },
  dialog: {
    showOpenDialog: vi.fn()
  },
  ipcMain: {
    handle: ipcMocks.handle
  },
  shell: {
    openExternal: vi.fn(),
    openPath: vi.fn()
  }
}));

import { IPC } from '../src/shared/ipc';
import { defaultSettings, type ConfigStore } from '../src/main/services/ConfigStore';
import { registerIpc } from '../src/main/ipc';
import type { Orchestrator } from '../src/main/Orchestrator';
import type { Log } from '../src/main/services/Log';

beforeEach(() => {
  ipcMocks.handlers.clear();
  vi.clearAllMocks();
});

function registerSettingsHandler(previous: ReturnType<typeof defaultSettings>, updated: ReturnType<typeof defaultSettings>): {
  handler: IpcHandler;
  orchestrator: {
    developerModeChanged: ReturnType<typeof vi.fn>;
    localClientDllChanged: ReturnType<typeof vi.fn>;
    settingsChanged: ReturnType<typeof vi.fn>;
  };
} {
  const orchestrator = {
    setBroadcast: vi.fn(),
    developerModeChanged: vi.fn(),
    localClientDllChanged: vi.fn(),
    settingsChanged: vi.fn(),
    gameClientPatchChanged: vi.fn()
  };
  const config = {
    get: vi.fn(() => previous),
    update: vi.fn(async () => updated)
  };
  const log = {
    onLine: vi.fn()
  };

  registerIpc(
    () => null,
    orchestrator as unknown as Orchestrator,
    config as unknown as ConfigStore,
    log as unknown as Log
  );
  const handler = ipcMocks.handlers.get(IPC.updateSettings);
  if (!handler) throw new Error('Settings IPC handler was not registered');
  return { handler, orchestrator };
}

describe('settings IPC DEV transitions', () => {
  it('disables the local override without starting a full settings refresh', async () => {
    const previous = defaultSettings();
    previous.developer.enabled = true;
    previous.developer.useLocalClientDll = true;
    const updated = structuredClone(previous);
    updated.developer.enabled = false;
    updated.developer.useLocalClientDll = false;
    const { handler, orchestrator } = registerSettingsHandler(previous, updated);

    await handler(null, { developer: { enabled: false } });

    expect(orchestrator.localClientDllChanged).toHaveBeenCalledWith(false);
    expect(orchestrator.developerModeChanged).not.toHaveBeenCalled();
    expect(orchestrator.settingsChanged).not.toHaveBeenCalled();
  });

  it('updates Developer Mode metadata without starting a full settings refresh', async () => {
    const previous = defaultSettings();
    const updated = structuredClone(previous);
    updated.developer.enabled = true;
    const { handler, orchestrator } = registerSettingsHandler(previous, updated);

    await handler(null, { developer: { enabled: true } });

    expect(orchestrator.developerModeChanged).toHaveBeenCalledOnce();
    expect(orchestrator.localClientDllChanged).not.toHaveBeenCalled();
    expect(orchestrator.settingsChanged).not.toHaveBeenCalled();
  });
});

import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigStore,
  CURRENT_SETTINGS_SCHEMA_VERSION,
  defaultSettings,
  migrateStoredSettings
} from '../src/main/services/ConfigStore';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DXVK/Vulkan settings migration', () => {
  it('adds a disabled graphics option without changing existing developer settings', () => {
    const previous = defaultSettings();
    const schema9 = {
      ...previous,
      schemaVersion: 9,
      developer: {
        enabled: true,
        windowed: false,
        resolutionWidth: 1920,
        resolutionHeight: 1080
      }
    };
    const migrated = migrateStoredSettings(schema9).settings;

    expect(migrated.schemaVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(migrated.developer).toEqual({
      enabled: true,
      windowed: false,
      resolutionWidth: 1920,
      resolutionHeight: 1080,
      useDxvk: false,
      useLocalClientDll: false
    });
    expect(migrated.patches).toEqual({
      gameClientPatch: true,
      highFpsMovementStability: true,
      adaptiveClientPerformance: true
    });
  });

  it('enables release patches without changing existing developer settings', () => {
    const previous = defaultSettings();
    const schema10 = {
      ...previous,
      schemaVersion: 10,
      developer: {
        enabled: true,
        windowed: false,
        resolutionWidth: 1600,
        resolutionHeight: 900,
        useDxvk: true
      }
    };

    expect(migrateStoredSettings(schema10).settings.developer).toEqual({
      enabled: true,
      windowed: false,
      resolutionWidth: 1600,
      resolutionHeight: 900,
      useDxvk: true,
      useLocalClientDll: false
    });
    expect(migrateStoredSettings(schema10).settings.patches).toEqual({
      gameClientPatch: true,
      highFpsMovementStability: true,
      adaptiveClientPerformance: true
    });
  });

  it('adds disabled local client DLL mode without changing patch state', () => {
    const previous = defaultSettings();
    const {
      useLocalClientDll: _removedLocalClientDll,
      ...previousDeveloper
    } = previous.developer;
    const schema11 = {
      ...previous,
      schemaVersion: 11,
      developer: {
        ...previousDeveloper,
        enabled: true,
        useClientPatches: true
      }
    };

    expect(migrateStoredSettings(schema11).settings.developer).toEqual({
      enabled: true,
      windowed: schema11.developer.windowed,
      resolutionWidth: schema11.developer.resolutionWidth,
      resolutionHeight: schema11.developer.resolutionHeight,
      useDxvk: schema11.developer.useDxvk,
      useLocalClientDll: false
    });
    expect(migrateStoredSettings(schema11).settings.patches).toEqual({
      gameClientPatch: true,
      highFpsMovementStability: true,
      adaptiveClientPerformance: true
    });
  });

  it('clears legacy local DLL mode once so it must pass current validation', () => {
    const previous = defaultSettings();
    const schema13 = {
      ...previous,
      schemaVersion: 13,
      developer: {
        ...previous.developer,
        enabled: true,
        useLocalClientDll: true
      }
    };

    const migrated = migrateStoredSettings(schema13).settings;

    expect(migrated.schemaVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(migrated.developer).toMatchObject({
      enabled: true,
      useLocalClientDll: false
    });
  });

  it('defaults every optional game patch on', () => {
    expect(defaultSettings().patches).toEqual({
      gameClientPatch: true,
      highFpsMovementStability: true,
      adaptiveClientPerformance: true
    });
  });

  it('adds the default-enabled maps DLC when schema 14 settings are upgraded', () => {
    const current = defaultSettings();
    const { dlcs: _removedDlcs, ...schema14 } = {
      ...current,
      schemaVersion: 14
    };

    expect(migrateStoredSettings(schema14).settings).toMatchObject({
      schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
      dlcs: {
        surfsideAtollPvpMaps: true
      }
    });
  });

  it('defaults the maps DLC on', () => {
    expect(defaultSettings().dlcs).toEqual({
      surfsideAtollPvpMaps: true
    });
  });
});

describe('launcher settings reset', () => {
  it('overwrites future-schema settings with defaults and restores write access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commonwealth-config-reset-'));
    roots.push(root);
    const defaults = defaultSettings();
    const file = join(root, 'settings.json');
    await writeFile(
      file,
      JSON.stringify({
        ...defaults,
        schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION + 1,
        gameExePath: 'future-launcher-path'
      }),
      { encoding: 'utf-8' }
    );
    const store = new ConfigStore(root, defaults, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as never);

    await store.load();
    await expect(store.update({ gameExePath: 'blocked' })).rejects.toThrow('newer launcher');

    await expect(store.resetToDefaults()).resolves.toEqual(defaults);
    expect(JSON.parse(await readFile(file, { encoding: 'utf-8' }))).toEqual(defaults);
    await expect(store.update({ gameExePath: 'new-path' })).resolves.toMatchObject({
      gameExePath: 'new-path'
    });
  });
});

describe('game patch settings', () => {
  it('persists independent patch opt-outs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commonwealth-config-patches-'));
    roots.push(root);
    const defaults = defaultSettings();
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as never;
    const store = new ConfigStore(root, defaults, log);

    await store.load();
    await store.update({
      patches: {
        gameClientPatch: false,
        adaptiveClientPerformance: false
      },
      dlcs: {
        surfsideAtollPvpMaps: false
      }
    });

    const reloaded = new ConfigStore(root, defaults, log);
    await expect(reloaded.load()).resolves.toMatchObject({
      patches: {
        gameClientPatch: false,
        highFpsMovementStability: true,
        adaptiveClientPerformance: false
      },
      dlcs: {
        surfsideAtollPvpMaps: false
      }
    });
  });

  it('cannot leave local DLL mode enabled after Developer Mode is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commonwealth-config-local-dll-'));
    roots.push(root);
    const defaults = defaultSettings();
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as never;
    const store = new ConfigStore(root, defaults, log);

    await store.load();
    await store.update({
      developer: {
        enabled: true,
        useLocalClientDll: true
      }
    });
    await expect(store.update({ developer: { enabled: false } })).resolves.toMatchObject({
      developer: {
        enabled: false,
        useLocalClientDll: false
      }
    });
  });
});

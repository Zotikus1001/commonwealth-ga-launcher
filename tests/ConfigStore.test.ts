import { describe, expect, it } from 'vitest';
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  defaultSettings,
  migrateStoredSettings
} from '../src/main/services/ConfigStore';

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
      useClientPatches: false,
      useLocalClientDll: false
    });
  });

  it('adds disabled experimental client patches without changing existing settings', () => {
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
      useClientPatches: false,
      useLocalClientDll: false
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
      ...schema11.developer,
      useLocalClientDll: false
    });
  });
});

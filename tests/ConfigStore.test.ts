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
      useDxvk: false
    });
  });
});

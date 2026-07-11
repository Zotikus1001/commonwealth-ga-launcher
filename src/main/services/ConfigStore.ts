import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { DeepPartial, DeveloperServer, Settings } from '@shared/types';
import { DEFAULT_LOGIN_MAP, isLoginMap } from '@shared/loginMaps';
import {
  DEFAULT_FPS_LIMIT,
  isFpsLimit,
  MAX_FPS_LIMIT,
  MIN_FPS_LIMIT
} from '@shared/fpsLimit';
import {
  DEFAULT_SERVER_ID,
  isDeveloperResolution,
  validateDeveloperServers
} from '@shared/serverProfiles';
import type { Log } from './Log';

export const CURRENT_SETTINGS_SCHEMA_VERSION = 4;

export class UnsupportedSettingsVersionError extends Error {}

export function migrateStoredSettings(value: unknown): {
  settings: Record<string, unknown>;
  migrated: boolean;
} {
  if (!isPlainObject(value)) throw new Error('Settings root must be an object.');
  const rawVersion = value.schemaVersion ?? 1;
  if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion)) {
    throw new Error('Settings schema version is invalid.');
  }
  if (rawVersion < 1 || rawVersion > CURRENT_SETTINGS_SCHEMA_VERSION) {
    throw new UnsupportedSettingsVersionError(`Unsupported settings schema: ${rawVersion}`);
  }

  let version = rawVersion;
  let settings = { ...value };
  let migrated = value.schemaVersion === undefined;
  while (version < CURRENT_SETTINGS_SCHEMA_VERSION) {
    switch (version) {
      case 1:
        settings = { ...settings, schemaVersion: 2 };
        version = 2;
        migrated = true;
        break;
      case 2: {
        const launch = isPlainObject(settings.launch) ? settings.launch : {};
        settings = {
          ...settings,
          schemaVersion: 3,
          launch: {
            ...launch,
            closeAfterLaunch:
              typeof launch.closeAfterLaunch === 'boolean' ? launch.closeAfterLaunch : true
          }
        };
        version = 3;
        migrated = true;
        break;
      }
      case 3: {
        const fpsLimit = isPlainObject(settings.fpsLimit) ? settings.fpsLimit : {};
        settings = {
          ...settings,
          schemaVersion: 4,
          fpsLimit: {
            enabled: typeof fpsLimit.enabled === 'boolean' ? fpsLimit.enabled : false,
            value: isFpsLimit(fpsLimit.value) ? fpsLimit.value : DEFAULT_FPS_LIMIT
          }
        };
        version = 4;
        migrated = true;
        break;
      }
      default:
        throw new UnsupportedSettingsVersionError(`No migration from settings schema ${version}`);
    }
  }
  return { settings, migrated };
}

export function defaultSettings(): Settings {
  return {
    schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    gameExePath: '',
    loginMap: DEFAULT_LOGIN_MAP,
    showOverhealing: false,
    fpsLimit: {
      enabled: false,
      value: DEFAULT_FPS_LIMIT
    },
    launch: {
      closeAfterLaunch: true,
      gpuAdapter: 0,
      noStartupMovies: false,
      noSplash: false,
      extraArgs: ''
    },
    linux: {
      winePath: '',
      winePrefix: join(homedir(), '.local', 'share', 'commonwealth-ga', 'prefix'),
      wineDebug: false
    },
    developer: {
      enabled: false,
      selectedServerId: DEFAULT_SERVER_ID,
      servers: [],
      windowed: true,
      resolutionWidth: 1280,
      resolutionHeight: 720
    }
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Merge stored/patch values over defaults; unknown keys are dropped (schema is the defaults shape).
function mergeInto<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch) || !isPlainObject(base)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(base as Record<string, unknown>)) {
    if (!(key in patch)) continue;
    const bv = (base as Record<string, unknown>)[key];
    const pv = patch[key];
    if (isPlainObject(bv)) {
      out[key] = mergeInto(bv, pv);
    } else if (pv !== undefined) {
      out[key] = pv;
    }
  }
  return out as T;
}

function normalizeServer(server: DeveloperServer): DeveloperServer {
  return {
    id: server.id.trim(),
    name: server.name.trim(),
    host: server.host.trim()
  };
}

function sanitizeStoredDeveloper(value: unknown, fallback: Settings['developer']): Settings['developer'] {
  if (!isPlainObject(value)) return structuredClone(fallback);
  const servers: DeveloperServer[] = [];
  if (Array.isArray(value.servers)) {
    for (const item of value.servers) {
      if (!isPlainObject(item)) continue;
      if (
        typeof item.id !== 'string' ||
        typeof item.name !== 'string' ||
        typeof item.host !== 'string'
      ) {
        continue;
      }
      const candidate = normalizeServer(item as unknown as DeveloperServer);
      if (validateDeveloperServers([...servers, candidate]) === null) servers.push(candidate);
    }
  }
  const requestedId =
    typeof value.selectedServerId === 'string' ? value.selectedServerId : DEFAULT_SERVER_ID;
  const selectedServerId = servers.some((server) => server.id === requestedId)
    ? requestedId
    : DEFAULT_SERVER_ID;
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : false,
    selectedServerId,
    servers,
    windowed: typeof value.windowed === 'boolean' ? value.windowed : fallback.windowed,
    resolutionWidth: isDeveloperResolution(value.resolutionWidth, value.resolutionHeight)
      ? (value.resolutionWidth as number)
      : fallback.resolutionWidth,
    resolutionHeight: isDeveloperResolution(value.resolutionWidth, value.resolutionHeight)
      ? (value.resolutionHeight as number)
      : fallback.resolutionHeight
  };
}

function validateUpdatedDeveloper(value: unknown): Settings['developer'] {
  if (!isPlainObject(value)) throw new Error('Developer settings are invalid.');
  if (
    typeof value.enabled !== 'boolean' ||
    typeof value.selectedServerId !== 'string' ||
    typeof value.windowed !== 'boolean'
  ) {
    throw new Error('Developer mode state is invalid.');
  }
  if (!isDeveloperResolution(value.resolutionWidth, value.resolutionHeight)) {
    throw new Error('Developer launch resolution is invalid.');
  }
  const error = validateDeveloperServers(value.servers);
  if (error) throw new Error(error);
  const servers = (value.servers as DeveloperServer[]).map(normalizeServer);
  const selectedServerId = servers.some((server) => server.id === value.selectedServerId)
    ? value.selectedServerId
    : DEFAULT_SERVER_ID;
  return {
    enabled: value.enabled,
    selectedServerId,
    servers,
    windowed: value.windowed,
    resolutionWidth: value.resolutionWidth as number,
    resolutionHeight: value.resolutionHeight as number
  };
}

function sanitizeStoredFpsLimit(
  value: unknown,
  fallback: Settings['fpsLimit']
): Settings['fpsLimit'] {
  if (!isPlainObject(value)) return structuredClone(fallback);
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : fallback.enabled,
    value: isFpsLimit(value.value) ? value.value : fallback.value
  };
}

function validateUpdatedFpsLimit(value: unknown): Settings['fpsLimit'] {
  if (!isPlainObject(value) || typeof value.enabled !== 'boolean' || !isFpsLimit(value.value)) {
    throw new Error(`FPS limit must be a whole number from ${MIN_FPS_LIMIT} to ${MAX_FPS_LIMIT}.`);
  }
  return { enabled: value.enabled, value: value.value };
}

// JSON settings in userData/settings.json, merged over defaults, saved atomically (tmp + rename).
export class ConfigStore {
  private readonly file: string;
  private settings: Settings;

  constructor(
    userDataDir: string,
    private readonly defaults: Settings,
    private readonly log: Log
  ) {
    this.file = join(userDataDir, 'settings.json');
    this.settings = structuredClone(defaults);
  }

  async load(): Promise<Settings> {
    let raw: string;
    try {
      raw = await readFile(this.file, { encoding: 'utf-8' });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') this.log.warn(`settings read failed (${err.message}); using defaults`);
      this.settings = structuredClone(this.defaults);
      return this.settings;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      await this.recoverInvalidSettings('corrupt', (error as Error).message);
      return this.settings;
    }

    let migrated: ReturnType<typeof migrateStoredSettings>;
    try {
      migrated = migrateStoredSettings(parsed);
    } catch (error) {
      const reason = error instanceof UnsupportedSettingsVersionError ? 'incompatible' : 'corrupt';
      await this.recoverInvalidSettings(reason, (error as Error).message);
      return this.settings;
    }

    this.settings = mergeInto(structuredClone(this.defaults), migrated.settings);
    this.settings.schemaVersion = CURRENT_SETTINGS_SCHEMA_VERSION;
    this.settings.developer = sanitizeStoredDeveloper(
      this.settings.developer,
      this.defaults.developer
    );
    this.settings.fpsLimit = sanitizeStoredFpsLimit(
      this.settings.fpsLimit,
      this.defaults.fpsLimit
    );
    if (!isLoginMap(this.settings.loginMap)) this.settings.loginMap = this.defaults.loginMap;
    if (typeof this.settings.showOverhealing !== 'boolean') {
      this.settings.showOverhealing = this.defaults.showOverhealing;
    }
    if (typeof this.settings.launch.closeAfterLaunch !== 'boolean') {
      this.settings.launch.closeAfterLaunch = this.defaults.launch.closeAfterLaunch;
    }

    const repaired = JSON.stringify(this.settings) !== JSON.stringify(migrated.settings);
    if (migrated.migrated || repaired) {
      try {
        await this.save();
        this.log.info(`settings upgraded to schema ${CURRENT_SETTINGS_SCHEMA_VERSION}`);
      } catch (error) {
        this.log.warn(`settings upgrade could not be saved: ${(error as Error).message}`);
      }
    }
    this.log.info(`settings loaded from ${this.file}`);
    return this.settings;
  }

  get(): Settings {
    return this.settings;
  }

  async update(patch: DeepPartial<Settings>): Promise<Settings> {
    const next = mergeInto(this.settings, patch);
    next.schemaVersion = CURRENT_SETTINGS_SCHEMA_VERSION;
    next.developer = validateUpdatedDeveloper(next.developer);
    next.fpsLimit = validateUpdatedFpsLimit(next.fpsLimit);
    if (!isLoginMap(next.loginMap)) next.loginMap = this.defaults.loginMap;
    if (typeof next.showOverhealing !== 'boolean') {
      next.showOverhealing = this.defaults.showOverhealing;
    }
    if (typeof next.launch.closeAfterLaunch !== 'boolean') {
      next.launch.closeAfterLaunch = this.defaults.launch.closeAfterLaunch;
    }
    this.settings = next;
    await this.save();
    return this.settings;
  }

  private async recoverInvalidSettings(reason: string, details: string): Promise<void> {
    this.log.warn(`settings ${reason} (${details}); using defaults`);
    this.settings = structuredClone(this.defaults);
    const backup = join(dirname(this.file), `settings.${reason}-${Date.now()}.json`);
    try {
      await rename(this.file, backup);
      await this.save();
      this.log.info(`previous settings preserved as ${backup}`);
    } catch (error) {
      this.log.warn(`settings recovery could not be persisted: ${(error as Error).message}`);
    }
  }

  private async save(): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      await writeFile(tmp, JSON.stringify(this.settings, null, 2), { encoding: 'utf-8' });
      await rename(tmp, this.file);
    } catch (e) {
      this.log.error(`settings save failed: ${(e as Error).message}`);
      throw e;
    }
  }
}

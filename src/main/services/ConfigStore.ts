import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type {
  CustomServer,
  DeepPartial,
  GameIniBaseline,
  GameIniSettings,
  Settings
} from '@shared/types';
import { DEFAULT_LOGIN_MAP, isLoginMap } from '@shared/loginMaps';
import {
  DEFAULT_FPS_LIMIT,
  isFpsLimit,
  MAX_FPS_LIMIT,
  MIN_FPS_LIMIT
} from '@shared/fpsLimit';
import {
  DEFAULT_BUILT_IN_SERVER_NAME,
  DEFAULT_SERVER_ID,
  isValidServerName,
  isDeveloperResolution,
  validateServerSettings
} from '@shared/serverProfiles';
import { DEFAULT_UI_SCALE, isUiScale } from '@shared/uiScale';
import type { Log } from './Log';

export const CURRENT_SETTINGS_SCHEMA_VERSION = 13;

export class UnsupportedSettingsVersionError extends Error {}

export class FutureSettingsVersionError extends UnsupportedSettingsVersionError {
  constructor(readonly version: number) {
    super(`Settings schema ${version} requires a newer launcher.`);
    this.name = 'FutureSettingsVersionError';
  }
}

export function migrateStoredSettings(
  value: unknown,
  defaultServerName = DEFAULT_BUILT_IN_SERVER_NAME
): {
  settings: Record<string, unknown>;
  migrated: boolean;
} {
  if (!isPlainObject(value)) throw new Error('Settings root must be an object.');
  const rawVersion = value.schemaVersion ?? 1;
  if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion)) {
    throw new Error('Settings schema version is invalid.');
  }
  if (rawVersion < 1) {
    throw new UnsupportedSettingsVersionError(`Unsupported settings schema: ${rawVersion}`);
  }
  if (rawVersion > CURRENT_SETTINGS_SCHEMA_VERSION) {
    throw new FutureSettingsVersionError(rawVersion);
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
      case 4:
        settings = {
          ...settings,
          schemaVersion: 5,
          uiScale: isUiScale(settings.uiScale) ? settings.uiScale : DEFAULT_UI_SCALE
        };
        version = 5;
        migrated = true;
        break;
      case 5: {
        const developer = isPlainObject(settings.developer) ? settings.developer : {};
        settings = {
          ...settings,
          schemaVersion: 6,
          servers: {
            builtInName: defaultServerName,
            selectedServerId:
              typeof developer.selectedServerId === 'string'
                ? developer.selectedServerId
                : DEFAULT_SERVER_ID,
            custom: Array.isArray(developer.servers) ? developer.servers : []
          }
        };
        version = 6;
        migrated = true;
        break;
      }
      case 6:
        settings = {
          ...settings,
          schemaVersion: 7,
          gameIniBaseline: emptyGameIniBaseline()
        };
        version = 7;
        migrated = true;
        break;
      case 7: {
        const servers = isPlainObject(settings.servers) ? settings.servers : {};
        settings = {
          ...settings,
          schemaVersion: 8,
          servers: {
            ...servers,
            builtInName:
              servers.builtInName === 'CommonWealth'
                ? defaultServerName
                : servers.builtInName
          }
        };
        version = 8;
        migrated = true;
        break;
      }
      case 8: {
        const linux = isPlainObject(settings.linux) ? settings.linux : {};
        settings = {
          ...settings,
          schemaVersion: 9,
          linux: {
            ...linux,
            runner: 'wine',
            protonPath: '',
            umuPath: '',
            gameMode: false
          }
        };
        version = 9;
        migrated = true;
        break;
      }
      case 9: {
        const developer = isPlainObject(settings.developer) ? settings.developer : {};
        settings = {
          ...settings,
          schemaVersion: 10,
          developer: {
            ...developer,
            useDxvk: false
          }
        };
        version = 10;
        migrated = true;
        break;
      }
      case 10: {
        const developer = isPlainObject(settings.developer) ? settings.developer : {};
        settings = {
          ...settings,
          schemaVersion: 11,
          developer: {
            ...developer,
            useClientPatches: false
          }
        };
        version = 11;
        migrated = true;
        break;
      }
      case 11: {
        const developer = isPlainObject(settings.developer) ? settings.developer : {};
        settings = {
          ...settings,
          schemaVersion: 12,
          developer: {
            ...developer,
            useLocalClientDll: false
          }
        };
        version = 12;
        migrated = true;
        break;
      }
      case 12: {
        const developer = isPlainObject(settings.developer) ? settings.developer : {};
        const remainingDeveloper = { ...developer };
        delete remainingDeveloper.useClientPatches;
        settings = {
          ...settings,
          schemaVersion: 13,
          patches: {
            gameClientPatch: true,
            highFpsMovementStability: true,
            adaptiveClientPerformance: true
          },
          developer: remainingDeveloper
        };
        version = 13;
        migrated = true;
        break;
      }
      default:
        throw new UnsupportedSettingsVersionError(`No migration from settings schema ${version}`);
    }
  }
  return { settings, migrated };
}

export function defaultSettings(defaultServerName = DEFAULT_BUILT_IN_SERVER_NAME): Settings {
  const builtInName = isValidServerName(defaultServerName)
    ? defaultServerName.trim()
    : DEFAULT_BUILT_IN_SERVER_NAME;
  return {
    schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    uiScale: DEFAULT_UI_SCALE,
    gameExePath: '',
    loginMap: DEFAULT_LOGIN_MAP,
    showOverhealing: false,
    fpsLimit: {
      enabled: false,
      value: DEFAULT_FPS_LIMIT
    },
    gameIniBaseline: emptyGameIniBaseline(),
    patches: {
      gameClientPatch: true,
      highFpsMovementStability: true,
      adaptiveClientPerformance: true
    },
    servers: {
      builtInName,
      selectedServerId: DEFAULT_SERVER_ID,
      custom: []
    },
    launch: {
      closeAfterLaunch: true,
      gpuAdapter: 0,
      noStartupMovies: false,
      noSplash: false,
      extraArgs: ''
    },
    linux: {
      runner: 'wine',
      winePath: '',
      protonPath: '',
      umuPath: '',
      winePrefix: join(homedir(), '.local', 'share', 'commonwealth-ga', 'prefix'),
      gameMode: false,
      wineDebug: false
    },
    developer: {
      enabled: false,
      windowed: true,
      resolutionWidth: 1280,
      resolutionHeight: 720,
      useDxvk: false,
      useLocalClientDll: false
    }
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function emptyGameIniBaseline(gameExePath = ''): GameIniBaseline {
  return {
    gameExePath,
    loginMap: null,
    showOverhealing: null,
    fpsLimit: {
      enabled: null,
      value: null
    }
  };
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

function normalizeServer(server: CustomServer): CustomServer {
  return {
    id: server.id.trim(),
    name: server.name.trim(),
    host: server.host.trim()
  };
}

function sanitizeStoredServers(
  value: unknown,
  fallback: Settings['servers']
): Settings['servers'] {
  if (!isPlainObject(value)) return structuredClone(fallback);
  const builtInName = isValidServerName(value.builtInName)
    ? value.builtInName.trim()
    : fallback.builtInName;
  const custom: CustomServer[] = [];
  if (Array.isArray(value.custom)) {
    for (const item of value.custom) {
      if (!isPlainObject(item)) continue;
      if (
        typeof item.id !== 'string' ||
        typeof item.name !== 'string' ||
        typeof item.host !== 'string'
      ) {
        continue;
      }
      const candidate = normalizeServer(item as unknown as CustomServer);
      if (validateServerSettings(builtInName, [...custom, candidate]) === null) {
        custom.push(candidate);
      }
    }
  }
  const requestedId =
    typeof value.selectedServerId === 'string' ? value.selectedServerId : DEFAULT_SERVER_ID;
  return {
    builtInName,
    selectedServerId: custom.some((server) => server.id === requestedId)
      ? requestedId
      : DEFAULT_SERVER_ID,
    custom
  };
}

function validateUpdatedServers(value: unknown): Settings['servers'] {
  if (!isPlainObject(value) || typeof value.selectedServerId !== 'string') {
    throw new Error('Server settings are invalid.');
  }
  const error = validateServerSettings(value.builtInName, value.custom);
  if (error) throw new Error(error);
  const builtInName = (value.builtInName as string).trim();
  const custom = (value.custom as CustomServer[]).map(normalizeServer);
  return {
    builtInName,
    selectedServerId: custom.some((server) => server.id === value.selectedServerId)
      ? value.selectedServerId
      : DEFAULT_SERVER_ID,
    custom
  };
}

function sanitizeStoredDeveloper(value: unknown, fallback: Settings['developer']): Settings['developer'] {
  if (!isPlainObject(value)) return structuredClone(fallback);
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : false,
    windowed: typeof value.windowed === 'boolean' ? value.windowed : fallback.windowed,
    resolutionWidth: isDeveloperResolution(value.resolutionWidth, value.resolutionHeight)
      ? (value.resolutionWidth as number)
      : fallback.resolutionWidth,
    resolutionHeight: isDeveloperResolution(value.resolutionWidth, value.resolutionHeight)
      ? (value.resolutionHeight as number)
      : fallback.resolutionHeight,
    useDxvk: typeof value.useDxvk === 'boolean' ? value.useDxvk : fallback.useDxvk,
    useLocalClientDll:
      typeof value.useLocalClientDll === 'boolean'
        ? value.useLocalClientDll
        : fallback.useLocalClientDll
  };
}

function validateUpdatedDeveloper(value: unknown): Settings['developer'] {
  if (!isPlainObject(value)) throw new Error('Developer settings are invalid.');
  if (
    typeof value.enabled !== 'boolean' ||
    typeof value.windowed !== 'boolean' ||
    typeof value.useDxvk !== 'boolean' ||
    typeof value.useLocalClientDll !== 'boolean'
  ) {
    throw new Error('Developer mode state is invalid.');
  }
  if (!isDeveloperResolution(value.resolutionWidth, value.resolutionHeight)) {
    throw new Error('Developer launch resolution is invalid.');
  }
  return {
    enabled: value.enabled,
    windowed: value.windowed,
    resolutionWidth: value.resolutionWidth as number,
    resolutionHeight: value.resolutionHeight as number,
    useDxvk: value.useDxvk,
    useLocalClientDll: value.useLocalClientDll
  };
}

function sanitizeStoredPatches(value: unknown, fallback: Settings['patches']): Settings['patches'] {
  if (!isPlainObject(value)) return structuredClone(fallback);
  return {
    gameClientPatch:
      typeof value.gameClientPatch === 'boolean'
        ? value.gameClientPatch
        : fallback.gameClientPatch,
    highFpsMovementStability:
      typeof value.highFpsMovementStability === 'boolean'
        ? value.highFpsMovementStability
        : fallback.highFpsMovementStability,
    adaptiveClientPerformance:
      typeof value.adaptiveClientPerformance === 'boolean'
        ? value.adaptiveClientPerformance
        : fallback.adaptiveClientPerformance
  };
}

function validateUpdatedPatches(value: unknown): Settings['patches'] {
  if (
    !isPlainObject(value) ||
    typeof value.gameClientPatch !== 'boolean' ||
    typeof value.highFpsMovementStability !== 'boolean' ||
    typeof value.adaptiveClientPerformance !== 'boolean'
  ) {
    throw new Error('Game patch settings are invalid.');
  }
  return {
    gameClientPatch: value.gameClientPatch,
    highFpsMovementStability: value.highFpsMovementStability,
    adaptiveClientPerformance: value.adaptiveClientPerformance
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

function sanitizeStoredLinux(value: unknown, fallback: Settings['linux']): Settings['linux'] {
  if (!isPlainObject(value)) return structuredClone(fallback);
  return {
    runner: value.runner === 'wine' || value.runner === 'proton' ? value.runner : fallback.runner,
    winePath: typeof value.winePath === 'string' ? value.winePath : fallback.winePath,
    protonPath: typeof value.protonPath === 'string' ? value.protonPath : fallback.protonPath,
    umuPath: typeof value.umuPath === 'string' ? value.umuPath : fallback.umuPath,
    winePrefix: typeof value.winePrefix === 'string' ? value.winePrefix : fallback.winePrefix,
    gameMode: typeof value.gameMode === 'boolean' ? value.gameMode : fallback.gameMode,
    wineDebug: typeof value.wineDebug === 'boolean' ? value.wineDebug : fallback.wineDebug
  };
}

function validateUpdatedLinux(value: unknown): Settings['linux'] {
  if (!isPlainObject(value) || (value.runner !== 'wine' && value.runner !== 'proton')) {
    throw new Error('Linux compatibility mode is invalid.');
  }
  for (const key of ['winePath', 'protonPath', 'umuPath', 'winePrefix'] as const) {
    if (typeof value[key] !== 'string') throw new Error(`Linux ${key} is invalid.`);
  }
  if (typeof value.gameMode !== 'boolean' || typeof value.wineDebug !== 'boolean') {
    throw new Error('Linux compatibility options are invalid.');
  }
  return {
    runner: value.runner,
    winePath: value.winePath as string,
    protonPath: value.protonPath as string,
    umuPath: value.umuPath as string,
    winePrefix: value.winePrefix as string,
    gameMode: value.gameMode,
    wineDebug: value.wineDebug
  };
}

function sanitizeStoredGameIniBaseline(
  value: unknown,
  fallback: GameIniBaseline
): GameIniBaseline {
  if (!isPlainObject(value)) return structuredClone(fallback);
  const fpsLimit = isPlainObject(value.fpsLimit) ? value.fpsLimit : {};
  return {
    gameExePath: typeof value.gameExePath === 'string' ? value.gameExePath : fallback.gameExePath,
    loginMap: value.loginMap === null || isLoginMap(value.loginMap) ? value.loginMap : null,
    showOverhealing:
      value.showOverhealing === null || typeof value.showOverhealing === 'boolean'
        ? value.showOverhealing
        : null,
    fpsLimit: {
      enabled:
        fpsLimit.enabled === null || typeof fpsLimit.enabled === 'boolean'
          ? fpsLimit.enabled
          : null,
      value: fpsLimit.value === null || isFpsLimit(fpsLimit.value) ? fpsLimit.value : null
    }
  };
}

function sameGamePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function reconcileIniValue<T extends string | number | boolean>(
  current: T,
  baseline: T | null,
  observed: T | null,
  sameSource: boolean
): T {
  if (observed === null) return current;
  if (!sameSource || baseline === null || current === baseline) return observed;
  return current;
}

// JSON settings in userData/settings.json, merged over defaults, saved atomically (tmp + rename).
export class ConfigStore {
  private readonly file: string;
  private settings: Settings;
  private readOnlyReason: string | null = null;

  constructor(
    userDataDir: string,
    private readonly defaults: Settings,
    private readonly log: Log
  ) {
    this.file = join(userDataDir, 'settings.json');
    this.settings = structuredClone(defaults);
  }

  async load(): Promise<Settings> {
    this.readOnlyReason = null;
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
      migrated = migrateStoredSettings(parsed, this.defaults.servers.builtInName);
    } catch (error) {
      if (error instanceof FutureSettingsVersionError) {
        this.readOnlyReason =
          `Settings were created by a newer launcher (schema ${error.version}). ` +
          'Update the launcher before changing them.';
        this.log.warn(
          `settings schema ${error.version} is newer than supported schema ` +
            `${CURRENT_SETTINGS_SCHEMA_VERSION}; preserving ${this.file} unchanged`
        );
        this.settings = structuredClone(this.defaults);
        return this.settings;
      }
      const reason = error instanceof UnsupportedSettingsVersionError ? 'incompatible' : 'corrupt';
      await this.recoverInvalidSettings(reason, (error as Error).message);
      return this.settings;
    }

    this.settings = mergeInto(structuredClone(this.defaults), migrated.settings);
    this.settings.schemaVersion = CURRENT_SETTINGS_SCHEMA_VERSION;
    this.settings.servers = sanitizeStoredServers(
      this.settings.servers,
      this.defaults.servers
    );
    this.settings.developer = sanitizeStoredDeveloper(
      this.settings.developer,
      this.defaults.developer
    );
    this.settings.patches = sanitizeStoredPatches(this.settings.patches, this.defaults.patches);
    this.settings.fpsLimit = sanitizeStoredFpsLimit(
      this.settings.fpsLimit,
      this.defaults.fpsLimit
    );
    this.settings.gameIniBaseline = sanitizeStoredGameIniBaseline(
      this.settings.gameIniBaseline,
      this.defaults.gameIniBaseline
    );
    this.settings.linux = sanitizeStoredLinux(this.settings.linux, this.defaults.linux);
    if (!isUiScale(this.settings.uiScale)) this.settings.uiScale = this.defaults.uiScale;
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

  async resetToDefaults(): Promise<Settings> {
    const next = structuredClone(this.defaults);
    await this.save(next);
    this.settings = next;
    this.readOnlyReason = null;
    this.log.info('launcher settings reset to defaults');
    return this.settings;
  }

  async update(patch: DeepPartial<Settings>): Promise<Settings> {
    if (this.readOnlyReason) throw new Error(this.readOnlyReason);
    const next = mergeInto(this.settings, patch);
    next.schemaVersion = CURRENT_SETTINGS_SCHEMA_VERSION;
    next.gameIniBaseline = structuredClone(this.settings.gameIniBaseline);
    next.servers = validateUpdatedServers(next.servers);
    next.developer = validateUpdatedDeveloper(next.developer);
    next.patches = validateUpdatedPatches(next.patches);
    next.fpsLimit = validateUpdatedFpsLimit(next.fpsLimit);
    next.linux = validateUpdatedLinux(next.linux);
    if (!isUiScale(next.uiScale)) throw new Error('Launcher UI scale is invalid.');
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

  async syncGameIniSettings(
    gameExePath: string,
    observed: GameIniSettings
  ): Promise<Settings> {
    if (this.readOnlyReason) return this.settings;

    const current = this.settings;
    const previous = current.gameIniBaseline;
    const sameSource = sameGamePath(previous.gameExePath, gameExePath);
    const baseline = sameSource
      ? structuredClone(previous)
      : emptyGameIniBaseline(gameExePath);
    const next = structuredClone(current);

    next.loginMap = reconcileIniValue(
      current.loginMap,
      previous.loginMap,
      observed.loginMap,
      sameSource
    );
    next.showOverhealing = reconcileIniValue(
      current.showOverhealing,
      previous.showOverhealing,
      observed.showOverhealing,
      sameSource
    );
    next.fpsLimit.enabled = reconcileIniValue(
      current.fpsLimit.enabled,
      previous.fpsLimit.enabled,
      observed.fpsLimit.enabled,
      sameSource
    );
    next.fpsLimit.value = reconcileIniValue(
      current.fpsLimit.value,
      previous.fpsLimit.value,
      observed.fpsLimit.value,
      sameSource
    );

    baseline.gameExePath = gameExePath;
    if (observed.loginMap !== null) baseline.loginMap = observed.loginMap;
    if (observed.showOverhealing !== null) {
      baseline.showOverhealing = observed.showOverhealing;
    }
    if (observed.fpsLimit.enabled !== null) {
      baseline.fpsLimit.enabled = observed.fpsLimit.enabled;
    }
    if (observed.fpsLimit.value !== null) {
      baseline.fpsLimit.value = observed.fpsLimit.value;
    }
    next.gameIniBaseline = baseline;

    if (JSON.stringify(next) === JSON.stringify(current)) return current;
    this.settings = next;
    await this.save();
    this.log.info('launcher settings synchronized with active game INIs');
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

  private async save(settings = this.settings): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      await writeFile(tmp, JSON.stringify(settings, null, 2), { encoding: 'utf-8' });
      await rename(tmp, this.file);
    } catch (e) {
      this.log.error(`settings save failed: ${(e as Error).message}`);
      throw e;
    }
  }
}

const { readFileSync } = require('fs');
const { isIP } = require('net');
const { resolve } = require('path');

const CONFIG_KEYS = new Set([
  'default_server_host',
  'fallback_server_host',
  'default_server_name',
  'agenda_stats_url',
  'agenda_stats_status_url',
  'discord_invite_url',
  'steam_store_url',
  'steam_install_url',
  'stable_branch',
  'update_repositories',
  'server_history_repository',
  'server_history_branch',
  'server_history_count',
  'windows_installer_name',
  'linux_appimage_name',
  'dxvk_version',
  'dxvk_archive_url',
  'dxvk_archive_sha256',
  'dxvk_d3d9_sha256',
  'client_patch_revision',
  'client_patch_url',
  'client_patch_size',
  'client_patch_sha256',
  'surfside_atoll_dlc_url',
  'surfside_atoll_dlc_archive_size',
  'surfside_atoll_dlc_archive_sha256',
  'surfside_atoll_dlc_beachhead_package_size',
  'surfside_atoll_dlc_beachhead_package_sha256',
  'surfside_atoll_dlc_beachhead_sound_size',
  'surfside_atoll_dlc_beachhead_sound_sha256',
  'surfside_atoll_dlc_beachhead2_package_size',
  'surfside_atoll_dlc_beachhead2_package_sha256',
  'surfside_atoll_dlc_beachhead2_sound_size',
  'surfside_atoll_dlc_beachhead2_sound_sha256',
  'carbon_capture_dlc_url',
  'carbon_capture_dlc_archive_size',
  'carbon_capture_dlc_archive_sha256',
  'carbon_capture_dlc_map_size',
  'carbon_capture_dlc_map_sha256',
  'pve_factory_3_4_dlc_url',
  'pve_factory_3_4_dlc_archive_size',
  'pve_factory_3_4_dlc_archive_sha256',
  'pve_factory_3_4_dlc_factory04_package_size',
  'pve_factory_3_4_dlc_factory04_package_sha256',
  'pve_factory_3_4_dlc_factory04_sound_size',
  'pve_factory_3_4_dlc_factory04_sound_sha256',
  'pve_factory_3_4_dlc_factory03_package_size',
  'pve_factory_3_4_dlc_factory03_package_sha256',
  'pve_factory_3_4_dlc_factory03_sound_size',
  'pve_factory_3_4_dlc_factory03_sound_sha256',
  'pve_factory_3_4_dlc_sound_environment_size',
  'pve_factory_3_4_dlc_sound_environment_sha256',
  'pve_factory_3_4_dlc_mining_interior_size',
  'pve_factory_3_4_dlc_mining_interior_sha256',
  'pve_factory_3_4_dlc_general_piping_size',
  'pve_factory_3_4_dlc_general_piping_sha256',
  'pve_factory_3_4_dlc_commonwealth_props_size',
  'pve_factory_3_4_dlc_commonwealth_props_sha256',
  'pve_factory_3_4_dlc_factory_wallsets_size',
  'pve_factory_3_4_dlc_factory_wallsets_sha256',
  'pve_factory_3_4_dlc_factory_exterior_size',
  'pve_factory_3_4_dlc_factory_exterior_sha256',
  'pve_factory_3_4_dlc_factory_conveyor_size',
  'pve_factory_3_4_dlc_factory_conveyor_sha256',
  'pve_factory_3_4_dlc_shader_worker_size',
  'pve_factory_3_4_dlc_shader_worker_sha256',
  'pve_factory_3_4_dlc_backup_sound_environment_size',
  'pve_factory_3_4_dlc_backup_sound_environment_sha256',
  'pve_factory_3_4_dlc_backup_mining_interior_size',
  'pve_factory_3_4_dlc_backup_mining_interior_sha256',
  'pve_factory_3_4_dlc_backup_general_piping_size',
  'pve_factory_3_4_dlc_backup_general_piping_sha256',
  'pve_factory_3_4_dlc_backup_commonwealth_props_size',
  'pve_factory_3_4_dlc_backup_commonwealth_props_sha256',
  'pve_factory_3_4_dlc_backup_factory_wallsets_size',
  'pve_factory_3_4_dlc_backup_factory_wallsets_sha256',
  'pve_factory_3_4_dlc_backup_factory_exterior_size',
  'pve_factory_3_4_dlc_backup_factory_exterior_sha256',
  'pve_factory_3_4_dlc_backup_factory_conveyor_size',
  'pve_factory_3_4_dlc_backup_factory_conveyor_sha256'
]);

function parseQuotedString(value, lineNumber) {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== 'string') throw new Error('value is not a string');
    return parsed;
  } catch (error) {
    throw new Error(`Invalid quoted string on line ${lineNumber}: ${error.message}`);
  }
}

function parseSimpleYaml(source) {
  const config = {};
  let activeList = null;

  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    const listItem = line.match(/^  - (.+)$/);
    if (listItem) {
      if (!activeList) throw new Error(`Unexpected list item on line ${lineNumber}`);
      config[activeList].push(parseQuotedString(listItem[1], lineNumber));
      continue;
    }

    if (/^\s/.test(line)) throw new Error(`Unexpected indentation on line ${lineNumber}`);
    const entry = line.match(/^([a-z][a-z0-9_]*):(.*)$/);
    if (!entry) throw new Error(`Unsupported YAML syntax on line ${lineNumber}`);

    const [, key, rawValue] = entry;
    if (!CONFIG_KEYS.has(key)) throw new Error(`Unknown launcher configuration key: ${key}`);
    if (Object.prototype.hasOwnProperty.call(config, key)) {
      throw new Error(`Duplicate launcher configuration key: ${key}`);
    }

    const value = rawValue.trim();
    if (!value) {
      if (key !== 'update_repositories') {
        throw new Error(`${key} must be a quoted string`);
      }
      config[key] = [];
      activeList = key;
    } else {
      if (key === 'update_repositories') {
        throw new Error('update_repositories must be a list');
      }
      config[key] = parseQuotedString(value, lineNumber);
      activeList = null;
    }
  }

  for (const key of CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(config, key)) {
      throw new Error(`Missing launcher configuration key: ${key}`);
    }
  }
  return config;
}

function resolveEnvironment(value) {
  return value
    .replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_match, name) =>
      (process.env[name] || '').trim()
    )
    .trim();
}

function assertFileName(value, extension, key) {
  if (!value.endsWith(extension) || value.includes('/') || value.includes('\\')) {
    throw new Error(`${key} must be a file name ending in ${extension}`);
  }
}

function parseRepository(value, key) {
  const parts = value.split('/');
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error(`Invalid ${key}: ${value}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function assertBranch(value, key) {
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) {
    throw new Error(`${key} contains unsupported characters`);
  }
}

function assertServerHost(value, key) {
  if (isIP(value)) return;
  if (
    value.length > 253 ||
    !value.split('.').every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
    )
  ) {
    throw new Error(`${key} must be an IP address or hostname without a port`);
  }
}

function assertSha256(value, key) {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${key} must be a lowercase SHA-256 digest`);
  }
}

function parseByteSize(value, key, maximum) {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${key} must be a positive byte count`);
  }
  const size = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(size) || size > maximum) {
    throw new Error(`${key} must not exceed ${maximum} bytes`);
  }
  return size;
}

function parseDirectZipUrl(value, key) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid URL`);
  }
  if (
    url.protocol !== 'https:' ||
    !url.pathname.endsWith('.zip') ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(`${key} must be a direct HTTPS ZIP URL`);
  }
  return url;
}

function loadLauncherConfig(options = {}) {
  const configPath = options.configPath || resolve(__dirname, '..', 'launcher.config.yml');
  const raw = parseSimpleYaml(readFileSync(configPath, { encoding: 'utf-8' }));
  const configuredServerHost = raw.default_server_host.trim();
  if (!configuredServerHost) throw new Error('default_server_host must not be empty');
  const defaultServerHost = options.resolveEnvironment
    ? resolveEnvironment(configuredServerHost)
    : configuredServerHost;
  const configuredFallbackHost = raw.fallback_server_host.trim();
  if (!configuredFallbackHost) throw new Error('fallback_server_host must not be empty');
  const fallbackServerHost = options.resolveEnvironment
    ? resolveEnvironment(configuredFallbackHost)
    : configuredFallbackHost;
  assertServerHost(defaultServerHost, 'default_server_host');
  assertServerHost(fallbackServerHost, 'fallback_server_host');
  if (defaultServerHost.toLowerCase() === fallbackServerHost.toLowerCase()) {
    throw new Error('default_server_host and fallback_server_host must be different');
  }
  const defaultServerName = raw.default_server_name.trim();
  if (!defaultServerName || defaultServerName.length > 64) {
    throw new Error('default_server_name must contain 1 to 64 characters');
  }

  let agendaStatsUrl;
  let agendaStatsStatusUrl;
  try {
    agendaStatsUrl = new URL(raw.agenda_stats_url);
    agendaStatsStatusUrl = new URL(raw.agenda_stats_status_url);
  } catch {
    throw new Error('Agenda Stats URLs must be valid URLs');
  }
  if (
    agendaStatsUrl.protocol !== 'https:' ||
    agendaStatsStatusUrl.protocol !== 'https:' ||
    agendaStatsUrl.username ||
    agendaStatsUrl.password ||
    agendaStatsStatusUrl.username ||
    agendaStatsStatusUrl.password
  ) {
    throw new Error('Agenda Stats URLs must use HTTPS without embedded credentials');
  }
  if (agendaStatsUrl.origin !== agendaStatsStatusUrl.origin) {
    throw new Error('agenda_stats_url and agenda_stats_status_url must use the same origin');
  }

  let discordUrl;
  try {
    discordUrl = new URL(raw.discord_invite_url);
  } catch {
    throw new Error('discord_invite_url must be a valid URL');
  }
  if (discordUrl.protocol !== 'https:') {
    throw new Error('discord_invite_url must use HTTPS');
  }

  let steamStoreUrl;
  try {
    steamStoreUrl = new URL(raw.steam_store_url);
  } catch {
    throw new Error('steam_store_url must be a valid URL');
  }
  if (
    steamStoreUrl.protocol !== 'https:' ||
    steamStoreUrl.hostname !== 'store.steampowered.com' ||
    !/^\/app\/\d+\/?$/.test(steamStoreUrl.pathname)
  ) {
    throw new Error('steam_store_url must use https://store.steampowered.com/app/<app-id>/');
  }

  let steamInstallUrl;
  try {
    steamInstallUrl = new URL(raw.steam_install_url);
  } catch {
    throw new Error('steam_install_url must be a valid URL');
  }
  if (
    steamInstallUrl.protocol !== 'steam:' ||
    steamInstallUrl.hostname !== 'run' ||
    !/^\/\d+$/.test(steamInstallUrl.pathname)
  ) {
    throw new Error('steam_install_url must use steam://run/<app-id>');
  }
  const storeAppId = steamStoreUrl.pathname.match(/^\/app\/(\d+)\/?$/)?.[1];
  const installAppId = steamInstallUrl.pathname.slice(1);
  if (storeAppId !== installAppId) {
    throw new Error('steam_store_url and steam_install_url must use the same app ID');
  }
  assertBranch(raw.stable_branch, 'stable_branch');
  if (!Array.isArray(raw.update_repositories) || raw.update_repositories.length !== 2) {
    throw new Error('update_repositories must contain exactly two repositories');
  }

  const updateRepositories = raw.update_repositories.map((repository) =>
    parseRepository(repository, 'update repository')
  );
  if (new Set(raw.update_repositories.map((value) => value.toLowerCase())).size !== 2) {
    throw new Error('update_repositories contains a duplicate');
  }

  assertFileName(raw.windows_installer_name, '.exe', 'windows_installer_name');
  assertFileName(raw.linux_appimage_name, '.AppImage', 'linux_appimage_name');
  if (!/^\d+\.\d+\.\d+$/.test(raw.dxvk_version)) {
    throw new Error('dxvk_version must be a semantic version');
  }
  let dxvkArchiveUrl;
  try {
    dxvkArchiveUrl = new URL(raw.dxvk_archive_url);
  } catch {
    throw new Error('dxvk_archive_url must be a valid URL');
  }
  const expectedDxvkPath =
    `/doitsujin/dxvk/releases/download/v${raw.dxvk_version}/dxvk-${raw.dxvk_version}.tar.gz`;
  if (
    dxvkArchiveUrl.protocol !== 'https:' ||
    dxvkArchiveUrl.hostname !== 'github.com' ||
    dxvkArchiveUrl.pathname !== expectedDxvkPath ||
    dxvkArchiveUrl.search ||
    dxvkArchiveUrl.hash ||
    dxvkArchiveUrl.username ||
    dxvkArchiveUrl.password
  ) {
    throw new Error('dxvk_archive_url must point to the configured official DXVK GitHub release');
  }
  for (const key of [
    'dxvk_archive_sha256',
    'dxvk_d3d9_sha256'
  ]) {
    assertSha256(raw[key], key);
  }

  const clientPatchSize = Number.parseInt(raw.client_patch_size, 10);
  const clientPatchDisabled = raw.client_patch_revision === '0';
  let clientPatchUrl = null;
  if (clientPatchDisabled) {
    if (raw.client_patch_url || raw.client_patch_sha256 || raw.client_patch_size !== '0') {
      throw new Error('disabled client patches require an empty URL/hash and size 0');
    }
  } else {
    if (!/^[1-9]\d*$/.test(raw.client_patch_revision)) {
      throw new Error('client_patch_revision must be 0 or a positive integer');
    }
    try {
      clientPatchUrl = new URL(raw.client_patch_url);
    } catch {
      throw new Error('client_patch_url must be a valid GitHub release asset URL');
    }
    if (
      clientPatchUrl.protocol !== 'https:' ||
      clientPatchUrl.hostname !== 'github.com' ||
      !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/[^/]+\/Commonwealth-GA-Client-Patches-x86\.dll$/.test(
        clientPatchUrl.pathname
      ) ||
      clientPatchUrl.search ||
      clientPatchUrl.hash ||
      clientPatchUrl.username ||
      clientPatchUrl.password
    ) {
      throw new Error('client_patch_url must point to a Commonwealth client-patch GitHub release asset');
    }
    if (!/^\d+$/.test(raw.client_patch_size) || clientPatchSize < 1 || clientPatchSize > 50 * 1024 * 1024) {
      throw new Error('client_patch_size must be between 1 byte and 50 MiB');
    }
    assertSha256(raw.client_patch_sha256, 'client_patch_sha256');
  }

  const surfsideAtollDlcUrl = parseDirectZipUrl(
    raw.surfside_atoll_dlc_url,
    'surfside_atoll_dlc_url'
  );
  const surfsideAtollArchiveSize = parseByteSize(
    raw.surfside_atoll_dlc_archive_size,
    'surfside_atoll_dlc_archive_size',
    512 * 1024 * 1024
  );
  assertSha256(raw.surfside_atoll_dlc_archive_sha256, 'surfside_atoll_dlc_archive_sha256');
  const surfsideAtollFiles = [
    {
      archivePath: 'Maps/3P_Beachhead/3P_Beachhead_P.ut3',
      targetPath: '3P_Beachhead/3P_Beachhead_P.ut3',
      size: parseByteSize(
        raw.surfside_atoll_dlc_beachhead_package_size,
        'surfside_atoll_dlc_beachhead_package_size',
        256 * 1024 * 1024
      ),
      sha256: raw.surfside_atoll_dlc_beachhead_package_sha256
    },
    {
      archivePath: 'Maps/3P_Beachhead/3P_Beachhead_Sound.ut3',
      targetPath: '3P_Beachhead/3P_Beachhead_Sound.ut3',
      size: parseByteSize(
        raw.surfside_atoll_dlc_beachhead_sound_size,
        'surfside_atoll_dlc_beachhead_sound_size',
        256 * 1024 * 1024
      ),
      sha256: raw.surfside_atoll_dlc_beachhead_sound_sha256
    },
    {
      archivePath: 'Maps/3P_Beachhead2/3P_Beachhead2_P.ut3',
      targetPath: '3P_Beachhead2/3P_Beachhead2_P.ut3',
      size: parseByteSize(
        raw.surfside_atoll_dlc_beachhead2_package_size,
        'surfside_atoll_dlc_beachhead2_package_size',
        256 * 1024 * 1024
      ),
      sha256: raw.surfside_atoll_dlc_beachhead2_package_sha256
    },
    {
      archivePath: 'Maps/3P_Beachhead2/3P_Beachhead2_Sound.ut3',
      targetPath: '3P_Beachhead2/3P_Beachhead2_Sound.ut3',
      size: parseByteSize(
        raw.surfside_atoll_dlc_beachhead2_sound_size,
        'surfside_atoll_dlc_beachhead2_sound_size',
        256 * 1024 * 1024
      ),
      sha256: raw.surfside_atoll_dlc_beachhead2_sound_sha256
    }
  ];
  for (const [index, file] of surfsideAtollFiles.entries()) {
    assertSha256(file.sha256, `surfside_atoll_dlc file ${index + 1} SHA-256`);
  }

  const carbonCaptureDlcUrl = parseDirectZipUrl(
    raw.carbon_capture_dlc_url,
    'carbon_capture_dlc_url'
  );
  const carbonCaptureArchiveSize = parseByteSize(
    raw.carbon_capture_dlc_archive_size,
    'carbon_capture_dlc_archive_size',
    512 * 1024 * 1024
  );
  assertSha256(raw.carbon_capture_dlc_archive_sha256, 'carbon_capture_dlc_archive_sha256');
  const carbonCaptureFiles = [
    {
      archivePath: 'Maps/Rot_10v10_Carbon_Capture1/Rot_10v10_Carbon_Capture1.ut3',
      targetPath: 'Rot_10v10_Carbon_Capture1/Rot_10v10_Carbon_Capture1.ut3',
      size: parseByteSize(
        raw.carbon_capture_dlc_map_size,
        'carbon_capture_dlc_map_size',
        256 * 1024 * 1024
      ),
      sha256: raw.carbon_capture_dlc_map_sha256
    }
  ];
  assertSha256(carbonCaptureFiles[0].sha256, 'carbon_capture_dlc map SHA-256');

  const pveFactoryDlcUrl = parseDirectZipUrl(
    raw.pve_factory_3_4_dlc_url,
    'pve_factory_3_4_dlc_url'
  );
  const pveFactoryArchiveSize = parseByteSize(
    raw.pve_factory_3_4_dlc_archive_size,
    'pve_factory_3_4_dlc_archive_size',
    512 * 1024 * 1024
  );
  assertSha256(raw.pve_factory_3_4_dlc_archive_sha256, 'pve_factory_3_4_dlc_archive_sha256');
  const pveFactoryPinnedFile = (archivePath, key) => {
    const field = `pve_factory_3_4_dlc_${key}`;
    const sha256 = raw[`${field}_sha256`];
    assertSha256(sha256, `${field}_sha256`);
    return {
      archivePath,
      size: parseByteSize(raw[`${field}_size`], `${field}_size`, 256 * 1024 * 1024),
      sha256
    };
  };
  const pveFactoryFiles = [
    {
      ...pveFactoryPinnedFile(
        'DLC/Maps/1P_CPFactory04/1P_CPFactory04_P.ut3',
        'factory04_package'
      ),
      targetRoot: 'cooked-pc',
      targetPath: 'Maps/1P_CPFactory04/1P_CPFactory04_P.ut3'
    },
    {
      ...pveFactoryPinnedFile(
        'DLC/Maps/1P_CPFactory04/1P_CPFactory04_Sound.ut3',
        'factory04_sound'
      ),
      targetRoot: 'cooked-pc',
      targetPath: 'Maps/1P_CPFactory04/1P_CPFactory04_Sound.ut3'
    },
    {
      ...pveFactoryPinnedFile(
        'DLC/Maps/1P_CPFactory03/1P_CPFactory03_Sound.ut3',
        'factory03_sound'
      ),
      targetRoot: 'cooked-pc',
      targetPath: 'Maps/1P_CPFactory03/1P_CPFactory03_Sound.ut3'
    },
    {
      ...pveFactoryPinnedFile(
        'DLC/Maps/1P_CPFactory03/1P_CPFactory03_P.ut3',
        'factory03_package'
      ),
      targetRoot: 'cooked-pc',
      targetPath: 'Maps/1P_CPFactory03/1P_CPFactory03_P.ut3'
    },
    {
      ...pveFactoryPinnedFile('DLC/Sounds/SND_ENV_CPFactory.upk', 'sound_environment'),
      targetRoot: 'cooked-pc',
      targetPath: 'Sounds/SND_ENV_CPFactory.upk',
      restore: pveFactoryPinnedFile(
        'Backup/Sounds/SND_ENV_CPFactory.upk',
        'backup_sound_environment'
      )
    },
    {
      ...pveFactoryPinnedFile(
        'DLC/Environments/SAAM_S_American_Arms_Market/SAAM_Mining_IntA00.upk',
        'mining_interior'
      ),
      targetRoot: 'cooked-pc',
      targetPath: 'Environments/SAAM_S_American_Arms_Market/SAAM_Mining_IntA00.upk',
      restore: pveFactoryPinnedFile(
        'Backup/Environments/SAAM_S_American_Arms_Market/SAAM_Mining_IntA00.upk',
        'backup_mining_interior'
      )
    },
    {
      ...pveFactoryPinnedFile(
        'DLC/Environments/Dev_Gen_Library/Gen_Piping.upk',
        'general_piping'
      ),
      targetRoot: 'cooked-pc',
      targetPath: 'Environments/Dev_Gen_Library/Gen_Piping.upk',
      restore: pveFactoryPinnedFile(
        'Backup/Environments/Dev_Gen_Library/Gen_Piping.upk',
        'backup_general_piping'
      )
    },
    {
      ...pveFactoryPinnedFile(
        'DLC/Environments/Commonwealth/Comm_Props/Commonwealth_Props.upk',
        'commonwealth_props'
      ),
      targetRoot: 'cooked-pc',
      targetPath: 'Environments/Commonwealth/Comm_Props/Commonwealth_Props.upk',
      restore: pveFactoryPinnedFile(
        'Backup/Environments/Commonwealth/Comm_Props/Commonwealth_Props.upk',
        'backup_commonwealth_props'
      )
    },
    {
      ...pveFactoryPinnedFile(
        'DLC/Environments/CMW_Factories/CMW_Factories_WallSets.upk',
        'factory_wallsets'
      ),
      targetRoot: 'cooked-pc',
      targetPath: 'Environments/CMW_Factories/CMW_Factories_WallSets.upk',
      restore: pveFactoryPinnedFile(
        'Backup/Environments/CMW_Factories/CMW_Factories_WallSets.upk',
        'backup_factory_wallsets'
      )
    },
    {
      ...pveFactoryPinnedFile(
        'DLC/Environments/CMW_Factories/CMW_Factory_ExteriorA01.upk',
        'factory_exterior'
      ),
      targetRoot: 'cooked-pc',
      targetPath: 'Environments/CMW_Factories/CMW_Factory_ExteriorA01.upk',
      restore: pveFactoryPinnedFile(
        'Backup/Environments/CMW_Factories/CMW_Factory_ExteriorA01.upk',
        'backup_factory_exterior'
      )
    },
    {
      ...pveFactoryPinnedFile(
        'DLC/Environments/CMW_Factories/CMW_Factories_Conveyor.upk',
        'factory_conveyor'
      ),
      targetRoot: 'cooked-pc',
      targetPath: 'Environments/CMW_Factories/CMW_Factories_Conveyor.upk',
      restore: pveFactoryPinnedFile(
        'Backup/Environments/CMW_Factories/CMW_Factories_Conveyor.upk',
        'backup_factory_conveyor'
      )
    },
    {
      ...pveFactoryPinnedFile(
        'Binaries/UE3ShaderCompileWorker.exe',
        'shader_worker'
      ),
      targetRoot: 'binaries',
      targetPath: 'UE3ShaderCompileWorker.exe'
    }
  ];

  assertBranch(raw.server_history_branch, 'server_history_branch');
  const serverHistoryCount = Number.parseInt(raw.server_history_count, 10);
  if (!/^\d+$/.test(raw.server_history_count) || serverHistoryCount < 1 || serverHistoryCount > 10) {
    throw new Error('server_history_count must be an integer from 1 to 10');
  }

  return {
    defaultServerHost,
    fallbackServerHost,
    defaultServerName,
    agendaStatsUrl: agendaStatsUrl.toString(),
    agendaStatsStatusUrl: agendaStatsStatusUrl.toString(),
    discordInviteUrl: raw.discord_invite_url,
    steamStoreUrl: raw.steam_store_url,
    steamInstallUrl: raw.steam_install_url,
    stableBranch: raw.stable_branch,
    updateRepositories,
    serverHistoryRepository: parseRepository(
      raw.server_history_repository,
      'server_history_repository'
    ),
    serverHistoryBranch: raw.server_history_branch,
    serverHistoryCount,
    windowsInstallerName: raw.windows_installer_name,
    linuxAppImageName: raw.linux_appimage_name,
    dxvk: {
      version: raw.dxvk_version,
      archiveUrl: raw.dxvk_archive_url,
      archiveSha256: raw.dxvk_archive_sha256,
      dllSha256: {
        'd3d9.dll': raw.dxvk_d3d9_sha256
      }
    },
    clientPatch: {
      enabled: !clientPatchDisabled,
      revision: raw.client_patch_revision,
      url: clientPatchUrl?.toString() ?? '',
      size: clientPatchSize,
      sha256: raw.client_patch_sha256,
      publishedAt: null
    },
    dlcs: [
      {
        id: 'surfside-atoll-pvp-maps',
        name: 'Surfside-Atoll PvP Maps',
        mode: 'PvP',
        mapCount: 2,
        description:
          'Adds Surfside and Atoll as two additional PvP maps. Install or remove the pack independently without changing the base game files around it.',
        url: surfsideAtollDlcUrl.toString(),
        archiveSize: surfsideAtollArchiveSize,
        archiveSha256: raw.surfside_atoll_dlc_archive_sha256,
        files: surfsideAtollFiles
      },
      {
        id: 'carbon-capture',
        name: 'Carbon Capture PvP Map',
        mode: 'PvP',
        mapCount: 1,
        description:
          'Adds Carbon Capture as an additional PvP map. Install or remove it independently without changing the base game files around it.',
        url: carbonCaptureDlcUrl.toString(),
        archiveSize: carbonCaptureArchiveSize,
        archiveSha256: raw.carbon_capture_dlc_archive_sha256,
        files: carbonCaptureFiles
      },
      {
        id: 'pve-factory-3-4',
        name: 'Factory 3-4 PvE Maps',
        mode: 'PvE',
        mapCount: 2,
        description:
          'Adds Central Industrial Complex and Recycling Plant 37 as two PvE maps, including their required support files. Remove restores the verified base-game files.',
        url: pveFactoryDlcUrl.toString(),
        archiveSize: pveFactoryArchiveSize,
        archiveSha256: raw.pve_factory_3_4_dlc_archive_sha256,
        files: pveFactoryFiles
      }
    ]
  };
}

module.exports = { loadLauncherConfig, parseSimpleYaml };

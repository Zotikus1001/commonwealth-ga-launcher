const { readFileSync } = require('fs');
const { isIP } = require('net');
const { resolve } = require('path');

const CONFIG_KEYS = new Set([
  'default_server_host',
  'fallback_server_host',
  'default_server_name',
  'discord_invite_url',
  'steam_store_url',
  'stable_branch',
  'update_repositories',
  'server_history_repository',
  'server_history_branch',
  'server_history_count',
  'windows_installer_name',
  'linux_appimage_name'
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
  assertBranch(raw.server_history_branch, 'server_history_branch');
  const serverHistoryCount = Number.parseInt(raw.server_history_count, 10);
  if (!/^\d+$/.test(raw.server_history_count) || serverHistoryCount < 1 || serverHistoryCount > 10) {
    throw new Error('server_history_count must be an integer from 1 to 10');
  }

  return {
    defaultServerHost,
    fallbackServerHost,
    defaultServerName,
    discordInviteUrl: raw.discord_invite_url,
    steamStoreUrl: raw.steam_store_url,
    stableBranch: raw.stable_branch,
    updateRepositories,
    serverHistoryRepository: parseRepository(
      raw.server_history_repository,
      'server_history_repository'
    ),
    serverHistoryBranch: raw.server_history_branch,
    serverHistoryCount,
    windowsInstallerName: raw.windows_installer_name,
    linuxAppImageName: raw.linux_appimage_name
  };
}

module.exports = { loadLauncherConfig, parseSimpleYaml };

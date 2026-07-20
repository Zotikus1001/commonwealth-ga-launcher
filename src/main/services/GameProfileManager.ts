import { createHash, randomUUID } from 'crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import type { GameProfileSummary } from '@shared/types';
import {
  MAX_GAME_PROFILES,
  normalizeGameProfileName,
  validateGameProfileName
} from '@shared/gameProfiles';
import type { GameInstall } from './InstallLocator';
import type { Log } from './Log';

const PROFILE_STORE_SCHEMA_VERSION = 1;
const PROFILE_FILE_PATTERN = /^Tg[A-Za-z0-9]+\.ini$/i;
const PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PROFILE_FILES = 32;
const MAX_PROFILE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PROFILE_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_STORED_PROFILE_BYTES = Math.ceil((MAX_PROFILE_TOTAL_BYTES * 4) / 3) + 1024 * 1024;

interface StoredProfileIndex {
  schemaVersion: number;
  selectedProfileId: string | null;
  profileIds: string[];
}

interface StoredProfileFile {
  name: string;
  size: number;
  sha256: string;
  contents: string;
}

interface StoredGameProfile {
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  files: StoredProfileFile[];
}

export interface GameProfileSnapshot {
  profiles: GameProfileSummary[];
  selectedProfileId: string | null;
}

export interface AppliedGameProfile extends GameProfileSummary {
  totalBytes: number;
}

interface RestoreTarget {
  path: string;
  contents: Buffer;
  original: Buffer | null;
  originalMode: number | null;
}

function sha256(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProfileId(value: unknown): value is string {
  return typeof value === 'string' && PROFILE_ID_PATTERN.test(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function decodeBase64(value: unknown): Buffer | null {
  if (
    typeof value !== 'string' ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null;
  }
  return Buffer.from(value, 'base64');
}

function profileSummary(profile: StoredGameProfile): GameProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    fileCount: profile.files.length
  };
}

function parseIndex(value: unknown): StoredProfileIndex {
  if (!isPlainObject(value) || value.schemaVersion !== PROFILE_STORE_SCHEMA_VERSION) {
    throw new Error('Unsupported or invalid profile index schema.');
  }
  if (!Array.isArray(value.profileIds) || value.profileIds.length > MAX_GAME_PROFILES) {
    throw new Error('Profile index contains an invalid profile list.');
  }
  const profileIds = value.profileIds.filter(isProfileId);
  if (
    profileIds.length !== value.profileIds.length ||
    new Set(profileIds).size !== profileIds.length
  ) {
    throw new Error('Profile index contains an invalid identifier.');
  }
  if (value.selectedProfileId !== null && !isProfileId(value.selectedProfileId)) {
    throw new Error('Profile index contains an invalid selection.');
  }
  return {
    schemaVersion: PROFILE_STORE_SCHEMA_VERSION,
    selectedProfileId:
      value.selectedProfileId !== null && profileIds.includes(value.selectedProfileId)
        ? value.selectedProfileId
        : null,
    profileIds
  };
}

function parseProfile(value: unknown, expectedId: string): StoredGameProfile {
  if (!isPlainObject(value) || value.schemaVersion !== PROFILE_STORE_SCHEMA_VERSION) {
    throw new Error('Unsupported or invalid game profile schema.');
  }
  if (value.id !== expectedId || !isProfileId(value.id)) {
    throw new Error('Game profile identifier does not match its storage file.');
  }
  const nameError = validateGameProfileName(value.name);
  if (nameError || normalizeGameProfileName(value.name as string) !== value.name) {
    throw new Error(nameError ?? 'Game profile name is not normalized.');
  }
  if (!isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt)) {
    throw new Error('Game profile timestamps are invalid.');
  }
  if (
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > MAX_PROFILE_FILES
  ) {
    throw new Error('Game profile contains an invalid file list.');
  }

  const files: StoredProfileFile[] = [];
  const names = new Set<string>();
  let totalBytes = 0;
  for (const candidate of value.files) {
    if (
      !isPlainObject(candidate) ||
      typeof candidate.name !== 'string' ||
      !PROFILE_FILE_PATTERN.test(candidate.name) ||
      basename(candidate.name) !== candidate.name ||
      !Number.isInteger(candidate.size) ||
      (candidate.size as number) < 0 ||
      (candidate.size as number) > MAX_PROFILE_FILE_BYTES ||
      typeof candidate.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(candidate.sha256)
    ) {
      throw new Error('Game profile contains invalid file metadata.');
    }
    const normalizedName = candidate.name.toLowerCase();
    if (names.has(normalizedName)) {
      throw new Error('Game profile contains duplicate file names.');
    }
    const contents = decodeBase64(candidate.contents);
    if (
      !contents ||
      contents.length !== candidate.size ||
      sha256(contents) !== candidate.sha256
    ) {
      throw new Error(`Game profile file ${candidate.name} failed integrity validation.`);
    }
    names.add(normalizedName);
    totalBytes += contents.length;
    if (totalBytes > MAX_PROFILE_TOTAL_BYTES) {
      throw new Error('Game profile exceeds the total size limit.');
    }
    files.push({
      name: candidate.name,
      size: candidate.size,
      sha256: candidate.sha256,
      contents: candidate.contents as string
    });
  }

  return {
    schemaVersion: PROFILE_STORE_SCHEMA_VERSION,
    id: value.id,
    name: value.name as string,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    files
  };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), { encoding: 'utf-8' });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeBufferAtomic(path: string, contents: Buffer, mode: number | null): Promise<void> {
  const temporaryPath = `${path}.profile-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, mode === null ? undefined : { mode });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export class GameProfileManager {
  private readonly userDataRoot: string;
  private readonly root: string;
  private readonly indexPath: string;
  private loaded = false;
  private readOnlyReason: string | null = null;
  private index: StoredProfileIndex = {
    schemaVersion: PROFILE_STORE_SCHEMA_VERSION,
    selectedProfileId: null,
    profileIds: []
  };
  private summaries = new Map<string, GameProfileSummary>();

  constructor(userDataDir: string, private readonly log: Log) {
    this.userDataRoot = resolve(userDataDir);
    this.root = resolve(this.userDataRoot, 'game-profiles');
    if (dirname(this.root) !== this.userDataRoot || basename(this.root) !== 'game-profiles') {
      throw new Error('Game profile storage path is unsafe.');
    }
    this.indexPath = join(this.root, 'index.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    let raw: string;
    try {
      raw = await readFile(this.indexPath, { encoding: 'utf-8' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.loaded = true;
        return;
      }
      this.markReadOnly(`Could not read game profiles: ${(error as Error).message}`);
      return;
    }

    try {
      const index = parseIndex(JSON.parse(raw));
      const summaries = new Map<string, GameProfileSummary>();
      for (const id of index.profileIds) {
        const profile = await this.readProfile(id);
        summaries.set(id, profileSummary(profile));
      }
      this.index = index;
      this.summaries = summaries;
      this.loaded = true;
      this.log.info(`game profiles loaded (${index.profileIds.length})`);
    } catch (error) {
      this.markReadOnly(`Game profiles could not be loaded: ${(error as Error).message}`);
    }
  }

  getSnapshot(): GameProfileSnapshot {
    return {
      profiles: this.index.profileIds.map((id) => structuredClone(this.summaries.get(id)!)),
      selectedProfileId: this.index.selectedProfileId
    };
  }

  getSelectedSummary(): GameProfileSummary | null {
    const id = this.index.selectedProfileId;
    return id ? structuredClone(this.summaries.get(id) ?? null) : null;
  }

  async create(name: string, install: GameInstall): Promise<GameProfileSummary> {
    await this.ensureWritable();
    if (this.index.profileIds.length >= MAX_GAME_PROFILES) {
      throw new Error(`You can save up to ${MAX_GAME_PROFILES} game profiles.`);
    }
    const normalizedName = this.validatedName(name);
    const files = await this.captureFiles(install);
    const now = new Date().toISOString();
    const id = randomUUID();
    const profile: StoredGameProfile = {
      schemaVersion: PROFILE_STORE_SCHEMA_VERSION,
      id,
      name: normalizedName,
      createdAt: now,
      updatedAt: now,
      files
    };
    const nextIndex: StoredProfileIndex = {
      ...this.index,
      selectedProfileId: id,
      profileIds: [...this.index.profileIds, id]
    };
    await writeJsonAtomic(this.profilePath(id), profile);
    try {
      await writeJsonAtomic(this.indexPath, nextIndex);
    } catch (error) {
      await rm(this.profilePath(id), { force: true }).catch(() => {});
      throw error;
    }
    const summary = profileSummary(profile);
    this.index = nextIndex;
    this.summaries.set(id, summary);
    this.log.info(`game profile created (${files.length} files)`);
    return structuredClone(summary);
  }

  async overwrite(id: string, install: GameInstall): Promise<GameProfileSummary> {
    await this.ensureWritable();
    const previous = await this.requireProfile(id);
    const files = await this.captureFiles(install);
    const profile: StoredGameProfile = {
      ...previous,
      updatedAt: new Date().toISOString(),
      files
    };
    await writeJsonAtomic(this.profilePath(id), profile);
    const summary = profileSummary(profile);
    this.summaries.set(id, summary);
    this.log.info(`game profile updated (${files.length} files)`);
    return structuredClone(summary);
  }

  async renameProfile(id: string, name: string): Promise<GameProfileSummary> {
    await this.ensureWritable();
    const previous = await this.requireProfile(id);
    const profile: StoredGameProfile = {
      ...previous,
      name: this.validatedName(name)
    };
    await writeJsonAtomic(this.profilePath(id), profile);
    const summary = profileSummary(profile);
    this.summaries.set(id, summary);
    this.log.info('game profile renamed');
    return structuredClone(summary);
  }

  async deleteProfile(id: string): Promise<void> {
    await this.ensureWritable();
    await this.requireProfile(id);
    const profileIds = this.index.profileIds.filter((candidate) => candidate !== id);
    const nextIndex: StoredProfileIndex = {
      ...this.index,
      selectedProfileId:
        this.index.selectedProfileId === id
          ? (profileIds[0] ?? null)
          : this.index.selectedProfileId,
      profileIds
    };
    await writeJsonAtomic(this.indexPath, nextIndex);
    this.index = nextIndex;
    this.summaries.delete(id);
    await rm(this.profilePath(id), { force: true }).catch((error) => {
      this.log.warn(`orphaned game profile could not be removed: ${(error as Error).message}`);
    });
    this.log.info('game profile removed');
  }

  async select(id: string): Promise<void> {
    await this.ensureWritable();
    if (!this.summaries.has(id)) throw new Error('Unknown game profile.');
    if (this.index.selectedProfileId === id) return;
    const nextIndex = { ...this.index, selectedProfileId: id };
    await writeJsonAtomic(this.indexPath, nextIndex);
    this.index = nextIndex;
    this.log.info('active game profile changed');
  }

  async applySelected(install: GameInstall): Promise<AppliedGameProfile | null> {
    await this.load();
    const id = this.index.selectedProfileId;
    if (!id) return null;
    const profile = await this.requireProfile(id);
    const entries = await readdir(install.configDir, { withFileTypes: true });
    const savedNames = new Set(profile.files.map((file) => file.name.toLowerCase()));
    const existing = new Map<string, { name: string; isFile: boolean }>();
    for (const entry of entries) {
      const key = entry.name.toLowerCase();
      if (!savedNames.has(key)) continue;
      if (existing.has(key)) {
        throw new Error(`Game configuration contains ambiguous file names for ${entry.name}.`);
      }
      existing.set(key, { name: entry.name, isFile: entry.isFile() });
    }

    const targets: RestoreTarget[] = [];
    let totalBytes = 0;
    for (const file of profile.files) {
      const match = existing.get(file.name.toLowerCase());
      if (match && !match.isFile) {
        throw new Error(`Cannot restore ${file.name} because its destination is not a regular file.`);
      }
      const targetPath = join(install.configDir, match?.name ?? file.name);
      const contents = decodeBase64(file.contents)!;
      let original: Buffer | null = null;
      let originalMode: number | null = null;
      if (match) {
        const [currentContents, details] = await Promise.all([readFile(targetPath), stat(targetPath)]);
        if (!details.isFile()) {
          throw new Error(`Cannot restore ${file.name} because its destination is not a regular file.`);
        }
        original = currentContents;
        originalMode = details.mode;
      }
      totalBytes += contents.length;
      targets.push({ path: targetPath, contents, original, originalMode });
    }

    const written: RestoreTarget[] = [];
    try {
      for (const target of targets) {
        await writeBufferAtomic(target.path, target.contents, target.originalMode);
        written.push(target);
        const verified = await readFile(target.path);
        if (sha256(verified) !== sha256(target.contents)) {
          throw new Error(`${basename(target.path)} did not retain the saved profile data.`);
        }
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const target of written.reverse()) {
        try {
          if (target.original === null) await rm(target.path, { force: true });
          else await writeBufferAtomic(target.path, target.original, target.originalMode);
        } catch (rollbackError) {
          rollbackErrors.push(`${basename(target.path)}: ${(rollbackError as Error).message}`);
        }
      }
      const suffix = rollbackErrors.length > 0 ? ` Rollback failed for ${rollbackErrors.join(', ')}.` : '';
      throw new Error(`Could not apply game profile: ${(error as Error).message}.${suffix}`);
    }

    this.log.info(`game profile applied (${profile.files.length} files, ${totalBytes} bytes)`);
    return { ...profileSummary(profile), totalBytes };
  }

  async reset(): Promise<void> {
    if (dirname(this.root) !== this.userDataRoot || basename(this.root) !== 'game-profiles') {
      throw new Error('Refusing to reset an unsafe game profile path.');
    }
    await rm(this.root, { recursive: true, force: true });
    this.index = {
      schemaVersion: PROFILE_STORE_SCHEMA_VERSION,
      selectedProfileId: null,
      profileIds: []
    };
    this.summaries.clear();
    this.readOnlyReason = null;
    this.loaded = true;
    this.log.info('game profiles reset');
  }

  private markReadOnly(reason: string): void {
    this.readOnlyReason = reason;
    this.loaded = true;
    this.log.warn(`${reason} Existing profile files were left unchanged.`);
  }

  private async ensureWritable(): Promise<void> {
    await this.load();
    if (this.readOnlyReason) throw new Error(this.readOnlyReason);
  }

  private validatedName(name: string): string {
    const error = validateGameProfileName(name);
    if (error) throw new Error(error);
    return normalizeGameProfileName(name);
  }

  private profilePath(id: string): string {
    if (!isProfileId(id)) throw new Error('Invalid game profile identifier.');
    return join(this.root, `${id}.json`);
  }

  private async readProfile(id: string): Promise<StoredGameProfile> {
    const path = this.profilePath(id);
    const details = await stat(path);
    if (!details.isFile() || details.size > MAX_STORED_PROFILE_BYTES) {
      throw new Error('Stored game profile is not a valid bounded file.');
    }
    return parseProfile(JSON.parse(await readFile(path, { encoding: 'utf-8' })), id);
  }

  private async requireProfile(id: string): Promise<StoredGameProfile> {
    if (!this.summaries.has(id)) throw new Error('Unknown game profile.');
    return this.readProfile(id);
  }

  private async captureFiles(install: GameInstall): Promise<StoredProfileFile[]> {
    const entries = (await readdir(install.configDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && PROFILE_FILE_PATTERN.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (entries.length === 0) {
      throw new Error('No active Global Agenda configuration files were found to save.');
    }
    if (entries.length > MAX_PROFILE_FILES) {
      throw new Error(`Game configuration contains more than ${MAX_PROFILE_FILES} profile files.`);
    }
    const seen = new Set<string>();
    const files: StoredProfileFile[] = [];
    let totalBytes = 0;
    for (const entry of entries) {
      const normalizedName = entry.name.toLowerCase();
      if (seen.has(normalizedName)) {
        throw new Error(`Game configuration contains ambiguous file names for ${entry.name}.`);
      }
      seen.add(normalizedName);
      const contents = await readFile(join(install.configDir, entry.name));
      if (contents.length > MAX_PROFILE_FILE_BYTES) {
        throw new Error(`${entry.name} is too large to save in a game profile.`);
      }
      totalBytes += contents.length;
      if (totalBytes > MAX_PROFILE_TOTAL_BYTES) {
        throw new Error('Game configuration is too large to save in one profile.');
      }
      files.push({
        name: entry.name,
        size: contents.length,
        sha256: sha256(contents),
        contents: contents.toString('base64')
      });
    }
    return files;
  }
}

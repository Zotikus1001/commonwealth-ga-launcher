import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import {
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile
} from 'fs/promises';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { inflateRaw } from 'zlib';
import type { DlcId, DlcStatus } from '@shared/types';
import { LAUNCHER_CONFIG } from '@shared/generatedLauncherConfig';
import { downloadToFile, type DownloadProgress } from './Download';
import type { GameInstall } from './InstallLocator';
import type { Log } from './Log';
import { managedInstallStatePath } from './ManagedInstallState';

const inflateRawAsync = promisify(inflateRaw);
const MARKER_SCHEMA = 1;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_MAX_COMMENT_LENGTH = 0xffff;
const ZIP_SUPPORTED_FLAGS = 0x0808;

export interface DlcFileDefinition {
  archivePath: string;
  targetPath: string;
  size: number;
  sha256: string;
}

export interface DlcDefinition {
  id: DlcId;
  name: string;
  url: string;
  archiveSize: number;
  archiveSha256: string;
  files: readonly DlcFileDefinition[];
}

type Downloader = typeof downloadToFile;

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  dataLimit: number;
}

interface DlcLocation {
  cookedPcDir: string;
  dlcDir: string;
  mapsDir: string;
  mapsDirExists: boolean;
}

interface InspectedFile {
  definition: DlcFileDefinition;
  path: string;
  state: 'missing' | 'exact' | 'conflict';
  detail: string;
}

interface PayloadInspection {
  location: DlcLocation;
  files: InspectedFile[];
}

interface StagedFile {
  definition: DlcFileDefinition;
  tempPath: string;
}

interface DlcMarker {
  schema: number;
  id: DlcId;
  archiveSha256: string;
  files: Array<{
    path: string;
    sha256: string;
  }>;
}

function normalizeRelativePath(value: string, label: string): string[] {
  if (
    !value ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error(`${label} is not a safe relative path: ${value}`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${label} is not a safe relative path: ${value}`);
  }
  return parts;
}

function validateDefinition(definition: DlcDefinition): void {
  if (!definition.files.length) throw new Error(`${definition.name} has no payload files.`);
  if (!Number.isSafeInteger(definition.archiveSize) || definition.archiveSize < 1) {
    throw new Error(`${definition.name} has an invalid archive size.`);
  }
  if (!/^[a-f0-9]{64}$/.test(definition.archiveSha256)) {
    throw new Error(`${definition.name} has an invalid archive hash.`);
  }
  let url: URL;
  try {
    url = new URL(definition.url);
  } catch {
    throw new Error(`${definition.name} has an invalid download URL.`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${definition.name} must use a direct HTTPS download URL.`);
  }
  const archivePaths = new Set<string>();
  const targetPaths = new Set<string>();
  for (const file of definition.files) {
    normalizeRelativePath(file.archivePath, 'DLC archive path');
    normalizeRelativePath(file.targetPath, 'DLC target path');
    if (archivePaths.has(file.archivePath) || targetPaths.has(file.targetPath.toLowerCase())) {
      throw new Error(`${definition.name} contains a duplicate payload path.`);
    }
    archivePaths.add(file.archivePath);
    targetPaths.add(file.targetPath.toLowerCase());
    if (!Number.isSafeInteger(file.size) || file.size < 1) {
      throw new Error(`${definition.name} contains an invalid payload size.`);
    }
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`${definition.name} contains an invalid payload hash.`);
    }
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const input = createReadStream(path);
  for await (const chunk of input) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function exactFile(path: string, size: number, sha256: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size === size && (await sha256File(path)) === sha256;
  } catch {
    return false;
  }
}

async function findCaseInsensitiveChild(
  parent: string,
  expectedName: string
): Promise<{ name: string; path: string } | null> {
  let names: string[];
  try {
    names = await readdir(parent);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return null;
    throw error;
  }
  const matches = names.filter((name) => name.toLowerCase() === expectedName.toLowerCase());
  if (matches.length > 1) {
    throw new Error(`Ambiguous case-insensitive path under ${parent}: ${expectedName}`);
  }
  return matches.length === 1
    ? { name: matches[0], path: join(parent, matches[0]) }
    : null;
}

async function existingChildDirectory(parent: string, name: string): Promise<string | null> {
  const child = await findCaseInsensitiveChild(parent, name);
  if (!child) return null;
  if (!(await stat(child.path)).isDirectory()) {
    throw new Error(`${child.path} blocks the required DLC directory.`);
  }
  return child.path;
}

async function requiredChildDirectory(parent: string, name: string): Promise<string> {
  const path = await existingChildDirectory(parent, name);
  if (!path) throw new Error(`The game installation is missing ${join(parent, name)}.`);
  return path;
}

async function ensureChildDirectory(parent: string, name: string): Promise<string> {
  const existing = await existingChildDirectory(parent, name);
  if (existing) return existing;
  const expected = join(parent, name);
  try {
    await mkdir(expected);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'EEXIST') throw error;
  }
  return requiredChildDirectory(parent, name);
}

async function resolveDlcLocation(
  install: GameInstall,
  createManagedDirectories: boolean
): Promise<DlcLocation> {
  const tgGameDir = dirname(install.configDir);
  const cookedPcDir = await requiredChildDirectory(tgGameDir, 'CookedPC');
  const existingDlcDir = await existingChildDirectory(cookedPcDir, 'DLC');
  const dlcDir = existingDlcDir
    ?? (createManagedDirectories
      ? await ensureChildDirectory(cookedPcDir, 'DLC')
      : join(cookedPcDir, 'DLC'));
  if (!existingDlcDir && !createManagedDirectories) {
    return {
      cookedPcDir,
      dlcDir,
      mapsDir: join(dlcDir, 'Maps'),
      mapsDirExists: false
    };
  }

  const existingMapsDir = await existingChildDirectory(dlcDir, 'Maps');
  const mapsDir = existingMapsDir
    ?? (createManagedDirectories
      ? await ensureChildDirectory(dlcDir, 'Maps')
      : join(dlcDir, 'Maps'));
  return {
    cookedPcDir,
    dlcDir,
    mapsDir,
    mapsDirExists: existingMapsDir !== null || createManagedDirectories
  };
}

async function resolveTargetFile(
  mapsDir: string,
  mapsDirExists: boolean,
  definition: DlcFileDefinition
): Promise<InspectedFile> {
  const parts = normalizeRelativePath(definition.targetPath, 'DLC target path');
  if (!mapsDirExists) {
    return {
      definition,
      path: join(mapsDir, ...parts),
      state: 'missing',
      detail: 'File is missing.'
    };
  }

  let parent = mapsDir;
  for (const [index, directoryName] of parts.slice(0, -1).entries()) {
    const directory = await findCaseInsensitiveChild(parent, directoryName);
    if (!directory) {
      return {
        definition,
        path: join(parent, ...parts.slice(index)),
        state: 'missing',
        detail: 'File is missing.'
      };
    }
    if (!(await stat(directory.path)).isDirectory()) {
      return {
        definition,
        path: directory.path,
        state: 'conflict',
        detail: `${directory.path} is not a directory.`
      };
    }
    parent = directory.path;
  }

  const expectedName = parts.at(-1)!;
  const file = await findCaseInsensitiveChild(parent, expectedName);
  if (!file) {
    return {
      definition,
      path: join(parent, expectedName),
      state: 'missing',
      detail: 'File is missing.'
    };
  }
  const info = await stat(file.path);
  if (!info.isFile()) {
    return {
      definition,
      path: file.path,
      state: 'conflict',
      detail: `${file.path} is not a regular file.`
    };
  }
  if (info.size !== definition.size) {
    return {
      definition,
      path: file.path,
      state: 'conflict',
      detail: `${file.path} differs from the verified DLC payload.`
    };
  }
  const hash = await sha256File(file.path);
  return {
    definition,
    path: file.path,
    state: hash === definition.sha256 ? 'exact' : 'conflict',
    detail:
      hash === definition.sha256
        ? 'Verified file is installed.'
        : `${file.path} differs from the verified DLC payload.`
  };
}

async function inspectPayload(
  install: GameInstall,
  definition: DlcDefinition,
  createManagedDirectories = false
): Promise<PayloadInspection> {
  const location = await resolveDlcLocation(install, createManagedDirectories);
  const files: InspectedFile[] = [];
  for (const file of definition.files) {
    files.push(await resolveTargetFile(location.mapsDir, location.mapsDirExists, file));
  }
  return { location, files };
}

function statusFromInspection(
  definition: DlcDefinition,
  inspection: PayloadInspection
): DlcStatus {
  const exact = inspection.files.filter((file) => file.state === 'exact').length;
  const conflict = inspection.files.find((file) => file.state === 'conflict');
  const total = definition.files.length;
  if (conflict) {
    return {
      id: definition.id,
      name: definition.name,
      status: 'modified',
      detail: conflict.detail,
      installedFiles: exact,
      totalFiles: total
    };
  }
  if (exact === total) {
    return {
      id: definition.id,
      name: definition.name,
      status: 'installed',
      detail:
        total === 1
          ? 'The verified map file is installed.'
          : `All ${total} verified map files are installed.`,
      installedFiles: exact,
      totalFiles: total
    };
  }
  if (exact === 0) {
    return {
      id: definition.id,
      name: definition.name,
      status: 'missing',
      detail: total === 1 ? 'The map file is not installed.' : 'The map files are not installed.',
      installedFiles: 0,
      totalFiles: total
    };
  }
  return {
    id: definition.id,
    name: definition.name,
    status: 'partial',
    detail: `${exact} of ${total} verified map files are installed.`,
    installedFiles: exact,
    totalFiles: total
  };
}

function locateZipEnd(archive: Buffer): number {
  const firstPossible = Math.max(0, archive.length - 22 - ZIP_MAX_COMMENT_LENGTH);
  for (let offset = archive.length - 22; offset >= firstPossible; offset -= 1) {
    if (archive.readUInt32LE(offset) !== ZIP_END_SIGNATURE) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) return offset;
  }
  throw new Error('The DLC archive has no valid ZIP end record.');
}

function allowedArchiveDirectories(files: readonly DlcFileDefinition[]): Set<string> {
  const directories = new Set<string>();
  for (const file of files) {
    const parts = normalizeRelativePath(file.archivePath, 'DLC archive path');
    let current = '';
    for (const part of parts.slice(0, -1)) {
      current += `${part}/`;
      directories.add(current);
    }
  }
  return directories;
}

function parseZipManifest(
  archive: Buffer,
  definition: DlcDefinition
): Map<string, ZipEntry> {
  const endOffset = locateZipEnd(archive);
  const diskNumber = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const diskEntries = archive.readUInt16LE(endOffset + 8);
  const totalEntries = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error('Multi-disk and Zip64 DLC archives are not supported.');
  }
  if (
    centralOffset + centralSize !== endOffset ||
    centralOffset < 0 ||
    centralOffset + centralSize > archive.length
  ) {
    throw new Error('The DLC ZIP central directory is invalid.');
  }

  const expectedFiles = new Map(definition.files.map((file) => [file.archivePath, file]));
  const allowedDirectories = allowedArchiveDirectories(definition.files);
  const entries = new Map<string, ZipEntry>();
  const seenNames = new Set<string>();
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > endOffset || archive.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error('The DLC ZIP central directory is truncated.');
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const startDisk = archive.readUInt16LE(cursor + 34);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > endOffset) throw new Error('The DLC ZIP central entry is truncated.');
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (seenNames.has(name)) throw new Error(`The DLC ZIP contains duplicate entry ${name}.`);
    seenNames.add(name);
    if (
      (flags & 0x0001) !== 0 ||
      (flags & ~ZIP_SUPPORTED_FLAGS) !== 0 ||
      startDisk !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new Error(`The DLC ZIP entry ${name} uses unsupported ZIP features.`);
    }

    if (name.endsWith('/')) {
      if (
        !allowedDirectories.has(name) ||
        compressedSize !== 0 ||
        uncompressedSize !== 0 ||
        method !== 0
      ) {
        throw new Error(`The DLC ZIP contains unexpected directory ${name}.`);
      }
    } else {
      const expected = expectedFiles.get(name);
      if (!expected) throw new Error(`The DLC ZIP contains unexpected file ${name}.`);
      if (method !== 0 && method !== 8) {
        throw new Error(`The DLC ZIP entry ${name} uses unsupported compression.`);
      }
      if (uncompressedSize !== expected.size) {
        throw new Error(`The DLC ZIP entry ${name} has the wrong unpacked size.`);
      }
      entries.set(name, {
        name,
        flags,
        method,
        compressedSize,
        uncompressedSize,
        localOffset,
        dataLimit: centralOffset
      });
    }
    cursor = next;
  }
  if (cursor !== endOffset) throw new Error('The DLC ZIP central directory size is inconsistent.');
  for (const path of expectedFiles.keys()) {
    if (!entries.has(path)) throw new Error(`The DLC ZIP is missing ${path}.`);
  }
  return entries;
}

async function extractZipEntry(archive: Buffer, entry: ZipEntry): Promise<Buffer> {
  if (
    entry.localOffset + 30 > archive.length ||
    archive.readUInt32LE(entry.localOffset) !== ZIP_LOCAL_SIGNATURE
  ) {
    throw new Error(`The DLC ZIP local entry for ${entry.name} is invalid.`);
  }
  const localFlags = archive.readUInt16LE(entry.localOffset + 6);
  const localMethod = archive.readUInt16LE(entry.localOffset + 8);
  const localCompressedSize = archive.readUInt32LE(entry.localOffset + 18);
  const localUncompressedSize = archive.readUInt32LE(entry.localOffset + 22);
  const nameLength = archive.readUInt16LE(entry.localOffset + 26);
  const extraLength = archive.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  const localName = archive
    .subarray(entry.localOffset + 30, entry.localOffset + 30 + nameLength)
    .toString('utf8');
  if (
    localName !== entry.name ||
    localFlags !== entry.flags ||
    localMethod !== entry.method ||
    ((entry.flags & 0x0008) === 0 &&
      (localCompressedSize !== entry.compressedSize ||
        localUncompressedSize !== entry.uncompressedSize)) ||
    dataStart < entry.localOffset ||
    dataEnd > entry.dataLimit
  ) {
    throw new Error(`The DLC ZIP local entry for ${entry.name} does not match its manifest.`);
  }

  const compressed = archive.subarray(dataStart, dataEnd);
  const output =
    entry.method === 0
      ? Buffer.from(compressed)
      : await inflateRawAsync(compressed, { maxOutputLength: entry.uncompressedSize });
  if (output.length !== entry.uncompressedSize) {
    throw new Error(`The DLC ZIP entry ${entry.name} unpacked to the wrong size.`);
  }
  return output;
}

async function ensureTargetParent(mapsDir: string, targetPath: string): Promise<string> {
  const parts = normalizeRelativePath(targetPath, 'DLC target path');
  let parent = mapsDir;
  for (const directoryName of parts.slice(0, -1)) {
    parent = await ensureChildDirectory(parent, directoryName);
  }
  return parent;
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

async function removeIfExact(path: string, definition: DlcFileDefinition): Promise<void> {
  if (await exactFile(path, definition.size, definition.sha256)) {
    await rm(path, { force: true });
  }
}

export function unavailableDlcStatuses(
  definitions: readonly DlcDefinition[] = LAUNCHER_CONFIG.dlcs
): DlcStatus[] {
  return definitions.map((definition) => ({
    id: definition.id,
    name: definition.name,
    status: 'unavailable',
    detail: 'Set a valid game installation to manage this DLC.',
    installedFiles: 0,
    totalFiles: definition.files.length
  }));
}

export function failedDlcStatus(
  id: DlcId,
  message: string,
  definitions: readonly DlcDefinition[] = LAUNCHER_CONFIG.dlcs
): DlcStatus {
  const definition = definitions.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Unknown DLC: ${id}`);
  return {
    id,
    name: definition.name,
    status: 'error',
    detail: message,
    installedFiles: 0,
    totalFiles: definition.files.length
  };
}

export class DlcManager {
  constructor(
    private readonly userDataDir: string,
    private readonly log: Log,
    private readonly definitions: readonly DlcDefinition[] = LAUNCHER_CONFIG.dlcs,
    private readonly downloader: Downloader = downloadToFile
  ) {
    const ids = new Set<DlcId>();
    const targetPaths = new Set<string>();
    for (const definition of definitions) {
      validateDefinition(definition);
      if (ids.has(definition.id)) throw new Error(`Duplicate DLC definition: ${definition.id}`);
      ids.add(definition.id);
      for (const file of definition.files) {
        const targetPath = file.targetPath.toLowerCase();
        if (targetPaths.has(targetPath)) {
          throw new Error(`DLC definitions share target path ${file.targetPath}.`);
        }
        targetPaths.add(targetPath);
      }
    }
  }

  private definition(id: DlcId): DlcDefinition {
    const definition = this.definitions.find((candidate) => candidate.id === id);
    if (!definition) throw new Error(`Unknown DLC: ${id}`);
    return definition;
  }

  private markerPath(install: GameInstall, id: DlcId): string {
    return managedInstallStatePath(
      this.userDataDir,
      install,
      `dlc-${id}.json`
    );
  }

  private async writeMarker(install: GameInstall, definition: DlcDefinition): Promise<void> {
    const marker: DlcMarker = {
      schema: MARKER_SCHEMA,
      id: definition.id,
      archiveSha256: definition.archiveSha256,
      files: definition.files.map((file) => ({
        path: file.targetPath,
        sha256: file.sha256
      }))
    };
    const path = this.markerPath(install, definition.id);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(marker, null, 2), { encoding: 'utf-8' });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async verifiedArchive(
    definition: DlcDefinition,
    onProgress: (progress: DownloadProgress) => void
  ): Promise<string> {
    const cacheDir = join(this.userDataDir, 'dlcs', definition.id);
    const archivePath = join(cacheDir, `${definition.archiveSha256}.zip`);
    await mkdir(cacheDir, { recursive: true });
    if (await exactFile(archivePath, definition.archiveSize, definition.archiveSha256)) {
      return archivePath;
    }
    await rm(archivePath, { force: true });

    const temporary = join(cacheDir, `${randomUUID()}.download`);
    try {
      this.log.info(`${definition.name}: downloading verified DLC archive`);
      await this.downloader(definition.url, temporary, onProgress, {
        idleTimeoutMs: 30_000,
        maxBytes: definition.archiveSize
      });
      if (!(await exactFile(temporary, definition.archiveSize, definition.archiveSha256))) {
        throw new Error('The downloaded DLC archive failed size or SHA-256 verification.');
      }
      await rename(temporary, archivePath);
      this.log.info(`${definition.name}: verified DLC archive cached`);
      return archivePath;
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async inspectAll(install: GameInstall): Promise<DlcStatus[]> {
    const statuses: DlcStatus[] = [];
    for (const definition of this.definitions) {
      try {
        statuses.push(statusFromInspection(definition, await inspectPayload(install, definition)));
      } catch (error) {
        statuses.push(failedDlcStatus(definition.id, (error as Error).message, this.definitions));
      }
    }
    return statuses;
  }

  async ensureInstalled(
    install: GameInstall,
    id: DlcId,
    onProgress: (progress: DownloadProgress) => void = () => {}
  ): Promise<DlcStatus> {
    const definition = this.definition(id);
    const initial = await inspectPayload(install, definition);
    const conflict = initial.files.find((file) => file.state === 'conflict');
    if (conflict) throw new Error(conflict.detail);
    if (initial.files.every((file) => file.state === 'exact')) {
      await this.writeMarker(install, definition);
      return statusFromInspection(definition, initial);
    }

    const archivePath = await this.verifiedArchive(definition, onProgress);
    const archive = await readFile(archivePath);
    const entries = parseZipManifest(archive, definition);
    const writable = await inspectPayload(install, definition, true);
    const writableConflict = writable.files.find((file) => file.state === 'conflict');
    if (writableConflict) throw new Error(writableConflict.detail);

    const staged: StagedFile[] = [];
    const published: Array<{ path: string; definition: DlcFileDefinition }> = [];
    try {
      for (const file of writable.files.filter((candidate) => candidate.state === 'missing')) {
        const entry = entries.get(file.definition.archivePath)!;
        const payload = await extractZipEntry(archive, entry);
        if (createHash('sha256').update(payload).digest('hex') !== file.definition.sha256) {
          throw new Error(`The DLC ZIP entry ${entry.name} failed SHA-256 verification.`);
        }
        const targetParent = await ensureTargetParent(
          writable.location.mapsDir,
          file.definition.targetPath
        );
        const temporary = join(
          targetParent,
          `.commonwealth-dlc-${definition.id}-${randomUUID()}.tmp`
        );
        await writeFile(temporary, payload, { flag: 'wx' });
        staged.push({ definition: file.definition, tempPath: temporary });
      }

      const beforePublish = await inspectPayload(install, definition);
      const publishConflict = beforePublish.files.find((file) => file.state === 'conflict');
      if (publishConflict) throw new Error(publishConflict.detail);
      for (const stagedFile of staged) {
        const current = beforePublish.files.find(
          (file) => file.definition.targetPath === stagedFile.definition.targetPath
        )!;
        if (current.state === 'exact') continue;
        try {
          await link(stagedFile.tempPath, current.path);
          published.push({ path: current.path, definition: stagedFile.definition });
        } catch (error) {
          if (
            !isAlreadyExists(error) ||
            !(await exactFile(
              current.path,
              stagedFile.definition.size,
              stagedFile.definition.sha256
            ))
          ) {
            throw error;
          }
        }
      }

      const installed = await inspectPayload(install, definition);
      if (!installed.files.every((file) => file.state === 'exact')) {
        throw new Error('The DLC could not be verified after installation.');
      }
      await this.writeMarker(install, definition);
      this.log.info(
        `${definition.name}: installed ${definition.files.length} verified map ` +
          `file${definition.files.length === 1 ? '' : 's'}`
      );
      return statusFromInspection(definition, installed);
    } catch (error) {
      for (const file of published) {
        await removeIfExact(file.path, file.definition).catch(() => {});
      }
      throw error;
    } finally {
      await Promise.all(staged.map((file) => rm(file.tempPath, { force: true }).catch(() => {})));
    }
  }

  async remove(install: GameInstall, id: DlcId): Promise<DlcStatus> {
    const definition = this.definition(id);
    const inspection = await inspectPayload(install, definition);
    const conflict = inspection.files.find((file) => file.state === 'conflict');
    if (conflict) {
      throw new Error(
        `The DLC was not removed because ${conflict.path} is not the verified managed file.`
      );
    }

    for (const file of inspection.files.filter((candidate) => candidate.state === 'exact')) {
      await unlink(file.path);
    }
    await rm(this.markerPath(install, definition.id), { force: true });
    await this.removeEmptyDirectories(inspection.location, definition);
    const removed = await inspectPayload(install, definition);
    this.log.info(`${definition.name}: removed verified map files`);
    return statusFromInspection(definition, removed);
  }

  private async removeEmptyDirectories(
    location: DlcLocation,
    definition: DlcDefinition
  ): Promise<void> {
    const directories = new Set<string>();
    for (const file of definition.files) {
      const parts = normalizeRelativePath(file.targetPath, 'DLC target path');
      let parent = location.mapsDir;
      for (const name of parts.slice(0, -1)) {
        const child = await existingChildDirectory(parent, name).catch(() => null);
        if (!child) break;
        directories.add(child);
        parent = child;
      }
    }
    const ordered = [...directories].sort((left, right) => right.length - left.length);
    for (const directory of [...ordered, location.mapsDir, location.dlcDir]) {
      try {
        await rmdir(directory);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
          this.log.warn(`DLC empty-directory cleanup skipped for ${directory}: ${(error as Error).message}`);
        }
      }
    }
  }
}

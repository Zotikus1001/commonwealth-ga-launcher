import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
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
const MARKER_SCHEMA = 2;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_MAX_COMMENT_LENGTH = 0xffff;
const ZIP_SUPPORTED_FLAGS = 0x0808;

interface DlcArchiveFileDefinition {
  archivePath: string;
  size: number;
  sha256: string;
}

export type DlcTargetRoot = 'dlc-maps' | 'cooked-pc' | 'binaries';

export interface DlcRestoreDefinition extends DlcArchiveFileDefinition {}

export interface DlcFileDefinition extends DlcArchiveFileDefinition {
  targetRoot?: DlcTargetRoot;
  targetPath: string;
  restore?: DlcRestoreDefinition;
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

export interface DlcOperationProgress {
  phase: 'download' | 'files';
  completed: number;
  total: number;
}

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
  binariesDir: string;
}

interface InspectedFile {
  definition: DlcFileDefinition;
  path: string;
  state: 'missing' | 'exact' | 'restored' | 'conflict';
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

interface InstallMutation {
  definition: DlcFileDefinition;
  path: string;
  rollbackPath?: string;
}

interface RemovalMutation {
  definition: DlcFileDefinition;
  path: string;
  rollbackPath?: string;
  publishedRestore: boolean;
}

interface DlcMarker {
  schema: number;
  id: DlcId;
  archiveSha256: string;
  files: Array<{
    root: DlcTargetRoot;
    path: string;
    sha256: string;
    restoreSha256?: string;
  }>;
}

function targetRootOf(definition: DlcFileDefinition): DlcTargetRoot {
  return definition.targetRoot ?? 'dlc-maps';
}

function targetKey(definition: DlcFileDefinition): string {
  const path = definition.targetPath.toLowerCase();
  return targetRootOf(definition) === 'dlc-maps'
    ? `cooked-pc:dlc/maps/${path}`
    : `${targetRootOf(definition)}:${path}`;
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
    if (!['dlc-maps', 'cooked-pc', 'binaries'].includes(targetRootOf(file))) {
      throw new Error(`${definition.name} contains an invalid target root.`);
    }
    if (archivePaths.has(file.archivePath.toLowerCase()) || targetPaths.has(targetKey(file))) {
      throw new Error(`${definition.name} contains a duplicate payload path.`);
    }
    archivePaths.add(file.archivePath.toLowerCase());
    targetPaths.add(targetKey(file));
    if (!Number.isSafeInteger(file.size) || file.size < 1) {
      throw new Error(`${definition.name} contains an invalid payload size.`);
    }
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`${definition.name} contains an invalid payload hash.`);
    }
    if (file.restore) {
      normalizeRelativePath(file.restore.archivePath, 'DLC restore archive path');
      if (archivePaths.has(file.restore.archivePath.toLowerCase())) {
        throw new Error(`${definition.name} contains a duplicate archive path.`);
      }
      archivePaths.add(file.restore.archivePath.toLowerCase());
      if (!Number.isSafeInteger(file.restore.size) || file.restore.size < 1) {
        throw new Error(`${definition.name} contains an invalid restore size.`);
      }
      if (!/^[a-f0-9]{64}$/.test(file.restore.sha256)) {
        throw new Error(`${definition.name} contains an invalid restore hash.`);
      }
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
    const info = await lstat(path);
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
  if (!(await lstat(child.path)).isDirectory()) {
    throw new Error(`${child.path} blocks the required DLC directory.`);
  }
  return child.path;
}

async function requiredChildDirectory(parent: string, name: string): Promise<string> {
  const path = await existingChildDirectory(parent, name);
  if (!path) throw new Error(`The game installation is missing ${join(parent, name)}.`);
  return path;
}

async function requiredDirectory(path: string): Promise<string> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`The game installation is missing ${path}.`);
    }
    throw error;
  }
  if (!info.isDirectory()) throw new Error(`${path} is not a game directory.`);
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

async function resolveDlcLocation(install: GameInstall): Promise<DlcLocation> {
  const tgGameDir = dirname(install.configDir);
  const cookedPcDir = await requiredChildDirectory(tgGameDir, 'CookedPC');
  const existingDlcDir = await existingChildDirectory(cookedPcDir, 'DLC');
  const dlcDir = existingDlcDir ?? join(cookedPcDir, 'DLC');
  if (!existingDlcDir) {
    return {
      cookedPcDir,
      dlcDir,
      mapsDir: join(dlcDir, 'Maps'),
      mapsDirExists: false,
      binariesDir: await requiredDirectory(install.binariesDir)
    };
  }

  const existingMapsDir = await existingChildDirectory(dlcDir, 'Maps');
  return {
    cookedPcDir,
    dlcDir,
    mapsDir: existingMapsDir ?? join(dlcDir, 'Maps'),
    mapsDirExists: existingMapsDir !== null,
    binariesDir: await requiredDirectory(install.binariesDir)
  };
}

function targetRootLocation(
  location: DlcLocation,
  definition: DlcFileDefinition
): { path: string; exists: boolean } {
  switch (targetRootOf(definition)) {
    case 'cooked-pc':
      return { path: location.cookedPcDir, exists: true };
    case 'binaries':
      return { path: location.binariesDir, exists: true };
    case 'dlc-maps':
      return { path: location.mapsDir, exists: location.mapsDirExists };
  }
}

async function resolveTargetFile(
  location: DlcLocation,
  definition: DlcFileDefinition
): Promise<InspectedFile> {
  const parts = normalizeRelativePath(definition.targetPath, 'DLC target path');
  const root = targetRootLocation(location, definition);
  if (!root.exists) {
    return {
      definition,
      path: join(root.path, ...parts),
      state: 'missing',
      detail: 'File is missing.'
    };
  }

  let parent = root.path;
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
    if (!(await lstat(directory.path)).isDirectory()) {
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
  const info = await lstat(file.path);
  if (!info.isFile()) {
    return {
      definition,
      path: file.path,
      state: 'conflict',
      detail: `${file.path} is not a regular file.`
    };
  }
  const couldBePayload = info.size === definition.size;
  const couldBeRestore = definition.restore?.size === info.size;
  const hash = couldBePayload || couldBeRestore ? await sha256File(file.path) : '';
  const payloadMatches = couldBePayload && hash === definition.sha256;
  const restoreMatches = couldBeRestore && hash === definition.restore?.sha256;
  return {
    definition,
    path: file.path,
    state: payloadMatches ? 'exact' : restoreMatches ? 'restored' : 'conflict',
    detail: payloadMatches
      ? 'Verified file is installed.'
      : restoreMatches
        ? 'Verified base-game file is restored.'
        : definition.restore
          ? `${file.path} differs from both the verified DLC payload and its base-game backup.`
          : `${file.path} differs from the verified DLC payload.`
  };
}

async function inspectPayload(
  install: GameInstall,
  definition: DlcDefinition
): Promise<PayloadInspection> {
  const location = await resolveDlcLocation(install);
  const files: InspectedFile[] = [];
  for (const file of definition.files) {
    files.push(await resolveTargetFile(location, file));
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
          ? 'The verified DLC file is installed.'
          : `All ${total} verified DLC files are installed.`,
      installedFiles: exact,
      totalFiles: total
    };
  }
  if (exact === 0) {
    return {
      id: definition.id,
      name: definition.name,
      status: 'missing',
      detail: total === 1 ? 'The DLC file is not installed.' : 'The DLC files are not installed.',
      installedFiles: 0,
      totalFiles: total
    };
  }
  return {
    id: definition.id,
    name: definition.name,
    status: 'partial',
    detail: `${exact} of ${total} verified DLC files are installed.`,
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

function archiveFiles(definition: DlcDefinition): DlcArchiveFileDefinition[] {
  return definition.files.flatMap((file) => file.restore ? [file, file.restore] : [file]);
}

function allowedArchiveDirectories(files: readonly DlcArchiveFileDefinition[]): Set<string> {
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

  const expectedArchiveFiles = archiveFiles(definition);
  const expectedFiles = new Map(expectedArchiveFiles.map((file) => [file.archivePath, file]));
  const allowedDirectories = allowedArchiveDirectories(expectedArchiveFiles);
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

async function ensureTargetParent(
  location: DlcLocation,
  definition: DlcFileDefinition
): Promise<string> {
  const parts = normalizeRelativePath(definition.targetPath, 'DLC target path');
  let parent: string;
  if (targetRootOf(definition) === 'dlc-maps') {
    const dlcDir = await ensureChildDirectory(location.cookedPcDir, 'DLC');
    parent = await ensureChildDirectory(dlcDir, 'Maps');
  } else {
    parent = targetRootLocation(location, definition).path;
  }
  for (const directoryName of parts.slice(0, -1)) {
    parent = await ensureChildDirectory(parent, directoryName);
  }
  return parent;
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function removeExactOrMissing(
  path: string,
  expected: DlcArchiveFileDefinition
): Promise<void> {
  if (!(await pathExists(path))) return;
  if (!(await exactFile(path, expected.size, expected.sha256))) {
    throw new Error(`Rollback stopped because ${path} changed during the DLC operation.`);
  }
  await rm(path, { force: true });
}

function rollbackFilePath(path: string, id: DlcId): string {
  return join(dirname(path), `.commonwealth-dlc-${id}-${randomUUID()}.rollback`);
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
        const targetPath = targetKey(file);
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

  private async clearArchiveDownloads(): Promise<void> {
    await rm(join(this.userDataDir, 'dlcs'), { recursive: true, force: true });
  }

  private async writeMarker(install: GameInstall, definition: DlcDefinition): Promise<void> {
    const marker: DlcMarker = {
      schema: MARKER_SCHEMA,
      id: definition.id,
      archiveSha256: definition.archiveSha256,
      files: definition.files.map((file) => ({
        root: targetRootOf(file),
        path: file.targetPath,
        sha256: file.sha256,
        ...(file.restore ? { restoreSha256: file.restore.sha256 } : {})
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

  private async downloadVerifiedArchive(
    definition: DlcDefinition,
    onProgress: (progress: DownloadProgress) => void,
    onVerified: () => void
  ): Promise<Buffer> {
    const downloadDir = join(this.userDataDir, 'dlcs', definition.id);
    try {
      await mkdir(downloadDir, { recursive: true });
      const temporary = join(downloadDir, `${randomUUID()}.download`);
      this.log.info(`${definition.name}: downloading verified DLC archive`);
      await this.downloader(definition.url, temporary, onProgress, {
        idleTimeoutMs: 30_000,
        maxBytes: definition.archiveSize
      });
      if (!(await exactFile(temporary, definition.archiveSize, definition.archiveSha256))) {
        throw new Error('The downloaded DLC archive failed size or SHA-256 verification.');
      }
      this.log.info(`${definition.name}: verified DLC archive ready for this operation`);
      onVerified();
      return await readFile(temporary);
    } finally {
      await this.clearArchiveDownloads();
    }
  }

  async inspectAll(install: GameInstall): Promise<DlcStatus[]> {
    await this.clearArchiveDownloads();
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

  private async stageArchiveFile(
    archive: Buffer,
    entries: ReadonlyMap<string, ZipEntry>,
    location: DlcLocation,
    definition: DlcDefinition,
    file: DlcFileDefinition,
    archiveFile: DlcArchiveFileDefinition
  ): Promise<StagedFile> {
    const entry = entries.get(archiveFile.archivePath);
    if (!entry) throw new Error(`The DLC ZIP is missing ${archiveFile.archivePath}.`);
    const payload = await extractZipEntry(archive, entry);
    if (createHash('sha256').update(payload).digest('hex') !== archiveFile.sha256) {
      throw new Error(`The DLC ZIP entry ${entry.name} failed SHA-256 verification.`);
    }
    const targetParent = await ensureTargetParent(location, file);
    const temporary = join(
      targetParent,
      `.commonwealth-dlc-${definition.id}-${randomUUID()}.tmp`
    );
    await writeFile(temporary, payload, { flag: 'wx' });
    return { definition: file, tempPath: temporary };
  }

  private async rollbackInstall(mutations: readonly InstallMutation[]): Promise<string[]> {
    const failures: string[] = [];
    for (const mutation of [...mutations].reverse()) {
      try {
        await removeExactOrMissing(mutation.path, mutation.definition);
        if (mutation.rollbackPath) {
          const restore = mutation.definition.restore!;
          if (!(await exactFile(mutation.rollbackPath, restore.size, restore.sha256))) {
            throw new Error(`The rollback copy for ${mutation.path} is missing or modified.`);
          }
          await rename(mutation.rollbackPath, mutation.path);
        }
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
    return failures;
  }

  private async rollbackRemoval(mutations: readonly RemovalMutation[]): Promise<string[]> {
    const failures: string[] = [];
    for (const mutation of [...mutations].reverse()) {
      try {
        if (mutation.publishedRestore) {
          await removeExactOrMissing(mutation.path, mutation.definition.restore!);
        } else if (await pathExists(mutation.path)) {
          throw new Error(`Rollback stopped because ${mutation.path} changed during removal.`);
        }
        if (mutation.rollbackPath) {
          if (
            !(await exactFile(
              mutation.rollbackPath,
              mutation.definition.size,
              mutation.definition.sha256
            ))
          ) {
            throw new Error(`The rollback copy for ${mutation.path} is missing or modified.`);
          }
          await rename(mutation.rollbackPath, mutation.path);
        }
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
    return failures;
  }

  private async discardRollbackFiles(
    mutations: ReadonlyArray<InstallMutation | RemovalMutation>
  ): Promise<void> {
    for (const mutation of mutations) {
      if (!mutation.rollbackPath) continue;
      await rm(mutation.rollbackPath, { force: true }).catch((error) => {
        this.log.warn(
          `DLC rollback-file cleanup skipped for ${mutation.rollbackPath}: ${(error as Error).message}`
        );
      });
    }
  }

  async ensureInstalled(
    install: GameInstall,
    id: DlcId,
    onProgress: (progress: DlcOperationProgress) => void = () => {}
  ): Promise<DlcStatus> {
    await this.clearArchiveDownloads();
    const definition = this.definition(id);
    const initial = await inspectPayload(install, definition);
    const conflict = initial.files.find((file) => file.state === 'conflict');
    if (conflict) throw new Error(conflict.detail);
    if (initial.files.every((file) => file.state === 'exact')) {
      await this.writeMarker(install, definition);
      return statusFromInspection(definition, initial);
    }

    const announcedFileWorkTotal =
      initial.files.filter((candidate) => candidate.state !== 'exact').length * 2 + 1;
    onProgress({ phase: 'download', completed: 0, total: definition.archiveSize });
    const archive = await this.downloadVerifiedArchive(
      definition,
      ({ transferred, total }) => {
        onProgress({
          phase: 'download',
          completed: transferred,
          total: total || definition.archiveSize
        });
      },
      () => onProgress({ phase: 'files', completed: 0, total: announcedFileWorkTotal })
    );
    const entries = parseZipManifest(archive, definition);
    const writable = await inspectPayload(install, definition);
    const writableConflict = writable.files.find((file) => file.state === 'conflict');
    if (writableConflict) throw new Error(writableConflict.detail);

    const filesToInstall = writable.files.filter((candidate) => candidate.state !== 'exact');
    let completedFileWork = 0;
    const totalFileWork = filesToInstall.length * 2 + 1;
    const reportFileProgress = (): void => {
      onProgress({ phase: 'files', completed: completedFileWork, total: totalFileWork });
    };
    if (totalFileWork !== announcedFileWorkTotal) reportFileProgress();

    const staged: StagedFile[] = [];
    const mutations: InstallMutation[] = [];
    try {
      for (const file of filesToInstall) {
        staged.push(
          await this.stageArchiveFile(
            archive,
            entries,
            writable.location,
            definition,
            file.definition,
            file.definition
          )
        );
        completedFileWork += 1;
        reportFileProgress();
      }

      const beforePublish = await inspectPayload(install, definition);
      const publishConflict = beforePublish.files.find((file) => file.state === 'conflict');
      if (publishConflict) throw new Error(publishConflict.detail);
      for (const stagedFile of staged) {
        const current = beforePublish.files.find(
          (file) => targetKey(file.definition) === targetKey(stagedFile.definition)
        )!;
        if (current.state !== 'exact') {
          let mutation: InstallMutation | null = null;
          if (current.state === 'restored') {
            const rollbackPath = rollbackFilePath(current.path, definition.id);
            await rename(current.path, rollbackPath);
            mutation = { definition: current.definition, path: current.path, rollbackPath };
            mutations.push(mutation);
          }
          try {
            await link(stagedFile.tempPath, current.path);
            if (!mutation) {
              mutations.push({ definition: current.definition, path: current.path });
            }
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
        completedFileWork += 1;
        reportFileProgress();
      }

      const installed = await inspectPayload(install, definition);
      if (!installed.files.every((file) => file.state === 'exact')) {
        throw new Error('The DLC could not be verified after installation.');
      }
      await this.writeMarker(install, definition);
      this.log.info(
        `${definition.name}: installed ${definition.files.length} verified DLC ` +
          `file${definition.files.length === 1 ? '' : 's'}`
      );
      await this.discardRollbackFiles(mutations);
      completedFileWork += 1;
      reportFileProgress();
      return statusFromInspection(definition, installed);
    } catch (error) {
      const rollbackFailures = await this.rollbackInstall(mutations);
      if (rollbackFailures.length) {
        throw new Error(
          `${(error as Error).message} DLC rollback was incomplete: ${rollbackFailures.join(' ')}`
        );
      }
      throw error;
    } finally {
      await Promise.all(staged.map((file) => rm(file.tempPath, { force: true }).catch(() => {})));
    }
  }

  async remove(
    install: GameInstall,
    id: DlcId,
    onProgress: (progress: DlcOperationProgress) => void = () => {}
  ): Promise<DlcStatus> {
    await this.clearArchiveDownloads();
    const definition = this.definition(id);
    const inspection = await inspectPayload(install, definition);
    const conflict = inspection.files.find((file) => file.state === 'conflict');
    if (conflict) {
      throw new Error(
        `The DLC was not removed because ${conflict.path} is not the verified managed file.`
      );
    }

    let archive: Buffer | null = null;
    let entries = new Map<string, ZipEntry>();
    const archiveRequired =
      inspection.files.some(
        (file) => file.definition.restore && file.state !== 'restored'
      );

    const announcedFileWorkTotal =
      inspection.files.filter(
        (candidate) => candidate.definition.restore && candidate.state !== 'restored'
      ).length +
      definition.files.length +
      1;
    if (archiveRequired) {
      onProgress({ phase: 'download', completed: 0, total: definition.archiveSize });
      archive = await this.downloadVerifiedArchive(
        definition,
        ({ transferred, total }) => {
          onProgress({
            phase: 'download',
            completed: transferred,
            total: total || definition.archiveSize
          });
        },
        () => onProgress({ phase: 'files', completed: 0, total: announcedFileWorkTotal })
      );
      entries = parseZipManifest(archive, definition);
    } else {
      onProgress({ phase: 'files', completed: 0, total: announcedFileWorkTotal });
    }

    const writable = await inspectPayload(install, definition);
    const writableConflict = writable.files.find((file) => file.state === 'conflict');
    if (writableConflict) {
      throw new Error(
        `The DLC was not removed because ${writableConflict.path} is not a verified managed file.`
      );
    }

    const filesToRestore = writable.files.filter(
      (candidate) => candidate.definition.restore && candidate.state !== 'restored'
    );
    let completedFileWork = 0;
    const totalFileWork = filesToRestore.length + definition.files.length + 1;
    const reportFileProgress = (): void => {
      onProgress({ phase: 'files', completed: completedFileWork, total: totalFileWork });
    };
    if (totalFileWork !== announcedFileWorkTotal) reportFileProgress();

    const staged: StagedFile[] = [];
    const mutations: RemovalMutation[] = [];
    try {
      if (archive) {
        for (const file of filesToRestore) {
          staged.push(
            await this.stageArchiveFile(
              archive,
              entries,
              writable.location,
              definition,
              file.definition,
              file.definition.restore!
            )
          );
          completedFileWork += 1;
          reportFileProgress();
        }
      }

      const beforeRemoval = await inspectPayload(install, definition);
      const removalConflict = beforeRemoval.files.find((file) => file.state === 'conflict');
      if (removalConflict) {
        throw new Error(
          `The DLC was not removed because ${removalConflict.path} is not a verified managed file.`
        );
      }

      for (const current of beforeRemoval.files) {
        if (
          current.state === 'restored' ||
          (!current.definition.restore && current.state === 'missing')
        ) {
          completedFileWork += 1;
          reportFileProgress();
          continue;
        }
        const stagedRestore = staged.find(
          (file) => targetKey(file.definition) === targetKey(current.definition)
        );
        if (current.definition.restore && !stagedRestore) {
          throw new Error(`${current.path} changed while the DLC removal was being prepared.`);
        }

        let rollbackPath: string | undefined;
        if (current.state === 'exact') {
          rollbackPath = rollbackFilePath(current.path, definition.id);
          await rename(current.path, rollbackPath);
          mutations.push({
            definition: current.definition,
            path: current.path,
            rollbackPath,
            publishedRestore: Boolean(current.definition.restore)
          });
        }
        if (!current.definition.restore) {
          completedFileWork += 1;
          reportFileProgress();
          continue;
        }

        try {
          await link(stagedRestore!.tempPath, current.path);
          if (!rollbackPath) {
            mutations.push({
              definition: current.definition,
              path: current.path,
              publishedRestore: true
            });
          }
        } catch (error) {
          if (
            !isAlreadyExists(error) ||
            !(await exactFile(
              current.path,
              current.definition.restore.size,
              current.definition.restore.sha256
            ))
          ) {
            throw error;
          }
        }
        completedFileWork += 1;
        reportFileProgress();
      }

      const removed = await inspectPayload(install, definition);
      if (
        !removed.files.every((file) =>
          file.definition.restore ? file.state === 'restored' : file.state === 'missing'
        )
      ) {
        throw new Error('The DLC could not be verified after removal.');
      }
      await rm(this.markerPath(install, definition.id), { force: true });
      await this.discardRollbackFiles(mutations);
      await this.removeEmptyDirectories(removed.location, definition);
      completedFileWork += 1;
      reportFileProgress();
      this.log.info(
        definition.files.some((file) => file.restore)
          ? `${definition.name}: removed verified DLC files and restored base-game files`
          : `${definition.name}: removed verified DLC files`
      );
      return statusFromInspection(definition, removed);
    } catch (error) {
      const rollbackFailures = await this.rollbackRemoval(mutations);
      if (rollbackFailures.length) {
        throw new Error(
          `${(error as Error).message} DLC rollback was incomplete: ${rollbackFailures.join(' ')}`
        );
      }
      throw error;
    } finally {
      await Promise.all(staged.map((file) => rm(file.tempPath, { force: true }).catch(() => {})));
    }
  }

  private async removeEmptyDirectories(
    location: DlcLocation,
    definition: DlcDefinition
  ): Promise<void> {
    const directories = new Set<string>();
    for (const file of definition.files) {
      const parts = normalizeRelativePath(file.targetPath, 'DLC target path');
      const root = targetRootLocation(location, file);
      if (!root.exists) continue;
      let parent = root.path;
      for (const name of parts.slice(0, -1)) {
        const child = await existingChildDirectory(parent, name).catch(() => null);
        if (!child) break;
        directories.add(child);
        parent = child;
      }
      if (targetRootOf(file) === 'dlc-maps') {
        directories.add(location.mapsDir);
        directories.add(location.dlcDir);
      }
    }
    const ordered = [...directories].sort((left, right) => right.length - left.length);
    for (const directory of ordered) {
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

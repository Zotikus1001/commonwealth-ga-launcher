import { createHash, randomUUID } from 'crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import type { GameInstall } from './InstallLocator';

function normalizedInstallRoot(install: GameInstall): string {
  const normalized = resolve(install.rootDir).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function managedInstallStateDirectory(
  userDataDir: string,
  install: GameInstall
): string {
  const installId = createHash('sha256').update(normalizedInstallRoot(install)).digest('hex');
  return join(userDataDir, 'managed-installs', installId);
}

export function managedInstallStatePath(
  userDataDir: string,
  install: GameInstall,
  fileName: string
): string {
  return join(managedInstallStateDirectory(userDataDir, install), fileName);
}

export function managedIniBackupDirectory(userDataDir: string, install: GameInstall): string {
  return join(managedInstallStateDirectory(userDataDir, install), 'ini-backups');
}

export async function writeManagedState(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, contents, { encoding: 'utf-8' });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function readCandidate(path: string): Promise<{ contents: string; modified: number } | null> {
  try {
    const [contents, details] = await Promise.all([
      readFile(path, { encoding: 'utf-8' }),
      stat(path)
    ]);
    if (!details.isFile()) throw new Error(`${path} is not a regular file`);
    return { contents, modified: details.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readMigratedManagedState(
  statePath: string,
  legacyPath: string
): Promise<string | null> {
  const [current, legacy] = await Promise.all([
    readCandidate(statePath),
    readCandidate(legacyPath)
  ]);
  if (!current && !legacy) return null;

  const selected = legacy && (!current || legacy.modified > current.modified) ? legacy : current!;
  if (!current || selected === legacy) await writeManagedState(statePath, selected.contents);
  if (legacy) await rm(legacyPath, { force: true });
  return selected.contents;
}

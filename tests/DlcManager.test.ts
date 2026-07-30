import { createHash } from 'crypto';
import { deflateRawSync } from 'zlib';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DlcManager,
  type DlcDefinition,
  type DlcFileDefinition
} from '../src/main/services/DlcManager';
import type { GameInstall } from '../src/main/services/InstallLocator';
import type { Log } from '../src/main/services/Log';
import { managedInstallStatePath } from '../src/main/services/ManagedInstallState';

const roots: string[] = [];

interface ArchiveSource {
  archivePath: string;
  targetPath: string;
  contents: Buffer;
}

function sha256(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function zip(entries: Array<{ name: string; contents: Buffer; method?: 0 | 8 }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf-8');
    const method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(entry.contents) : entry.contents;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function definition(archive: Buffer, files: ArchiveSource[]): DlcDefinition {
  return {
    id: 'surfside-atoll-pvp-maps',
    name: 'Surfside-Atoll PvP Maps',
    url: 'https://example.com/surfside-atoll.zip',
    archiveSize: archive.length,
    archiveSha256: sha256(archive),
    files: files.map(
      (file): DlcFileDefinition => ({
        archivePath: file.archivePath,
        targetPath: file.targetPath,
        size: file.contents.length,
        sha256: sha256(file.contents)
      })
    )
  };
}

function logger(): Log {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as Log;
}

async function fixture(): Promise<{
  root: string;
  userData: string;
  install: GameInstall;
  cookedPcDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'ga-dlc-'));
  roots.push(root);
  const gameRoot = join(root, 'game');
  const binariesDir = join(gameRoot, 'Binaries');
  const tgGameDir = join(gameRoot, 'tGgAmE');
  const configDir = join(tgGameDir, 'cOnFiG');
  const cookedPcDir = join(tgGameDir, 'cOoKeDpC');
  await Promise.all([
    mkdir(binariesDir, { recursive: true }),
    mkdir(configDir, { recursive: true }),
    mkdir(cookedPcDir, { recursive: true })
  ]);
  return {
    root,
    userData: join(root, 'user-data'),
    cookedPcDir,
    install: {
      exePath: join(binariesDir, 'GlobalAgenda.exe'),
      binariesDir,
      rootDir: gameRoot,
      configDir
    }
  };
}

function payload(): ArchiveSource[] {
  return [
    {
      archivePath: 'Maps/3P_Beachhead/3P_Beachhead_P.ut3',
      targetPath: '3P_Beachhead/3P_Beachhead_P.ut3',
      contents: Buffer.from('beachhead package')
    },
    {
      archivePath: 'Maps/3P_Beachhead2/3P_Beachhead2_P.ut3',
      targetPath: '3P_Beachhead2/3P_Beachhead2_P.ut3',
      contents: Buffer.from('beachhead two package')
    }
  ];
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DlcManager', () => {
  it('installs and adopts an exact manifest under the case-insensitive CookedPC path', async () => {
    const { userData, install, cookedPcDir } = await fixture();
    const files = payload();
    const archive = zip(files.map((file) => ({ name: file.archivePath, contents: file.contents })));
    const downloader = vi.fn(async (_url: string, destination: string) => {
      await writeFile(destination, archive);
    });
    const manager = new DlcManager(userData, logger(), [definition(archive, files)], downloader);

    await expect(manager.ensureInstalled(install, 'surfside-atoll-pvp-maps')).resolves.toMatchObject({
      status: 'installed',
      installedFiles: 2,
      totalFiles: 2
    });

    for (const file of files) {
      await expect(
        readFile(join(cookedPcDir, 'DLC', 'Maps', ...file.targetPath.split('/')))
      ).resolves.toEqual(file.contents);
    }
    const marker = JSON.parse(
      await readFile(
        managedInstallStatePath(
          userData,
          install,
          'dlc-surfside-atoll-pvp-maps.json'
        ),
        { encoding: 'utf-8' }
      )
    ) as { schema: number; archiveSha256: string };
    expect(marker).toMatchObject({ schema: 1, archiveSha256: sha256(archive) });
    expect(downloader).toHaveBeenCalledTimes(1);

    await manager.ensureInstalled(install, 'surfside-atoll-pvp-maps');
    expect(downloader).toHaveBeenCalledTimes(1);

    const missingTarget = join(
      cookedPcDir,
      'DLC',
      'Maps',
      ...files[1].targetPath.split('/')
    );
    await rm(missingTarget);
    await expect(manager.ensureInstalled(install, 'surfside-atoll-pvp-maps')).resolves.toMatchObject({
      status: 'installed',
      installedFiles: 2
    });
    await expect(readFile(missingTarget)).resolves.toEqual(files[1].contents);
    expect(downloader).toHaveBeenCalledTimes(1);
  });

  it('recognizes exact pre-existing files without downloading the archive', async () => {
    const { userData, install, cookedPcDir } = await fixture();
    const files = payload();
    const archive = zip(files.map((file) => ({ name: file.archivePath, contents: file.contents })));
    for (const file of files) {
      const target = join(cookedPcDir, 'dlc', 'maps', ...file.targetPath.split('/'));
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, file.contents);
    }
    const downloader = vi.fn();
    const manager = new DlcManager(userData, logger(), [definition(archive, files)], downloader);

    await expect(manager.ensureInstalled(install, 'surfside-atoll-pvp-maps')).resolves.toMatchObject({
      status: 'installed'
    });
    expect(downloader).not.toHaveBeenCalled();
  });

  it('never overwrites a conflicting target file', async () => {
    const { userData, install, cookedPcDir } = await fixture();
    const files = payload();
    const archive = zip(files.map((file) => ({ name: file.archivePath, contents: file.contents })));
    const target = join(cookedPcDir, 'DLC', 'Maps', ...files[0].targetPath.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, 'user-owned-map', { encoding: 'utf-8' });
    const downloader = vi.fn();
    const manager = new DlcManager(userData, logger(), [definition(archive, files)], downloader);

    await expect(manager.ensureInstalled(install, 'surfside-atoll-pvp-maps')).rejects.toThrow(
      'differs from the verified DLC payload'
    );
    await expect(readFile(target, { encoding: 'utf-8' })).resolves.toBe('user-owned-map');
    expect(downloader).not.toHaveBeenCalled();
  });

  it('rejects unexpected ZIP entries before writing any game file', async () => {
    const { userData, install, cookedPcDir } = await fixture();
    const files = payload();
    const archive = zip([
      ...files.map((file) => ({ name: file.archivePath, contents: file.contents })),
      { name: '../outside.ut3', contents: Buffer.from('unexpected') }
    ]);
    const manager = new DlcManager(
      userData,
      logger(),
      [definition(archive, files)],
      async (_url, destination) => writeFile(destination, archive)
    );

    await expect(manager.ensureInstalled(install, 'surfside-atoll-pvp-maps')).rejects.toThrow(
      'unexpected file'
    );
    await expect(stat(join(cookedPcDir, 'DLC', 'Maps', '3P_Beachhead'))).rejects.toThrow();
    await expect(stat(join(cookedPcDir, '..', 'outside.ut3'))).rejects.toThrow();
  });

  it('rejects a payload hash mismatch without publishing partial files', async () => {
    const { userData, install, cookedPcDir } = await fixture();
    const expectedFiles = payload();
    const archiveFiles = expectedFiles.map((file, index) => ({
      ...file,
      contents:
        index === 1
          ? Buffer.from('x'.repeat(file.contents.length))
          : file.contents
    }));
    expect(archiveFiles[1].contents.length).toBe(expectedFiles[1].contents.length);
    const archive = zip(
      archiveFiles.map((file) => ({ name: file.archivePath, contents: file.contents }))
    );
    const manager = new DlcManager(
      userData,
      logger(),
      [definition(archive, expectedFiles)],
      async (_url, destination) => writeFile(destination, archive)
    );

    await expect(manager.ensureInstalled(install, 'surfside-atoll-pvp-maps')).rejects.toThrow(
      'SHA-256 verification'
    );
    for (const file of expectedFiles) {
      await expect(
        stat(join(cookedPcDir, 'DLC', 'Maps', ...file.targetPath.split('/')))
      ).rejects.toThrow();
    }
  });

  it('removes only verified DLC files and preserves unrelated map content', async () => {
    const { userData, install, cookedPcDir } = await fixture();
    const files = payload();
    const archive = zip(files.map((file) => ({ name: file.archivePath, contents: file.contents })));
    const manager = new DlcManager(
      userData,
      logger(),
      [definition(archive, files)],
      async (_url, destination) => writeFile(destination, archive)
    );
    await manager.ensureInstalled(install, 'surfside-atoll-pvp-maps');
    const unrelated = join(cookedPcDir, 'DLC', 'Maps', 'keep-me.txt');
    await writeFile(unrelated, 'unrelated', { encoding: 'utf-8' });

    await expect(manager.remove(install, 'surfside-atoll-pvp-maps')).resolves.toMatchObject({
      status: 'missing',
      installedFiles: 0
    });
    await expect(readFile(unrelated, { encoding: 'utf-8' })).resolves.toBe('unrelated');
    for (const file of files) {
      await expect(
        stat(join(cookedPcDir, 'DLC', 'Maps', ...file.targetPath.split('/')))
      ).rejects.toThrow();
    }
  });

  it('refuses removal when any target no longer matches the managed payload', async () => {
    const { userData, install, cookedPcDir } = await fixture();
    const files = payload();
    const archive = zip(files.map((file) => ({ name: file.archivePath, contents: file.contents })));
    const manager = new DlcManager(
      userData,
      logger(),
      [definition(archive, files)],
      async (_url, destination) => writeFile(destination, archive)
    );
    await manager.ensureInstalled(install, 'surfside-atoll-pvp-maps');
    const modified = join(cookedPcDir, 'DLC', 'Maps', ...files[0].targetPath.split('/'));
    await writeFile(modified, 'modified map', { encoding: 'utf-8' });

    await expect(manager.remove(install, 'surfside-atoll-pvp-maps')).rejects.toThrow(
      'not the verified managed file'
    );
    await expect(
      readFile(join(cookedPcDir, 'DLC', 'Maps', ...files[1].targetPath.split('/')))
    ).resolves.toEqual(files[1].contents);
  });
});

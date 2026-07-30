import { createHash } from 'crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ClientPatchManager,
  type ClientPatchDefinition
} from '../src/main/services/ClientPatchManager';
import type { GameInstall } from '../src/main/services/InstallLocator';
import type { Log } from '../src/main/services/Log';
import { managedInstallStatePath } from '../src/main/services/ManagedInstallState';

const roots: string[] = [];

function logger(): Log {
  return {
    info: () => {},
    warn: () => {},
    error: () => {}
  } as unknown as Log;
}

function definition(revision: string, contents: Buffer): ClientPatchDefinition {
  return {
    enabled: true,
    revision,
    url: `https://github.com/example/client-patches/releases/download/v${revision}/Commonwealth-GA-Client-Patches-x86.dll`,
    size: contents.byteLength,
    sha256: createHash('sha256').update(contents).digest('hex'),
    publishedAt: null
  };
}

function peDll(label: string, machine = 0x014c): Buffer {
  const image = Buffer.alloc(512);
  image.write('MZ', 0, 'ascii');
  image.writeUInt32LE(0x80, 0x3c);
  image.write('PE\0\0', 0x80, 'binary');
  image.writeUInt16LE(machine, 0x84);
  image.writeUInt16LE(1, 0x86);
  image.writeUInt16LE(0xe0, 0x94);
  image.writeUInt16LE(0x2102, 0x96);
  image.writeUInt16LE(machine === 0x014c ? 0x010b : 0x020b, 0x98);
  image.write(label, 0xc0, 'utf-8');
  return image;
}

async function fixture(): Promise<{
  root: string;
  userData: string;
  install: GameInstall;
}> {
  const root = await mkdtemp(join(tmpdir(), 'ga-client-patches-'));
  roots.push(root);
  const userData = join(root, 'user-data');
  const binariesDir = join(root, 'game', 'Binaries');
  await mkdir(binariesDir, { recursive: true });
  return {
    root,
    userData,
    install: {
      exePath: join(binariesDir, 'GlobalAgenda.exe'),
      binariesDir,
      rootDir: join(root, 'game'),
      configDir: join(root, 'game', 'TgGame', 'Config')
    }
  };
}

function downloader(contents: Buffer) {
  return async (_url: string, destination: string): Promise<void> => {
    await writeFile(destination, contents);
  };
}

function release(id: number, publishedAt: string, contents: Buffer) {
  return {
    id,
    draft: false,
    prerelease: true,
    published_at: publishedAt,
    assets: [
      {
        name: 'Commonwealth-GA-Client-Patches-x86.dll',
        size: contents.byteLength,
        digest: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
        browser_download_url:
          `https://github.com/example/client-patches/releases/download/v${id}/` +
          'Commonwealth-GA-Client-Patches-x86.dll'
      }
    ]
  };
}

const unavailableReleases = async (): Promise<unknown> => {
  throw new Error('release service unavailable');
};

afterEach(async () => {
  delete process.env.WINEDLLOVERRIDES;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ClientPatchManager', () => {
  it('downloads, verifies, and installs the managed DLL on Windows', async () => {
    const { userData, install } = await fixture();
    const contents = peDll('managed release');
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', contents),
      downloader(contents),
      unavailableReleases
    );

    const environment = await manager.prepareForLaunch(install, 'win32');

    expect(environment).toEqual({});
    expect(await readFile(join(install.binariesDir, 'dinput8.dll'))).toEqual(contents);
    const marker = JSON.parse(
      await readFile(managedInstallStatePath(userData, install, 'client-patches.json'), {
        encoding: 'utf-8'
      })
    ) as { phase: string; revision: string };
    expect(marker).toMatchObject({ phase: 'active', revision: '1' });
    await expect(
      readFile(join(install.binariesDir, '.commonwealth-client-patches.json'))
    ).rejects.toThrow();
  });

  it('migrates a legacy game-folder marker into launcher state', async () => {
    const { userData, install } = await fixture();
    const contents = Buffer.from('patch payload v1');
    const definitionV1 = definition('1', contents);
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definitionV1,
      downloader(contents),
      unavailableReleases
    );
    await manager.prepareForLaunch(install, 'win32');
    const statePath = managedInstallStatePath(userData, install, 'client-patches.json');
    const marker = await readFile(statePath, { encoding: 'utf-8' });
    await rm(statePath);
    const legacyPath = join(install.binariesDir, '.commonwealth-client-patches.json');
    await writeFile(legacyPath, marker, { encoding: 'utf-8' });

    await manager.prepareForLaunch(install, 'win32');

    expect(await readFile(statePath, { encoding: 'utf-8' })).toBe(marker);
    await expect(readFile(legacyPath)).rejects.toThrow();
  });

  it('replaces an unmanaged dinput8.dll with the verified managed release', async () => {
    const { userData, install } = await fixture();
    const existing = Buffer.from('third-party wrapper');
    const contents = peDll('managed release');
    await writeFile(join(install.binariesDir, 'DINPUT8.dll'), existing);
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', contents),
      downloader(contents),
      unavailableReleases
    );

    await expect(manager.prepareForLaunch(install, 'win32')).resolves.toEqual({});
    expect(await readFile(join(install.binariesDir, 'DINPUT8.dll'))).toEqual(contents);
    await expect(manager.inspect(install)).resolves.toMatchObject({
      status: 'managed',
      hasManagedMarker: true
    });
  });

  it('updates a previously launcher-managed payload', async () => {
    const { userData, install } = await fixture();
    const first = Buffer.from('patch payload v1');
    const second = Buffer.from('patch payload v2');
    await new ClientPatchManager(
      userData,
      logger(),
      definition('1', first),
      downloader(first),
      unavailableReleases
    ).prepareForLaunch(install, 'win32');

    await new ClientPatchManager(
      userData,
      logger(),
      definition('2', second),
      downloader(second),
      unavailableReleases
    ).prepareForLaunch(install, 'win32');

    expect(await readFile(join(install.binariesDir, 'dinput8.dll'))).toEqual(second);
  });

  it('removes the launcher-managed payload during reset cleanup', async () => {
    const { userData, install } = await fixture();
    const contents = Buffer.from('patch payload v1');
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', contents),
      downloader(contents),
      unavailableReleases
    );
    await manager.prepareForLaunch(install, 'win32');

    await expect(manager.removeManaged(install)).resolves.toBe(true);

    await expect(readFile(join(install.binariesDir, 'dinput8.dll'))).rejects.toThrow();
    await expect(
      readFile(managedInstallStatePath(userData, install, 'client-patches.json'))
    ).rejects.toThrow();
  });

  it('leaves an unmanaged local DLL untouched during reset cleanup', async () => {
    const { userData, install } = await fixture();
    const managed = Buffer.from('patch payload v1');
    const local = Buffer.from('local development payload');
    await writeFile(join(install.binariesDir, 'dinput8.dll'), local);
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', managed),
      downloader(managed),
      unavailableReleases
    );

    await expect(manager.removeManaged(install)).resolves.toBe(false);
    expect(await readFile(join(install.binariesDir, 'dinput8.dll'))).toEqual(local);
  });

  it('refuses to remove a modified managed payload during reset cleanup', async () => {
    const { userData, install } = await fixture();
    const contents = Buffer.from('patch payload v1');
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', contents),
      downloader(contents),
      unavailableReleases
    );
    await manager.prepareForLaunch(install, 'win32');
    await writeFile(join(install.binariesDir, 'dinput8.dll'), 'modified payload');

    await expect(manager.removeManaged(install)).rejects.toThrow('unmanaged or modified');
    expect(await readFile(join(install.binariesDir, 'dinput8.dll'), { encoding: 'utf-8' })).toBe(
      'modified payload'
    );
  });

  it('keeps ownership metadata when the managed DLL path is no longer a file', async () => {
    const { userData, install } = await fixture();
    const managed = Buffer.from('patch payload v1');
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', managed),
      downloader(managed),
      unavailableReleases
    );
    await manager.prepareForLaunch(install, 'win32');
    const target = join(install.binariesDir, 'dinput8.dll');
    const marker = managedInstallStatePath(userData, install, 'client-patches.json');
    await rm(target);
    await mkdir(target);

    await expect(manager.removeManaged(install)).rejects.toThrow('not a regular file');
    await expect(readFile(marker)).resolves.toBeInstanceOf(Buffer);
  });

  it('retains disable recovery for a known payload whose marker is missing', async () => {
    const { userData, install } = await fixture();
    const managed = Buffer.from('patch payload v1');
    await writeFile(join(install.binariesDir, 'dinput8.dll'), managed);
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', managed),
      downloader(managed),
      unavailableReleases
    );

    await manager.disable(install);
    await expect(readFile(join(install.binariesDir, 'dinput8.dll'))).rejects.toThrow();
  });

  it('removes a replacement DLL and stale ownership when the managed patch is disabled', async () => {
    const { userData, install } = await fixture();
    const managed = peDll('managed release');
    const unmanaged = peDll('unmanaged payload');
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', managed),
      downloader(managed),
      unavailableReleases
    );
    await manager.prepareForLaunch(install, 'win32');
    await writeFile(join(install.binariesDir, 'dinput8.dll'), unmanaged);

    await manager.disable(install);

    await expect(readFile(join(install.binariesDir, 'dinput8.dll'))).rejects.toThrow();
    await expect(
      readFile(managedInstallStatePath(userData, install, 'client-patches.json'))
    ).rejects.toThrow();
  });

  it('removes an unmanaged DLL when the managed payload cannot be downloaded', async () => {
    const { userData, install } = await fixture();
    const managed = peDll('managed release');
    await writeFile(join(install.binariesDir, 'dinput8.dll'), peDll('unmanaged payload'));
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', managed),
      async () => {
        throw new Error('download failed');
      },
      unavailableReleases
    );

    await expect(manager.prepareForLaunch(install, 'win32')).rejects.toThrow('download failed');
    await expect(readFile(join(install.binariesDir, 'dinput8.dll'))).rejects.toThrow();
  });

  it('adds the Wine override without replacing existing overrides', async () => {
    const { userData, install } = await fixture();
    const contents = Buffer.from('patch payload v1');
    process.env.WINEDLLOVERRIDES = 'xaudio2_7=n,b';
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', contents),
      downloader(contents),
      unavailableReleases
    );

    const environment = await manager.prepareForLaunch(install, 'linux');

    expect(environment.WINEDLLOVERRIDES).toBe('xaudio2_7=n,b;dinput8=n,b');
  });

  it('uses a local DLL without checking, downloading, or replacing it', async () => {
    const { userData, install } = await fixture();
    const local = peDll('local development payload');
    let releaseChecks = 0;
    let downloads = 0;
    await writeFile(join(install.binariesDir, 'dinput8.dll'), local);
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', Buffer.from('upstream payload')),
      async () => {
        downloads += 1;
      },
      async () => {
        releaseChecks += 1;
        return [];
      }
    );

    expect(await manager.prepareLocalForLaunch(install, 'win32')).toEqual({});
    expect(await readFile(join(install.binariesDir, 'dinput8.dll'))).toEqual(local);
    expect(releaseChecks).toBe(0);
    expect(downloads).toBe(0);
  });

  it('enables the Wine override for an existing local DLL', async () => {
    const { userData, install } = await fixture();
    await writeFile(join(install.binariesDir, 'dinput8.dll'), peDll('local development payload'));
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', Buffer.from('upstream payload'))
    );

    const environment = await manager.prepareLocalForLaunch(install, 'linux');

    expect(environment.WINEDLLOVERRIDES).toBe('dinput8=n,b');
  });

  it('reports when local mode has no DLL', async () => {
    const { userData, install } = await fixture();
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', Buffer.from('upstream payload'))
    );

    await expect(manager.prepareLocalForLaunch(install, 'linux')).rejects.toThrow(
      'No dinput8.dll is present'
    );
  });

  it('distinguishes a valid local x86 DLL from the managed release', async () => {
    const { userData, install } = await fixture();
    const managed = peDll('managed release');
    const local = peDll('local development payload');
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', managed),
      downloader(managed),
      unavailableReleases
    );
    await manager.prepareForLaunch(install, 'win32');

    await expect(manager.inspect(install)).resolves.toMatchObject({
      status: 'managed',
      hasManagedMarker: true
    });
    await expect(manager.prepareLocalForLaunch(install, 'win32')).rejects.toThrow(
      'launcher-managed release'
    );

    await writeFile(join(install.binariesDir, 'dinput8.dll'), local);
    await expect(manager.inspect(install)).resolves.toMatchObject({
      status: 'local',
      hasManagedMarker: true
    });
    await expect(manager.prepareLocalForLaunch(install, 'win32')).resolves.toEqual({});
  });

  it('replaces a local DLL left over stale managed ownership in normal mode', async () => {
    const { userData, install } = await fixture();
    const managed = peDll('managed release');
    const local = peDll('local development payload');
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', managed),
      downloader(managed),
      unavailableReleases
    );
    await manager.prepareForLaunch(install, 'win32');
    await writeFile(join(install.binariesDir, 'dinput8.dll'), local);

    await manager.prepareForLaunch(install, 'win32');

    expect(await readFile(join(install.binariesDir, 'dinput8.dll'))).toEqual(managed);
    await expect(manager.inspect(install)).resolves.toMatchObject({
      status: 'managed',
      hasManagedMarker: true
    });
  });

  it('rejects a local DLL that is not a 32-bit x86 PE DLL', async () => {
    const { userData, install } = await fixture();
    await writeFile(join(install.binariesDir, 'dinput8.dll'), peDll('x64 payload', 0x8664));
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', peDll('managed release'))
    );

    await expect(manager.inspect(install)).resolves.toMatchObject({
      status: 'invalid',
      detail: expect.stringContaining('32-bit x86')
    });
    await expect(manager.prepareLocalForLaunch(install, 'win32')).rejects.toThrow('32-bit x86');
  });

  it('replaces conflicting Wine dinput8 overrides while retaining unrelated entries', async () => {
    const { userData, install } = await fixture();
    await writeFile(join(install.binariesDir, 'dinput8.dll'), peDll('local development payload'));
    process.env.WINEDLLOVERRIDES = 'xaudio2_7=n,b;dinput8=b;d3d9.dll=n';
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', peDll('managed release'))
    );

    const environment = await manager.prepareLocalForLaunch(install, 'linux');

    expect(environment.WINEDLLOVERRIDES).toBe('xaudio2_7=n,b;d3d9.dll=n;dinput8=n,b');
  });

  it('removes dinput8 from grouped Wine overrides without dropping the other DLLs', async () => {
    const { userData, install } = await fixture();
    await writeFile(join(install.binariesDir, 'dinput8.dll'), peDll('local development payload'));
    process.env.WINEDLLOVERRIDES = 'dinput8,xaudio2_7=b;foo=n';
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', peDll('managed release'))
    );

    const environment = await manager.prepareLocalForLaunch(install, 'linux');

    expect(environment.WINEDLLOVERRIDES).toBe('xaudio2_7=b;foo=n;dinput8=n,b');
  });

  it('checks every enabled launch and installs the newest release by publication time', async () => {
    const { userData, install } = await fixture();
    const pinned = Buffer.from('pinned payload');
    const newer = Buffer.from('newer release payload');
    let checks = 0;
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', pinned),
      downloader(newer),
      async () => {
        checks += 1;
        return [
          release(2, '2026-07-12T12:00:00.000Z', newer),
          release(1, '2026-07-11T12:00:00.000Z', pinned)
        ];
      }
    );

    await manager.prepareForLaunch(install, 'win32');
    await manager.prepareForLaunch(install, 'win32');

    expect(checks).toBe(2);
    expect(await readFile(join(install.binariesDir, 'dinput8.dll'))).toEqual(newer);
  });

  it('keeps a valid installed payload when a newer download fails', async () => {
    const { userData, install } = await fixture();
    const current = Buffer.from('current payload');
    const newer = Buffer.from('newer release payload');
    await new ClientPatchManager(
      userData,
      logger(),
      definition('1', current),
      downloader(current),
      unavailableReleases
    ).prepareForLaunch(install, 'win32');
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', current),
      async () => {
        throw new Error('download failed');
      },
      async () => [release(2, '2026-07-12T12:00:00.000Z', newer)]
    );

    await expect(manager.prepareForLaunch(install, 'win32')).resolves.toEqual({});
    expect(await readFile(join(install.binariesDir, 'dinput8.dll'))).toEqual(current);
  });

  it('retries an interrupted update when the old managed DLL was restored', async () => {
    const { userData, install } = await fixture();
    const current = Buffer.from('current payload');
    const newer = Buffer.from('newer release payload');
    const currentDefinition = definition('1', current);
    await new ClientPatchManager(
      userData,
      logger(),
      currentDefinition,
      downloader(current),
      unavailableReleases
    ).prepareForLaunch(install, 'win32');
    await writeFile(
      managedInstallStatePath(userData, install, 'client-patches.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        owner: 'commonwealth-ga-launcher',
        phase: 'installing',
        revision: '2',
        publishedAt: '2026-07-12T12:00:00.000Z',
        installedSha256: currentDefinition.sha256,
        pendingSha256: createHash('sha256').update(newer).digest('hex')
      })}\n`,
      { encoding: 'utf-8' }
    );
    const manager = new ClientPatchManager(
      userData,
      logger(),
      currentDefinition,
      downloader(newer),
      async () => [release(2, '2026-07-12T12:00:00.000Z', newer)]
    );

    await manager.prepareForLaunch(install, 'win32');

    expect(await readFile(join(install.binariesDir, 'dinput8.dll'))).toEqual(newer);
  });

  it('does nothing while delivery is disabled', async () => {
    const { userData, install } = await fixture();
    const manager = new ClientPatchManager(userData, logger(), {
      enabled: false,
      revision: '0',
      url: '',
      size: 0,
      sha256: '',
      publishedAt: null
    });

    expect(await manager.prepareForLaunch(install, 'win32')).toEqual({});
    await expect(readFile(join(install.binariesDir, 'dinput8.dll'))).rejects.toThrow();
  });
});

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
    const contents = Buffer.from('patch payload v1');
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

  it('never overwrites an unmanaged dinput8.dll', async () => {
    const { userData, install } = await fixture();
    const existing = Buffer.from('third-party wrapper');
    const contents = Buffer.from('patch payload v1');
    await writeFile(join(install.binariesDir, 'DINPUT8.dll'), existing);
    const manager = new ClientPatchManager(
      userData,
      logger(),
      definition('1', contents),
      downloader(contents),
      unavailableReleases
    );

    await expect(manager.prepareForLaunch(install, 'win32')).rejects.toThrow(
      'unmanaged dinput8.dll'
    );
    expect(await readFile(join(install.binariesDir, 'DINPUT8.dll'))).toEqual(existing);
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

  it('removes only the launcher-managed payload when disabled', async () => {
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

    await manager.disable(install);

    await expect(readFile(join(install.binariesDir, 'dinput8.dll'))).rejects.toThrow();
    await expect(
      readFile(managedInstallStatePath(userData, install, 'client-patches.json'))
    ).rejects.toThrow();
  });

  it('refuses to remove a modified managed payload', async () => {
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

    await expect(manager.disable(install)).rejects.toThrow('unmanaged or modified');
    expect(await readFile(join(install.binariesDir, 'dinput8.dll'), { encoding: 'utf-8' })).toBe(
      'modified payload'
    );
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

import { createHash } from 'crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectConfiguredRenderer,
  DXVK_ACTIVE_DLL_NAMES,
  DXVK_ARCHIVE_DLL_NAMES,
  DxvkManager,
  type DxvkDefinition
} from '../src/main/services/DxvkManager';
import type { GameInstall } from '../src/main/services/InstallLocator';

vi.mock('electron', () => ({
  net: { fetch: vi.fn(() => Promise.reject(new Error('network must not be used in this test'))) }
}));

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture(allowD3d10 = false): Promise<{
  root: string;
  userData: string;
  install: GameInstall;
  definition: DxvkDefinition;
}> {
  const root = await mkdtemp(join(tmpdir(), 'commonwealth-dxvk-'));
  roots.push(root);
  const userData = join(root, 'user-data');
  const binariesDir = join(root, 'game', 'Binaries');
  const configDir = join(root, 'game', 'TgGame', 'Config');
  await mkdir(binariesDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, 'TgEngine.ini'),
    `[SystemSettings]\r\nAllowD3D10=${allowD3d10 ? 'True' : 'False'}\r\n`,
    { encoding: 'utf-8' }
  );
  const version = 'test-1';
  const dllSha256 = {} as DxvkDefinition['dllSha256'];
  const payloadDir = join(userData, 'dxvk', version, 'payload');
  await mkdir(payloadDir, { recursive: true });
  for (const name of DXVK_ACTIVE_DLL_NAMES) {
    const contents = `DXVK payload for ${name}`;
    dllSha256[name] = digest(contents);
    await writeFile(join(payloadDir, name), contents, { encoding: 'utf-8' });
  }
  return {
    root,
    userData,
    install: {
      exePath: join(binariesDir, 'GlobalAgenda.exe'),
      binariesDir,
      rootDir: join(root, 'game'),
      configDir
    },
    definition: {
      version,
      archiveUrl: 'https://example.invalid/dxvk.tar.gz',
      archiveSha256: digest('unused archive'),
      dllSha256
    }
  };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

describe('detectConfiguredRenderer', () => {
  it('uses the last active AllowD3D10 assignment in SystemSettings', () => {
    expect(
      detectConfiguredRenderer(
        '[Other]\nAllowD3D10=True\n[SystemSettings]\nAllowD3D10=False\nAllowD3D10=True\n'
      )
    ).toBe('directx-10');
  });

  it('treats an Unreal removal line as unknown until another assignment appears', () => {
    expect(detectConfiguredRenderer('[SystemSettings]\nAllowD3D10=True\n-AllowD3D10\n')).toBe(
      'unknown'
    );
  });

  it('reads an active renderer assignment with an inline comment', () => {
    expect(detectConfiguredRenderer('[SystemSettings] ; renderer\r+AllowD3D10=False ; launcher\r')).toBe(
      'directx-9'
    );
  });
});

describe('DxvkManager graphics DLL transaction', () => {
  it('preserves an existing D3D9 wrapper, leaves unrelated DLLs alone, and restores exactly', async () => {
    const { userData, install, definition } = await fixture();
    const originalIni = await readFile(join(install.configDir, 'TgEngine.ini'), {
      encoding: 'utf-8'
    });
    await writeFile(join(install.binariesDir, 'd3d9.dll'), 'original d3d9', { encoding: 'utf-8' });
    await writeFile(join(install.binariesDir, 'dxgi.dll'), 'original dxgi', { encoding: 'utf-8' });
    await writeFile(
      join(userData, 'dxvk', definition.version, 'payload', 'dxgi.dll'),
      'stale pre-release cache file',
      { encoding: 'utf-8' }
    );
    const manager = new DxvkManager(userData, logger(), definition);

    expect((await manager.inspect(install)).status).toBe('external');
    const active = await manager.prepareForLaunch(install, true);
    expect(active.status).toBe('active');
    expect(active.rendererSetting).toBe('directx-9');
    for (const name of DXVK_ACTIVE_DLL_NAMES) {
      expect(await readFile(join(install.binariesDir, name), { encoding: 'utf-8' })).toBe(
        `DXVK payload for ${name}`
      );
    }
    expect(
      await readFile(join(install.binariesDir, 'd3d9.dll.commonwealth-original'), {
        encoding: 'utf-8'
      })
    ).toBe('original d3d9');
    expect(await readFile(join(install.binariesDir, 'dxgi.dll'), { encoding: 'utf-8' })).toBe(
      'original dxgi'
    );
    expect(await isFile(join(install.binariesDir, 'dxgi.dll.commonwealth-original'))).toBe(false);
    expect(
      await isFile(join(userData, 'dxvk', definition.version, 'payload', 'dxgi.dll'))
    ).toBe(false);

    const restored = await manager.prepareForLaunch(install, false);
    expect(restored.status).toBe('external');
    expect(await readFile(join(install.binariesDir, 'd3d9.dll'), { encoding: 'utf-8' })).toBe(
      'original d3d9'
    );
    expect(await readFile(join(install.binariesDir, 'dxgi.dll'), { encoding: 'utf-8' })).toBe(
      'original dxgi'
    );
    expect(await isFile(join(install.binariesDir, 'd3d10core.dll'))).toBe(false);
    expect(await isFile(join(install.binariesDir, 'd3d11.dll'))).toBe(false);
    expect(await isFile(join(install.binariesDir, '.commonwealth-dxvk.json'))).toBe(false);
    expect(await readFile(join(install.configDir, 'TgEngine.ini'), { encoding: 'utf-8' })).toBe(
      originalIni
    );
  });

  it('refuses to overwrite a graphics DLL changed after activation', async () => {
    const { userData, install, definition } = await fixture();
    await writeFile(join(install.binariesDir, 'd3d9.dll'), 'original d3d9', { encoding: 'utf-8' });
    const manager = new DxvkManager(userData, logger(), definition);
    await manager.prepareForLaunch(install, true);
    await writeFile(join(install.binariesDir, 'd3d9.dll'), 'changed externally', {
      encoding: 'utf-8'
    });

    await expect(manager.restore(install)).rejects.toThrow('changed after DXVK/Vulkan activation');
    expect(await readFile(join(install.binariesDir, 'd3d9.dll'), { encoding: 'utf-8' })).toBe(
      'changed externally'
    );
    expect(
      await readFile(join(install.binariesDir, 'd3d9.dll.commonwealth-original'), {
        encoding: 'utf-8'
      })
    ).toBe('original d3d9');
  });

  it('recovers an interrupted activation from its marker and verified backups', async () => {
    const { userData, install, definition } = await fixture(true);
    await writeFile(join(install.binariesDir, 'd3d9.dll'), 'original d3d9', { encoding: 'utf-8' });
    const manager = new DxvkManager(userData, logger(), definition);
    await manager.prepareForLaunch(install, true);
    const markerPath = join(install.binariesDir, '.commonwealth-dxvk.json');
    const marker = JSON.parse(await readFile(markerPath, { encoding: 'utf-8' })) as {
      phase: string;
    };
    marker.phase = 'activating';
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { encoding: 'utf-8' });
    await rm(join(install.binariesDir, 'd3d9.dll'));

    const restored = await manager.restore(install);
    expect(restored.status).toBe('external');
    expect(restored.rendererSetting).toBe('directx-10');
    expect(await readFile(join(install.binariesDir, 'd3d9.dll'), { encoding: 'utf-8' })).toBe(
      'original d3d9'
    );
    for (const name of ['d3d10core.dll', 'd3d11.dll', 'dxgi.dll']) {
      expect(await isFile(join(install.binariesDir, name))).toBe(false);
    }
    expect(await isFile(markerPath)).toBe(false);
  });

  it('switches DirectX 10 off without changing unrelated INI content before activation', async () => {
    const { userData, install, definition } = await fixture(true);
    const originalIni =
      '[Other]\r\nKeepMe=42\r\n[SystemSettings]\r\n' +
      'AllowD3D10=True ; first\r\nAllowD3D10 = True\r\n';
    await writeFile(join(install.configDir, 'TgEngine.ini'), originalIni, { encoding: 'utf-8' });
    await writeFile(join(install.binariesDir, 'd3d9.dll'), 'original d3d9', { encoding: 'utf-8' });
    const manager = new DxvkManager(userData, logger(), definition);

    const active = await manager.prepareForLaunch(install, true);
    expect(active.status).toBe('active');
    expect(active.rendererSetting).toBe('directx-9');
    expect(await readFile(join(install.configDir, 'TgEngine.ini'), { encoding: 'utf-8' })).toBe(
      '[Other]\r\nKeepMe=42\r\n[SystemSettings]\r\n' +
        'AllowD3D10=False ; first\r\nAllowD3D10 = False\r\n'
    );
    expect(
      await readFile(join(install.configDir, 'TgEngine.ini.commonwealth-backup'), {
        encoding: 'utf-8'
      })
    ).toBe(originalIni);
    expect(await readFile(join(install.binariesDir, 'd3d9.dll'), { encoding: 'utf-8' })).toBe(
      'DXVK payload for d3d9.dll'
    );
    expect(await isFile(join(install.binariesDir, '.commonwealth-dxvk.json'))).toBe(true);

    const marker = JSON.parse(
      await readFile(join(install.binariesDir, '.commonwealth-dxvk.json'), {
        encoding: 'utf-8'
      })
    ) as { schemaVersion: number; originalRenderer: { setting: string } };
    expect(marker.schemaVersion).toBe(3);
    expect(marker.originalRenderer.setting).toBe('directx-10');

    const restartedManager = new DxvkManager(userData, logger(), definition);
    const restored = await restartedManager.prepareForLaunch(install, false);
    expect(restored.rendererSetting).toBe('directx-10');
    expect(await readFile(join(install.configDir, 'TgEngine.ini'), { encoding: 'utf-8' })).toBe(
      originalIni
    );
    expect(await isFile(join(install.binariesDir, '.commonwealth-dxvk.json'))).toBe(false);
  });

  it('restores the previous renderer without reverting unrelated INI changes made while active', async () => {
    const { userData, install, definition } = await fixture(true);
    const manager = new DxvkManager(userData, logger(), definition);
    await manager.prepareForLaunch(install, true);
    const activeIni = await readFile(join(install.configDir, 'TgEngine.ini'), {
      encoding: 'utf-8'
    });
    await writeFile(
      join(install.configDir, 'TgEngine.ini'),
      `${activeIni}[Other]\r\nKeepAfterDxvk=True\r\n`,
      { encoding: 'utf-8' }
    );

    const restored = await manager.prepareForLaunch(install, false);
    const restoredIni = await readFile(join(install.configDir, 'TgEngine.ini'), {
      encoding: 'utf-8'
    });
    expect(restored.rendererSetting).toBe('directx-10');
    expect(restoredIni).toContain('AllowD3D10=True');
    expect(restoredIni).toContain('[Other]\r\nKeepAfterDxvk=True');
  });

  it('restores a renderer directive with trailing spaces and no final newline exactly', async () => {
    const { userData, install, definition } = await fixture(true);
    const originalIni = '[SystemSettings]\nAllowD3D10=True   ';
    await writeFile(join(install.configDir, 'TgEngine.ini'), originalIni, { encoding: 'utf-8' });
    const manager = new DxvkManager(userData, logger(), definition);

    await manager.prepareForLaunch(install, true);
    await manager.prepareForLaunch(install, false);
    expect(await readFile(join(install.configDir, 'TgEngine.ini'), { encoding: 'utf-8' })).toBe(
      originalIni
    );
  });

  it.each([
    ['missing setting', '[Other]\nKeepMe=True\n'],
    ['missing setting without a trailing newline', '[Other]\nKeepMe=True'],
    ['missing setting with trailing blank lines', '[Other]\nKeepMe=True\n\n'],
    ['removal only', '[SystemSettings]\n-AllowD3D10\n\n[Other]\nKeepMe=True\n'],
    [
      'assignment followed by removal',
      '[SystemSettings]\nAllowD3D10=True\n-AllowD3D10\n\n[Other]\nKeepMe=True\n'
    ]
  ])('adds the DX9 setting to SystemSettings when it has %s', async (_case, contents) => {
    const { userData, install, definition } = await fixture();
    await writeFile(join(install.configDir, 'TgEngine.ini'), contents, { encoding: 'utf-8' });
    const manager = new DxvkManager(userData, logger(), definition);

    const active = await manager.prepareForLaunch(install, true);
    const updated = await readFile(join(install.configDir, 'TgEngine.ini'), {
      encoding: 'utf-8'
    });
    expect(active.rendererSetting).toBe('directx-9');
    expect(updated).toContain('AllowD3D10=False');
    expect(updated).toContain('KeepMe=True');
    expect(detectConfiguredRenderer(updated)).toBe('directx-9');

    const restored = await manager.prepareForLaunch(install, false);
    expect(restored.rendererSetting).toBe('unknown');
    expect(await readFile(join(install.configDir, 'TgEngine.ini'), { encoding: 'utf-8' })).toBe(
      contents
    );
  });

  it('restores every DLL from a legacy four-file marker before using the DX9-only flow', async () => {
    const { userData, install, definition } = await fixture(true);
    const files: Record<string, { originalSha256: string | null; dxvkSha256: string; backupName: string }> = {};
    for (const name of DXVK_ARCHIVE_DLL_NAMES) {
      const payload = `DXVK payload for ${name}`;
      const original = name === 'd3d9.dll' || name === 'dxgi.dll' ? `original ${name}` : null;
      await writeFile(join(install.binariesDir, name), payload, { encoding: 'utf-8' });
      if (original !== null) {
        await writeFile(join(install.binariesDir, `${name}.commonwealth-original`), original, {
          encoding: 'utf-8'
        });
      }
      files[name] = {
        originalSha256: original === null ? null : digest(original),
        dxvkSha256: digest(payload),
        backupName: `${name}.commonwealth-original`
      };
    }
    await writeFile(
      join(install.binariesDir, '.commonwealth-dxvk.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        owner: 'commonwealth-ga-launcher',
        version: definition.version,
        phase: 'active',
        files
      })}\n`,
      { encoding: 'utf-8' }
    );
    const manager = new DxvkManager(userData, logger(), definition);

    const active = await manager.prepareForLaunch(install, true);
    expect(active.status).toBe('active');
    expect(active.rendererSetting).toBe('directx-9');
    expect(await readFile(join(install.binariesDir, 'd3d9.dll'), { encoding: 'utf-8' })).toBe(
      'DXVK payload for d3d9.dll'
    );
    expect(await readFile(join(install.binariesDir, 'dxgi.dll'), { encoding: 'utf-8' })).toBe(
      'original dxgi.dll'
    );
    expect(await isFile(join(install.binariesDir, 'd3d10core.dll'))).toBe(false);
    expect(await isFile(join(install.binariesDir, 'd3d11.dll'))).toBe(false);
    expect(await isFile(join(install.binariesDir, '.commonwealth-dxvk.json'))).toBe(true);
    expect(await isFile(join(install.binariesDir, 'd3d9.dll.commonwealth-original'))).toBe(true);
    expect(await isFile(join(install.binariesDir, 'dxgi.dll.commonwealth-original'))).toBe(false);

    const restored = await manager.prepareForLaunch(install, false);
    expect(restored.status).toBe('external');
    expect(await readFile(join(install.binariesDir, 'd3d9.dll'), { encoding: 'utf-8' })).toBe(
      'original d3d9.dll'
    );
    expect(restored.rendererSetting).toBe('directx-10');
  });
});

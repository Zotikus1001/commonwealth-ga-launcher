import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyClientPatch,
  ensureClientConfiguration,
  inspectClientPatches,
  removeClientPatch
} from '../src/main/services/IniFixes';
import { DEFAULT_LOGIN_MAP } from '../src/shared/loginMaps';
import type { GameInstall } from '../src/main/services/InstallLocator';
import type { Log } from '../src/main/services/Log';
import { managedIniBackupDirectory } from '../src/main/services/ManagedInstallState';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function logger(): Log {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Log;
}

async function fixture(engineText: string, defaultText = engineText): Promise<{
  install: GameInstall;
  userData: string;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), 'commonwealth-ini-performance-'));
  roots.push(rootDir);
  const binariesDir = join(rootDir, 'Binaries');
  const configDir = join(rootDir, 'TgGame', 'Config');
  await mkdir(binariesDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'TgEngine.ini'), engineText, { encoding: 'utf-8' });
  await writeFile(join(configDir, 'DefaultEngine.ini'), defaultText, { encoding: 'utf-8' });
  await writeFile(join(configDir, 'TgUI.ini'), '', { encoding: 'utf-8' });
  await writeFile(join(configDir, 'DefaultUI.ini'), '', { encoding: 'utf-8' });
  return {
    userData: join(rootDir, 'user-data'),
    install: {
      exePath: join(binariesDir, 'GlobalAgenda.exe'),
      binariesDir,
      rootDir,
      configDir
    }
  };
}

describe('adaptive client performance INI patch', () => {
  it('changes only its two settings, preserves formatting, and is idempotent', async () => {
    const original =
      '[TextureStreaming]\r\n' +
      'PoolSize = 158 ; original budget\r\n' +
      'StopStreamingLimit=8\r\n' +
      '\r\n' +
      '[Engine.ISVHacks]\r\n' +
      'bInitializeShadersOnDemand=True ; original mode\r\n' +
      'UseMinimalNVIDIADriverShaderOptimization=True\r\n';
    const { install, userData } = await fixture(original);
    const backupDirectory = managedIniBackupDirectory(userData, install);

    const first = await applyClientPatch(
      install,
      'adaptive-client-performance',
      logger(),
      backupDirectory,
      1_024
    );
    expect(first.changedFiles).toHaveLength(2);
    const active = await readFile(join(install.configDir, 'TgEngine.ini'), { encoding: 'utf-8' });
    expect(active).toContain('PoolSize = 1024 ; original budget\r\n');
    expect(active).toContain('bInitializeShadersOnDemand=False ; original mode\r\n');
    expect(active).toContain('StopStreamingLimit=8\r\n');
    expect(active).toContain('UseMinimalNVIDIADriverShaderOptimization=True\r\n');
    expect(await readFile(join(backupDirectory, 'TgEngine.ini.commonwealth-backup'), {
      encoding: 'utf-8'
    })).toBe(original);
    await expect(
      readFile(join(install.configDir, 'TgEngine.ini.commonwealth-backup'))
    ).rejects.toThrow();

    const status = (await inspectClientPatches(install)).find(
      (patch) => patch.id === 'adaptive-client-performance'
    );
    expect(status?.applied).toBe(true);
    const second = await applyClientPatch(
      install,
      'adaptive-client-performance',
      logger(),
      backupDirectory,
      1_024
    );
    expect(second.changedFiles).toHaveLength(0);
  });

  it('adds active values after Unreal removal directives', async () => {
    const { install, userData } = await fixture(
      '[TextureStreaming]\nPoolSize=158\n-PoolSize\n' +
        '[Engine.ISVHacks]\nbInitializeShadersOnDemand=True\n-bInitializeShadersOnDemand\n'
    );
    await applyClientPatch(
      install,
      'adaptive-client-performance',
      logger(),
      managedIniBackupDirectory(userData, install),
      768
    );
    const active = await readFile(join(install.configDir, 'TgEngine.ini'), { encoding: 'utf-8' });
    expect(active).toContain('-PoolSize\n+PoolSize=768\n');
    expect(active).toContain('-bInitializeShadersOnDemand\n+bInitializeShadersOnDemand=False\n');
  });

  it('moves a legacy first backup even when no INI change is needed', async () => {
    const current =
      '[TextureStreaming]\nPoolSize=768\n' +
      '[Engine.ISVHacks]\nbInitializeShadersOnDemand=False\n';
    const { install, userData } = await fixture(current);
    const legacyPath = join(install.configDir, 'TgEngine.ini.commonwealth-backup');
    await writeFile(legacyPath, 'original first backup', { encoding: 'utf-8' });
    const backupDirectory = managedIniBackupDirectory(userData, install);

    await applyClientPatch(
      install,
      'adaptive-client-performance',
      logger(),
      backupDirectory,
      768
    );

    expect(
      await readFile(join(backupDirectory, 'TgEngine.ini.commonwealth-backup'), {
        encoding: 'utf-8'
      })
    ).toBe('original first backup');
    await expect(readFile(legacyPath)).rejects.toThrow();
  });

  it('keeps the launcher first backup when a stale legacy backup also exists', async () => {
    const current =
      '[TextureStreaming]\nPoolSize=768\n' +
      '[Engine.ISVHacks]\nbInitializeShadersOnDemand=False\n';
    const { install, userData } = await fixture(current);
    const backupDirectory = managedIniBackupDirectory(userData, install);
    const managedPath = join(backupDirectory, 'TgEngine.ini.commonwealth-backup');
    const legacyPath = join(install.configDir, 'TgEngine.ini.commonwealth-backup');
    await mkdir(backupDirectory, { recursive: true });
    await writeFile(managedPath, 'launcher first backup', { encoding: 'utf-8' });
    await writeFile(legacyPath, 'stale legacy backup', { encoding: 'utf-8' });

    await applyClientPatch(
      install,
      'adaptive-client-performance',
      logger(),
      backupDirectory,
      768
    );

    expect(await readFile(managedPath, { encoding: 'utf-8' })).toBe('launcher first backup');
    await expect(readFile(legacyPath)).rejects.toThrow();
  });

  it('removes only its own settings and preserves later unrelated changes', async () => {
    const original =
      '[Engine.Player]\r\n' +
      'ConfiguredInternetSpeed=10000\r\n' +
      'ConfiguredLanSpeed=20000\r\n' +
      '\r\n' +
      '[TextureStreaming]\r\n' +
      'PoolSize=158\r\n' +
      'StopStreamingLimit=8\r\n' +
      '\r\n' +
      '[Engine.ISVHacks]\r\n' +
      'bInitializeShadersOnDemand=True\r\n';
    const { install, userData } = await fixture(original);
    const backupDirectory = managedIniBackupDirectory(userData, install);

    await applyClientPatch(
      install,
      'adaptive-client-performance',
      logger(),
      backupDirectory,
      1_024
    );
    await applyClientPatch(
      install,
      'high-fps-movement-stability',
      logger(),
      backupDirectory
    );
    const activePath = join(install.configDir, 'TgEngine.ini');
    const changedOutsidePatch = (await readFile(activePath, { encoding: 'utf-8' })).replace(
      'StopStreamingLimit=8',
      'StopStreamingLimit=12 ; changed after apply'
    );
    await writeFile(activePath, changedOutsidePatch, { encoding: 'utf-8' });

    const result = await removeClientPatch(
      install,
      'adaptive-client-performance',
      logger(),
      backupDirectory
    );

    expect(result.changedFiles).toHaveLength(2);
    const restored = await readFile(activePath, { encoding: 'utf-8' });
    expect(restored).toContain('PoolSize=158\r\n');
    expect(restored).toContain('bInitializeShadersOnDemand=True\r\n');
    expect(restored).toContain('StopStreamingLimit=12 ; changed after apply\r\n');
    expect(restored).toContain('ConfiguredInternetSpeed=50000\r\n');
    expect(restored).toContain('ConfiguredLanSpeed=50000\r\n');
    expect(await inspectClientPatches(install)).toEqual([
      { id: 'high-fps-movement-stability', applied: true },
      { id: 'adaptive-client-performance', applied: false }
    ]);
  });

  it('can reapply a removed patch without replacing its first backup', async () => {
    const original =
      '[Engine.Player]\nConfiguredInternetSpeed=10000\nConfiguredLanSpeed=20000\n';
    const { install, userData } = await fixture(original);
    const backupDirectory = managedIniBackupDirectory(userData, install);

    await applyClientPatch(
      install,
      'high-fps-movement-stability',
      logger(),
      backupDirectory
    );
    await removeClientPatch(
      install,
      'high-fps-movement-stability',
      logger(),
      backupDirectory
    );
    await applyClientPatch(
      install,
      'high-fps-movement-stability',
      logger(),
      backupDirectory
    );

    expect(await readFile(join(backupDirectory, 'TgEngine.ini.commonwealth-backup'), {
      encoding: 'utf-8'
    })).toBe(original);
    expect((await inspectClientPatches(install))[0].applied).toBe(true);
  });

  it('can disable a patch when original settings already match it', async () => {
    const original =
      '[Engine.Player]\nConfiguredInternetSpeed=50000\nConfiguredLanSpeed=50000\n';
    const { install, userData } = await fixture(original);
    const backupDirectory = managedIniBackupDirectory(userData, install);

    await applyClientPatch(
      install,
      'high-fps-movement-stability',
      logger(),
      backupDirectory
    );
    const result = await removeClientPatch(
      install,
      'high-fps-movement-stability',
      logger(),
      backupDirectory
    );

    expect(result.changedFiles).toHaveLength(0);
    expect(await readFile(join(install.configDir, 'TgEngine.ini'), {
      encoding: 'utf-8'
    })).toBe(original);
  });

  it('removes a section added by the patch without leaving separator bytes behind', async () => {
    const original = '[Core.System]\r\nPaths=../System/*.u\r\n';
    const { install, userData } = await fixture(original);
    const backupDirectory = managedIniBackupDirectory(userData, install);

    await applyClientPatch(
      install,
      'high-fps-movement-stability',
      logger(),
      backupDirectory
    );
    await removeClientPatch(
      install,
      'high-fps-movement-stability',
      logger(),
      backupDirectory
    );

    expect(await readFile(join(install.configDir, 'TgEngine.ini'), {
      encoding: 'utf-8'
    })).toBe(original);
    expect(await readFile(join(install.configDir, 'DefaultEngine.ini'), {
      encoding: 'utf-8'
    })).toBe(original);
  });

  it('removes both adaptive sections when the patch added them', async () => {
    const original = '[Core.System]\nPaths=../System/*.u\n';
    const { install, userData } = await fixture(original);
    const backupDirectory = managedIniBackupDirectory(userData, install);

    await applyClientPatch(
      install,
      'adaptive-client-performance',
      logger(),
      backupDirectory,
      1_024
    );
    await removeClientPatch(
      install,
      'adaptive-client-performance',
      logger(),
      backupDirectory
    );

    expect(await readFile(join(install.configDir, 'TgEngine.ini'), {
      encoding: 'utf-8'
    })).toBe(original);
    expect(await readFile(join(install.configDir, 'DefaultEngine.ini'), {
      encoding: 'utf-8'
    })).toBe(original);
  });

  it('does not reapply patches disabled for future launches', async () => {
    const original =
      '[Engine.Player]\nConfiguredInternetSpeed=10000\nConfiguredLanSpeed=20000\n' +
      '[TextureStreaming]\nPoolSize=158\n' +
      '[Engine.ISVHacks]\nbInitializeShadersOnDemand=True\n';
    const { install, userData } = await fixture(original);

    await ensureClientConfiguration(
      install,
      DEFAULT_LOGIN_MAP,
      false,
      false,
      144,
      1_024,
      {
        gameClientPatch: true,
        highFpsMovementStability: false,
        adaptiveClientPerformance: false
      },
      logger(),
      managedIniBackupDirectory(userData, install)
    );

    const active = await readFile(join(install.configDir, 'TgEngine.ini'), { encoding: 'utf-8' });
    expect(active).toContain('ConfiguredInternetSpeed=10000\n');
    expect(active).toContain('ConfiguredLanSpeed=20000\n');
    expect(active).toContain('PoolSize=158\n');
    expect(active).toContain('bInitializeShadersOnDemand=True\n');
    expect(await inspectClientPatches(install)).toEqual([
      { id: 'high-fps-movement-stability', applied: false },
      { id: 'adaptive-client-performance', applied: false }
    ]);
  });
});

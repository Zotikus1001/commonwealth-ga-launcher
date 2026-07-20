import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_GAME_PROFILES } from '../src/shared/gameProfiles';
import { GameProfileManager } from '../src/main/services/GameProfileManager';
import type { GameInstall } from '../src/main/services/InstallLocator';
import type { Log } from '../src/main/services/Log';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function testLog(): Log {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as unknown as Log;
}

async function testInstall(root: string): Promise<GameInstall> {
  const rootDir = join(root, 'Global Agenda');
  const binariesDir = join(rootDir, 'Binaries');
  const configDir = join(rootDir, 'TgGame', 'Config');
  await Promise.all([
    mkdir(binariesDir, { recursive: true }),
    mkdir(configDir, { recursive: true })
  ]);
  return {
    exePath: join(binariesDir, 'GlobalAgenda.exe'),
    binariesDir,
    rootDir,
    configDir
  };
}

async function newRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe('game settings profiles', () => {
  it('captures exact active Tg INI bytes and restores only the saved files', async () => {
    const root = await newRoot('commonwealth-profiles-');
    const install = await testInstall(root);
    const userData = join(root, 'user-data');
    const engine = Buffer.from([0xff, 0xfe, 0x5b, 0x00, 0x41, 0x00, 0x5d, 0x00]);
    await Promise.all([
      writeFile(join(install.configDir, 'TgEngine.ini'), engine),
      writeFile(join(install.configDir, 'TgInput.ini'), '[Bindings]\r\nJump=Space\r\n', {
        encoding: 'utf-8'
      }),
      writeFile(join(install.configDir, 'DefaultEngine.ini'), 'default', { encoding: 'utf-8' }),
      writeFile(join(install.configDir, 'TgEngine.ini.commonwealth-backup'), 'backup', {
        encoding: 'utf-8'
      }),
      writeFile(join(install.configDir, 'readme.ini'), 'unrelated', { encoding: 'utf-8' })
    ]);

    const manager = new GameProfileManager(userData, testLog());
    const created = await manager.create('  High Quality  ', install);
    expect(created).toMatchObject({ name: 'High Quality', fileCount: 2 });
    expect(manager.getSnapshot().selectedProfileId).toBe(created.id);

    await Promise.all([
      writeFile(join(install.configDir, 'TgEngine.ini'), 'changed', { encoding: 'utf-8' }),
      writeFile(join(install.configDir, 'TgInput.ini'), 'changed', { encoding: 'utf-8' }),
      writeFile(join(install.configDir, 'DefaultEngine.ini'), 'new-default', { encoding: 'utf-8' }),
      writeFile(join(install.configDir, 'TgUI.ini'), 'new-unsaved-file', { encoding: 'utf-8' })
    ]);

    await expect(manager.applySelected(install)).resolves.toMatchObject({
      id: created.id,
      name: 'High Quality',
      fileCount: 2
    });
    expect(await readFile(join(install.configDir, 'TgEngine.ini'))).toEqual(engine);
    expect(await readFile(join(install.configDir, 'TgInput.ini'), { encoding: 'utf-8' })).toBe(
      '[Bindings]\r\nJump=Space\r\n'
    );
    expect(await readFile(join(install.configDir, 'DefaultEngine.ini'), { encoding: 'utf-8' })).toBe(
      'new-default'
    );
    expect(await readFile(join(install.configDir, 'TgUI.ini'), { encoding: 'utf-8' })).toBe(
      'new-unsaved-file'
    );
  });

  it('persists profile order, selection, renames, and refreshed snapshots', async () => {
    const root = await newRoot('commonwealth-profile-persistence-');
    const install = await testInstall(root);
    const userData = join(root, 'user-data');
    await writeFile(join(install.configDir, 'TgEngine.ini'), 'quality=low', { encoding: 'utf-8' });

    const manager = new GameProfileManager(userData, testLog());
    const first = await manager.create('Low', install);
    await writeFile(join(install.configDir, 'TgEngine.ini'), 'quality=high', { encoding: 'utf-8' });
    const second = await manager.create('High', install);
    const renamed = await manager.renameProfile(first.id, 'Performance');
    expect(renamed.updatedAt).toBe(first.updatedAt);
    await manager.select(first.id);
    await writeFile(join(install.configDir, 'TgEngine.ini'), 'quality=competitive', {
      encoding: 'utf-8'
    });
    await manager.overwrite(first.id, install);

    const reloaded = new GameProfileManager(userData, testLog());
    await reloaded.load();
    expect(reloaded.getSnapshot()).toEqual({
      profiles: [
        expect.objectContaining({ id: first.id, name: 'Performance', fileCount: 1 }),
        expect.objectContaining({ id: second.id, name: 'High', fileCount: 1 })
      ],
      selectedProfileId: first.id
    });

    await writeFile(join(install.configDir, 'TgEngine.ini'), 'quality=other', { encoding: 'utf-8' });
    await reloaded.applySelected(install);
    expect(await readFile(join(install.configDir, 'TgEngine.ini'), { encoding: 'utf-8' })).toBe(
      'quality=competitive'
    );

    await reloaded.deleteProfile(first.id);
    expect(reloaded.getSnapshot()).toMatchObject({
      profiles: [expect.objectContaining({ id: second.id })],
      selectedProfileId: second.id
    });
  });

  it('enforces the five-profile limit and reset clears all profile data', async () => {
    const root = await newRoot('commonwealth-profile-limit-');
    const install = await testInstall(root);
    const userData = join(root, 'user-data');
    await writeFile(join(install.configDir, 'TgEngine.ini'), 'settings', { encoding: 'utf-8' });
    const manager = new GameProfileManager(userData, testLog());

    for (let index = 1; index <= MAX_GAME_PROFILES; index++) {
      await manager.create(`Profile ${index}`, install);
    }
    await expect(manager.create('Profile 6', install)).rejects.toThrow('up to 5');

    await manager.reset();
    expect(manager.getSnapshot()).toEqual({ profiles: [], selectedProfileId: null });
    const reloaded = new GameProfileManager(userData, testLog());
    await reloaded.load();
    expect(reloaded.getSnapshot()).toEqual({ profiles: [], selectedProfileId: null });
  });

  it('refuses to mutate a corrupt profile store', async () => {
    const root = await newRoot('commonwealth-profile-corrupt-');
    const install = await testInstall(root);
    const userData = join(root, 'user-data');
    await writeFile(join(install.configDir, 'TgEngine.ini'), 'settings', { encoding: 'utf-8' });
    const manager = new GameProfileManager(userData, testLog());
    const created = await manager.create('Safe copy', install);
    const profilePath = join(userData, 'game-profiles', `${created.id}.json`);
    const stored = JSON.parse(await readFile(profilePath, { encoding: 'utf-8' })) as {
      files: { contents: string }[];
    };
    stored.files[0].contents = 'AAAA';
    await writeFile(profilePath, JSON.stringify(stored), { encoding: 'utf-8' });

    const reloaded = new GameProfileManager(userData, testLog());
    await reloaded.load();
    expect(reloaded.getSnapshot()).toEqual({ profiles: [], selectedProfileId: null });
    await expect(reloaded.create('Do not overwrite', install)).rejects.toThrow(
      'Game profiles could not be loaded'
    );
  });
});

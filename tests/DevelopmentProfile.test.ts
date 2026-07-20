import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureDevelopmentProfile } from '../src/main/services/DevelopmentProfile';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('development profile', () => {
  it('moves unpackaged user and session data into a sibling development directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commonwealth-development-profile-'));
    roots.push(root);
    const defaultUserDataDir = join(root, 'Commonwealth GA Launcher');
    const developmentUserDataDir = join(root, 'Commonwealth GA Launcher Development');
    const setPath = vi.fn();

    configureDevelopmentProfile({
      isPackaged: false,
      getPath: vi.fn(() => defaultUserDataDir),
      setPath
    });

    expect(setPath.mock.calls).toEqual([
      ['userData', developmentUserDataDir],
      ['sessionData', developmentUserDataDir]
    ]);
    expect((await stat(developmentUserDataDir)).isDirectory()).toBe(true);
  });

  it('leaves packaged launcher paths unchanged', () => {
    const getPath = vi.fn();
    const setPath = vi.fn();

    configureDevelopmentProfile({ isPackaged: true, getPath, setPath });

    expect(getPath).not.toHaveBeenCalled();
    expect(setPath).not.toHaveBeenCalled();
  });
});

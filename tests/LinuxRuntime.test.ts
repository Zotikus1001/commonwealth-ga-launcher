import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../src/shared/types';

vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof import('os')>();
  return { ...original, homedir: vi.fn() };
});

import { homedir } from 'os';
import { listLinuxRuntimeOptions } from '../src/main/services/LinuxRuntime';

const roots: string[] = [];

afterEach(async () => {
  vi.mocked(homedir).mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function settings(): Settings {
  return {
    gameExePath: '',
    linux: {
      runner: 'proton',
      winePath: '',
      protonPath: '',
      umuPath: '',
      winePrefix: '',
      gameMode: false,
      wineDebug: false
    }
  } as Settings;
}

describe('Linux Proton discovery', () => {
  it('deduplicates Steam aliases that resolve to the same Proton executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commonwealth-linux-runtime-'));
    roots.push(root);
    vi.mocked(homedir).mockReturnValue(root);
    const steam = join(root, '.local', 'share', 'Steam');
    const tool = join(steam, 'compatibilitytools.d', 'GE-Proton-Test');
    await mkdir(tool, { recursive: true });
    await writeFile(join(tool, 'proton'), '#!/bin/sh\n', { mode: 0o755 });
    await mkdir(join(root, '.steam'), { recursive: true });
    await symlink(steam, join(root, '.steam', 'root'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(steam, join(root, '.steam', 'steam'), process.platform === 'win32' ? 'junction' : 'dir');

    const options = await listLinuxRuntimeOptions(settings(), {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as never);

    expect(options.protonRunners).toEqual([
      { label: 'GE-Proton-Test', path: join(root, '.steam', 'root', 'compatibilitytools.d', 'GE-Proton-Test') }
    ]);
  });
});

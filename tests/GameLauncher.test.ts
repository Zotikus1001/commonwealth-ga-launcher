import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertLinuxWrapperExecutable,
  buildLinuxLaunchCommand
} from '../src/main/services/GameLauncher';
import { defaultSettings } from '../src/main/services/ConfigStore';
import type { LinuxRuntimeInspection } from '../src/main/services/LinuxRuntime';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function readyRuntime(): LinuxRuntimeInspection {
  return {
    status: 'ready',
    prefixPath: '/prefix',
    winePath: '/usr/bin/wine',
    protonPath: '/opt/GE-Proton',
    umuPath: '/usr/bin/umu-run',
    gameModePath: '/usr/bin/gamemoderun',
    steamPrefixPath: '',
    suggestedPrefixPath: ''
  };
}

describe('Linux game launch composition', () => {
  it('preserves the direct Wine command with the default template', () => {
    const settings = defaultSettings();
    settings.gameExePath = '/games/GlobalAgenda.exe';

    expect(buildLinuxLaunchCommand(settings, readyRuntime(), ['-host=test'])).toEqual({
      command: '/usr/bin/wine',
      args: ['/games/GlobalAgenda.exe', '-host=test'],
      env: {
        WINEPREFIX: '/prefix',
        WINEDEBUG: '-all'
      }
    });
  });

  it('wraps built-in GameMode inside taskset', () => {
    const settings = defaultSettings();
    settings.gameExePath = '/games/GlobalAgenda.exe';
    settings.linux.gameMode = true;
    settings.linux.commandTemplate = 'taskset -c 0,1,2,4,5,6 %command%';

    expect(buildLinuxLaunchCommand(settings, readyRuntime(), ['-tcp=300'])).toMatchObject({
      command: 'taskset',
      args: [
        '-c',
        '0,1,2,4,5,6',
        '/usr/bin/gamemoderun',
        '/usr/bin/wine',
        '/games/GlobalAgenda.exe',
        '-tcp=300'
      ]
    });
  });

  it('keeps Proton behind UMU when a wrapper is active', () => {
    const settings = defaultSettings();
    settings.gameExePath = '/games/GlobalAgenda.exe';
    settings.linux.runner = 'proton';
    settings.linux.commandTemplate = 'env DXVK_ASYNC=1 %command%';

    expect(buildLinuxLaunchCommand(settings, readyRuntime(), ['-seekfreeloading'])).toEqual({
      command: 'env',
      args: [
        'DXVK_ASYNC=1',
        '/usr/bin/umu-run',
        '/games/GlobalAgenda.exe',
        '-seekfreeloading'
      ],
      env: {
        WINEPREFIX: '/prefix',
        PROTONPATH: '/opt/GE-Proton'
      }
    });
  });

  it('fails clearly when the first wrapper executable cannot be found', () => {
    expect(() =>
      assertLinuxWrapperExecutable(
        'missing-commonwealth-wrapper',
        '/usr/bin/wine',
        { PATH: '' },
        process.cwd()
      )
    ).toThrow(
      'Linux command wrapper executable was not found or is not executable: missing-commonwealth-wrapper'
    );
  });

  it('finds a wrapper executable on PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commonwealth-wrapper-'));
    roots.push(root);
    const executable = join(root, 'wrapper-tool');
    await writeFile(executable, '#!/bin/sh\n', { encoding: 'utf-8', mode: 0o755 });

    expect(() =>
      assertLinuxWrapperExecutable(
        'wrapper-tool',
        '/usr/bin/wine',
        { PATH: [root, join(root, 'other')].join(delimiter) },
        root
      )
    ).not.toThrow();
  });

  it('resolves relative PATH entries from the game working directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commonwealth-wrapper-relative-'));
    roots.push(root);
    const executable = join(root, 'relative-wrapper');
    await writeFile(executable, '#!/bin/sh\n', { encoding: 'utf-8', mode: 0o755 });

    expect(() =>
      assertLinuxWrapperExecutable(
        'relative-wrapper',
        '/usr/bin/wine',
        { PATH: '.' },
        root
      )
    ).not.toThrow();
  });
});

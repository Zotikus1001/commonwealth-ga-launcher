import { describe, expect, it } from 'vitest';
import {
  expandLinuxCommandTemplate,
  GAMESCOPE_COMMAND_TEMPLATE_EXAMPLE,
  validateLinuxCommandTemplate
} from '../src/shared/linuxCommandTemplate';

describe('Linux command wrapper templates', () => {
  it('accepts the default and the Gamescope example', () => {
    expect(validateLinuxCommandTemplate('%command%')).toBeNull();
    expect(validateLinuxCommandTemplate(GAMESCOPE_COMMAND_TEMPLATE_EXAMPLE)).toBeNull();
  });

  it('expands a taskset and env chain as shell-free arguments', () => {
    const result = expandLinuxCommandTemplate(
      'taskset -c 0,1,2 env CACHE="$HOME/GA Shader Cache" DXVK_ASYNC=1 %command%',
      '/usr/bin/umu-run',
      ['/games/GlobalAgenda.exe', '-host=commonwealth.ydns.eu'],
      { HOME: '/home/zax' }
    );

    expect(result).toEqual({
      command: 'taskset',
      args: [
        '-c',
        '0,1,2',
        'env',
        'CACHE=/home/zax/GA Shader Cache',
        'DXVK_ASYNC=1',
        '/usr/bin/umu-run',
        '/games/GlobalAgenda.exe',
        '-host=commonwealth.ydns.eu'
      ]
    });
  });

  it('preserves single-quoted variables and expands braced variables', () => {
    const result = expandLinuxCommandTemplate(
      "env LITERAL='$HOME' CACHE=${HOME}/cache %command%",
      'wine',
      ['GlobalAgenda.exe'],
      { HOME: '/home/player' }
    );

    expect(result.args).toEqual([
      'LITERAL=$HOME',
      'CACHE=/home/player/cache',
      'wine',
      'GlobalAgenda.exe'
    ]);
  });

  it.each([
    ['', 'exactly one standalone %command%'],
    ['gamescope --', 'exactly one standalone %command%'],
    ['%command% %command%', 'exactly one standalone %command%'],
    ['gamescope prefix-%command%', 'as a standalone argument'],
    ['gamescope %command% && touch /tmp/x', 'shell operator is not supported'],
    ['gamescope $(touch /tmp/x) %command%', 'command substitution is not supported'],
    ['gamescope `touch /tmp/x` %command%', 'command substitution is not supported'],
    ['gamescope "unterminated %command%', 'unterminated double-quoted argument'],
    ['gamescope %command% \\', 'incomplete escape']
  ])('rejects invalid template %j', (template, message) => {
    expect(validateLinuxCommandTemplate(template)).toContain(message);
  });

  it('reports an unset environment variable only when the command is expanded', () => {
    const template = 'env CACHE="$MISSING/cache" %command%';
    expect(validateLinuxCommandTemplate(template)).toBeNull();
    expect(() => expandLinuxCommandTemplate(template, 'wine', [], {})).toThrow(
      'environment variable is not set: MISSING'
    );
  });

  it('rejects malformed environment references and oversized templates', () => {
    expect(validateLinuxCommandTemplate('env CACHE=${HOME %command%')).toContain(
      'unterminated environment variable'
    );
    expect(validateLinuxCommandTemplate(`gamescope ${'x'.repeat(4_096)} %command%`)).toContain(
      '4096 characters or fewer'
    );
  });

  it('allows shell-looking text when it is a quoted literal argument', () => {
    expect(
      expandLinuxCommandTemplate("%command% '--literal|argument'", 'wine', [], {})
    ).toEqual({
      command: 'wine',
      args: ['--literal|argument']
    });
  });
});

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameProcessTracker } from '../src/main/services/GameProcessTracker';
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

describe('launcher-started game process tracking', () => {
  it('persists live PIDs across launcher instances and clears them after exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commonwealth-game-processes-'));
    roots.push(root);
    const live = new Set([1234, 5678]);
    const exists = (pid: number): boolean => live.has(pid);
    const first = new GameProcessTracker(root, testLog(), exists);

    expect(await first.add(1234)).toBe(1);
    expect(await first.add(5678)).toBe(2);

    const reloaded = new GameProcessTracker(root, testLog(), exists);
    expect(await reloaded.refresh()).toBe(2);
    live.delete(1234);
    expect(await reloaded.refresh()).toBe(1);
    live.clear();
    expect(await reloaded.refresh()).toBe(0);

    const empty = new GameProcessTracker(root, testLog(), exists);
    expect(await empty.refresh()).toBe(0);
  });

  it('serializes a launch and exit recorded at nearly the same time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commonwealth-game-process-race-'));
    roots.push(root);
    const tracker = new GameProcessTracker(root, testLog(), () => false);
    const added = tracker.add(4321);
    const removed = tracker.remove(4321);
    await expect(Promise.all([added, removed])).resolves.toEqual([1, 0]);

    const reloaded = new GameProcessTracker(root, testLog(), () => false);
    expect(await reloaded.refresh()).toBe(0);
  });

  it('reset clears persisted tracking state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commonwealth-game-process-reset-'));
    roots.push(root);
    const tracker = new GameProcessTracker(root, testLog(), () => true);
    await tracker.add(1111);
    await tracker.reset();

    const reloaded = new GameProcessTracker(root, testLog(), () => true);
    expect(await reloaded.refresh()).toBe(0);
  });
});

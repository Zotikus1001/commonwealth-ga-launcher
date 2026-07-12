import { createRequire } from 'module';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { loadLauncherConfig } = require('../scripts/launcher-config.cjs') as {
  loadLauncherConfig: (options: { configPath: string }) => {
    clientPatch: {
      enabled: boolean;
      revision: string;
      url: string;
      size: number;
      sha256: string;
      publishedAt: string | null;
    };
  };
};

describe('launcher client patch configuration', () => {
  it('accepts a pinned immutable GitHub release asset', async () => {
    expect(
      loadLauncherConfig({ configPath: join(process.cwd(), 'launcher.config.yml') }).clientPatch
    ).toEqual({
      enabled: true,
      revision: '1',
      url: 'https://github.com/Zotikus1001/commonwealth-ga-client-patches/releases/download/client-patches-v1/Commonwealth-GA-Client-Patches-x86.dll',
      size: 407040,
      sha256: '39a34d90c8440f2b8163679cf0979d9735b6c6ae5e369e71fe1b5f3a06d1e1fb',
      publishedAt: null
    });
  });
});

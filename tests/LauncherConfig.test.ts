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
    dlcs: Array<{
      id: string;
      name: string;
      url: string;
      archiveSize: number;
      archiveSha256: string;
      files: Array<{
        archivePath: string;
        targetPath: string;
        size: number;
        sha256: string;
      }>;
    }>;
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

  it('pins the Surfside-Atoll archive and its exact installed files', () => {
    expect(
      loadLauncherConfig({ configPath: join(process.cwd(), 'launcher.config.yml') }).dlcs
    ).toEqual([
      {
        id: 'surfside-atoll-pvp-maps',
        name: 'Surfside-Atoll PvP Maps',
        url: 'https://commonwealth.ydns.eu/files/surfside-atoll.zip',
        archiveSize: 45272364,
        archiveSha256: '6e49e53642c237c1a8b9729afd62a844b2169418e686c22d61b7fe9cce272bc8',
        files: [
          {
            archivePath: 'Maps/3P_Beachhead/3P_Beachhead_P.ut3',
            targetPath: '3P_Beachhead/3P_Beachhead_P.ut3',
            size: 57488194,
            sha256: '6762d7dfb7f208b56227a967915d09707042a776497b7c8a2afefefba81a3641'
          },
          {
            archivePath: 'Maps/3P_Beachhead/3P_Beachhead_Sound.ut3',
            targetPath: '3P_Beachhead/3P_Beachhead_Sound.ut3',
            size: 220088,
            sha256: '382cdc8f1fb501b0e26d6a4477dfcab646765c581bd579bee96e7afc326ba49f'
          },
          {
            archivePath: 'Maps/3P_Beachhead2/3P_Beachhead2_P.ut3',
            targetPath: '3P_Beachhead2/3P_Beachhead2_P.ut3',
            size: 43009046,
            sha256: 'cada292ff6796b26d07fcb2c0cc4d1663b0ad3c62b01eb2a2da439171663d997'
          },
          {
            archivePath: 'Maps/3P_Beachhead2/3P_Beachhead2_Sound.ut3',
            targetPath: '3P_Beachhead2/3P_Beachhead2_Sound.ut3',
            size: 151483,
            sha256: '2a838000d9db4b2578e2615d3f9d7257012a60b1d2e82319fe570d2871f0840a'
          }
        ]
      }
    ]);
  });
});

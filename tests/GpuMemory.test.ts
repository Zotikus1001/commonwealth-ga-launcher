import { describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_TEXTURE_POOL_MB,
  GpuMemoryDetector,
  parseWindowsGpuBytes,
  selectTexturePoolMb,
  type GpuMemoryDependencies
} from '../src/main/services/GpuMemory';

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe('selectTexturePoolMb', () => {
  it('uses one quarter of detected VRAM with safe bounds and granularity', () => {
    expect(selectTexturePoolMb(2_048)).toBe(512);
    expect(selectTexturePoolMb(3_072)).toBe(768);
    expect(selectTexturePoolMb(4_096)).toBe(1_024);
    expect(selectTexturePoolMb(8_192)).toBe(2_048);
    expect(selectTexturePoolMb(24_576)).toBe(2_048);
  });

  it('uses 512 MB when GPU memory is unavailable or invalid', () => {
    expect(selectTexturePoolMb(null)).toBe(FALLBACK_TEXTURE_POOL_MB);
    expect(selectTexturePoolMb(0)).toBe(FALLBACK_TEXTURE_POOL_MB);
    expect(selectTexturePoolMb(Number.NaN)).toBe(FALLBACK_TEXTURE_POOL_MB);
  });
});

describe('Windows GPU memory parsing', () => {
  it('selects the launcher adapter ordinal from PowerShell JSON', () => {
    const output = JSON.stringify([{ bytes: '4294967296' }, { bytes: '8589934592' }]);
    expect(parseWindowsGpuBytes(output, 1)).toBe(8_589_934_592);
    expect(parseWindowsGpuBytes(output, 2)).toBeNull();
  });

  it('matches the primary game adapter by PCI identity instead of WMI order', () => {
    const output = JSON.stringify([
      { bytes: '17171480576', vendorId: 4318, deviceId: 9986, subSysId: 1360532578 },
      { bytes: '34190917632', vendorId: 4318, deviceId: 11141, subSysId: 1392579682 }
    ]);
    const gpuInfo = {
      gpuDevice: [
        { active: false, vendorId: 4318, deviceId: 9986, subSysId: 1360532578 },
        { active: true, vendorId: 4318, deviceId: 11141, subSysId: 1392579682 }
      ]
    };

    expect(parseWindowsGpuBytes(output, 0, gpuInfo)).toBe(34_190_917_632);
    expect(parseWindowsGpuBytes(output, 1, gpuInfo)).toBe(17_171_480_576);
  });
});

describe('GpuMemoryDetector', () => {
  it('selects a Windows adapter and derives its texture budget', async () => {
    const dependencies: GpuMemoryDependencies = {
      run: vi.fn().mockResolvedValue(JSON.stringify([
        { bytes: '2147483648', vendorId: 4318, deviceId: 1, subSysId: 10 },
        { bytes: '8589934592', vendorId: 4318, deviceId: 2, subSysId: 20 }
      ])),
      readText: vi.fn(),
      listDirectory: vi.fn(),
      getWindowsGpuInfo: vi.fn().mockResolvedValue({
        gpuDevice: [
          { active: true, vendorId: 4318, deviceId: 1, subSysId: 10 },
          { active: false, vendorId: 4318, deviceId: 2, subSysId: 20 }
        ]
      })
    };
    const selected = await new GpuMemoryDetector('win32', logger(), dependencies).select(1);
    expect(selected).toMatchObject({
      adapterIndex: 1,
      vramMb: 8_192,
      texturePoolMb: 2_048,
      source: 'windows'
    });
  });

  it('uses the selected Linux DRM card instead of the primary card', async () => {
    const dependencies: GpuMemoryDependencies = {
      run: vi.fn().mockRejectedValue(new Error('not needed')),
      listDirectory: vi.fn().mockResolvedValue(['renderD128', 'card1', 'card0']),
      readText: vi.fn(async (path: string) => {
        if (path.includes('card1') && path.endsWith('mem_info_vram_total')) {
          return String(8 * 1_024 * 1_024 * 1_024);
        }
        throw new Error('missing');
      })
    };
    const selected = await new GpuMemoryDetector('linux', logger(), dependencies).select(1);
    expect(selected).toMatchObject({
      adapterIndex: 1,
      vramMb: 8_192,
      texturePoolMb: 2_048,
      source: 'linux-drm'
    });
  });

  it('uses the selected Linux card PCI address for NVIDIA memory', async () => {
    const run = vi.fn().mockResolvedValue('8192\n');
    const dependencies: GpuMemoryDependencies = {
      run,
      listDirectory: vi.fn().mockResolvedValue(['card0']),
      readText: vi.fn(async (path: string) => {
        if (path.endsWith('uevent')) return 'DRIVER=nvidia\nPCI_SLOT_NAME=0000:01:00.0\n';
        throw new Error('not exposed');
      })
    };
    const selected = await new GpuMemoryDetector('linux', logger(), dependencies).select(0);
    expect(run).toHaveBeenCalledWith('nvidia-smi', [
      '--id=0000:01:00.0',
      '--query-gpu=memory.total',
      '--format=csv,noheader,nounits'
    ]);
    expect(selected).toMatchObject({ vramMb: 8_192, texturePoolMb: 2_048, source: 'linux-nvidia' });
  });

  it('falls back safely when platform detection fails', async () => {
    const dependencies: GpuMemoryDependencies = {
      run: vi.fn().mockRejectedValue(new Error('unavailable')),
      readText: vi.fn().mockRejectedValue(new Error('unavailable')),
      listDirectory: vi.fn().mockRejectedValue(new Error('unavailable'))
    };
    const selected = await new GpuMemoryDetector('linux', logger(), dependencies).select(3);
    expect(selected).toMatchObject({
      adapterIndex: 3,
      vramMb: null,
      texturePoolMb: FALLBACK_TEXTURE_POOL_MB,
      source: 'fallback'
    });
  });
});

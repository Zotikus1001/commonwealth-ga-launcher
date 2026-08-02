import { LAUNCHER_CONFIG } from './generatedLauncherConfig';

export type DxvkVersion = (typeof LAUNCHER_CONFIG.dxvk.versions)[number]['version'];

export const DEFAULT_DXVK_VERSION = LAUNCHER_CONFIG.dxvk.defaultVersion as DxvkVersion;

export const DXVK_VERSION_OPTIONS: readonly DxvkVersion[] =
  LAUNCHER_CONFIG.dxvk.versions.map(({ version }) => version);

export function isDxvkVersion(value: unknown): value is DxvkVersion {
  return (
    typeof value === 'string' &&
    DXVK_VERSION_OPTIONS.some((version) => version === value)
  );
}

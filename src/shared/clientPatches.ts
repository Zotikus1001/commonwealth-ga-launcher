import type { ClientPatchId, PatchSettings } from './types';

export const CLIENT_PATCH_IDS = [
  'high-fps-movement-stability',
  'adaptive-client-performance',
  'render-command-signal',
  'foot-placement-off',
  'combat-text-shadows-off'
] as const satisfies readonly ClientPatchId[];

export type ClientPatchPreferenceKey = Exclude<keyof PatchSettings, 'gameClientPatch'>;

export const CLIENT_PATCH_PREFERENCE_KEYS: Record<ClientPatchId, ClientPatchPreferenceKey> = {
  'high-fps-movement-stability': 'highFpsMovementStability',
  'adaptive-client-performance': 'adaptiveClientPerformance',
  'render-command-signal': 'renderCommandSignal',
  'foot-placement-off': 'footPlacementOff',
  'combat-text-shadows-off': 'combatTextShadowsOff'
};

/**
 * Patches implemented by the Game Client Patch DLL. The launcher only writes their on/off line to
 * [Commonwealth.ClientPatch] in TgEngine.ini; the DLL reads it at game start.
 */
export const CLIENT_DLL_PATCH_SETTING_KEYS = {
  'render-command-signal': 'RenderCommandSignal',
  'foot-placement-off': 'FootPlacementOff',
  'combat-text-shadows-off': 'CombatTextShadowsOff'
} as const satisfies Partial<Record<ClientPatchId, string>>;

export type ClientDllPatchId = keyof typeof CLIENT_DLL_PATCH_SETTING_KEYS;

/**
 * What the DLL does when a patch's line is missing or not 0/1. Must match the DLL's defaults.
 * Damage-number shadows are opt-in because the outline keeps numbers readable.
 */
export const CLIENT_DLL_PATCH_DEFAULTS: Record<ClientDllPatchId, boolean> = {
  'render-command-signal': true,
  'foot-placement-off': true,
  'combat-text-shadows-off': false
};

export const CLIENT_DLL_PATCH_SECTION = 'Commonwealth.ClientPatch';

export function isClientPatchId(value: unknown): value is ClientPatchId {
  return typeof value === 'string' && (CLIENT_PATCH_IDS as readonly string[]).includes(value);
}

export function isClientDllPatchId(id: ClientPatchId): id is ClientDllPatchId {
  return Object.prototype.hasOwnProperty.call(CLIENT_DLL_PATCH_SETTING_KEYS, id);
}

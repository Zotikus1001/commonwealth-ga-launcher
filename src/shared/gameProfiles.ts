export const MAX_GAME_PROFILES = 5;
export const MAX_GAME_PROFILE_NAME_LENGTH = 48;

export function normalizeGameProfileName(value: string): string {
  return value.trim();
}

export function validateGameProfileName(value: unknown): string | null {
  if (typeof value !== 'string') return 'Profile name must be text.';
  const normalized = normalizeGameProfileName(value);
  if (!normalized) return 'Enter a profile name.';
  if (normalized.length > MAX_GAME_PROFILE_NAME_LENGTH) {
    return `Profile name must be ${MAX_GAME_PROFILE_NAME_LENGTH} characters or fewer.`;
  }
  if (/\p{Cc}/u.test(normalized)) return 'Profile name contains unsupported characters.';
  return null;
}

export const DEFAULT_FPS_LIMIT = 144;
export const MIN_FPS_LIMIT = 60;
export const MAX_FPS_LIMIT = 900;

export function isFpsLimit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_FPS_LIMIT &&
    value <= MAX_FPS_LIMIT
  );
}

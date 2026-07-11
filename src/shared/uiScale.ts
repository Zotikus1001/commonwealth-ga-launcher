export const UI_SCALE_OPTIONS = [1, 1.1, 1.2, 1.3, 1.4, 1.5] as const;

export type UiScale = (typeof UI_SCALE_OPTIONS)[number];

export const DEFAULT_UI_SCALE: UiScale = 1.2;

export function isUiScale(value: unknown): value is UiScale {
  return UI_SCALE_OPTIONS.some((option) => option === value);
}

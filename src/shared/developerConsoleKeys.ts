export const DEVELOPER_CONSOLE_KEY_OPTIONS = [
  { value: 'Backslash', label: '\\' },
  { value: 'Tilde', label: '~' },
  { value: 'F1', label: 'F1' },
  { value: 'F2', label: 'F2' },
  { value: 'F3', label: 'F3' },
  { value: 'F4', label: 'F4' },
  { value: 'F5', label: 'F5' },
  { value: 'F6', label: 'F6' },
  { value: 'F7', label: 'F7' },
  { value: 'F8', label: 'F8' },
  { value: 'F9', label: 'F9' },
  { value: 'F10', label: 'F10' },
  { value: 'F11', label: 'F11' },
  { value: 'F12', label: 'F12' },
  { value: 'Insert', label: 'Insert' },
  { value: 'Delete', label: 'Delete' },
  { value: 'Home', label: 'Home' },
  { value: 'End', label: 'End' },
  { value: 'PageUp', label: 'Page Up' },
  { value: 'PageDown', label: 'Page Down' }
] as const;

export type DeveloperConsoleKey = (typeof DEVELOPER_CONSOLE_KEY_OPTIONS)[number]['value'];

export const DEFAULT_DEVELOPER_CONSOLE_KEY: DeveloperConsoleKey = 'Backslash';

export function isDeveloperConsoleKey(value: unknown): value is DeveloperConsoleKey {
  return (
    typeof value === 'string' &&
    DEVELOPER_CONSOLE_KEY_OPTIONS.some((option) => option.value === value)
  );
}

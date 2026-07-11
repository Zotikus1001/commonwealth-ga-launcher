export const LOGIN_MAP_OPTIONS = [
  { value: 'Login_FreeAgent.ut3', label: 'Free Agent' },
  { value: 'LoginAllCombined_P.ut3', label: 'Rotating Earth' },
  { value: 'LoginElvish_P.ut3', label: 'Elvish' },
  { value: '3P_Beachhead3_P.ut3', label: 'Dropship' },
  { value: 'Dome3_VR_Arena_P.ut3', label: 'VR Arena' }
] as const;

export type LoginMap = (typeof LOGIN_MAP_OPTIONS)[number]['value'];

export const DEFAULT_LOGIN_MAP: LoginMap = LOGIN_MAP_OPTIONS[0].value;

export function isLoginMap(value: unknown): value is LoginMap {
  return LOGIN_MAP_OPTIONS.some((option) => option.value === value);
}

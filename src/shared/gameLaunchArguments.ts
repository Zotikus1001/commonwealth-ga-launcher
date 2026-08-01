const MANAGED_ARGUMENT_REASONS = new Map<string, string>([
  ['host', 'server selection'],
  ['hostdns', 'server selection'],
  ['seekfreeloading', 'seek-free loading'],
  ['tcp', 'the TCP connection'],
  ['nostartupmovies', 'the Skip Startup Movies setting'],
  ['nosplash', 'the Skip Splash Screen setting'],
  ['graphicsadapter', 'the GPU Adapter setting']
]);

function formatList(values: readonly string[]): string {
  if (values.length < 2) return values[0] ?? '';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
}

export function validateExtraGameArguments(value: unknown): string | null {
  if (typeof value !== 'string') return 'Extra Launch Arguments must be text.';

  const managed = new Map<string, string>();
  for (const token of value.trim().split(/\s+/)) {
    const name = /^["']*(?:-+|\/)([^=:\s"']+)/.exec(token)?.[1]?.toLowerCase();
    if (!name) continue;
    const reason = MANAGED_ARGUMENT_REASONS.get(name);
    if (reason) managed.set(name, reason);
  }
  if (managed.size === 0) return null;

  const flags = [...managed.keys()].map((name) => `-${name}`);
  const reasons = [...new Set(managed.values())];
  return (
    `Remove launcher-managed argument${flags.length === 1 ? '' : 's'}: ${formatList(flags)}. ` +
    `The launcher already controls ${formatList(reasons)}; duplicate values can conflict with those settings.`
  );
}

export function parseExtraGameArguments(value: string): string[] {
  const error = validateExtraGameArguments(value);
  if (error) throw new Error(error);
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/) : [];
}

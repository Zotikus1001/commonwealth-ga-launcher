export const CHANGELOG_CLOSE_DELAY_MS = 10_000;

export function changelogSecondsRemaining(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1_000));
}

export function changelogReleaseBadge(
  entryVersion: string,
  index: number,
  currentVersion: string
): 'Current release' | 'NEW LAUNCHER UPDATE' | null {
  if (index !== 0) return null;
  return entryVersion === currentVersion ? 'Current release' : 'NEW LAUNCHER UPDATE';
}

export function formatChangelogReleaseDate(releasedOn: string): string {
  const [year, month, day] = releasedOn.split('-').map(Number);
  const suffix =
    day % 100 >= 11 && day % 100 <= 13
      ? 'th'
      : day % 10 === 1
        ? 'st'
        : day % 10 === 2
          ? 'nd'
          : day % 10 === 3
            ? 'rd'
            : 'th';
  const monthName = new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    timeZone: 'UTC'
  }).format(new Date(Date.UTC(year, month - 1, 1)));
  return `${day}${suffix} ${monthName}, ${year}`;
}

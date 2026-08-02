import rawLauncherChangelog from '../../launcher-changelog.json';

export interface LauncherChangelogEntry {
  readonly version: string;
  readonly title?: string;
  readonly summary?: string;
  readonly changes: readonly string[];
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function versionParts(version: string): readonly number[] {
  return version.split('.').map(Number);
}

function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function parseLauncherChangelog(raw: unknown): readonly LauncherChangelogEntry[] {
  if (typeof raw !== 'object' || raw === null || !('versions' in raw)) {
    throw new Error('Launcher changelog must contain a versions list.');
  }
  const versions = (raw as { versions?: unknown }).versions;
  if (!Array.isArray(versions) || versions.length === 0 || versions.length > 100) {
    throw new Error('Launcher changelog versions list is invalid.');
  }

  const seenVersions = new Set<string>();
  const entries = versions.map((rawEntry, entryIndex): LauncherChangelogEntry => {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      throw new Error(`Launcher changelog entry ${entryIndex + 1} is invalid.`);
    }
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.version !== 'string' || !VERSION_PATTERN.test(entry.version)) {
      throw new Error(`Launcher changelog entry ${entryIndex + 1} has an invalid version.`);
    }
    if (seenVersions.has(entry.version)) {
      throw new Error(`Launcher changelog version ${entry.version} is duplicated.`);
    }
    seenVersions.add(entry.version);
    if (
      entry.title !== undefined &&
      (typeof entry.title !== 'string' ||
        entry.title.trim() !== entry.title ||
        entry.title.length === 0 ||
        entry.title.length > 80)
    ) {
      throw new Error(`Launcher changelog version ${entry.version} has an invalid title.`);
    }
    if (
      entry.summary !== undefined &&
      (typeof entry.summary !== 'string' ||
        entry.summary.trim() !== entry.summary ||
        entry.summary.length === 0 ||
        entry.summary.length > 300)
    ) {
      throw new Error(`Launcher changelog version ${entry.version} has an invalid summary.`);
    }
    if (!Array.isArray(entry.changes) || entry.changes.length === 0 || entry.changes.length > 25) {
      throw new Error(`Launcher changelog version ${entry.version} has an invalid changes list.`);
    }
    const changes = entry.changes.map((change, changeIndex) => {
      if (
        typeof change !== 'string' ||
        change.trim() !== change ||
        change.length === 0 ||
        change.length > 240
      ) {
        throw new Error(
          `Launcher changelog version ${entry.version} change ${changeIndex + 1} is invalid.`
        );
      }
      return change;
    });
    return Object.freeze({
      version: entry.version,
      ...(typeof entry.title === 'string' ? { title: entry.title } : {}),
      ...(typeof entry.summary === 'string' ? { summary: entry.summary } : {}),
      changes: Object.freeze(changes)
    });
  });

  for (let index = 1; index < entries.length; index += 1) {
    if (compareVersions(entries[index - 1].version, entries[index].version) <= 0) {
      throw new Error('Launcher changelog versions must be ordered newest first.');
    }
  }
  return Object.freeze(entries);
}

export const LAUNCHER_CHANGELOG = parseLauncherChangelog(rawLauncherChangelog);

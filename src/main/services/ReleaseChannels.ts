import { LAUNCHER_CONFIG } from '@shared/generatedLauncherConfig';

export interface UpdateRepository {
  owner: string;
  repo: string;
}

export interface PublishedRelease extends UpdateRepository {
  tag: string;
  version: string;
  publishedAt: number;
}

export const STABLE_RELEASE_BRANCH = LAUNCHER_CONFIG.stableBranch;

export const UPDATE_REPOSITORIES: readonly UpdateRepository[] =
  LAUNCHER_CONFIG.updateRepositories;

export function comparePublishedReleases(left: PublishedRelease, right: PublishedRelease): number {
  if (left.publishedAt !== right.publishedAt) return right.publishedAt - left.publishedAt;
  return `${left.owner}/${left.repo}`.localeCompare(`${right.owner}/${right.repo}`);
}

export function latestStableRelease(
  raw: unknown,
  source: UpdateRepository
): PublishedRelease | null {
  if (!Array.isArray(raw)) throw new Error('GitHub releases response is not an array');
  const releases: PublishedRelease[] = [];

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const release = item as Record<string, unknown>;
    if (release.draft === true || release.prerelease === true) continue;
    if (release.target_commitish !== STABLE_RELEASE_BRANCH) continue;

    const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
    const version = tag.replace(/^v/, '');
    const publishedAt =
      typeof release.published_at === 'string' ? Date.parse(release.published_at) : Number.NaN;
    if (!/^\d+\.\d+\.\d+$/.test(version) || !Number.isFinite(publishedAt)) continue;
    releases.push({ ...source, tag, version, publishedAt });
  }

  releases.sort(comparePublishedReleases);
  return releases[0] ?? null;
}

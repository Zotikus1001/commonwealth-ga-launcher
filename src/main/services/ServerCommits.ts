import { net } from 'electron';
import { LAUNCHER_CONFIG } from '@shared/generatedLauncherConfig';
import type { ServerCommit } from '@shared/types';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function parseServerCommits(raw: unknown, limit: number): ServerCommit[] {
  if (!Array.isArray(raw)) throw new Error('GitHub commits response is not an array');
  const commits: ServerCommit[] = [];

  for (const item of raw) {
    const entry = asRecord(item);
    const commit = asRecord(entry?.commit);
    const committer = asRecord(commit?.committer);
    const author = asRecord(commit?.author);
    const sha = typeof entry?.sha === 'string' ? entry.sha : '';
    const rawMessage = typeof commit?.message === 'string' ? commit.message : '';
    const rawDate =
      typeof committer?.date === 'string'
        ? committer.date
        : typeof author?.date === 'string'
          ? author.date
          : '';
    const timestamp = Date.parse(rawDate);
    const message = rawMessage.split(/\r?\n/, 1)[0].trim();
    if (!/^[0-9a-f]{7,40}$/i.test(sha) || !message || !Number.isFinite(timestamp)) continue;
    commits.push({
      sha,
      message: message.slice(0, 160),
      committedAt: new Date(timestamp).toISOString()
    });
    if (commits.length >= limit) break;
  }
  return commits;
}

export async function fetchServerCommits(): Promise<ServerCommit[]> {
  const { owner, repo } = LAUNCHER_CONFIG.serverHistoryRepository;
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/commits`);
  url.searchParams.set('sha', LAUNCHER_CONFIG.serverHistoryBranch);
  url.searchParams.set('per_page', String(LAUNCHER_CONFIG.serverHistoryCount));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await net.fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Commonwealth-GA-Launcher',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    return parseServerCommits(await response.json(), LAUNCHER_CONFIG.serverHistoryCount);
  } finally {
    clearTimeout(timer);
  }
}

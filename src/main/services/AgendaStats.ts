import { net } from 'electron';
import { LAUNCHER_CONFIG } from '@shared/generatedLauncherConfig';

const STATUS_TIMEOUT_MS = 8_000;
const MAX_STATUS_LENGTH = 80;

export function parseAgendaStatsStatus(raw: string): string {
  const status = raw.trim().replace(/\s+/g, ' ');
  if (status.length > MAX_STATUS_LENGTH) throw new Error('Agenda Stats status is too long');
  const match = status.match(/^(\d{1,6}) players? in-game$/i);
  if (!match) throw new Error('Agenda Stats returned an unexpected status');
  const players = Number.parseInt(match[1], 10);
  return `${players} ${players === 1 ? 'player' : 'players'} in-game`;
}

export async function fetchAgendaStatsStatus(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('Agenda Stats request timed out')),
    STATUS_TIMEOUT_MS
  );
  try {
    const response = await net.fetch(LAUNCHER_CONFIG.agendaStatsStatusUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'text/plain',
        'Cache-Control': 'no-cache',
        'User-Agent': 'Commonwealth-GA-Launcher'
      }
    });
    if (!response.ok) throw new Error(`Agenda Stats returned HTTP ${response.status}`);
    return parseAgendaStatsStatus(await response.text());
  } finally {
    clearTimeout(timer);
  }
}

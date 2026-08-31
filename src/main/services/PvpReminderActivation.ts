import type { SteamLaunchIntegrationStatus } from '@shared/types';
import { isPvpEventId, type PvpEventId } from '@shared/pvpEvents';

const PVP_REMINDER_ARGUMENT = '--pvp-event-reminder=';

export type PvpReminderClickTarget = 'launcher' | 'steam';

export function pvpReminderFromArguments(argumentsList: readonly string[]): PvpEventId | null {
  const argument = argumentsList.find((candidate) => candidate.startsWith(PVP_REMINDER_ARGUMENT));
  if (!argument) return null;
  const eventId = argument.slice(PVP_REMINDER_ARGUMENT.length);
  return isPvpEventId(eventId) ? eventId : null;
}

export function launcherArgumentsWithoutPvpReminder(
  argumentsList: readonly string[]
): string[] {
  return argumentsList
    .slice(1)
    .filter((candidate) => !candidate.startsWith(PVP_REMINDER_ARGUMENT));
}

export function launcherRelaunchExecutable(
  platform: NodeJS.Platform,
  executablePath: string,
  appImagePath?: string
): string {
  return platform === 'linux' ? appImagePath?.trim() || executablePath : executablePath;
}

export function pvpReminderClickTarget(
  steamState: SteamLaunchIntegrationStatus['state']
): PvpReminderClickTarget {
  return steamState === 'enabled' ? 'steam' : 'launcher';
}

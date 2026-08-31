const LONDON_TIME_ZONE = 'Europe/London';
const PVP_LIVE_LEAD_MS = 15 * 60 * 1_000;

export type PvpEventId = 'mercenary-fun' | 'challenge-night';

export interface PvpEventDefinition {
  id: PvpEventId;
  name: string;
  weekday: 0 | 2;
  hour: number;
  minute: number;
  summary: string;
}

export const PVP_EVENTS: readonly PvpEventDefinition[] = [
  {
    id: 'mercenary-fun',
    name: 'PvP Merc Fun',
    weekday: 0,
    hour: 18,
    minute: 0,
    summary: 'Casual Mercenary PvP for relaxed matches and community fun.'
  },
  {
    id: 'challenge-night',
    name: 'PvP Challenge Night',
    weekday: 2,
    hour: 18,
    minute: 30,
    summary:
      'A more competitive night: join voice chat to coordinate teamwork for Challenge matches, with Mercenary PvP when enough players attend.'
  }
] as const;

interface LondonCalendar {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export type PvpEventStatus =
  | {
      mode: 'countdown';
      event: PvpEventDefinition;
      startsAt: number;
    }
  | {
      mode: 'live';
      event: PvpEventDefinition;
      startsAt: number;
      liveUntil: number;
    };

export interface PvpCountdownParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

const londonPartsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

const eventDateFormatter = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
  hourCycle: 'h23'
});

const eventScheduleFormatter = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
  hourCycle: 'h23'
});

function londonCalendar(timestamp: number): LondonCalendar {
  const parts = londonPartsFormatter.formatToParts(timestamp);
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (!part) throw new Error(`London time formatter omitted ${type}`);
    return Number.parseInt(part, 10);
  };
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second')
  };
}

function addCalendarDays(calendar: LondonCalendar, days: number): LondonCalendar {
  const shifted = new Date(
    Date.UTC(calendar.year, calendar.month - 1, calendar.day + days, 0, 0, 0)
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0
  };
}

function londonWallClockToTimestamp(
  calendar: LondonCalendar,
  hour: number,
  minute: number
): number {
  const wallClockAsUtc = Date.UTC(
    calendar.year,
    calendar.month - 1,
    calendar.day,
    hour,
    minute,
    0
  );
  let timestamp = wallClockAsUtc;

  // Event times are outside DST transition hours; two offset passes also handle either UK season.
  for (let pass = 0; pass < 2; pass += 1) {
    const projected = londonCalendar(timestamp);
    const projectedAsUtc = Date.UTC(
      projected.year,
      projected.month - 1,
      projected.day,
      projected.hour,
      projected.minute,
      projected.second
    );
    timestamp -= projectedAsUtc - wallClockAsUtc;
  }
  return timestamp;
}

function calendarWeekday(calendar: LondonCalendar): number {
  return new Date(Date.UTC(calendar.year, calendar.month - 1, calendar.day)).getUTCDay();
}

function eventStart(event: PvpEventDefinition, calendar: LondonCalendar): number {
  return londonWallClockToTimestamp(calendar, event.hour, event.minute);
}

export function getPvpEventStatus(now = Date.now()): PvpEventStatus {
  if (!Number.isFinite(now)) throw new Error('Current time must be a finite timestamp');

  const today = londonCalendar(now);
  const todaysEvent = PVP_EVENTS.find((event) => event.weekday === calendarWeekday(today));
  if (todaysEvent) {
    const startsAt = eventStart(todaysEvent, today);
    const liveUntil = londonWallClockToTimestamp(addCalendarDays(today, 1), 0, 0);
    if (now >= startsAt - PVP_LIVE_LEAD_MS && now < liveUntil) {
      return { mode: 'live', event: todaysEvent, startsAt, liveUntil };
    }
  }

  for (let daysAhead = 0; daysAhead <= 7; daysAhead += 1) {
    const calendar = addCalendarDays(today, daysAhead);
    const event = PVP_EVENTS.find((candidate) => candidate.weekday === calendarWeekday(calendar));
    if (!event) continue;
    const startsAt = eventStart(event, calendar);
    if (startsAt > now) return { mode: 'countdown', event, startsAt };
  }

  throw new Error('PvP schedule does not contain an upcoming event');
}

export function isPvpEventId(value: unknown): value is PvpEventId {
  return PVP_EVENTS.some((event) => event.id === value);
}

export function getPvpEvent(eventId: PvpEventId): PvpEventDefinition {
  const event = PVP_EVENTS.find((candidate) => candidate.id === eventId);
  if (!event) throw new Error(`Unknown PvP event: ${eventId}`);
  return event;
}

function findNextPvpEventStart(eventId: PvpEventId, after: number, leadMs: number): number {
  if (!Number.isFinite(after)) throw new Error('Current time must be a finite timestamp');
  const event = getPvpEvent(eventId);
  const today = londonCalendar(after);

  for (let daysAhead = 0; daysAhead <= 7; daysAhead += 1) {
    const calendar = addCalendarDays(today, daysAhead);
    if (calendarWeekday(calendar) !== event.weekday) continue;
    const startsAt = eventStart(event, calendar);
    if (startsAt - leadMs > after) return startsAt;
  }

  throw new Error(`Could not find the next ${event.name} occurrence`);
}

export function getNextPvpEventStart(eventId: PvpEventId, after = Date.now()): number {
  return findNextPvpEventStart(eventId, after, 0);
}

export function getNextPvpReminderEventStart(
  eventId: PvpEventId,
  after = Date.now()
): number {
  return findNextPvpEventStart(eventId, after, 0);
}

export function getPvpCountdownParts(startsAt: number, now = Date.now()): PvpCountdownParts {
  let seconds = Math.max(0, Math.ceil((startsAt - now) / 1_000));
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds -= hours * 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  return { days, hours, minutes, seconds };
}

export function formatPvpCountdown(startsAt: number, now = Date.now()): string {
  const { days, hours, minutes, seconds } = getPvpCountdownParts(startsAt, now);
  const clock = [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
  return days > 0 ? `${String(days).padStart(2, '0')}D ${clock}` : clock;
}

export function formatPvpEventDate(startsAt: number): string {
  return eventDateFormatter.format(startsAt);
}

export function formatPvpEventSchedule(eventId: PvpEventId, after = Date.now()): string {
  const startsAt = getNextPvpEventStart(eventId, after);
  return `Every ${eventScheduleFormatter.format(startsAt).replace(',', ' ·')}`;
}

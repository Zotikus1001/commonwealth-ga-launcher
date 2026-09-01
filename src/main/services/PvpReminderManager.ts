import { execFile } from 'child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { promisify } from 'util';
import {
  getNextPvpReminderEventStart,
  getPvpEvent,
  PVP_EVENTS,
  type PvpEventDefinition,
  type PvpEventId
} from '@shared/pvpEvents';
import type { PvpReminderState } from '@shared/types';
import type { Log } from './Log';

const execFileP = promisify(execFile);
const MARKER_SCHEMA_VERSION = 1;
const REMINDER_SCHEDULE_VERSION = 2;
const REMINDER_SCHEDULE_MARKER =
  `CommonwealthReminderScheduleVersion=${REMINDER_SCHEDULE_VERSION}`;
const REMINDER_DELIVERY_GRACE_MS = 15 * 60 * 1_000;
const WINDOWS_LONDON_UTC_OFFSETS = [1, 0] as const;
const WINDOWS_TASK_NAMES: Record<PvpEventId, string> = {
  'mercenary-fun': 'Commonwealth GA PvP Merc Fun',
  'challenge-night': 'Commonwealth GA PvP Challenge Night'
};
const WINDOWS_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
] as const;
const SYSTEMD_WEEKDAYS: Record<PvpEventDefinition['weekday'], string> = {
  0: 'Sun',
  2: 'Tue'
};

interface ReminderMarker {
  schemaVersion: number;
  enabled: PvpEventId[];
}

interface ReminderSupport {
  supported: boolean;
  detail: string;
}

export interface PvpReminderManagerOptions {
  platform: NodeJS.Platform;
  packaged: boolean;
  executablePath: string;
  developmentAppPath?: string;
  appImagePath?: string;
  userDataDir: string;
  homeDirectory?: string;
  now?: () => number;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function windowsArgument(value: string): string {
  if (/\0|\r|\n|"/.test(value)) {
    throw new Error('Reminder launch argument contains an invalid character');
  }
  if (value !== '' && !/[ \t]/.test(value)) return value;
  return `"${value.replace(/\\+$/, (slashes) => `${slashes}${slashes}`)}"`;
}

function systemdArgument(value: string): string {
  if (/\0|\r|\n/.test(value)) {
    throw new Error('Reminder launch argument contains an invalid character');
  }
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('$', () => '$$')
    .replaceAll('%', '%%')}"`;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

function windowsWeeklyBoundary(
  event: PvpEventDefinition,
  firstOccurrenceAt: number,
  londonUtcOffset: (typeof WINDOWS_LONDON_UTC_OFFSETS)[number]
): { startBoundary: string; weekday: (typeof WINDOWS_WEEKDAYS)[number] } {
  const occurrence = new Date(firstOccurrenceAt);
  const localOccurrence = new Date(
    Date.UTC(
      occurrence.getUTCFullYear(),
      occurrence.getUTCMonth(),
      occurrence.getUTCDate(),
      event.hour - londonUtcOffset,
      event.minute
    )
  );
  const timezoneOffsetMinutes = -localOccurrence.getTimezoneOffset();
  const timezoneSign = timezoneOffsetMinutes >= 0 ? '+' : '-';
  const absoluteOffsetMinutes = Math.abs(timezoneOffsetMinutes);
  const startBoundary = `${localOccurrence.getFullYear()}-${twoDigits(
    localOccurrence.getMonth() + 1
  )}-${twoDigits(localOccurrence.getDate())}T${twoDigits(
    localOccurrence.getHours()
  )}:${twoDigits(localOccurrence.getMinutes())}:00${timezoneSign}${twoDigits(
    Math.floor(absoluteOffsetMinutes / 60)
  )}:${twoDigits(absoluteOffsetMinutes % 60)}`;
  return { startBoundary, weekday: WINDOWS_WEEKDAYS[localOccurrence.getDay()] };
}

function systemdWeeklyCalendar(event: PvpEventDefinition): string {
  const hour = String(event.hour).padStart(2, '0');
  const minute = String(event.minute).padStart(2, '0');
  return `${SYSTEMD_WEEKDAYS[event.weekday]} *-*-* ${hour}:${minute}:00 Europe/London`;
}

function isReminderDeliveryTime(eventId: PvpEventId, now: number): boolean {
  const startsAt = getNextPvpReminderEventStart(
    eventId,
    now - REMINDER_DELIVERY_GRACE_MS - 1
  );
  return startsAt <= now && now - startsAt <= REMINDER_DELIVERY_GRACE_MS;
}

function isWindowsRecurringSchedule(xml: string, eventId: PvpEventId): boolean {
  const weekdayCount =
    xml.match(/<(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s*\/>/g)
      ?.length ?? 0;
  return (
    (xml.match(/<CalendarTrigger>/g)?.length ?? 0) === WINDOWS_LONDON_UTC_OFFSETS.length &&
    (xml.match(/<ScheduleByWeek>/g)?.length ?? 0) === WINDOWS_LONDON_UTC_OFFSETS.length &&
    xml.includes('<WeeksInterval>1</WeeksInterval>') &&
    weekdayCount === WINDOWS_LONDON_UTC_OFFSETS.length &&
    xml.includes('<MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>') &&
    xml.includes('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>') &&
    xml.includes(`--pvp-event-reminder=${eventId}`)
  );
}

export function windowsReminderTaskName(eventId: PvpEventId, packaged: boolean): string {
  const name = WINDOWS_TASK_NAMES[eventId];
  return packaged ? name : name.replace('Commonwealth GA ', 'Commonwealth GA Development ');
}

export function linuxReminderUnitNames(
  eventId: PvpEventId,
  packaged: boolean
): { service: string; timer: string } {
  const scope = packaged ? '' : 'development-';
  const prefix = `commonwealth-ga-${scope}pvp-${eventId}`;
  return { service: `${prefix}.service`, timer: `${prefix}.timer` };
}

export function buildWindowsReminderTask(
  event: PvpEventDefinition,
  executablePath: string,
  reminderAt: number,
  launchArguments: readonly string[] = []
): string {
  const description = `Notify the user when ${event.name} starts.`;
  const argumentsValue = [...launchArguments, `--pvp-event-reminder=${event.id}`]
    .map(windowsArgument)
    .join(' ');
  // Task Scheduler cannot express an IANA timezone. Both possible London UTC offsets recur
  // weekly. Localized boundaries keep date-crossing weekdays correct in every user timezone,
  // while their explicit offsets remain stable through the user's own DST changes.
  const triggers = WINDOWS_LONDON_UTC_OFFSETS.map((londonUtcOffset) => {
    const { startBoundary, weekday } = windowsWeeklyBoundary(
      event,
      reminderAt,
      londonUtcOffset
    );
    return `    <CalendarTrigger>
      <StartBoundary>${startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByWeek>
        <WeeksInterval>1</WeeksInterval>
        <DaysOfWeek>
          <${weekday} />
        </DaysOfWeek>
      </ScheduleByWeek>
    </CalendarTrigger>`;
  }).join('\n');
  return `\uFEFF<?xml version="1.0" encoding="UTF-16"?>
<!-- ${REMINDER_SCHEDULE_MARKER} -->
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${escapeXml(description)}</Description>
  </RegistrationInfo>
  <Triggers>
${triggers}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(executablePath)}</Command>
      <Arguments>${escapeXml(argumentsValue)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function buildLinuxReminderUnits(
  event: PvpEventDefinition,
  executablePath: string,
  reminderAt: number,
  launchArguments: readonly string[] = [],
  serviceUnitName = linuxReminderUnitNames(event.id, true).service
): { service: string; timer: string } {
  const argumentsValue = [...launchArguments, `--pvp-event-reminder=${event.id}`]
    .map(systemdArgument)
    .join(' ');
  const systemdRunArguments = ['--user', '--collect', '--', executablePath]
    .map(systemdArgument)
    .join(' ');
  return {
    service: `[Unit]
Description=Commonwealth GA reminder for ${event.name}

[Service]
Type=oneshot
ExecStart=${systemdArgument('systemd-run')} ${systemdRunArguments} ${argumentsValue}
`,
    timer: `# ${REMINDER_SCHEDULE_MARKER}
# FirstOccurrence=${new Date(reminderAt).toISOString()}
[Unit]
Description=Commonwealth GA reminder timer for ${event.name} (${REMINDER_SCHEDULE_MARKER})

[Timer]
OnCalendar=${systemdWeeklyCalendar(event)}
AccuracySec=1s
Persistent=false
Unit=${serviceUnitName}

[Install]
WantedBy=timers.target
`
  };
}

export class PvpReminderManager {
  private readonly markerPath: string;
  private readonly stateDirectory: string;
  private readonly systemdDirectory: string;
  private readonly now: () => number;
  private supportPromise: Promise<ReminderSupport> | null = null;
  private readonly recurringSchedulePromises = new Map<PvpEventId, Promise<boolean>>();

  constructor(
    private readonly options: PvpReminderManagerOptions,
    private readonly log: Log
  ) {
    this.stateDirectory = join(options.userDataDir, 'pvp-reminders');
    this.markerPath = join(this.stateDirectory, 'state.json');
    this.systemdDirectory = join(options.homeDirectory ?? homedir(), '.config', 'systemd', 'user');
    this.now = options.now ?? Date.now;
  }

  async getState(): Promise<PvpReminderState> {
    const support = await this.support();
    const marker = await this.readMarker();
    const reminders: PvpReminderState['reminders'] = [];
    for (const event of PVP_EVENTS) {
      reminders.push({
        eventId: event.id,
        enabled:
          support.supported && marker.enabled.includes(event.id)
            ? await this.ensureRecurringSchedule(event.id)
            : false
      });
    }
    return { ...support, reminders };
  }

  async setEnabled(eventId: PvpEventId, enabled: boolean): Promise<PvpReminderState> {
    const support = await this.support();
    if (!support.supported) throw new Error(support.detail);
    const marker = await this.readMarker();
    const previouslyEnabled = marker.enabled.includes(eventId);

    if (enabled) {
      try {
        await this.scheduleWeekly(eventId, this.now());
        await this.writeMarker({
          schemaVersion: MARKER_SCHEMA_VERSION,
          enabled: [...new Set([...marker.enabled, eventId])]
        });
      } catch (error) {
        await this.removeSchedule(eventId).catch(() => {});
        throw error;
      }
    } else {
      await this.removeSchedule(eventId);
      try {
        await this.writeMarker({
          schemaVersion: MARKER_SCHEMA_VERSION,
          enabled: marker.enabled.filter((candidate) => candidate !== eventId)
        });
      } catch (error) {
        if (previouslyEnabled) await this.scheduleWeekly(eventId, this.now()).catch(() => {});
        throw error;
      }
    }

    return this.getState();
  }

  async consumeTriggeredReminder(eventId: PvpEventId): Promise<PvpEventDefinition | null> {
    const support = await this.support();
    if (!support.supported) return null;
    const marker = await this.readMarker();
    if (!marker.enabled.includes(eventId)) return null;
    if (!isReminderDeliveryTime(eventId, this.now())) {
      this.log.info(`PvP reminder trigger ignored outside the event start window: ${eventId}`);
      return null;
    }
    return getPvpEvent(eventId);
  }

  private async support(): Promise<ReminderSupport> {
    if (!this.supportPromise) this.supportPromise = this.detectSupport();
    return this.supportPromise;
  }

  private async detectSupport(): Promise<ReminderSupport> {
    if (!this.options.packaged && !this.options.developmentAppPath) {
      return {
        supported: false,
        detail: 'System reminders cannot locate this development build.'
      };
    }
    if (this.options.platform === 'win32') {
      return {
        supported: true,
        detail: 'Windows will notify you when enabled events start.'
      };
    }
    if (this.options.platform === 'linux') {
      if (this.options.packaged && !this.options.appImagePath) {
        return {
          supported: false,
          detail: 'System reminders require launching the packaged AppImage directly.'
        };
      }
      try {
        await Promise.all([
          this.run('systemctl', ['--user', 'show-environment']),
          this.run('systemd-run', ['--version'])
        ]);
        return {
          supported: true,
          detail:
            'Linux will notify you when enabled events start. Disable reminders before moving or deleting this AppImage.'
        };
      } catch {
        return {
          supported: false,
          detail: 'System reminders require an active systemd user session.'
        };
      }
    }
    return { supported: false, detail: 'System reminders are not supported on this platform.' };
  }

  private launcherCommand(): { executablePath: string; launchArguments: string[] } {
    if (!this.options.packaged) {
      if (!this.options.developmentAppPath) {
        throw new Error('The development application path is unavailable');
      }
      return {
        executablePath: this.options.executablePath,
        launchArguments: [this.options.developmentAppPath]
      };
    }
    if (this.options.platform === 'linux') {
      if (!this.options.appImagePath) throw new Error('The AppImage path is unavailable');
      return { executablePath: this.options.appImagePath, launchArguments: [] };
    }
    return { executablePath: this.options.executablePath, launchArguments: [] };
  }

  private async scheduleWeekly(eventId: PvpEventId, after: number): Promise<void> {
    const event = getPvpEvent(eventId);
    const reminderAt = getNextPvpReminderEventStart(eventId, after);
    const command = this.launcherCommand();
    if (this.options.platform === 'win32') {
      await mkdir(this.stateDirectory, { recursive: true });
      const xmlPath = this.windowsXmlPath(eventId);
      await writeFile(
        xmlPath,
        buildWindowsReminderTask(
          event,
          command.executablePath,
          reminderAt,
          command.launchArguments
        ),
        { encoding: 'utf-16le' }
      );
      await this.run('schtasks.exe', [
        '/Create',
        '/TN',
        windowsReminderTaskName(eventId, this.options.packaged),
        '/XML',
        xmlPath,
        '/F'
      ]);
      return;
    }

    if (this.options.platform === 'linux') {
      const names = this.linuxUnitNames(eventId);
      const units = buildLinuxReminderUnits(
        event,
        command.executablePath,
        reminderAt,
        command.launchArguments,
        names.service
      );
      await mkdir(this.systemdDirectory, { recursive: true });
      await Promise.all([
        writeFile(join(this.systemdDirectory, names.service), units.service, { encoding: 'utf-8' }),
        writeFile(join(this.systemdDirectory, names.timer), units.timer, { encoding: 'utf-8' })
      ]);
      await this.run('systemctl', ['--user', 'daemon-reload']);
      await this.run('systemctl', ['--user', 'enable', names.timer]);
      await this.run('systemctl', ['--user', 'restart', names.timer]);
      return;
    }

    throw new Error('System reminders are not supported on this platform');
  }

  private async removeSchedule(eventId: PvpEventId): Promise<void> {
    if (this.options.platform === 'win32') {
      if (await this.windowsTaskExists(eventId)) {
        await this.run('schtasks.exe', [
          '/Delete',
          '/TN',
          windowsReminderTaskName(eventId, this.options.packaged),
          '/F'
        ]);
      }
      await rm(this.windowsXmlPath(eventId), { force: true });
      return;
    }
    if (this.options.platform === 'linux') {
      const names = this.linuxUnitNames(eventId);
      const timerPath = join(this.systemdDirectory, names.timer);
      const timerExists = await readFile(timerPath, { encoding: 'utf-8' })
        .then(() => true)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        });
      if (timerExists) {
        await this.run('systemctl', ['--user', 'disable', '--now', names.timer]);
      }
      await Promise.all([
        rm(timerPath, { force: true }),
        rm(join(this.systemdDirectory, names.service), { force: true })
      ]);
      await this.run('systemctl', ['--user', 'daemon-reload']);
    }
  }

  private async ensureRecurringSchedule(eventId: PvpEventId): Promise<boolean> {
    const existing = this.recurringSchedulePromises.get(eventId);
    if (existing) return existing;
    const operation = this.ensureRecurringScheduleOnce(eventId).finally(() => {
      if (this.recurringSchedulePromises.get(eventId) === operation) {
        this.recurringSchedulePromises.delete(eventId);
      }
    });
    this.recurringSchedulePromises.set(eventId, operation);
    return operation;
  }

  private async ensureRecurringScheduleOnce(eventId: PvpEventId): Promise<boolean> {
    if (await this.hasRecurringSchedule(eventId)) return true;
    try {
      await this.scheduleWeekly(eventId, this.now());
      this.log.info(`PvP reminder upgraded to a recurring weekly schedule: ${eventId}`);
      return true;
    } catch (error) {
      this.log.error(`PvP reminder recurring schedule could not be installed: ${(error as Error).message}`);
      return false;
    }
  }

  private async hasRecurringSchedule(eventId: PvpEventId): Promise<boolean> {
    if (this.options.platform === 'win32') {
      try {
        const xml = await this.run('schtasks.exe', [
          '/Query',
          '/TN',
          windowsReminderTaskName(eventId, this.options.packaged),
          '/XML'
        ]);
        return isWindowsRecurringSchedule(xml, eventId);
      } catch {
        return false;
      }
    }
    if (this.options.platform === 'linux') {
      const names = this.linuxUnitNames(eventId);
      const source = await readFile(join(this.systemdDirectory, names.timer), {
        encoding: 'utf-8'
      }).catch(() => null);
      if (!source?.includes(`# ${REMINDER_SCHEDULE_MARKER}`)) return false;
      try {
        const loaded = await this.run('systemctl', [
          '--user',
          'show',
          names.timer,
          '--property=Description',
          '--property=ActiveState'
        ]);
        return (
          loaded.includes(REMINDER_SCHEDULE_MARKER) &&
          /^ActiveState=active$/m.test(loaded)
        );
      } catch {
        return false;
      }
    }
    return false;
  }

  private async windowsTaskExists(eventId: PvpEventId): Promise<boolean> {
    try {
      await this.run('schtasks.exe', [
        '/Query',
        '/TN',
        windowsReminderTaskName(eventId, this.options.packaged)
      ]);
      return true;
    } catch {
      return false;
    }
  }

  private windowsXmlPath(eventId: PvpEventId): string {
    return join(this.stateDirectory, `${eventId}.xml`);
  }

  private linuxUnitNames(eventId: PvpEventId): { service: string; timer: string } {
    return linuxReminderUnitNames(eventId, this.options.packaged);
  }

  private async readMarker(): Promise<ReminderMarker> {
    try {
      const raw = JSON.parse(await readFile(this.markerPath, { encoding: 'utf-8' })) as unknown;
      if (
        typeof raw !== 'object' ||
        raw === null ||
        (raw as { schemaVersion?: unknown }).schemaVersion !== MARKER_SCHEMA_VERSION ||
        !Array.isArray((raw as { enabled?: unknown }).enabled)
      ) {
        throw new Error('unsupported reminder state');
      }
      const enabled = (raw as { enabled: unknown[] }).enabled.filter(
        (value): value is PvpEventId => PVP_EVENTS.some((event) => event.id === value)
      );
      return { schemaVersion: MARKER_SCHEMA_VERSION, enabled: [...new Set(enabled)] };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') this.log.warn(`PvP reminder state ignored: ${(error as Error).message}`);
      return { schemaVersion: MARKER_SCHEMA_VERSION, enabled: [] };
    }
  }

  private async writeMarker(marker: ReminderMarker): Promise<void> {
    await mkdir(dirname(this.markerPath), { recursive: true });
    const temporary = `${this.markerPath}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf-8' });
      await rename(temporary, this.markerPath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async run(command: string, args: string[]): Promise<string> {
    const { stdout } = await execFileP(command, args, {
      encoding: 'utf-8',
      timeout: 15_000,
      windowsHide: true
    });
    return stdout;
  }
}

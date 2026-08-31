import { execFile } from 'child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { promisify } from 'util';
import {
  getNextPvpReminderEventStart,
  getPvpEvent,
  PVP_EVENTS,
  PVP_REMINDER_LEAD_MS,
  type PvpEventDefinition,
  type PvpEventId
} from '@shared/pvpEvents';
import type { PvpReminderState } from '@shared/types';
import type { Log } from './Log';

const execFileP = promisify(execFile);
const MARKER_SCHEMA_VERSION = 1;
const WINDOWS_TASK_NAMES: Record<PvpEventId, string> = {
  'mercenary-fun': 'Commonwealth GA PvP Merc Fun',
  'challenge-night': 'Commonwealth GA PvP Challenge Night'
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

function systemdArgument(value: string): string {
  if (/\r|\n/.test(value)) throw new Error('Reminder executable path contains a line break');
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('$', () => '$$')
    .replaceAll('%', '%%')}"`;
}

function utcBoundary(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function systemdCalendar(timestamp: number): string {
  return `${new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export function buildWindowsReminderTask(
  event: PvpEventDefinition,
  executablePath: string,
  reminderAt: number
): string {
  const description = `Notify the user 15 minutes before ${event.name}.`;
  return `\uFEFF<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${escapeXml(description)}</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${utcBoundary(reminderAt)}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
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
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(executablePath)}</Command>
      <Arguments>--pvp-event-reminder=${event.id}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function buildLinuxReminderUnits(
  event: PvpEventDefinition,
  executablePath: string,
  reminderAt: number
): { service: string; timer: string } {
  const unitName = `commonwealth-ga-pvp-${event.id}.service`;
  return {
    service: `[Unit]
Description=Commonwealth GA reminder for ${event.name}

[Service]
Type=oneshot
ExecStart=${systemdArgument(executablePath)} ${systemdArgument(`--pvp-event-reminder=${event.id}`)}
`,
    timer: `# ScheduledAt=${new Date(reminderAt).toISOString()}
[Unit]
Description=Commonwealth GA reminder timer for ${event.name}

[Timer]
OnCalendar=${systemdCalendar(reminderAt)}
AccuracySec=1s
Persistent=false
Unit=${unitName}

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
    const reminders = await Promise.all(
      PVP_EVENTS.map(async (event) => ({
        eventId: event.id,
        enabled:
          support.supported && marker.enabled.includes(event.id)
            ? await this.hasFutureSchedule(event.id)
            : false
      }))
    );
    return { ...support, reminders };
  }

  async setEnabled(eventId: PvpEventId, enabled: boolean): Promise<PvpReminderState> {
    const support = await this.support();
    if (!support.supported) throw new Error(support.detail);
    const marker = await this.readMarker();
    const previouslyEnabled = marker.enabled.includes(eventId);

    if (enabled) {
      try {
        await this.scheduleNext(eventId, this.now());
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
        if (previouslyEnabled) await this.scheduleNext(eventId, this.now()).catch(() => {});
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
    try {
      await this.scheduleNext(eventId, this.now() + 60_000);
    } catch (error) {
      this.log.error(`PvP reminder could not schedule its next occurrence: ${(error as Error).message}`);
    }
    return getPvpEvent(eventId);
  }

  private async support(): Promise<ReminderSupport> {
    if (!this.supportPromise) this.supportPromise = this.detectSupport();
    return this.supportPromise;
  }

  private async detectSupport(): Promise<ReminderSupport> {
    if (!this.options.packaged) {
      return {
        supported: false,
        detail: 'System reminders are available in installed launcher builds.'
      };
    }
    if (this.options.platform === 'win32') {
      return {
        supported: true,
        detail: 'Windows will notify you 15 minutes before enabled events.'
      };
    }
    if (this.options.platform === 'linux') {
      if (!this.options.appImagePath) {
        return {
          supported: false,
          detail: 'System reminders require launching the packaged AppImage directly.'
        };
      }
      try {
        await this.run('systemctl', ['--user', 'show-environment']);
        return {
          supported: true,
          detail:
            'Linux will notify you 15 minutes before enabled events. Disable reminders before moving or deleting this AppImage.'
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

  private launcherExecutable(): string {
    if (this.options.platform === 'linux') {
      if (!this.options.appImagePath) throw new Error('The AppImage path is unavailable');
      return this.options.appImagePath;
    }
    return this.options.executablePath;
  }

  private async scheduleNext(eventId: PvpEventId, after: number): Promise<void> {
    const event = getPvpEvent(eventId);
    const reminderAt = getNextPvpReminderEventStart(eventId, after) - PVP_REMINDER_LEAD_MS;
    if (this.options.platform === 'win32') {
      await mkdir(this.stateDirectory, { recursive: true });
      const xmlPath = this.windowsXmlPath(eventId);
      await writeFile(
        xmlPath,
        buildWindowsReminderTask(event, this.launcherExecutable(), reminderAt),
        { encoding: 'utf-16le' }
      );
      await this.run('schtasks.exe', [
        '/Create',
        '/TN',
        WINDOWS_TASK_NAMES[eventId],
        '/XML',
        xmlPath,
        '/F'
      ]);
      return;
    }

    if (this.options.platform === 'linux') {
      const names = this.linuxUnitNames(eventId);
      const units = buildLinuxReminderUnits(event, this.launcherExecutable(), reminderAt);
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
        await this.run('schtasks.exe', ['/Delete', '/TN', WINDOWS_TASK_NAMES[eventId], '/F']);
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

  private async hasFutureSchedule(eventId: PvpEventId): Promise<boolean> {
    if (this.options.platform === 'win32') {
      const xml = await readFile(this.windowsXmlPath(eventId), { encoding: 'utf-16le' }).catch(
        () => null
      );
      const boundary = xml?.match(/<StartBoundary>([^<]+)<\/StartBoundary>/)?.[1];
      return Boolean(
        boundary && Date.parse(boundary) > this.now() && (await this.windowsTaskExists(eventId))
      );
    }
    if (this.options.platform === 'linux') {
      const names = this.linuxUnitNames(eventId);
      const source = await readFile(join(this.systemdDirectory, names.timer), {
        encoding: 'utf-8'
      }).catch(() => null);
      const scheduledAt = source?.match(/^# ScheduledAt=(.+)$/m)?.[1];
      if (!scheduledAt || Date.parse(scheduledAt) <= this.now()) return false;
      try {
        await this.run('systemctl', ['--user', 'is-active', '--quiet', names.timer]);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  private async windowsTaskExists(eventId: PvpEventId): Promise<boolean> {
    try {
      await this.run('schtasks.exe', ['/Query', '/TN', WINDOWS_TASK_NAMES[eventId]]);
      return true;
    } catch {
      return false;
    }
  }

  private windowsXmlPath(eventId: PvpEventId): string {
    return join(this.stateDirectory, `${eventId}.xml`);
  }

  private linuxUnitNames(eventId: PvpEventId): { service: string; timer: string } {
    const prefix = `commonwealth-ga-pvp-${eventId}`;
    return { service: `${prefix}.service`, timer: `${prefix}.timer` };
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

  private async run(command: string, args: string[]): Promise<void> {
    await execFileP(command, args, {
      encoding: 'utf-8',
      timeout: 15_000,
      windowsHide: true
    });
  }
}

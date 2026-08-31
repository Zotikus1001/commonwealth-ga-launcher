import { useEffect, useMemo, useRef, useState } from 'react';
import {
  formatPvpEventDate,
  formatPvpEventSchedule,
  getPvpCountdownParts,
  getPvpEventStatus,
  PVP_EVENTS,
  type PvpEventStatus
} from '@shared/pvpEvents';
import type { PvpReminderState } from '@shared/types';
import styles from './PvpEventSpotlight.module.css';

function describeCountdown(parts: {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}): string {
  const values = [
    ['day', parts.days],
    ['hour', parts.hours],
    ['minute', parts.minutes],
    ['second', parts.seconds]
  ] as const;
  return values
    .filter(([unit, value]) => unit !== 'day' || value > 0)
    .map(([unit, value]) => `${value} ${unit}${value === 1 ? '' : 's'}`)
    .join(', ');
}

function PvpEventDetailsDialog({
  status,
  onClose
}: {
  status: PvpEventStatus;
  onClose: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [reportsOpening, setReportsOpening] = useState(false);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [reminders, setReminders] = useState<PvpReminderState | null>(null);
  const [reminderChanging, setReminderChanging] = useState<string | null>(null);
  const [reminderError, setReminderError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    let active = true;
    void window.api
      .getPvpReminderState()
      .then((state) => {
        if (active) setReminders(state);
      })
      .catch((error) => {
        if (!active) return;
        setReminders({
          supported: false,
          detail: `Could not read system reminders: ${error instanceof Error ? error.message : String(error)}`,
          reminders: []
        });
      });
    return () => {
      active = false;
    };
  }, []);

  const openReports = async (): Promise<void> => {
    if (reportsOpening) return;
    setReportsOpening(true);
    setReportsError(null);
    try {
      const result = await window.api.openPvpReports();
      if (!result.ok) setReportsError(result.message);
    } catch (error) {
      setReportsError(
        `Could not open PvP Day summaries: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setReportsOpening(false);
    }
  };

  const toggleReminder = async (eventId: (typeof PVP_EVENTS)[number]['id']): Promise<void> => {
    if (!reminders?.supported || reminderChanging) return;
    const enabled = reminders.reminders.find((item) => item.eventId === eventId)?.enabled ?? false;
    setReminderChanging(eventId);
    setReminderError(null);
    try {
      setReminders(await window.api.setPvpEventReminder(eventId, !enabled));
    } catch (error) {
      setReminderError(
        `Could not ${enabled ? 'disable' : 'enable'} the reminder: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      setReminderChanging(null);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="pvp-event-dialog-title"
      aria-describedby="pvp-event-dialog-description"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className={styles.dialogReadout}>
        <span className={styles.readoutSignal} aria-hidden="true" />
        <span>Commonwealth event schedule // Your local time</span>
        <button type="button" className={styles.closeButton} aria-label="Close event details" onClick={onClose}>
          ×
        </button>
      </div>

      <div className={styles.dialogHero}>
        <span className={styles.dialogIndex} aria-hidden="true">EVENTS</span>
        <div>
          <p className={styles.dialogKicker}>
            {status.mode === 'live'
              ? `${status.event.name} is live — join the fun now`
              : `Next event · ${formatPvpEventDate(status.startsAt)}`}
          </p>
          <h2 id="pvp-event-dialog-title">Commonwealth Community Events</h2>
          <p id="pvp-event-dialog-description">
            Two community sessions run every week. Every time below is converted automatically to
            your current system time zone.
          </p>
        </div>
      </div>

      <div className={styles.scheduleGrid}>
        {PVP_EVENTS.map((event, index) => (
          <article className={styles.eventCard} key={event.id}>
            <div className={styles.eventOrdinal} aria-hidden="true">
              0{index + 1}
            </div>
            <div className={styles.eventCardCopy}>
              <span>{formatPvpEventSchedule(event.id)}</span>
              <h3>{event.name}</h3>
              <p>{event.summary}</p>
              <div className={styles.reminderRow}>
                <span>System alert · At event start</span>
                {(() => {
                  const enabled =
                    reminders?.reminders.find((item) => item.eventId === event.id)?.enabled ?? false;
                  const changing = reminderChanging === event.id;
                  return (
                    <button
                      type="button"
                      className={enabled ? styles.reminderEnabled : ''}
                      aria-pressed={enabled}
                      disabled={!reminders?.supported || reminderChanging !== null}
                      title={
                        enabled
                          ? `Disable the ${event.name} system reminder`
                          : `Notify me when ${event.name} starts`
                      }
                      onClick={() => void toggleReminder(event.id)}
                    >
                      {!reminders
                        ? 'CHECKING…'
                        : !reminders.supported
                          ? 'UNAVAILABLE'
                          : changing
                            ? 'UPDATING…'
                            : enabled
                              ? 'REMINDER ON'
                              : 'REMIND ME'}
                    </button>
                  );
                })()}
              </div>
            </div>
          </article>
        ))}
      </div>

      {reminders && <p className={styles.reminderDetail}>{reminders.detail}</p>}
      {reminderError && <p className={styles.reminderError}>{reminderError}</p>}

      <div className={styles.reportsBlock}>
        <div>
          <span className={styles.reportsLabel}>After-action archive</span>
          <strong>PvP Day summaries</strong>
          <p>Browse published session totals, leaderboards, matches, and player breakdowns.</p>
        </div>
        <button type="button" disabled={reportsOpening} onClick={() => void openReports()}>
          {reportsOpening ? 'OPENING…' : 'VIEW REPORTS ↗'}
        </button>
      </div>
      {reportsError && <p className={styles.reportsError}>{reportsError}</p>}
    </dialog>
  );
}

export function PvpEventSpotlight(): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const status = useMemo(() => getPvpEventStatus(now), [now]);
  const live = status.mode === 'live';
  const countdown = live ? null : getPvpCountdownParts(status.startsAt, now);
  const timing = countdown ? describeCountdown(countdown) : 'LIVE';
  const detail = live ? 'Join the fun now' : formatPvpEventDate(status.startsAt);

  return (
    <>
      <section className={`rise ${styles.spotlight} ${live ? styles.spotlightLive : ''}`}>
        <button
          type="button"
          className={styles.spotlightButton}
          aria-haspopup="dialog"
          aria-label={
            live
              ? `${status.event.name} is live. Join the fun now. Open event details.`
              : `${status.event.name} starts in ${timing}, ${detail}. Open event details.`
          }
          onClick={() => setDetailsOpen(true)}
        >
          <span className={styles.signalColumn}>
            <span className={styles.signalBox} aria-hidden="true">
              EVENTS
            </span>
            <span className={styles.signalCaption}>{live ? 'ON AIR' : 'WEEKLY'}</span>
          </span>

          <span className={styles.eventCopy}>
            <small>{live ? 'Weekly community event is live' : 'Next weekly community event'}</small>
            <strong>{status.event.name}</strong>
            <span>{detail}</span>
          </span>

          {countdown ? (
            <span className={styles.timingBlock} aria-hidden="true">
              <small>STARTS IN</small>
              <span className={styles.countdownGrid}>
                {(
                  [
                    ['DAYS', countdown.days],
                    ['HOURS', countdown.hours],
                    ['MIN', countdown.minutes],
                    ['SEC', countdown.seconds]
                  ] as const
                ).map(([label, value]) => (
                  <span className={styles.countdownUnit} key={label}>
                    <strong>{String(value).padStart(2, '0')}</strong>
                    <span>{label}</span>
                  </span>
                ))}
              </span>
            </span>
          ) : (
            <span className={`${styles.timingBlock} ${styles.timingBlockLive}`} aria-hidden="true">
              <small>STATUS</small>
              <span className={styles.liveCallout}>
                <strong className={styles.liveReadout}>LIVE</strong>
                <strong className={styles.liveJoinNow}>JOIN NOW</strong>
              </span>
            </span>
          )}

          <span className={styles.detailsCue} aria-hidden="true">
            DETAILS <b>→</b>
          </span>
        </button>
      </section>
      {detailsOpen && <PvpEventDetailsDialog status={status} onClose={() => setDetailsOpen(false)} />}
    </>
  );
}

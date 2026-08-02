import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { LAUNCHER_CHANGELOG } from '@shared/launcherChangelog';
import { LAUNCHER_CONFIG } from '@shared/generatedLauncherConfig';
import styles from './LauncherChangelogDialog.module.css';

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

function InlineReleaseText({ text }: { text: string }): JSX.Element {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, index): ReactNode => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={index}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return <code key={index}>{part.slice(1, -1)}</code>;
        }
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}

export function LauncherChangelogDialog({
  currentVersion,
  enforceReadDelay,
  onClose
}: {
  currentVersion: string;
  enforceReadDelay: boolean;
  onClose: () => void;
}): JSX.Element {
  const closeDelayMs = enforceReadDelay ? CHANGELOG_CLOSE_DELAY_MS : 0;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(closeDelayMs / 1_000);
  const [showOlderReleases, setShowOlderReleases] = useState(false);
  const canClose = remainingSeconds === 0;
  const canCloseRef = useRef(canClose);
  const onCloseRef = useRef(onClose);
  canCloseRef.current = canClose;
  onCloseRef.current = onClose;
  const visibleReleases = showOlderReleases
    ? LAUNCHER_CHANGELOG
    : LAUNCHER_CHANGELOG.slice(0, 1);
  const olderReleaseCount = LAUNCHER_CHANGELOG.length - 1;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // Chromium's Escape-triggered dialog cancel event is non-cancelable in Electron.
    dialog.setAttribute('closedby', 'none');
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (canCloseRef.current) onCloseRef.current();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    if (!dialog.open) dialog.showModal();
    dialog.focus();
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      if (dialog.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    if (closeDelayMs === 0) {
      setRemainingSeconds(0);
      return;
    }
    const deadline = performance.now() + closeDelayMs;
    setRemainingSeconds(changelogSecondsRemaining(deadline, performance.now()));
    const timer = window.setInterval(() => {
      const next = changelogSecondsRemaining(deadline, performance.now());
      setRemainingSeconds(next);
      if (next === 0) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, [closeDelayMs]);

  const requestClose = (): void => {
    if (canClose) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className={`${styles.dialog} ${showOlderReleases ? styles.dialogExpanded : ''}`}
      aria-labelledby="launcher-changelog-title"
      tabIndex={-1}
    >
      <div className={styles.readout}>
        <span className={styles.signal} aria-hidden="true" />
        <span id="launcher-changelog-title">Launcher Changelog</span>
        <button
          type="button"
          className={styles.closeButton}
          disabled={!canClose}
          aria-label={
            canClose
              ? 'Close changelog'
              : `Close available in ${remainingSeconds} seconds`
          }
          aria-live="polite"
          onClick={requestClose}
        >
          <span aria-hidden="true">{canClose ? '×' : remainingSeconds}</span>
        </button>
      </div>

      <aside className={styles.feedbackNote}>
        <span>
          Please report any <strong>bugs</strong> you encounter. Suggestions for new{' '}
          <strong>features, additions, or changes</strong> are also welcome.
        </span>
        <a
          className={styles.feedbackCta}
          href={LAUNCHER_CONFIG.discordSupportThreadUrl}
          onClick={(event) => {
            event.preventDefault();
            void window.api.openDiscordSupport();
          }}
        >
          Open support thread
        </a>
      </aside>

      <div className={styles.releaseScroll} tabIndex={0} aria-label="Launcher release notes">
        {visibleReleases.map((entry, index) => {
          const releaseBadge = changelogReleaseBadge(entry.version, index, currentVersion);
          const isCurrent = releaseBadge === 'Current release';
          return (
            <Fragment key={entry.version}>
              <article
                className={`${styles.releaseCard} ${isCurrent ? styles.currentRelease : ''}`}
              >
                <div className={styles.releaseHeading}>
                  <h3>
                    <span>{entry.title ?? `v${entry.version}`}</span>
                    {entry.releasedOn && (
                      <time className={styles.releaseDate} dateTime={entry.releasedOn}>
                        {formatChangelogReleaseDate(entry.releasedOn)}
                      </time>
                    )}
                  </h3>
                  {releaseBadge && <span className={styles.releaseBadge}>{releaseBadge}</span>}
                </div>
                {entry.summary && <p className={styles.releaseSummary}>{entry.summary}</p>}
                <ul>
                  {entry.changes.map((change) => (
                    <li key={change}>
                      <InlineReleaseText text={change} />
                    </li>
                  ))}
                </ul>
              </article>
              {index === 0 && olderReleaseCount > 0 && (
                <button
                  type="button"
                  className={styles.olderReleaseToggle}
                  aria-expanded={showOlderReleases}
                  onClick={() => setShowOlderReleases((visible) => !visible)}
                >
                  {showOlderReleases
                    ? 'Hide older changelogs'
                    : `Show older changelogs (${olderReleaseCount})`}
                </button>
              )}
            </Fragment>
          );
        })}
      </div>
    </dialog>
  );
}

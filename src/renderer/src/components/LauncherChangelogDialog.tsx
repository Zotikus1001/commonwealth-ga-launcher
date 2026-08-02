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
): 'Current release' | 'Latest' | null {
  if (index !== 0) return null;
  return entryVersion === currentVersion ? 'Current release' : 'Latest';
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
  onClose
}: {
  currentVersion: string;
  onClose: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(
    CHANGELOG_CLOSE_DELAY_MS / 1_000
  );
  const [showOlderReleases, setShowOlderReleases] = useState(false);
  const canClose = remainingSeconds === 0;
  const visibleReleases = showOlderReleases
    ? LAUNCHER_CHANGELOG
    : LAUNCHER_CHANGELOG.slice(0, 1);
  const olderReleaseCount = LAUNCHER_CHANGELOG.length - 1;

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
    const deadline = performance.now() + CHANGELOG_CLOSE_DELAY_MS;
    setRemainingSeconds(changelogSecondsRemaining(deadline, performance.now()));
    const timer = window.setInterval(() => {
      const next = changelogSecondsRemaining(deadline, performance.now());
      setRemainingSeconds(next);
      if (next === 0) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, []);

  const requestClose = (): void => {
    if (canClose) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="launcher-changelog-title"
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
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
          Please report any <strong>bugs</strong> you encounter below. Suggestions for new{' '}
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
                  <h3>{entry.title ?? `v${entry.version}`}</h3>
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

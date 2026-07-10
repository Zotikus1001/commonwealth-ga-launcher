import { useEffect, useState } from 'react';
import type { ActionResult, LauncherState } from '@shared/types';
import styles from './Play.module.css';

function updateLine(state: LauncherState): { text: string; tone: 'ok' | 'warn' | 'dim' } {
  switch (state.launcherUpdate) {
    case 'up-to-date':
      return { text: `Launcher v${state.launcherVersion} is up to date`, tone: 'ok' };
    case 'checking':
      return { text: 'Checking for launcher updates…', tone: 'dim' };
    case 'downloading':
      return {
        text: `Downloading launcher${state.launcherUpdateVersion ? ` v${state.launcherUpdateVersion}` : ' update'}…`,
        tone: 'warn'
      };
    case 'installing':
      return { text: 'Installing update and restarting…', tone: 'warn' };
    case 'error':
      return { text: 'Launcher update check failed — Play is blocked', tone: 'warn' };
    case 'disabled':
      return { text: `Development run v${state.launcherVersion} — using local out/`, tone: 'dim' };
    default:
      return { text: `Launcher v${state.launcherVersion}`, tone: 'dim' };
  }
}

function relativeTime(value: string): string {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'just now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

interface CtaSpec {
  label: string;
  disabled: boolean;
  action: () => void;
  loading?: boolean;
}

function cta(state: LauncherState, onOpenGameSettings: () => void): CtaSpec {
  switch (state.phase) {
    case 'init':
      return { label: 'CHECKING…', disabled: true, action: () => {} };
    case 'checking':
      if (
        !state.developerMode &&
        state.serverOnline !== true &&
        state.gamePathValid &&
        (state.platform !== 'linux' || state.winePathValid === true)
      ) {
        return {
          label: 'CHECKING SERVER',
          disabled: true,
          action: () => {},
          loading: true
        };
      }
      return { label: 'CHECKING…', disabled: true, action: () => {} };
    case 'launching':
      return { label: 'LAUNCHING…', disabled: true, action: () => {} };
    case 'running':
      return state.developerMode
        ? { label: 'PLAY', disabled: false, action: () => void window.api.play() }
        : { label: 'RUNNING', disabled: true, action: () => {} };
  }
  if (!state.gamePathValid) {
    return { label: 'SET UP GAME', disabled: false, action: onOpenGameSettings };
  }
  if (state.platform === 'linux' && !state.winePathValid) {
    return { label: 'SET WINE RUNNER', disabled: false, action: onOpenGameSettings };
  }
  if (state.phase === 'error') {
    return { label: 'RETRY', disabled: false, action: () => void window.api.refresh() };
  }
  if (!state.developerMode && state.serverOnline !== true) {
    return {
      label: 'CHECKING SERVER',
      disabled: true,
      action: () => {},
      loading: true
    };
  }
  return { label: 'PLAY', disabled: false, action: () => void window.api.play() };
}

export default function Play({
  state,
  onOpenGameSettings
}: {
  state: LauncherState;
  onOpenGameSettings: () => void;
}): JSX.Element {
  const update = updateLine(state);
  const button = cta(state, onOpenGameSettings);
  const online = state.serverOnline;
  const [discordOpening, setDiscordOpening] = useState(false);
  const [discordResult, setDiscordResult] = useState<ActionResult | null>(null);
  const [selectingServer, setSelectingServer] = useState(false);
  const [serverSelectionError, setServerSelectionError] = useState<string | null>(null);
  const [, setClock] = useState(0);
  const canDevLaunch =
    state.developerMode &&
    (state.phase === 'ready' || state.phase === 'running') &&
    state.gamePathValid &&
    (state.platform !== 'linux' || state.winePathValid === true);

  useEffect(() => {
    const timer = window.setInterval(() => setClock((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const openDiscord = async (): Promise<void> => {
    if (discordOpening) return;
    setDiscordOpening(true);
    setDiscordResult(null);
    try {
      setDiscordResult(await window.api.openDiscord());
    } catch (error) {
      setDiscordResult({
        ok: false,
        message: `Could not open Discord: ${error instanceof Error ? error.message : String(error)}`
      });
    } finally {
      setDiscordOpening(false);
    }
  };

  const selectServer = async (id: string): Promise<void> => {
    if (selectingServer || id === state.selectedServerId) return;
    setSelectingServer(true);
    setServerSelectionError(null);
    try {
      await window.api.selectDeveloperServer(id);
    } catch (error) {
      setServerSelectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSelectingServer(false);
    }
  };

  return (
    <div className={styles.play}>
      <div className={`rise ${styles.discordWrap}`} style={{ animationDelay: '40ms' }}>
        <button
          className={styles.discordBanner}
          disabled={discordOpening}
          aria-label="Join the Commonwealth Discord server"
          onClick={() => void openDiscord()}
        >
          <span className={styles.discordBadge}>DISCORD</span>
          <span className={styles.discordCopy}>
            <strong>Join the Commonwealth</strong>
            <small>News, support, squads, and server announcements</small>
          </span>
          <span className={styles.discordJoin}>{discordOpening ? 'OPENING…' : 'JOIN ↗'}</span>
        </button>
        {discordResult && !discordResult.ok && (
          <p className={styles.discordError}>{discordResult.message}</p>
        )}
      </div>

      <div className={styles.grid}>
        <section className={`panel rise ${styles.updates}`} style={{ animationDelay: '100ms' }}>
          <div className={styles.panelHeading}>
            <div className="panel-title">Updates</div>
            <span className={`${styles.updateState} ${styles[update.tone]}`}>{update.text}</span>
          </div>
          {state.progress && (
            <div className={styles.progressWrap}>
              <div className={styles.progressTrack}>
                <div
                  className={`${styles.progressFill} ${state.progress.percent < 0 ? styles.progressIndeterminate : ''}`}
                  style={state.progress.percent >= 0 ? { width: `${state.progress.percent}%` } : undefined}
                />
              </div>
              <span className={`mono ${styles.progressLabel}`}>
                {state.progress.percent >= 0 ? `${state.progress.percent}%` : 'working'}
              </span>
            </div>
          )}
          <div className={styles.historyLabel}>Recent server changes</div>
          {state.serverCommits.length > 0 ? (
            <ol className={styles.commitList}>
              {state.serverCommits.map((commit) => (
                <li key={commit.sha}>
                  <span className={styles.commitMark} aria-hidden="true" />
                  <span className={styles.commitMessage}>{commit.message}</span>
                  <time dateTime={commit.committedAt} title={new Date(commit.committedAt).toLocaleString()}>
                    {relativeTime(commit.committedAt)}
                  </time>
                </li>
              ))}
            </ol>
          ) : (
            <p className={styles.historyEmpty}>
              {state.serverCommitsStatus === 'error'
                ? 'Server history is temporarily unavailable.'
                : state.serverCommitsStatus === 'ready'
                  ? 'No recent server changes found.'
                  : 'Reading server history…'}
            </p>
          )}
        </section>

        <section className={`panel rise ${styles.server}`} style={{ animationDelay: '160ms' }}>
          <div className="panel-title">Server</div>
          <div className={styles.serverName}>{state.serverName || 'Unavailable'}</div>
          <div className={styles.serverRow}>
            <span
              className={`${styles.dot} ${
                online === true ? styles.dotOn : online === false ? styles.dotOff : styles.dotUnknown
              }`}
            />
            <span className={styles.serverStatus}>
              {online === true ? 'ONLINE' : online === false ? 'OFFLINE' : 'PROBING'}
            </span>
          </div>
        </section>
      </div>

      <div className={`rise ${styles.ctaBlock}`} style={{ animationDelay: '220ms' }}>
        <div className={styles.playControls}>
          {state.developerMode && (
            <label className={styles.serverPicker}>
              <span>Launch server</span>
              <select
                value={state.selectedServerId}
                disabled={selectingServer || state.phase === 'checking' || state.phase === 'launching'}
                onChange={(event) => void selectServer(event.currentTarget.value)}
              >
                {state.serverChoices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            className={styles.playButton}
            disabled={button.disabled}
            aria-busy={button.loading || undefined}
            onClick={button.action}
          >
            {button.loading && <span className={styles.serverSpinner} aria-hidden="true" />}
            <span>{button.label}</span>
          </button>
          {state.developerMode && (
            <button
              className={styles.devPlayButton}
              disabled={!canDevLaunch}
              onClick={() => void window.api.playDeveloper()}
            >
              DEV LAUNCH
            </button>
          )}
        </div>
        {serverSelectionError && <p className={styles.errorDetails}>{serverSelectionError}</p>}
        {state.statusLine !== 'Ready.' && (
          <p className={styles.statusLine}>{state.statusLine}</p>
        )}
        {state.phase === 'error' && state.errorDetails && (
          <p className={`mono ${styles.errorDetails}`}>{state.errorDetails}</p>
        )}
      </div>
    </div>
  );
}

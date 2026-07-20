import { useEffect, useState } from 'react';
import type { ActionResult, LauncherState } from '@shared/types';
import { DEFAULT_SERVER_ID } from '@shared/serverProfiles';
import styles from './Play.module.css';

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
  if (state.launcherUpdate === 'downloading') {
    return {
      label: 'DOWNLOADING UPDATE',
      disabled: true,
      action: () => {},
      loading: true
    };
  }
  if (state.launchCoolingDown) {
    return { label: 'LAUNCHING…', disabled: true, action: () => {} };
  }
  switch (state.phase) {
    case 'init':
      return { label: 'CHECKING…', disabled: true, action: () => {} };
    case 'checking':
      if (
        !state.developerMode &&
        state.serverStatus === 'checking' &&
        state.gamePathValid &&
        (state.platform !== 'linux' || state.linuxRuntimeStatus === 'ready')
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
  }
  if (!state.gamePathValid) {
    return { label: 'SET UP GAME', disabled: false, action: onOpenGameSettings };
  }
  if (state.platform === 'linux' && state.linuxRuntimeStatus !== 'ready') {
    return { label: 'SET UP GAME', disabled: false, action: onOpenGameSettings };
  }
  if (state.phase === 'error') {
    return { label: 'RETRY', disabled: false, action: () => void window.api.refresh() };
  }
  if (!state.developerMode) {
    if (state.serverStatus === 'checking') {
      return {
        label: 'CHECKING SERVER',
        disabled: true,
        action: () => {},
        loading: true
      };
    }
    if (state.serverStatus === 'invalid') {
      return { label: 'INVALID SERVER ADDRESS', disabled: true, action: () => {} };
    }
    if (state.serverStatus === 'offline') {
      return {
        label: 'CHECK SERVER',
        disabled: false,
        action: () => void window.api.checkServer()
      };
    }
  }
  return { label: 'PLAY', disabled: false, action: () => void window.api.play() };
}

export default function Play({
  state,
  onOpenGameSettings,
  onOpenInfo
}: {
  state: LauncherState;
  onOpenGameSettings: () => void;
  onOpenInfo: () => void;
}): JSX.Element {
  const button = cta(state, onOpenGameSettings);
  const serverStatus = state.serverStatus;
  const [discordOpening, setDiscordOpening] = useState(false);
  const [discordResult, setDiscordResult] = useState<ActionResult | null>(null);
  const [agendaStatsOpening, setAgendaStatsOpening] = useState(false);
  const [agendaStatsOpenError, setAgendaStatsOpenError] = useState<string | null>(null);
  const [selectingServer, setSelectingServer] = useState(false);
  const [serverSelectionError, setServerSelectionError] = useState<string | null>(null);
  const [, setClock] = useState(0);
  const canDevLaunch =
    state.developerMode &&
    state.launcherUpdate !== 'downloading' &&
    state.phase === 'ready' &&
    !state.launchCoolingDown &&
    state.gamePathValid &&
    (state.platform !== 'linux' || state.linuxRuntimeStatus === 'ready');
  const showsAgendaStats =
    state.selectedServerId === DEFAULT_SERVER_ID &&
    state.agendaStatsStatus === 'ready' &&
    state.agendaStatsText !== null;

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

  const openAgendaStats = async (): Promise<void> => {
    if (agendaStatsOpening) return;
    setAgendaStatsOpening(true);
    setAgendaStatsOpenError(null);
    try {
      const result = await window.api.openAgendaStats();
      if (!result.ok) setAgendaStatsOpenError(result.message);
    } catch (error) {
      setAgendaStatsOpenError(
        `Could not open Agenda Stats: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setAgendaStatsOpening(false);
    }
  };

  const selectServer = async (id: string): Promise<void> => {
    if (selectingServer || id === state.selectedServerId) return;
    setSelectingServer(true);
    setServerSelectionError(null);
    try {
      await window.api.selectServer(id);
    } catch (error) {
      setServerSelectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSelectingServer(false);
    }
  };

  return (
    <div className={styles.play}>
      <div className={`rise ${styles.utilityGrid}`} style={{ animationDelay: '40ms' }}>
        <div className={styles.discordWrap}>
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
        <button
          className={styles.infoBanner}
          aria-label="Open player information and frequently asked questions"
          onClick={onOpenInfo}
        >
          <span className={styles.infoBadge} aria-hidden="true">
            i
          </span>
          <span className={styles.infoBannerCopy}>
            <strong>Player Info</strong>
            <small>Stutter fixes · DX9 · account FAQ</small>
          </span>
          <span className={styles.infoOpen}>OPEN →</span>
        </button>
      </div>

      <div className={styles.grid}>
        <section className={`panel rise ${styles.updates}`} style={{ animationDelay: '100ms' }}>
          <div className="panel-title">Server Updates</div>
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
                serverStatus === 'online'
                  ? styles.dotOn
                  : serverStatus === 'offline'
                    ? styles.dotOff
                    : serverStatus === 'invalid'
                      ? styles.dotInvalid
                      : styles.dotUnknown
              }`}
            />
            <span className={styles.serverStatus}>
              {serverStatus === 'online'
                ? 'ONLINE'
                : serverStatus === 'offline'
                  ? 'OFFLINE'
                  : serverStatus === 'invalid'
                    ? 'INVALID ADDRESS'
                    : 'PROBING'}
            </span>
          </div>
          {showsAgendaStats && (
            <div className={styles.agendaStats}>
              <div className={styles.agendaStatsPopulation}>
                <span className={styles.agendaStatsLabel}>Live population</span>
                <span
                  className={`${styles.agendaStatsValue} ${styles.agendaStatsReady}`}
                  role="status"
                  aria-live="polite"
                >
                  <span className={styles.agendaStatsSignal} aria-hidden="true" />
                  <span className={styles.agendaStatsText}>{state.agendaStatsText}</span>
                </span>
              </div>
              <button
                className={styles.agendaStatsButton}
                disabled={agendaStatsOpening}
                title="View recorded PvP, PvE, mission, and player statistics"
                onClick={() => void openAgendaStats()}
              >
                <span className={styles.agendaStatsButtonCopy}>
                  <strong>Agenda Stats</strong>
                  <small>PvP · PvE · player records</small>
                </span>
                <span className={styles.agendaStatsOpen}>
                  {agendaStatsOpening ? 'OPENING…' : 'VIEW ↗'}
                </span>
              </button>
              {agendaStatsOpenError && (
                <p className={styles.agendaStatsOpenError}>{agendaStatsOpenError}</p>
              )}
            </div>
          )}
        </section>
      </div>

      <div className={`rise ${styles.ctaBlock}`} style={{ animationDelay: '220ms' }}>
        <div className={styles.playControls}>
          {state.serverChoices.length > 1 && (
            <label className={styles.serverPicker}>
              <span>Launch Server</span>
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

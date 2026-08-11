import { useEffect, useRef, useState } from 'react';
import type {
  ActionResult,
  DlcStatus,
  LauncherState,
  ProfilePlayAction,
  ProfilePlayDecision,
  ProfilePlayPrompt,
  ProfileSwitchDecision,
  ProfileSwitchPrompt
} from '@shared/types';
import { DEFAULT_SERVER_ID } from '@shared/serverProfiles';
import {
  ProfileChangeSummary,
  ProfileSwitchDialog
} from '../components/ProfileSwitchDialog';
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

export function DlcActivityProgress({ dlc }: { dlc: DlcStatus }): JSX.Element {
  const progressPercent = dlc.progressPercent;
  const determinate = typeof progressPercent === 'number' && progressPercent >= 0;
  const percent = determinate
    ? Math.min(100, Math.max(0, Math.round(progressPercent)))
    : -1;
  const operation =
    dlc.progressPhase === 'download'
      ? 'Downloading'
      : dlc.status === 'removing'
        ? 'Removing'
        : 'Installing';
  return (
    <div className={styles.dlcActivity} aria-live="polite" title={dlc.detail}>
      <div className={styles.dlcActivityHead}>
        <span className={styles.dlcActivityOperation}>{operation}</span>
        <span className={styles.dlcActivityName}>{dlc.name}</span>
        <strong>{determinate ? `${percent}%` : 'WORKING'}</strong>
      </div>
      <div
        className={styles.dlcActivityTrack}
        role="progressbar"
        aria-label={`${operation} ${dlc.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? percent : undefined}
      >
        <span
          className={`${styles.dlcActivityFill} ${
            determinate ? '' : styles.dlcActivityIndeterminate
          }`}
          style={determinate ? { width: `${percent}%` } : undefined}
        />
      </div>
    </div>
  );
}

export function ProfilePlayDialog({
  prompt,
  onDecision,
  onCancel
}: {
  prompt: ProfilePlayPrompt;
  onDecision: (action: ProfilePlayAction) => void;
  onCancel: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const profileLabel = `Profile #${prompt.profileNumber}`;
  return (
    <dialog
      ref={dialogRef}
      className={styles.profilePlayDialog}
      aria-labelledby="profile-play-title"
      aria-describedby="profile-play-description profile-play-consequence"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div className={styles.profilePlayReadout}>
        <span className={styles.profilePlaySignal} aria-hidden="true" />
        <span>Selected {profileLabel}</span>
      </div>
      <div className={styles.profilePlayBody}>
        <div className={styles.profilePlayNumber} aria-hidden="true">
          {String(prompt.profileNumber).padStart(2, '0')}
        </div>
        <div className={styles.profilePlayCopy}>
          <h2 id="profile-play-title">Save your in-game settings?</h2>
          <p id="profile-play-description">
            Your in-game settings were changed. Save them to your selected {profileLabel}?
          </p>
        </div>
      </div>
      <ProfileChangeSummary items={prompt.changeSummary} />
      <p id="profile-play-consequence" className={styles.profilePlayConsequence}>
        <span aria-hidden="true">!</span>
        <span>
          <strong>Use Profile &amp; Play</strong> starts with {profileLabel} without saving your new
          settings.
        </span>
      </p>
      <div className={styles.profilePlayActions}>
        <button
          type="button"
          className={styles.profilePlaySave}
          autoFocus
          onClick={() => onDecision('save-current')}
        >
          Save to Profile &amp; Play
        </button>
        <button
          type="button"
          className={styles.profilePlayUseSaved}
          onClick={() => onDecision('use-saved')}
        >
          Use Profile &amp; Play
        </button>
        <button type="button" className={styles.profilePlayCancel} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}

function cta(
  state: LauncherState,
  onOpenGameSettings: () => void,
  onPlay: () => void,
  launchRequestPending: boolean
): CtaSpec {
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
  if (launchRequestPending) {
    return { label: 'CHECKING…', disabled: true, action: () => {}, loading: true };
  }
  switch (state.phase) {
    case 'init':
      return { label: 'CHECKING…', disabled: true, action: () => {} };
    case 'checking':
      if (
        !state.developerMode &&
        state.serverStatus === 'checking' &&
        state.gamePathValid &&
        state.gameConfigReady &&
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
  if (!state.gameConfigReady) {
    return { label: 'FIRST LAUNCH REQUIRED', disabled: true, action: () => {} };
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
  return { label: 'PLAY', disabled: false, action: onPlay };
}

interface PendingProfilePlay {
  prompt: ProfilePlayPrompt;
  developerLaunch: boolean;
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
  const serverStatus = state.serverStatus;
  const activeDlcOperation = state.dlcs.find(
    (dlc) => dlc.status === 'installing' || dlc.status === 'removing'
  );
  const [discordOpening, setDiscordOpening] = useState(false);
  const [discordResult, setDiscordResult] = useState<ActionResult | null>(null);
  const [agendaStatsOpening, setAgendaStatsOpening] = useState(false);
  const [agendaStatsOpenError, setAgendaStatsOpenError] = useState<string | null>(null);
  const [gaCardsOpening, setGaCardsOpening] = useState(false);
  const [gaCardsOpenError, setGaCardsOpenError] = useState<string | null>(null);
  const [selectingServer, setSelectingServer] = useState(false);
  const [serverSelectionError, setServerSelectionError] = useState<string | null>(null);
  const [selectingProfile, setSelectingProfile] = useState(false);
  const profileSelectionInFlight = useRef(false);
  const [profileSelectionError, setProfileSelectionError] = useState<string | null>(null);
  const [pendingProfileSwitch, setPendingProfileSwitch] = useState<ProfileSwitchPrompt | null>(null);
  const [pendingProfilePlay, setPendingProfilePlay] = useState<PendingProfilePlay | null>(null);
  const [launchRequestPending, setLaunchRequestPending] = useState(false);
  const launchRequestInFlight = useRef(false);
  const [launchRequestError, setLaunchRequestError] = useState<string | null>(null);
  const [, setClock] = useState(0);
  const canDevLaunch =
    state.developerMode &&
    state.launcherUpdate !== 'downloading' &&
    state.phase === 'ready' &&
    !state.launchCoolingDown &&
    !launchRequestPending &&
    state.gamePathValid &&
    state.gameConfigReady &&
    (state.platform !== 'linux' || state.linuxRuntimeStatus === 'ready');
  const showsAgendaStats =
    state.selectedServerId === DEFAULT_SERVER_ID &&
    state.agendaStatsStatus === 'ready' &&
    state.agendaStatsText !== null;
  const profileSelectionDisabled =
    selectingProfile ||
    state.activeGameInstances > 0 ||
    state.launchCoolingDown ||
    state.phase === 'checking' ||
    state.phase === 'launching' ||
    state.launcherUpdate === 'downloading' ||
    state.launcherUpdate === 'installing';

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

  const openGaCards = async (): Promise<void> => {
    if (gaCardsOpening) return;
    setGaCardsOpening(true);
    setGaCardsOpenError(null);
    try {
      const result = await window.api.openGaCards();
      if (!result.ok) setGaCardsOpenError(result.message);
    } catch (error) {
      setGaCardsOpenError(
        `Could not open GA CARDS: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setGaCardsOpening(false);
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

  const selectProfile = async (
    id: string,
    decision?: ProfileSwitchDecision
  ): Promise<void> => {
    if (
      profileSelectionDisabled ||
      profileSelectionInFlight.current ||
      id === state.selectedGameProfileId
    ) {
      return;
    }
    profileSelectionInFlight.current = true;
    setSelectingProfile(true);
    setProfileSelectionError(null);
    try {
      const prompt = await window.api.selectGameProfile(id, decision);
      setPendingProfileSwitch(prompt);
    } catch (error) {
      setProfileSelectionError(error instanceof Error ? error.message : String(error));
    } finally {
      profileSelectionInFlight.current = false;
      setSelectingProfile(false);
    }
  };

  const requestPlay = async (
    developerLaunch: boolean,
    decision?: ProfilePlayDecision
  ): Promise<void> => {
    if (launchRequestInFlight.current) return;
    launchRequestInFlight.current = true;
    setLaunchRequestPending(true);
    setLaunchRequestError(null);
    if (decision) setPendingProfilePlay(null);
    try {
      const prompt = developerLaunch
        ? await window.api.playDeveloper(decision)
        : await window.api.play(decision);
      setPendingProfilePlay(prompt ? { prompt, developerLaunch } : null);
    } catch (error) {
      setLaunchRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      launchRequestInFlight.current = false;
      setLaunchRequestPending(false);
    }
  };

  const button = cta(
    state,
    onOpenGameSettings,
    () => void requestPlay(false),
    launchRequestPending
  );
  const launchCheckPending =
    state.phase === 'init' ||
    state.phase === 'checking' ||
    button.label === 'CHECKING SERVER';

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
          aria-label="Open frequently asked questions"
          onClick={onOpenInfo}
        >
          <span className={styles.infoBadge} aria-hidden="true">
            i
          </span>
          <span className={styles.infoBannerCopy}>
            <strong>FAQ</strong>
            <small>Performance · Commands · Etc</small>
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
          {state.gameProfilesEnabled && state.gameProfiles.length > 0 && (
            <div className={styles.profileNumbers} aria-label="Game settings profiles">
              {state.gameProfiles.map((profile, index) => {
                const active = profile.id === state.selectedGameProfileId;
                return (
                  <button
                    key={profile.id}
                    className={`${styles.profileNumber} ${active ? styles.profileNumberActive : ''}`}
                    data-profile-name={profile.name}
                    title={profile.name}
                    aria-label={`Profile ${index + 1}: ${profile.name}${active ? ', active' : ''}`}
                    aria-pressed={active}
                    disabled={profileSelectionDisabled}
                    onClick={() => void selectProfile(profile.id)}
                  >
                    {index + 1}
                  </button>
                );
              })}
            </div>
          )}
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
          <div className={styles.serverResources}>
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
            <button
              className={`${styles.agendaStatsButton} ${styles.gaCardsButton}`}
              disabled={gaCardsOpening}
              title="Open the GA CARDS website"
              aria-label="Open the GA CARDS website"
              onClick={() => void openGaCards()}
            >
              <span className={styles.agendaStatsButtonCopy}>
                <strong>GA CARDS</strong>
                <small>Global Agenda card game</small>
              </span>
              <span className={`${styles.agendaStatsOpen} ${styles.gaCardsOpen}`}>
                {gaCardsOpening ? 'OPENING…' : 'VISIT ↗'}
              </span>
            </button>
            {gaCardsOpenError && (
              <p className={styles.agendaStatsOpenError}>{gaCardsOpenError}</p>
            )}
          </div>
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
          <div
            className={`${styles.launchActionSlot} ${
              state.developerMode ? styles.launchActionSlotDeveloper : ''
            }`}
          >
            {activeDlcOperation ? (
              <DlcActivityProgress dlc={activeDlcOperation} />
            ) : launchCheckPending ? (
              <div
                className={styles.launchChecking}
                role="status"
                aria-label="Checking launcher readiness"
              >
                <span className={styles.serverSpinner} aria-hidden="true" />
              </div>
            ) : (
              <>
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
                    onClick={() => void requestPlay(true)}
                  >
                    DEV LAUNCH
                  </button>
                )}
              </>
            )}
          </div>
        </div>
        {profileSelectionError && <p className={styles.errorDetails}>{profileSelectionError}</p>}
        {serverSelectionError && <p className={styles.errorDetails}>{serverSelectionError}</p>}
        {launchRequestError && <p className={styles.errorDetails}>{launchRequestError}</p>}
        {!activeDlcOperation && !launchCheckPending && state.statusLine !== 'Ready.' && (
          <p className={styles.statusLine}>{state.statusLine}</p>
        )}
        {state.phase === 'error' && state.errorDetails && (
          <p className={`mono ${styles.errorDetails}`}>{state.errorDetails}</p>
        )}
      </div>
      {pendingProfilePlay && (
        <ProfilePlayDialog
          key={pendingProfilePlay.prompt.comparisonToken}
          prompt={pendingProfilePlay.prompt}
          onDecision={(action) =>
            void requestPlay(pendingProfilePlay.developerLaunch, {
              action,
              profileId: pendingProfilePlay.prompt.profileId,
              comparisonToken: pendingProfilePlay.prompt.comparisonToken
            })
          }
          onCancel={() => {
            setPendingProfilePlay(null);
            setLaunchRequestError(null);
          }}
        />
      )}
      {pendingProfileSwitch && (
        <ProfileSwitchDialog
          key={`${pendingProfileSwitch.targetProfileId}:${pendingProfileSwitch.comparisonToken}`}
          prompt={pendingProfileSwitch}
          onDecision={(action) =>
            void selectProfile(pendingProfileSwitch.targetProfileId, {
              action,
              profileId: pendingProfileSwitch.profileId,
              targetProfileId: pendingProfileSwitch.targetProfileId,
              comparisonToken: pendingProfileSwitch.comparisonToken
            })
          }
          onCancel={() => {
            setPendingProfileSwitch(null);
            setProfileSelectionError(null);
          }}
        />
      )}
    </div>
  );
}

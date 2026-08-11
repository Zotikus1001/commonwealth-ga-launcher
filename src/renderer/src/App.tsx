import { useEffect, useRef, useState } from 'react';
import type { LauncherState } from '@shared/types';
import { LAUNCHER_CONFIG } from '@shared/generatedLauncherConfig';
import Play from './screens/Play';
import Settings, { type SettingsHandle, type SettingsTab } from './screens/Settings';
import { LauncherChangelogDialog } from './components/LauncherChangelogDialog';
import styles from './App.module.css';

const manualUpdateRepository = LAUNCHER_CONFIG.updateRepositories[0];
const manualUpdateUrl =
  `https://github.com/${manualUpdateRepository.owner}/${manualUpdateRepository.repo}/releases/latest`;

function updateCheckFailureTitle(error: string | null): string {
  const httpError = error?.match(/HTTP\s+\d{3}/i)?.[0].toUpperCase();
  const normalizedError = error?.replace(/\s+/g, ' ').trim();
  const detail = httpError ?? (normalizedError ? normalizedError.slice(0, 160) : 'Unknown error');
  return [
    'Could not retrieve launcher update information from GitHub.',
    `Error: ${detail}`,
    'The launcher should still work normally.',
    `Download updates manually: ${manualUpdateUrl}`
  ].join('\n');
}

function launcherUpdateLabel(state: LauncherState): {
  text: string;
  tone: 'ok' | 'warn' | 'error' | 'dim';
  title: string;
} {
  switch (state.launcherUpdate) {
    case 'up-to-date':
      return { text: 'Up to date', tone: 'ok', title: 'Launcher is up to date' };
    case 'checking':
      return { text: 'Checking updates…', tone: 'dim', title: 'Checking for launcher updates' };
    case 'downloading':
      return {
        text: state.launcherUpdateVersion
          ? `Downloading v${state.launcherUpdateVersion}…`
          : 'Downloading update…',
        tone: 'warn',
        title: 'Downloading launcher update'
      };
    case 'installing':
      return { text: 'Installing update…', tone: 'warn', title: 'Installing launcher update' };
    case 'check-failed':
      return {
        text: 'Update status ?',
        tone: 'dim',
        title: updateCheckFailureTitle(state.launcherUpdateError)
      };
    case 'error':
      return {
        text: 'Update Failed',
        tone: 'warn',
        title: state.launcherUpdateError ?? 'Launcher update check failed'
      };
    case 'disabled':
      return { text: 'Local build', tone: 'dim', title: 'Online updates disabled in development' };
    default:
      return { text: 'Update pending', tone: 'dim', title: 'Launcher update check pending' };
  }
}

function SteamLaunchOfferDialog({
  onDecision
}: {
  onDecision: (setUp: boolean) => Promise<void>;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.setAttribute('closedby', 'none');
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const decide = async (setUp: boolean): Promise<void> => {
    if (saving) return;
    setSaving(true);
    await onDecision(setUp);
  };

  return (
    <dialog
      ref={dialogRef}
      className={styles.steamOfferDialog}
      aria-labelledby="steam-offer-title"
      aria-describedby="steam-offer-description"
      onCancel={(event) => {
        event.preventDefault();
        void decide(false);
      }}
    >
      <div className={styles.steamOfferReadout}>Steam // Launcher Link</div>
      <div className={styles.steamOfferBody}>
        <span className={styles.steamOfferMark} aria-hidden="true">
          S
        </span>
        <div>
          <h2 id="steam-offer-title">Launch Global Agenda through Steam?</h2>
          <p id="steam-offer-description">
            Keep Steam playtime tracking and use the Steam overlay while launching through
            Commonwealth GA Launcher.
          </p>
        </div>
      </div>
      <div className={styles.steamOfferActions}>
        <button type="button" disabled={saving} onClick={() => void decide(true)} autoFocus>
          {saving ? 'Opening…' : 'Set Up'}
        </button>
        <button type="button" disabled={saving} onClick={() => void decide(false)}>
          No Thanks
        </button>
      </div>
    </dialog>
  );
}

function GameFirstRunDialog({
  onClose
}: {
  onClose: () => void;
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

  return (
    <dialog
      ref={dialogRef}
      className={styles.steamOfferDialog}
      aria-labelledby="game-first-run-title"
      aria-describedby="game-first-run-description"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className={styles.steamOfferReadout}>First-time game setup</div>
      <div className={styles.steamOfferBody}>
        <span className={styles.steamOfferMark} aria-hidden="true">
          1
        </span>
        <div>
          <h2 id="game-first-run-title">Run Global Agenda once first</h2>
          <p id="game-first-run-description">
            Close this launcher, then open Global Agenda from Steam once. Reach the login screen,
            close the game, then reopen this launcher.
          </p>
        </div>
      </div>
      <div className={`${styles.steamOfferActions} ${styles.gameFirstRunActions}`}>
        <button type="button" onClick={onClose} autoFocus>
          OK
        </button>
      </div>
    </dialog>
  );
}

export default function App(): JSX.Element {
  const [state, setState] = useState<LauncherState | null>(null);
  const [view, setView] = useState<'play' | 'settings'>('play');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('game');
  const [changelogOpenMode, setChangelogOpenMode] = useState<
    'automatic' | 'manual' | null
  >(null);
  const [steamLaunchOfferOpen, setSteamLaunchOfferOpen] = useState(false);
  const [gameFirstRunOpen, setGameFirstRunOpen] = useState(false);
  const [changelogStatusChecked, setChangelogStatusChecked] = useState(false);
  const gameFirstRunShown = useRef(false);
  const steamLaunchOfferChecked = useRef(false);
  const settingsRef = useRef<SettingsHandle>(null);

  const openSettings = (tab: SettingsTab): void => {
    setSettingsTab(tab);
    setView('settings');
  };

  useEffect(() => {
    let mounted = true;
    void window.api.getState().then((s) => {
      if (mounted) setState(s);
    });
    void window.api
      .getLauncherChangelogStatus()
      .then((status) => {
        if (mounted && status.showOnStartup) {
          setChangelogOpenMode((mode) => mode ?? 'automatic');
        }
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setChangelogStatusChecked(true);
      });
    const unsubscribe = window.api.onState((s) => setState(s));
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (
      !state ||
      !changelogStatusChecked ||
      changelogOpenMode ||
      steamLaunchOfferOpen ||
      gameFirstRunShown.current ||
      !state.gamePathValid ||
      state.gameConfigReady
    ) {
      return;
    }
    gameFirstRunShown.current = true;
    setGameFirstRunOpen(true);
  }, [changelogOpenMode, changelogStatusChecked, state, steamLaunchOfferOpen]);

  useEffect(() => {
    if (
      !state ||
      !changelogStatusChecked ||
      changelogOpenMode ||
      gameFirstRunOpen ||
      steamLaunchOfferOpen ||
      steamLaunchOfferChecked.current ||
      !state.gameConfigReady
    ) {
      return;
    }
    steamLaunchOfferChecked.current = true;
    void window.api
      .shouldOfferSteamLaunchIntegration()
      .then((shouldOffer) => setSteamLaunchOfferOpen(shouldOffer))
      .catch(() => {});
  }, [changelogOpenMode, changelogStatusChecked, gameFirstRunOpen, state, steamLaunchOfferOpen]);

  if (!state) {
    return <div className={styles.boot}>COMMONWEALTH GA</div>;
  }
  const launcherUpdate = launcherUpdateLabel(state);
  const updateDownloading = state.launcherUpdate === 'downloading';
  const closeChangelog = (): void => {
    setChangelogOpenMode(null);
    void window.api.acknowledgeLauncherChangelog().catch(() => {});
  };

  const respondToSteamLaunchOffer = async (setUp: boolean): Promise<void> => {
    await window.api.acknowledgeSteamLaunchIntegrationOffer().catch(() => {});
    setSteamLaunchOfferOpen(false);
    if (setUp) openSettings('launcher');
  };

  return (
    <div className={styles.shell}>
      <div className={styles.topline} />
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.wordmark}>COMMONWEALTH GA</span>
          <span className={styles.tagline}>GLOBAL AGENDA PRIVATE SERVER</span>
        </div>
        <div className={styles.headerRight}>
          <div className={styles.versionGroup}>
            <button
              type="button"
              className={`mono ${styles.versionButton} ${
                state.launcherUpdate === 'check-failed' ? styles.versionButtonDim : ''
              }`}
              title="Open launcher changelog"
              aria-label={`Open launcher changelog for version ${state.launcherVersion}`}
              aria-haspopup="dialog"
              onClick={() => setChangelogOpenMode('manual')}
            >
              v{state.launcherVersion}
            </button>
            <span
              className={`${styles.updateStatus} ${styles[launcherUpdate.tone]}`}
              title={launcherUpdate.title}
              role="status"
              aria-live="polite"
            >
              {launcherUpdate.text}
            </span>
          </div>
          <button
            disabled={updateDownloading}
            title={updateDownloading ? 'Settings are unavailable while the launcher update downloads.' : undefined}
            onClick={() => {
              if (view === 'play') openSettings('game');
              else settingsRef.current?.requestBack();
            }}
          >
            {view === 'play' ? 'Settings' : 'Back'}
          </button>
        </div>
      </header>

      <main className={styles.body}>
        {view === 'play' ? (
          <Play
            state={state}
            onOpenGameSettings={() => openSettings('game')}
            onOpenInfo={() => openSettings('info')}
          />
        ) : (
          <fieldset className={styles.settingsGate} disabled={updateDownloading}>
            <Settings
              ref={settingsRef}
              state={state}
              initialTab={settingsTab}
              onBack={() => setView('play')}
            />
          </fieldset>
        )}
      </main>
      {changelogOpenMode && (
        <LauncherChangelogDialog
          currentVersion={state.launcherVersion}
          enforceReadDelay={changelogOpenMode === 'automatic'}
          onClose={closeChangelog}
        />
      )}
      {steamLaunchOfferOpen && (
        <SteamLaunchOfferDialog onDecision={respondToSteamLaunchOffer} />
      )}
      {gameFirstRunOpen && (
        <GameFirstRunDialog
          onClose={() => setGameFirstRunOpen(false)}
        />
      )}
    </div>
  );
}

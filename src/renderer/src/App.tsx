import { useEffect, useRef, useState } from 'react';
import type { LauncherState } from '@shared/types';
import { LAUNCHER_CONFIG } from '@shared/generatedLauncherConfig';
import Play from './screens/Play';
import Settings, { type SettingsHandle, type SettingsTab } from './screens/Settings';
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

export default function App(): JSX.Element {
  const [state, setState] = useState<LauncherState | null>(null);
  const [view, setView] = useState<'play' | 'settings'>('play');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('game');
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
    const unsubscribe = window.api.onState((s) => setState(s));
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  if (!state) {
    return <div className={styles.boot}>COMMONWEALTH GA</div>;
  }
  const launcherUpdate = launcherUpdateLabel(state);
  const updateDownloading = state.launcherUpdate === 'downloading';

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
            <span className={`mono ${styles.version}`} title="Launcher version">
              v{state.launcherVersion}
            </span>
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
          <Play state={state} onOpenGameSettings={() => openSettings('game')} />
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
    </div>
  );
}

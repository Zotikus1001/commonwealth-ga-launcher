import { useEffect, useRef, useState } from 'react';
import type { LauncherState } from '@shared/types';
import Play from './screens/Play';
import Settings, { type SettingsHandle, type SettingsTab } from './screens/Settings';
import styles from './App.module.css';

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

  return (
    <div className={styles.shell}>
      <div className={styles.topline} />
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.wordmark}>COMMONWEALTH GA</span>
          <span className={styles.tagline}>GLOBAL AGENDA PRIVATE SERVER</span>
        </div>
        <div className={styles.headerRight}>
          <span className={`mono ${styles.version}`} title="Launcher version">
            v{state.launcherVersion}
          </span>
          <button
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
          <Settings
            ref={settingsRef}
            state={state}
            initialTab={settingsTab}
            onBack={() => setView('play')}
          />
        )}
      </main>
    </div>
  );
}

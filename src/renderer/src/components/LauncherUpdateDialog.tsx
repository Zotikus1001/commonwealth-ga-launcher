import { useEffect, useRef, useState } from 'react';
import styles from '../App.module.css';

export function LauncherUpdateDialog({ version, onLater }: {
  version: string;
  onLater: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  const update = async (): Promise<void> => {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      await window.api.downloadLauncherUpdate(version);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setStarting(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className={styles.steamOfferDialog}
      aria-labelledby="launcher-update-title"
      aria-describedby="launcher-update-description"
      onCancel={(event) => { event.preventDefault(); if (!starting) onLater(); }}
    >
      <div className={styles.steamOfferReadout}>Launcher update // v{version}</div>
      <div className={styles.steamOfferBody}>
        <span className={styles.steamOfferMark} aria-hidden="true">↑</span>
        <div>
          <h2 id="launcher-update-title">Update launcher now?</h2>
          <p id="launcher-update-description">
            Version {version} is available. Updating will download the new version and restart
            the launcher. Ask again later to be reminded next time you open the launcher.
          </p>
          {error && <p role="alert">{error}</p>}
        </div>
      </div>
      <div className={styles.steamOfferActions}>
        <button type="button" disabled={starting} onClick={() => void update()}>
          {starting ? 'Starting update…' : 'Update now'}
        </button>
        <button type="button" disabled={starting} onClick={onLater} autoFocus>
          Ask again later
        </button>
      </div>
    </dialog>
  );
}

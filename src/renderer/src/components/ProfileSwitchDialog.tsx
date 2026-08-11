import { useEffect, useRef } from 'react';
import type { ProfileSwitchAction, ProfileSwitchPrompt } from '@shared/types';
import styles from '../screens/Play.module.css';

export function ProfileSwitchDialog({
  prompt,
  onDecision,
  onCancel
}: {
  prompt: ProfileSwitchPrompt;
  onDecision: (action: ProfileSwitchAction) => void;
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

  const currentLabel = `Profile #${prompt.profileNumber}`;
  const targetLabel = `Profile #${prompt.targetProfileNumber}`;
  return (
    <dialog
      ref={dialogRef}
      className={styles.profilePlayDialog}
      aria-labelledby="profile-switch-title"
      aria-describedby="profile-switch-description"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div className={styles.profilePlayReadout}>
        <span className={styles.profilePlaySignal} aria-hidden="true" />
        <span>
          Profile switch // {String(prompt.profileNumber).padStart(2, '0')} →{' '}
          {String(prompt.targetProfileNumber).padStart(2, '0')}
        </span>
      </div>
      <div className={styles.profilePlayBody}>
        <div className={styles.profilePlayNumber} aria-hidden="true">
          {String(prompt.targetProfileNumber).padStart(2, '0')}
        </div>
        <div className={styles.profilePlayCopy}>
          <h2 id="profile-switch-title">Save changes before switching?</h2>
          <p id="profile-switch-description">
            Your in-game settings changed while {currentLabel} was active. Save them before
            switching to {targetLabel}?
          </p>
        </div>
      </div>
      <div className={styles.profilePlayActions}>
        <button
          type="button"
          className={styles.profilePlaySave}
          autoFocus
          onClick={() => onDecision('save-current')}
        >
          Save &amp; Switch
        </button>
        <button
          type="button"
          className={styles.profilePlayUseSaved}
          onClick={() => onDecision('switch-without-saving')}
        >
          Switch Without Saving
        </button>
        <button type="button" className={styles.profilePlayCancel} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}

import { useEffect, useRef } from 'react';
import type { ProfileIniChange, ProfileSwitchAction, ProfileSwitchPrompt } from '@shared/types';
import styles from '../screens/Play.module.css';

function displayIniValue(value: string | null): JSX.Element {
  if (value === null) return <span className={styles.profileIniMissing}>Not set</span>;
  if (value === '') return <span className={styles.profileIniEmpty}>Empty</span>;
  return <code>{value}</code>;
}

interface ProfileIniFileGroup {
  fileName: string;
  changes: ProfileIniChange[];
}

function groupChangesByFile(changes: readonly ProfileIniChange[]): ProfileIniFileGroup[] {
  const groups: ProfileIniFileGroup[] = [];
  const indexes = new Map<string, number>();
  for (const change of changes) {
    const fileKey = change.fileName.toLowerCase();
    const existingIndex = indexes.get(fileKey);
    if (existingIndex === undefined) {
      indexes.set(fileKey, groups.length);
      groups.push({ fileName: change.fileName, changes: [change] });
    } else {
      groups[existingIndex].changes.push(change);
    }
  }
  return groups;
}

export function ProfileIniDiffTable({
  changes,
  profileNumber
}: {
  changes: readonly ProfileIniChange[];
  profileNumber: number;
}): JSX.Element {
  const fileGroups = groupChangesByFile(changes);
  return (
    <div className={styles.profileIniDiff} aria-label="Changed INI settings">
      <div className={styles.profileIniDiffHeading}>
        <strong>Changed settings</strong>
        <span>
          {changes.length} {changes.length === 1 ? 'change' : 'changes'}
        </span>
      </div>
      <div className={styles.profileIniDiffScroll} tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th scope="col">Setting</th>
              <th scope="col">Before · Profile #{profileNumber}</th>
              <th scope="col">After · Current game</th>
            </tr>
          </thead>
          {fileGroups.map((group) => (
            <tbody key={group.fileName.toLowerCase()}>
              <tr className={styles.profileIniFileRow}>
                <th scope="rowgroup" colSpan={3}>
                  <span className={styles.profileIniFileName}>{group.fileName}</span>
                  <span className={styles.profileIniFileCount}>
                    {group.changes.length} {group.changes.length === 1 ? 'setting' : 'settings'}
                  </span>
                </th>
              </tr>
              {group.changes.map((change, index) => (
                <tr key={`${change.section ?? ''}:${change.key}:${index}`}>
                  <th scope="row">
                    <span className={styles.profileIniSection}>
                      [{change.section ?? 'Global'}]
                    </span>
                    <code className={styles.profileIniKey}>{change.key}</code>
                  </th>
                  <td className={styles.profileIniBefore}>{displayIniValue(change.beforeValue)}</td>
                  <td className={styles.profileIniAfter}>{displayIniValue(change.afterValue)}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  );
}

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
          <h2 id="profile-switch-title">Switch to {targetLabel}?</h2>
          <p id="profile-switch-description">
            Do you want to save your latest in-game settings to {currentLabel} before switching?
          </p>
        </div>
      </div>
      <ProfileIniDiffTable changes={prompt.changes} profileNumber={prompt.profileNumber} />
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

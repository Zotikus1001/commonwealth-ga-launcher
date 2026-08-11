import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './ToastStack.module.css';

export type ToastTone = 'status' | 'error';

export interface ToastNotification {
  source: string;
  message: string;
  tone: ToastTone;
}

interface ActiveToast extends ToastNotification {
  id: number;
}

export function collectChangedToastNotifications(
  previousBySource: ReadonlyMap<string, string>,
  notifications: readonly ToastNotification[]
): { additions: ToastNotification[]; currentBySource: Map<string, string> } {
  const additions: ToastNotification[] = [];
  const currentBySource = new Map<string, string>();

  for (const notification of notifications) {
    const source = notification.source.trim();
    const message = notification.message.trim();
    if (!source || !message) continue;
    const fingerprint = `${notification.tone}\u0000${message}`;
    currentBySource.set(source, fingerprint);
    if (previousBySource.get(source) !== fingerprint) {
      additions.push({ ...notification, source, message });
    }
  }

  return { additions, currentBySource };
}

function ToastCard({
  toast,
  onDismiss
}: {
  toast: ActiveToast;
  onDismiss: (id: number) => void;
}): JSX.Element {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    let removeTimer: number | undefined;
    const lifetimeTimer = window.setTimeout(() => {
      setLeaving(true);
      removeTimer = window.setTimeout(() => onDismiss(toast.id), 180);
    }, 3_000);

    return () => {
      window.clearTimeout(lifetimeTimer);
      if (removeTimer !== undefined) window.clearTimeout(removeTimer);
    };
  }, [onDismiss, toast.id]);

  return (
    <div
      className={`${styles.toast} ${styles[toast.tone]} ${leaving ? styles.leaving : ''}`}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      aria-atomic="true"
    >
      <span className={styles.signal} aria-hidden="true" />
      <span className={styles.message}>{toast.message}</span>
      <span className={styles.lifetime} aria-hidden="true" />
    </div>
  );
}

export default function ToastStack({
  notifications
}: {
  notifications: readonly ToastNotification[];
}): JSX.Element | null {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  const previousBySource = useRef<Map<string, string>>(new Map());
  const nextId = useRef(0);

  useEffect(() => {
    const { additions, currentBySource } = collectChangedToastNotifications(
      previousBySource.current,
      notifications
    );
    previousBySource.current = currentBySource;
    if (additions.length === 0) return;
    setToasts((current) => [
      ...additions.map((notification) => ({ ...notification, id: ++nextId.current })),
      ...current
    ]);
  }, [notifications]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  if (toasts.length === 0) return null;

  return createPortal(
    <div className={styles.viewport}>
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
      ))}
    </div>,
    document.body
  );
}

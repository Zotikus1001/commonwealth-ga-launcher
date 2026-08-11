import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './ToastQueue.module.css';

export type ToastTone = 'status' | 'error';

export interface ToastNotification {
  source: string;
  message: string;
  tone: ToastTone;
}

interface QueuedToast extends ToastNotification {
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

export default function ToastQueue({
  notifications
}: {
  notifications: readonly ToastNotification[];
}): JSX.Element | null {
  const [queue, setQueue] = useState<QueuedToast[]>([]);
  const [leavingId, setLeavingId] = useState<number | null>(null);
  const previousBySource = useRef<Map<string, string>>(new Map());
  const nextId = useRef(0);
  const active = queue[0] ?? null;

  useEffect(() => {
    const { additions, currentBySource } = collectChangedToastNotifications(
      previousBySource.current,
      notifications
    );
    previousBySource.current = currentBySource;
    if (additions.length === 0) return;
    setQueue((current) => [
      ...current,
      ...additions.map((notification) => ({ ...notification, id: ++nextId.current }))
    ]);
  }, [notifications]);

  useEffect(() => {
    if (!active) return;
    let removeTimer: number | undefined;
    const lifetimeTimer = window.setTimeout(() => {
      setLeavingId(active.id);
      removeTimer = window.setTimeout(() => {
        setQueue((current) => (current[0]?.id === active.id ? current.slice(1) : current));
        setLeavingId(null);
      }, 180);
    }, 3_000);

    return () => {
      window.clearTimeout(lifetimeTimer);
      if (removeTimer !== undefined) window.clearTimeout(removeTimer);
    };
  }, [active?.id]);

  if (!active) return null;

  return createPortal(
    <div className={styles.viewport}>
      <div
        key={active.id}
        className={`${styles.toast} ${styles[active.tone]} ${
          leavingId === active.id ? styles.leaving : ''
        }`}
        role={active.tone === 'error' ? 'alert' : 'status'}
        aria-atomic="true"
      >
        <span className={styles.signal} aria-hidden="true" />
        <span className={styles.message}>{active.message}</span>
        <span className={styles.lifetime} aria-hidden="true" />
      </div>
    </div>,
    document.body
  );
}

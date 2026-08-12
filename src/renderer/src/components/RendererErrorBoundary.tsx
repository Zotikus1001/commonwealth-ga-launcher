import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import type { ActionResult, RendererErrorReport } from '@shared/types';
import styles from './RendererErrorBoundary.module.css';

interface RendererErrorBoundaryProps {
  children: ReactNode;
}

interface RendererErrorBoundaryState {
  failed: boolean;
}

function rendererErrorReport(error: Error, info: ErrorInfo): RendererErrorReport {
  return {
    name: error.name.slice(0, 128),
    message: error.message.slice(0, 4_096),
    stack: (error.stack ?? '').slice(0, 16_384),
    componentStack: (info.componentStack ?? '').slice(0, 16_384)
  };
}

export function RendererCrashRecovery(): JSX.Element {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [busyAction, setBusyAction] = useState<'reload' | 'copy' | 'logs' | null>(null);

  const runAction = async (
    action: 'reload' | 'copy' | 'logs',
    request: () => Promise<ActionResult>
  ): Promise<void> => {
    if (busyAction) return;
    setBusyAction(action);
    setResult(null);
    try {
      setResult(await request());
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className={styles.shell}>
      <div className={styles.topline} />
      <header className={styles.header}>
        <span className={styles.wordmark}>COMMONWEALTH GA</span>
        <span className={styles.headerState}>Launcher recovery</span>
      </header>
      <main className={styles.main}>
        <section
          className={styles.panel}
          role="alert"
          aria-labelledby="renderer-recovery-title"
          aria-describedby="renderer-recovery-description"
        >
          <div className={styles.readout}>
            <span className={styles.faultMark} aria-hidden="true">
              !
            </span>
            <span>Interface fault detected</span>
          </div>
          <div className={styles.body}>
            <h1 id="renderer-recovery-title">Launcher interface stopped</h1>
            <p id="renderer-recovery-description">
              Reload the launcher to continue. If this happens again, copy the diagnostics and
              report the problem in the support thread.
            </p>
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primaryAction}
              autoFocus
              disabled={busyAction !== null}
              onClick={() => void runAction('reload', window.api.reloadRenderer)}
            >
              {busyAction === 'reload' ? 'Reloading…' : 'Reload launcher'}
            </button>
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => void runAction('copy', window.api.copyDiagnostics)}
            >
              {busyAction === 'copy' ? 'Copying…' : 'Copy diagnostics'}
            </button>
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => void runAction('logs', window.api.openLauncherLogs)}
            >
              {busyAction === 'logs' ? 'Opening…' : 'Open logs'}
            </button>
          </div>
          {result && (
            <p
              className={`${styles.result} ${result.ok ? styles.resultOk : styles.resultError}`}
              role="status"
            >
              {result.message}
            </p>
          )}
        </section>
      </main>
    </div>
  );
}

export default class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  state: RendererErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): RendererErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    try {
      void window.api.reportRendererError(rendererErrorReport(error, info)).catch(() => {});
    } catch {
      // The recovery screen must still render if the preload bridge itself is unavailable.
    }
  }

  render(): ReactNode {
    if (this.state.failed) return <RendererCrashRecovery />;
    return this.props.children;
  }
}

import { app } from 'electron';
import type { LauncherState, Settings } from '@shared/types';

/** Plain-text diagnostics report for the clipboard. Private connection values are always redacted. */
export function buildDiagnosticsReport(state: LauncherState, settings: Settings, logTail: string[]): string {
  const safeSettings: Settings = {
    ...settings,
    servers: {
      ...settings.servers,
      custom: settings.servers.custom.map((server) => ({
        ...server,
        host: '[redacted]'
      }))
    }
  };
  const lines: string[] = [
    '=== Commonwealth GA Launcher diagnostics ===',
    `generated: ${new Date().toISOString()}`,
    `launcher: ${app.getVersion()} (${process.platform} ${process.arch}, packaged=${app.isPackaged})`,
    '',
    '--- state ---',
    `phase: ${state.phase}`,
    `status: ${state.statusLine}`,
    `resolved host: ${state.resolvedHost ? '[configured]' : '(unavailable)'}`,
    `server status: ${state.serverStatus}`,
    `game path: ${settings.gameExePath || '(unset)'} (valid=${state.gamePathValid})`,
    `wine runner valid: ${state.winePathValid ?? 'not-applicable'}`,
    `launch cooldown active: ${state.launchCoolingDown}`,
    `developer mode: ${state.developerMode}`,
    `launcher update: ${state.launcherUpdate}${state.launcherUpdateVersion ? ` (${state.launcherUpdateVersion})` : ''}`,
    `launcher update error: ${state.launcherUpdateError ?? '(none)'}`,
    '',
    '--- settings ---',
    JSON.stringify(safeSettings, null, 2),
    '',
    `--- launcher log (last ${logTail.length} lines) ---`,
    ...logTail
  ];
  return lines.join('\n');
}

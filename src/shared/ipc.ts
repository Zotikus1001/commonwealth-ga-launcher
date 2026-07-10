// IPC channel names — single source of truth for main and preload.
export const IPC = {
  getState: 'launcher:get-state',
  getSettings: 'launcher:get-settings',
  updateSettings: 'launcher:update-settings',
  browseForGame: 'launcher:browse-for-game',
  autoDetectGame: 'launcher:auto-detect-game',
  play: 'launcher:play',
  playDeveloper: 'launcher:play-developer',
  applyClientPatch: 'launcher:apply-client-patch',
  selectDeveloperServer: 'launcher:select-developer-server',
  refresh: 'launcher:refresh',
  listWineRunners: 'launcher:list-wine-runners',
  createWinePrefix: 'launcher:create-wine-prefix',
  openDiscord: 'launcher:open-discord',
  openSteamStore: 'launcher:open-steam-store',
  openLauncherLogs: 'launcher:open-launcher-logs',
  copyDiagnostics: 'launcher:copy-diagnostics',
  getLogTail: 'launcher:get-log-tail',
  // main -> renderer events
  evState: 'launcher:ev-state',
  evLog: 'launcher:ev-log'
} as const;

import { app, BrowserWindow, Menu, Notification, shell, type Input } from 'electron';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { Log } from './services/Log';
import { LauncherUpdater } from './services/LauncherUpdater';
import { configureDevelopmentProfile } from './services/DevelopmentProfile';
import { LAUNCHER_CONFIG } from '@shared/generatedLauncherConfig';
import { getPvpEvent, isPvpEventId, type PvpEventId } from '@shared/pvpEvents';
import { PvpReminderManager } from './services/PvpReminderManager';
import {
  launcherArgumentsWithoutPvpReminder,
  launcherRelaunchExecutable,
  pvpReminderClickTarget,
  pvpReminderFromArguments
} from './services/PvpReminderActivation';

const BROWSER_KEYS = new Set([
  'browserback',
  'browserfavorites',
  'browserforward',
  'browserhome',
  'browserrefresh',
  'browsersearch',
  'browserstop',
  'contextmenu'
]);
const EDITING_KEYS = new Set([
  'a',
  'backspace',
  'c',
  'delete',
  'end',
  'home',
  'insert',
  'arrowleft',
  'arrowright',
  'v',
  'x',
  'y',
  'z'
]);
const SHIFT_EDITING_KEYS = new Set([
  'backspace',
  'delete',
  'end',
  'home',
  'insert',
  'arrowleft',
  'arrowright',
  'v',
  'z'
]);

const APP_USER_MODEL_ID = 'gg.commonwealth.ga-launcher';

let mainWindow: BrowserWindow | null = null;
let pvpReminderManager: PvpReminderManager | null = null;
let pendingPvpReminder: PvpEventId | null = null;
let activePvpNotification: Notification | null = null;
let pvpReminderActivationInProgress = false;
let launcherRelaunchQueued = false;

// Prevent newer local settings schemas from making an installed launcher profile read-only.
const installedUserDataDir = configureDevelopmentProfile(app);

function shouldBlockBrowserInput(input: Input): boolean {
  if (input.type !== 'keyDown' || input.isComposing) return false;
  const key = input.key.toLowerCase();
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(key) || BROWSER_KEYS.has(key)) return true;

  // Preserve AltGr text input on Windows/Linux keyboard layouts.
  if (input.control && input.alt && !input.meta) return false;
  if (input.alt) return true;

  if (!input.control && !input.meta) return false;
  if (!EDITING_KEYS.has(key)) return true;
  return input.shift && !SHIFT_EDITING_KEYS.has(key);
}

function lockDownBrowserWindow(window: BrowserWindow, log: Log): void {
  const contents = window.webContents;
  contents.setIgnoreMenuShortcuts(true);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-frame-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('context-menu', (event) => event.preventDefault());
  contents.on('before-input-event', (event, input) => {
    if (shouldBlockBrowserInput(input)) event.preventDefault();
  });
  contents.on('before-mouse-event', (event, input) => {
    const browserClick = input.button === 'middle' || input.button === 'right';
    const zoomWheel =
      input.type === 'mouseWheel' &&
      (input.modifiers?.some((modifier) =>
        ['control', 'ctrl', 'meta', 'command', 'cmd'].includes(modifier)
      ) ?? false);
    if (browserClick || zoomWheel) event.preventDefault();
  });
  window.on('system-context-menu', (event) => event.preventDefault());
  void contents
    .setVisualZoomLevelLimits(1, 1)
    .catch((error) => log.warn(`launcher zoom lock unavailable: ${error.message}`));
}

function resolveEnvironmentReferences(value: string): string {
  return value
    .replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_match, name) => process.env[name]?.trim() ?? '')
    .trim();
}

function launcherIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png');
}

function focusMainWindow(): boolean {
  if (!mainWindow) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  return true;
}

function openLauncherFromReminder(log: Log): void {
  if (focusMainWindow() || launcherRelaunchQueued) return;
  launcherRelaunchQueued = true;
  log.info('PvP reminder opening Commonwealth GA Launcher');
  app.relaunch({
    execPath: launcherRelaunchExecutable(
      process.platform,
      process.execPath,
      process.env['APPIMAGE']
    ),
    args: launcherArgumentsWithoutPvpReminder(process.argv)
  });
  app.quit();
}

async function resolvePvpReminderClickTarget(log: Log): Promise<'launcher' | 'steam'> {
  try {
    const { SteamLaunchIntegration, resolveSteamIntegrationLauncherPath } =
      await import('./services/SteamLaunchIntegration');
    const launcherPath = resolveSteamIntegrationLauncherPath(
      app.isPackaged,
      process.platform,
      process.execPath
    );
    const integration = new SteamLaunchIntegration(
      installedUserDataDir ?? app.getPath('userData'),
      LAUNCHER_CONFIG.steamAppId,
      launcherPath,
      process.platform,
      log,
      { onboardingEnabled: app.isPackaged }
    );
    return pvpReminderClickTarget((await integration.inspect()).state);
  } catch (error) {
    log.warn(`PvP reminder Steam routing unavailable: ${(error as Error).message}`);
    return 'launcher';
  }
}

async function activatePvpReminder(log: Log): Promise<void> {
  if (pvpReminderActivationInProgress) return;
  pvpReminderActivationInProgress = true;
  try {
    if ((await resolvePvpReminderClickTarget(log)) !== 'steam') {
      openLauncherFromReminder(log);
      return;
    }

    log.info('PvP reminder opening Global Agenda through Steam integration');
    // Steam starts a fresh launcher process; release first so it cannot bounce off this helper.
    app.releaseSingleInstanceLock();
    try {
      await shell.openExternal(LAUNCHER_CONFIG.steamInstallUrl);
      app.quit();
    } catch (error) {
      log.error(`PvP reminder could not open Steam: ${(error as Error).message}`);
      if (!app.requestSingleInstanceLock()) {
        app.quit();
        return;
      }
      openLauncherFromReminder(log);
    }
  } finally {
    pvpReminderActivationInProgress = false;
  }
}

function showPvpReminder(eventId: PvpEventId, log: Log): boolean {
  if (!Notification.isSupported()) {
    log.warn('PvP reminder reached its start time, but system notifications are unavailable.');
    return false;
  }
  const event = getPvpEvent(eventId);
  const notification = new Notification({
    title: `Weekly Event — ${event.name}`,
    body: 'Starting now. Click to join the fun.',
    icon: launcherIconPath(),
    urgency: 'normal',
    timeoutType: 'never'
  });
  activePvpNotification = notification;
  notification.on('click', () => void activatePvpReminder(log));
  notification.on('close', () => {
    if (activePvpNotification === notification) activePvpNotification = null;
    setTimeout(() => {
      if (
        launchPvpReminder &&
        !activePvpNotification &&
        !mainWindow &&
        !pvpReminderActivationInProgress
      ) {
        app.quit();
      }
    }, 250);
  });
  notification.on('failed', (_event, error) => {
    log.error(`PvP reminder notification failed: ${error}`);
    if (activePvpNotification === notification) activePvpNotification = null;
    if (launchPvpReminder && !activePvpNotification && !mainWindow) app.quit();
  });
  notification.show();
  return true;
}

async function handlePvpReminder(eventId: PvpEventId, log: Log): Promise<boolean> {
  if (!pvpReminderManager) {
    pendingPvpReminder = eventId;
    return false;
  }
  try {
    const event = await pvpReminderManager.consumeTriggeredReminder(eventId);
    return event ? showPvpReminder(event.id, log) : false;
  } catch (error) {
    log.error(`PvP reminder delivery failed: ${(error as Error).message}`);
    return false;
  }
}

async function resolveDefaultServerHosts(log: Log): Promise<{
  primary: string;
  fallback: string;
}> {
  let primary = resolveEnvironmentReferences(LAUNCHER_CONFIG.defaultServerHost);
  let fallback = resolveEnvironmentReferences(LAUNCHER_CONFIG.fallbackServerHost);
  if (primary && fallback) {
    log.info('server addresses: build defaults configured');
    return { primary, fallback };
  }
  if (!app.isPackaged) return { primary, fallback };
  try {
    const metadata = JSON.parse(
      await readFile(join(app.getAppPath(), 'package.json'), { encoding: 'utf-8' })
    ) as Record<string, unknown>;
    if (!primary && typeof metadata.defaultServerHost === 'string') {
      primary = metadata.defaultServerHost.trim();
    }
    if (!fallback && typeof metadata.fallbackServerHost === 'string') {
      fallback = metadata.fallbackServerHost.trim();
    }
    if (primary || fallback) log.info('server addresses: packaged defaults configured');
    return { primary, fallback };
  } catch (error) {
    log.warn(`server address metadata unavailable: ${(error as Error).message}`);
    return { primary, fallback };
  }
}

if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);
const launchPvpReminder = pvpReminderFromArguments(process.argv);

// One launcher instance: reminder invocations notify the existing process without stealing focus.
if (!app.requestSingleInstanceLock(launchPvpReminder ? { pvpReminder: launchPvpReminder } : {})) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    const additionalReminder =
      typeof additionalData === 'object' && additionalData !== null
        ? (additionalData as Record<string, unknown>)['pvpReminder']
        : null;
    const eventId = isPvpEventId(additionalReminder)
      ? additionalReminder
      : pvpReminderFromArguments(argv);
    if (eventId) {
      const log = new Log(app.getPath('userData'));
      void handlePvpReminder(eventId, log);
      return;
    }
    if (!focusMainWindow() && launchPvpReminder) {
      const log = new Log(app.getPath('userData'));
      openLauncherFromReminder(log);
    }
  });

  void app.whenReady().then(async () => {
    const log = new Log(app.getPath('userData'));
    log.info(`launcher ${app.getVersion()} starting (${process.platform} ${process.arch}, packaged=${app.isPackaged})`);

    pvpReminderManager = new PvpReminderManager(
      {
        platform: process.platform,
        packaged: app.isPackaged,
        executablePath: process.execPath,
        developmentAppPath: app.isPackaged ? undefined : app.getAppPath(),
        appImagePath: process.env['APPIMAGE']?.trim() || undefined,
        userDataDir: app.getPath('userData')
      },
      log
    );
    const reminderReconciliation = pvpReminderManager.getState().catch((error) => {
      log.error(`PvP reminder schedules could not be reconciled: ${(error as Error).message}`);
    });
    if (launchPvpReminder) {
      await reminderReconciliation;
      if (!(await handlePvpReminder(launchPvpReminder, log))) app.quit();
      return;
    }
    if (pendingPvpReminder) {
      await reminderReconciliation;
      const eventId = pendingPvpReminder;
      pendingPvpReminder = null;
      void handlePvpReminder(eventId, log);
    }

    const launcherUpdater = new LauncherUpdater(log);

    const [
      { ConfigStore, defaultSettings },
      { LauncherChangelogStore },
      { SteamLaunchIntegration, resolveSteamIntegrationLauncherPath },
      { Orchestrator },
      { registerIpc }
    ] =
      await Promise.all([
        import('./services/ConfigStore'),
        import('./services/LauncherChangelogStore'),
        import('./services/SteamLaunchIntegration'),
        import('./Orchestrator'),
        import('./ipc')
      ]);

    const config = new ConfigStore(
      app.getPath('userData'),
      defaultSettings(LAUNCHER_CONFIG.defaultServerName),
      log
    );
    const launcherChangelog = new LauncherChangelogStore(
      app.getPath('userData'),
      app.getVersion(),
      log
    );
    const installedLauncherPath = resolveSteamIntegrationLauncherPath(
      app.isPackaged,
      process.platform,
      process.execPath
    );
    const steamLaunchIntegration = new SteamLaunchIntegration(
      installedUserDataDir ?? app.getPath('userData'),
      LAUNCHER_CONFIG.steamAppId,
      installedLauncherPath,
      process.platform,
      log,
      { onboardingEnabled: app.isPackaged }
    );
    await Promise.all([config.load(), launcherChangelog.load()]);

    const defaultServerHosts = await resolveDefaultServerHosts(log);
    const orchestrator = new Orchestrator(
      config,
      log,
      defaultServerHosts.primary,
      defaultServerHosts.fallback,
      launcherUpdater
    );
    registerIpc(
      () => mainWindow,
      orchestrator,
      config,
      log,
      launcherChangelog,
      steamLaunchIntegration,
      pvpReminderManager
    );

    Menu.setApplicationMenu(null);

    mainWindow = new BrowserWindow({
      width: 1180,
      height: 765,
      minWidth: 1060,
      minHeight: 690,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#0b0e14',
      title: 'Commonwealth GA',
      icon: launcherIconPath(),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        disableDialogs: true,
        navigateOnDragDrop: false,
        spellcheck: false,
        webSecurity: true,
        webviewTag: false
      }
    });
    lockDownBrowserWindow(mainWindow, log);
    let startupUpdateStarted = false;
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow?.webContents.setZoomFactor(config.get().uiScale);
      mainWindow?.show();
      if (!startupUpdateStarted) {
        startupUpdateStarted = true;
        setTimeout(() => void launcherUpdater.ensureCurrent(), 250);
      }
    });
    mainWindow.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (isMainFrame) {
          log.error(
            `launcher window failed to load ${validatedURL}: ${errorDescription} (${errorCode})`
          );
        }
      }
    );
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    // electron-vite: dev server URL in dev, bundled file in production.
    let windowLoad: Promise<void>;
    if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
      windowLoad = mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
    } else {
      windowLoad = mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
    }
    void windowLoad.catch((error) => log.error(`launcher window load rejected: ${error.message}`));

    void orchestrator.start(true);
  });

  app.on('window-all-closed', () => {
    app.quit(); // the game is detached — closing the launcher never kills it
  });
}

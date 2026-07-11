import { app, BrowserWindow, Menu, type Input } from 'electron';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { Log } from './services/Log';
import { LauncherUpdater } from './services/LauncherUpdater';
import { LAUNCHER_CONFIG } from '@shared/generatedLauncherConfig';

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

let mainWindow: BrowserWindow | null = null;

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

// One launcher instance: a second copy focuses the first instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    const log = new Log(app.getPath('userData'));
    log.info(`launcher ${app.getVersion()} starting (${process.platform} ${process.arch}, packaged=${app.isPackaged})`);

    const launcherUpdater = new LauncherUpdater(log);
    void launcherUpdater.ensureCurrentBeforeWindow().then((bootstrapUpdate) => {
      if (bootstrapUpdate === 'restarting') {
        log.info('self-update bootstrap: update installer started');
      } else if (bootstrapUpdate === 'error') {
        log.warn('self-update bootstrap: update failed; launcher remains available');
      }
    });

    const [{ ConfigStore, defaultSettings }, { Orchestrator }, { registerIpc }] =
      await Promise.all([
        import('./services/ConfigStore'),
        import('./Orchestrator'),
        import('./ipc')
      ]);

    const config = new ConfigStore(
      app.getPath('userData'),
      defaultSettings(LAUNCHER_CONFIG.defaultServerName),
      log
    );
    await config.load();

    const defaultServerHosts = await resolveDefaultServerHosts(log);
    const orchestrator = new Orchestrator(
      config,
      log,
      defaultServerHosts.primary,
      defaultServerHosts.fallback,
      launcherUpdater
    );
    registerIpc(() => mainWindow, orchestrator, config, log);

    Menu.setApplicationMenu(null);

    mainWindow = new BrowserWindow({
      width: 1180,
      height: 760,
      minWidth: 1060,
      minHeight: 690,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#0b0e14',
      title: 'Commonwealth GA',
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
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow?.webContents.setZoomFactor(config.get().uiScale);
      mainWindow?.show();
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

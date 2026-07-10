import { app, BrowserWindow } from 'electron';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { Log } from './services/Log';
import { ConfigStore, defaultSettings } from './services/ConfigStore';
import { Orchestrator } from './Orchestrator';
import { registerIpc } from './ipc';
import { LAUNCHER_CONFIG } from '@shared/generatedLauncherConfig';

const UI_ZOOM_FACTOR = 1.15;

let mainWindow: BrowserWindow | null = null;

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
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    const log = new Log(app.getPath('userData'));
    log.info(`launcher ${app.getVersion()} starting (${process.platform} ${process.arch}, packaged=${app.isPackaged})`);

    const config = new ConfigStore(app.getPath('userData'), defaultSettings(), log);
    await config.load();

    const defaultServerHosts = await resolveDefaultServerHosts(log);
    const orchestrator = new Orchestrator(
      config,
      log,
      defaultServerHosts.primary,
      defaultServerHosts.fallback,
      LAUNCHER_CONFIG.defaultServerName
    );
    registerIpc(() => mainWindow, orchestrator, config, log);

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
        nodeIntegration: false
      }
    });
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow?.webContents.setZoomFactor(UI_ZOOM_FACTOR);
    });
    mainWindow.on('ready-to-show', () => mainWindow?.show());
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    // electron-vite: dev server URL in dev, bundled file in production.
    if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
      void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
    } else {
      void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
    }

    void orchestrator.start();
  });

  app.on('window-all-closed', () => {
    app.quit(); // the game is detached — closing the launcher never kills it
  });
}

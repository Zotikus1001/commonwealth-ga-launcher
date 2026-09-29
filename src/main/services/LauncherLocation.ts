import { app, dialog, type BrowserWindow } from 'electron';
import { constants } from 'fs';
import { access, chmod, copyFile, realpath, stat } from 'fs/promises';
import { basename, dirname, isAbsolute, join } from 'path';
import type { Log } from './Log';
import type { ActionResult } from '@shared/types';

export function launcherInstallDirectory(): string {
  if (!app.isPackaged) return app.getAppPath();
  const appImage = process.platform === 'linux' ? process.env['APPIMAGE']?.trim() : undefined;
  return dirname(appImage && isAbsolute(appImage) ? appImage : app.getPath('exe'));
}

/** Called only from the user's Settings action; first launch must reach the main window. */
export async function chooseLinuxLauncherLocation(log: Log, parent: BrowserWindow): Promise<ActionResult> {
  const source = process.env['APPIMAGE']?.trim();
  if (process.platform !== 'linux' || !app.isPackaged || !source || !isAbsolute(source)) {
    return { ok: false, message: 'Folder selection is available when running the Linux AppImage.' };
  }

  try {
    const selected = await dialog.showOpenDialog(parent, {
      title: 'Choose launcher folder',
      buttonLabel: 'Copy here and restart',
      defaultPath: dirname(source),
      properties: ['openDirectory', 'createDirectory']
    });
    if (selected.canceled || !selected.filePaths[0]) {
      return { ok: true, message: 'Launcher folder unchanged.' };
    }
    const folder = await realpath(selected.filePaths[0]);
    if (folder === await realpath(dirname(source))) {
      return { ok: true, message: 'The launcher is already in that folder.' };
    }
    const destination = join(folder, basename(source));
    const info = await stat(source);
    if (!info.isFile()) throw new Error('The running AppImage is not a regular file.');
    await access(folder, constants.W_OK);
    // Never overwrite an existing download or installation selected by the user.
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    await chmod(destination, (info.mode & 0o777) | 0o100);
    log.info(`Launcher copied to ${destination}`);
    app.relaunch({ execPath: destination, args: process.argv.slice(1) });
    app.quit();
    return { ok: true, message: 'Launcher copied. Restarting from the new folder…' };
  } catch (error) {
    log.warn(`Launcher installation folder setup failed: ${(error as Error).message}`);
    return {
      ok: false,
      message: (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? 'That folder already contains this AppImage. Choose another folder.'
        : `Could not copy the launcher: ${(error as Error).message}`
    };
  }
}

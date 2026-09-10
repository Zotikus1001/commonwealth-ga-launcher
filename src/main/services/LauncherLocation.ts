import { app, dialog } from 'electron';
import { constants } from 'fs';
import { access, chmod, copyFile, mkdir, readFile, realpath, stat, writeFile } from 'fs/promises';
import { basename, dirname, isAbsolute, join } from 'path';
import type { Log } from './Log';

export function launcherInstallDirectory(): string {
  if (!app.isPackaged) return app.getAppPath();
  const appImage = process.platform === 'linux' ? process.env['APPIMAGE']?.trim() : undefined;
  return dirname(appImage && isAbsolute(appImage) ? appImage : app.getPath('exe'));
}

/** Returns true when setup has scheduled a restart from the chosen AppImage location. */
export async function chooseLinuxLauncherLocation(log: Log): Promise<boolean> {
  const source = process.env['APPIMAGE']?.trim();
  if (process.platform !== 'linux' || !app.isPackaged || !source || !isAbsolute(source)) return false;
  const marker = join(app.getPath('userData'), 'launcher-location.json');
  try {
    const saved = JSON.parse(await readFile(marker, 'utf-8')) as { schemaVersion?: number };
    if (saved.schemaVersion === 1) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`Launcher location preference could not be read: ${(error as Error).message}`);
    }
  }

  try {
    const choice = await dialog.showMessageBox({
      type: 'question',
      title: 'Launcher installation',
      message: 'Where do you want to keep Commonwealth GA Launcher?',
      detail: `Current folder: ${dirname(source)}\n\nChoose a folder to copy the launcher there and restart. Future updates will use that location.`,
      buttons: ['Choose folder', 'Keep current location'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    let destination = source;
    if (choice.response === 0) {
      const selected = await dialog.showOpenDialog({
        title: 'Choose launcher installation folder',
        defaultPath: dirname(source),
        properties: ['openDirectory', 'createDirectory']
      });
      if (selected.canceled || !selected.filePaths[0]) return false;
      const folder = await realpath(selected.filePaths[0]);
      if (folder !== await realpath(dirname(source))) {
        destination = join(folder, basename(source));
        const info = await stat(source);
        if (!info.isFile()) throw new Error('The running AppImage is not a regular file.');
        await access(folder, constants.W_OK);
        // Never overwrite an existing download or installation selected by the user.
        await copyFile(source, destination, constants.COPYFILE_EXCL);
        await chmod(destination, (info.mode & 0o777) | 0o100);
      }
    }
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, `${JSON.stringify({ schemaVersion: 1 })}\n`, 'utf-8');
    if (destination === source) return false;
    log.info(`Launcher copied to ${destination}`);
    app.relaunch({ execPath: destination, args: process.argv.slice(1) });
    app.quit();
    return true;
  } catch (error) {
    log.warn(`Launcher installation folder setup failed: ${(error as Error).message}`);
    await dialog.showMessageBox({
      type: 'error',
      title: 'Launcher installation',
      message: 'Could not set up the launcher in that folder.',
      detail: `${(error as Error).message}\n\nThe launcher will continue from its current location. You can choose again on the next launch.`
    });
    return false;
  }
}

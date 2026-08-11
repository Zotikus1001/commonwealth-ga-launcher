import { mkdirSync } from 'fs';
import { basename, dirname, join } from 'path';

interface AppPathAccess {
  readonly isPackaged: boolean;
  getPath(name: string): string;
  setPath(name: string, path: string): void;
}

export function configureDevelopmentProfile(app: AppPathAccess): string | null {
  if (app.isPackaged) return null;

  const defaultUserDataDir = app.getPath('userData');
  const developmentUserDataDir = join(
    dirname(defaultUserDataDir),
    `${basename(defaultUserDataDir)} Development`
  );
  mkdirSync(developmentUserDataDir, { recursive: true });
  app.setPath('userData', developmentUserDataDir);
  app.setPath('sessionData', developmentUserDataDir);
  return defaultUserDataDir;
}

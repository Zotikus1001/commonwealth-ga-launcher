# Commonwealth GA Launcher

Download the launcher, select your Global Agenda installation, and play.

## Download and install

### Windows

**[Download the Windows installer](../../releases/latest/download/Commonwealth-GA-Launcher-Windows-x64-Setup.exe)**

Run the installer, open the launcher, and select `GlobalAgenda.exe` when prompted.

### Linux

> [!WARNING]
> The Linux version is currently untested.

**[Download the Linux AppImage](../../releases/latest/download/Commonwealth-GA-Launcher-Linux-x64.AppImage)**

Allow the AppImage to run, open it, and select your game executable. The launcher includes settings
for choosing your Wine runner and prefix.

The launcher checks for updates automatically before starting the game.

## Developers

<details>
<summary>Development and release information</summary>

Node.js 22.12 or newer is required.

```bash
npm ci
npx --no-install install-electron --no
npm run dev
npm run typecheck
```

To reveal the Dev tab, click the About tab ten times within four seconds. Enable Developer mode
there to keep the tab available and use its development launch options.

Create local packages with `npm run dist:win` or `npm run dist:linux`. Output is written to `dist/`.

Public settings are stored in `launcher.config.yml`. Local development uses the generated `out/`
files and does not check online release channels.

Run the `Release launcher` workflow from the stable branch to publish the Windows installer and
Linux AppImage. The workflow updates the version automatically and publishes both platforms in one
release.

</details>

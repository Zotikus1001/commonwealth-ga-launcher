# Commonwealth GA Launcher

## Download and install

- [Download for Windows](../../releases/latest/download/Commonwealth-GA-Setup.exe)
- [Download for Linux](../../releases/latest/download/Commonwealth-GA.AppImage)

On Windows, download and run the installer, then select `GlobalAgenda.exe` in the launcher.

On Linux, make the AppImage executable, open it, then select the game executable and configure your
Wine runner and prefix in the launcher.

The launcher checks for updates automatically before starting the game.
Automatic updates preserve compatible settings. Running the installer manually over an existing
installation performs a clean reinstall and resets saved launcher settings.

## Developer information

<details>
<summary>Show development and release instructions</summary>

### Local development

Node.js 22.12 or newer is required.

```bash
npm ci
npx --no-install install-electron --no
npm run dev
npm run typecheck
```

Distribution builds are created with `npm run dist:win` or `npm run dist:linux` and written to
`dist/`.

Click the About tab ten times within four seconds to unlock the Dev tab. Developer mode supports
named test servers, repeated game launches, and a separate windowed/resolution-controlled Dev
Launch action. Untick **Developer mode** and save to disable its features and hide the Dev tab.

### Configuration

Public build settings, including the primary and fallback Live server addresses, live in
`launcher.config.yml`. Custom test servers are configured in Dev mode.

Development builds use the local `out/` files and do not check online release channels.
Settings use explicit schema migrations so automatic updates retain compatible values and upgrade
older settings files. Corrupt or newer incompatible files are preserved as backups before defaults
are restored.

### Releases

Run the `Release launcher` workflow and select a patch, minor, or major bump. It builds the Windows
installer and Linux AppImage, publishes their update metadata, and only exposes the release after
both platforms succeed.

The configured stable branch and update sources are read from `launcher.config.yml`. The launcher
checks every configured source and selects the most recently published eligible release by date and
time, independently of version ordering.

</details>

# Commonwealth GA Launcher

The easiest way to install, configure, and launch Global Agenda for the Commonwealth private
server.

---

## Download and Install

### Windows

**[Download the latest Windows installer](../../releases/latest/download/Commonwealth-GA-Launcher-Windows-x64-Setup.exe)**

1. Run the installer.
2. Open the launcher.
3. Select `GlobalAgenda.exe` when prompted, or let the launcher find it automatically.
4. Press **Play**.

### Linux

> [!WARNING]
> The Linux version includes Wine support but has not been fully tested yet.

**[Download the latest Linux AppImage](../../releases/latest/download/Commonwealth-GA-Launcher-Linux-x64.AppImage)**

Use the AppImage on Linux instead of installing the Windows launcher inside a Wine prefix. Allow
the AppImage to run, open it, and select your game executable. The launcher can find common Wine
runners, create or use a Wine prefix, and launch the Windows game through Wine.

The launcher keeps itself updated automatically. Install a new release manually only if the
launcher specifically asks you to download the latest version.

---

## Features

| Feature | What it does for you |
| --- | --- |
| **Automatic launcher updates** | Checks stable releases at startup and when Play is pressed, preserves saved settings, and installs detected updates automatically without locking launcher controls. |
| **Easy game setup** | Finds common Steam installations automatically, supports manual selection, and links directly to the Steam store or install action when needed. |
| **Server status checks** | Detects online, offline, and invalid server addresses, blocks unavailable launches, and lets you retry an offline server immediately. |
| **Multiple server profiles** | Lets you rename the main server, add other servers, and choose where to connect from the home screen. |
| **High-FPS movement fix** | Applies the required client network fix for high-FPS teleporting and movement issues. |
| **Safe game configuration** | Changes only the required INI settings, preserves unrelated settings, creates a backup, and verifies each change before launch. |
| **Game preferences** | Offers login-screen themes, an optional FPS limit, visible overhealing and repair numbers, GPU selection, and extra launch arguments. |
| **Faster startup** | Can skip startup movies and the splash screen, then close the launcher automatically after the game starts. |
| **Custom launcher scaling** | Adjusts launcher text and controls from 100% to 150% and applies the new scale immediately. |
| **Patches and diagnostics** | Shows whether required fixes are applied, lets you apply them manually, checks the runtime setup, and provides launcher logs for troubleshooting. |
| **Agenda Stats and community updates** | Shows the Commonwealth server's live player count, opens recorded PvP, PvE, mission, and player statistics, lists recent server changes, and links to Discord. |
| **Windows and Linux support** | Provides a Windows installer and a Linux AppImage with configurable Wine runner and prefix support. |

---

## Developers

<details>
<summary>Development and release information</summary>

Node.js 22.12 or newer is required.

```bash
npm ci
npx --no-install install-electron --no
npm run dev
npm run typecheck
npm run build
```

Create local packages with `npm run dist:win` or `npm run dist:linux`. Build output is written to
`out/`; installers and AppImages are written to `dist/`. Local development uses the generated
`out/` files and does not check online release channels.

Public launcher settings are stored in `launcher.config.yml`.

To reveal the Dev tab, click the **About** tab ten times within four seconds. Developer mode adds a
separate launch button with windowed-mode and custom-resolution controls.

Run the **Release launcher** workflow from the stable branch to publish both platforms. The
workflow calculates and publishes the next launcher version automatically.

</details>

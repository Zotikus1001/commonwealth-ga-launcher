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

Allow the AppImage to run, open it, and follow the game setup instructions.

The launcher updates itself automatically.

---

## Features

- **Automatic updates** — Keeps the launcher up to date.
- **Easy game setup** — Finds your game or lets you select it manually.
- **Server status** — Shows whether your selected server is available.
- **Multiple servers** — Save and choose additional servers.
- **Client fixes** — Includes fixes for known gameplay issues.
- **Game options** — Manage login themes, FPS limits, healing numbers, graphics, and launch options.
- **Faster launching** — Skip startup movies and close the launcher after starting the game.
- **UI scaling** — Adjust the launcher size for your display.
- **Patches and diagnostics** — View installed fixes and access troubleshooting tools.
- **Community tools** — View player counts, Agenda Stats, server updates, and Discord.
- **Windows and Linux** — Available as a Windows installer and Linux AppImage.

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

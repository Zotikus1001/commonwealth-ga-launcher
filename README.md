# Commonwealth GA Launcher

The easiest way to install, configure, and launch Global Agenda for the Commonwealth private
server.

---

## Download and Install

### Windows

**[Download the latest Windows installer](../../releases/latest/download/Commonwealth-GA-Launcher-Windows-x64-Setup.exe)**

1. Run the installer.
2. Open the launcher.
3. Select your game installation, or let the launcher find it.
4. Press **Play**.

### Linux

**[Download the latest Linux AppImage](../../releases/latest/download/Commonwealth-GA-Launcher-Linux-x64.AppImage)**

Allow the AppImage to run, open it, and follow the setup instructions.

The launcher supports installed Wine runners and Proton through UMU.

The launcher updates itself automatically.

---

## Features

- Automatic updates
- Easy game setup and launching
- Server status and server selection
- Client fixes and game options
- Agenda Stats and Discord access
- Windows support and flexible Linux compatibility options

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

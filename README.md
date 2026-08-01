# Commonwealth GA Launcher

The easiest way to install, configure, and launch Global Agenda for the Commonwealth private
server.

---

## Download and Install

For a fresh game installation, start Global Agenda normally once and close it after the login
screen appears. This creates the configuration files the launcher manages.

### Windows

**[Download the latest Windows installer](../../releases/latest/download/Commonwealth-GA-Launcher-Windows-x64-Setup.exe)**

1. Run the installer.
2. Open the launcher.
3. Select your game installation, or let the launcher find it.
4. Press **Play**.

### Linux

**[Download the latest Linux AppImage](../../releases/latest/download/Commonwealth-GA-Launcher-Linux-x64.AppImage)**

Allow the AppImage to run, open it, and follow the setup instructions.

The launcher supports installed Wine runners and Proton through UMU. Linux users can also wrap
the launch with tools such as Gamescope, `taskset`, and custom environment options.

The launcher updates itself automatically.

---

## Features

- Automatic updates
- Easy game setup and launching, with saved game settings and enabled content prepared as soon as
  the install location validates
- Server status and server selection
- Up to five named game-settings profiles for quickly switching graphics, audio, controls, and
  UI preferences
- Game patches enabled by default, with one-click Apply and Remove controls
- A Game Client Patch that fixes scope-transition stutters and adds an in-game FOV slider
- Optional Surfside-Atoll and Carbon Capture PvP maps plus Central Industrial Complex and
  Recycling Plant 37 PvE maps, with one-click install and repair that replaces mismatched files at
  that pack's declared locations, pre-install backups that restore saved copies and are then
  deleted on removal, separate download and file-operation progress, plus per-pack matchmaking
  include and exclude commands
- Useful game options
- An Info and FAQ guide for performance, graphics stability, account setup, and click-to-copy
  in-game chat commands, including suit-cosmetic performance controls
- Agenda Stats and Discord access
- Diagnostics and a one-click recovery reset
- Windows support and flexible Linux compatibility options, including custom command wrappers

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
`out/` files, keeps its settings separate from installed builds, and does not check online release
channels.

Developer Mode can validate and use a local 32-bit x86 client patch DLL. Local DLLs remain
developer-owned while Local DLL Override is enabled. With the override off, pressing Play restores
the saved managed-patch choice by replacing or removing the client DLL.

Public launcher settings are stored in `launcher.config.yml`.

Run the **Release launcher** workflow from the stable branch to publish both platforms. The
workflow calculates and publishes the next launcher version automatically.

</details>

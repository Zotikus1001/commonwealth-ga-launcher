const fs = require('node:fs/promises');
const path = require('node:path');
const { loadLauncherConfig } = require('./launcher-config.cjs');

function xml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[character]);
}

module.exports = async function writeAppStreamMetadata(context) {
  if (context.electronPlatformName !== 'linux') return;

  const launcher = loadLauncherConfig();
  const { owner, repo } = launcher.updateRepositories[0];
  const homepage = `https://github.com/${owner}/${repo}`;
  const screenshot = `https://raw.githubusercontent.com/${owner}/${repo}/${launcher.stableBranch}/images/launcher-main.jpg`;
  const { appInfo, config } = context.packager;
  const { metadata } = context.packager.info;
  const id = config.appId;
  const desktop = metadata.desktopName.replace(/\.desktop$/, '');
  const directory = path.join(context.appOutDir, 'usr', 'share', 'metainfo');

  // AppImage catalogs prefer this complete README preview over their small
  // virtual-display capture. Keep the image remote so packaging stays slim.
  const document = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${xml(id)}</id>
  <name>${xml(appInfo.productName)}</name>
  <summary>Launcher for the Commonwealth Global Agenda private server</summary>
  <metadata_license>MIT</metadata_license>
  <project_license>${xml(metadata.license)}</project_license>
  <description>
    <p>Set up and launch Global Agenda on the Commonwealth private server.
    Manage game settings, optional maps and client patches, and keep up with
    community events and server updates.</p>
  </description>
  <launchable type="desktop-id">${xml(desktop)}.desktop</launchable>
  <url type="homepage">${xml(homepage)}</url>
  <screenshots>
    <screenshot type="default">
      <caption>The launcher main page with server updates and game launch controls</caption>
      <image type="source">${xml(screenshot)}</image>
    </screenshot>
  </screenshots>
</component>
`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${id}.metainfo.xml`), document, 'utf8');
};

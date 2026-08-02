const { loadLauncherConfig } = require('./scripts/launcher-config.cjs');

const launcherConfig = loadLauncherConfig({ resolveEnvironment: true });
const repository = (process.env.GITHUB_REPOSITORY || '').trim();
let publish;

if (repository) {
  const parts = repository.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  publish = {
    provider: 'github',
    owner: parts[0],
    repo: parts[1],
    releaseType: 'draft'
  };
}

module.exports = {
  appId: 'gg.commonwealth.ga-launcher',
  productName: 'Commonwealth GA',
  directories: {
    output: 'dist',
    buildResources: 'build'
  },
  files: ['out/**', '!out/**/*.map'],
  toolsets: {
    appimage: '1.0.3'
  },
  extraMetadata: {
    launcherReleaseRepository: repository,
    defaultServerHost: launcherConfig.defaultServerHost,
    fallbackServerHost: launcherConfig.fallbackServerHost
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: launcherConfig.windowsInstallerName
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    differentialPackage: false,
    deleteAppDataOnUninstall: true,
    include: 'build/installer.nsh'
  },
  linux: {
    target: ['AppImage'],
    category: 'Game',
    executableName: 'commonwealth-ga-launcher',
    artifactName: launcherConfig.linuxAppImageName,
    synopsis: 'Commonwealth Global Agenda launcher',
    maintainer: 'Commonwealth GA <commonwealth-ga@example.invalid>'
  },
  electronUpdaterCompatibility: '>= 2.16',
  ...(publish ? { publish } : {})
};

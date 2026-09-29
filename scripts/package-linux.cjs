const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadLauncherConfig } = require('./launcher-config.cjs');

function embedUpdateInformation(runtime, sections, information) {
  const matches = [...sections.matchAll(/^\s*\[\s*\d+\]\s+\.upd_info\s+PROGBITS\s+\S+\s+([\da-f]+)\s+([\da-f]+)/gmi)];
  if (matches.length !== 1 || runtime.subarray(0, 4).toString('hex') !== '7f454c46' ||
      runtime.subarray(8, 11).toString('hex') !== '414902') {
    throw new Error('Expected an AppImage type-2 runtime with one .upd_info section.');
  }
  const offset = Number.parseInt(matches[0][1], 16);
  const size = Number.parseInt(matches[0][2], 16);
  const value = Buffer.from(information, 'utf8');
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 64 ||
      offset + size > runtime.length || value.length >= size || information.includes('\0')) {
    throw new Error('AppImage update information does not fit the runtime section.');
  }
  const result = Buffer.from(runtime);
  result.fill(0, offset, offset + size);
  value.copy(result, offset);
  return result;
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('Build the Linux x64 AppImage on Linux x64 with binutils and zsync installed.');
  }
  const launcher = loadLauncherConfig();
  const fallback = launcher.updateRepositories[0];
  const repository = (process.env.GITHUB_REPOSITORY || `${fallback.owner}/${fallback.repo}`).trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('Invalid AppImage release repository.');
  }
  const name = launcher.linuxAppImageName;
  if (!/^[A-Za-z0-9_.-]+\.AppImage$/.test(name)) {
    throw new Error('Invalid AppImage asset name.');
  }
  process.env.GITHUB_REPOSITORY = repository;
  const config = require('../electron-builder.config.cjs');
  const { build, Platform, Arch } = require('electron-builder');
  const { getAppImageTools } = require('app-builder-lib/out/toolsets/linux');
  const { load } = require('js-yaml');
  const information = `gh-releases-zsync|${repository.replace('/', '|')}|latest|${name}.zsync`;
  const tools = await getAppImageTools(config.toolsets.appimage, Arch.x64);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-appimage-'));
  const previousTools = process.env.APPIMAGE_TOOLS_PATH;
  try {
    // Prepare a private runtime before packaging so Electron hashes and block maps
    // describe the final bytes. Never modify the shared, checksum-verified tool cache.
    const toolset = path.join(temporary, 'tools');
    await fs.cp(path.dirname(tools.mksquashfs), toolset, { recursive: true });
    const runtime = path.join(toolset, 'runtimes', 'runtime-x64');
    const sections = execFileSync('readelf', ['--wide', '--section-headers', runtime], { encoding: 'utf8' });
    await fs.writeFile(runtime, embedUpdateInformation(await fs.readFile(runtime), sections, information));
    process.env.APPIMAGE_TOOLS_PATH = toolset;
    await build({ targets: Platform.LINUX.createTarget(['AppImage'], Arch.x64), config, publish: 'never' });

    const output = path.resolve(config.directories.output);
    const artifact = path.join(output, name);
    const embedded = execFileSync(artifact, ['--appimage-updateinformation'], { encoding: 'utf8' }).trim();
    if (embedded !== information) throw new Error('Packaged AppImage update information differs from the intended feed.');
    const metadata = load(await fs.readFile(path.join(output, 'latest-linux.yml'), 'utf8'));
    const bytes = await fs.readFile(artifact);
    const sha512 = createHash('sha512').update(bytes).digest('base64');
    const entry = metadata.files?.find((file) => file.url === name);
    if (!entry || entry.size !== bytes.length || entry.sha512 !== sha512 || metadata.sha512 !== sha512) {
      throw new Error('Electron update metadata does not match the final AppImage.');
    }
    // Pin the payload URL to this version; a newer release must not change the
    // bytes fetched for an already downloaded zsync control file.
    const url = `https://github.com/${repository}/releases/download/v${metadata.version}/${name}`;
    execFileSync('zsyncmake', ['-u', url, '-o', `${name}.zsync`, name], { cwd: output, stdio: 'inherit' });
    const control = await fs.readFile(`${artifact}.zsync`);
    const end = control.indexOf('\n\n');
    const header = control.subarray(0, end).toString('utf8');
    const sha1 = createHash('sha1').update(bytes).digest('hex');
    if (end < 0 || !header.split('\n').includes(`Length: ${bytes.length}`) ||
        !header.split('\n').includes(`SHA-1: ${sha1}`) || !header.split('\n').includes(`URL: ${url}`)) {
      throw new Error('zsync control file does not match the final AppImage.');
    }
    console.log(`Verified AppImageUpdate and Electron metadata for ${name}`);
  } finally {
    if (previousTools === undefined) delete process.env.APPIMAGE_TOOLS_PATH;
    else process.env.APPIMAGE_TOOLS_PATH = previousTools;
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

module.exports = { embedUpdateInformation, main };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });

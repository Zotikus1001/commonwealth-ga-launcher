const { readFileSync } = require('fs');
const { resolve } = require('path');

const root = resolve(__dirname, '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), { encoding: 'utf-8' }));
const changelog = JSON.parse(
  readFileSync(resolve(root, 'launcher-changelog.json'), { encoding: 'utf-8' })
);
const versions = changelog?.versions;
const arguments = process.argv.slice(2);
const allowPrevious = arguments.includes('--allow-previous');
const versionArguments = arguments.filter((argument) => argument !== '--allow-previous');
if (versionArguments.length > 1) {
  throw new Error('Only one release version may be supplied.');
}
const releaseVersion = versionArguments[0] ?? packageJson.version;
const semanticVersion = /^\d+\.\d+\.\d+$/;
const releaseDate = /^\d{4}-\d{2}-\d{2}$/;

function isValidReleaseDate(value) {
  if (!releaseDate.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const comparison = leftParts[index] - rightParts[index];
    if (comparison !== 0) return comparison;
  }
  return 0;
}

if (!Array.isArray(versions) || versions.length === 0 || versions.length > 100) {
  throw new Error('launcher-changelog.json must contain between 1 and 100 versions.');
}
if (!semanticVersion.test(releaseVersion)) {
  throw new Error(`Release version is invalid: ${releaseVersion}`);
}

const seen = new Set();
for (let index = 0; index < versions.length; index += 1) {
  const entry = versions[index];
  if (
    !entry ||
    typeof entry !== 'object' ||
    typeof entry.version !== 'string' ||
    !semanticVersion.test(entry.version)
  ) {
    throw new Error(`Launcher changelog entry ${index + 1} has an invalid version.`);
  }
  if (seen.has(entry.version)) {
    throw new Error(`Launcher changelog version ${entry.version} is duplicated.`);
  }
  seen.add(entry.version);
  if (
    entry.releasedOn !== undefined &&
    (typeof entry.releasedOn !== 'string' || !isValidReleaseDate(entry.releasedOn))
  ) {
    throw new Error(`Launcher changelog version ${entry.version} has an invalid release date.`);
  }
  if (
    entry.title !== undefined &&
    (typeof entry.title !== 'string' ||
      entry.title.trim() !== entry.title ||
      entry.title.length === 0 ||
      entry.title.length > 80)
  ) {
    throw new Error(`Launcher changelog version ${entry.version} has an invalid title.`);
  }
  if (
    entry.summary !== undefined &&
    (typeof entry.summary !== 'string' ||
      entry.summary.trim() !== entry.summary ||
      entry.summary.length === 0 ||
      entry.summary.length > 300)
  ) {
    throw new Error(`Launcher changelog version ${entry.version} has an invalid summary.`);
  }
  if (!Array.isArray(entry.changes) || entry.changes.length === 0 || entry.changes.length > 25) {
    throw new Error(`Launcher changelog version ${entry.version} has an invalid changes list.`);
  }
  for (let changeIndex = 0; changeIndex < entry.changes.length; changeIndex += 1) {
    const change = entry.changes[changeIndex];
    if (
      typeof change !== 'string' ||
      change.trim() !== change ||
      change.length === 0 ||
      change.length > 240
    ) {
      throw new Error(
        `Launcher changelog version ${entry.version} change ${changeIndex + 1} is invalid.`
      );
    }
  }
  if (index > 0) {
    if (compareVersions(versions[index - 1].version, entry.version) <= 0) {
      throw new Error('Launcher changelog versions must be ordered newest first.');
    }
  }
}

if (versions[0].version !== releaseVersion) {
  if (!allowPrevious || compareVersions(releaseVersion, versions[0].version) <= 0) {
    throw new Error(
      `Newest launcher changelog is v${versions[0].version}, ` +
        `but the release build is v${releaseVersion}.`
    );
  }
  process.stdout.write(
    `Launcher changelog remains at v${versions[0].version} for hotfix v${releaseVersion}.\n`
  );
} else {
  process.stdout.write(`Launcher changelog is ready for v${releaseVersion}.\n`);
}

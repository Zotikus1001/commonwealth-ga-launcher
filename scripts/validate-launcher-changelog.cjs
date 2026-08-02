const { readFileSync } = require('fs');
const { resolve } = require('path');

const root = resolve(__dirname, '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), { encoding: 'utf-8' }));
const changelog = JSON.parse(
  readFileSync(resolve(root, 'launcher-changelog.json'), { encoding: 'utf-8' })
);
const versions = changelog?.versions;
const releaseVersion = process.argv[2] ?? packageJson.version;
const semanticVersion = /^\d+\.\d+\.\d+$/;
const releaseDate = /^\d{4}-\d{2}-\d{2}$/;

function isValidReleaseDate(value) {
  if (!releaseDate.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
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
    const previous = versions[index - 1].version.split('.').map(Number);
    const current = entry.version.split('.').map(Number);
    let comparison = 0;
    for (let partIndex = 0; partIndex < 3; partIndex += 1) {
      comparison = previous[partIndex] - current[partIndex];
      if (comparison !== 0) break;
    }
    if (comparison <= 0) {
      throw new Error('Launcher changelog versions must be ordered newest first.');
    }
  }
}

if (versions[0].version !== releaseVersion) {
  throw new Error(
    `Newest launcher changelog is v${versions[0].version}, ` +
      `but the release build is v${releaseVersion}.`
  );
}

process.stdout.write(`Launcher changelog is ready for v${releaseVersion}.\n`);

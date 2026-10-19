const { mkdirSync, readFileSync, writeFileSync } = require('fs');
const { dirname, resolve } = require('path');
const { loadLauncherConfig } = require('./launcher-config.cjs');
const { parseServerEvents } = require('../src/shared/serverEventsParser.cjs');

const validateEnvironment = process.argv.includes('--validate-environment');
const config = loadLauncherConfig({ resolveEnvironment: validateEnvironment });
if (validateEnvironment) {
  if (!config.defaultServerHost) {
    throw new Error('The configured default server host environment value is required.');
  }
} else if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(config)}\n`);
} else {
  const output = resolve(__dirname, '..', 'src', 'shared', 'generatedLauncherConfig.ts');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(
    output,
    `export const LAUNCHER_CONFIG = ${JSON.stringify(config, null, 2)} as const;\n`,
    { encoding: 'utf-8' }
  );
  const events = parseServerEvents(readFileSync(resolve(__dirname, '..', 'server-events.yaml'), 'utf8'));
  writeFileSync(resolve(dirname(output), 'generatedServerEvents.ts'),
    `export const BUNDLED_SERVER_EVENTS = ${JSON.stringify(events, null, 2)} as const;\n`, 'utf8');
}

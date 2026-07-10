const { mkdirSync, writeFileSync } = require('fs');
const { dirname, resolve } = require('path');
const { loadLauncherConfig } = require('./launcher-config.cjs');

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
}

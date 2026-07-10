import { constants } from 'fs';
import { access, copyFile, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { isLoginMap, type LoginMap } from '@shared/loginMaps';
import type { ClientPatchStatus } from '@shared/types';
import type { GameInstall } from './InstallLocator';
import type { Log } from './Log';

export const CLIENT_NET_SPEED = 50_000;

const NET_SPEED_KEYS = ['ConfiguredInternetSpeed', 'ConfiguredLanSpeed'] as const;
type NetSpeedKey = (typeof NET_SPEED_KEYS)[number];
const LOGIN_MAP_KEYS = ['Map', 'LocalMap'] as const;
type LoginMapKey = (typeof LOGIN_MAP_KEYS)[number];

export interface IniRepairResult {
  checkedFiles: string[];
  changedFiles: string[];
  backupFiles: string[];
}

interface TextPatchResult {
  text: string;
  changed: boolean;
}

interface IniPatchOptions {
  netSpeed?: boolean;
  loginMap?: LoginMap;
  suppressOverhealing?: boolean;
}

function trailingLineEnding(value: string): string {
  return value.match(/(?:\r\n|\n|\r)$/)?.[0] ?? '';
}

function patchEnginePlayerSection(text: string): TextPatchResult {
  const lines = (text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? []).filter(
    (line) => line.length > 0
  );
  let inEnginePlayer = false;
  let firstSectionStart = -1;
  let firstSectionEnd = -1;
  let firstSectionLineEnding = '';
  const assignments = new Map<NetSpeedKey, number>(NET_SPEED_KEYS.map((key) => [key, 0]));
  const removals = new Set<NetSpeedKey>();
  let changed = false;

  for (let index = 0; index < lines.length; index++) {
    const lineEnding = trailingLineEnding(lines[index]);
    const line = lineEnding ? lines[index].slice(0, -lineEnding.length) : lines[index];
    const section = line.match(/^\uFEFF?\s*\[([^\]]+)]\s*(?:[;#].*)?$/);
    if (section) {
      if (inEnginePlayer && firstSectionEnd < 0) firstSectionEnd = index;
      inEnginePlayer = section[1].trim().toLowerCase() === 'engine.player';
      if (inEnginePlayer && firstSectionStart < 0) {
        firstSectionStart = index;
        firstSectionLineEnding = lineEnding;
      }
      continue;
    }
    if (!inEnginePlayer) continue;

    const assignment = line.match(
      /^(\s*)([+.-]?)(ConfiguredInternetSpeed|ConfiguredLanSpeed)(\s*=\s*)([^;#\s]*)(.*)$/i
    );
    if (!assignment) continue;
    const key = NET_SPEED_KEYS.find((candidate) => candidate.toLowerCase() === assignment[3].toLowerCase());
    if (!key) continue;
    // Unreal -Key lines remove inherited values; changing them would preserve the old limit.
    if (assignment[2] === '-') {
      removals.add(key);
      continue;
    }
    assignments.set(key, (assignments.get(key) ?? 0) + 1);
    const replacement = `${assignment[1]}${assignment[2]}${assignment[3]}${assignment[4]}${CLIENT_NET_SPEED}${assignment[6]}`;
    if (replacement !== line) {
      lines[index] = replacement + lineEnding;
      changed = true;
    }
  }

  const missing = NET_SPEED_KEYS.filter((key) => (assignments.get(key) ?? 0) === 0);
  if (missing.length === 0) return { text: lines.join(''), changed };

  const preferredLineEnding =
    firstSectionLineEnding || lines.map(trailingLineEnding).find(Boolean) || '\r\n';
  const newAssignments = missing.map(
    (key) => `${removals.has(key) ? '+' : ''}${key}=${CLIENT_NET_SPEED}`
  );

  if (firstSectionStart < 0) {
    let separator = '';
    if (text.length > 0) {
      const endsWithLineEnding = trailingLineEnding(text) !== '';
      const lastLine = text.split(/\r\n|\n|\r/).at(endsWithLineEnding ? -2 : -1) ?? '';
      if (!endsWithLineEnding) separator += preferredLineEnding;
      if (lastLine.trim() !== '') separator += preferredLineEnding;
    }
    const section =
      `[Engine.Player]${preferredLineEnding}` + newAssignments.join(preferredLineEnding);
    return { text: text + separator + section, changed: true };
  }

  if (firstSectionEnd < 0) firstSectionEnd = lines.length;
  let insertAt = firstSectionEnd;
  while (insertAt > firstSectionStart + 1) {
    const token = lines[insertAt - 1];
    const lineEnding = trailingLineEnding(token);
    const content = lineEnding ? token.slice(0, -lineEnding.length) : token;
    if (content.trim() !== '') break;
    insertAt--;
  }
  const previousHasLineEnding =
    insertAt === 0 || trailingLineEnding(lines[insertAt - 1]) !== '';
  const preserveMissingTrailingNewline =
    insertAt === lines.length && text.length > 0 && trailingLineEnding(text) === '';
  const inserted = newAssignments.map((assignment, index) => {
    const prefix = index === 0 && !previousHasLineEnding ? preferredLineEnding : '';
    const isLast = index === newAssignments.length - 1;
    const suffix = isLast && preserveMissingTrailingNewline ? '' : preferredLineEnding;
    return prefix + assignment + suffix;
  });
  lines.splice(insertAt, 0, ...inserted);
  return { text: lines.join(''), changed: true };
}

function verifyEnginePlayerSection(text: string, fileName: string): void {
  let inEnginePlayer = false;
  const values = new Map<NetSpeedKey, number[]>(NET_SPEED_KEYS.map((key) => [key, []]));

  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\uFEFF?\s*\[([^\]]+)]\s*(?:[;#].*)?$/);
    if (section) {
      inEnginePlayer = section[1].trim().toLowerCase() === 'engine.player';
      continue;
    }
    if (!inEnginePlayer) continue;
    const assignment = line.match(
      /^\s*([+.-]?)(ConfiguredInternetSpeed|ConfiguredLanSpeed)\s*=\s*([^;#\s]*)/i
    );
    if (!assignment || assignment[1] === '-') continue;
    const key = NET_SPEED_KEYS.find((candidate) => candidate.toLowerCase() === assignment[2].toLowerCase());
    if (key) values.get(key)?.push(Number(assignment[3]));
  }

  for (const key of NET_SPEED_KEYS) {
    const found = values.get(key) ?? [];
    if (found.length === 0 || found.some((value) => value !== CLIENT_NET_SPEED)) {
      throw new Error(`${fileName} did not retain ${key}=${CLIENT_NET_SPEED}`);
    }
  }
}

export function unavailableClientPatches(): ClientPatchStatus[] {
  return [{ id: 'high-fps-movement-stability', applied: null }];
}

export async function inspectClientPatches(
  install: GameInstall | null
): Promise<ClientPatchStatus[]> {
  if (!install) return unavailableClientPatches();

  const configDir = join(install.rootDir, 'TgGame', 'Config');
  let applied = true;
  for (const [path, required] of [
    [join(configDir, 'TgEngine.ini'), true],
    [join(configDir, 'DefaultEngine.ini'), false]
  ] as const) {
    try {
      verifyEnginePlayerSection(await readFile(path, { encoding: 'utf-8' }), basename(path));
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      applied = false;
      break;
    }
  }

  return [{ id: 'high-fps-movement-stability', applied }];
}

function patchUrlSection(text: string, loginMap: LoginMap): TextPatchResult {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingNewline = text.endsWith('\n');
  const lines = text.split(/\r?\n/);
  if (hasTrailingNewline) lines.pop();

  let inUrl = false;
  let firstSectionStart = -1;
  let firstSectionEnd = -1;
  const assignments = new Map<LoginMapKey, number>(LOGIN_MAP_KEYS.map((key) => [key, 0]));
  let changed = false;

  for (let index = 0; index < lines.length; index++) {
    const section = lines[index].match(/^\uFEFF?\s*\[([^\]]+)]\s*(?:[;#].*)?$/);
    if (section) {
      if (inUrl && firstSectionEnd < 0) firstSectionEnd = index;
      inUrl = section[1].trim().toLowerCase() === 'url';
      if (inUrl && firstSectionStart < 0) firstSectionStart = index;
      continue;
    }
    if (!inUrl) continue;

    const assignment = lines[index].match(/^(\s*)([+.-]?)(Map|LocalMap)(\s*=\s*)([^;#\s]*)(.*)$/i);
    if (!assignment || assignment[2] === '-') continue;
    const key = LOGIN_MAP_KEYS.find((candidate) => candidate.toLowerCase() === assignment[3].toLowerCase());
    if (!key) continue;
    assignments.set(key, (assignments.get(key) ?? 0) + 1);
    const replacement = `${assignment[1]}${assignment[2]}${assignment[3]}${assignment[4]}${loginMap}${assignment[6]}`;
    if (replacement !== lines[index]) {
      lines[index] = replacement;
      changed = true;
    }
  }

  if (firstSectionStart < 0) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push('[URL]');
    firstSectionStart = lines.length - 1;
    firstSectionEnd = lines.length;
    changed = true;
  } else if (firstSectionEnd < 0) {
    firstSectionEnd = lines.length;
  }

  let insertAt = firstSectionEnd;
  while (insertAt > firstSectionStart + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  for (const key of LOGIN_MAP_KEYS) {
    if ((assignments.get(key) ?? 0) > 0) continue;
    lines.splice(insertAt, 0, `${key}=${loginMap}`);
    insertAt++;
    changed = true;
  }

  return { text: lines.join(newline) + (hasTrailingNewline ? newline : ''), changed };
}

function verifyUrlSection(text: string, fileName: string, loginMap: LoginMap): void {
  let inUrl = false;
  const values = new Map<LoginMapKey, string[]>(LOGIN_MAP_KEYS.map((key) => [key, []]));

  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\uFEFF?\s*\[([^\]]+)]\s*(?:[;#].*)?$/);
    if (section) {
      inUrl = section[1].trim().toLowerCase() === 'url';
      continue;
    }
    if (!inUrl) continue;
    const assignment = line.match(/^\s*([+.-]?)(Map|LocalMap)\s*=\s*([^;#\s]*)/i);
    if (!assignment || assignment[1] === '-') continue;
    const key = LOGIN_MAP_KEYS.find((candidate) => candidate.toLowerCase() === assignment[2].toLowerCase());
    if (key) values.get(key)?.push(assignment[3]);
  }

  for (const key of LOGIN_MAP_KEYS) {
    const found = values.get(key) ?? [];
    if (found.length === 0 || found.some((value) => value !== loginMap)) {
      throw new Error(`${fileName} did not retain ${key}=${loginMap}`);
    }
  }
}

function patchOverhealingSection(text: string, suppressOverhealing: boolean): TextPatchResult {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingNewline = text.endsWith('\n');
  const lines = text.split(/\r?\n/);
  if (hasTrailingNewline) lines.pop();

  const expected = suppressOverhealing ? 'True' : 'False';
  let inPrimaryHud = false;
  let firstSectionStart = -1;
  let firstSectionEnd = -1;
  let assignments = 0;
  let changed = false;

  for (let index = 0; index < lines.length; index++) {
    const section = lines[index].match(/^\uFEFF?\s*\[([^\]]+)]\s*(?:[;#].*)?$/);
    if (section) {
      if (inPrimaryHud && firstSectionEnd < 0) firstSectionEnd = index;
      inPrimaryHud = section[1].trim().toLowerCase() === 'tgclient.tguiprimaryhud';
      if (inPrimaryHud && firstSectionStart < 0) firstSectionStart = index;
      continue;
    }
    if (!inPrimaryHud) continue;

    const assignment = lines[index].match(
      /^(\s*)([+.-]?)(m_bSuppressOverhealing)(\s*=\s*)([^;#\s]*)(.*)$/i
    );
    if (!assignment || assignment[2] === '-') continue;
    assignments++;
    const replacement =
      `${assignment[1]}${assignment[2]}${assignment[3]}${assignment[4]}${expected}${assignment[6]}`;
    if (replacement !== lines[index]) {
      lines[index] = replacement;
      changed = true;
    }
  }

  if (firstSectionStart < 0) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push('[TgClient.TgUIPrimaryHUD]');
    firstSectionStart = lines.length - 1;
    firstSectionEnd = lines.length;
    changed = true;
  } else if (firstSectionEnd < 0) {
    firstSectionEnd = lines.length;
  }

  if (assignments === 0) {
    let insertAt = firstSectionEnd;
    while (insertAt > firstSectionStart + 1 && lines[insertAt - 1].trim() === '') insertAt--;
    lines.splice(insertAt, 0, `m_bSuppressOverhealing=${expected}`);
    changed = true;
  }

  return { text: lines.join(newline) + (hasTrailingNewline ? newline : ''), changed };
}

function verifyOverhealingSection(
  text: string,
  fileName: string,
  suppressOverhealing: boolean
): void {
  const expected = suppressOverhealing ? 'true' : 'false';
  let inPrimaryHud = false;
  const values: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\uFEFF?\s*\[([^\]]+)]\s*(?:[;#].*)?$/);
    if (section) {
      inPrimaryHud = section[1].trim().toLowerCase() === 'tgclient.tguiprimaryhud';
      continue;
    }
    if (!inPrimaryHud) continue;
    const assignment = line.match(/^\s*([+.-]?)m_bSuppressOverhealing\s*=\s*([^;#\s]*)/i);
    if (!assignment || assignment[1] === '-') continue;
    values.push(assignment[2].toLowerCase());
  }

  if (values.length === 0 || values.some((value) => value !== expected)) {
    throw new Error(
      `${fileName} did not retain m_bSuppressOverhealing=${suppressOverhealing ? 'True' : 'False'}`
    );
  }
}

async function patchIniFile(
  path: string,
  options: IniPatchOptions
): Promise<{ changed: boolean; backupPath: string | null }> {
  const original = await readFile(path, { encoding: 'utf-8' });
  let patchedText = original;
  let changed = false;
  const apply = (patch: TextPatchResult): void => {
    if (!patch.changed) return;
    patchedText = patch.text;
    changed = true;
  };

  if (options.netSpeed) apply(patchEnginePlayerSection(patchedText));
  if (options.loginMap) apply(patchUrlSection(patchedText, options.loginMap));
  if (options.suppressOverhealing !== undefined) {
    apply(patchOverhealingSection(patchedText, options.suppressOverhealing));
  }

  const verify = (text: string): void => {
    const fileName = basename(path);
    if (options.netSpeed) verifyEnginePlayerSection(text, fileName);
    if (options.loginMap) verifyUrlSection(text, fileName, options.loginMap);
    if (options.suppressOverhealing !== undefined) {
      verifyOverhealingSection(text, fileName, options.suppressOverhealing);
    }
  };

  if (!changed) {
    verify(patchedText);
    return { changed: false, backupPath: null };
  }

  const backupPath = `${path}.commonwealth-backup`;
  try {
    await copyFile(path, backupPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const temporaryPath = `${path}.commonwealth-tmp-${process.pid}`;
  const mode = (await stat(path)).mode;
  try {
    await writeFile(temporaryPath, patchedText, { encoding: 'utf-8', mode });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }

  const verified = await readFile(path, { encoding: 'utf-8' });
  verify(verified);
  return { changed: true, backupPath };
}

/** Verifies the active config and its regeneration source before every game launch. */
export async function ensureClientConfiguration(
  install: GameInstall,
  loginMap: LoginMap,
  showOverhealing: boolean,
  log: Log
): Promise<IniRepairResult> {
  if (!isLoginMap(loginMap)) throw new Error(`Unsupported login map: ${loginMap}`);
  if (typeof showOverhealing !== 'boolean') throw new Error('Invalid overhealing setting');
  const configDir = join(install.rootDir, 'TgGame', 'Config');
  const suppressOverhealing = !showOverhealing;
  const result: IniRepairResult = { checkedFiles: [], changedFiles: [], backupFiles: [] };

  const files: Array<{ path: string; required: boolean; options: IniPatchOptions }> = [
    {
      path: join(configDir, 'TgEngine.ini'),
      required: true,
      options: { netSpeed: true, loginMap }
    },
    {
      path: join(configDir, 'DefaultEngine.ini'),
      required: false,
      options: { netSpeed: true }
    },
    {
      path: join(configDir, 'TgUI.ini'),
      required: true,
      options: { suppressOverhealing }
    },
    {
      path: join(configDir, 'DefaultUI.ini'),
      required: false,
      options: { suppressOverhealing }
    }
  ];

  for (const { path, required, options } of files) {
    try {
      await access(path, constants.R_OK | constants.W_OK);
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        log.warn(`client ini: ${basename(path)} is absent; active config will still be repaired`);
        continue;
      }
      throw new Error(`Cannot update ${basename(path)}: ${(error as Error).message}`);
    }

    try {
      const patched = await patchIniFile(path, options);
      result.checkedFiles.push(path);
      if (patched.changed) result.changedFiles.push(path);
      if (patched.backupPath) result.backupFiles.push(patched.backupPath);
    } catch (error) {
      throw new Error(`Cannot repair ${basename(path)}: ${(error as Error).message}`);
    }
  }

  log.info(
    `client ini: ${CLIENT_NET_SPEED}/${CLIENT_NET_SPEED}, ${loginMap}, and overhealing ` +
      `${showOverhealing ? 'shown' : 'suppressed'} verified in ` +
      `${result.checkedFiles.length} file(s); ` +
      `${result.changedFiles.length} changed`
  );
  return result;
}

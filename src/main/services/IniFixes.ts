import { constants } from 'fs';
import { access, copyFile, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { isLoginMap, type LoginMap } from '@shared/loginMaps';
import { isFpsLimit } from '@shared/fpsLimit';
import type { ClientPatchId, ClientPatchStatus } from '@shared/types';
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

type IniPatchOptions =
  | { kind: 'net-speed' }
  | { kind: 'login-map'; loginMap: LoginMap }
  | { kind: 'overhealing'; suppressOverhealing: boolean }
  | { kind: 'fps-smoothing'; enabled: boolean }
  | { kind: 'fps-limit'; limit: number };

interface IniFileEdit {
  path: string;
  required: boolean;
  options: IniPatchOptions;
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

  for (const line of text.split(/\r\n|\n|\r/)) {
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

function frameRateValue(
  options: Extract<IniPatchOptions, { kind: 'fps-smoothing' | 'fps-limit' }>
): {
  key: 'bSmoothFrameRate' | 'MaxSmoothedFrameRate';
  insertedValue: string;
  replacementValue(current: string): string;
  matches(current: string): boolean;
} {
  if (options.kind === 'fps-smoothing') {
    const expected = options.enabled ? 'true' : 'false';
    return {
      key: 'bSmoothFrameRate',
      insertedValue: options.enabled ? 'True' : 'False',
      replacementValue: () => (options.enabled ? 'True' : 'False'),
      matches: (current) => current.toLowerCase() === expected
    };
  }
  return {
    key: 'MaxSmoothedFrameRate',
    insertedValue: options.limit.toFixed(6),
    replacementValue: (current) => {
      const decimals = current.match(/^[+]?[0-9]+\.([0-9]+)$/)?.[1].length;
      return decimals === undefined ? String(options.limit) : options.limit.toFixed(decimals);
    },
    matches: (current) => Number(current) === options.limit
  };
}

function patchGameEngineFrameRate(
  text: string,
  options: Extract<IniPatchOptions, { kind: 'fps-smoothing' | 'fps-limit' }>
): TextPatchResult {
  const setting = frameRateValue(options);
  const lines = (text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? []).filter(
    (line) => line.length > 0
  );
  let inGameEngine = false;
  let firstSectionStart = -1;
  let firstSectionEnd = -1;
  let firstSectionLineEnding = '';
  let assignments = 0;
  let hasRemoval = false;
  let changed = false;

  for (let index = 0; index < lines.length; index++) {
    const lineEnding = trailingLineEnding(lines[index]);
    const line = lineEnding ? lines[index].slice(0, -lineEnding.length) : lines[index];
    const section = line.match(/^\uFEFF?\s*\[([^\]]+)]\s*(?:[;#].*)?$/);
    if (section) {
      if (inGameEngine && firstSectionEnd < 0) firstSectionEnd = index;
      inGameEngine = section[1].trim().toLowerCase() === 'engine.gameengine';
      if (inGameEngine && firstSectionStart < 0) {
        firstSectionStart = index;
        firstSectionLineEnding = lineEnding;
      }
      continue;
    }
    if (!inGameEngine) continue;

    const assignment = line.match(
      /^(\s*)([+.-]?)(bSmoothFrameRate|MaxSmoothedFrameRate)(\s*=\s*)([^;#\s]*)(.*)$/i
    );
    if (!assignment || assignment[3].toLowerCase() !== setting.key.toLowerCase()) continue;
    if (assignment[2] === '-') {
      hasRemoval = true;
      continue;
    }
    assignments++;
    if (setting.matches(assignment[5])) continue;
    lines[index] =
      `${assignment[1]}${assignment[2]}${assignment[3]}${assignment[4]}` +
      `${setting.replacementValue(assignment[5])}${assignment[6]}${lineEnding}`;
    changed = true;
  }

  if (assignments > 0) return { text: lines.join(''), changed };

  const preferredLineEnding =
    firstSectionLineEnding || lines.map(trailingLineEnding).find(Boolean) || '\r\n';
  const newAssignment = `${hasRemoval ? '+' : ''}${setting.key}=${setting.insertedValue}`;
  if (firstSectionStart < 0) {
    let separator = '';
    if (text.length > 0) {
      const endsWithLineEnding = trailingLineEnding(text) !== '';
      const lastLine = text.split(/\r\n|\n|\r/).at(endsWithLineEnding ? -2 : -1) ?? '';
      if (!endsWithLineEnding) separator += preferredLineEnding;
      if (lastLine.trim() !== '') separator += preferredLineEnding;
    }
    const section = `[Engine.GameEngine]${preferredLineEnding}${newAssignment}`;
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
  const previousHasLineEnding = insertAt === 0 || trailingLineEnding(lines[insertAt - 1]) !== '';
  const preserveMissingTrailingNewline =
    insertAt === lines.length && text.length > 0 && trailingLineEnding(text) === '';
  lines.splice(
    insertAt,
    0,
    `${previousHasLineEnding ? '' : preferredLineEnding}${newAssignment}${
      preserveMissingTrailingNewline ? '' : preferredLineEnding
    }`
  );
  return { text: lines.join(''), changed: true };
}

function verifyGameEngineFrameRate(
  text: string,
  fileName: string,
  options: Extract<IniPatchOptions, { kind: 'fps-smoothing' | 'fps-limit' }>
): void {
  const setting = frameRateValue(options);
  let inGameEngine = false;
  const values: string[] = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    const section = line.match(/^\uFEFF?\s*\[([^\]]+)]\s*(?:[;#].*)?$/);
    if (section) {
      inGameEngine = section[1].trim().toLowerCase() === 'engine.gameengine';
      continue;
    }
    if (!inGameEngine) continue;
    const assignment = line.match(
      /^\s*([+.-]?)(bSmoothFrameRate|MaxSmoothedFrameRate)\s*=\s*([^;#\s]*)/i
    );
    if (
      !assignment ||
      assignment[1] === '-' ||
      assignment[2].toLowerCase() !== setting.key.toLowerCase()
    ) {
      continue;
    }
    values.push(assignment[3]);
  }
  if (values.length === 0 || values.some((value) => !setting.matches(value))) {
    throw new Error(`${fileName} did not retain ${setting.key}=${setting.insertedValue}`);
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
  const lines = (text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? []).filter(
    (line) => line.length > 0
  );
  let inUrl = false;
  let firstSectionStart = -1;
  let firstSectionEnd = -1;
  let firstSectionLineEnding = '';
  const assignments = new Map<LoginMapKey, number>(LOGIN_MAP_KEYS.map((key) => [key, 0]));
  const removals = new Set<LoginMapKey>();
  let changed = false;

  for (let index = 0; index < lines.length; index++) {
    const lineEnding = trailingLineEnding(lines[index]);
    const line = lineEnding ? lines[index].slice(0, -lineEnding.length) : lines[index];
    const section = line.match(/^\uFEFF?\s*\[([^\]]+)]\s*(?:[;#].*)?$/);
    if (section) {
      if (inUrl && firstSectionEnd < 0) firstSectionEnd = index;
      inUrl = section[1].trim().toLowerCase() === 'url';
      if (inUrl && firstSectionStart < 0) {
        firstSectionStart = index;
        firstSectionLineEnding = lineEnding;
      }
      continue;
    }
    if (!inUrl) continue;

    const assignment = line.match(/^(\s*)([+.-]?)(Map|LocalMap)(\s*=\s*)([^;#\s]*)(.*)$/i);
    if (!assignment) continue;
    const key = LOGIN_MAP_KEYS.find((candidate) => candidate.toLowerCase() === assignment[3].toLowerCase());
    if (!key) continue;
    if (assignment[2] === '-') {
      removals.add(key);
      continue;
    }
    assignments.set(key, (assignments.get(key) ?? 0) + 1);
    const replacement = `${assignment[1]}${assignment[2]}${assignment[3]}${assignment[4]}${loginMap}${assignment[6]}`;
    if (replacement !== line) {
      lines[index] = replacement + lineEnding;
      changed = true;
    }
  }

  const missing = LOGIN_MAP_KEYS.filter((key) => (assignments.get(key) ?? 0) === 0);
  if (missing.length === 0) return { text: lines.join(''), changed };

  const preferredLineEnding =
    firstSectionLineEnding || lines.map(trailingLineEnding).find(Boolean) || '\r\n';
  const newAssignments = missing.map(
    (key) => `${removals.has(key) ? '+' : ''}${key}=${loginMap}`
  );

  if (firstSectionStart < 0) {
    let separator = '';
    if (text.length > 0) {
      const endsWithLineEnding = trailingLineEnding(text) !== '';
      const lastLine = text.split(/\r\n|\n|\r/).at(endsWithLineEnding ? -2 : -1) ?? '';
      if (!endsWithLineEnding) separator += preferredLineEnding;
      if (lastLine.trim() !== '') separator += preferredLineEnding;
    }
    const section = `[URL]${preferredLineEnding}` + newAssignments.join(preferredLineEnding);
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
  const previousHasLineEnding = insertAt === 0 || trailingLineEnding(lines[insertAt - 1]) !== '';
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

function verifyUrlSection(text: string, fileName: string, loginMap: LoginMap): void {
  let inUrl = false;
  const values = new Map<LoginMapKey, string[]>(LOGIN_MAP_KEYS.map((key) => [key, []]));

  for (const line of text.split(/\r\n|\n|\r/)) {
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
  const lines = (text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? []).filter(
    (line) => line.length > 0
  );
  const expected = suppressOverhealing ? 'True' : 'False';
  let inPrimaryHud = false;
  let firstSectionStart = -1;
  let firstSectionEnd = -1;
  let firstSectionLineEnding = '';
  let assignments = 0;
  let hasRemoval = false;
  let changed = false;

  for (let index = 0; index < lines.length; index++) {
    const lineEnding = trailingLineEnding(lines[index]);
    const line = lineEnding ? lines[index].slice(0, -lineEnding.length) : lines[index];
    const section = line.match(/^\uFEFF?\s*\[([^\]]+)]\s*(?:[;#].*)?$/);
    if (section) {
      if (inPrimaryHud && firstSectionEnd < 0) firstSectionEnd = index;
      inPrimaryHud = section[1].trim().toLowerCase() === 'tgclient.tguiprimaryhud';
      if (inPrimaryHud && firstSectionStart < 0) {
        firstSectionStart = index;
        firstSectionLineEnding = lineEnding;
      }
      continue;
    }
    if (!inPrimaryHud) continue;

    const assignment = line.match(
      /^(\s*)([+.-]?)(m_bSuppressOverhealing)(\s*=\s*)([^;#\s]*)(.*)$/i
    );
    if (!assignment) continue;
    if (assignment[2] === '-') {
      hasRemoval = true;
      continue;
    }
    assignments++;
    const replacement =
      `${assignment[1]}${assignment[2]}${assignment[3]}${assignment[4]}${expected}${assignment[6]}`;
    if (replacement !== line) {
      lines[index] = replacement + lineEnding;
      changed = true;
    }
  }

  if (assignments > 0) return { text: lines.join(''), changed };

  const preferredLineEnding =
    firstSectionLineEnding || lines.map(trailingLineEnding).find(Boolean) || '\r\n';
  const newAssignment = `${hasRemoval ? '+' : ''}m_bSuppressOverhealing=${expected}`;
  if (firstSectionStart < 0) {
    let separator = '';
    if (text.length > 0) {
      const endsWithLineEnding = trailingLineEnding(text) !== '';
      const lastLine = text.split(/\r\n|\n|\r/).at(endsWithLineEnding ? -2 : -1) ?? '';
      if (!endsWithLineEnding) separator += preferredLineEnding;
      if (lastLine.trim() !== '') separator += preferredLineEnding;
    }
    const section =
      `[TgClient.TgUIPrimaryHUD]${preferredLineEnding}${newAssignment}`;
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
  const previousHasLineEnding = insertAt === 0 || trailingLineEnding(lines[insertAt - 1]) !== '';
  const preserveMissingTrailingNewline =
    insertAt === lines.length && text.length > 0 && trailingLineEnding(text) === '';
  lines.splice(
    insertAt,
    0,
    `${previousHasLineEnding ? '' : preferredLineEnding}${newAssignment}${
      preserveMissingTrailingNewline ? '' : preferredLineEnding
    }`
  );
  return { text: lines.join(''), changed: true };
}

function verifyOverhealingSection(
  text: string,
  fileName: string,
  suppressOverhealing: boolean
): void {
  const expected = suppressOverhealing ? 'true' : 'false';
  let inPrimaryHud = false;
  const values: string[] = [];

  for (const line of text.split(/\r\n|\n|\r/)) {
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

  if (options.kind === 'net-speed') apply(patchEnginePlayerSection(patchedText));
  if (options.kind === 'login-map') apply(patchUrlSection(patchedText, options.loginMap));
  if (options.kind === 'overhealing') {
    apply(patchOverhealingSection(patchedText, options.suppressOverhealing));
  }
  if (options.kind === 'fps-smoothing' || options.kind === 'fps-limit') {
    apply(patchGameEngineFrameRate(patchedText, options));
  }

  const verify = (text: string): void => {
    const fileName = basename(path);
    if (options.kind === 'net-speed') verifyEnginePlayerSection(text, fileName);
    if (options.kind === 'login-map') verifyUrlSection(text, fileName, options.loginMap);
    if (options.kind === 'overhealing') {
      verifyOverhealingSection(text, fileName, options.suppressOverhealing);
    }
    if (options.kind === 'fps-smoothing' || options.kind === 'fps-limit') {
      verifyGameEngineFrameRate(text, fileName, options);
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

async function applyIniEdits(edits: IniFileEdit[], log: Log): Promise<IniRepairResult> {
  const result: IniRepairResult = { checkedFiles: [], changedFiles: [], backupFiles: [] };
  for (const { path, required, options } of edits) {
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

  return result;
}

function mergeRepairResults(results: IniRepairResult[]): IniRepairResult {
  return {
    checkedFiles: [...new Set(results.flatMap((result) => result.checkedFiles))],
    changedFiles: [...new Set(results.flatMap((result) => result.changedFiles))],
    backupFiles: [...new Set(results.flatMap((result) => result.backupFiles))]
  };
}

export async function applyClientPatch(
  install: GameInstall,
  id: ClientPatchId,
  log: Log
): Promise<IniRepairResult> {
  if (id !== 'high-fps-movement-stability') throw new Error(`Unsupported client patch: ${id}`);
  const configDir = join(install.rootDir, 'TgGame', 'Config');
  const result = await applyIniEdits(
    [
      {
        path: join(configDir, 'TgEngine.ini'),
        required: true,
        options: { kind: 'net-speed' }
      },
      {
        path: join(configDir, 'DefaultEngine.ini'),
        required: false,
        options: { kind: 'net-speed' }
      }
    ],
    log
  );
  log.info(
    `client patch: ${id} verified in ${result.checkedFiles.length} file(s); ` +
      `${result.changedFiles.length} changed`
  );
  return result;
}

async function ensureLoginMap(
  install: GameInstall,
  loginMap: LoginMap,
  log: Log
): Promise<IniRepairResult> {
  if (!isLoginMap(loginMap)) throw new Error(`Unsupported login map: ${loginMap}`);
  const configDir = join(install.rootDir, 'TgGame', 'Config');
  return applyIniEdits(
    [
      {
        path: join(configDir, 'TgEngine.ini'),
        required: true,
        options: { kind: 'login-map', loginMap }
      }
    ],
    log
  );
}

async function ensureOverhealing(
  install: GameInstall,
  showOverhealing: boolean,
  log: Log
): Promise<IniRepairResult> {
  if (typeof showOverhealing !== 'boolean') throw new Error('Invalid overhealing setting');
  const configDir = join(install.rootDir, 'TgGame', 'Config');
  const suppressOverhealing = !showOverhealing;
  return applyIniEdits(
    [
      {
        path: join(configDir, 'TgUI.ini'),
        required: true,
        options: { kind: 'overhealing', suppressOverhealing }
      },
      {
        path: join(configDir, 'DefaultUI.ini'),
        required: false,
        options: { kind: 'overhealing', suppressOverhealing }
      }
    ],
    log
  );
}

async function ensureFpsLimit(
  install: GameInstall,
  enabled: boolean,
  limit: number,
  log: Log
): Promise<IniRepairResult> {
  if (typeof enabled !== 'boolean' || !isFpsLimit(limit)) {
    throw new Error('Invalid FPS limit setting');
  }
  const configDir = join(install.rootDir, 'TgGame', 'Config');
  const files = [
    { path: join(configDir, 'TgEngine.ini'), required: true },
    { path: join(configDir, 'DefaultEngine.ini'), required: false }
  ];
  const maximumResult = enabled
    ? await applyIniEdits(
        files.map(({ path, required }) => ({
          path,
          required,
          options: { kind: 'fps-limit', limit } as const
        })),
        log
      )
    : { checkedFiles: [], changedFiles: [], backupFiles: [] };
  const smoothingResult = await applyIniEdits(
    files.map(({ path, required }) => ({
      path,
      required,
      options: { kind: 'fps-smoothing', enabled } as const
    })),
    log
  );
  return mergeRepairResults([maximumResult, smoothingResult]);
}

/** Applies each configured INI setting independently before every game launch. */
export async function ensureClientConfiguration(
  install: GameInstall,
  loginMap: LoginMap,
  showOverhealing: boolean,
  fpsLimitEnabled: boolean,
  fpsLimit: number,
  log: Log
): Promise<IniRepairResult> {
  const networkResult = await applyClientPatch(install, 'high-fps-movement-stability', log);
  const loginMapResult = await ensureLoginMap(install, loginMap, log);
  const overhealingResult = await ensureOverhealing(install, showOverhealing, log);
  const fpsResult = await ensureFpsLimit(install, fpsLimitEnabled, fpsLimit, log);
  const result = mergeRepairResults([
    networkResult,
    loginMapResult,
    overhealingResult,
    fpsResult
  ]);

  log.info(
    `client ini: ${CLIENT_NET_SPEED}/${CLIENT_NET_SPEED}, ${loginMap}, and overhealing ` +
      `${showOverhealing ? 'shown' : 'suppressed'}, FPS limit ` +
      `${fpsLimitEnabled ? fpsLimit : 'off'} verified in ` +
      `${result.checkedFiles.length} file(s); ` +
      `${result.changedFiles.length} changed`
  );
  return result;
}

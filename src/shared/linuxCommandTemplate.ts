export const LINUX_COMMAND_PLACEHOLDER = '%command%';
export const DEFAULT_LINUX_COMMAND_TEMPLATE = LINUX_COMMAND_PLACEHOLDER;
export const MAX_LINUX_COMMAND_TEMPLATE_LENGTH = 4_096;
export const GAMESCOPE_COMMAND_TEMPLATE_EXAMPLE =
  'gamescope -w 1920 -h 1080 -W 3440 -H 1440 -b -- %command%';

export interface ExpandedLinuxCommand {
  command: string;
  args: string[];
}

type LaunchEnvironment = Readonly<Record<string, string | undefined>>;

interface TemplateWord {
  source: string;
  value: string;
}

function templateError(message: string): Error {
  return new Error(`Linux command wrapper: ${message}`);
}

function expandEnvironmentVariable(
  template: string,
  start: number,
  environment: LaunchEnvironment | undefined
): { source: string; value: string; end: number } | null {
  const next = template[start + 1];
  let name = '';
  let end = start;
  let source = '$';

  if (next === '(') {
    throw templateError('command substitution is not supported.');
  }

  if (next === '{') {
    const close = template.indexOf('}', start + 2);
    if (close === -1) throw templateError('has an unterminated environment variable.');
    name = template.slice(start + 2, close);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw templateError(`has an invalid environment variable: \${${name}}.`);
    }
    source = template.slice(start, close + 1);
    end = close;
  } else if (next && /[A-Za-z_]/.test(next)) {
    let cursor = start + 2;
    while (cursor < template.length && /[A-Za-z0-9_]/.test(template[cursor])) cursor += 1;
    name = template.slice(start + 1, cursor);
    source = template.slice(start, cursor);
    end = cursor - 1;
  } else {
    return null;
  }

  if (!environment) return { source, value: source, end };
  const value = environment[name];
  if (value === undefined) {
    throw templateError(`environment variable is not set: ${name}.`);
  }
  if (value.includes('\0')) {
    throw templateError(`environment variable contains an invalid null character: ${name}.`);
  }
  return { source, value, end };
}

function parseTemplateWords(
  template: string,
  environment?: LaunchEnvironment
): TemplateWord[] {
  const words: TemplateWord[] = [];
  let source = '';
  let value = '';
  let started = false;
  let quote: 'single' | 'double' | null = null;

  const append = (sourcePart: string, valuePart = sourcePart): void => {
    source += sourcePart;
    value += valuePart;
    started = true;
  };
  const finishWord = (): void => {
    if (!started) return;
    words.push({ source, value });
    source = '';
    value = '';
    started = false;
  };

  for (let index = 0; index < template.length; index += 1) {
    const character = template[index];

    if (quote === 'single') {
      if (character === "'") {
        quote = null;
      } else {
        append(character);
      }
      continue;
    }

    if (quote === 'double') {
      if (character === '"') {
        quote = null;
        continue;
      }
      if (character === '\\') {
        if (index + 1 >= template.length) {
          throw templateError('ends with an incomplete escape.');
        }
        index += 1;
        append(template[index]);
        continue;
      }
      if (character === '`') {
        throw templateError('command substitution is not supported.');
      }
      if (character === '$') {
        const expanded = expandEnvironmentVariable(template, index, environment);
        if (expanded) {
          append(expanded.source, expanded.value);
          index = expanded.end;
          continue;
        }
      }
      append(character);
      continue;
    }

    if (/\s/.test(character)) {
      finishWord();
      continue;
    }
    if (character === "'") {
      quote = 'single';
      started = true;
      continue;
    }
    if (character === '"') {
      quote = 'double';
      started = true;
      continue;
    }
    if (character === '\\') {
      if (index + 1 >= template.length) {
        throw templateError('ends with an incomplete escape.');
      }
      index += 1;
      append(template[index]);
      continue;
    }
    if (character === '`') {
      throw templateError('command substitution is not supported.');
    }
    if ('|&;<>'.includes(character)) {
      throw templateError(`shell operator is not supported: ${character}.`);
    }
    if (character === '$') {
      const expanded = expandEnvironmentVariable(template, index, environment);
      if (expanded) {
        append(expanded.source, expanded.value);
        index = expanded.end;
        continue;
      }
    }
    append(character);
  }

  if (quote) throw templateError(`has an unterminated ${quote}-quoted argument.`);
  finishWord();
  return words;
}

function validateParsedTemplate(template: string): string | null {
  if (!template.trim()) {
    return `Linux command wrapper must contain exactly one standalone ${LINUX_COMMAND_PLACEHOLDER}.`;
  }
  if (template.length > MAX_LINUX_COMMAND_TEMPLATE_LENGTH) {
    return `Linux command wrapper must be ${MAX_LINUX_COMMAND_TEMPLATE_LENGTH} characters or fewer.`;
  }
  if (template.includes('\0')) {
    return 'Linux command wrapper contains an invalid null character.';
  }

  try {
    const words = parseTemplateWords(template);
    const placeholderWords = words.filter((word) =>
      word.source.includes(LINUX_COMMAND_PLACEHOLDER)
    );
    const placeholderCount = placeholderWords.reduce(
      (count, word) => count + word.source.split(LINUX_COMMAND_PLACEHOLDER).length - 1,
      0
    );
    if (placeholderCount !== 1) {
      return `Linux command wrapper must contain exactly one standalone ${LINUX_COMMAND_PLACEHOLDER}.`;
    }
    if (placeholderWords[0].source !== LINUX_COMMAND_PLACEHOLDER) {
      return `Linux command wrapper requires ${LINUX_COMMAND_PLACEHOLDER} as a standalone argument.`;
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function validateLinuxCommandTemplate(value: unknown): string | null {
  if (typeof value !== 'string') return 'Linux command wrapper must be text.';
  return validateParsedTemplate(value);
}

export function expandLinuxCommandTemplate(
  template: string,
  command: string,
  args: readonly string[],
  environment: LaunchEnvironment
): ExpandedLinuxCommand {
  const validationError = validateParsedTemplate(template);
  if (validationError) throw new Error(validationError);
  if (!command) throw templateError('received an empty game command.');

  const expanded: string[] = [];
  for (const word of parseTemplateWords(template, environment)) {
    if (word.source === LINUX_COMMAND_PLACEHOLDER) {
      expanded.push(command, ...args);
    } else {
      expanded.push(word.value);
    }
  }
  if (!expanded[0]) throw templateError('expanded to an empty executable.');
  return { command: expanded[0], args: expanded.slice(1) };
}

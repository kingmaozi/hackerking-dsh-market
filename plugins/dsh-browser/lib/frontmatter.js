/**
 * Minimal YAML frontmatter reader for DSH skill packs.
 *
 * Only the fields the skill registry needs are read: name, description,
 * whenToUse, disable-model-invocation, user-invocable. Nested maps such as
 * `metadata:` are ignored. Block scalars (`|`, `>`, with chomping hints) are
 * supported because several upstream skills use them for descriptions.
 */

function stripQuotes(value) {
  const text = value.trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = text.slice(1, -1);
      return first === '"'
        ? inner.replaceAll('\\"', '"').replaceAll('\\\\', '\\')
        : inner.replaceAll("''", "'");
    }
  }
  return text;
}

function indentOf(line) {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 2;
    else break;
  }
  return width;
}

function parseBlock(lines, start, style, chomp) {
  const collected = [];
  let index = start;
  let minIndent = Number.POSITIVE_INFINITY;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') {
      collected.push('');
      continue;
    }
    const indent = indentOf(line);
    if (indent === 0) break;
    minIndent = Math.min(minIndent, indent);
    collected.push(line);
  }
  const trimmed = collected.map((line) => (line === '' ? '' : line.slice(minIndent)));
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();
  const text = style === '|' ? trimmed.join('\n') : trimmed.join(' ').replace(/\s+/g, ' ').trim();
  if (chomp === '-') return { value: text.replace(/\n+$/u, ''), next: index };
  if (chomp === '+') return { value: `${text}\n`, next: index };
  return { value: text, next: index };
}

function parseTopLevel(lines) {
  const data = Object.create(null);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      index += 1;
      continue;
    }
    if (indentOf(line) > 0) {
      index += 1;
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):(.*)$/u.exec(line);
    if (match === null) {
      index += 1;
      continue;
    }
    const key = match[1];
    const rest = match[2].trim();
    index += 1;

    if (rest === '' || rest === '|' || rest === '>' || /^[|>][+-]?$/u.test(rest)) {
      const style = rest.startsWith('|') ? '|' : rest.startsWith('>') ? '>' : '';
      const chomp = rest.slice(1) || '';
      if (style === '') {
        // Plain nested map or list: skip its indented body.
        while (index < lines.length && (lines[index].trim() === '' || indentOf(lines[index]) > 0)) index += 1;
        data[key] = '';
      } else {
        const block = parseBlock(lines, index, style, chomp);
        data[key] = block.value;
        index = block.next;
      }
      continue;
    }

    if (rest.startsWith('[') || rest.startsWith('{')) {
      data[key] = rest;
      continue;
    }

    data[key] = stripQuotes(rest);
    // Fold indented continuation lines of a plain scalar.
    const continuation = [];
    while (index < lines.length && lines[index].trim() !== '' && indentOf(lines[index]) > 0) {
      continuation.push(lines[index].trim());
      index += 1;
    }
    if (continuation.length > 0) data[key] = `${data[key]} ${continuation.join(' ')}`.trim();
  }
  return data;
}

/**
 * Split a SKILL.md into frontmatter data and body.
 * @param {string} raw file contents
 * @returns {{ data: Record<string, string>, body: string } | undefined}
 */
export function parseFrontmatter(raw) {
  let text = raw;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstBreak = text.indexOf('\n');
  if (firstBreak < 0) return undefined;
  if (text.slice(0, firstBreak).replace(/\r$/u, '') !== '---') return undefined;
  const lines = text.slice(firstBreak + 1).split('\n');
  let closing = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].replace(/\r$/u, '') === '---') {
      closing = index;
      break;
    }
  }
  if (closing < 0) return undefined;
  const data = parseTopLevel(lines.slice(0, closing));
  const body = lines.slice(closing + 1).join('\n').replace(/^\n+/u, '');
  return { data, body };
}

function booleanField(data, key) {
  if (!Object.hasOwn(data, key)) return undefined;
  const value = String(data[key]).trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(value)) return true;
  if (['false', 'no', 'off', '0'].includes(value)) return false;
  throw new TypeError(`frontmatter field "${key}" must be a boolean`);
}

/**
 * Parse one skill file into the fields the provider needs.
 * @param {string} raw file contents
 */
export function parseSkill(raw) {
  const parsed = parseFrontmatter(raw);
  if (parsed === undefined) return undefined;
  const { data, body } = parsed;
  const skillName = typeof data.name === 'string' ? data.name.trim() : '';
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (skillName === '' || description === '') return undefined;
  const whenToUse = typeof data.whenToUse === 'string' ? data.whenToUse.trim() : undefined;
  const modelInvocable = booleanField(data, 'disable-model-invocation') !== true;
  const userInvocable = booleanField(data, 'user-invocable') !== false;
  return {
    name: skillName,
    description,
    ...(whenToUse === undefined || whenToUse === '' ? {} : { whenToUse }),
    invocation: { modelInvocable, userInvocable },
    content: body.trim(),
  };
}

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

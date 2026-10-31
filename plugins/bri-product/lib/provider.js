import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSkill, SKILL_NAME_PATTERN } from './frontmatter.js';

/**
 * Skill provider backed by one directory of `<name>/SKILL.md` bundles.
 * The provider is read-only; the registry asks for a catalog and later loads
 * one body by the locator discovered in that catalog.
 */
export class DirectorySkillProvider {
  /**
   * @param {{ logger: { warn: Function, debug?: Function }, providerName: string, skillDir: string, rank: number }} options
   */
  constructor(options) {
    this.name = options.providerName;
    this.skillDir = options.skillDir;
    this.rank = options.rank;
    this.logger = options.logger;
  }

  async list(lookup = {}) {
    lookup.signal?.throwIfAborted();
    let entries;
    try {
      entries = await readdir(this.skillDir, { withFileTypes: true, signal: lookup.signal });
    } catch (error) {
      const code = error?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        this.logger.warn(`[${this.name}] skill directory not found: ${this.skillDir}`);
        return [];
      }
      throw error;
    }

    const candidates = [];
    const seen = new Set();
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      lookup.signal?.throwIfAborted();
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.')) continue;
      const skillPath = join(this.skillDir, entry.name, 'SKILL.md');
      try {
        const info = await stat(skillPath);
        if (!info.isFile()) continue;
      } catch {
        continue;
      }

      let parsed;
      try {
        parsed = parseSkill(await readFile(skillPath, 'utf8'));
      } catch (error) {
        this.logger.warn(`[${this.name}] skip ${skillPath}: ${String(error)}`);
        continue;
      }
      if (parsed === undefined) {
        this.logger.warn(`[${this.name}] skip ${skillPath}: missing or invalid frontmatter`);
        continue;
      }
      if (!SKILL_NAME_PATTERN.test(parsed.name)) {
        this.logger.warn(`[${this.name}] skip ${skillPath}: invalid skill name "${parsed.name}"`);
        continue;
      }
      if (seen.has(parsed.name)) {
        this.logger.warn(`[${this.name}] skip ${skillPath}: duplicate skill name "${parsed.name}"`);
        continue;
      }
      seen.add(parsed.name);
      const directory = join(this.skillDir, entry.name);
      candidates.push({
        name: parsed.name,
        description: parsed.description,
        ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
        invocation: parsed.invocation,
        source: 'bundled',
        provider: this.name,
        rank: this.rank,
        locator: { path: skillPath, directory },
        resourceBase: { kind: 'directory', path: directory },
        path: skillPath,
      });
    }
    return candidates;
  }

  async get(candidate, lookup = {}) {
    lookup.signal?.throwIfAborted();
    const locator = candidate?.locator;
    if (locator?.path === undefined || locator?.directory === undefined) return undefined;

    let raw;
    try {
      raw = await readFile(locator.path, { encoding: 'utf8', signal: lookup.signal });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (error?.code === 'ENOENT') return undefined;
      this.logger.warn(`[${this.name}] get ${candidate.name}: read failed (${String(error?.code ?? error)})`);
      return undefined;
    }

    const parsed = parseSkill(raw);
    if (parsed === undefined) return undefined;
    if (parsed.name !== candidate.name) {
      this.logger.warn(`[${this.name}] get ${candidate.name}: name drift "${parsed.name}"`);
      return undefined;
    }

    return {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
      invocation: parsed.invocation,
      source: 'bundled',
      provider: this.name,
      resourceBase: { kind: 'directory', path: locator.directory },
      path: locator.path,
      content: parsed.content,
    };
  }
}

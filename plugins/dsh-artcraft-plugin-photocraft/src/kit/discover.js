/**
 * Locate a craft CLI on this machine.
 *
 * Search order is explicit and reported, because "the tool exists but the
 * binary was not found" is the single most likely failure a user hits:
 *   1. an explicit path written into `catalog/binaries.json` at install time,
 *   2. an explicit path in the plugin config,
 *   3. the craft's own environment variable (`GRIDCRAFT_CLI`, …),
 *   4. the documented search directories, resolved against the plugin package,
 *      the session cwd and this kernel (so the workspace `crafts-bin/` is found
 *      from wherever the plugin is loaded),
 *   5. `PATH`.
 * @module @dsh-artcraft/craft-kit/discover
 */

import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
                                                           

/**
 * True when `path` is an executable regular file (or a symlink to one).
 *
 * `X_OK` is a no-op on Windows — it succeeds for any file that exists — so on
 * that platform the name is additionally required to carry an executable
 * extension (`PATHEXT`), which stops a stray text file called
 * `gridcraft-cli` from being adopted as the binary.
 */
export function isExecutable(path        )          {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    if (process.platform === 'win32') {
      const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';').map(extension => extension.trim().toLowerCase()).filter(extension => extension.length > 0)
      const lower = path.toLowerCase()
      return extensions.some(extension => lower.endsWith(extension))
    }
    return true
  } catch {
    return false
  }
}

/** Every directory on `PATH`, in order, with quoting removed. */
function pathDirs()           {
  return (process.env.PATH ?? '')
    .split(delimiter)
    .map(entry => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(entry => entry.length > 0)
}

/** Directory holding this kernel (`<workspace>/dsh-plugins/craft-kit/src`). */
const kernelDir = dirname(fileURLToPath(import.meta.url))

/**
 * Where `scripts/install-craft.mjs` puts downloaded CLIs.
 *
 * This is the location that works for an installed plugin: the package may sit
 * in a profile's `node_modules` with no workspace around it, so the binary is
 * cached under the harness home instead. `DSH_ARTCRAFT_BIN_DIR` overrides it.
 */
function cacheDirs()           {
  const explicit = process.env.DSH_ARTCRAFT_BIN_DIR
  if (explicit !== undefined && explicit.length > 0) return [explicit]
  const roots = [process.env.DSH_HOME, join(homedir(), '.dsh'), join(homedir(), '.dsh-artcraft')]
    .filter((root)                 => typeof root === 'string' && root.length > 0)
  return [...new Set(roots.map(root => join(root, 'crafts', 'bin')))]
}

/**
 * Bases a relative search directory is resolved against.
 *
 * The plugin package root comes first: `<workspace>/dsh-plugins/plugin-x` and
 * `<workspace>/crafts-bin` are siblings, so `../crafts-bin` finds the
 * workspace's installed binaries no matter which directory the agent runs in.
 * @param packageRoot - the calling plugin's package root, when it has one.
 * @returns absolute bases, most specific first.
 */
function searchBases(packageRoot         )           {
  const bases = [
    ...packageRoot !== undefined ? [packageRoot, dirname(packageRoot)] : [],
    process.cwd(),
    // `<workspace>/dsh-plugins/craft-kit/src` → up three levels is the workspace.
    resolve(kernelDir, '..', '..', '..'),
    dirname(kernelDir),
  ]
  return [...new Set(bases)]
}

/** Absolute path recorded by `scripts/link-into-profile.mjs`, when present. */
function recordedBinary(profile              )                                               {
  for (const base of searchBases()) {
    const file = join(base, 'craft-kit', 'catalog', 'binaries.json')
    try {
      const parsed          = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) continue
      const entry = (parsed                           )[profile.id]
      if (typeof entry === 'string' && entry.length > 0) return { path: entry, source: 'craft-kit/catalog/binaries.json' }
    } catch {
      // No record at this base; keep looking.
    }
  }
  return undefined
}

/**
 * Candidate absolute paths for one craft binary, in priority order, with provenance.
 * @param profile - the craft to locate.
 * @param configured - explicit path from plugin configuration, if any.
 * @param packageRoot - the calling plugin's package root, when it has one.
 * @returns candidates in the order they will be tested.
 */
export function candidates(profile              , configured         , packageRoot         )                                     {
  const out                                     = []
  if (configured !== undefined && configured.length > 0) out.push({ path: configured, source: 'config.path' })
  const fromEnv = process.env[profile.envVar]
  if (fromEnv !== undefined && fromEnv.length > 0) out.push({ path: fromEnv, source: `env:${profile.envVar}` })
  for (const dir of cacheDirs()) out.push({ path: join(dir, platformBinaryName(profile)), source: `cache:${dir}` })
  const recorded = recordedBinary(profile)
  if (recorded !== undefined) out.push(recorded)
  const seen = new Set        ()
  for (const base of searchBases(packageRoot)) {
    for (const dir of profile.searchDirs) {
      const resolved = isAbsolute(dir) ? dir : resolve(base, dir)
      if (seen.has(resolved)) continue
      seen.add(resolved)
      // Windows installs the CLI as `<craft>-cli.exe`, so the platform's own
      // name has to be tried before the bare one; otherwise a workspace
      // `crafts-bin/` copy is never found there.
      for (const name of candidateNames(profile)) {
        out.push({ path: join(resolved, name), source: `search-dir:${resolved}` })
      }
    }
  }
  for (const dir of pathDirs()) {
    for (const name of candidateNames(profile)) {
      out.push({ path: join(dir, name), source: 'PATH' })
    }
  }
  return out
}

/**
 * Names a craft CLI may have on this platform, most likely first.
 *
 * Windows installs `<craft>-cli.exe`, so the extension is what a `PATH` or
 * `crafts-bin/` lookup has to try; `PATHEXT` is honoured rather than assumed
 * because a machine may have narrowed it. The bare name comes last, and only on
 * Windows, for a CLI a user renamed themselves.
 * @param profile - the craft being located.
 * @returns candidate file names, deduplicated.
 */
function candidateNames(profile              )           {
  if (process.platform !== 'win32') return [profile.bin]
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';').map(extension => extension.trim().toLowerCase()).filter(extension => extension.length > 0)
  return [...new Set([platformBinaryName(profile), ...extensions.map(extension => `${profile.bin}${extension}`), profile.bin])]
}

/** The CLI's executable name on this platform (`-cli.exe` on Windows). */
export function platformBinaryName(profile              )         {
  return process.platform === 'win32' ? `${profile.bin}.exe` : profile.bin
}

/**
 * Resolve the craft CLI for `profile`.
 * @param profile - the craft to locate.
 * @param configured - explicit path from plugin configuration, if any.
 * @param packageRoot - the calling plugin's package root, when it has one.
 * @returns the first executable candidate and its provenance, or `undefined`.
 */
export function discoverCraft(profile              , configured         , packageRoot         )                          {
  for (const candidate of candidates(profile, configured, packageRoot)) {
    if (isExecutable(candidate.path)) return { path: candidate.path, source: candidate.source }
  }
  return undefined
}

/** Cached `--version` output per resolved path; only successes are stored. */
const versionCache = new Map                ()

/**
 * Read a craft binary's version, tolerating CLIs that spell the flag
 * differently (`--version` and `version` are both in use).
 * @param path - absolute path to the CLI.
 * @param timeoutMs - hard cap on the probe; a slow binary yields `undefined`.
 * @returns the first non-empty line of version output, or `undefined`.
 */
export function craftVersion(path        , timeoutMs = 5000)                     {
  if (versionCache.has(path)) return versionCache.get(path)
  let version                    
  for (const flag of ['--version', 'version']) {
    try {
      const out = execFileSync(path, [flag], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })
      const line = out.split('\n').map(part => part.trim()).find(part => part.length > 0)
      if (line !== undefined) { version = line; break }
    } catch {
      // Try the next spelling; a missing flag is expected on some crafts.
    }
  }
  // Only a successful probe is cached. A binary that is mid-install, or that
  // had not been written when the previous call ran, must be retried rather
  // than remembered as version-less for the rest of the session.
  if (version !== undefined) versionCache.set(path, version)
  return version
}

/**
 * A ready-to-print diagnostic for a craft binary that could not be found.
 * @param profile - the craft that was searched for.
 * @param configured - explicit path from plugin configuration, if any.
 * @param packageRoot - the calling plugin's package root, when it has one.
 * @returns multi-line guidance naming every searched location.
 */
export function missingBinaryMessage(profile              , configured         , packageRoot         )         {
  const tried = candidates(profile, configured, packageRoot)
  const executable = `${profile.bin}${process.platform === 'win32' ? '.exe' : ''}`
  const example = process.platform === 'win32'
    ? `C:\\path\\to\\${executable}`
    : `/absolute/path/to/${executable}`
  const setEnv = process.platform === 'win32'
    ? `$env:${profile.envVar}="${example}"   (PowerShell;  set ${profile.envVar}=${example} in cmd.exe)`
    : `export ${profile.envVar}=${example}`
  const lines = [
    `${profile.product}: '${profile.bin}' was not found, so the ${profile.id} tools cannot run.`,
    `Searched, in order:`,
    ...tried.slice(0, 10).map(entry => `  - ${entry.path}  (${entry.source})`),
  ]
  lines.push(
    `Fix it by any of:`,
    `  - run \`node scripts/install-craft.mjs ${profile.id}\` (macOS, Windows and Linux)`,
    `  - set ${setEnv}`,
    `  - download the CLI from https://github.com/storytold/${profile.id}/releases/latest and put it on PATH`,
    `  - pass { "path": "${example.replace(/\\/g, '\\\\')}" } in this plugin's config`,
  )
  if (process.platform === 'win32') {
    lines.push(`The Windows build is the portable archive's \`${executable}\`; no Rust toolchain is needed.`)
  }
  return lines.join('\n')
}

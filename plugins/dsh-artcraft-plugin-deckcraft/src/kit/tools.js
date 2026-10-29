/**
 * Build the model-facing tool set for one craft.
 *
 * This module returns plain descriptors plus the `defineTool` option objects.
 * The calling plugin (which does import `@deepseek-ai/dsh-tools`) turns them
 * into registered tools; the kernel itself stays free of DSH runtime imports
 * so it can be exercised by the verifier and the MCP bridge too.
 * @module @dsh-artcraft/craft-kit/tools
 */

import { CraftMcpClient, renderSchema } from './mcp.js'
                                       
import { groupsOf, loadCatalog, score } from './catalog.js'
import { craftVersion, discoverCraft, missingBinaryMessage } from './discover.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_TIMEOUT_MS, buildRunArgv, runCraft } from './exec.js'
                                                  
                                                                                         

/**
 * Decide which document a run starts from.
 *
 * An explicit model choice always wins — `sample: true` means "start a new
 * document" even on crafts that would otherwise wait to be told. Only when the
 * model said nothing does the craft default apply: crafts whose document is a
 * real input start from their built-in sample, crafts that open documents
 * through commands (PdfCraft, PhotoCraft) get no source flag at all, and a
 * sample flag that requires a value is never invented.
 *
 * `sample: true` on a craft with no sample flag is an error rather than a
 * silent no-op, because the caller asked for something the craft cannot do.
 * @param profile - the craft being driven.
 * @param args - the model's tool arguments.
 * @returns the sample selection, or `undefined` to send no source flag.
 */
function resolveSample(profile              , args                         )                               {
  const requested = args.sample
  if (typeof requested === 'string' && requested.length > 0) return requested
  if (requested === true) {
    if (profile.run.sampleFlag.length === 0) {
      throw new Error(
        `${profile.product} has no "new document" flag: pass \`input\` to open an existing document, `
        + `or use a command such as file.new in \`commands\` to start one.`,
      )
    }
    return true
  }
  if (args.input !== undefined) return undefined
  const inputMode = profile.run.inputMode ?? (profile.run.inFlag.length > 0 ? 'flag' : 'none')
  if (inputMode === 'none') return undefined
  if (profile.run.sampleFlag.length === 0) return undefined
  if (profile.run.samples !== undefined) return undefined
  if (profile.run.newSampleValue !== undefined) return undefined
  return true
}

/**
 * Flags that must precede the subcommand.
 *
 * FilmCraft is the one craft that works this way: its script mode writes the
 * project with the global `--save-as FILE`, so `filmcraft-cli --save-as out.fcproj
 * run script.jsonl`. Without a `save` path the flag is omitted entirely — a
 * placeholder here would create a file literally named after it.
 * @param profile - the craft being driven.
 * @param args - the model's tool arguments.
 * @returns flags to place before the subcommand, possibly empty.
 */
function globalFlagsFor(profile              , args                         )           {
  const save = typeof args.save === 'string' && args.save.length > 0 ? args.save : undefined
  if (profile.run.scriptMode === true && profile.run.saveFlag.length > 0 && save !== undefined) {
    return [profile.run.saveFlag, save]
  }
  return []
}

/**
 * Pull the parameter grammar out of a craft's `describe` output.
 *
 * Crafts disagree on shape: SoundCraft and DesignCraft print `{"params": "…"}`,
 * so the JSON field wins when present and the raw text is used otherwise.
 * @param stdout - the describe command's stdout.
 * @returns the grammar, or `undefined` when the output declares none.
 */
function extractParams(stdout        )                     {
  const text = stdout.trim()
  if (text.length === 0) return undefined
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)                        
      if (typeof parsed.params === 'string' && parsed.params.length > 0) return parsed.params
    } catch {
      // Fall through to the line scan below.
    }
  }
  const match = /^\s*params:\s*(.+)$/m.exec(text)
  return match?.[1]?.trim()
}

/** Scratch directory for files the kernel generates per craft (script modes). */
function craftWorkDir(profile              )         {
  return join(tmpdir(), 'dsh-artcraft', profile.id)
}

/** Plugin configuration shared by every craft plugin. */
                                    
                                                             
               
                                                    
                    
     
                                                                           
                                                                             
                                                  
     
                               
                                                                   
                       
     
                                                                            
                                                                             
     
                     
                                                                                     
                    
 

/** Resolved runtime context shared by all tools of one craft. */
                               
                                
                                    
                                                                                     
                                   
                                                         
                       
                                                     
                                                                                          
     
                                                                 
                                                                            
     
                                   
                                                    
                 
 

/**
 * Build the shared runtime for one craft plugin instance.
 * @param profile - the craft to drive.
 * @param packageRoot - the plugin package root that may hold `catalog/<id>.json`.
 * @param config - plugin configuration.
 * @returns the runtime shared by every tool of this craft.
 */
export function createRuntime(profile              , packageRoot        , config                    = {})               {
  let catalogCache                                                                                                          
  let mcpClient                            
  return {
    profile,
    config,
    mcp()                             {
      if (config.enableMcp === false) return undefined
      if (profile.mcpArgs === undefined) return undefined
      const binary = this.binary()
      if (binary === undefined) return undefined
      // A CLI upgrade mid-session invalidates the running server.
      if (mcpClient !== undefined && !mcpClient.running && mcpClient.cachedTools !== undefined) mcpClient = undefined
      mcpClient ??= new CraftMcpClient(profile, binary, profile.mcpSessionArgs ?? [])
      return mcpClient
    },
    dispose()       {
      mcpClient?.close()
      mcpClient = undefined
    },
    binary()                          {
      const found = discoverCraft(profile, config.path, packageRoot)
      if (found === undefined) return undefined
      return { ...found, version: craftVersion(found.path) }
    },
    unavailable()         {
      return missingBinaryMessage(profile, config.path, packageRoot)
    },
    async catalog() {
      const binary = this.binary()
      const key = binary?.path ?? '(none)'
      if (catalogCache !== undefined && catalogCache.key === key) return catalogCache.value
      const loaded = await loadCatalog(profile, binary, packageRoot, config.timeoutMs ?? 30_000)
      const value = { commands: loaded.commands, origin: loaded.origin, ...loaded.note !== undefined ? { note: loaded.note } : {} }
      catalogCache = { key, value }
      return value
    },
  }
}

/** Render a finished run for both the model and the transcript. */
export function renderRun(result                , profile              )         {
  const parts           = []
  const head = `${profile.product} exited ${result.exitCode ?? `signal ${result.signal ?? '?'}`} in ${result.durationMs}ms`
  const body = [result.stdout.trim(), result.stderr.trim()].filter(part => part.length > 0).join('\n')
  parts.push(body.length > 0 ? `${body}\n${head}` : head)
  if (result.truncated) parts.push(`[output truncated at 256 KiB]`)
  return parts.join('\n')
}

/** Human-readable catalog listing, grouped by family. */
export function renderCatalog(
  profile              ,
  commands                         ,
  origin        ,
  limit        ,
  query         ,
)         {
  const needle = query?.trim().toLowerCase()
  let selected = commands
  if (needle !== undefined && needle.length > 0) {
    selected = commands
      .map(command => ({ command, weight: score(command, needle) }))
      .filter(entry => entry.weight > 0)
      .sort((a, b) => b.weight - a.weight || a.command.id.localeCompare(b.command.id))
      .map(entry => entry.command)
  }
  const shown = selected.slice(0, limit)
  const lines = [
    `${profile.product} command catalog (${origin}): ${selected.length}`
    + (selected.length > shown.length ? ` shown ${shown.length}` : '')
    + (needle !== undefined && needle.length > 0 ? ` matching ${JSON.stringify(query)}` : ''),
    `Families: ${groupsOf(commands).slice(0, 24).join(', ')}`,
    '',
  ]
  for (const command of shown) {
    const label = command.label !== undefined && command.label.length > 0 ? `  — ${command.label}` : ''
    const params = command.params !== undefined && command.params.length > 0 ? `\n      params: ${command.params}` : ''
    lines.push(`  ${command.id}${label}${params}`)
  }
  if (shown.length === 0) lines.push('  (no matching commands)')
  return lines.join('\n')
}

/** Every tool the craft contributes, as `defineTool`-ready descriptors. */
                               
                               
                                         
                                         
                                        
                                        
                                                         
                                          
                                        
                                            
 

/** One tool's definition: name/description/schema plus its executor. */
                                             
                  
                       
                              
                                              
                                                                      
 

/**
 * Normalize the model's `commands` argument into craft-agnostic pairs.
 * @param raw - the argument as supplied by the model.
 * @returns one { id, json } per entry, skipping anything unusable.
 */
function toCommandInputs(raw         )                      {
  if (!Array.isArray(raw)) return []
  const out                      = []
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      // A raw CLI string: split off the JSON argument if the model supplied one.
      const match = /^(\S+)\s+(.+)$/s.exec(entry.trim())
      if (match === null) { out.push({ id: entry.trim() }); continue }
      try {
        out.push({ id: match[1], json: JSON.parse(match[2]) })
      } catch {
        out.push({ id: match[1], json: match[2] })
      }
      continue
    }
    if (typeof entry === 'object' && entry !== null) {
      const record = entry                           
      const id = record.id
      if (typeof id !== 'string' || id.length === 0) continue
      const json = record.json ?? record.params ?? record.args
      out.push(json === undefined ? { id } : { id, json })
    }
  }
  return out
}

/** Read-only subcommand profile for the optional `inspect` tool. */
function readSpec(profile              , name        )                                                {
  const found = profile.reads?.find(read => read.name === name)
  return found === undefined ? undefined : { verb: found.verb, summary: found.summary }
}

/**
 * Build the complete tool set for one craft.
 * @param runtime - the craft runtime (profile + discovery + catalog).
 * @returns tool descriptors; `inspect`/`convert` are absent when the craft has no such verb.
 */
export function createToolSet(runtime              )               {
  const { profile, config } = runtime
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const catalogLimit = config.catalogLimit ?? 60

  /** Guard every tool: a missing binary is an answer, never a crash. */
  const requireBinary = ()              => {
    const binary = runtime.binary()
    if (binary === undefined) throw new Error(runtime.unavailable())
    return binary
  }

  /** One headless run of exactly one command, for crafts that cap it at one. */
  const runSingle = async (
    binary             ,
    input                    ,
    sample                              ,
    commands                              ,
  )                  => {
    const argv = buildRunArgv(profile, {
      ...input !== undefined ? { input } : {},
      ...sample !== undefined ? { sample } : {},
      commands,
    })
    return renderRun(await runCraft({ profile, binary, argv, cwd: process.cwd(), timeoutMs }), profile)
  }

  const session               = { commands: [], stale: false }

  /**
   * Commands to send for this call: the recorded history first when the craft
   * needs one process, then the caller's new commands. A failing call clears
   * the history so the next call starts from a clean document.
   */
  const withSession = (commands                              , reset         )                      => {
    if (profile.oneToolPerRun !== true) return [...commands]
    if (reset) session.commands = []
    const merged = [...session.commands, ...commands]
    session.commands = merged
    return merged
  }

  const run                  = {
    kind: 'run',
    name: `${profile.id}_run`,
    description:
      `Run ${profile.product} headlessly. Loads a document (or the built-in sample), applies an ordered list of `
      + `commands, and optionally writes the document and/or an exported artifact. `
      + `Use \`${profile.id}_commands\` first to discover command ids and their parameters: `
      + `each entry here is { "id": "<command id>", "json": <its parameters> }, where "json" is `
      + (profile.run.positionalKeyValues === true
        ? `a flat object of the command's own argument names, e.g. { "control": "light.exposure", "value": 0.7 }. `
        : `the command's parameter object, e.g. { "cell": "A1", "input": "x" }. `)
      + `${profile.blurb} Files: ${profile.extensions.join(', ')}.`,
    parameters: {
      input: { type: 'string', description: `Absolute or workspace-relative path to an existing ${profile.extensions[0]} document. Mutually exclusive with \`sample\`.` },
      commands: {
        type: 'array',
        description: 'Ordered commands to apply. Each is { "id": "cell.set", "json": { "cell": "A1", "input": "x" } }. An entry may also be a raw CLI string.',
        items: { type: 'json' },
      },
      ...(profile.run.saveMode ?? 'flag') === 'flag'
        ? { save: { type: 'string', description: `Path to write the edited document to (${profile.extensions.join('/')}).` } }
        : {},
      // `export` is always advertised when the craft can render one. Where the
      // craft writes documents and artifacts through the same flag (VectorCraft
      // `--export`), the executor folds `export` into `save`; the parameter is
      // still offered because naming the artifact is what a caller means, and
      // withholding it only pushes them to `extraArgs`.
      ...profile.run.exportFlag !== undefined
        ? { export: { type: 'string', description: 'Path to export a rendered artifact to (png/svg/pdf, or the app\'s native media type).' } }
        : {},
      ...profile.run.sampleFlag.length > 0
        ? {
            sample: profile.run.samples !== undefined
              ? { type: 'string', enum: [...profile.run.samples], description: 'Use a built-in sample document instead of `input`.' }
              : { type: 'boolean', description: 'Start from a new/empty document (the craft\'s own default template) instead of `input`.' },
          }
        : {},
      print: { type: 'boolean', description: 'Also print the resulting document state to stdout.' },
      extraArgs: { type: 'array', items: { type: 'string' }, description: 'Verbatim extra CLI arguments appended last, for flags this tool does not model.' },
      extraArgs: { type: 'array', items: { type: 'string' }, description: 'Verbatim extra CLI arguments appended last, for flags this tool does not model.' },
      ...profile.oneToolPerRun === true
        ? {
            resetSession: {
              type: 'boolean',
              description: `${profile.product} holds one document per process, so earlier commands are replayed to rebuild state. `
                + 'Set this to start a fresh document and drop that history.',
            },
          }
        : {},
    },
    async execute(args) {
      const binary = requireBinary()
      const input = typeof args.input === 'string' ? args.input : undefined
      // Sample semantics, in one place:
      //  - `sample: "<name>"` from the model is always honoured;
      //  - a craft whose document is its input (inputMode !== 'none') and whose
      //    sample flag takes no value defaults to that sample, so a call with
      //    no `input` starts from the built-in document rather than failing;
      //  - a craft with no sample flag (VectorCraft) starts blank, which is
      //    what its `run` does when given neither source;
      //  - a craft whose sample flag *requires* a value never defaults to it,
      //    because inventing that value would be a guess.
      const sample = resolveSample(profile, args)
      const requested = toCommandInputs(args.commands)
      const commands = withSession(requested, args.resetSession === true)
      // Crafts whose headless entry point only accepts a script file get one
      // written for this call; the file names the same commands the inline
      // style would have carried.
      if (profile.run.scriptFlag !== undefined) {
        const scriptPath = join(craftWorkDir(profile), `steps-${Date.now()}.json`)
        mkdirSync(dirname(scriptPath), { recursive: true })
        // PdfCraft's step file is `{tool, args}` per step; the shape is declared
        // by the craft, so the kernel keeps the JSON object form it accepts.
        writeFileSync(scriptPath, JSON.stringify(commands.map(command => ({
          tool: command.id,
          args: command.json ?? {},
        }))))
        const extra = [
          profile.run.scriptFlag, scriptPath,
          ...Array.isArray(args.extraArgs) ? args.extraArgs.filter((a)              => typeof a === 'string') : [],
        ]
        const result = await runCraft({ profile, binary, argv: [profile.run.verb, ...extra], cwd: process.cwd(), timeoutMs })
        return renderRun(result, profile)
      }
      if (profile.run.scriptMode === true) {
        const scriptPath = join(craftWorkDir(profile), `run-${Date.now()}.jsonl`)
        mkdirSync(dirname(scriptPath), { recursive: true })
        writeFileSync(scriptPath, commands.map(command =>
          JSON.stringify({ id: command.id, params: command.json ?? {} })).join('\n') + '\n')
        const extra = [
          ...input !== undefined ? [input] : [],
          scriptPath,
          ...Array.isArray(args.extraArgs) ? args.extraArgs.filter((a)              => typeof a === 'string') : [],
        ]
        const result = await runCraft({
          profile, binary,
          argv: [...globalFlagsFor(profile, args), profile.run.verb, ...extra],
          cwd: process.cwd(), timeoutMs,
        })
        return renderRun(result, profile)
      }
      // PdfCraft's `run` accepts exactly one tool per invocation; sending a
      // list would produce "expected key=value" from the CLI, so the extra
      // commands are reported instead of silently mis-executed.
      const [first, ...rest] = commands
      const single = profile.oneToolPerRun === true ? (first === undefined ? [] : [first]) : commands
      // PdfCraft accepts one tool per invocation, but a `--script` file runs a
      // whole list in a single process; the history recorded above is replayed
      // through that path, so a second call continues the same document.
      if (profile.oneToolPerRun === true && profile.run.scriptFlag === undefined && rest.length > 0) {
        const only = await runSingle(binary, input, sample, single)
        return `${only}\n\n[${profile.product} runs one tool per call: ${rest.length} further command(s) were not sent — ${rest.map(c => c.id).join(', ')}. Call this tool again for each.]`
      }
      const argv = buildRunArgv(profile, {
        ...input !== undefined ? { input } : {},
        ...sample !== undefined ? { sample } : {},
        commands: single,
        ...typeof args.save === 'string' ? { save: args.save } : {},
        // VectorCraft writes through one flag (`--export`); when a caller names
        // both, the artifact path is the one that must survive.
        ...typeof args.export === 'string' && profile.run.exportFlag !== profile.run.saveFlag
          ? { export: args.export }
          : typeof args.save !== 'string' && typeof args.export === 'string' && profile.run.exportFlag === profile.run.saveFlag
            ? { save: args.export }
            : {},
        ...args.print === true ? { print: true } : {},
        ...Array.isArray(args.extraArgs) ? { extra: args.extraArgs.filter((a)              => typeof a === 'string') } : {},
      })
      const result = await runCraft({ profile, binary, argv, cwd: process.cwd(), timeoutMs })
      return renderRun(result, profile)
    },
  }

  const commands                       = {
    kind: 'commands',
    name: `${profile.id}_commands`,
    description:
      `List or search ${profile.product}'s commands and their parameter grammar. `
      + `Call this before \`${profile.id}_run\` whenever you are unsure of a command id or its JSON shape.`,
    parameters: {
      search: { type: 'string', description: 'Free-text filter over command ids, labels and parameters (case-insensitive). Omit to list the catalog from the start.' },
      limit: { type: 'number', description: `Maximum commands to print (default ${catalogLimit}).` },
      group: { type: 'string', description: 'Only commands in this family, e.g. "insert", "cell", "slide", "mix".' },
    },
    async execute(args) {
      const catalog = await runtime.catalog()
      let selected = catalog.commands
      if (typeof args.group === 'string' && args.group.length > 0) {
        selected = selected.filter(command => (command.group ?? '') === args.group)
      }
      const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
        ? Math.min(Math.floor(args.limit), 500)
        : catalogLimit
      const header = catalog.note !== undefined ? `${catalog.note}\n\n` : ''
      const binary = runtime.binary()
      const where = binary === undefined ? `(${profile.bin} not installed)` : `${binary.path}${binary.version !== undefined ? ` ${binary.version}` : ''}`
      return `${header}${renderCatalog(profile, selected, catalog.origin, limit, typeof args.search === 'string' ? args.search : undefined)}\n\nbinary: ${where}`
    },
  }

  const describe                       = {
    kind: 'describe',
    name: `${profile.id}_describe`,
    description:
      `Look up one ${profile.product} command in full: its label, menu, and — most importantly — the exact JSON parameter `
      + `grammar it accepts. Use this when \`${profile.id}_commands\` showed a command you want but not enough detail to call it.`,
    parameters: {
      id: { type: 'string', required: true, description: 'Command id, e.g. "cell.set".' },
    },
    async execute(args) {
      const wanted = String(args.id ?? '').trim()
      if (wanted.length === 0) throw new Error('id is required')
      const catalog = await runtime.catalog()
      const command = catalog.commands.find(entry => entry.id === wanted)
        ?? catalog.commands.find(entry => entry.aliases?.includes(wanted) === true)
      if (command === undefined) {
        const near = catalog.commands
          .map(entry => ({ entry, weight: score(entry, wanted.toLowerCase()) }))
          .filter(candidate => candidate.weight > 0)
          .sort((a, b) => b.weight - a.weight)
          .slice(0, 8)
        return [
          `No command with id ${JSON.stringify(wanted)} in the ${profile.product} catalog (${catalog.commands.length} commands, ${catalog.origin}).`,
          near.length > 0 ? `Did you mean: ${near.map(candidate => candidate.entry.id).join(', ')}` : `Search with \`${profile.id}_commands\`.`,
        ].join('\n')
      }
      // Some crafts' `commands` table carries no parameter column, but their own
      // `describe <id>` does; ask for it rather than reporting "(none)".
      let params = command.params
      let paramsSource = ''
      if ((params === undefined || params.length === 0) && profile.describeArgs !== undefined) {
        const binary = runtime.binary()
        if (binary !== undefined) {
          const detail = await runCraft({
            profile, binary,
            argv: [...profile.describeArgs, command.id],
            cwd: process.cwd(), timeoutMs: Math.min(timeoutMs, 20_000),
          })
          const fetched = extractParams(detail.stdout)
          if (fetched !== undefined) { params = fetched; paramsSource = ' (from the CLI\'s describe)' }
        }
      }
      const lines = [
        `${command.id}${command.label !== undefined ? `  — ${command.label}` : ''}`,
        params !== undefined && params.length > 0 ? `params: ${params}${paramsSource}` : 'params: (none declared)',
      ]
      if (command.menu !== undefined && command.menu.length > 0) lines.push(`menu: ${command.menu.join(' ▸ ')}`)
      if (command.shortcut !== undefined && command.shortcut !== null) lines.push(`shortcut: ${command.shortcut}`)
      if (command.aliases !== undefined && command.aliases.length > 0) lines.push(`aliases: ${command.aliases.join(', ')}`)
      if (command.description !== undefined) lines.push(command.description)
      lines.push('', `Call it with \`${profile.id}_run\`: commands: [{ "id": ${JSON.stringify(command.id)}, "json": { … } }]`)
      return lines.join('\n')
    },
  }

  const inspectSpec = readSpec(profile, 'inspect')
  const inspect                                  = inspectSpec === undefined ? undefined : {
    kind: 'inspect',
    name: `${profile.id}_inspect`,
    description: `${inspectSpec.summary} Runs \`${profile.bin} ${inspectSpec.verb} <file>\` and returns its output. Read-only.`,
    parameters: {
      ...(inspectSpec.arg ?? 'file') === 'file'
        ? { file: { type: 'string', required: true, description: 'Path to the document to read.' } }
        : {},
      ...(inspectSpec.arg ?? 'file') === 'section'
        ? {
            section: { type: 'string', enum: ['project', 'sequence'], description: 'Which view to read (default project).' },
            project: { type: 'string', description: 'Project file to read, when the CLI needs one named explicitly.' },
          }
        : {},
      extraArgs: { type: 'array', items: { type: 'string' }, description: 'Verbatim extra CLI arguments appended last.' },
    },
    async execute(args) {
      const binary = requireBinary()
      const argMode = inspectSpec.arg ?? 'file'
      const file = String(args.file ?? '')
      if (argMode === 'file' && file.length === 0) throw new Error('file is required')
      const extra = Array.isArray(args.extraArgs) ? args.extraArgs.filter((a)              => typeof a === 'string') : []
      const argv = [inspectSpec.verb]
      if (argMode === 'file') argv.push(file)
      else if (argMode === 'section') argv.push(typeof args.section === 'string' && args.section.length > 0 ? args.section : inspectSpec.section ?? 'project')
      if (inspectSpec.projectFlag !== undefined && typeof args.project === 'string') argv.push(inspectSpec.projectFlag, args.project)
      argv.push(...inspectSpec.extraArgs ?? [], ...extra)
      const result = await runCraft({ profile, binary, argv, cwd: process.cwd(), timeoutMs })
      return renderRun(result, profile)
    },
  }

  const convert                                  = profile.reads?.some(read => read.name === 'convert') === true ? {
    kind: 'convert',
    name: `${profile.id}_convert`,
    description: `Convert a document between formats with \`${profile.bin} convert in out\`. The output format follows the output extension.`,
    parameters: {
      input: { type: 'string', required: true, description: 'Source document path.' },
      output: { type: 'string', required: true, description: 'Destination path; its extension selects the target format.' },
      extraArgs: { type: 'array', items: { type: 'string' }, description: 'Verbatim extra CLI arguments appended last.' },
    },
    async execute(args) {
      const binary = requireBinary()
      const extra = Array.isArray(args.extraArgs) ? args.extraArgs.filter((a)              => typeof a === 'string') : []
      const result = await runCraft({
        profile, binary,
        argv: ['convert', String(args.input ?? ''), String(args.output ?? ''), ...extra],
        cwd: process.cwd(), timeoutMs,
      })
      return renderRun(result, profile)
    },
  } : undefined

  const mcp = runtime.mcp()
  const idleMs = config.mcpIdleMs ?? 300_000

  const mcpTools                                   = mcp === undefined ? undefined : {
    kind: 'mcpTools',
    name: `${profile.id}_mcp_tools`,
    description:
      `${profile.product}'s own MCP server tools, each with a real JSON Schema. `
      + `These are the modelled operations (think \`write_range\`, \`render\`), whereas \`${profile.id}_run\` takes generic `
      + `command strings. Use this to discover them, then call one with \`${profile.id}_mcp_call\`. `
      + `Search by name or description; omit \`search\` to list everything.`,
    parameters: {
      search: { type: 'string', description: 'Case-insensitive filter over tool names and descriptions.' },
      limit: { type: 'number', description: 'Maximum tools to describe (default 30).' },
    },
    async execute(args) {
      const client = runtime.mcp()
      if (client === undefined) throw new Error(`${profile.product} has no MCP server configured`)
      await client.start(idleMs)
      const all = await client.listTools()
      const needle = typeof args.search === 'string' ? args.search.trim().toLowerCase() : ''
      const matched = needle.length === 0
        ? all
        : all.filter(tool => tool.name.toLowerCase().includes(needle) || (tool.description ?? '').toLowerCase().includes(needle))
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 200) : 30
      const shown = matched.slice(0, limit)
      const lines = [
        `${profile.product} MCP server — ${matched.length} tool(s)${needle.length > 0 ? ` matching ${JSON.stringify(args.search)}` : ''}`
        + (matched.length > shown.length ? `, showing ${shown.length}` : ''),
        `server: ${client.describe()}`,
        '',
      ]
      for (const tool of shown) {
        lines.push(`${tool.name}${tool.description !== undefined ? ` — ${tool.description}` : ''}`)
        lines.push(renderSchema(tool.inputSchema))
      }
      if (shown.length === 0) lines.push('(no matching tools)')
      return lines.join('\n')
    },
  }

  const mcpCall                                  = mcp === undefined ? undefined : {
    kind: 'mcpCall',
    name: `${profile.id}_mcp_call`,
    description:
      `Call one tool on ${profile.product}'s MCP server with JSON arguments. `
      + `Discover names and schemas with \`${profile.id}_mcp_tools\` first. `
      + `Use this for modelled operations; use \`${profile.id}_run\` for arbitrary command ids.`,
    parameters: {
      tool: { type: 'string', required: true, description: 'MCP tool name, exactly as listed.' },
      arguments: { type: 'object', additionalProperties: true, description: "The tool's arguments object; see its schema in the listing." },
    },
    async execute(args) {
      const client = runtime.mcp()
      if (client === undefined) throw new Error(`${profile.product} has no MCP server configured`)
      const name = String(args.tool ?? '').trim()
      if (name.length === 0) throw new Error('tool is required')
      await client.start(idleMs)
      if (client.cachedTools === undefined) await client.listTools()
      const declared = client.cachedTools?.find(tool => tool.name === name)
      if (declared === undefined) {
        const names = (client.cachedTools ?? []).map(tool => tool.name).slice(0, 20)
        return `No MCP tool named ${JSON.stringify(name)} on ${profile.product}. Known: ${names.join(', ')}`
      }
      const raw = args.arguments
      const params = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw                            : {}
      return await client.callTool(name, params)
    },
  }

  const mcpStatus                                    = mcp === undefined ? undefined : {
    kind: 'mcpStatus',
    name: `${profile.id}_mcp_status`,
    description: `Report whether ${profile.product}'s MCP bridge is running and how it was started. Diagnostics only.`,
    parameters: {},
    async execute() {
      const client = runtime.mcp()
      if (client === undefined) return `${profile.product}: no MCP server configured.`
      return [
        `${profile.product} MCP bridge`,
        `command: ${client.describe()}`,
        `running: ${client.running}`,
        `tools cached: ${client.cachedTools === undefined ? 'no' : client.cachedTools.length}`,
      ].join('\n')
    },
  }

  return {
    run, commands, describe,
    ...inspect !== undefined ? { inspect } : {},
    ...convert !== undefined ? { convert } : {},
    ...mcpTools !== undefined ? { mcpTools } : {},
    ...mcpCall !== undefined ? { mcpCall } : {},
    ...mcpStatus !== undefined ? { mcpStatus } : {},
  }
}


/** Prompt-section slot: after the built-in tool sections, app prose follows. */
export const CRAFT_SECTION_ORDER = 120

/**
 * The `defineTool` shape the kernel calls. Structurally typed so the kernel
 * itself needs no DSH import — the plugin passes the real implementation in.
 */
                                    
              
                     
                     
           
                   
                                                                              
   
                                                          
             

/** The `ctx` surface the kernel uses; kept structural for the same reason. */
                                     
                                                             
                          
                                                                                
   
                                                          
 

/**
 * Register every craft tool on `ctx.tools` and return a disposer.
 *
 * Plugin packages call this instead of hand-rolling a registration per tool, so
 * one place owns the contract: the harness's own `defineTool` is supplied by the
 * caller, the kernel attaches nothing global, releases the MCP server when the
 * plugin unloads, and adds the system-prompt section that tells the model the
 * tools exist.
 * @param ctx - the plugin's Cordis context.
 * @param options - the craft, the plugin package root, the config, and `defineTool`.
 * @returns a disposer that unregisters the tools and closes the MCP server.
 */
export function applyCraftPlugin(
  ctx                    ,
  options   
                                  
                                                                            
                                
                                       
                                                                                     
                                   
   ,
)             {
  const { profile, packageRoot, config = {}, defineTool } = options
  const runtime = createRuntime(profile, packageRoot, config)
  const tools = createToolSet(runtime)
  const disposers                 = []
  for (const spec of Object.values(tools)) {
    if (spec === undefined) continue
    disposers.push(ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: { type: 'string' },
        render: (_args         , value        ) => [{ type: 'text'         , text: value }],
      },
      async execute(args       ) {
        return await spec.execute(args                                      )
      },
    })))
  }
  ctx.systemPrompt.section({
    name: `artcraft:${profile.id}`,
    text: `${profile.product} is available through the ${profile.id}_* tools. `
      + `Documents are ${profile.extensions.join('/')}. `
      + `Discover operations with \`${profile.id}_commands\` (generic command ids) or `
      + `\`${profile.id}_mcp_tools\` (modelled operations with JSON schemas), read them back with `
      + `\`${profile.id}_inspect\`, and apply them with \`${profile.id}_run\` or \`${profile.id}_mcp_call\`.`,
    order: CRAFT_SECTION_ORDER,
  })
  return () => {
    for (const dispose of disposers) dispose()
    runtime.dispose()
  }
}

/**
 * Run a craft CLI headlessly and collect a bounded, structured result.
 *
 * The craft processes are ordinary external programs: this module deliberately
 * uses `node:child_process` rather than a harness capability seam so the same
 * code works from a Cordis plugin, the MCP bridge, the CLI and the tests.
 * @module @dsh-artcraft/craft-kit/exec
 */

import { spawn, spawnSync } from 'node:child_process'
                                                      
import { appendFileSync } from 'node:fs'
                                                                           

/**
 * Terminate a craft process and anything it started.
 *
 * Windows has no process groups and no signals, so `child.kill` reaches only
 * the direct child: a craft engine that spawned helpers would leave them
 * running. `taskkill /T` walks the child tree instead. Both steps are
 * best-effort, because by the time this runs the process may already be gone.
 * @param child - the process to terminate.
 */
export function killTree(child              )       {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill('SIGKILL')
  } catch {
    // Already exited.
  }
  // Re-check before taskkill: a recycled pid would otherwise be killed.
  if (process.platform !== 'win32' || child.pid === undefined || child.exitCode !== null) return
  try {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // taskkill is absent on some minimal images; the direct kill still ran.
  }
}

/** Default cap on captured stdout+stderr, so a runaway export cannot flood the model. */
export const MAX_CAPTURE_BYTES = 256 * 1024

/** Cap used for catalog reads, whose JSON is legitimately large (VectorCraft is ~350 KB). */
export const CATALOG_CAPTURE_BYTES = 16 * 1024 * 1024

/** Default wall-clock budget for one headless craft run. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Arguments accepted by {@link runCraft}. */
                                  
                                
                              
                                  
                      
                             
                               
                                                              
                                   
 

/**
 * Spawn a craft CLI, capture both streams, and settle on exit.
 *
 * Never rejects for a non-zero exit: the craft's own error text is the useful
 * result, so it is returned as `ok: false` with the raw output attached.
 * Rejects only when the process could not be spawned at all.
 * @param options - profile, resolved binary, argv, cwd, and limits.
 * @returns the structured run result.
 */
export async function runCraft(options                 )                          {
  const { profile, binary, argv, cwd } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const started = Date.now()
  const full = [...(profile.baseArgs ?? []), ...argv]
  const cap = options.maxCaptureBytes ?? MAX_CAPTURE_BYTES
  // DSH_ARTCRAFT_TRACE=<file> records every exact invocation, which is how a
  // craft whose CLI is picky about argument shape gets debugged without
  // guessing at what the plugin sent.
  if (process.env.DSH_ARTCRAFT_TRACE !== undefined) {
    try {
      appendFileSync(process.env.DSH_ARTCRAFT_TRACE, `${binary.path} ${full.map(a => JSON.stringify(a)).join(' ')}\n`)
    } catch {
      // Tracing must never break a run.
    }
  }

  return await new Promise                ((resolve, reject) => {
    const child = spawn(binary.path, full, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
      // Without this Windows flashes a console window for every craft run.
      windowsHide: true,
    })

    const stdout           = []
    const stderr           = []
    let captured = 0
    let truncated = false

    const collect = (sink          ) => (chunk        ) => {
      if (captured >= cap) { truncated = true; return }
      const room = cap - captured
      if (chunk.length > room) {
        sink.push(chunk.subarray(0, room))
        captured = cap
        truncated = true
      } else {
        sink.push(chunk)
        captured += chunk.length
      }
    }

    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)

    const onAbort = ()       => { killTree(child) }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const cleanup = ()       => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    child.on('error', (error) => {
      cleanup()
      reject(new Error(`${profile.product}: failed to start ${binary.path}: ${error.message}`))
    })

    child.on('close', (code, signal) => {
      cleanup()
      const out = Buffer.concat(stdout).toString('utf8')
      const err = Buffer.concat(stderr).toString('utf8')
      const tail = timedOut ? `\n[timed out after ${timeoutMs}ms]` : ''
      resolve({
        ok: code === 0 && !timedOut,
        bin: binary.path,
        argv: full,
        cwd,
        exitCode: code,
        signal,
        stdout: out,
        stderr: err + tail,
        truncated,
        durationMs: Date.now() - started,
        artifacts: [],
      })
    })
  })
}

/**
 * Compose the argv for one headless `run` invocation.
 *
 * Each craft spells "run these commands" differently — repeated `--cmd id=json`
 * (CADCraft, GridCraft), `--cmd id --params json` (PhotoCraft, VectorCraft),
 * positional `id key=value` (LightCraft, EffectCraft), or a JSON-lines script
 * file (FilmCraft). Profile fields select the spelling; this function owns the
 * assembly so every plugin behaves identically.
 * @param profile - the craft profile supplying flag spellings.
 * @param options - document source, commands, outputs and extras.
 * @returns the argv after the executable.
 */
export function buildRunArgv(
  profile              ,
  options   
                           
                                      
                                                    
                          
                            
                                    
                            
                                      
                                                  
                                            
   ,
)           {
  const spec = profile.run
  const inputMode = spec.inputMode ?? (spec.inFlag.length > 0 ? 'flag' : 'none')
  // Some crafts take project-level flags before the subcommand, not after.
  const argv           = [...options.globalFlags ?? [], spec.verb]
  // CADCraft takes the drawing as a positional argument to `run` itself.
  if (options.input !== undefined && inputMode === 'positional') argv.push(options.input)
  else if (options.input !== undefined && inputMode === 'flag' && spec.inFlag.length > 0) {
    argv.push(spec.inFlag, options.input)
  } else if (options.input === undefined && options.sample !== undefined && options.sample !== false) {
    if (spec.sampleFlag.length > 0) {
      argv.push(spec.sampleFlag)
      if (typeof options.sample === 'string') argv.push(options.sample)
      else if (spec.newSampleValue !== undefined) argv.push(spec.newSampleValue)
    }
  }
  for (const command of options.commands ?? []) {
    const style = spec.cmdStyle ?? 'flag'
    const json = command.json === undefined || command.json === null || command.json === '' ? undefined : command.json
    const jsonText = json === undefined ? undefined : typeof json === 'string' ? json : JSON.stringify(json)
    switch (style) {
      case 'flag':
        argv.push(spec.cmdFlag, formatCommand(command.id, json, spec.cmdSeparator))
        break
      case 'flag-params':
        argv.push(spec.cmdFlag, command.id)
        if (spec.cmdParamsFlag !== undefined && jsonText !== undefined) argv.push(spec.cmdParamsFlag, jsonText)
        break
      case 'positional-pair':
        argv.push(command.id)
        if (jsonText !== undefined) argv.push(jsonText)
        break
      case 'positional-kv':
        argv.push(command.id)
        for (const [key, value] of Object.entries(asRecord(json))) {
          argv.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
        }
        break
    }
  }
  if (options.save !== undefined && (spec.saveMode ?? 'flag') === 'flag') argv.push(spec.saveFlag, options.save)
  if (options.export !== undefined && spec.exportFlag !== undefined) argv.push(spec.exportFlag, options.export)
  if (options.exportAllPages !== undefined && spec.exportAllPagesFlag !== undefined) {
    argv.push(spec.exportAllPagesFlag, options.exportAllPages)
  }
  if (options.print === true && spec.printFlag !== undefined) argv.push(spec.printFlag)
  argv.push(...options.extra ?? [])
  return argv
}

/** One command to apply, before it is spelled for a particular CLI. */
                                    
                     
                         
 

/** Coerce a model-supplied JSON argument into a flat parameter map. */
function asRecord(value         )                          {
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed          = JSON.parse(value)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed                           
    } catch {
      return {}
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value                           
  return {}
}

/**
 * Normalize one model-supplied command into the CLI's `--cmd` value.
 *
 * The model writes `{ "id": "cell.set", "json": "{\"cell\":\"A1\"}" }` or a
 * bare id; the craft CLI wants `id={...}` on GridCraft and `id {...}` on
 * SoundCraft, so the separator comes from the profile.
 * @param id - command id.
 * @param json - optional JSON argument object.
 * @param separator - the craft's separator between id and JSON.
 * @returns the single argv value for `--cmd`.
 */
export function formatCommand(id        , json         , separator        )         {
  if (json === undefined || json === null || json === '') return id
  const text = typeof json === 'string' ? json : JSON.stringify(json)
  if (text.length === 0) return id
  return `${id}${separator}${text}`
}

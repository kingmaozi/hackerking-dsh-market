/**
 * PhotoCraft as a DSH plugin.
 *
 * Registers model-callable tools that drive the `photocraft-cli` binary this machine
 * already has — both its generic `--cmd` surface and its own MCP server. The
 * PhotoCraft source tree is never touched: the CLI is an external process, located
 * at call time so installing it mid-session works.
 *
 * The kernel under `./kit/` is generated from `dsh-plugins/craft-kit/src` by
 * `scripts/build-kit.mjs` and inlined so this package installs standalone.
 * @module dsh-artcraft-plugin-photocraft
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
                                                  
import { applyCraftPlugin, profileOf } from './kit/index.js'
                                                       
import { PLUGIN_ROOT } from './root.js'

export const name = 'dsh-artcraft-photocraft'
export const inject = ['tools', 'systemPrompt']

/** The craft this plugin exposes. */
export const craft = profileOf('photocraft')

/** Configuration is the shared craft config. */
                                      

export function apply(ctx         , config         = {})       {
  if (craft === undefined) throw new Error('dsh-artcraft-photocraft: profile "photocraft" is missing from the inlined kernel')
  // `ctx.effect` ties the registration and the MCP server to this plugin's fiber.
  ctx.effect(() => applyCraftPlugin(ctx, {
    profile: craft,
    packageRoot: PLUGIN_ROOT,
    config,
    defineTool: defineTool         ,
  }))
}

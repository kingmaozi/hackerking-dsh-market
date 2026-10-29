/**
 * GridCraft as a DSH plugin.
 *
 * Registers model-callable tools that drive the `gridcraft-cli` binary this machine
 * already has — both its generic `--cmd` surface and its own MCP server. The
 * GridCraft source tree is never touched: the CLI is an external process, located
 * at call time so installing it mid-session works.
 *
 * The kernel under `./kit/` is generated from `dsh-plugins/craft-kit/src` by
 * `scripts/build-kit.mjs` and inlined so this package installs standalone.
 * @module dsh-artcraft-plugin-gridcraft
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { applyCraftPlugin, profileOf } from './kit/index.js'
import type { CraftPluginConfig } from './kit/index.js'
import { PLUGIN_ROOT } from './root.ts'

export const name = 'dsh-artcraft-gridcraft'
export const inject = ['tools', 'systemPrompt']

/** The craft this plugin exposes. */
export const craft = profileOf('gridcraft')

/** Configuration is the shared craft config. */
export type Config = CraftPluginConfig

export function apply(ctx: Context, config: Config = {}): void {
  if (craft === undefined) throw new Error('dsh-artcraft-gridcraft: profile "gridcraft" is missing from the inlined kernel')
  // `ctx.effect` ties the registration and the MCP server to this plugin's fiber.
  ctx.effect(() => applyCraftPlugin(ctx, {
    profile: craft,
    packageRoot: PLUGIN_ROOT,
    config,
    defineTool: defineTool as never,
  }))
}

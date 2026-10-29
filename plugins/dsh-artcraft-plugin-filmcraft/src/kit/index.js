/**
 * The ArtCraft DSH plugin kernel.
 *
 * Import this from a plugin package that does the actual
 * `ctx.tools.register(defineTool(...))` calls; everything here is plain Node
 * so it can also run from the MCP bridge, the CLI verifier and unit tests.
 * @module @dsh-artcraft/craft-kit
 */

export * from './types.js'
export * from './discover.js'
export * from './exec.js'
export * from './catalog.js'
export * from './tools.js'
export * from './mcp.js'
export { CRAFT_PROFILES, CRAFTS_BIN_DIR, PROFILES_BY_ID, REPOS_DIR, profileOf } from './profiles.mjs'

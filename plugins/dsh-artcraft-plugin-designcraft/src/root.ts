/**
 * Resolve this plugin package's root directory at runtime.
 *
 * Kept in its own module so every craft plugin can share the same two lines
 * while the kernel stays free of `import.meta` path arithmetic.
 * @module @dsh-artcraft/plugin-designcraft/root
 */

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of this plugin package (`<root>/src/root.ts` → `<root>`). */
export const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

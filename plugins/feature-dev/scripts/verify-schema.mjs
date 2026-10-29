/**
 * verify-schema.mjs — check the role tool against DSH's own enforced schemas.
 *
 * The plugin cannot import `@deepseek-ai/dsh-tools` at runtime (DSH loads
 * plugins without resolving that package), so this check is opt-in: point
 * `DSH_TOOLS_DIR` at an extracted `@deepseek-ai/dsh-tools` package and run it.
 *
 *   DSH_TOOLS_DIR=/path/to/node_modules/@deepseek-ai/dsh-tools \
 *     node scripts/verify-schema.mjs
 *
 * It asserts the three things the tool runtime enforces at registration:
 *   1. `parameters` is a valid ParameterSchemaSpec (converted to wire JSON Schema)
 *   2. `output.schema` is inside the enforced JSON-Schema subset
 *   3. returned values validate against `output.schema`
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const toolsDir = process.env.DSH_TOOLS_DIR;
if (toolsDir === undefined || toolsDir.length === 0) {
  console.log('SKIP verify-schema: set DSH_TOOLS_DIR to an extracted @deepseek-ai/dsh-tools package');
  process.exit(0);
}

const base = pathToFileURL(resolve(toolsDir, 'lib/types')).href;
const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(`${base}/json-schema.js`);

const { createRoleTool } = await import('../lib/delegate.js');
const { buildRoles } = await import('../lib/roles.js');

const roles = buildRoles({});
const tool = createRoleTool({ ctx: { logger: { info() {}, warn() {} } }, config: {}, roles });

// DSH forwards `parameters` to providers verbatim, so it must already be wire JSON Schema.
assertSupportedJsonSchema(tool.parameters);
assertSupportedJsonSchema(tool.output.schema);

const valid = validateJsonSchemaValue(tool.parameters, { description: 'd', prompt: 'p', role: 'feature-dev-code' });
if (valid.length > 0) throw new Error(`valid args rejected: ${valid.join('; ')}`);

const missing = validateJsonSchemaValue(tool.parameters, { description: 'd' });
if (!missing.some((entry) => entry.includes('prompt'))) throw new Error('missing prompt not reported');

const badRole = validateJsonSchemaValue(tool.parameters, { description: 'd', prompt: 'p', role: 'nope' });
if (!badRole.some((entry) => entry.includes('role'))) throw new Error('bad role not reported');

const samples = [
  { kind: 'foreground', runId: 'child-1', output: [{ type: 'text', text: 'done' }] },
  { kind: 'background', jobId: 'job-1' },
  { kind: 'continuable', subagentId: 'sub-1' },
];
for (const sample of samples) {
  const violations = validateJsonSchemaValue(tool.output.schema, sample);
  if (violations.length > 0) throw new Error(`${sample.kind} output rejected: ${violations.join('; ')}`);
}

console.log('OK parameters wire schema, output schema subset, and all three output shapes');

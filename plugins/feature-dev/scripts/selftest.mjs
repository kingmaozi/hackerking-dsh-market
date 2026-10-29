import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectorySkillProvider } from '../lib/provider.js';
import { apply } from '../lib/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- skills ----
const provider = new DirectorySkillProvider({
  logger: { warn: (message) => console.error('WARN', message), debug: () => {} },
  providerName: 'feature-dev',
  skillDir: resolve(root, 'skills'),
  rank: 430,
});

const expected = [
  'feature-dev',
  'feature-dev-pr-review',
  'feature-dev-code',
  'feature-dev-architect',
  'feature-dev-review',
];

const candidates = await provider.list();
for (const name of expected) {
  if (!candidates.some((skill) => skill.name === name)) {
    console.error(`missing ${name}`);
    process.exit(1);
  }
}
if (candidates.length !== expected.length) {
  console.error(`unexpected skill count ${candidates.length}, expected ${expected.length}`);
  process.exit(1);
}
for (const candidate of candidates) {
  const loaded = await provider.get(candidate);
  if (loaded === undefined) {
    console.error(`failed to load ${candidate.name}`);
    process.exit(1);
  }
  if (typeof loaded.description !== 'string' || loaded.description.length < 20) {
    console.error(`weak description for ${candidate.name}`);
    process.exit(1);
  }
  if (loaded.content.length < 500) {
    console.error(`content too short for ${candidate.name}`);
    process.exit(1);
  }
}

// ------------------------------------------------------------ role tool ----
const registered = [];
let activationCount = 0;
const started = [];

const fakeActivation = () => {
  activationCount += 1;
  return {
    childId: `child-${activationCount}`,
    messageId: `msg-${activationCount}`,
    result: Promise.resolve({
      stopReason: 'completed',
      output: [{ type: 'text', text: `child ${activationCount} done` }],
    }),
    dispose: async () => {},
  };
};

const tools = {
  register(definition) {
    registered.push(definition);
    return () => {};
  },
};

const subagents = {
  getProvider(name) {
    if (name !== 'spawn') return undefined;
    return { name, capabilities: { agentOptions: true, depthLimit: true }, inheritsParentContext: false };
  },
  async startActivation(spec) {
    started.push(spec);
    return fakeActivation();
  },
};

const services = {
  skills: {
    registerProvider(create) {
      create({ signal: new AbortController().signal, invalidate() {} });
      return () => {};
    },
  },
  tools,
  subagents,
};

const ctx = {
  logger: { info: () => {}, warn: (m) => console.error('WARN', m), debug: () => {} },
  effect(fn) {
    return fn();
  },
  get(service) {
    return services[service];
  },
  ...services,
};

apply(ctx, {
  provider: 'king',
  model: 'gpt-6.1-sol',
  reasoningEffort: 'high',
  roles: {
    'feature-dev-code': { model: 'deepseek-v4.1-flash', reasoningEffort: 'max' },
    'feature-dev-review': { provider: 'king', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' },
  },
});

const tool = registered.find((definition) => definition.name === 'feature_dev_role');
if (tool === undefined) {
  console.error('role tool not registered');
  process.exit(1);
}
if (tool.parameters.type !== 'object' || !Array.isArray(tool.parameters.required)) {
  console.error('parameters must be wire JSON Schema (object root + required array)');
  process.exit(1);
}
for (const key of ['description', 'prompt', 'role', 'provider', 'model', 'reasoningEffort', 'run_in_background']) {
  if (tool.parameters.properties[key] === undefined) {
    console.error(`tool parameter missing: ${key}`);
    process.exit(1);
  }
}
// DSH rejects registration unless output is exactly { schema, render, presentationMeta? }.
if (typeof tool.output?.render !== 'function') {
  console.error('output.render must be a function (DSH register throws otherwise)');
  process.exit(1);
}
const rendered = tool.output.render({}, { kind: 'background', jobId: 'j1' });
if (!Array.isArray(rendered) || rendered[0]?.type !== 'text' || typeof rendered[0]?.text !== 'string') {
  console.error('output.render must return text content blocks', rendered);
  process.exit(1);
}
if (!Array.isArray(tool.parameters.properties.role.enum) || tool.parameters.properties.role.enum.length !== 4) {
  console.error('role enum must list the four roles');
  process.exit(1);
}

const parent = { id: 'parent-agent' };
const exec = { agent: parent, signal: new AbortController().signal };

// 1) role binding wins over plugin defaults
let result = await tool.execute({ description: 'code lane', prompt: 'do it', role: 'feature-dev-code' }, exec);
if (result.kind !== 'foreground' || result.output[0].text !== 'child 1 done') {
  console.error('foreground result shape wrong', result);
  process.exit(1);
}
let spec = started.at(-1);
if (spec.request.agentOptions.model !== 'deepseek-v4.1-flash'
  || spec.request.agentOptions.reasoningEffort !== 'max'
  || spec.request.agentOptions.provider !== 'king') {
  console.error('role binding not applied', spec.request.agentOptions);
  process.exit(1);
}
if (spec.delivery !== 'caller' || spec.request.parent !== parent) {
  console.error('foreground delivery/parent wrong', { delivery: spec.delivery, parent: spec.request.parent === parent });
  process.exit(1);
}

// 2) explicit call route wins over the role
await tool.execute({
  description: 'override',
  prompt: 'do it',
  role: 'feature-dev-code',
  provider: 'king',
  model: 'gpt-6.1-sol',
  reasoningEffort: 'low',
}, exec);
spec = started.at(-1);
if (spec.request.agentOptions.model !== 'gpt-6.1-sol' || spec.request.agentOptions.reasoningEffort !== 'low') {
  console.error('call override not applied', spec.request.agentOptions);
  process.exit(1);
}

// 3) background returns a job id
result = await tool.execute({ description: 'bg', prompt: 'x', role: 'feature-dev-architect', run_in_background: true }, exec);
if (result.kind !== 'background' || typeof result.jobId !== 'string') {
  console.error('background result wrong', result);
  process.exit(1);
}
if (started.at(-1).delivery !== 'parent') {
  console.error('background delivery must be parent');
  process.exit(1);
}
if (started.at(-1).request.agentOptions.model !== 'gpt-6.1-sol') {
  console.error('plugin default route not applied for architect', started.at(-1).request.agentOptions);
  process.exit(1);
}

// 4) unknown role is rejected
let rejected = false;
try {
  await tool.execute({ description: 'bad', prompt: 'x', role: 'nope' }, exec);
} catch {
  rejected = true;
}
if (!rejected) {
  console.error('unknown role must throw');
  process.exit(1);
}

// 5) provider without model is rejected
rejected = false;
try {
  await tool.execute({ description: 'bad', prompt: 'x', provider: 'king' }, exec);
} catch {
  rejected = true;
}
if (!rejected) {
  console.error('provider without model must throw');
  process.exit(1);
}

console.log(`OK ${candidates.length} skills; role tool routes resolved (${activationCount} activations)`);

/**
 * `feature_dev_role` — delegate one task to a role-bound subagent with an
 * explicit LLM route.
 *
 * This is the DSH counterpart of the ZCode agents' `model:` / `thoughtLevel:`
 * frontmatter: on ZCode each `agents/*.md` could pin its own provider, model and
 * thinking level; DSH expresses the same thing as AgentOptions on a subagent
 * activation. The tool is registered as a plain ToolDefinition object — no
 * `@deepseek-ai/*` import — so it mounts in any profile that exposes the
 * `tools` and `subagents` services.
 */
import { resolveRoute } from './roles.js';

const ERROR_PREFIX = 'feature-dev:';

/** DSH-flavoured JSON schema helpers (field-level `required: true`). */
const text = (description) => ({ type: 'string', description });

function parametersFor(roles) {
  const ids = Object.keys(roles);
  return {
    description: {
      type: 'string',
      required: true,
      description: 'A short (3-5 word) description of the delegated task, for display.',
    },
    prompt: {
      type: 'string',
      required: true,
      description:
        'The complete, self-contained task for the subagent. It does not share this conversation context, so inline the role brief, allowedFiles, acceptance and evidence requirements.',
    },
    role: {
      type: 'string',
      ...(ids.length > 0 ? { enum: ids } : {}),
      description:
        'Role id. Picks the role brief and, when configured, its provider/model/reasoningEffort. '
        + `Known roles: ${ids.join(', ')}.`,
    },
    provider: text('LLM provider override (optional). Wins over the role binding; must be supplied together with model.'),
    model: text('Model id override (optional). Wins over the role binding; must be supplied together with provider.'),
    reasoningEffort: text('Reasoning-effort override (optional). The adapter serving the route decides the allowed values.'),
    run_in_background: {
      type: 'boolean',
      description:
        'Run as a background job and return its id immediately. Defaults to false; collect with job_output or stop with job_kill.',
    },
  };
}

/**
 * Output schema uses the ENFORCED standard JSON-Schema subset shared by DSH
 * tool outputs (object `required` arrays, scalar `const`, no `type: 'json'`)
 * — not the parameter-spec dialect used by `parameters`, where `required` is a
 * per-field boolean.
 */
/**
 * Compile the DSH parameter-spec dialect into the standard JSON-Schema that the
 * tool runtime forwards to providers verbatim.
 *
 * DSH's registry (`schemaOf` / `piTool` / `input_schema`) passes `parameters`
 * through WITHOUT compiling the per-field `required: true` dialect, so a raw
 * `ctx.tools.register()` with dialect parameters hands the model a non-schema
 * object. Everything this tool registers must therefore already be wire JSON
 * Schema: object root, `required` array, scalar `enum`.
 */
function toWireParameters(spec) {
  const properties = {};
  const required = [];
  for (const [key, field] of Object.entries(spec)) {
    const node = { type: field.type };
    if (field.description !== undefined) node.description = field.description;
    if (field.enum !== undefined) node.enum = field.enum;
    if (field.items !== undefined) node.items = field.items;
    properties[key] = node;
    if (field.required === true) required.push(key);
  }
  return { type: 'object', additionalProperties: false, properties, required };
}

function outputSchema() {
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'runId', 'output'],
        properties: {
          kind: { type: 'string', const: 'foreground' },
          runId: { type: 'string' },
          output: { type: 'array' },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'jobId'],
        properties: {
          kind: { type: 'string', const: 'background' },
          jobId: { type: 'string' },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'subagentId'],
        properties: {
          kind: { type: 'string', const: 'continuable' },
          subagentId: { type: 'string' },
        },
      },
    ],
  };
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function stopReasonError(result) {
  const reason = result?.stopReason;
  if (reason === undefined || reason === 'completed') return undefined;
  const diagnostic = typeof result?.diagnostic === 'string' && result.diagnostic.length > 0
    ? `: ${result.diagnostic}`
    : '';
  return new Error(`${ERROR_PREFIX} 子代理未完成（stopReason=${String(reason)}）${diagnostic}`);
}

/**
 * Build the ToolDefinition for one plugin mount.
 * @param {object} options
 * @param {any} options.ctx            plugin context (tools + subagents services)
 * @param {object} options.config      plugin config
 * @param {Record<string, object>} options.roles resolved role table
 * @param {string} [options.toolName]  registered tool name
 * @param {string} [options.providerName] subagent transport provider (default `spawn`)
 */
export function createRoleTool(options) {
  const { ctx, config, roles } = options;
  const toolName = options.toolName ?? 'feature_dev_role';
  const providerName = options.providerName ?? 'spawn';
  const defaultRole = config.defaultRole;
  const continueAfterSettle = config.backgroundMode === 'continuable';

  return {
    name: toolName,
    description:
      'Delegate one self-contained task to a role-bound subagent and choose its LLM route. '
      + 'Route resolution: call arguments > role binding > plugin defaults > inherit the parent agent. '
      + 'The role brief lives in a skill; inline its body plus allowedFiles, acceptance and evidence requirements into `prompt`. '
      + 'Returns the child result in the foreground, or a job id when `run_in_background` is true.',
    parameters: toWireParameters(parametersFor(roles)),
    output: {
      schema: outputSchema(),
      render(_args, value) {
        if (value?.kind === 'foreground') {
          const body = textOf(value.output);
          return [{ type: 'text', text: body.length > 0 ? body : `[${toolName}] 子代理完成，无文本输出（runId=${value.runId}）` }];
        }
        if (value?.kind === 'continuable') {
          return [{ type: 'text', text: `[${toolName}] 子代理已在后台启动，可继续对话的 id：${value.subagentId}` }];
        }
        return [{ type: 'text', text: `[${toolName}] 子代理已在后台启动，job id：${value?.jobId ?? '(unknown)'}；用 job_output 收集结果。` }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec?.agent;
      if (parent === undefined || parent === null) {
        throw new Error(`${ERROR_PREFIX} 该工具需要调用方 agent（exec.agent 为空）`);
      }
      const subagents = ctx.get?.('subagents') ?? ctx.subagents;
      if (subagents === undefined || typeof subagents.startActivation !== 'function') {
        throw new Error(`${ERROR_PREFIX} 当前 profile 没有 subagents 服务，无法派单`);
      }
      const transport = subagents.getProvider?.(providerName);
      if (transport === undefined) {
        throw new Error(`${ERROR_PREFIX} subagent provider "${providerName}" 未注册`);
      }

      const roleId = typeof args.role === 'string' && args.role.length > 0 ? args.role : defaultRole;
      let role;
      if (roleId !== undefined) {
        role = roles[roleId];
        if (role === undefined) {
          throw new Error(`${ERROR_PREFIX} 未知角色 "${roleId}"；可用：${Object.keys(roles).join(', ')}`);
        }
      }

      const { route, layer, warnings } = resolveRoute({
        args,
        role,
        config,
        defaults: transport.agentRouteDefaults,
      });
      for (const warning of warnings) ctx.logger?.warn?.(warning);

      const hasRoute = route.provider !== undefined || route.model !== undefined;
      if (hasRoute && transport.capabilities?.agentOptions !== true) {
        throw new Error(
          `${ERROR_PREFIX} provider "${providerName}" 不支持 agentOptions，无法指定模型；` +
          '请换一个支持 agentOptions 的 subagent provider，或去掉角色模型绑定改用继承',
        );
      }

      const prompt = typeof args.prompt === 'string' ? args.prompt : String(args.prompt ?? '');
      if (prompt.trim().length === 0) {
        throw new Error(`${ERROR_PREFIX} prompt 不能为空`);
      }

      const request = {
        prompt: [{ type: 'text', text: prompt }],
        parent,
        ...(hasRoute || route.reasoningEffort !== undefined ? { agentOptions: route } : {}),
      };

      ctx.logger?.info?.(
        `[${toolName}] role=${roleId ?? '(none)'} layer=${layer} route=${JSON.stringify(route)} `
        + `skill=${role?.skill ?? '(none)'} background=${args.run_in_background === true}`,
      );

      if (args.run_in_background === true) {
        const activation = await subagents.startActivation({
          provider: providerName,
          label: args.description,
          request,
          signal: exec.signal,
          delivery: 'parent',
        });
        if (continueAfterSettle) return { kind: 'continuable', subagentId: String(activation.childId) };
        return { kind: 'background', jobId: String(activation.childId) };
      }

      const activation = await subagents.startActivation({
        provider: providerName,
        label: args.description,
        request,
        signal: exec.signal,
        delivery: 'caller',
      });
      try {
        const result = await activation.result;
        const error = stopReasonError(result);
        if (error !== undefined) throw error;
        return {
          kind: 'foreground',
          runId: String(activation.childId),
          output: Array.isArray(result?.output) ? result.output : [],
        };
      } finally {
        await Promise.resolve()
          .then(() => activation.dispose())
          .catch((error) => ctx.logger?.warn?.(`[${toolName}] dispose 失败：${String(error)}`));
      }
    },
  };
}

export const ROLE_TOOL_META = Object.freeze({ ERROR_PREFIX });

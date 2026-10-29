/**
 * Role table for feature-dev.
 *
 * Each role binds:
 *   - `skill`            the SKILL.md that carries this role's brief
 *   - `provider/model`   optional LLM route (route owner: plugin config > role)
 *   - `reasoningEffort`  optional reasoning tier for that route
 *
 * Resolution order (matches dsh-plugin-subagent-director, minus its settings UI):
 *   call arguments  >  role binding  >  plugin defaults  >  inherit the parent agent
 *
 * A route only takes effect when the deployment's
 * `subagent-model-selection.allowedModels` admits it; an unlisted route is
 * dropped by the core and the child inherits the parent model. Keep the
 * allow-list in `cordis.patch.yml` in sync with the role bindings.
 */

export const DEFAULT_ROLES = Object.freeze({
  'feature-dev-code': {
    skill: 'feature-dev-code',
    summary: '复杂本机实现、诊断与真实验证（implementation / verification-only / exploration 三模式）',
  },
  'feature-dev-architect': {
    skill: 'feature-dev-architect',
    summary: '只读架构：公共契约、数据流与文件级任务切分',
  },
  'feature-dev-review': {
    skill: 'feature-dev-review',
    summary: '独立只读审查：severity + confidence ≥ 80，验收缺口单列',
  },
  'feature-dev-pr-review': {
    skill: 'feature-dev-pr-review',
    summary: 'PR 级审查：冻结 repo/PR/base/head 后只读取证，默认只聊天报告',
  },
});

const ROUTE_FIELDS = ['provider', 'model', 'reasoningEffort'];

function isEmpty(value) {
  return value === undefined || value === null || value === '';
}

function routeOf(source) {
  const out = {};
  for (const field of ROUTE_FIELDS) {
    if (!isEmpty(source?.[field])) out[field] = source[field];
  }
  return out;
}

/**
 * Merge the built-in roles with `config.roles`.
 * User entries may add new roles or override just the route of an existing one.
 * @param {object} config plugin config (from the bundle patch)
 */
export function buildRoles(config = {}) {
  const roles = {};
  for (const [id, role] of Object.entries(DEFAULT_ROLES)) {
    roles[id] = { ...role };
  }
  const overrides = config.roles ?? {};
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('[feature-dev] config.roles must be an object keyed by role id');
  }
  for (const [id, override] of Object.entries(overrides)) {
    if (override === null || typeof override !== 'object' || Array.isArray(override)) {
      throw new Error(`[feature-dev] config.roles.${id} must be an object`);
    }
    roles[id] = { ...(roles[id] ?? { skill: id }), ...override };
  }
  for (const [id, role] of Object.entries(roles)) {
    if (typeof role.skill !== 'string' || role.skill.length === 0) {
      throw new Error(`[feature-dev] role "${id}" must declare a skill name`);
    }
    for (const field of ROUTE_FIELDS) {
      if (role[field] !== undefined && typeof role[field] !== 'string') {
        throw new Error(`[feature-dev] role "${id}".${field} must be a string`);
      }
    }
  }
  return roles;
}

/**
 * Resolve one delegation request's LLM route.
 * @param {object} input
 * @param {object} input.args    model-supplied tool arguments
 * @param {object} input.role    resolved role binding (may be undefined)
 * @param {object} input.config  plugin config
 * @param {object} [input.defaults] provider-owned route defaults
 * @returns {{ route: {provider?: string, model?: string, reasoningEffort?: string}, layer: string, warnings: string[] }}
 */
export function resolveRoute({ args = {}, role, config = {}, defaults }) {
  const warnings = [];
  const call = routeOf(args);
  const roleRoute = routeOf(role);
  const pluginRoute = routeOf(config);
  const inheritedRoute = routeOf(defaults);

  if (!isEmpty(call.provider) !== !isEmpty(call.model)) {
    throw new Error('[feature-dev] provider 与 model 必须成对提供（一个 route 由两者共同构成）');
  }

  const route = {};
  let layer = 'inherit';
  for (const field of ROUTE_FIELDS) {
    const value = call[field] ?? roleRoute[field] ?? pluginRoute[field] ?? inheritedRoute[field];
    if (value !== undefined) route[field] = value;
  }
  if (Object.keys(call).length > 0) layer = 'call';
  else if (Object.keys(roleRoute).length > 0) layer = 'role';
  else if (Object.keys(pluginRoute).length > 0) layer = 'plugin';
  else if (Object.keys(inheritedRoute).length > 0) layer = 'provider-default';

  if (isEmpty(route.provider) !== isEmpty(route.model)) {
    warnings.push('[feature-dev] 解析出的 route 只有 provider 或只有 model，已整体丢弃并继承主代理');
    delete route.provider;
    delete route.model;
  }
  if (Object.keys(route).length === 0) layer = 'inherit';
  return { route, layer, warnings };
}

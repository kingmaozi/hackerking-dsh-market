/**
 * 参数方言 → 标准 JSON Schema 的本地编译器 + 轻量校验器。
 *
 * 为什么要自己编：`ToolRuntime.register()` 不编译参数，`schemaOf()` 把
 * `definition.parameters` 原样投影给模型（`dsh-tools/lib/index.js` 的 `schemas()`），
 * 上游 provider 又把它当 `input_schema`/`parameters` 直接发给 API
 * （`dsh-llm-pi-ai` 的 `piTool()`、`dsh-llm-deepseek` 的 `input_schema: tool.parameters`）。
 * 也就是说：注册方必须自己交**标准 JSON Schema**，字段级 `required: true` 那种作者方言
 * 只有 `defineTool()` 会替你编译——而本插件刻意不 import 宿主内部包。
 *
 * 所以：工具表里继续用作者方言写（可读、和 DSH 文档一致），挂载时用 compileParams()
 * 编成标准子集，selftest 再拿真实 `parameterSchemaSpecToJsonSchema` 做等价断言。
 */

/**
 * 编译字段级参数方言。
 * @param {Record<string, any>} spec 形如 `{ x: { type: 'number', required: true } }`
 * @returns {{type:'object', properties:Record<string, any>, required?:string[]}}
 */
export function compileParams(spec) {
  const properties = {};
  const required = [];
  for (const [key, node] of Object.entries(spec ?? {})) {
    const { required: isRequired, ...rest } = node ?? {};
    if (isRequired === true) required.push(key);
    properties[key] = compileNode(rest);
  }
  const schema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

function compileNode(node) {
  const out = {};
  if (typeof node.description === 'string') out.description = node.description;
  if (typeof node.type === 'string') out.type = node.type;
  if (Array.isArray(node.enum)) out.enum = [...node.enum];
  if (node.properties !== undefined) {
    const nested = compileParams(node.properties);
    out.properties = nested.properties;
    if (nested.required !== undefined) out.required = nested.required;
  }
  if (node.items !== undefined) out.items = compileNode(node.items);
  return out;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(declared, actual) {
  if (declared === 'number') return actual === 'number' || actual === 'integer';
  return declared === actual;
}

/**
 * 最小参数校验器：required / type / enum（足够覆盖本插件的扁平参数表）。
 * @param {object} schema compileParams() 的产物
 * @param {any} args 模型给的参数
 * @param {string} [path] 递归前缀
 * @returns {string[]} 违规描述；空数组表示通过
 */
export function validateArgs(schema, args, path = '') {
  const violations = [];
  if (schema?.type === 'object') {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      violations.push(`${path || 'args'} must be an object`);
      return violations;
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(args, key) || args[key] === undefined) {
        violations.push(`${path}${path.length > 0 ? '.' : ''}${key} is required`);
      }
    }
    for (const [key, node] of Object.entries(schema.properties ?? {})) {
      if (!Object.hasOwn(args, key) || args[key] === undefined) continue;
      violations.push(...validateNode(node, args[key], `${path}${path.length > 0 ? '.' : ''}${key}`));
    }
  }
  return violations;
}

function validateNode(node, value, path) {
  const violations = [];
  if (node.type !== undefined && !matchesType(node.type, typeOf(value))) {
    violations.push(`${path} must be type ${node.type}`);
    return violations;
  }
  if (Array.isArray(node.enum) && !node.enum.includes(value)) {
    violations.push(`${path} must be one of ${node.enum.map((item) => JSON.stringify(item)).join(', ')}`);
  }
  if (node.type === 'object') violations.push(...validateArgs(node, value, path));
  if (node.type === 'array' && Array.isArray(value) && node.items !== undefined) {
    value.forEach((item, index) => violations.push(...validateNode(node.items, item, `${path}[${index}]`)));
  }
  return violations;
}

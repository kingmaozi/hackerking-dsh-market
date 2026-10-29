/** Inline local schema references, preserving constraints and literal data. */
export function inlineInputSchema(root) {
  const maps = new Set(['properties', 'patternProperties', 'dependentSchemas']);
  const arrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
  const children = new Set(['items', 'additionalProperties', 'unevaluatedProperties', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'additionalItems', 'unevaluatedItems']);
  let count = 0;
  function visit(schema, active = new Set()) {
    if (++count > 100000) throw new Error('schema expansion budget exceeded');
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return schema;
    if (typeof schema.$ref === 'string') {
      const ref = schema.$ref;
      if (ref.startsWith('#/') === false) throw new Error(`unsupported reference: ${ref}`);
      if (active.has(ref)) throw new Error(`recursive reference: ${ref}`);
      let target = root;
      for (const token of ref.slice(2).split('/')) {
        const k = decodeURIComponent(token).replaceAll('~1', '/').replaceAll('~0', '~');
        if (target == null || Object.hasOwn(target, k) === false) throw new Error(`missing reference: ${ref}`);
        target = target[k];
      }
      const expanded = visit(target, new Set(active).add(ref));
      const { $ref, ...siblings } = schema;
      if (Object.keys(siblings).length === 0) return expanded;
      return { allOf: [expanded, visit(siblings, active)] };
    }
    return Object.fromEntries(Object.entries(schema).flatMap(([k, v]) => {
      if (k === '$defs' || k === 'definitions') return [];
      if (maps.has(k)) return [[k, Object.fromEntries(Object.entries(v).map(([n, s]) => [n, visit(s, active)]))]];
      if (arrays.has(k)) return [[k, v.map(s => visit(s, active))]];
      if (children.has(k)) return [[k, Array.isArray(v) ? v.map(s => visit(s, active)) : visit(v, active)]];
      return [[k, v]];
    }));
  }
  return visit(root);
}

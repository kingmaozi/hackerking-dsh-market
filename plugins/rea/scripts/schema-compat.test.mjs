import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineInputSchema } from '../lib/schema-compat.js';
test('address_name chained refs and constraints survive without mutation', () => {
  const s = { type:'object', properties:{ address:{$ref:'#/$defs/a', description:'Address'} }, required:['address'], additionalProperties:false, $defs:{a:{$ref:'#/$defs/b'}, b:{type:'string', minLength:1}} };
  const before = structuredClone(s);
  const out = inlineInputSchema(s);
  assert.deepEqual(s, before);
  assert.equal(JSON.stringify(out).includes('"$ref"'), false);
  assert.deepEqual(out.properties.address, {allOf:[{type:'string',minLength:1},{description:'Address'}]});
  assert.deepEqual(out.required,['address']); assert.equal(out.additionalProperties,false);
});
test('literal ref/default/enum data is untouched', () => {
  const literal = {$ref:'#/not-a-schema', $defs:{test:true}};
  assert.deepEqual(inlineInputSchema({type:'object', default:literal, examples:[literal], enum:[literal]}), {type:'object',default:literal,examples:[literal],enum:[literal]});
});
test('pointer escaping and arrays', () => {
  assert.deepEqual(inlineInputSchema({type:'array',items:{$ref:'#/$defs/a~1b~0c'},$defs:{'a/b~c':{type:'number'}}}),{type:'array',items:{type:'number'}});
});
test('broken/external/recursive references fail closed', () => {
  assert.throws(()=>inlineInputSchema({$ref:'#/$defs/missing'}),/missing/);
  assert.throws(()=>inlineInputSchema({$ref:'https://example.org/schema'}),/unsupported/);
  assert.throws(()=>inlineInputSchema({$ref:'#/$defs/a',$defs:{a:{$ref:'#/$defs/a'}}}),/recursive/);
});
test('ref siblings are intersections rather than overwriting constraints', () => {
  assert.deepEqual(inlineInputSchema({$ref:'#/$defs/n',maximum:5,$defs:{n:{type:'number',maximum:10}}}),{allOf:[{type:'number',maximum:10},{maximum:5}]});
});

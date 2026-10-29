#!/usr/bin/env node
// Transparent stdio relay. Only tools/list inputSchema is normalized.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { inlineInputSchema } from './schema-compat.js';
const args = process.argv.slice(2);
if (args.length === 0) throw new Error('usage: node mcp-compat.js COMMAND [ARGS...]');
const child = spawn(args[0], args.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
let failed = false;
const pending = new Set();
const key = id => JSON.stringify(id);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
async function send(stream, text) {
  if (stream.write(text + '\n') === false) await new Promise(resolve => stream.once('drain', resolve));
}
(async () => {
  for await (const line of input) {
    try {
      const request = JSON.parse(line);
      if (request.method === 'tools/list' && Object.hasOwn(request, 'id')) pending.add(key(request.id));
    } catch { /* Upstream handles malformed client input. */ }
    await send(child.stdin, line);
  }
  child.stdin.end();
})().catch(fail);
(async () => {
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    let message;
    try { message = JSON.parse(line); } catch { throw new Error('upstream emitted non-JSON stdout'); }
    if (Object.hasOwn(message, 'id') && message.method === undefined && pending.delete(key(message.id)) && message.result?.tools) {
      try {
        message.result.tools = message.result.tools.map(tool => ({ ...tool, inputSchema: inlineInputSchema(tool.inputSchema) }));
      } catch (error) {
        message = { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: `REA input schema compatibility: ${error.message}` } };
      }
    }
    await send(process.stdout, JSON.stringify(message));
  }
})().catch(fail);
function fail(error) {
  if (failed) return;
  failed = true;
  console.error('[rea-compat]', error.message);
  input.close(); process.stdin.destroy(); child.kill(); process.exitCode = 1;
}
child.stdin.on('error', fail);
child.stdout.on('error', fail);
process.stdout.on('error', fail);
child.on('error', error => { fail(error); input.close(); process.stdin.destroy(); });
child.on('exit', (code, signal) => { input.close(); process.stdin.destroy(); process.exitCode = failed ? 1 : (code ?? (signal ? 1 : 0)); });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));

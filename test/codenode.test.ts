import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { bundleCode } from '../kit/code.ts';

/** Run generated jsCode the way n8n 2.40's JS task runner does: in a vm context, inside an async
 *  function, after the preamble the runner puts in front of every Code node (copied from
 *  @n8n/task-runner's createVmExecutableCode: Object.defineProperty is a no-op, constructors are
 *  frozen). Plain Node misses that: a bundle whose exports relied on defineProperty passed in plain
 *  Node and failed in real n8n. The runner's process-level hardening is not reproduced here. */
const N8N_HARDENING = [
  'globalThis.global = globalThis',
  'var module = { exports: {} }',
  'Object.getPrototypeOf = () => ({})',
  'Reflect.getPrototypeOf = () => ({})',
  'Object.setPrototypeOf = () => false',
  'Reflect.setPrototypeOf = () => false',
  'delete Error.prepareStackTrace',
  'delete Error.captureStackTrace',
  'Object.defineProperty(Error, "prepareStackTrace", { configurable: false, writable: false, value: undefined })',
  'Object.defineProperty(Error, "captureStackTrace", { configurable: false, writable: false, value: undefined })',
  'Object.defineProperty = () => ({})',
  'Object.defineProperties = () => ({})',
  '[Object, Function, Array, String, Number, Boolean, RegExp, Error, TypeError, RangeError, SyntaxError, ReferenceError, Promise, Symbol, Map, Set, WeakMap, WeakSet, Date, JSON, Math, Reflect, ArrayBuffer, DataView, Int8Array, Uint8Array, Float32Array, Float64Array].forEach((constructor) => { try { Object.freeze(constructor); } catch {} })',
];

async function runInN8nShape(jsCode: string, input: unknown[], nodes: Record<string, unknown[]> = {}) {
  const wrap = (arr: unknown[]) => arr.map((json) => ({ json }));
  const context = vm.createContext({
    $input: { all: () => wrap(input) },
    $: (name: string) => {
      if (!(name in nodes)) throw new Error(`node '${name}' has not been executed`);
      return { all: () => wrap(nodes[name]) };
    },
  });
  const code = [...N8N_HARDENING, `module.exports = async function VmCodeWrapper() {${jsCode}
}()`].join('; ');
  const out = await vm.runInContext(code, context, { timeout: 5000 });
  return JSON.parse(JSON.stringify(out)).map((i: { json: unknown }) => i.json);
}

test('a bundled module runs in the n8n shape, shared helper included', async () => {
  const js = bundleCode('code/normalize-ticket.ts');
  const [out] = await runInN8nShape(js, [{ body: { email: 'a@b.co', message: 'card 4111 1111 1111 1111' } }]);
  const ticket = (out as { ticket: { message_for_logs: string } }).ticket;
  assert.equal(ticket.message_for_logs, 'card [card ****1111]'); // redact() from code/lib was inlined
});

test('every module in code/ runs under the n8n sandbox hardening', async () => {
  const [routed] = await runInN8nShape(bundleCode('code/route-ticket.ts'), [{ valid: true, ticket: { subject: '', message: 'I want a refund', plan: 'standard' } }]);
  assert.equal((routed as { queue: string }).queue, 'billing');
  const [alert] = await runInN8nShape(bundleCode('code/format-error.ts'), [{ workflow: { name: 'wf' }, execution: { lastNodeExecuted: 'X', error: { message: 'boom <b>' } } }]);
  assert.match((alert as { text: string }).text, /<b>wf<\/b> failed[\s\S]*boom &lt;b&gt;/);
});

test('bundles are self-contained: no import or require left', () => {
  const js = bundleCode('code/format-error.ts');
  assert.doesNotMatch(js, /\bimport\s|require\(/);
  assert.match(js, /^\/\/ generated from code\/format-error\.ts/);
});

test('bundling is deterministic', () => {
  assert.equal(bundleCode('code/route-ticket.ts'), bundleCode('code/route-ticket.ts'));
});

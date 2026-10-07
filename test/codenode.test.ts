import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { bundleCode } from '../kit/code.ts';

/** Run generated jsCode the way n8n 2.x's JS task runner does: in a vm context, inside an async
 *  function, after the runner's hardening (Object.defineProperty is a no-op there and built-ins are
 *  frozen; copied from @n8n/task-runner's createVmExecutableCode). Plain Node misses that: a bundle
 *  whose exports rely on defineProperty passed here and failed in real n8n. */
const N8N_HARDENING = [
  'globalThis.global = globalThis',
  'var module = { exports: {} }',
  'Object.getPrototypeOf = () => ({})',
  'Reflect.getPrototypeOf = () => ({})',
  'Object.setPrototypeOf = () => false',
  'Reflect.setPrototypeOf = () => false',
  'Object.defineProperty = () => ({})',
  'Object.defineProperties = () => ({})',
  '[Object, Function, Array, String, Number, Boolean, RegExp, Error, Promise, Symbol, Map, Set, Date, JSON, Math, Reflect].forEach((c) => { try { Object.freeze(c); } catch {} })',
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

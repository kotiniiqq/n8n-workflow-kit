import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bundleCode } from '../kit/code.ts';

/** Run generated jsCode the way n8n does: inside an async function with $input and $ in scope. */
async function runInN8nShape(jsCode: string, input: unknown[], nodes: Record<string, unknown[]> = {}) {
  const wrap = (arr: unknown[]) => arr.map((json) => ({ json }));
  const $input = { all: () => wrap(input) };
  const $ = (name: string) => {
    if (!(name in nodes)) throw new Error(`node '${name}' has not been executed`);
    return { all: () => wrap(nodes[name]) };
  };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const out = await new AsyncFunction('$input', '$', jsCode)($input, $);
  return (out as Array<{ json: unknown }>).map((i) => i.json);
}

test('a bundled module runs in the n8n shape, shared helper included', async () => {
  const js = bundleCode('code/normalize-ticket.ts');
  const [out] = await runInN8nShape(js, [{ body: { email: 'a@b.co', message: 'card 4111 1111 1111 1111' } }]);
  const ticket = (out as { ticket: { message_for_logs: string } }).ticket;
  assert.equal(ticket.message_for_logs, 'card [card ****1111]'); // redact() from code/lib was inlined
});

test('bundles are self-contained: no import or require left', () => {
  const js = bundleCode('code/format-error.ts');
  assert.doesNotMatch(js, /\bimport\s|require\(/);
  assert.match(js, /^\/\/ generated from code\/format-error\.ts/);
});

test('bundling is deterministic', () => {
  assert.equal(bundleCode('code/route-ticket.ts'), bundleCode('code/route-ticket.ts'));
});

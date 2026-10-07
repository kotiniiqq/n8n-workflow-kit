import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { BuildError, build, finalize, resolveForEnvironment, stableId } from '../kit/build.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kit-build-'));

test('two builds of the same source are byte-identical', async () => {
  const [a, b] = [tmp(), tmp()];
  await build('staging', { outDir: a });
  await build('staging', { outDir: b });
  for (const f of fs.readdirSync(a)) {
    assert.equal(fs.readFileSync(path.join(a, f), 'utf8'), fs.readFileSync(path.join(b, f), 'utf8'), f);
  }
});

test('environments get their own credential ids and values; no build placeholder survives', async () => {
  const [stg] = (await build('staging', { outDir: tmp() })).filter((w) => w.name === 'support-intake');
  const [prd] = (await build('production', { outDir: tmp() })).filter((w) => w.name === 'support-intake');
  const text = (w: typeof stg) => JSON.stringify(w.json);
  assert.match(text(stg), /stgHelpdesk0001/);
  assert.match(text(prd), /prdHelpdesk0001/);
  assert.match(text(prd), /helpdesk\.example\.com/);
  assert.doesNotMatch(text(prd), /%%(cred|env):/);
});

test('every workflow but the error workflow points at it; ids are stable', async () => {
  const built = await build('staging', { outDir: tmp() });
  const byName = Object.fromEntries(built.map((w) => [w.name, w.json]));
  assert.equal(byName['support-intake'].settings.errorWorkflow, '%%workflow:error-alert%%');
  assert.equal(byName['error-alert'].settings.errorWorkflow, undefined);
  const webhook = byName['support-intake'].nodes.find((n) => n.name === 'Incoming Ticket')!;
  assert.equal(webhook.id, stableId('support-intake', 'Incoming Ticket'));
  assert.equal(webhook.webhookId, stableId('support-intake', 'Incoming Ticket', 'webhook'));
});

test('a missing credential mapping fails the build and names what is missing', () => {
  const json = finalize({ name: 'x', nodes: [{ name: 'A', type: 't', credentials: { api: { id: '%%cred:nope%%', name: 'nope' } } }], connections: {}, settings: {} });
  assert.throws(() => resolveForEnvironment(json, { url: '', apiKeyEnv: '', credentials: {}, values: {} }, 'staging'),
    (e: unknown) => e instanceof BuildError && /cred:nope/.test((e as Error).message));
});

test('values are escaped safely inside JSON strings', () => {
  const json = finalize({ name: 'x', nodes: [{ name: 'A', type: 't', parameters: { url: '%%env:u%%' } }], connections: {}, settings: {} });
  const out = resolveForEnvironment(json, { url: '', apiKeyEnv: '', credentials: {}, values: { u: 'a"b\\c' } }, 's');
  assert.equal(out.nodes[0].parameters.url, 'a"b\\c');
});

test('unknown environment is a clear error', async () => {
  await assert.rejects(build('qa', { outDir: tmp() }), /unknown environment 'qa'. Known: staging, production/);
});

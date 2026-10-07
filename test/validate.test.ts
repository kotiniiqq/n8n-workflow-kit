import assert from 'node:assert/strict';
import { test } from 'node:test';

import { finalize, listWorkflowSources, loadWorkflow, type WorkflowJson } from '../kit/build.ts';
import { secretsInBuild, validateAll, validateOne } from '../kit/validate.ts';

const webhook = (name = 'Hook', path = 'p') => ({ name, type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { httpMethod: 'POST', path } });
const code = (name: string, jsCode: string) => ({ name, type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 0], parameters: { jsCode } });
const wf = (nodes: any[], connections: any = {}, name = 'w'): WorkflowJson => finalize({ name, nodes, connections, settings: {} });
const rules = (issues: { rule: string }[]) => issues.map((i) => i.rule).sort();

test('the example workflows are clean', async () => {
  const all = await Promise.all(listWorkflowSources().map((f) => loadWorkflow(f)));
  assert.deepEqual(validateAll(all), []);
});

test('dangling connection', () => {
  const issues = validateOne(wf([webhook()], { Hook: { main: [[{ node: 'Ghost', type: 'main', index: 0 }]] } }));
  assert.ok(rules(issues).includes('connections'));
});

test('duplicate node names', () => {
  assert.ok(rules(validateOne(wf([webhook(), code('Hook', 'return [];')]))).includes('unique-names'));
});

test('no trigger', () => {
  assert.ok(rules(validateOne(wf([code('A', 'return [];')]))).includes('trigger'));
});

test('missing error workflow', () => {
  const json = wf([webhook()]);
  delete json.settings.errorWorkflow;
  assert.ok(rules(validateOne(json)).includes('error-workflow'));
});

test('literal credential id in source', () => {
  const n = { ...webhook(), credentials: { httpHeaderAuth: { id: 'AbC123xyz', name: 'helpdesk' } } };
  assert.ok(rules(validateOne(wf([n]))).includes('credential-ids'));
});

for (const [label, value] of [
  ['bearer', 'Bearer abcdefghijklmnopqrstuvwxyz123456'],
  ['openai-style key', 'sk-abcdefghijklmnopqrstuvwx'],
  ['query string key', 'https://api.example.com/x?api_key=abcdef123456'],
  ['telegram bot token', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawE'],
] as const) {
  test(`hardcoded secret: ${label}`, () => {
    const n = { ...webhook(), parameters: { ...webhook().parameters, headerValue: value } };
    assert.ok(rules(validateOne(wf([n]))).includes('secrets'));
  });
}

test('expressions and ordinary strings are not mistaken for secrets', () => {
  const n = { ...webhook(), parameters: { ...webhook().parameters, text: '={{ $json.token }}', url: 'https://api.example.com/v1/items?page=2' } };
  assert.ok(!rules(validateOne(wf([n]))).includes('secrets'));
});

test('Code node that does not compile', () => {
  const issues = validateOne(wf([webhook(), code('Broken', 'return [;')], { Hook: { main: [[{ node: 'Broken', type: 'main', index: 0 }]] } }));
  assert.ok(rules(issues).includes('code-compiles'));
});

test('top-level await and return are valid Code-node code', () => {
  const issues = validateOne(wf([webhook(), code('Ok', 'const r = await Promise.resolve(1);\nreturn [{ json: { r } }];')],
    { Hook: { main: [[{ node: 'Ok', type: 'main', index: 0 }]] } }));
  assert.ok(!rules(issues).includes('code-compiles'));
});

test('two workflows on the same webhook path', () => {
  const issues = validateAll([wf([webhook('A', 'same')], {}, 'one'), wf([webhook('B', 'same')], {}, 'two')]);
  assert.ok(rules(issues).includes('webhook-paths'));
});

test('secrets are also caught after environment values are filled in', () => {
  const w = { name: 'w', nodes: [{ name: 'Call', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://api.example.com/v1?api_key=abcd1234efgh5678' } }], connections: {}, settings: {} };
  assert.deepEqual(secretsInBuild(w as any, 'production').map((i) => i.message), ["parameter looks like a hardcoded key in a query string (environment 'production')"]);
  const stripe = { ...w, nodes: [{ ...w.nodes[0], parameters: { header: 'sk_live_' + 'a'.repeat(24) } }] };
  assert.equal(secretsInBuild(stripe as any, 'staging')[0].message, "parameter looks like a hardcoded stripe key (environment 'staging')");
});

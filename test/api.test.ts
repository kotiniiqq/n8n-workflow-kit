import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { N8nApi, N8nApiError } from '../kit/n8n-api.ts';
import { diff, normalize, same } from '../kit/normalize.ts';
import { startMockN8n, type MockN8n } from './mock-n8n.ts';

let mock: MockN8n;
let api: N8nApi;
before(async () => { mock = await startMockN8n({ pageSize: 2 }); api = new N8nApi(mock.url, mock.apiKey); });
after(() => mock.close());

const body = (name: string) => ({
  name,
  nodes: [{ id: 'n1', name: 'Hook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: name } }],
  connections: {},
  settings: { executionOrder: 'v1' },
});

test('create, save a draft, publish: the published version only changes on publish', async () => {
  const created = await api.createWorkflow(body('alpha'));
  assert.equal(created.active, false);
  const first = await api.publish(created.id, created.versionId!, 'v1 of alpha');
  assert.equal(first.activeVersion?.description, 'v1 of alpha');
  const draft = await api.saveDraft(created.id, { ...body('alpha'), settings: { executionOrder: 'v1', timezone: 'UTC' } });
  assert.notEqual(draft.versionId, draft.activeVersionId); // saved, not live
  const live = await api.publish(created.id, draft.versionId!, 'v2');
  assert.equal(live.activeVersionId, draft.versionId);
  assert.equal((await api.getWorkflow(created.id)).settings.timezone, 'UTC');
  assert.equal((await api.unpublish(created.id)).active, false);
});

test('the client strips fields the API would reject, and keeps every setting it accepts', async () => {
  const w = body('beta') as any;
  w.nodes[0].extendsCredential = 'x'; // stored by n8n on some nodes, rejected by the write schema
  const created = await api.createWorkflow({ ...w, id: 'x', active: true, tags: [], settings: { executionOrder: 'v1', redactionPolicy: 'all', madeUp: 1 } });
  assert.equal(created.name, 'beta');
  assert.deepEqual(created.settings, { executionOrder: 'v1', redactionPolicy: 'all' });
});

test('the mock is as strict as the real API about extra fields', async () => {
  const res = await fetch(`${mock.url}/api/v1/workflows`, {
    method: 'POST', headers: { 'X-N8N-API-KEY': mock.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ ...body('gamma'), active: true }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).message, /additional properties \(active\)/);
});

test('listing follows pagination', async () => {
  for (const n of ['p1', 'p2', 'p3', 'p4']) await api.createWorkflow(body(n));
  const names = (await api.listWorkflows()).map((w) => w.name);
  assert.ok(['p1', 'p2', 'p3', 'p4'].every((n) => names.includes(n)));
});

test('errors carry method, path, status and the server message', async () => {
  await assert.rejects(api.getWorkflow('nope'), (e: unknown) =>
    e instanceof N8nApiError && e.status === 404 && /GET \/workflows\/nope\?excludePinnedData=true -> 404: workflow nope not found/.test(e.message));
  await assert.rejects(new N8nApi(mock.url, 'wrong').listWorkflows(), (e: unknown) => (e as N8nApiError).status === 401);
});

test('two workflows with the same name are reported, not guessed', async () => {
  await api.createWorkflow(body('twin'));
  await api.createWorkflow(body('twin'));
  await assert.rejects(api.findByName('twin'), /2 workflows are named 'twin'/);
});

test('normalize ignores server-managed fields and positions, diff names what changed', () => {
  const a = { ...body('n'), id: 'x', active: true, versionId: 'v1', updatedAt: 't1' };
  const b = structuredClone({ ...body('n'), id: 'y', active: false, versionId: 'v9', updatedAt: 't2' });
  b.nodes[0].position = [500, 500];
  assert.ok(same(normalize(a), normalize(b)));
  b.nodes[0].parameters.path = 'changed';
  (b.nodes as Array<Record<string, unknown>>).push({ id: 'n2', name: 'Extra', type: 'n8n-nodes-base.set', typeVersion: 3, position: [0, 0], parameters: {} });
  assert.deepEqual(diff(normalize(a), normalize(b)), ["+ node 'Extra' (n8n-nodes-base.set)", "~ node 'Hook': parameters changed"]);
});

test('credentials compare by id: the server rewrites the name, a different id is a real change', () => {
  const withCred = (id: string, name: string) => {
    const w = body('c');
    (w.nodes[0] as Record<string, unknown>).credentials = { httpHeaderAuth: { id, name } };
    return w;
  };
  assert.ok(same(normalize(withCred('cred1', 'helpdesk-api')), normalize(withCred('cred1', 'Helpdesk (prod)'))));
  assert.deepEqual(diff(normalize(withCred('cred1', 'x')), normalize(withCred('cred2', 'x'))), ["~ node 'Hook': credentials changed"]);
});

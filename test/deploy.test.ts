import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { build, type Built } from '../kit/build.ts';
import { DeployError, DriftError, deploy, diffAgainstLive, needsPublishing, ordered, rollback, type DeployOptions } from '../kit/deploy.ts';
import { N8nApi } from '../kit/n8n-api.ts';
import { workflowRef } from '../kit/placeholders.ts';
import { startMockN8n, type MockN8n } from './mock-n8n.ts';

let mock: MockN8n;
let opts: DeployOptions;
let built: Built[];
let lines: string[];

beforeEach(async () => {
  mock = await startMockN8n();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-deploy-'));
  lines = [];
  opts = { env: 'staging', api: new N8nApi(mock.url, mock.apiKey), stateDir: path.join(dir, 'state'),
           backupDir: path.join(dir, 'backups'), log: (l) => lines.push(l) };
  built = await build('staging', { outDir: path.join(dir, 'dist') });
});
afterEach(() => mock.close());

const live = (name: string) => [...mock.store.values()].find((w) => w.name === name);
const writes = () => mock.requests.filter((r) => !r.startsWith('GET')).length;
const timeoutOf = (nodes: any[]) => nodes.find((n: any) => n.name === 'Create Helpdesk Ticket').parameters.options.timeout;
const withTimeout = (source: Built[], ms: number) => {
  const changed = structuredClone(source);
  changed.find((b) => b.name === 'support-intake')!.json.nodes.find((n) => n.name === 'Create Helpdesk Ticket')!.parameters.options.timeout = ms;
  return changed;
};

test('first deploy creates and publishes both, dependencies first, with the build fingerprint', async () => {
  const steps = await deploy(built, opts);
  assert.deepEqual(steps.map((s) => [s.workflow, s.action]), [['error-alert', 'create'], ['support-intake', 'create']]);
  const intake = live('support-intake');
  assert.equal(intake.settings.errorWorkflow, live('error-alert').id);
  assert.equal(intake.active, true);
  assert.equal(live('error-alert').active, true); // n8n 2.x runs only published error workflows
  assert.match(intake.activeVersion.description, /^n8n-workflow-kit build [0-9a-f]{16}$/);
  assert.doesNotMatch(JSON.stringify(intake), /%%/);
});

test('deploying the same build again changes nothing', async () => {
  await deploy(built, opts);
  const before = writes();
  const steps = await deploy(built, opts);
  assert.deepEqual(steps.map((s) => s.action), ['unchanged', 'unchanged']);
  assert.equal(writes(), before);
});

test('drift state lives on the server: another machine, with no local state, sees no false drift', async () => {
  await deploy(built, opts);
  fs.rmSync(opts.stateDir, { recursive: true, force: true });
  const steps = await deploy(built, opts);
  assert.deepEqual(steps.map((s) => s.action), ['unchanged', 'unchanged']);
});

test('a source change is saved as a draft, then published; never unpublished in between', async () => {
  await deploy(built, opts);
  const [, step] = await deploy(withTimeout(built, 20000), opts);
  assert.equal(step.action, 'update');
  assert.deepEqual(step.changes, ["~ node 'Create Helpdesk Ticket': parameters changed"]);
  assert.equal(timeoutOf(JSON.parse(fs.readFileSync(step.backup!, 'utf8')).nodes), 10000);
  assert.equal(timeoutOf(live('support-intake').activeVersion.nodes), 20000);
  assert.ok(!mock.requests.some((r) => /unpublish|deactivate/.test(r)));
  assert.ok(mock.requests.some((r) => /^PUT /.test(r)));
});

test('a failed publish leaves production on the previous version, and the next run finishes it', async () => {
  await deploy(built, opts);
  const id = live('support-intake').id;
  mock.failNext(`POST /api/v1/workflows/${id}/publish`, 409);
  await assert.rejects(deploy(withTimeout(built, 20000), opts), /409/);
  assert.equal(live('support-intake').active, true);
  assert.equal(timeoutOf(live('support-intake').activeVersion.nodes), 10000); // still the old version live
  const steps = await deploy(withTimeout(built, 20000), opts); // no --force needed
  assert.equal(steps.find((s) => s.workflow === 'support-intake')!.action, 'publish');
  assert.equal(timeoutOf(live('support-intake').activeVersion.nodes), 20000);
});

test('a failed save changes nothing live', async () => {
  await deploy(built, opts);
  mock.failNext('PUT /api/v1/workflows/', 500);
  await assert.rejects(deploy(withTimeout(built, 20000), opts), /500/);
  assert.equal(timeoutOf(live('support-intake').activeVersion.nodes), 10000);
  const [, step] = await deploy(withTimeout(built, 20000), opts);
  assert.equal(step.action, 'update');
});

test('an unpublished edit made in the n8n UI stops the deploy and says what changed', async () => {
  await deploy(built, opts);
  mock.editInUi(live('support-intake').id, (w) => {
    w.nodes.find((n: any) => n.name === 'Route Ticket').parameters.jsCode = 'return $input.all();';
  });
  const before = writes();
  await assert.rejects(deploy(built, opts), (e: unknown) =>
    e instanceof DriftError && e.workflow === 'support-intake' && /latest saved version differs[\s\S]*node 'Route Ticket': parameters changed/.test(e.message));
  assert.equal(writes(), before); // nothing written
});

test('an edit that was also published in the UI is drift too', async () => {
  await deploy(built, opts);
  mock.editInUi(live('support-intake').id, (w) => { w.nodes.find((n: any) => n.name === 'Valid?').parameters.extra = 1; }, { publish: true });
  await assert.rejects(deploy(built, opts), /published version was not deployed by this kit/);
});

test('publishing an older version from the history is drift', async () => {
  await deploy(built, opts);
  const id = live('support-intake').id;
  const firstPublished = live('support-intake').activeVersionId;
  await deploy(withTimeout(built, 20000), opts);
  mock.publishFromHistory(id, firstPublished);
  await assert.rejects(deploy(withTimeout(built, 20000), opts), /older version published from the history/);
});

test('moving nodes around in the UI is not drift', async () => {
  await deploy(built, opts);
  mock.editInUi(live('support-intake').id, (w) => { w.nodes[0].position = [999, 999]; });
  const steps = await deploy(built, opts);
  assert.deepEqual(steps.map((s) => s.action), ['unchanged', 'unchanged']);
});

test('--force overwrites a UI edit, keeping it in a backup', async () => {
  await deploy(built, opts);
  mock.editInUi(live('support-intake').id, (w) => { w.nodes.find((n: any) => n.name === 'Valid?').parameters.extra = 1; });
  const [, step] = await deploy(built, { ...opts, force: true });
  assert.equal(step.action, 'update');
  assert.equal(JSON.parse(fs.readFileSync(step.backup!, 'utf8')).nodes.find((n: any) => n.name === 'Valid?').parameters.extra, 1);
  assert.equal(live('support-intake').activeVersion.nodes.find((n: any) => n.name === 'Valid?').parameters.extra, undefined);
});

test('a workflow that exists but was never deployed by the kit is not taken over silently', async () => {
  await opts.api.createWorkflow({ name: 'support-intake', nodes: [], connections: {}, settings: {} });
  await assert.rejects(deploy(built, opts), /never deployed by this kit/);
});

test('--force takes over a workflow that already matches: it is published with the fingerprint', async () => {
  await deploy(built, opts);
  const id = live('support-intake').id;
  await opts.api.unpublish(id); // e.g. switched off in the UI
  await assert.rejects(deploy(built, opts), DriftError);
  const steps = await deploy(built, { ...opts, force: true });
  assert.deepEqual(steps.map((s) => s.action), ['unchanged', 'publish']);
  assert.equal(live('support-intake').active, true);
  assert.deepEqual((await deploy(built, opts)).map((s) => s.action), ['unchanged', 'unchanged']);
});

test('backups leave out pinned and static data', async () => {
  await deploy(built, opts);
  mock.store.get(live('support-intake').id).pinData = { 'Incoming Ticket': [{ json: { email: 'real@customer.com' } }] };
  const [, step] = await deploy(withTimeout(built, 20000), opts);
  const saved = fs.readFileSync(step.backup!, 'utf8');
  assert.doesNotMatch(saved, /real@customer\.com|"pinData"|"staticData"/);
});

test('rollback restores the previous published version and re-arms drift detection', async () => {
  await deploy(built, opts);
  await deploy(withTimeout(built, 20000), opts);
  await rollback('support-intake', opts);
  assert.equal(timeoutOf(live('support-intake').activeVersion.nodes), 10000);
  assert.equal(live('support-intake').active, true);
  const steps = await deploy(built, opts); // source is the original again: nothing to do, no drift
  assert.deepEqual(steps.map((s) => s.action), ['unchanged', 'unchanged']);
});

test('rollback refuses to discard a UI edit; with --force the edit is backed up first', async () => {
  await deploy(built, opts);
  await deploy(withTimeout(built, 20000), opts);
  mock.editInUi(live('support-intake').id, (w) => { w.nodes.find((n: any) => n.name === 'Valid?').parameters.extra = 'ui edit'; });
  await assert.rejects(rollback('support-intake', opts), DriftError);
  await rollback('support-intake', { ...opts, force: true });
  const dir = path.join(opts.backupDir, 'staging', 'support-intake');
  const pre = fs.readdirSync(dir).filter((f) => f.includes('.pre-rollback'));
  assert.equal(pre.length, 1);
  assert.match(fs.readFileSync(path.join(dir, pre[0]), 'utf8'), /ui edit/);
});

test('dry run writes nothing', async () => {
  const steps = await deploy(built, { ...opts, dryRun: true });
  assert.deepEqual(steps.map((s) => s.action), ['create', 'create']);
  assert.equal(mock.store.size, 0);
});

test('a reference to a workflow that does not exist anywhere fails before any write', async () => {
  const intakeOnly = built.filter((b) => b.name === 'support-intake');
  await assert.rejects(deploy(intakeOnly, opts), (e: unknown) => e instanceof DeployError && /error-alert/.test((e as Error).message));
  assert.equal(mock.store.size, 0);
});

const hook = (name: string, extra: Record<string, unknown> = {}): Built => ({
  name, file: `${name}.json`,
  json: {
    name,
    nodes: [{ id: `${name}-1`, name: 'Hook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: name } }],
    connections: {}, settings: { executionOrder: 'v1', ...extra },
  },
});

test('workflows are deployed in dependency order, not alphabetically', async () => {
  const set = [hook('aa-main', { errorWorkflow: workflowRef('zz-sub') }), hook('zz-sub')];
  assert.deepEqual(ordered(set).map((b) => b.name), ['zz-sub', 'aa-main']);
  const steps = await deploy(set, opts);
  assert.deepEqual(steps.map((s) => [s.workflow, s.action]), [['zz-sub', 'create'], ['aa-main', 'create']]);
  assert.equal(live('aa-main').settings.errorWorkflow, live('zz-sub').id);
});

test('a reference cycle is refused before any write', async () => {
  const set = [hook('a', { errorWorkflow: workflowRef('b') }), hook('b', { errorWorkflow: workflowRef('a') })];
  await assert.rejects(deploy(set, opts), /cycle: a -> b -> a/);
  assert.equal(mock.store.size, 0);
});

test('deploying one workflow alone resolves the reference from the server', async () => {
  await deploy(built, opts);
  const [step] = await deploy(withTimeout(built, 30000).filter((b) => b.name === 'support-intake'), opts);
  assert.equal(step.action, 'update');
  assert.equal(live('support-intake').settings.errorWorkflow, live('error-alert').id);
});

test('deploying a subset does not report the rest as renamed', async () => {
  await deploy(built, opts);
  lines = [];
  await deploy(withTimeout(built, 30000).filter((b) => b.name === 'support-intake'), { ...opts, sourceNames: built.map((b) => b.name) });
  assert.ok(!lines.some((l) => l.startsWith('!')), lines.join('\n'));
});

test('a workflow renamed in the source is reported, never deleted', async () => {
  await deploy(built, opts);
  const renamed = structuredClone(built);
  renamed[1].json.name = 'support-intake-v2';
  renamed[1].name = 'support-intake-v2';
  renamed[1].json.nodes.find((n) => n.name === 'Incoming Ticket')!.parameters.path = 'support-intake-v2';
  await deploy(renamed, opts);
  assert.ok(lines.some((l) => /'support-intake' was deployed before but is not in the source/.test(l)));
  assert.ok(live('support-intake') && live('support-intake-v2'));
});

test('diff shows built vs live', async () => {
  assert.deepEqual(await diffAgainstLive(built, opts.api), { 'error-alert': ['not on the server yet'], 'support-intake': ['not on the server yet'] });
  await deploy(built, opts);
  assert.deepEqual(await diffAgainstLive(built, opts.api), { 'error-alert': [], 'support-intake': [] });
});

test('publishing: every trigger but the manual one; Respond to Webhook and disabled triggers do not count', () => {
  const wf = (...nodes: Array<Record<string, unknown>>) => ({ nodes });
  assert.equal(needsPublishing(wf({ type: 'n8n-nodes-base.errorTrigger' })), true);
  assert.equal(needsPublishing(wf({ type: 'n8n-nodes-base.executeWorkflowTrigger' })), true);
  assert.equal(needsPublishing(wf({ type: 'n8n-nodes-base.webhook' })), true);
  assert.equal(needsPublishing(wf({ type: 'n8n-nodes-base.manualTrigger' })), false);
  assert.equal(needsPublishing(wf({ type: 'n8n-nodes-base.manualTrigger' }, { type: 'n8n-nodes-base.respondToWebhook' })), false);
  assert.equal(needsPublishing(wf({ type: 'n8n-nodes-base.webhook', disabled: true })), false);
});

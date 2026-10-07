import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { build, type Built } from '../kit/build.ts';
import { DeployError, DriftError, deploy, diffAgainstLive, rollback, type DeployOptions } from '../kit/deploy.ts';
import { N8nApi } from '../kit/n8n-api.ts';
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

test('first deploy creates both, error workflow first, wires and activates', async () => {
  const steps = await deploy(built, opts);
  assert.deepEqual(steps.map((s) => [s.workflow, s.action]), [['error-alert', 'create'], ['support-intake', 'create']]);
  const intake = live('support-intake');
  assert.equal(intake.settings.errorWorkflow, live('error-alert').id);
  assert.equal(intake.active, true);                 // webhook trigger: activated
  assert.equal(live('error-alert').active, false);  // error trigger: runs without activation
  assert.doesNotMatch(JSON.stringify(intake), /%%/);
});

test('deploying the same build again changes nothing', async () => {
  await deploy(built, opts);
  const before = mock.requests.filter((r) => !r.startsWith('GET')).length;
  const steps = await deploy(built, opts);
  assert.deepEqual(steps.map((s) => s.action), ['unchanged', 'unchanged']);
  assert.equal(mock.requests.filter((r) => !r.startsWith('GET')).length, before);
});

test('a source change is deployed with a backup of the old version', async () => {
  await deploy(built, opts);
  const changed = structuredClone(built);
  changed[1].json.nodes.find((n) => n.name === 'Create Helpdesk Ticket')!.parameters.options.timeout = 20000;
  const [, step] = await deploy(changed, opts);
  assert.equal(step.action, 'update');
  assert.deepEqual(step.changes, ["~ node 'Create Helpdesk Ticket': parameters changed"]);
  const saved = JSON.parse(fs.readFileSync(step.backup!, 'utf8'));
  assert.equal(saved.nodes.find((n: any) => n.name === 'Create Helpdesk Ticket').parameters.options.timeout, 10000);
  assert.equal(live('support-intake').active, true);
});

test('an edit made in the n8n UI stops the deploy and says what changed', async () => {
  await deploy(built, opts);
  mock.editInUi(live('support-intake').id, (w) => {
    w.nodes.find((n: any) => n.name === 'Route Ticket').parameters.jsCode = 'return $input.all();';
  });
  const writesBefore = mock.requests.filter((r) => !r.startsWith('GET')).length;
  await assert.rejects(deploy(built, opts), (e: unknown) =>
    e instanceof DriftError && e.workflow === 'support-intake' && /node 'Route Ticket': parameters changed/.test(e.message));
  assert.equal(mock.requests.filter((r) => !r.startsWith('GET')).length, writesBefore); // nothing written
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
  assert.equal(live('support-intake').nodes.find((n: any) => n.name === 'Valid?').parameters.extra, undefined);
});

test('a workflow that exists but was never deployed by the kit is not taken over silently', async () => {
  await opts.api.createWorkflow({ name: 'support-intake', nodes: [], connections: {}, settings: {} });
  await assert.rejects(deploy(built, opts), /never deployed by this kit/);
});

test('rollback restores the previous version and re-arms drift detection', async () => {
  await deploy(built, opts);
  const changed = structuredClone(built);
  changed[1].json.nodes.find((n) => n.name === 'Create Helpdesk Ticket')!.parameters.options.timeout = 20000;
  await deploy(changed, opts);
  await rollback('support-intake', opts);
  const node = live('support-intake').nodes.find((n: any) => n.name === 'Create Helpdesk Ticket');
  assert.equal(node.parameters.options.timeout, 10000);
  assert.equal(live('support-intake').active, true);
  const steps = await deploy(built, opts); // source is the original again: nothing to do, no drift
  assert.deepEqual(steps.map((s) => s.action), ['unchanged', 'unchanged']);
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

test('deploying one workflow alone resolves the reference from the server', async () => {
  await deploy(built, opts);
  const changed = structuredClone(built.filter((b) => b.name === 'support-intake'));
  changed[0].json.nodes.find((n) => n.name === 'Create Helpdesk Ticket')!.parameters.options.timeout = 30000;
  const [step] = await deploy(changed, opts);
  assert.equal(step.action, 'update');
  assert.equal(live('support-intake').settings.errorWorkflow, live('error-alert').id);
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

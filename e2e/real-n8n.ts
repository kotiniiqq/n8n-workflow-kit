/** End-to-end check against a real n8n instance (environment "local" in environments.json).
 *
 * Needs: n8n on http://localhost:5678, an API key in N8N_API_KEY_LOCAL, and the two credentials
 * from e2e/credentials.json imported with their fixed ids (`n8n import:credentials`). The script
 * starts its own helpdesk + Telegram mock on :8787, so nothing leaves the machine.
 *
 *   npm run e2e
 *
 * It deploys with the kit, calls the production webhook, makes the helpdesk fail to fire the error
 * workflow, edits a workflow behind the kit's back to trigger drift detection, then forces a deploy
 * and rolls it back. The n8n instance should be a throwaway one: the script creates and changes
 * the workflows "support-intake" and "error-alert" there.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { build, loadEnvironments } from '../kit/build.ts';
import { deploy, DriftError, rollback, type DeployOptions } from '../kit/deploy.ts';
import { N8nApi, writable } from '../kit/n8n-api.ts';

const ENV = 'local';
const MOCK_PORT = 8787;
const FAIL_MARKER = 'E2E_HELPDESK_DOWN';

interface Received { path: string; headers: http.IncomingHttpHeaders; body: any }

function startMock(): Promise<{ received: Received[]; close: () => void }> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body: any = raw;
      try { body = JSON.parse(raw); } catch { /* telegram may send form data */ }
      received.push({ path: req.url ?? '', headers: req.headers, body });
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url === '/api/tickets') {
        if (req.headers.authorization !== 'Bearer local-helpdesk-token') return json(401, { error: 'bad token' });
        if (String(body?.message ?? '').includes(FAIL_MARKER)) return json(500, { error: 'helpdesk is down' });
        return json(201, { id: received.length });
      }
      if (/^\/bot[^/]+\/sendMessage$/.test(req.url ?? '')) {
        return json(200, { ok: true, result: { message_id: received.length, chat: { id: body?.chat_id }, text: body?.text } });
      }
      json(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, () => resolve({ received, close: () => server.close() })));
}

async function waitFor<T>(what: string, probe: () => T | undefined, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  const env = loadEnvironments()[ENV];
  const key = process.env[env.apiKeyEnv];
  if (!key) throw new Error(`set ${env.apiKeyEnv}`);
  const api = new N8nApi(env.url, key);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-kit-e2e-'));
  const opts: DeployOptions = { env: ENV, api, stateDir: path.join(work, 'state'), backupDir: path.join(work, 'backups'), force: true, log: () => {} };
  const mock = await startMock();
  const results: string[] = [];
  const pass = (line: string) => { results.push(line); console.log(`ok  ${line}`); };

  try {
    const built = await build(ENV, { outDir: path.join(work, 'dist') });

    // 1. first deploy takes over whatever is there (force), creates and activates
    const first = await deploy(built, opts);
    const intake = (await api.findByName('support-intake'))!;
    const alert = (await api.findByName('error-alert'))!;
    assert.ok(intake.active, 'support-intake is active');
    assert.equal(intake.settings.errorWorkflow, alert.id, 'errorWorkflow resolved to the live id');
    pass(`deploy: ${first.map((s) => `${s.workflow} ${s.action}`).join(', ')}; webhook active; errorWorkflow -> ${alert.id}`);

    // 2. redeploy of the same source is a no-op: the kit's normalization matches what n8n stores
    const second = await deploy(built, { ...opts, force: false });
    assert.deepEqual(second.map((s) => s.action), ['unchanged', 'unchanged'], JSON.stringify(second));
    pass('redeploy without changes: unchanged, unchanged (no false drift)');

    // 3. valid ticket: routed, created in the helpdesk with the credential, 202 back
    const webhook = `${env.url}/webhook/support-intake`;
    const post = (body: unknown) => fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let r = await post({ email: ' Anna@Example.com ', message: 'I was charged twice, card 4111 1111 1111 1111', plan: 'standard' });
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { status: 'accepted', queue: 'billing' });
    const ticket = mock.received.find((x) => x.path === '/api/tickets')!;
    assert.equal(ticket.body.email, 'anna@example.com');
    assert.equal(ticket.body.queue, 'billing');
    assert.equal(ticket.body.priority, 'high');
    assert.match(ticket.body.message_for_logs, /\[card \*\*\*\*1111\]/);
    pass('valid ticket: 202 {queue: billing}; helpdesk got the ticket with the Bearer credential, card redacted in message_for_logs');

    // 4. invalid ticket: 400 with the validation errors, helpdesk untouched
    const before = mock.received.length;
    r = await post({ email: 'nope', message: '' });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { status: 'invalid', errors: ['email is missing or invalid', 'message is empty'] });
    assert.equal(mock.received.length, before);
    pass('invalid ticket: 400 with both errors, nothing sent to the helpdesk');

    // 5. helpdesk fails -> the error workflow runs the bundled Format Error module and alerts Telegram
    r = await post({ email: 'bob@example.com', message: `server down ${FAIL_MARKER}` });
    assert.ok(r.status >= 500, `webhook status ${r.status}`);
    const sent = await waitFor('Telegram alert', () => mock.received.find((x) => x.path.endsWith('/sendMessage')));
    assert.equal(String(sent.body.chat_id), env.values.alertsChatId);
    assert.match(sent.body.text, /<b>support-intake<\/b> failed/);
    assert.match(sent.body.text, /Node: Create Helpdesk Ticket/);
    pass(`helpdesk 500: webhook ${r.status}; error-alert sent to Telegram: ${JSON.stringify(sent.body.text.split('\n').slice(0, 2).join(' | '))}`);

    // 6. someone edits the workflow in the UI -> the next deploy refuses and names the change
    const live = (await api.getWorkflow(intake.id));
    const edited = structuredClone(live);
    edited.nodes.find((n) => n.name === 'Create Helpdesk Ticket')!.parameters.options.timeout = 30000;
    await api.updateWorkflow(intake.id, writable(edited));
    await assert.rejects(deploy(built, { ...opts, force: false }), (err: unknown) => {
      assert.ok(err instanceof DriftError);
      assert.ok(err.changes.some((c) => c === "~ node 'Create Helpdesk Ticket': parameters changed"), err.changes.join('; '));
      return true;
    });
    pass("edit on the server: deploy stops with DriftError: ~ node 'Create Helpdesk Ticket': parameters changed");

    // 7. --force overwrites (backing the edit up), rollback brings the edit back
    const forced = await deploy(built, opts);
    const step = forced.find((s) => s.workflow === 'support-intake')!;
    assert.equal(step.action, 'update');
    assert.ok(step.backup && fs.existsSync(step.backup));
    const timeoutOf = async () => (await api.getWorkflow(intake.id)).nodes.find((n) => n.name === 'Create Helpdesk Ticket')!.parameters.options.timeout;
    assert.equal(await timeoutOf(), 10000);
    await rollback('support-intake', opts);
    assert.equal(await timeoutOf(), 30000);
    assert.ok((await api.getWorkflow(intake.id)).active, 'still active after rollback');
    pass('deploy --force: update with backup; rollback restored the edited version and kept it active');

    // leave the server matching the source
    await deploy(built, opts);
    console.log(`\n${results.length} checks passed against n8n at ${env.url}`);
  } finally {
    mock.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

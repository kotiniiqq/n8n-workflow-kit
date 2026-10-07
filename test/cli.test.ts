import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { startMockN8n, type MockN8n } from './mock-n8n.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
let mock: MockN8n;

before(async () => { mock = await startMockN8n(); });
after(() => mock.close());

// async on purpose: the mock n8n runs in this process, so a blocking spawn would deadlock it
function kit(args: string[], env: Record<string, string> = {}): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [tsx, 'kit/cli.ts', ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000 },
      (err, stdout, stderr) => resolve({ status: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

test('validate passes on the examples', async () => {
  const r = await kit(['validate']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 workflows valid for staging, production/);
});

test('deploy --dry-run against a server plans two creates and writes nothing', async () => {
  const r = await kit(['deploy', '--env', 'staging', '--dry-run'], { N8N_URL: mock.url, N8N_API_KEY_STAGING: mock.apiKey });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /planned: error-alert create, support-intake create/);
  assert.equal(mock.store.size, 0);
});

test('a missing API key is a clear error, not a stack trace', async () => {
  const r = await kit(['diff', '--env', 'production'], { N8N_API_KEY_PRODUCTION: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /set N8N_API_KEY_PRODUCTION/);
});

test('unknown command prints usage', async () => {
  assert.equal((await kit(['launch'])).status, 2);
});

test('typecheck passes', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', ROOT], { cwd: ROOT });
});

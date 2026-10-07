import assert from 'node:assert/strict';
import { test } from 'node:test';

import formatError, { escapeHtml } from '../code/format-error.ts';
import { luhnOk, redact } from '../code/lib/redact.ts';
import normalize from '../code/normalize-ticket.ts';
import route from '../code/route-ticket.ts';

const ctx = { now: '2026-10-07T10:00:00.000Z', node: () => [] };

test('redact masks Luhn-valid cards and e-mails only', () => {
  assert.equal(redact('card 4111 1111 1111 1111, mail a@b.co'), 'card [card ****1111], mail [email]');
  assert.equal(redact('order 1234 5678 9012 3456'), 'order 1234 5678 9012 3456');
  assert.ok(luhnOk('4111111111111111') && !luhnOk('4111111111111112'));
});

test('normalize accepts a good ticket and cleans it', () => {
  const [out] = normalize([{ json: { body: { email: ' Ann@Example.COM ', message: 'Server is down, card 4111 1111 1111 1111' } } }], ctx);
  assert.equal(out.json.valid, true);
  const t = out.json.ticket as Record<string, string>;
  assert.equal(t.email, 'ann@example.com');
  assert.equal(t.received_at, ctx.now);
  assert.match(t.message_for_logs, /\[card \*\*\*\*1111\]/);
});

test('normalize reports every problem with a bad ticket', () => {
  const [out] = normalize([{ json: { body: { email: 'nope', message: '' } } }], ctx);
  assert.deepEqual(out.json, { valid: false, errors: ['email is missing or invalid', 'message is empty'] });
});

test('route picks queue and priority', () => {
  const item = (message: string, plan = 'standard') => ({ json: { ticket: { subject: '', message, plan } } });
  const got = route([item('I want a refund'), item('server is down'), item('how do I add a mod'), item('how do I add a mod', 'vip')], ctx)
    .map((i) => [i.json.queue, i.json.priority]);
  assert.deepEqual(got, [['billing', 'high'], ['outage', 'high'], ['general', 'normal'], ['general', 'high']]);
});

test('format error escapes HTML, redacts and truncates', () => {
  const [out] = formatError([{ json: {
    workflow: { name: 'support <intake>' },
    execution: { lastNodeExecuted: 'Create Ticket', url: 'https://n8n/x/1', error: { message: 'x'.repeat(800) + ' a@b.co' } },
  } }], ctx);
  const text = out.json.text as string;
  assert.match(text, /support &lt;intake&gt;/);
  assert.ok(text.includes('…') && !text.includes('a@b.co'));
  assert.equal(escapeHtml('<b>&'), '&lt;b&gt;&amp;');
});

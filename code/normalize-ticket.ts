/** Code node "Normalize Ticket": validate and clean the webhook body.
 *  Output: one item per input, either { valid: true, ticket } or { valid: false, errors }. */
import { redact } from './lib/redact.ts';
import type { Ctx, Item } from './lib/types.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_MESSAGE = 5000;

export default function main(items: Item[], ctx: Ctx): Item[] {
  return items.map(({ json }) => {
    const body = (json.body ?? json) as Record<string, unknown>;
    const errors: string[] = [];
    const email = String(body.email ?? '').trim().toLowerCase();
    const subject = String(body.subject ?? '').trim();
    const message = String(body.message ?? '').trim();
    if (!EMAIL.test(email)) errors.push('email is missing or invalid');
    if (!message) errors.push('message is empty');
    if (message.length > MAX_MESSAGE) errors.push(`message is longer than ${MAX_MESSAGE} characters`);
    if (errors.length) return { json: { valid: false, errors } };
    return {
      json: {
        valid: true,
        ticket: {
          email,
          subject: subject || message.slice(0, 60),
          message,
          message_for_logs: redact(message),
          plan: String(body.plan ?? 'standard'),
          received_at: ctx.now,
        },
      },
    };
  });
}

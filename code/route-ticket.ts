/** Code node "Route Ticket": pick a helpdesk queue and priority. Deterministic rules,
 *  so routing is testable and explainable; an LLM classifier could sit behind "general". */
import type { Ctx, Item } from './lib/types.ts';

const RULES: Array<{ queue: string; pattern: RegExp }> = [
  { queue: 'billing', pattern: /\b(refund\w*|invoice\w*|charged|billing|payment\w*|paid)\b/i },
  { queue: 'legal', pattern: /\b(lawyers?|sue|suing|police|gdpr|delete my data)\b/i },
  { queue: 'outage', pattern: /\b(down|offline|not starting|won'?t start|crash\w*)\b/i },
];

export default function main(items: Item[], _ctx: Ctx): Item[] {
  return items.map(({ json }) => {
    const ticket = json.ticket as { message: string; subject: string; plan: string };
    const text = `${ticket.subject} ${ticket.message}`;
    const rule = RULES.find((r) => r.pattern.test(text));
    const queue = rule?.queue ?? 'general';
    const priority = queue === 'outage' || ticket.plan === 'vip' ? 'high' : queue === 'general' ? 'normal' : 'high';
    return { json: { ...json, queue, priority } };
  });
}

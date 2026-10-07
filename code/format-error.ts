/** Code node "Format Error": turn an Error Trigger item into a short Telegram message (HTML). */
import { redact } from './lib/redact.ts';
import type { Ctx, Item } from './lib/types.ts';

const MAX = 700;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default function main(items: Item[], _ctx: Ctx): Item[] {
  return items.map(({ json }) => {
    const execution = (json.execution ?? {}) as { lastNodeExecuted?: string; url?: string; error?: { message?: string } };
    const workflow = (json.workflow ?? {}) as { name?: string };
    let message = redact(execution.error?.message ?? 'unknown error');
    if (message.length > MAX) message = `${message.slice(0, MAX)}…`;
    const lines = [
      `⚠️ <b>${escapeHtml(workflow.name ?? 'unknown workflow')}</b> failed`,
      `Node: ${escapeHtml(execution.lastNodeExecuted ?? 'unknown')}`,
      escapeHtml(message),
    ];
    if (execution.url) lines.push(escapeHtml(execution.url));
    return { json: { text: lines.join('\n') } };
  });
}

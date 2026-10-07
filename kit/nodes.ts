/** Node-type facts shared by the validator and the deploy. */
type Node = Record<string, any>;

const NOT_A_START = new Set(['n8n-nodes-base.respondToWebhook']);

/** A node that can start a run: a trigger or a webhook (Respond to Webhook is neither). */
export function isTrigger(n: Node): boolean {
  return /(trigger|webhook)$/i.test(String(n.type)) && !NOT_A_START.has(n.type) && !n.disabled;
}

/** n8n 2.x runs only the published version of a workflow: webhooks, schedules, error workflows and
 *  sub-workflows alike. Only a workflow started by hand has nothing to publish. */
export function needsPublishing(w: { nodes: Node[] }): boolean {
  return w.nodes.some((n) => isTrigger(n) && n.type !== 'n8n-nodes-base.manualTrigger');
}

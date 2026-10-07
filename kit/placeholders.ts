/** Placeholders for anything that differs between environments or is only known at deploy time.
 *  Workflow sources use these instead of credential ids, URLs or workflow ids. */

/** `{ telegramApi: { id: '%%cred:alerts-bot%%', name: 'alerts-bot' } }`, resolved at build time. */
export function cred(type: string, name: string) {
  return { [type]: { id: `%%cred:${name}%%`, name } };
}

/** A per-environment value from environments.json `values`, resolved at build time. */
export function envValue(key: string): string {
  return `%%env:${key}%%`;
}

/** Another workflow's id on the server, resolved at deploy time. */
export function workflowRef(name: string): string {
  return `%%workflow:${name}%%`;
}

export const PLACEHOLDER = /%%(cred|env|workflow):([\w.-]+)%%/g;

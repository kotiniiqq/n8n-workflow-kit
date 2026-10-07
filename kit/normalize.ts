/** Canonical form of a workflow for comparisons, and a readable node-level diff.
 *
 * Server-managed fields (id, active, versionId, timestamps, tags, pinData, staticData…) and node
 * positions are ignored: moving a node on the canvas is not a change worth stopping a deploy for.
 * Credentials compare by type and id only: n8n resolves them by id and stores the credential's
 * own display name in the node, so the name in the source never survives a save.
 */
type Json = Record<string, any>;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Json).sort().map((k) => [k, sortKeys((value as Json)[k])]));
  }
  return value;
}

function credentialIds(credentials: Json | undefined): Json | undefined {
  if (!credentials) return undefined;
  return Object.fromEntries(Object.entries(credentials).map(([type, c]) => [type, { id: (c as Json)?.id }]));
}

function canonicalNode(n: Json): Json {
  const { name, type, typeVersion, parameters, disabled, onError, retryOnFail, maxTries, waitBetweenTries, executeOnce, alwaysOutputData } = n;
  return sortKeys(Object.fromEntries(Object.entries({
    name, type, typeVersion, parameters: parameters ?? {}, credentials: credentialIds(n.credentials), disabled, onError, retryOnFail,
    maxTries, waitBetweenTries, executeOnce, alwaysOutputData,
  }).filter(([, v]) => v !== undefined))) as Json;
}

export function normalize(w: Json, settingsKeys?: string[]): Json {
  const settings = Object.fromEntries(Object.entries(w.settings ?? {})
    .filter(([k]) => !settingsKeys || settingsKeys.includes(k)));
  return sortKeys({
    name: w.name,
    nodes: [...(w.nodes ?? [])].map(canonicalNode).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    connections: w.connections ?? {},
    settings,
  }) as Json;
}

export function same(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Human-readable differences between two normalized workflows (from -> to). */
export function diff(from: Json, to: Json): string[] {
  const out: string[] = [];
  const byName = (w: Json) => new Map<string, Json>((w.nodes ?? []).map((n: Json) => [n.name, n]));
  const [a, b] = [byName(from), byName(to)];
  for (const name of b.keys()) if (!a.has(name)) out.push(`+ node '${name}' (${b.get(name)!.type})`);
  for (const name of a.keys()) if (!b.has(name)) out.push(`- node '${name}' (${a.get(name)!.type})`);
  for (const [name, node] of a) {
    const other = b.get(name);
    if (!other) continue;
    const fields = [...new Set([...Object.keys(node), ...Object.keys(other)])]
      .filter((k) => JSON.stringify(node[k]) !== JSON.stringify(other[k]));
    if (fields.length) out.push(`~ node '${name}': ${fields.join(', ')} changed`);
  }
  if (JSON.stringify(from.connections) !== JSON.stringify(to.connections)) out.push('~ connections changed');
  if (JSON.stringify(from.settings) !== JSON.stringify(to.settings)) out.push('~ settings changed');
  return out;
}

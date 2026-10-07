/** In-process mock of the n8n 2.x public API.
 *
 * Strict like the real one: unknown top-level fields, settings keys or node fields are a 400.
 * Models what deploys depend on: every save is a new version (versionId); publishing makes a
 * version live (activeVersionId / activeVersion, with an optional description); a PUT on a
 * published workflow re-publishes unless ?publishIfActive=false; credential names are rewritten
 * to the stored credential's own name. Shapes follow n8n 2.40.6. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { NODE_KEYS, SETTINGS_KEYS } from '../kit/n8n-api.ts';

const BODY_KEYS = ['name', 'nodes', 'connections', 'settings', 'staticData', 'pinData', 'nodeGroups', 'shared'];

export interface MockN8n {
  url: string;
  apiKey: string;
  store: Map<string, any>;
  requests: string[];
  /** fail the next request that starts with `METHOD /api/v1/path` with this status */
  failNext(match: string, status: number): void;
  /** simulate a person saving an edit in the n8n UI; `publish` also clicks Publish */
  editInUi(id: string, change: (w: any) => void, opts?: { publish?: boolean }): void;
  /** simulate publishing an earlier version from the workflow history */
  publishFromHistory(id: string, versionId: string): void;
  versionsOf(id: string): string[];
  close(): Promise<void>;
}

export async function startMockN8n(opts: { pageSize?: number } = {}): Promise<MockN8n> {
  const store = new Map<string, any>();
  const history = new Map<string, Map<string, any>>(); // workflow id -> versionId -> version
  const requests: string[] = [];
  const failures: Array<{ match: string; status: number }> = [];
  let seq = 0;
  const apiKey = 'test-key';
  const pageSize = opts.pageSize ?? 100;

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const bad = (body: any): string | null => {
    const extra = Object.keys(body ?? {}).filter((k) => !BODY_KEYS.includes(k));
    if (extra.length) return `request/body must NOT have additional properties (${extra.join(', ')})`;
    if (!body?.name || !Array.isArray(body.nodes) || typeof body.connections !== 'object') return 'request/body must have required properties name, nodes, connections, settings';
    if (typeof body.settings !== 'object') return "request/body must have required property 'settings'";
    const extraSettings = Object.keys(body.settings).filter((k) => !SETTINGS_KEYS.includes(k));
    if (extraSettings.length) return `request/body/settings must NOT have additional properties (${extraSettings.join(', ')})`;
    for (const n of body.nodes) {
      const extraNode = Object.keys(n).filter((k) => !NODE_KEYS.includes(k));
      if (extraNode.length) return `request/body/nodes must NOT have additional properties (${extraNode.join(', ')})`;
    }
    return null;
  };
  // like the real server: a node's credential is looked up by id and stored with the credential's own name
  const storedCredentials = (nodes: any[]) => nodes.map((n: any) => (n.credentials ? {
    ...n,
    credentials: Object.fromEntries(Object.entries(n.credentials).map(([type, c]: [string, any]) => [type, { id: c.id, name: `${type} ${c.id}` }])),
  } : n));
  const startsWorkflow = (n: any) => /(trigger|webhook)$/i.test(n.type) && n.type !== 'n8n-nodes-base.respondToWebhook'
    && n.type !== 'n8n-nodes-base.manualTrigger' && !n.disabled;

  /** save a new version of the workflow (create or replace); publishing is separate */
  const save = (id: string, body: any, base: any = {}) => {
    const versionId = `ver${++seq}`;
    const w = {
      ...base, id, name: body.name, nodes: storedCredentials(structuredClone(body.nodes)), connections: structuredClone(body.connections),
      settings: structuredClone(body.settings), pinData: body.pinData ?? base.pinData ?? null, staticData: body.staticData ?? base.staticData ?? null,
      versionId, updatedAt: new Date().toISOString(),
    };
    if (!history.has(id)) history.set(id, new Map());
    history.get(id)!.set(versionId, { versionId, workflowId: id, nodes: structuredClone(w.nodes), connections: structuredClone(w.connections), description: null });
    store.set(id, w);
    return w;
  };
  const publish = (id: string, versionId: string, description?: string) => {
    const version = history.get(id)!.get(versionId)!;
    if (description !== undefined) version.description = description;
    store.set(id, { ...store.get(id), active: true, activeVersionId: versionId, activeVersion: structuredClone(version) });
  };

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url!, 'http://mock');
    const line = `${req.method} ${url.pathname}`;
    requests.push(line);
    const failure = failures.findIndex((f) => line.startsWith(f.match));
    if (failure >= 0) {
      const [f] = failures.splice(failure, 1);
      return send(res, f.status, { message: `injected failure ${f.status}` });
    }
    if (req.headers['x-n8n-api-key'] !== apiKey) return send(res, 401, { message: 'unauthorized' });
    const parts = url.pathname.replace(/^\/api\/v1\//, '').split('/');
    let body: any;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { return send(res, 400, { message: 'invalid JSON' }); }

    if (parts[0] !== 'workflows') return send(res, 404, { message: 'not found' });
    const id = parts[1];
    if (req.method === 'GET' && !id) {
      const name = url.searchParams.get('name');
      const all = [...store.values()].filter((w) => !name || w.name === name);
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), pageSize);
      const data = all.slice(start, start + limit);
      const next = start + limit < all.length ? String(start + limit) : null;
      return send(res, 200, { data, nextCursor: next });
    }
    if (req.method === 'POST' && !id) {
      const problem = bad(body);
      if (problem) return send(res, 400, { message: problem });
      const created = save(`wf${++seq}`, body, { active: false, activeVersionId: null, activeVersion: null, createdAt: new Date().toISOString(), tags: [] });
      return send(res, 200, created);
    }
    const existing = store.get(id);
    if (!existing) return send(res, 404, { message: `workflow ${id} not found` });
    if (req.method === 'GET') return send(res, 200, existing);
    if (req.method === 'PUT') {
      const problem = bad(body);
      if (problem) return send(res, 400, { message: problem });
      const saved = save(id, body, existing);
      if (existing.active && url.searchParams.get('publishIfActive') !== 'false') publish(id, saved.versionId);
      return send(res, 200, store.get(id));
    }
    if (req.method === 'POST' && parts[2] === 'publish') {
      const versionId = body?.versionId ?? existing.versionId;
      const version = history.get(id)?.get(versionId);
      if (!version) return send(res, 404, { message: `version ${versionId} not found` });
      if (!version.nodes.some(startsWorkflow)) return send(res, 400, { message: 'Workflow has no node to start the workflow' });
      publish(id, versionId, body?.description);
      return send(res, 200, store.get(id));
    }
    if (req.method === 'POST' && parts[2] === 'unpublish') {
      store.set(id, { ...existing, active: false, activeVersionId: null, activeVersion: null });
      return send(res, 200, store.get(id));
    }
    return send(res, 405, { message: 'method not allowed' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`, apiKey, store, requests,
    failNext(match, status) { failures.push({ match, status }); },
    editInUi(id, change, o = {}) {
      const w = structuredClone(store.get(id));
      change(w);
      const saved = save(id, w, store.get(id));
      if (o.publish) publish(id, saved.versionId);
    },
    publishFromHistory(id, versionId) { publish(id, versionId); },
    versionsOf(id) { return [...(history.get(id)?.keys() ?? [])]; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

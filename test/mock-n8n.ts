/** In-process mock of the n8n public API, as strict as the real one about request bodies:
 *  unknown top-level fields or settings keys are rejected with 400. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { SETTINGS_KEYS } from '../kit/n8n-api.ts';

const BODY_KEYS = ['name', 'nodes', 'connections', 'settings', 'staticData', 'shared'];

export interface MockN8n {
  url: string;
  apiKey: string;
  store: Map<string, any>;
  requests: string[];
  /** simulate a person editing a workflow in the n8n UI */
  editInUi(id: string, change: (w: any) => void): void;
  close(): Promise<void>;
}

export async function startMockN8n(opts: { pageSize?: number } = {}): Promise<MockN8n> {
  const store = new Map<string, any>();
  const requests: string[] = [];
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
    return null;
  };
  const stamp = (w: any) => ({ ...w, updatedAt: new Date().toISOString(), versionId: `v${++seq}` });
  // like the real server: a node's credential is looked up by id and stored with the credential's own name
  const storedCredentials = (body: any) => ({
    ...body,
    nodes: body.nodes.map((n: any) => (n.credentials ? {
      ...n,
      credentials: Object.fromEntries(Object.entries(n.credentials).map(([type, c]: [string, any]) => [type, { id: c.id, name: `${type} ${c.id}` }])),
    } : n)),
  });

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url!, 'http://mock');
    requests.push(`${req.method} ${url.pathname}`);
    if (req.headers['x-n8n-api-key'] !== apiKey) return send(res, 401, { message: 'unauthorized' });
    const parts = url.pathname.replace(/^\/api\/v1\//, '').split('/');
    let body: any;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { return send(res, 400, { message: 'invalid JSON' }); }

    if (parts[0] !== 'workflows') return send(res, 404, { message: 'not found' });
    const id = parts[1];
    if (req.method === 'GET' && !id) {
      const all = [...store.values()];
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), pageSize);
      const data = all.slice(start, start + limit);
      const next = start + limit < all.length ? String(start + limit) : null;
      return send(res, 200, { data, nextCursor: next });
    }
    if (req.method === 'POST' && !id) {
      const problem = bad(body);
      if (problem) return send(res, 400, { message: problem });
      const created = stamp({ ...storedCredentials(body), id: `wf${++seq}`, active: false, createdAt: new Date().toISOString(), tags: [] });
      store.set(created.id, created);
      return send(res, 200, created);
    }
    const existing = store.get(id);
    if (!existing) return send(res, 404, { message: `workflow ${id} not found` });
    if (req.method === 'GET') return send(res, 200, existing);
    if (req.method === 'PUT') {
      const problem = bad(body);
      if (problem) return send(res, 400, { message: problem });
      const updated = stamp({ ...existing, ...storedCredentials(body) });
      store.set(id, updated);
      return send(res, 200, updated);
    }
    if (req.method === 'POST' && (parts[2] === 'activate' || parts[2] === 'deactivate')) {
      if (parts[2] === 'activate' && !existing.nodes.some((n: any) => /(trigger|webhook)$/i.test(n.type))) {
        return send(res, 400, { message: 'Workflow has no node to start the workflow' });
      }
      const updated = { ...existing, active: parts[2] === 'activate' };
      store.set(id, updated);
      return send(res, 200, updated);
    }
    return send(res, 405, { message: 'method not allowed' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`, apiKey, store, requests,
    editInUi(id, change) {
      const w = structuredClone(store.get(id));
      change(w);
      store.set(id, stamp(w));
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

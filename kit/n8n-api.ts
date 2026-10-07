/** Client for the n8n public REST API (/api/v1), only what deploys need.
 *  The API rejects unknown body fields, so writes send exactly name, nodes, connections, settings. */

export interface LiveWorkflow {
  id: string;
  name: string;
  active: boolean;
  nodes: Array<Record<string, any>>;
  connections: Record<string, any>;
  settings: Record<string, any>;
  [key: string]: unknown;
}

export type WritableWorkflow = Pick<LiveWorkflow, 'name' | 'nodes' | 'connections' | 'settings'>;

// settings keys the public API accepts; anything else is a 400
export const SETTINGS_KEYS = [
  'saveExecutionProgress', 'saveManualExecutions', 'saveDataErrorExecution', 'saveDataSuccessExecution',
  'executionTimeout', 'errorWorkflow', 'timezone', 'executionOrder', 'callerPolicy', 'callerIds',
  'timeSavedPerExecution', 'availableInMCP',
];

export class N8nApiError extends Error {
  constructor(readonly method: string, readonly path: string, readonly status: number, detail: string) {
    super(`${method} ${path} -> ${status}: ${detail}`);
  }
}

export function writable(w: { name: string; nodes: any[]; connections: any; settings?: any }): WritableWorkflow {
  const settings = Object.fromEntries(Object.entries(w.settings ?? {}).filter(([k]) => SETTINGS_KEYS.includes(k)));
  return { name: w.name, nodes: w.nodes, connections: w.connections, settings };
}

export class N8nApi {
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/api/v1${path}`, {
        method,
        headers: { 'X-N8N-API-KEY': this.apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new N8nApiError(method, path, 0, `cannot reach n8n: ${(err as Error).message}`);
    }
    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 300);
      try { detail = JSON.parse(text).message ?? detail; } catch { /* keep the raw text */ }
      throw new N8nApiError(method, path, response.status, detail);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async listWorkflows(): Promise<LiveWorkflow[]> {
    const all: LiveWorkflow[] = [];
    let cursor: string | undefined;
    do {
      const query = `?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await this.call<{ data: LiveWorkflow[]; nextCursor?: string | null }>('GET', `/workflows${query}`);
      all.push(...page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return all;
  }

  async findByName(name: string): Promise<LiveWorkflow | undefined> {
    const matches = (await this.listWorkflows()).filter((w) => w.name === name);
    if (matches.length > 1) {
      throw new N8nApiError('GET', '/workflows', 409, `${matches.length} workflows are named '${name}' (ids ${matches.map((m) => m.id).join(', ')}); rename or archive the extras`);
    }
    return matches[0] ? this.getWorkflow(matches[0].id) : undefined;
  }

  getWorkflow(id: string) { return this.call<LiveWorkflow>('GET', `/workflows/${id}`); }
  createWorkflow(w: WritableWorkflow) { return this.call<LiveWorkflow>('POST', '/workflows', writable(w)); }
  updateWorkflow(id: string, w: WritableWorkflow) { return this.call<LiveWorkflow>('PUT', `/workflows/${id}`, writable(w)); }
  activate(id: string) { return this.call<LiveWorkflow>('POST', `/workflows/${id}/activate`); }
  deactivate(id: string) { return this.call<LiveWorkflow>('POST', `/workflows/${id}/deactivate`); }
}

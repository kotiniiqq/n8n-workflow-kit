/** Client for the n8n public REST API (/api/v1), only what deploys need. Shapes follow n8n 2.x.
 *  The API rejects unknown body fields, so writes send exactly name, nodes, connections, settings,
 *  with node fields and settings keys limited to what the write schema accepts. */

export interface PublishedVersion {
  versionId: string;
  nodes: Array<Record<string, any>>;
  connections: Record<string, any>;
  description?: string | null;
  [key: string]: unknown;
}

export interface LiveWorkflow {
  id: string;
  name: string;
  active: boolean;
  versionId?: string;              // the latest saved version (the draft)
  activeVersionId?: string | null; // the published version, which is what production runs
  activeVersion?: PublishedVersion | null;
  nodes: Array<Record<string, any>>;
  connections: Record<string, any>;
  settings: Record<string, any>;
  [key: string]: unknown;
}

export type WritableWorkflow = Pick<LiveWorkflow, 'name' | 'nodes' | 'connections' | 'settings'>;

// the public API's write schema (n8n 2.40.6); anything else is a 400
export const SETTINGS_KEYS = [
  'saveExecutionProgress', 'saveManualExecutions', 'saveDataErrorExecution', 'saveDataSuccessExecution',
  'executionTimeout', 'errorWorkflow', 'timezone', 'executionOrder', 'binaryMode', 'callerPolicy', 'callerIds',
  'timeSavedMode', 'timeSavedPerExecution', 'redactionPolicy', 'availableInMCP', 'customTelemetryTags',
  'credentialResolverId',
];
export const NODE_KEYS = [
  'id', 'name', 'webhookId', 'disabled', 'notesInFlow', 'notes', 'type', 'typeVersion', 'executeOnce',
  'alwaysOutputData', 'retryOnFail', 'maxTries', 'waitBetweenTries', 'continueOnFail', 'onError', 'position',
  'parameters', 'credentials',
];

export class N8nApiError extends Error {
  constructor(readonly method: string, readonly path: string, readonly status: number, detail: string) {
    super(`${method} ${path} -> ${status}: ${detail}`);
  }
}

const pick = (o: Record<string, any>, keys: string[]) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => keys.includes(k)));

export function writable(w: { name: string; nodes: any[]; connections: any; settings?: any }): WritableWorkflow {
  return { name: w.name, nodes: w.nodes.map((n) => pick(n, NODE_KEYS)), connections: w.connections, settings: pick(w.settings, SETTINGS_KEYS) };
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

  async listWorkflows(name?: string): Promise<LiveWorkflow[]> {
    const all: LiveWorkflow[] = [];
    let cursor: string | undefined;
    do {
      const query = `?limit=100&excludePinnedData=true${name ? `&name=${encodeURIComponent(name)}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await this.call<{ data: LiveWorkflow[]; nextCursor?: string | null }>('GET', `/workflows${query}`);
      all.push(...page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return all;
  }

  async findByName(name: string): Promise<LiveWorkflow | undefined> {
    const matches = (await this.listWorkflows(name)).filter((w) => w.name === name);
    if (matches.length > 1) {
      throw new N8nApiError('GET', '/workflows', 409, `${matches.length} workflows are named '${name}' (ids ${matches.map((m) => m.id).join(', ')}); rename or archive the extras`);
    }
    return matches[0] ? this.getWorkflow(matches[0].id) : undefined;
  }

  getWorkflow(id: string) { return this.call<LiveWorkflow>('GET', `/workflows/${id}?excludePinnedData=true`); }
  createWorkflow(w: WritableWorkflow) { return this.call<LiveWorkflow>('POST', '/workflows', writable(w)); }
  /** Saves a new draft. The published version stays live until publish() (publishIfActive=false). */
  saveDraft(id: string, w: WritableWorkflow) { return this.call<LiveWorkflow>('PUT', `/workflows/${id}?publishIfActive=false`, writable(w)); }
  publish(id: string, versionId: string, description: string) { return this.call<LiveWorkflow>('POST', `/workflows/${id}/publish`, { versionId, description }); }
  unpublish(id: string) { return this.call<LiveWorkflow>('POST', `/workflows/${id}/unpublish`); }
}

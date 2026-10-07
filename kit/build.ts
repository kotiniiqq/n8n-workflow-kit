/** Build: workflows/*.ts -> dist/<env>/<name>.json
 *
 * - node ids and webhook ids are derived from names, so the same source always builds to the
 *   same bytes and a diff against the server shows only real changes;
 * - every workflow gets executionOrder v1 and, unless it is an error workflow itself, a
 *   reference to the error workflow (resolved to an id at deploy time);
 * - credential ids and per-environment values come from environments.json; a missing one fails
 *   the build instead of shipping a placeholder.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from './code.ts';
import { PLACEHOLDER, workflowRef } from './placeholders.ts';

export const ERROR_WORKFLOW = 'error-alert';

export interface Environment {
  url: string;
  apiKeyEnv: string;
  credentials: Record<string, string>;
  values: Record<string, string>;
}

export interface WorkflowJson {
  name: string;
  nodes: Array<Record<string, any>>;
  connections: Record<string, any>;
  settings: Record<string, any>;
  [key: string]: unknown;
}

export interface Built {
  name: string;
  file: string;
  json: WorkflowJson;
}

export class BuildError extends Error {}

export function loadEnvironments(file = path.join(ROOT, 'environments.json')): Record<string, Environment> {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function stableId(...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function isErrorWorkflow(json: WorkflowJson): boolean {
  return json.nodes.some((n) => n.type === 'n8n-nodes-base.errorTrigger');
}

/** Turn SDK output into what the kit deploys: stable ids, settings, no SDK-only fields. */
export function finalize(raw: WorkflowJson): WorkflowJson {
  const nodes = raw.nodes.map((n) => {
    const out: Record<string, any> = { ...n, id: stableId(raw.name, n.name) };
    if ('webhookId' in n) out.webhookId = stableId(raw.name, n.name, 'webhook');
    return out;
  });
  const settings: Record<string, any> = { executionOrder: 'v1', ...(raw.settings ?? {}) };
  if (!isErrorWorkflow(raw)) settings.errorWorkflow = workflowRef(ERROR_WORKFLOW);
  return { name: raw.name, nodes, connections: raw.connections, settings };
}

/** Replace %%cred:…%% and %%env:…%% with values for one environment; %%workflow:…%% stays. */
export function resolveForEnvironment(json: WorkflowJson, env: Environment, envName: string): WorkflowJson {
  const missing = new Set<string>();
  const text = JSON.stringify(json).replace(PLACEHOLDER, (match, kind: string, key: string) => {
    if (kind === 'workflow') return match;
    const table = kind === 'cred' ? env.credentials : env.values;
    const value = table?.[key];
    if (value === undefined) {
      missing.add(`${kind}:${key}`);
      return match;
    }
    return JSON.stringify(value).slice(1, -1); // escaped for embedding inside a JSON string
  });
  if (missing.size) {
    throw new BuildError(`${json.name}: no value in environments.json[${envName}] for ${[...missing].join(', ')}`);
  }
  return JSON.parse(text);
}

export function listWorkflowSources(dir = path.join(ROOT, 'workflows')): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).sort().map((f) => path.join(dir, f));
}

export async function loadWorkflow(file: string): Promise<WorkflowJson> {
  const mod = await import(pathToFileURL(file).href);
  const builder = mod.default;
  if (!builder || typeof builder.toJSON !== 'function') {
    throw new BuildError(`${path.basename(file)} must default-export a workflow from @n8n/workflow-sdk`);
  }
  return finalize(builder.toJSON() as WorkflowJson);
}

export async function build(envName: string, opts: { outDir?: string; sources?: string[]; environments?: Record<string, Environment> } = {}): Promise<Built[]> {
  const environments = opts.environments ?? loadEnvironments();
  const env = environments[envName];
  if (!env) throw new BuildError(`unknown environment '${envName}'. Known: ${Object.keys(environments).join(', ')}`);
  const outDir = opts.outDir ?? path.join(ROOT, 'dist', envName);
  fs.mkdirSync(outDir, { recursive: true });
  const built: Built[] = [];
  const names = new Set<string>();
  for (const source of opts.sources ?? listWorkflowSources()) {
    const json = resolveForEnvironment(await loadWorkflow(source), env, envName);
    if (names.has(json.name)) throw new BuildError(`two workflows are named '${json.name}'`);
    names.add(json.name);
    const file = path.join(outDir, `${json.name}.json`);
    fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
    built.push({ name: json.name, file, json });
  }
  return built;
}

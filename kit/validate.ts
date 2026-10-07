/** Validation: the SDK's own checks plus the rules that catch what breaks in production. */
import { validateWorkflow } from '@n8n/workflow-sdk';
import vm from 'node:vm';

import type { WorkflowJson } from './build.ts';

export interface Issue {
  workflow: string;
  node?: string;
  rule: string;
  message: string;
}

const TRIGGER_TYPES = /(trigger|webhook)$/i;
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/],
  ['api key', /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/],
  ['key in a query string', /[?&](?:api_?key|token|secret|access_token)=[A-Za-z0-9._-]{8,}/i],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['telegram bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
];
const CRED_PLACEHOLDER = /^%%cred:[\w.-]+%%$/;

function walkStrings(value: unknown, visit: (s: string) => void): void {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) value.forEach((v) => walkStrings(v, visit));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => walkStrings(v, visit));
}

function compiles(jsCode: string): string | null {
  try {
    // n8n runs Code-node code as the body of an async function
    new vm.Script(`(async function () {\n${jsCode}\n})`);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Validate one workflow as it comes out of `finalize` (before environment resolution). */
export function validateOne(json: WorkflowJson, opts: { source?: boolean } = { source: true }): Issue[] {
  const issues: Issue[] = [];
  const add = (rule: string, message: string, node?: string) => issues.push({ workflow: json.name, node, rule, message });

  const sdk = validateWorkflow(json as any) as { errors?: Array<{ message?: string; nodeName?: string }> };
  for (const e of sdk.errors ?? []) add('sdk', e.message ?? String(e), e.nodeName);

  const names = new Map<string, number>();
  for (const n of json.nodes) names.set(n.name, (names.get(n.name) ?? 0) + 1);
  for (const [name, count] of names) if (count > 1) add('unique-names', `node name used ${count} times`, name);

  for (const [from, outputs] of Object.entries(json.connections ?? {})) {
    if (!names.has(from)) add('connections', `connection from a node that does not exist: '${from}'`);
    for (const branch of Object.values(outputs as Record<string, unknown[][]>)) {
      for (const targets of branch ?? []) {
        for (const t of (targets ?? []) as Array<{ node: string }>) {
          if (!names.has(t.node)) add('connections', `connection to a node that does not exist: '${t.node}'`, from);
        }
      }
    }
  }

  const triggers = json.nodes.filter((n) => TRIGGER_TYPES.test(n.type));
  if (!triggers.length) add('trigger', 'workflow has no trigger node');
  const isError = json.nodes.some((n) => n.type === 'n8n-nodes-base.errorTrigger');
  if (!isError && !json.settings?.errorWorkflow) add('error-workflow', 'settings.errorWorkflow is not set');

  for (const n of json.nodes) {
    for (const [type, value] of Object.entries((n.credentials ?? {}) as Record<string, { id?: string }>)) {
      if (opts.source && value?.id && !CRED_PLACEHOLDER.test(value.id)) {
        add('credential-ids', `credential '${type}' has a literal id; use cred() so each environment maps its own`, n.name);
      }
    }
    walkStrings(n.parameters, (s) => {
      for (const [label, pattern] of SECRET_PATTERNS) {
        if (pattern.test(s)) add('secrets', `parameter looks like a hardcoded ${label}`, n.name);
      }
    });
    if (n.type === 'n8n-nodes-base.code') {
      const error = compiles(String(n.parameters?.jsCode ?? ''));
      if (error) add('code-compiles', `Code node does not compile: ${error}`, n.name);
    }
  }
  return issues;
}

/** Validate a set of workflows together: rules that span workflows live here. */
export function validateAll(workflows: WorkflowJson[]): Issue[] {
  const issues = workflows.flatMap((w) => validateOne(w));
  const paths = new Map<string, string>();
  for (const w of workflows) {
    for (const n of w.nodes.filter((x) => x.type === 'n8n-nodes-base.webhook')) {
      const key = `${String(n.parameters?.httpMethod ?? 'GET')} ${String(n.parameters?.path ?? '')}`;
      const other = paths.get(key);
      if (other) issues.push({ workflow: w.name, node: n.name, rule: 'webhook-paths', message: `webhook ${key} is also used by '${other}'` });
      else paths.set(key, `${w.name}/${n.name}`);
    }
  }
  return issues;
}

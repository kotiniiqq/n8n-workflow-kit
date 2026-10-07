/** Deploy built workflows to an n8n instance, safely.
 *
 * For each workflow (the error workflow first, because others reference it):
 *   1. find it on the server by name;
 *   2. if it exists, compare it with the snapshot of what this kit deployed last time — any
 *      difference means someone edited it in the UI, and the deploy stops (unless --force);
 *   3. back up the live version;
 *   4. resolve %%workflow:…%% references to live ids and create or update;
 *   5. activate it if it has a trigger that needs activation;
 *   6. save a snapshot of what is now live.
 * Before any write, every workflow reference must resolve, so a run never deploys half a change.
 */
import fs from 'node:fs';
import path from 'node:path';

import { ERROR_WORKFLOW, type Built, type WorkflowJson } from './build.ts';
import { N8nApi, writable, type LiveWorkflow } from './n8n-api.ts';
import { diff, normalize, same } from './normalize.ts';
import { PLACEHOLDER } from './placeholders.ts';

const NO_ACTIVATION = new Set(['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.errorTrigger', 'n8n-nodes-base.executeWorkflowTrigger']);

export class DriftError extends Error {
  constructor(readonly workflow: string, readonly changes: string[]) {
    super(`'${workflow}' was changed on the server since the last deploy:\n  ${changes.join('\n  ')}\n` +
      'Bring the change into the source, or deploy with --force to overwrite it (the live version is backed up either way).');
  }
}

export class DeployError extends Error {}

export interface DeployOptions {
  env: string;
  api: N8nApi;
  stateDir: string;   // snapshots of what the kit deployed: <stateDir>/<env>/<name>.json
  backupDir: string;  // <backupDir>/<env>/<name>/<timestamp>.json
  force?: boolean;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface Step {
  workflow: string;
  action: 'create' | 'update' | 'unchanged';
  id?: string;
  changes: string[];
  backup?: string;
}

export function needsActivation(w: { nodes: Array<Record<string, any>> }): boolean {
  return w.nodes.some((n) => /(trigger|webhook)$/i.test(n.type) && !NO_ACTIVATION.has(n.type));
}

function references(w: WorkflowJson): string[] {
  return [...JSON.stringify(w).matchAll(PLACEHOLDER)].filter((m) => m[1] === 'workflow').map((m) => m[2]);
}

function resolveRefs(w: WorkflowJson, ids: Map<string, string>): WorkflowJson {
  return JSON.parse(JSON.stringify(w).replace(PLACEHOLDER, (match, kind: string, key: string) => {
    if (kind !== 'workflow') return match;
    const id = ids.get(key);
    if (!id) throw new DeployError(`'${w.name}' references workflow '${key}', which is neither deployed nor part of this build`);
    return id;
  }));
}

const snapshotPath = (o: DeployOptions, name: string) => path.join(o.stateDir, o.env, `${name}.json`);

function readSnapshot(o: DeployOptions, name: string): Record<string, any> | undefined {
  const file = snapshotPath(o, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
}

function writeSnapshot(o: DeployOptions, live: LiveWorkflow): void {
  const file = snapshotPath(o, live.name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(normalize(live), null, 2)}\n`);
}

function backup(o: DeployOptions, live: LiveWorkflow): string {
  const dir = path.join(o.backupDir, o.env, live.name);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let file = path.join(dir, `${stamp}.json`);
  for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `${stamp}-${i}.json`);
  fs.writeFileSync(file, `${JSON.stringify(live, null, 2)}\n`);
  return file;
}

/** Desired vs live, compared on the fields the kit controls. */
function changesFrom(live: LiveWorkflow, desired: WorkflowJson): string[] {
  const keys = Object.keys(desired.settings ?? {});
  return diff(normalize(live, keys), normalize(desired, keys));
}

function ordered(built: Built[]): Built[] {
  return [...built].sort((a, b) => Number(b.name === ERROR_WORKFLOW) - Number(a.name === ERROR_WORKFLOW) || a.name.localeCompare(b.name));
}

export async function deploy(built: Built[], o: DeployOptions): Promise<Step[]> {
  const log = o.log ?? (() => {});
  const live = new Map<string, LiveWorkflow>();
  for (const b of built) {
    const found = await o.api.findByName(b.name);
    if (found) live.set(b.name, found);
  }

  // preflight: every reference resolves, every existing workflow is safe to overwrite
  const ids = new Map<string, string>([...live].map(([name, w]) => [name, w.id]));
  const buildNames = new Set(built.map((b) => b.name));
  for (const b of built) {
    for (const ref of references(b.json)) {
      if (!ids.has(ref) && !buildNames.has(ref)) {
        const onServer = await o.api.findByName(ref);
        if (!onServer) throw new DeployError(`'${b.name}' references workflow '${ref}', which is neither on the server nor part of this build`);
        ids.set(ref, onServer.id);
      }
    }
    const current = live.get(b.name);
    if (!current || o.force) continue;
    const snapshot = readSnapshot(o, b.name);
    if (!snapshot) {
      throw new DriftError(b.name, ['exists on the server but was never deployed by this kit; deploy with --force to take it over']);
    }
    if (!same(normalize(current), snapshot)) throw new DriftError(b.name, diff(snapshot, normalize(current)));
  }

  const steps: Step[] = [];
  for (const b of ordered(built)) {
    const current = live.get(b.name);
    // refs to workflows created earlier in this run are not known yet during a dry run
    const desired = o.dryRun && references(b.json).some((r) => !ids.has(r)) ? b.json : resolveRefs(b.json, ids);
    if (!current) {
      steps.push({ workflow: b.name, action: 'create', changes: [] });
      log(`+ create ${b.name}`);
      if (o.dryRun) continue;
      const created = await o.api.createWorkflow(writable(desired));
      ids.set(b.name, created.id);
      if (needsActivation(desired)) await o.api.activate(created.id);
      writeSnapshot(o, await o.api.getWorkflow(created.id));
      steps[steps.length - 1].id = created.id;
      continue;
    }
    const changes = changesFrom(current, desired);
    if (!changes.length) {
      steps.push({ workflow: b.name, action: 'unchanged', id: current.id, changes });
      log(`= ${b.name} unchanged`);
      continue;
    }
    log(`~ update ${b.name}\n  ${changes.join('\n  ')}`);
    if (o.dryRun) {
      steps.push({ workflow: b.name, action: 'update', id: current.id, changes });
      continue;
    }
    const file = backup(o, current);
    if (current.active) await o.api.deactivate(current.id);
    await o.api.updateWorkflow(current.id, writable(desired));
    if (needsActivation(desired)) await o.api.activate(current.id);
    writeSnapshot(o, await o.api.getWorkflow(current.id));
    steps.push({ workflow: b.name, action: 'update', id: current.id, changes, backup: file });
  }

  // workflows deployed before but gone from the source (renamed or deleted) are reported, never touched
  const stateDir = path.join(o.stateDir, o.env);
  if (fs.existsSync(stateDir)) {
    for (const f of fs.readdirSync(stateDir)) {
      const name = f.replace(/\.json$/, '');
      if (!buildNames.has(name)) log(`! '${name}' was deployed before but is not in the source any more (renamed?); it is still live`);
    }
  }
  return steps;
}

export function latestBackup(backupDir: string, env: string, name: string): string {
  const dir = path.join(backupDir, env, name);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  if (!files.length) throw new DeployError(`no backup of '${name}' in ${dir}`);
  return path.join(dir, files[files.length - 1]);
}

/** Put the newest backup back and make it the new snapshot. */
export async function rollback(name: string, o: DeployOptions): Promise<string> {
  const file = latestBackup(o.backupDir, o.env, name);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as LiveWorkflow;
  const current = await o.api.findByName(name);
  if (!current) throw new DeployError(`'${name}' is not on the server; nothing to roll back`);
  if (current.active) await o.api.deactivate(current.id);
  await o.api.updateWorkflow(current.id, writable(saved));
  if (saved.active) await o.api.activate(current.id);
  writeSnapshot(o, await o.api.getWorkflow(current.id));
  fs.renameSync(file, `${file}.restored`); // the next rollback goes one version further back
  return file;
}

export async function diffAgainstLive(built: Built[], api: N8nApi): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const ids = new Map<string, string>();
  const live = new Map<string, LiveWorkflow>();
  for (const b of built) {
    const w = await api.findByName(b.name);
    if (w) { live.set(b.name, w); ids.set(b.name, w.id); }
  }
  for (const b of built) {
    const current = live.get(b.name);
    if (!current) { out[b.name] = ['not on the server yet']; continue; }
    const desired = references(b.json).every((r) => ids.has(r)) ? resolveRefs(b.json, ids) : b.json;
    out[b.name] = changesFrom(current, desired);
  }
  return out;
}

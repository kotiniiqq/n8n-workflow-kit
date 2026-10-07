/** Deploy built workflows to an n8n 2.x instance, safely.
 *
 * Workflows go in dependency order: one that references another (error workflow, sub-workflow) is
 * deployed after it, so every reference resolves to a live id. For each workflow:
 *   1. find it on the server by name;
 *   2. check it is still what the kit left there (drift, below); if not, stop, unless --force;
 *   3. back up the live version;
 *   4. save the new version as a draft: production keeps running the published version;
 *   5. publish exactly that version, with the build's fingerprint in the version description.
 * If step 4 or 5 fails, production is still on the previous version, and running the deploy again
 * continues: a saved draft that already equals the build is simply published. Workflows earlier in
 * the order stay deployed; the run is not a transaction across workflows.
 *
 * Drift: the fingerprint (a hash of the workflow as n8n stores it) is kept on the server, in the
 * published version's description, so any machine or CI job can tell whether a workflow is still
 * what the kit deployed: the published version must be the latest saved one and carry the
 * fingerprint of that content. The local snapshot (.n8n-kit/) only adds a readable diff, and is the
 * whole mechanism for workflows that are never published (started by hand only).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Built, WorkflowJson } from './build.ts';
import { N8nApi, writable, type LiveWorkflow } from './n8n-api.ts';
import { needsPublishing } from './nodes.ts';
import { diff, normalize } from './normalize.ts';
import { PLACEHOLDER } from './placeholders.ts';

export { needsPublishing };

export class DriftError extends Error {
  constructor(readonly workflow: string, readonly changes: string[]) {
    super(`'${workflow}' is not what this kit deployed last:\n  ${changes.join('\n  ')}\n` +
      'Bring the change into the source, or run again with --force to overwrite it (the live version is backed up either way).');
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
  /** every workflow in the source; deploying a subset (--only) must not report the rest as renamed */
  sourceNames?: string[];
  log?: (line: string) => void;
}

export interface Step {
  workflow: string;
  action: 'create' | 'update' | 'publish' | 'unchanged';
  id?: string;
  changes: string[];
  backup?: string;
}

const KIT_TAG = 'n8n-workflow-kit build ';

/** Hash of a workflow's content as the kit compares it (positions, ids and server fields ignored). */
export function fingerprint(w: { name: string; nodes: any[]; connections: any; settings?: any }): string {
  return createHash('sha256').update(JSON.stringify(normalize(w))).digest('hex').slice(0, 16);
}

const recordedFingerprint = (w: LiveWorkflow) => /n8n-workflow-kit build ([0-9a-f]{16})/.exec(w.activeVersion?.description ?? '')?.[1];

/** The published version as a whole workflow (settings are not versioned in n8n). */
const published = (w: LiveWorkflow): LiveWorkflow => ({ ...w, nodes: w.activeVersion!.nodes, connections: w.activeVersion!.connections });

/** Published, and both the published version and the latest saved one are the content the kit
 *  fingerprinted. Compared by content, not version id: moving a node in the UI saves a new version. */
export function publishedByKit(w: LiveWorkflow): boolean {
  if (!w.active || !w.activeVersion) return false;
  const recorded = recordedFingerprint(w);
  return recorded === fingerprint(published(w)) && recorded === fingerprint(w);
}

const snapshotPath = (o: DeployOptions, name: string) => path.join(o.stateDir, o.env, `${name}.json`);

function readSnapshot(o: DeployOptions, name: string): Record<string, any> | undefined {
  const file = snapshotPath(o, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
}

/** A version this machine saved but has not published yet (a deploy that stopped half-way). */
const pendingPath = (o: DeployOptions, name: string) => path.join(o.stateDir, o.env, `${name}.pending`);
const readPending = (o: DeployOptions, name: string) => (fs.existsSync(pendingPath(o, name)) ? fs.readFileSync(pendingPath(o, name), 'utf8').trim() : undefined);
function markPending(o: DeployOptions, name: string, versionId: string): void {
  fs.mkdirSync(path.dirname(pendingPath(o, name)), { recursive: true });
  fs.writeFileSync(pendingPath(o, name), versionId);
}

function writeSnapshot(o: DeployOptions, live: LiveWorkflow): void {
  fs.rmSync(pendingPath(o, live.name), { force: true });
  const file = snapshotPath(o, live.name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(normalize(live), null, 2)}\n`);
}

/** Why the live workflow is not what the kit deployed last; empty when it is. */
export function drift(current: LiveWorkflow, o: DeployOptions): string[] {
  const snapshot = readSnapshot(o, current.name);
  const detail = snapshot ? diff(snapshot, normalize(current)).map((c) => `  ${c}`) : [];
  if (!needsPublishing(current)) {
    if (!snapshot) return ['exists on the server but was never deployed by this kit from this machine'];
    return detail.length ? ['changed since the last deploy:', ...detail] : [];
  }
  if (!current.active || !current.activeVersion) {
    return ['is not published on the server (never deployed by this kit, unpublished in the UI, or a deploy stopped before publishing)', ...detail];
  }
  const recorded = recordedFingerprint(current);
  if (!recorded) return ['the published version was not deployed by this kit', ...detail];
  const reasons: string[] = [];
  const unpublished = diff(normalize(published(current)), normalize(current));
  if (unpublished.length) {
    reasons.push('the latest saved version differs from the published one (an unpublished edit, or an older version published from the history):',
      ...unpublished.map((c) => `  ${c}`));
  }
  if (fingerprint(published(current)) !== recorded) {
    reasons.push('the published version is not the one this kit deployed (edited and published, or published from the history)', ...detail);
  }
  return reasons;
}

function references(w: WorkflowJson): string[] {
  return [...JSON.stringify(w).matchAll(PLACEHOLDER)].filter((m) => m[1] === 'workflow').map((m) => m[2]);
}

const unresolved = (w: WorkflowJson, ids: Map<string, string>) => references(w).some((r) => !ids.has(r));

function resolveRefs(w: WorkflowJson, ids: Map<string, string>): WorkflowJson {
  return JSON.parse(JSON.stringify(w).replace(PLACEHOLDER, (match, kind: string, key: string) => {
    if (kind !== 'workflow') return match;
    const id = ids.get(key);
    if (!id) throw new DeployError(`'${w.name}' references workflow '${key}', which is neither deployed nor part of this build`);
    return id;
  }));
}

/** Dependencies first; a reference cycle cannot be deployed (neither side would have an id yet). */
export function ordered(built: Built[]): Built[] {
  const byName = new Map(built.map((b) => [b.name, b]));
  const state = new Map<string, 'visiting' | 'done'>();
  const out: Built[] = [];
  const visit = (b: Built, trail: string[]) => {
    if (state.get(b.name) === 'done') return;
    if (state.get(b.name) === 'visiting') throw new DeployError(`workflow references form a cycle: ${[...trail, b.name].join(' -> ')}`);
    state.set(b.name, 'visiting');
    for (const ref of [...new Set(references(b.json))].sort()) {
      const dep = byName.get(ref);
      if (dep && dep !== b) visit(dep, [...trail, b.name]);
    }
    state.set(b.name, 'done');
    out.push(b);
  };
  [...built].sort((a, b) => a.name.localeCompare(b.name)).forEach((b) => visit(b, []));
  return out;
}

function backup(o: DeployOptions, live: LiveWorkflow, kind = ''): string {
  const dir = path.join(o.backupDir, o.env, live.name);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = kind ? `.${kind}` : '';
  let file = path.join(dir, `${stamp}${suffix}.json`);
  for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `${stamp}-${i}${suffix}.json`);
  // pinned test data and static data can hold real payloads; deploys never write them back
  const { pinData: _pin, staticData: _static, ...kept } = live;
  fs.writeFileSync(file, `${JSON.stringify(kept, null, 2)}\n`);
  return file;
}

/** Desired vs live, compared on the fields the kit controls. */
function changesFrom(live: LiveWorkflow, desired: WorkflowJson): string[] {
  const keys = Object.keys(desired.settings ?? {});
  return diff(normalize(live, keys), normalize(desired, keys));
}

async function publishSaved(o: DeployOptions, id: string): Promise<LiveWorkflow> {
  const saved = await o.api.getWorkflow(id);
  markPending(o, saved.name, saved.versionId!);
  await o.api.publish(id, saved.versionId!, `${KIT_TAG}${fingerprint(saved)}`);
  return o.api.getWorkflow(id);
}

export async function deploy(built: Built[], o: DeployOptions): Promise<Step[]> {
  const log = o.log ?? (() => {});
  const order = ordered(built);
  const live = new Map<string, LiveWorkflow>();
  for (const b of order) {
    const found = await o.api.findByName(b.name);
    if (found) live.set(b.name, found);
  }

  // preflight, before any write: every reference resolves, every existing workflow is safe to overwrite
  const ids = new Map<string, string>([...live].map(([name, w]) => [name, w.id]));
  const buildNames = new Set(built.map((b) => b.name));
  for (const b of order) {
    for (const ref of references(b.json)) {
      if (!ids.has(ref) && !buildNames.has(ref)) {
        const onServer = await o.api.findByName(ref);
        if (!onServer) throw new DeployError(`'${b.name}' references workflow '${ref}', which is neither on the server nor part of this build`);
        ids.set(ref, onServer.id);
      }
    }
    const current = live.get(b.name);
    if (!current || o.force) continue;
    const reasons = drift(current, o);
    if (!reasons.length) continue;
    // this machine saved exactly this build and stopped before publishing it: finishing loses nothing
    const resumable = readPending(o, b.name) === current.versionId
      && !unresolved(b.json, ids) && !changesFrom(current, resolveRefs(b.json, ids)).length;
    if (!resumable) throw new DriftError(b.name, reasons);
  }

  const steps: Step[] = [];
  for (const b of order) {
    const current = live.get(b.name);
    // refs to workflows created earlier in this run are not known yet during a dry run
    const desired = o.dryRun && unresolved(b.json, ids) ? b.json : resolveRefs(b.json, ids);
    const publish = needsPublishing(desired);
    if (!current) {
      steps.push({ workflow: b.name, action: 'create', changes: [] });
      log(`+ create ${b.name}`);
      if (o.dryRun) continue;
      const created = await o.api.createWorkflow(writable(desired));
      ids.set(b.name, created.id);
      writeSnapshot(o, publish ? await publishSaved(o, created.id) : await o.api.getWorkflow(created.id));
      steps[steps.length - 1].id = created.id;
      continue;
    }
    const changes = changesFrom(current, desired);
    if (!changes.length && (!publish || publishedByKit(current))) {
      steps.push({ workflow: b.name, action: 'unchanged', id: current.id, changes });
      log(`= ${b.name} unchanged`);
      if (!o.dryRun && !readSnapshot(o, b.name)) writeSnapshot(o, current);
      continue;
    }
    if (!changes.length) {
      steps.push({ workflow: b.name, action: 'publish', id: current.id, changes });
      log(`^ publish ${b.name} (the latest saved version already equals the build)`);
      if (!o.dryRun) writeSnapshot(o, await publishSaved(o, current.id));
      continue;
    }
    log(`~ update ${b.name}\n  ${changes.join('\n  ')}`);
    if (o.dryRun) {
      steps.push({ workflow: b.name, action: 'update', id: current.id, changes });
      continue;
    }
    const file = backup(o, current);
    await o.api.saveDraft(current.id, writable(desired));
    writeSnapshot(o, publish ? await publishSaved(o, current.id) : await o.api.getWorkflow(current.id));
    steps.push({ workflow: b.name, action: 'update', id: current.id, changes, backup: file });
  }

  // workflows deployed before but gone from the source (renamed or deleted) are reported, never touched
  const sourceNames = new Set(o.sourceNames ?? buildNames);
  const stateDir = path.join(o.stateDir, o.env);
  if (fs.existsSync(stateDir)) {
    for (const f of fs.readdirSync(stateDir).filter((x) => x.endsWith('.json'))) {
      const name = f.replace(/\.json$/, '');
      if (!sourceNames.has(name)) log(`! '${name}' was deployed before but is not in the source any more (renamed?); it is still live`);
    }
  }
  return steps;
}

export function latestBackup(backupDir: string, env: string, name: string): string {
  const dir = path.join(backupDir, env, name);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('.pre-rollback')).sort() : [];
  if (!files.length) throw new DeployError(`no backup of '${name}' in ${dir}`);
  return path.join(dir, files[files.length - 1]);
}

/** Put the newest backup back: its published version, published again if it was live.
 *  Refuses when the live workflow drifted (--force overrides), and backs the live one up first. */
export async function rollback(name: string, o: DeployOptions): Promise<string> {
  const file = latestBackup(o.backupDir, o.env, name);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as LiveWorkflow;
  const current = await o.api.findByName(name);
  if (!current) throw new DeployError(`'${name}' is not on the server; nothing to roll back`);
  if (!o.force) {
    const reasons = drift(current, o);
    if (reasons.length) throw new DriftError(name, reasons);
  }
  backup(o, current, 'pre-rollback');
  const restored = saved.activeVersion ? { ...saved, nodes: saved.activeVersion.nodes, connections: saved.activeVersion.connections } : saved;
  await o.api.saveDraft(current.id, writable(restored));
  if (saved.active && needsPublishing(restored)) writeSnapshot(o, await publishSaved(o, current.id));
  else {
    if (current.active) await o.api.unpublish(current.id);
    writeSnapshot(o, await o.api.getWorkflow(current.id));
  }
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
    const desired = unresolved(b.json, ids) ? b.json : resolveRefs(b.json, ids);
    out[b.name] = changesFrom(current, desired);
    if (needsPublishing(desired) && !publishedByKit(current) && !out[b.name].length) out[b.name].push('saved but not published by this kit');
  }
  return out;
}

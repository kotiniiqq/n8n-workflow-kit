/** n8n-kit: build | validate | diff | deploy | rollback
 *
 *   npm run kit -- build --env staging
 *   npm run kit -- validate
 *   npm run kit -- diff --env staging
 *   npm run kit -- deploy --env staging [--dry-run] [--force] [--only support-intake]
 *   npm run kit -- rollback support-intake --env staging
 */
import path from 'node:path';
import { parseArgs } from 'node:util';

import { BuildError, build, listWorkflowSources, loadEnvironments, loadWorkflow } from './build.ts';
import { ROOT } from './code.ts';
import { DeployError, DriftError, deploy, diffAgainstLive, rollback } from './deploy.ts';
import { N8nApi, N8nApiError } from './n8n-api.ts';
import { secretsInBuild, validateAll } from './validate.ts';

const USAGE = `usage: n8n-kit <build|validate|diff|deploy|rollback> [name] --env <environment> [--dry-run] [--force] [--only a,b]`;

function api(envName: string): N8nApi {
  const env = loadEnvironments()[envName];
  if (!env) throw new BuildError(`unknown environment '${envName}'`);
  const key = process.env[env.apiKeyEnv];
  if (!key) throw new BuildError(`set ${env.apiKeyEnv} to an n8n API key for '${envName}' (Settings -> n8n API)`);
  return new N8nApi(process.env.N8N_URL ?? env.url, key);
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      env: { type: 'string', default: 'staging' },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      only: { type: 'string' },
    },
  });
  const [command, name] = positionals;
  const env = values.env!;
  const deployOptions = () => ({
    env, api: api(env), stateDir: path.join(ROOT, '.n8n-kit'), backupDir: path.join(ROOT, 'backups'),
    force: values.force, dryRun: values['dry-run'], log: (l: string) => console.log(l),
  });

  switch (command) {
    case 'validate': {
      const workflows = await Promise.all(listWorkflowSources().map((f) => loadWorkflow(f)));
      const issues = validateAll(workflows);
      for (const e of Object.keys(loadEnvironments())) { // every environment must resolve, without secrets
        for (const b of await build(e)) issues.push(...secretsInBuild(b.json, e));
      }
      for (const i of issues) console.log(`${i.workflow}${i.node ? ` / ${i.node}` : ''}: [${i.rule}] ${i.message}`);
      console.log(issues.length ? `${issues.length} problem(s)` : `${workflows.length} workflows valid for ${Object.keys(loadEnvironments()).join(', ')}`);
      return issues.length ? 1 : 0;
    }
    case 'build': {
      const built = await build(env);
      for (const b of built) console.log(`built ${path.relative(ROOT, b.file)}`);
      return 0;
    }
    case 'diff': {
      const result = await diffAgainstLive(await build(env), api(env));
      for (const [wf, changes] of Object.entries(result)) {
        console.log(changes.length ? `${wf}:\n  ${changes.join('\n  ')}` : `${wf}: up to date`);
      }
      return Object.values(result).some((c) => c.length) ? 1 : 0;
    }
    case 'deploy': {
      let built = await build(env);
      const sourceNames = built.map((b) => b.name);
      if (values.only) {
        const only = new Set(values.only.split(',').map((s) => s.trim()));
        const unknown = [...only].filter((n) => !built.some((b) => b.name === n));
        if (unknown.length) throw new BuildError(`--only: no such workflow ${unknown.join(', ')}`);
        built = built.filter((b) => only.has(b.name));
      }
      const issues = [
        ...validateAll(await Promise.all(listWorkflowSources().map((f) => loadWorkflow(f)))),
        ...built.flatMap((b) => secretsInBuild(b.json, env)),
      ];
      if (issues.length) throw new BuildError(`validation failed (${issues.length} problems); run validate`);
      const steps = await deploy(built, { ...deployOptions(), sourceNames });
      console.log(`${values['dry-run'] ? 'planned' : 'done'}: ${steps.map((s) => `${s.workflow} ${s.action}`).join(', ')}`);
      return 0;
    }
    case 'rollback': {
      if (!name) throw new BuildError('rollback needs a workflow name');
      const file = await rollback(name, deployOptions());
      console.log(`restored ${name} from ${path.relative(ROOT, file)}`);
      return 0;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isEntry) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((err) => {
    const known = err instanceof BuildError || err instanceof DeployError || err instanceof DriftError || err instanceof N8nApiError;
    console.error(known ? `error: ${err.message}` : err);
    process.exitCode = known ? 1 : 2;
  });
}

# n8n-workflow-kit

n8n workflows as TypeScript, with the safety net hand-edited workflows lack: Code-node logic in
ordinary modules with unit tests, deterministic builds per environment, validation, and a deploy
that backs up what it replaces, refuses to overwrite edits made in the UI, and can roll back.

> Reference implementation of how I ran client automations: workflows generated from versioned
> code and deployed through the n8n API. The example workflows here are synthetic.

```bash
npm install
npm test                                   # unit, bundling, build, validation, deploy against a mock API, typecheck
npm run e2e                                # against a real n8n, see below
npm run kit -- validate                    # every workflow, every environment
npm run kit -- build --env staging         # -> dist/staging/*.json
N8N_API_KEY_STAGING=... npm run kit -- deploy --env staging --dry-run
npm run kit -- deploy --env staging        # backups/, .n8n-kit/ snapshots
npm run kit -- rollback support-intake --env staging
```

## What it does

- **Workflows are TypeScript** (`workflows/*.ts`) on the official `@n8n/workflow-sdk`.
- **Code nodes come from tested modules** (`code/*.ts`): esbuild bundles each module and its
  shared helpers (`code/lib/`) into the node, so Code nodes share code and every one has unit tests.
  The generated node says where it came from: `// generated from code/route-ticket.ts … edit the source`.
- **Deterministic builds**: node and webhook ids derive from names; the same source builds to the
  same bytes, so diffs show only real changes.
- **Environments** (`environments.json`): credential ids and URLs are placeholders in the source
  (`cred()`, `envValue()`) and resolved per environment; a missing mapping fails the build.
- **Validation**: SDK checks plus dangling connections, duplicate names, missing trigger, missing
  error workflow, literal credential ids, Code nodes that do not compile, duplicate webhook paths,
  and hardcoded secrets (Bearer and Basic auth, `sk-…`, Stripe, GitHub, Slack, AWS keys, JWT, bot
  tokens, keys in URLs), checked in the source and again after `environments.json` values are filled in.
- **Deploy** (n8n 2.x publishes versions; production runs the published one):
  - workflows go in dependency order (an error workflow or sub-workflow before the workflows that
    reference it); every reference is resolved before any write, a reference cycle is refused;
  - the live version is backed up (without pinned or static data), the new version is saved as a
    draft, then exactly that version is published. Production never goes unpublished in between;
    if the save or the publish fails, it stays on the previous version, and re-running the deploy
    finishes the job;
  - **drift detection on the server**: the published version's description carries a fingerprint
    of what the kit deployed, so any machine or CI job can tell whether a workflow was changed
    since. An unpublished edit, an edit published in the UI, or an older version published from
    the history stops the deploy with what changed. `--force` overwrites; the replaced version stays
    in the backup. Moving nodes on the canvas is not drift;
  - `rollback` puts the previous published version back; it refuses when the live workflow has
    drifted (`--force` overrides) and backs up what it replaces first;
  - renamed workflows are reported, never deleted; `--dry-run`; `--only a,b`.

## Status, honestly

- **70 unit tests** against an in-process mock of the n8n 2.x public API: strict about request
  bodies, settings keys and node fields, and modelling versions, publishing and the
  `publishIfActive` flag; it can inject failures to test a deploy that stops half-way. Code nodes
  are executed behind the same preamble n8n's JS task runner puts in front of every Code node.
- **End-to-end against a real n8n 2.40.6** (`npm run e2e`, 8 checks): deploy creates and publishes
  both workflows; a second deploy is a no-op, also from a machine with no local state; the
  production webhook routes a ticket and creates it in a helpdesk mock with the credential; an
  invalid ticket gets a 400; a helpdesk 500 fires the error workflow, which sends the formatted
  alert to a Telegram mock; an unpublished edit leaves production serving the published version and
  stops the next deploy; `--force` keeps the overwritten draft in the backup; a change goes live
  and `rollback` restores the previous version.
- The first real run found three bugs the mock-only tests had missed, each now covered by a unit test:
  1. Code nodes failed with `__kit.default is not a function`: n8n's task runner makes
     `Object.defineProperty` a no-op, and esbuild defines module exports with it. The bundle now
     hands over the entry function by plain assignment.
  2. Every deploy reported a change: n8n stores the credential's own name in each node, so the name
     from the source never matched. Credentials now compare by type and id.
  3. The error workflow never ran: n8n 2.x executes only published workflows, error workflows and
     sub-workflows included, and the kit left those unpublished (correct for 1.x).
- An independent review then went through the deploy and rollback paths. What it found and is now
  fixed: deploy unpublished the workflow before updating it (a failed step left webhooks down),
  rollback could discard an edit made in the UI without backing it up, the order was alphabetical
  rather than by dependency, drift state existed only on the machine that deployed, a version
  published from the history went unnoticed, a card number followed by its expiry date escaped
  redaction, and some settings were silently dropped on rollback.
- Known limits: a run is not a transaction across workflows (earlier ones stay deployed when a later
  one fails; re-running continues); finishing a half-done deploy without `--force` works from the
  machine that started it; workflows started only by hand are never published, so their drift
  check relies on the local snapshot in `.n8n-kit/`. Checked on n8n 2.40.6 only.
  `@n8n/workflow-sdk` is pinned (pre-1.0, its shape changes between minors).

### Run the end-to-end check

Use a throwaway n8n: the script creates and overwrites `support-intake` and `error-alert` there.
It starts its own helpdesk and Telegram mock on port 8787, so nothing leaves the machine.

```bash
npx n8n@2.40.6 start                                             # in another terminal
npm run e2e:setup                                                # owner account + API key, prints the export
npx n8n@2.40.6 import:credentials --input=e2e/credentials.json   # fixed ids used by the "local" env
export N8N_API_KEY_LOCAL=...
npm run e2e
```

## How this was built

A design spec and plan first, then test-first implementation task by task. The tests caught a
real deadlock along the way: a CLI test that spawned the kit synchronously blocked the mock server
living in the same process.

## License

MIT

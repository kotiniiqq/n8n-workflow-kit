# n8n-workflow-kit

n8n workflows as TypeScript, with the safety net hand-edited workflows lack: Code-node logic in
ordinary modules with unit tests, deterministic builds per environment, validation, and a deploy
that backs up what it replaces, refuses to overwrite edits made in the UI, and can roll back.

> Reference implementation of how I ran client automations: workflows generated from versioned
> code and deployed through the n8n API. The example workflows here are synthetic.

```bash
npm install
npm test                                   # unit, bundling, build, validation, deploy against a mock API, typecheck
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
  error workflow, literal credential ids, hardcoded secrets (Bearer, `sk-…`, JWT, bot tokens, keys in
  URLs), Code nodes that do not compile, duplicate webhook paths.
- **Deploy**: error workflow first; every reference checked before any write; live version backed
  up; **drift detection**: if the workflow was edited in the UI since the last deploy, the deploy
  stops and lists what changed (`--force` overwrites, the edit stays in the backup); moving nodes on
  the canvas is not drift; renamed workflows are reported, never deleted; `--dry-run`; `rollback`.

## Status, honestly

- Tested against an **in-process mock of the n8n public API** that rejects unknown body fields and
  settings keys the way the real API does (53 tests).
- Not yet verified by importing and running the generated workflows in a real n8n instance. That
  check is the next step; until then treat the generated JSON as unverified against a live server.
- `@n8n/workflow-sdk` is pinned (pre-1.0, its shape changes between minors).

## How this was built

A design spec and plan first, then test-first implementation task by task. The tests caught a
real deadlock along the way: a CLI test that spawned the kit synchronously blocked the mock server
living in the same process.

## License

MIT

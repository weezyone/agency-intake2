# Agency Intake Prototype — v0.2.0

Research worker update: see [RESEARCH.md](RESEARCH.md) for approved Research execution, immutable human QA, and explicit same-scope revisions with inspectable history. Use `research-revise RUN_ID ASSIGNMENT_ID REVISION.json` after `changes_requested`, `research-show ASSIGNMENT_ID` to inspect all revisions, and `research-review ASSIGNMENT_ID REVIEW.json` for each new human decision. Keep your working GLM-5.3 Flash configuration.

A working TypeScript prototype of **client intake → Project Manager plan → human approval → queued specialist assignments**, built with Mastra and MongoDB.

Version 0.2 adds a plain application state-machine baseline, a durable project-creation intent, a persistent fake project destination, and a process-kill recovery demonstration. Both orchestration paths share the same approval and delivery contracts.

## Start with the recovery demonstration

After extracting, open a terminal in `agency-intake`:

```sh
npm ci
npm run recovery-demo
npm run compare
```

`recovery-demo` runs both the baseline and Mastra paths. It approves a fixture proposal, kills a child worker immediately after the fake destination commits a project, then starts a fresh worker and verifies that the original project is recovered. A final replay must create no extra project. Both demonstrations use temporary MongoDB databases and delete those databases on exit. No API keys or model calls are needed.

`compare` executes the same ten fixtures twice per path (40 runs), including duplicate approvals and delivery. It saves inspectable samples to `results/comparison.json`. This is a local persistence/coordination comparison, not a model evaluation or production benchmark. See `DESIGN.md` for contracts and `VALIDATION.md` for the measured results.

## Try it first

Requires Node.js 22.13 or newer (tested on 24.19.0) and npm. Extract the archive, open a terminal in `agency-intake`, then:

```sh
npm ci
npm run demo
```

The demo downloads a temporary MongoDB 8.2.6 server on its first run (roughly 123 MB on Linux). It uses actual MongoDB persistence and Mastra workflows with a deterministic fixture planner. It needs no API key. The temporary demo database is deleted when the demo exits.

You will see a draft, a new process recovering it, four queued assignments after approval, and a duplicate approval producing no additional assignments. Queuing writes assignments to MongoDB; it does not execute specialist agents or send anything externally.

## Run your own intake

Use an existing development MongoDB instance. Copy `.env.example` to `.env`, fill in the connection and local operator fields, then:

```sh
npm run cli -- start fixtures/intake.json
npm run cli -- show RUN_ID
npm run cli -- approve RUN_ID PLAN_HASH
# Or reject the draft:
npm run cli -- reject RUN_ID PLAN_HASH
```

Replace `RUN_ID` and `PLAN_HASH` with the values printed by `start`. Read the printed plan before approving. The same commands work after exiting and reopening your terminal because the data is in your MongoDB database. `npm run cli` loads `.env` automatically.

The CLI is a **trusted local operator interface**. `AGENCY_TENANT`, `AGENCY_USER`, and `AGENCY_CAN_APPROVE` describe that operator; they are not authentication credentials. An HTTP wrapper must construct the principal from verified authentication and authorization, never from request JSON. Do not expose this CLI as a public API.

## Use a real model

Set these in `.env`:

```dotenv
PLANNER_MODE=live
PM_MODEL=openai/gpt-5-mini
MEMORY_MODEL=openai/gpt-5-mini
OPENAI_API_KEY=your-provider-key
```

Then run `npm run cli -- start fixtures/intake.json`. Live runs incur provider charges. Change the provider/model identifiers and corresponding credentials to use another Mastra-supported provider. Validate that provider's structured output support before using it for live intake.

The live planner uses structured output, a 60-second abort signal, and a maximum of two agent steps. It has no dispatch tool. Observational memory is explicitly configured with MongoDB storage and thread scope. Every intake run gets a distinct thread; resource IDs are hashes of tenant and project tuples. A short single-turn intake is unlikely to trigger observation compression: configuring OM does not demonstrate that its Observer or Reflector ran.

Semantic recall/vector retrieval is intentionally outside this slice. Add it only with retrieval-level tenant authorization tests and a labeled recall dataset. The prototype does not claim vector isolation or live OM quality has been validated.

## Verification

```sh
npm run typecheck
npm test
npm run benchmark
npm run recovery-demo
npm run compare
```

`npm test` starts temporary MongoDB and verifies approval recovery, terminal rejection, stale plan hashes, tenant access checks, reviewer permission, strict schemas, query-object injection rejection, concurrent duplicate approvals, simulated partial dispatch recovery, and memory ID partitioning. Research tests additionally cover immutable revision history/QA, request replay and conflicts, retries and stale-worker fencing, revision limits, CLI commands, and approval/execution/rejection-feedback delivery through a local protocol server. These checks make no paid model calls and do not establish live report quality.

`npm run benchmark` exercises 30 fixture cases and writes `results/fixture-benchmark.json`. This measures the test harness and persistence overhead; the fixture planner does not demonstrate model reasoning, quality, token consumption, observational memory, or production throughput. See `EXPERIMENT.md` for the live evaluation protocol.

## How it works

| File | Responsibility |
|---|---|
| `src/contracts.ts` | Strict input/plan schemas and tenant/run memory IDs |
| `src/planner.ts` | Deterministic demo and real Mastra PM planner |
| `src/workflow.ts` | Draft, durable approval suspension, assignment queue step |
| `src/repository.ts` | Tenant-scoped records, immutable decision, atomic assignment batch |
| `src/app.ts` | Validated application boundary and controlled resume |
| `src/cli.ts` | Local start/show/approve/reject commands |
| `src/baseline.ts` | Ordinary application state machine using the same repository |
| `src/delivery.ts` | One bounded delivery attempt, validated receipt, retry-safe completion |
| `src/delivery-contracts.ts` | Project request, receipt, and stable creation key |
| `src/fake-destination.ts` | Persistent test destination with atomic deduplication |
| `src/research.ts` | Approved Research execution, immutable human QA, explicit revisions/history and fenced retries |
| `src/research-contracts.ts` | Bounded packet/report schemas, strict review/revision bodies, mechanical citations |
| `src/research-cli.ts` | Research packet/execute/show/review/revise commands |
| `src/researcher.ts` | Bounded Mastra Research adapter with explicit approval/execution/feedback context |

The application writes intake records to `agency_intakes` and Research jobs with revision history to `agency_research`; Mastra manages its own workflow and memory collections in the same database.

Approval is bound to the validated plan's SHA-256 hash. Model output and workflow resume payloads cannot grant approval. The workflow checks the persisted human decision. A single conditional document update commits all assignments and `dispatched` status together. Assignment IDs are stable hashes of tenant, run, plan hash, and task position.

That same update now writes `projectDelivery: { key, payloadHash, status: 'pending' }`. The worker receives a trusted operator principal, reloads the persisted approval, validates the plan and intent, and calls its destination. A matching receipt changes delivery status to `delivered`. `dispatched` still means assignments were queued; inspect `projectDelivery.status` for project creation.

The stable creation key identifies tenant + project ID. Repeated intakes with the same approved plan recover one destination project. A changed proposal for an already-created project raises an idempotency conflict; editing an existing project requires a future explicit update operation. Specialist assignments remain scoped per intake run. Only an explicitly requested approved Research assignment can execute; dispatch never starts it automatically. The assignment's `queued` field is dispatch bookkeeping, not the current Research state or evidence of missing intake approval. Intake approval does not imply client or implementation sign-off.

## Recovery and limits

- **Suspended at approval:** repeat `show`, then `approve` or `reject` with the stored plan hash.
- **Duplicate completed decision:** repeat the same decision; assignment IDs and count remain unchanged. An opposite decision is rejected.
- **Planner failure:** the record becomes `failed` and has no assignments. Correct the cause and start a new intake; this prototype has no automatic model retry queue.
- **Resume process terminates:** a five-minute lease prevents overlapping resume attempts. Retry after it expires. A persisted `suspended` workflow can resume. Other incomplete framework states require operator recovery; there is no automatic crashed-worker reconciler in this release.
- **Dispatch committed before workflow completion:** replaying the queue step returns the existing assignment batch. The test injects this durable state window; it does not simulate every possible process interruption.
- **Project delivery:** the worker makes one attempt per call. After an ambiguous failure, repeat delivery with the same intent. This is safe only with a destination implementing the documented durable idempotency contract. The included fake proves that contract locally; no real project-management service is integrated.
- **Scope conflict:** do not retry under a new creation key to bypass the conflict. Review the existing project and implement a separately authorized update operation.
- **Existing 0.1 records:** dispatched records from the earlier release have no project-delivery intent. This release does not backfill them or retroactively create projects; use a fresh development database for the demonstration.
- **Research revisions:** after immutable human `changes_requested`, explicitly submit a full packet bound to that rejected artifact hash. The same request replays or retries its own revision; conflicting evidence cannot replace it. Accepted reports stay terminal, history is retained (20 revisions total), and changed scope still requires a new approved intake. See [RESEARCH.md](RESEARCH.md) for exact commands and limits.
- **Specialist execution:** Research alone has an explicit worker. No automatic scheduler, other specialist execution, external messaging, or engineering release is connected.
- New `start` commands intentionally create new runs. HTTP request deduplication, project-level access control, retention/export/deletion, deployment, and production monitoring remain future work.

## Versions and evidence

Pinned direct versions: `@mastra/core` 1.71.0, `@mastra/memory` 1.32.1, `@mastra/mongodb` 1.19.0, `mongodb` 7.6.0, `zod` 4.6.5. The lockfile pins transitive packages. Dependency lifecycle scripts are disabled in `.npmrc`; `npm ci` was verified with that policy.

Official references checked September 25, 2026; installed declarations were also inspected and the project was type-checked:

- https://mastra.ai/docs/workflows/suspend-and-resume
- https://mastra.ai/docs/workflows/overview
- https://mastra.ai/docs/storage
- https://mastra.ai/docs/memory/observational-memory
- https://mastra.ai/docs/memory/semantic-recall

See `VALIDATION.md` and `results/` for executed checks and their limitations.

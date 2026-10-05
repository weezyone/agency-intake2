# Execute, review, and revise one approved Research assignment

The explicit, single-assignment Research worker reads a supplied evidence packet, produces a cited report, and stores that report for human review. After a human requests changes, an explicit revision can use corrected evidence and rejection feedback within the same approved scope. Every prior report and review remains inspectable. Research does not browse, contact clients, execute other specialists, create an external project, or authorize implementation.

## Upgrade your existing checkout

Keep your existing `.env` and the same MongoDB database and tenant. Existing run IDs, approvals, and assignment IDs remain valid; no migration or reapproval is needed. Install with `npm ci`, then run `npm run typecheck`.

Keep the working Flash model. The example configuration now uses:

```dotenv
LLM_PROVIDER=nim
PM_MODEL=z-ai/glm-5.3-flash
MEMORY_MODEL=z-ai/glm-5.3-flash
RESEARCH_MODEL=z-ai/glm-5.3-flash
OUTPUT_MODE=prompt
```

Updating `.env.example` does not change your `.env`. If your current `.env` explicitly sets the full model for MEMORY_MODEL or RESEARCH_MODEL, change those entries too. Omitted memory/research model settings inherit PM_MODEL. Existing planner JSON-correction and NIM low-reasoning settings are preserved. Research uses the same low-reasoning setting, a 4096-token output cap, no automatic retry, and a 60-second model-call timeout. Provider behavior remains model-dependent.

## Run it in PowerShell

Set these variables to an existing approved run and its Research assignment from `show`:

```powershell
$runId = 'YOUR_RUN_ID'
$assignmentId = 'YOUR_RESEARCH_ASSIGNMENT_ID'
npm run cli -- show $runId
npm run cli -- research-packet $runId .\research-packet.json
```

The packet command exports only the saved client brief, with a capture timestamp. It refuses to overwrite an existing file. Review the packet before executing. Additional sources may be added as objects in `sources`, each with a unique `id`, descriptive `title`, UTC `retrievedAt`, and exact `text`; an HTTPS `url` is optional. URLs are citation metadata and are never fetched. Do not invent a public URL for private client notes. Max 8 sources, 16,000 characters each, 60,000 combined, and a 512 KB JSON file. If an unusually long intake brief exceeds a source limit, prepare multiple accurately labeled source excerpts manually.

Budget and launch date are not confirmed merely because the brief asks for confirmation. With only the original brief, expect a gap analysis and client questions—not completed discovery.

```powershell
npm run cli -- research $runId $assignmentId .\research-packet.json
npm run cli -- research-show $assignmentId
```

`research` calls the configured provider even if PLANNER_MODE is demo: it is an explicit live execution command. It requires AGENCY_CAN_APPROVE=true and persisted approval for this tenant/run/assignment. The evidence and brief are sent to the model provider. Inspect sources before doing so.

Success returns `status: "awaiting_qa"`, an `artifact`, and `artifactHash`. Token/latency metrics are emitted to stderr; report JSON goes to stdout. These are reported model usage values, not a complete billing ledger. Failed calls may have unknown token counts.

## Review the report

Check whether each quote supports its claim, whether the source is trustworthy, and whether limitations accurately identify missing answers. Mechanical citation checks prove only exact quote membership in the supplied packet, not external provenance, accuracy, or that the claim follows from it. A paraphrase copied into a packet is not thereby a verified verbatim quotation from the referenced URL. Missing sign-off or assets in the packet means unknown, not proof they do not exist.

Create `research-review.json` with the exact returned artifact hash and your decision:

```json
{
  "artifactHash": "COPY_THE_64_CHARACTER_ARTIFACT_HASH_HERE",
  "accepted": true,
  "notes": "Reviewed against the supplied brief. Budget and date still require client confirmation."
}
```

```powershell
npm run cli -- research-review $assignmentId .\research-review.json
npm run cli -- research-show $assignmentId
```

Use `accepted: false` when changes are needed. Review is bound to the artifact hash and is immutable, including normalized notes and reviewer identity; only the exact original decision can be replayed. A conflicting decision, replacement notes, or another reviewer's replay is rejected. Accepting a gap-analysis report does not mean the client's budget/date are confirmed or that all assignment acceptance criteria are met. It does not release engineering. Accepted reports cannot be reopened.

## Explicit revision after changes requested

First record a human rejection with `research-review` as above (`accepted: false`). Inspect `research-show`: the current status must be `changes_requested`. Prepare corrected evidence outside Git. You may also reuse the same evidence to correct reasoning. Changes to objectives, acceptance criteria, scope, or the approved plan still require a new approved intake.

Create `research-revision.json` with exactly two fields: the **rejected** artifact hash and the full packet for its successor. Do not supply approval, scope, or replacement QA notes; feedback is loaded from the immutable saved rejection.

```json
{
  "artifactHash": "COPY_THE_REJECTED_64_CHARACTER_ARTIFACT_HASH_HERE",
  "packet": {
    "sources": [{
      "id": "client-note",
      "title": "Human-confirmed client note",
      "retrievedAt": "2026-09-30T00:00:00.000Z",
      "text": "Replace this example with accurate evidence and its actual capture timestamp."
    }]
  }
}
```

```powershell
npm run cli -- research-revise $runId $assignmentId .\research-revision.json
npm run cli -- research-show $assignmentId
# After human inspection, write a NEW review file bound to the NEW artifactHash:
npm run cli -- research-review $assignmentId .\research-revision-review.json
```

`research-revise` is an explicit provider execution just like `research`; it requires reviewer permission and revalidates the persisted intake approval, tenant, assignment, and plan integrity. The new packet, rejected report, and rejection notes are sent to the configured provider. Review these before execution; feedback is context, not authority or verified current evidence. No revision or QA decision runs automatically.

The top-level result is the current `revision` (starting at 1). `history` contains earlier rejected revisions in ascending order, each retaining its packet, source hash, report, artifact hash, citation count, and immutable QA attribution/timestamp. Revisions after the first also retain `request` with the rejected parent hash, requesting user, and timestamp. The current revision has its own packet/report/hash and requires fresh human QA; it never inherits the rejection as its own QA. Even identical report text in a later revision gets a different artifact hash.

## State and recovery

- Intake `dispatched` and assignment `queued` are the original dispatch record. Read the separate Research job via `research-show` for execution and review state: running, failed, awaiting_qa, accepted, or changes_requested. The researcher receives verified intake approval and current execution separately; neither is client/implementation sign-off.
- The rejected artifact hash is the revision request's idempotency key: exactly one successor is permitted per rejected artifact. Replaying that hash with the exact same normalized packet returns that successor without another model call after completion—even after later revisions. Conflicting packets for the same key fail. An unknown/stale parent hash, a not-yet-reviewed report, or an accepted report cannot start a revision.
- Evidence, including source order and timestamps, is immutable **per revision**. Do not regenerate it between retries. `research` always addresses revision 1; after revisions exist it replays the original report, not the latest one. `research-show` always returns the current revision and full history. Historical QA replays return the historical decision without changing the current revision.
- Invalid JSON, schema violations, invented source IDs, or non-verbatim quotes fail closed. Fix provider settings and retry the **same command and exact request** if status is failed. A failed revision remains that revision, preserving its request and history; retry does not append another revision. A failed attempt cannot substitute another packet; changed scope requires a new intake. There is no abandon/edit-failed-request operation.
- Concurrent identical requests return the completed result or a busy error; retry the same request later. Conflicting concurrent packets have one winner, never two successors.
- An interrupted running attempt becomes eligible for retry after its three-minute lease expires. A recovered attempt can incur another model charge; only the winning attempt can publish. This is not exactly-once billing.
- The CLI intentionally avoids printing raw provider/driver errors. On failure check arguments, `.env`, MongoDB access, tenant, approval, assignment role, packet format, and output mode; use `research-show` to inspect persisted state. Typecheck and tests are separate diagnostics.
- At most 20 revisions (including the original) are retained in one atomic MongoDB document. This bound, together with packet/report size limits, keeps history below the document-size limit. Replays still work at the cap; another revision requires a new approved intake. History is never silently trimmed or deleted.
- Legacy single-report records are read as revision 1 with empty history. Existing hashes and QA remain unchanged, and they can be reviewed or explicitly revised after rejection without migration or reapproval. Do not edit MongoDB records or delete jobs to bypass these rules.
- `projectDelivery: pending` is independent of Research and remains unchanged.

## Verification and boundaries

Run `npm test` and `npm run typecheck`. The tests use temporary MongoDB, an injected deterministic Research runner, and a local OpenAI-compatible protocol server through the actual Mastra adapter. They cover revision history and its bound, failed retries, original/historical replay, concurrent duplicate/conflicting requests, tenant/role restrictions, citations, provider-input mutation isolation, tamper detection, deterministic-clock stale-worker fencing, immutable QA, CLI revise/show/review, prompt/schema output, and conversation persistence across session restarts. Protocol assertions verify approval/execution/feedback delivery and instructions, not model compliance. Protocol token counts are synthetic. These tests do not measure live GLM report quality or observational-memory compression quality. On a resource-constrained Windows host, run `node --import tsx --test --test-concurrency=1 test/*.test.ts` to avoid starting all temporary servers together.

This is a trusted local-operator CLI, not a network authentication service. Keep .env, evidence packets, generated reports, and review notes out of Git. No new dependencies are added. Automated specialist scheduling and client-confirmation gates for future implementation workers remain future work.

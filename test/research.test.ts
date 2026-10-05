import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { createApp } from '../src/app.js';
import { demoPlanner } from '../src/planner.js';
import { ResearchService } from '../src/research.js';

let server: MongoMemoryServer;
let client: MongoClient;
const actor = { tenantId: 'tenant-a', userId: 'reviewer', canApprove: true };
const packet = { sources: [{ id: 's1', title: 'Workflow docs', url: 'https://mastra.ai/docs/workflows/suspend-and-resume',
  retrievedAt: '2026-09-29T00:00:00.000Z', text: 'Suspension saves the current execution state as a snapshot.' }] };
const output = { summary: 'Use a persisted approval pause before dispatching work.',
  findings: [{ claim: 'Suspension records workflow state for later use.', citations: [{ sourceId: 's1', quote: 'execution state as a snapshot' }] }],
  limitations: ['A snapshot does not guarantee exactly-once external delivery.'] };
before(async () => {
  server = await MongoMemoryServer.create({
    binary: { version: '8.2.6' },
    instance: { launchTimeout: 60_000, ...(process.platform === 'win32' ? {} : { args: ['--nounixsocket'] }) },
  });
  client = await new MongoClient(server.getUri()).connect();
});
after(async () => { await client?.close(); await server?.stop(); });

async function setup(name: string, approved = true) {
  const app = await createApp({ uri: server.getUri(), dbName: name, planner: demoPlanner });
  let run = await app.start(actor, { projectId: 'website', brief: 'Research a reliable client approval workflow for our agency.' });
  if (approved) run = await app.decide(actor, run.runId, { approved: true, planHash: run.planHash! });
  await app.close();
  return { run, service: new ResearchService(client.db(name)) };
}

test('human-requested revision preserves rejected evidence, report and QA in inspectable history', async () => {
  const { run, service } = await setup('research-revision');
  const id = run.assignments[0].id;
  const original = await service.execute(actor, run.runId, id, packet, async () => output);
  const rejected = await service.review(actor, id, { artifactHash: original.artifactHash, accepted: false,
    notes: 'Please distinguish recorded state from delivery guarantees.' });
  const revisedPacket = { sources: [{ ...packet.sources[0], text: packet.sources[0].text + ' External delivery needs its own idempotency contract.' }] };
  const revised = await service.revise(actor, run.runId, id, { artifactHash: original.artifactHash, packet: revisedPacket }, async () => output);
  assert.equal(revised.status, 'awaiting_qa');
  assert.equal(revised.revision, 2);
  assert.equal(revised.qa, undefined);
  assert.deepEqual(revised.history, [{ revision: 1, status: 'changes_requested', packet: rejected.packet,
    sourceHash: rejected.sourceHash, artifact: rejected.artifact, artifactHash: rejected.artifactHash,
    citationsChecked: rejected.citationsChecked, qa: rejected.qa }]);
  assert.deepEqual(revised.packet, revisedPacket);
  assert.notEqual(revised.artifactHash, original.artifactHash);
  assert.equal(revised.request?.userId, actor.userId);
  assert.equal(revised.request?.artifactHash, original.artifactHash);
  assert.deepEqual(await new ResearchService(client.db('research-revision')).get(actor, id), revised);
});

test('revision replays return the same artifact without another execution and reject conflicting evidence', async () => {
  const { run, service } = await setup('research-replay');
  const id = run.assignments[0].id;
  const first = await service.execute(actor, run.runId, id, packet, async () => output);
  await service.review(actor, id, { artifactHash: first.artifactHash, accepted: false, notes: 'Clarify limitations using the same supplied evidence.' });
  const request = { artifactHash: first.artifactHash, packet };
  let calls = 0;
  const runner = async () => { calls++; return output; };
  const second = await service.revise(actor, run.runId, id, request, runner);
  const replay = await new ResearchService(client.db('research-replay')).revise(actor, run.runId, id, request, runner);
  assert.equal(replay.artifactHash, second.artifactHash);
  assert.notEqual(second.artifactHash, first.artifactHash);
  assert.equal(calls, 1);
  await assert.rejects(service.revise(actor, run.runId, id, { ...request,
    packet: { sources: [{ ...packet.sources[0], text: 'Conflicting changed evidence for the same revision request.' }] } }, runner), /conflict/i);
  const originalReplay = await service.execute(actor, run.runId, id, packet, runner);
  assert.equal(originalReplay.artifactHash, first.artifactHash);
  await service.review(actor, id, { artifactHash: second.artifactHash, accepted: false, notes: 'One more explicit human revision is required.' });
  const third = await service.revise(actor, run.runId, id, { artifactHash: second.artifactHash, packet }, runner);
  const olderReplay = await service.revise(actor, run.runId, id, request, runner);
  assert.equal(olderReplay.artifactHash, second.artifactHash);
  assert.equal(olderReplay.revision, 2);
  assert.equal(calls, 2);
  assert.equal((await service.get(actor, id)).artifactHash, third.artifactHash);
});

test('QA replay preserves exact notes and reviewer attribution, including archived revisions', async () => {
  const { run, service } = await setup('research-qa-history');
  const id = run.assignments[0].id;
  const first = await service.execute(actor, run.runId, id, packet, async () => output);
  const decision = { artifactHash: first.artifactHash, accepted: false, notes: 'Distinguish unknown sign-off from evidence that sign-off does not exist.' };
  const rejected = await service.review(actor, id, decision);
  await assert.rejects(service.review(actor, id, { ...decision, notes: 'Replacing the original immutable review notes.' }), /conflict/i);
  await assert.rejects(service.review({ ...actor, userId: 'another-reviewer' }, id, decision), /conflict/i);
  const revised = await service.revise(actor, run.runId, id, { artifactHash: first.artifactHash, packet }, async () => output);
  const replay = await service.review(actor, id, decision);
  assert.deepEqual(replay.qa, rejected.qa);
  assert.equal(replay.artifactHash, first.artifactHash);
  await assert.rejects(service.review(actor, id, { ...decision, accepted: true }), /conflict/i);
  assert.equal((await service.get(actor, id)).artifactHash, revised.artifactHash);
  assert.equal((await service.get(actor, id)).status, 'awaiting_qa');
});

test('revision runner receives persisted approval, current execution and rejected report feedback separately', async () => {
  const { run, service } = await setup('research-feedback');
  const id = run.assignments[0].id;
  const first = await service.execute(actor, run.runId, id, packet, async () => output);
  const rejected = await service.review(actor, id, { artifactHash: first.artifactHash, accepted: false,
    notes: 'Missing sign-off evidence means unknown, not nonexistent. Recheck source quotations.' });
  await service.revise(actor, run.runId, id, { artifactHash: first.artifactHash, packet }, async input => {
    assert.deepEqual(input.approval, { approved: true, runId: run.runId, planHash: run.planHash });
    assert.deepEqual(input.execution, { status: 'running', revision: 2 });
    assert.deepEqual(input.feedback, { artifactHash: first.artifactHash, report: first.artifact, qa: rejected.qa });
    assert.equal(input.task.status, 'queued');
    assert.deepEqual(input.packet, packet);
    return output;
  });
});

test('concurrent duplicate revision requests converge or report busy, never request conflict', async () => {
  const { run, service } = await setup('research-revise-concurrent');
  const id = run.assignments[0].id;
  const first = await service.execute(actor, run.runId, id, packet, async () => output);
  await service.review(actor, id, { artifactHash: first.artifactHash, accepted: false, notes: 'Please improve the explanation of delivery guarantees.' });
  let calls = 0;
  const runner = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 100)); return output; };
  const request = { artifactHash: first.artifactHash, packet };
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.revise(actor, run.runId, id, request, runner)));
  assert.ok(results.some(result => result.status === 'fulfilled'));
  for (const result of results) if (result.status === 'rejected') assert.match(String(result.reason), /busy/i);
  const replay = await service.revise(actor, run.runId, id, request, runner);
  assert.equal(calls, 1);
  assert.equal(replay.revision, 2);
  assert.equal(replay.history.length, 1);
});

test('revision history is bounded without deleting or reopening any saved report', async () => {
  const { run, service } = await setup('research-history-limit');
  const id = run.assignments[0].id;
  let job = await service.execute(actor, run.runId, id, packet, async () => output);
  for (let revision = 1; revision <= 20; revision++) {
    job = await service.review(actor, id, { artifactHash: job.artifactHash, accepted: false, notes: `Human requests clarification after revision ${revision}.` });
    if (revision < 20) job = await service.revise(actor, run.runId, id, { artifactHash: job.artifactHash, packet }, async () => output);
  }
  await assert.rejects(service.revise(actor, run.runId, id, { artifactHash: job.artifactHash, packet }, async () => output), /revision limit/i);
  assert.deepEqual(await service.get(actor, id), job);
  assert.equal(job.history.length, 19);
});

test('runner mutation cannot change the immutable evidence used for citation checks', async () => {
  const { run, service } = await setup('research-runner-isolation');
  const id = run.assignments[0].id;
  await assert.rejects(service.execute(actor, run.runId, id, packet, async input => {
    input.packet.sources[0].text = 'An invented assertion added by the provider rather than the human.';
    return { ...output, findings: [{ claim: 'An unsupported assertion must not pass citation validation.',
      citations: [{ sourceId: 's1', quote: 'invented assertion added by the provider' }] }] };
  }), /citation/i);
  const failed = await service.get(actor, id);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.packet, packet);
});

test('failed revisions retry the exact request without archiving again or changing rejection feedback', async () => {
  const { run, service } = await setup('research-revision-retry');
  const id = run.assignments[0].id;
  const first = await service.execute(actor, run.runId, id, packet, async () => output);
  const rejected = await service.review(actor, id, { artifactHash: first.artifactHash, accepted: false, notes: 'Please revise the interpretation of the supplied evidence.' });
  const request = { artifactHash: first.artifactHash, packet };
  await assert.rejects(service.revise(actor, run.runId, id, request, async () => { throw new Error('Local provider failure'); }), /provider failure/i);
  const failed = await service.get(actor, id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.revision, 2);
  assert.equal(failed.history.length, 1);
  assert.deepEqual(failed.history[0].qa, rejected.qa);
  assert.equal((await service.execute(actor, run.runId, id, packet, async () => assert.fail('Must not execute the original again'))).artifactHash, first.artifactHash);
  await assert.rejects(service.revise(actor, run.runId, id, { ...request, packet: { sources: [{ ...packet.sources[0], text: 'Different evidence is not a retry of the recorded request.' }] } }, async () => output), /conflict/i);
  await assert.rejects(service.revise(actor, run.runId, id, request, async () => ({ ...output, findings: [{ claim: 'This quotation does not exist in the supplied evidence.', citations: [{ sourceId: 's1', quote: 'invented guarantee of exactly once delivery' }] }] })), /citation/i);
  const retry = await new ResearchService(client.db('research-revision-retry')).revise(actor, run.runId, id, request, async input => {
    assert.deepEqual(input.feedback?.qa, rejected.qa);
    return output;
  });
  assert.equal(retry.status, 'awaiting_qa');
  assert.equal(retry.revision, 2);
  assert.deepEqual(retry.history, failed.history);
  assert.deepEqual(retry.request, failed.request);
});

test('expired revision workers cannot publish over a recovered revision or damage rejected history', async t => {
  const { run, service } = await setup('research-revision-fencing');
  const id = run.assignments[0].id;
  const first = await service.execute(actor, run.runId, id, packet, async () => output);
  await service.review(actor, id, { artifactHash: first.artifactHash, accepted: false, notes: 'Human requests a clearer description of the known limitations.' });
  const request = { artifactHash: first.artifactHash, packet };
  let started!: () => void;
  let finish!: (value: typeof output) => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const deferred = new Promise<typeof output>(resolve => { finish = resolve; });
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const old = service.revise(actor, run.runId, id, request, async () => { started(); return deferred; });
  const oldRejected = assert.rejects(old, /lease lost/i);
  await entered;
  const running = await service.get(actor, id);
  t.mock.timers.setTime(now + 180_001);
  try {
    const replacement = await service.revise(actor, run.runId, id, request, async () => output);
    finish({ ...output, summary: 'This stale revision must never replace the recovered report.' });
    await oldRejected;
    const saved = await service.get(actor, id);
    assert.equal(saved.artifactHash, replacement.artifactHash);
    assert.equal(saved.status, 'awaiting_qa');
    assert.equal(saved.revision, 2);
    assert.deepEqual(saved.history, running.history);
    assert.deepEqual(saved.request, running.request);
  } finally { finish(output); t.mock.timers.reset(); }
});

test('revision authorization, strict input and terminal acceptance fail closed for legacy records', async () => {
  const { run, service } = await setup('research-revision-access');
  const id = run.assignments[0].id;
  const first = await service.execute(actor, run.runId, id, packet, async () => output);
  assert.equal(first.revision, 1);
  assert.deepEqual(first.history, []);
  const request = { artifactHash: first.artifactHash, packet };
  const neverRun = async () => assert.fail('Denied requests must not call a provider');
  await assert.rejects(service.revise(actor, run.runId, id, request, neverRun), /changes_requested/i);
  await assert.rejects(service.revise({ ...actor, canApprove: false }, run.runId, id, request, neverRun), /forbidden/i);
  await assert.rejects(service.revise({ ...actor, tenantId: 'tenant-b' }, run.runId, id, request, neverRun), /not found/i);
  await assert.rejects(service.revise(actor, run.runId, run.assignments.find(a => a.role === 'design')!.id, request, neverRun), /research/i);
  for (const body of [{ ...request, approval: true }, { ...request, artifactHash: { $ne: null } }, { ...request, artifactHash: 'invalid' }, { ...request, packet: { ...packet, scope: 'Changed scope' } }]) {
    await assert.rejects(service.revise(actor, run.runId, id, body, neverRun));
  }
  await assert.rejects(service.revise(actor, run.runId, id, { ...request, artifactHash: '0'.repeat(64) }, neverRun), /stale/i);
  const accepted = await service.review(actor, id, { artifactHash: first.artifactHash, accepted: true, notes: 'Human verified this exact report against the evidence.' });
  await assert.rejects(service.revise(actor, run.runId, id, request, neverRun), /changes_requested/i);
  await assert.rejects(service.review(actor, id, { artifactHash: first.artifactHash, accepted: false, notes: 'Attempt to reopen an accepted legacy artifact.' }), /conflict/i);
  assert.deepEqual(await service.get(actor, id), accepted);
  assert.equal(accepted.artifactHash, first.artifactHash);
});

test('concurrent conflicting revision evidence has one immutable winner', async () => {
  const { run, service } = await setup('research-revision-conflict');
  const id = run.assignments[0].id;
  const first = await service.execute(actor, run.runId, id, packet, async () => output);
  await service.review(actor, id, { artifactHash: first.artifactHash, accepted: false, notes: 'Please revise the explanation with corrected evidence.' });
  let calls = 0;
  const runner = async () => { calls++; return output; };
  const requests = [packet, { sources: [{ ...packet.sources[0], text: packet.sources[0].text + ' Clarification from the human reviewer.' }] }].map(packet => ({ artifactHash: first.artifactHash, packet }));
  const results = await Promise.allSettled(requests.map(request => service.revise(actor, run.runId, id, request, runner)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const loser = results.find(result => result.status === 'rejected');
  assert.ok(loser?.status === 'rejected');
  assert.match(String(loser.reason), /conflict/i);
  const saved = await service.get(actor, id);
  assert.equal(saved.revision, 2);
  assert.equal(saved.history.length, 1);
  assert.equal(calls, 1);
  const decisions = [true, false].map(accepted => ({ artifactHash: saved.artifactHash, accepted, notes: 'A human decision on the exact revised artifact.' }));
  const reviews = await Promise.allSettled(decisions.map(decision => service.review(actor, id, decision)));
  assert.equal(reviews.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(reviews.filter(result => result.status === 'rejected').length, 1);
  assert.deepEqual((await service.get(actor, id)).history, saved.history);
});

test('approved research produces one persisted artifact and explicit QA decision', async () => {
  const { run, service } = await setup('research-happy');
  const assignment = run.assignments.find(a => a.role === 'research')!;
  let calls = 0;
  const runner = async () => { calls++; return output; };
  const job = await service.execute(actor, run.runId, assignment.id, packet, runner);
  assert.equal(job.status, 'awaiting_qa');
  assert.equal(job.citationsChecked, 1);
  const again = await new ResearchService(client.db('research-happy')).execute(actor, run.runId, assignment.id, packet, runner);
  assert.equal(again.artifactHash, job.artifactHash);
  assert.equal(calls, 1);
  const reviewed = await service.review(actor, assignment.id, { artifactHash: job.artifactHash!, accepted: true, notes: 'Verified the claim against its quoted source.' });
  assert.equal(reviewed.status, 'accepted');
  await assert.rejects(service.review(actor, assignment.id, { artifactHash: '0'.repeat(64), accepted: true, notes: 'Incorrect artifact hash.' }), /stale/i);
});

test('unapproved, cross-tenant, and non-research assignments cannot execute', async () => {
  const pending = await setup('research-pending', false);
  await assert.rejects(pending.service.execute(actor, pending.run.runId, '0'.repeat(64), packet, async () => output), /approval/i);
  const { run, service } = await setup('research-access');
  const task = run.assignments.find(a => a.role === 'research')!;
  await assert.rejects(service.execute({ ...actor, tenantId: 'tenant-b' }, run.runId, task.id, packet, async () => output), /not found/i);
  await assert.rejects(service.execute({ ...actor, canApprove: false }, run.runId, task.id, packet, async () => output), /forbidden/i);
  await assert.rejects(service.execute(actor, run.runId, run.assignments.find(a => a.role === 'design')!.id, packet, async () => output), /research/i);
});

test('invented sources and quotations fail closed and can retry with valid output', async () => {
  const { run, service } = await setup('research-citations');
  const id = run.assignments[0].id;
  for (const citation of [{ sourceId: 'invented', quote: 'execution state as a snapshot' }, { sourceId: 's1', quote: 'guarantees exactly once delivery' }]) {
    await assert.rejects(service.execute(actor, run.runId, id, packet, async () => ({ ...output,
      findings: [{ claim: 'An unsupported factual claim in this test.', citations: [citation] }] })), /citation/i);
    assert.equal((await service.get(actor, id)).status, 'failed');
  }
  const valid = await service.execute(actor, run.runId, id, packet, async () => output);
  assert.equal(valid.status, 'awaiting_qa');
  await assert.rejects(service.execute(actor, run.runId, id, { sources: [{ ...packet.sources[0], text: 'Different evidence packet for the same assignment.' }] }, async () => output), /conflict/i);
});

test('concurrent executions do not publish competing artifacts', async () => {
  const { run, service } = await setup('research-concurrent');
  let calls = 0;
  const runner = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 100)); return output; };
  const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => service.execute(actor, run.runId, run.assignments[0].id, packet, runner)));
  assert.ok(attempts.some(r => r.status === 'fulfilled'));
  assert.equal(calls, 1);
  assert.equal((await service.get(actor, run.assignments[0].id)).status, 'awaiting_qa');
});

test('tampered assignment cannot change the approved research task', async () => {
  const { run, service } = await setup('research-integrity');
  await client.db('research-integrity').collection('agency_intakes').updateOne({ _id: run.runId } as never,
    { $set: { 'assignments.0.objective': 'Different unapproved research work.' } });
  await assert.rejects(service.execute(actor, run.runId, run.assignments[0].id, packet, async () => output), /integrity/i);
});

test('expired attempt is fenced when a replacement publishes, and QA cannot be reversed', async () => {
  const { run, service } = await setup('research-fencing');
  const id = run.assignments[0].id;
  let started!: () => void;
  let finish!: (value: typeof output) => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const deferred = new Promise<typeof output>(resolve => { finish = resolve; });
  const old = service.execute(actor, run.runId, id, packet, async () => { started(); return deferred; });
  const oldRejected = assert.rejects(old, /lease lost/i);
  await entered;
  await client.db('research-fencing').collection('agency_research').updateOne({ _id: id } as never, { $set: { leaseUntil: new Date(0) } });
  const replacement = await service.execute(actor, run.runId, id, packet, async () => output);
  finish({ ...output, summary: 'This stale result must never replace the winning artifact.' });
  await oldRejected;
  assert.equal((await service.get(actor, id)).artifactHash, replacement.artifactHash);
  await assert.rejects(service.review({ ...actor, canApprove: false }, id,
    { artifactHash: replacement.artifactHash, accepted: true, notes: 'A review without permission.' }), /forbidden/i);
  await service.review(actor, id, { artifactHash: replacement.artifactHash, accepted: false, notes: 'Needs stronger evidence for the recommendation.' });
  await assert.rejects(service.review(actor, id, { artifactHash: replacement.artifactHash, accepted: true, notes: 'Attempt to reverse the recorded review.' }), /conflict/i);
});

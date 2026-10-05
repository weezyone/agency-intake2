import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { createApp } from '../src/app.js';
import { demoPlanner } from '../src/planner.js';
import { runResearchCommand, researchCommands } from '../src/research-cli.js';
import type { ResearchJob } from '../src/research.js';

const actor = { tenantId: 'client-a', userId: 'reviewer', canApprove: true };
test('CLI packet, research, replay, show, and hash-bound human review', async () => {
 const server = await MongoMemoryServer.create({ binary: { version: '8.2.6' }, instance: process.platform === 'win32' ? {} : { args: ['--nounixsocket'] } });
 const client = await new MongoClient(server.getUri()).connect();
 const dir = await mkdtemp(join(tmpdir(), 'agency-cli-'));
 const app = await createApp({ uri: server.getUri(), dbName: 'cli', planner: demoPlanner });
 try {
  let run = await app.start(actor, { projectId: 'website', brief: 'Confirm the budget and launch date before implementation.' });
  run = await app.decide(actor, run.runId, { approved: true, planHash: run.planHash! });
  let calls = 0;
  const context = { db: client.db('cli'), principal: actor, runner: async () => {
    calls++;
    return { summary: 'Budget and launch date remain unconfirmed in the supplied brief.',
     findings: [{ claim: 'The client requires confirmation before implementation.', citations: [{ sourceId: 'client-brief', quote: 'Confirm the budget and launch date' }] }],
     limitations: ['No confirmed budget or launch date was supplied.'] };
  } };
  const packet = join(dir, 'packet.json');
  await runResearchCommand('research-packet', [run.runId, packet], context);
  const evidence = JSON.parse(await readFile(packet, 'utf8'));
  assert.equal(evidence.sources[0].text, run.brief);
  await assert.rejects(runResearchCommand('research-packet', [run.runId, packet], context), /exist/i);
  const id = run.assignments[0].id;
  const result = await runResearchCommand('research', [run.runId, id, packet], context) as { status: string; artifactHash: string };
  assert.equal(result.status, 'awaiting_qa');
  await runResearchCommand('research', [run.runId, id, packet], context);
  assert.equal(calls, 1);
  const review = join(dir, 'review.json');
  await writeFile(review, JSON.stringify({ artifactHash: result.artifactHash, accepted: true, notes: 'Evidence reviewed; budget and date still need client confirmation.' }));
  const reviewed = await runResearchCommand('research-review', [id, review], context) as { status: string };
  assert.equal(reviewed.status, 'accepted');
  const shown = await runResearchCommand('research-show', [id], context) as { status: string };
  assert.equal(shown.status, 'accepted');
  assert.equal((await app.get(actor, run.runId)).assignments[1].status, 'queued');
  await assert.rejects(runResearchCommand('research-show', [id], { ...context, principal: { ...actor, tenantId: 'other' } }), /not found/i);
 } finally { await app.close(); await client.close(); await server.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('CLI explicit revision retries, replays and shows immutable history before human review', async () => {
 const server = await MongoMemoryServer.create({ binary: { version: '8.2.6' }, instance: { launchTimeout: 60_000, ...(process.platform === 'win32' ? {} : { args: ['--nounixsocket'] }) } });
 const client = await new MongoClient(server.getUri()).connect();
 const dir = await mkdtemp(join(tmpdir(), 'agency-revision-cli-'));
 const app = await createApp({ uri: server.getUri(), dbName: 'revision-cli', planner: demoPlanner });
 try {
  let run = await app.start(actor, { projectId: 'website', brief: 'Confirm the budget and launch date before implementation.' });
  run = await app.decide(actor, run.runId, { approved: true, planHash: run.planHash! });
  const id = run.assignments[0].id;
  let calls = 0;
  const context = { db: client.db('revision-cli'), principal: actor, runner: async () => {
   calls++;
   return { summary: 'Budget and launch date remain unknown from the supplied brief.',
    findings: [{ claim: 'The client requests confirmation before implementation.', citations: [{ sourceId: 'client-brief', quote: 'Confirm the budget and launch date' }] }],
    limitations: ['Missing confirmation in this packet does not prove that confirmation does not exist.'] };
  } };
  const packet = join(dir, 'packet.json');
  const review = join(dir, 'review.json');
  const revision = join(dir, 'revision.json');
  await runResearchCommand('research-packet', [run.runId, packet], context);
  const first = await runResearchCommand('research', [run.runId, id, packet], context) as ResearchJob;
  const decision = { artifactHash: first.artifactHash, accepted: false, notes: 'Distinguish unknown facts from claims that assets or sign-off do not exist.' };
  await writeFile(review, JSON.stringify(decision));
  const rejected = await runResearchCommand('research-review', [id, review], context) as ResearchJob;
  const request = { artifactHash: first.artifactHash, packet: JSON.parse(await readFile(packet, 'utf8')) };
  await writeFile(revision, '\uFEFF' + JSON.stringify(request));
  await assert.rejects(runResearchCommand('research-revise', [run.runId, id, revision], { ...context, runner: async () => { throw new Error('Fixture provider unavailable'); } }), /provider unavailable/i);
  const revised = await runResearchCommand('research-revise', [run.runId, id, revision], context) as ResearchJob;
  assert.ok(researchCommands.includes('research-revise'));
  assert.equal(revised.revision, 2);
  assert.equal(revised.status, 'awaiting_qa');
  const replay = await runResearchCommand('research-revise', [run.runId, id, revision], context) as ResearchJob;
  assert.equal(replay.artifactHash, revised.artifactHash);
  assert.equal(calls, 2);
  const shown = await runResearchCommand('research-show', [id], context) as ResearchJob;
  assert.deepEqual(shown.history?.[0].qa, rejected.qa);
  assert.deepEqual(shown.history?.[0].packet, first.packet);
  assert.equal(shown.history?.[0].artifactHash, first.artifactHash);
  assert.equal(Object.hasOwn(shown, 'token'), false);
  assert.equal(Object.hasOwn(shown, 'leaseUntil'), false);
  await runResearchCommand('research-review', [id, review], context);
  assert.equal((await runResearchCommand('research-show', [id], context) as ResearchJob).status, 'awaiting_qa');
  await writeFile(review, JSON.stringify({ artifactHash: revised.artifactHash, accepted: true, notes: 'Human verified this revision against the corrected evidence.' }));
  assert.equal((await runResearchCommand('research-review', [id, review], context) as ResearchJob).status, 'accepted');
  for (const args of [[run.runId, id], [run.runId, id, revision, 'extra'], [run.runId, '', revision]]) {
   await assert.rejects(runResearchCommand('research-revise', args, context), /research-revise/);
  }
  await writeFile(revision, JSON.stringify({ ...request, scope: 'New unapproved scope' }));
  await assert.rejects(runResearchCommand('research-revise', [run.runId, id, revision], context));
  await writeFile(revision, JSON.stringify(request));
  await assert.rejects(runResearchCommand('research-revise', [run.runId, id, revision], { ...context, principal: { ...actor, canApprove: false } }), /forbidden/i);
  await assert.rejects(runResearchCommand('research-revise', [run.runId, id, revision], { ...context, principal: { ...actor, tenantId: 'other' } }), /not found/i);
  assert.equal(calls, 2);
  assert.equal((await app.get(actor, run.runId)).assignments[1].status, 'queued');
 } finally { await app.close(); await client.close(); await server.stop(); await rm(dir, { recursive: true, force: true }); }
});

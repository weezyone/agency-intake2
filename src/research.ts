import { randomUUID } from 'node:crypto';
import { type Db, type Collection } from 'mongodb';
import { z } from 'zod';
import { digest, planSchema, principalSchema } from './contracts.js';
import { Repository, type Record as IntakeRecord } from './repository.js';
import { packetSchema, researchSchema, reviewSchema, revisionSchema, hashSchema, checkCitations, type Packet, type Research } from './research-contracts.js';

type Task = IntakeRecord['assignments'][number];
export type ResearchRunner = (input: { brief: string; task: Task; packet: Packet; ids: { resource: string; thread: string };
  approval: { approved: true; runId: string; planHash: string }; execution: { status: 'running'; revision: number };
  feedback?: { artifactHash: string; report: Research; qa: NonNullable<ResearchRevision['qa']> } }) => Promise<unknown>;
export type ResearchRevision = { revision: number; sourceHash: string;
  status: 'running' | 'failed' | 'awaiting_qa' | 'accepted' | 'changes_requested';
  packet: Packet; artifact?: Research; artifactHash?: string;
  request?: { artifactHash: string; userId: string; at: string };
  citationsChecked?: number; qa?: { accepted: boolean; notes: string; userId: string; at: string } };
export type ResearchJob = Omit<ResearchRevision, 'revision'> & { _id: string; tenantId: string; runId: string; planHash: string;
  revision?: number; history?: ResearchRevision[]; token?: string; leaseUntil?: Date };
const snapshot = ({ revision, status, sourceHash, packet, artifact, artifactHash, citationsChecked, qa, request }: ResearchRevision): ResearchRevision =>
  ({ revision, status, sourceHash, packet, artifact, artifactHash, citationsChecked, qa, ...(request ? { request } : {}) });

export class ResearchService {
  private readonly jobs: Collection<ResearchJob>;
  private readonly repo: Repository;
  constructor(db: Db) { this.jobs = db.collection<ResearchJob>('agency_research'); this.repo = new Repository(db); }
  async get(principal: unknown, assignmentId: string) {
    const actor = principalSchema.parse(principal);
    const job = await this.jobs.findOne({ _id: hashSchema.parse(assignmentId), tenantId: actor.tenantId });
    if (!job) throw new Error('Research job not found');
    return { ...job, revision: job.revision ?? 1, history: job.history ?? [] };
  }
  async execute(principal: unknown, runId: string, assignmentId: string, evidence: unknown, runner: ResearchRunner) {
    return this.perform(principal, runId, assignmentId, evidence, runner);
  }
  async revise(principal: unknown, runId: string, assignmentId: string, body: unknown, runner: ResearchRunner) {
    const input = revisionSchema.parse(body);
    return this.perform(principal, runId, assignmentId, input.packet, runner, input.artifactHash);
  }
  private async perform(principal: unknown, runId: string, assignmentId: string, evidence: unknown, runner: ResearchRunner, rejectedHash?: string) {
    const actor = principalSchema.parse(principal);
    if (!actor.canApprove) throw new Error('Forbidden');
    runId = z.uuid().parse(runId); assignmentId = hashSchema.parse(assignmentId);
    const record = await this.repo.get(actor.tenantId, runId);
    if (record.status !== 'dispatched' || !record.decision?.approved) throw new Error('Persisted approval required');
    const plan = planSchema.parse(record.plan);
    if (digest(plan) !== record.planHash) throw new Error('Approved plan integrity failure');
    const task = record.assignments.find(a => a.id === assignmentId);
    if (!task || task.role !== 'research') throw new Error('An approved Research assignment is required');
    const index = record.assignments.findIndex(a => a.id === assignmentId);
    const approvedTask = plan.tasks[index];
    if (!approvedTask || task.id !== digest([actor.tenantId, runId, record.planHash, index]) ||
      digest({ role: task.role, objective: task.objective, acceptance: task.acceptance }) !== digest(approvedTask)) {
      throw new Error('Approved assignment integrity failure');
    }
    const packet = packetSchema.parse(evidence);
    const sourceHash = digest(packet);
    // The current revision and its immutable history share one atomic document.
    if (!rejectedHash) try {
      await this.jobs.insertOne({ _id: assignmentId, tenantId: actor.tenantId, runId, sourceHash, planHash: record.planHash!,
        status: 'failed', packet });
    } catch (error) { if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 11000)) throw error; }
    let job = await this.get(actor, assignmentId);
    if (job.runId !== runId || job.planHash !== record.planHash) throw new Error('Research input conflict');
    if (rejectedHash && ![...job.history, job].some(r => r.request?.artifactHash === rejectedHash)) {
      if (job.artifactHash !== rejectedHash) throw new Error('Stale research artifact');
      if (job.status !== 'changes_requested' || job.qa?.accepted !== false) throw new Error('Research revision requires changes_requested');
      if (job.revision >= 20) throw new Error('Research revision limit reached; a new approved intake is required');
      await this.jobs.updateOne({ _id: assignmentId, tenantId: actor.tenantId,
        status: 'changes_requested', artifactHash: rejectedHash },
      { $push: { history: snapshot(job) }, $set: { revision: job.revision + 1, packet, sourceHash, status: 'failed',
        request: { artifactHash: rejectedHash, userId: actor.userId, at: new Date().toISOString() } },
        $unset: { artifact: '', artifactHash: '', citationsChecked: '', qa: '', token: '', leaseUntil: '' } });
      job = await this.get(actor, assignmentId);
    }
    const target = rejectedHash ? [...job.history, job].find(r => r.request?.artifactHash === rejectedHash) : job.history[0] ?? job;
    if (!target || target.sourceHash !== sourceHash) throw new Error('Research input conflict');
    if (target.revision !== job.revision) return { _id: job._id, tenantId: job.tenantId, runId: job.runId, planHash: job.planHash,
      ...target, history: job.history.filter(r => r.revision < target.revision) };
    if (job.artifact) return job;
    const token = randomUUID();
    const claimed = await this.jobs.updateOne({ _id: assignmentId, tenantId: actor.tenantId, sourceHash,
      ...(job.revision === 1 ? { $and: [{ $or: [{ revision: 1 }, { revision: { $exists: false } }] }] } : { revision: job.revision }),
      $or: [{ status: 'failed' }, { status: 'running', leaseUntil: { $lt: new Date() } }] },
    { $set: { status: 'running', token, leaseUntil: new Date(Date.now() + 180_000) } });
    if (!claimed.modifiedCount) throw new Error('Research busy; retry later');
    try {
      const previous = job.history.at(-1);
      const artifact = researchSchema.parse(await runner(structuredClone({ brief: record.brief, task, packet,
        approval: { approved: true as const, runId, planHash: record.planHash! }, execution: { status: 'running' as const, revision: job.revision },
        ...(previous ? { feedback: { artifactHash: previous.artifactHash!, report: previous.artifact!, qa: previous.qa! } } : {}),
        ids: { resource: digest([actor.tenantId, record.projectId, 'research']), thread: digest([actor.tenantId, assignmentId, token]) } })));
      const citationsChecked = checkCitations(artifact, packet);
      const artifactHash = digest({ artifact, sourceHash, planHash: record.planHash, assignmentId,
        ...(job.revision > 1 ? { revision: job.revision, rejectedHash: job.request!.artifactHash } : {}) });
      const saved = await this.jobs.updateOne({ _id: assignmentId, tenantId: actor.tenantId, status: 'running', token },
        { $set: { artifact, artifactHash, citationsChecked, status: 'awaiting_qa' }, $unset: { token: '', leaseUntil: '' } });
      if (!saved.modifiedCount) throw new Error('Research lease lost; result discarded');
      return this.get(actor, assignmentId);
    } catch (error) {
      await this.jobs.updateOne({ _id: assignmentId, tenantId: actor.tenantId, status: 'running', token },
        { $set: { status: 'failed' }, $unset: { token: '', leaseUntil: '' } });
      throw error;
    }
  }
  async review(principal: unknown, assignmentId: string, body: unknown) {
    const actor = principalSchema.parse(principal);
    if (!actor.canApprove) throw new Error('Forbidden');
    const input = reviewSchema.parse(body);
    const job = await this.get(actor, assignmentId);
    if (![...job.history, job].some(r => r.artifact && r.artifactHash === input.artifactHash)) throw new Error('Stale research artifact');
    await this.jobs.updateOne({ _id: assignmentId, tenantId: actor.tenantId, status: 'awaiting_qa', artifactHash: input.artifactHash },
      { $set: { status: input.accepted ? 'accepted' : 'changes_requested',
        qa: { accepted: input.accepted, notes: input.notes, userId: actor.userId, at: new Date().toISOString() } } });
    const current = await this.get(actor, assignmentId);
    const reviewed = [...current.history, current].find(r => r.artifactHash === input.artifactHash);
    if (!reviewed?.qa || reviewed.qa.accepted !== input.accepted || reviewed.qa.notes !== input.notes || reviewed.qa.userId !== actor.userId) {
      throw new Error('QA decision conflict');
    }
    return reviewed.revision === current.revision ? current : { _id: current._id, tenantId: current.tenantId,
      runId: current.runId, planHash: current.planHash, ...reviewed, history: current.history.filter(r => r.revision < reviewed.revision) };
  }
}

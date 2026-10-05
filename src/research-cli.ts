import { readFile, writeFile, stat } from 'node:fs/promises';
import type { Db } from 'mongodb';
import { z } from 'zod';
import { principalSchema } from './contracts.js';
import { Repository } from './repository.js';
import { ResearchService, type ResearchRunner } from './research.js';
import { packetSchema } from './research-contracts.js';

export const researchCommands = ['research-packet', 'research', 'research-revise', 'research-show', 'research-review'];
export const researchUsage = 'research-packet RUN_ID OUTPUT.json | research RUN_ID ASSIGNMENT_ID PACKET.json | research-revise RUN_ID ASSIGNMENT_ID REVISION.json | research-show ASSIGNMENT_ID | research-review ASSIGNMENT_ID REVIEW.json';
export async function readJson(path: string) {
  if ((await stat(path)).size > 512_000) throw new Error('JSON input exceeds 512 KB');
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > 512_000) throw new Error('JSON input exceeds 512 KB');
  return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
}
export async function runResearchCommand(command: string, args: string[], context: {
  db: Db; principal: unknown; runner?: ResearchRunner;
}) {
  const actor = principalSchema.parse(context.principal);
  const service = new ResearchService(context.db);
  const counts: Record<string, number> = { 'research-packet': 2, research: 3, 'research-revise': 3, 'research-show': 1, 'research-review': 2 };
  if (!Object.hasOwn(counts, command) || args.length !== counts[command] || args.some(a => !a)) throw new Error(researchUsage);
  const [first, second, third] = args;
  if (command === 'research-packet') {
    const record = await new Repository(context.db).get(actor.tenantId, z.uuid().parse(first));
    const packet = packetSchema.parse({ sources: [{ id: 'client-brief', title: 'Client brief from saved intake',
      retrievedAt: new Date().toISOString(), text: record.brief }] });
    await writeFile(second, JSON.stringify(packet, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { saved: second, note: 'Review and add evidence before first execution. This contains only the original brief.' };
  }
  if (command === 'research-show') {
    const { token, leaseUntil, ...visible } = await service.get(actor, first);
    return visible;
  }
  if (command === 'research-review') return service.review(actor, first, await readJson(second));
  if (!context.runner) throw new Error('Research runner is not configured');
  const body = await readJson(third);
  const { token, leaseUntil, ...visible } = command === 'research-revise'
    ? await service.revise(actor, first, second, body, context.runner)
    : await service.execute(actor, first, second, body, context.runner);
  return visible;
}

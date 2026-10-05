import { z } from 'zod';
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z.object({ id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  title: z.string().trim().min(3).max(200), url: z.url().refine(v => v.startsWith('https://'), 'HTTPS source URL required').optional(),
  retrievedAt: z.iso.datetime(), text: z.string().trim().min(20).max(16_000) }).strict();
export const packetSchema = z.object({ sources: z.array(sourceSchema).min(1).max(8) }).strict()
  .refine(p => new Set(p.sources.map(s => s.id)).size === p.sources.length, 'Unique source IDs required')
  .refine(p => p.sources.reduce((n, s) => n + s.text.length, 0) <= 60_000, 'Source packet too large');
export const researchSchema = z.object({ summary: z.string().trim().min(20).max(4000),
  findings: z.array(z.object({ claim: z.string().trim().min(10).max(1000),
    citations: z.array(z.object({ sourceId: z.string().min(1).max(40), quote: z.string().trim().min(8).max(240) }).strict()).min(1).max(3),
  }).strict()).min(1).max(8), limitations: z.array(z.string().trim().min(10).max(500)).min(1).max(8),
}).strict();
export const revisionSchema = z.object({ artifactHash: hashSchema, packet: packetSchema }).strict();
export type Packet = z.infer<typeof packetSchema>;
export type Research = z.infer<typeof researchSchema>;
export const reviewSchema = z.object({ artifactHash: hashSchema, accepted: z.boolean(), notes: z.string().trim().min(10).max(2000) }).strict();
export function checkCitations(report: Research, packet: Packet) {
  let checked = 0;
  for (const finding of report.findings) for (const citation of finding.citations) {
    const source = packet.sources.find(s => s.id === citation.sourceId);
    if (!source || !source.text.includes(citation.quote)) throw new Error('Citation does not match supplied evidence');
    checked++;
  }
  return checked;
}

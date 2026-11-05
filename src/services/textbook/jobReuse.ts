import type { TextbookJob, TextbookJobSpec } from './generationTypes';
import { stableTextbookValue } from './fingerprint';

/** Compare approved execution scope, not mutable display-only descriptions. */
export function sameTextbookJobScope(left: TextbookJobSpec, right: TextbookJobSpec): boolean {
  // Presentation/prompt upgrades are not new authority. Reuse the old job
  // with its own frozen version, prompts, checkpoints and exhausted input hashes.
  const scope = (spec: TextbookJobSpec) => ({ schemaVersion: spec.schemaVersion, projectNoteId: spec.projectNoteId,
    rootProjectId: spec.rootProjectId, planningHash: spec.planningHash,
    allowedDocIds: [...spec.allowedDocIds].sort(), documentHashes: spec.documentHashes, knowledgeHashes: spec.knowledgeHashes,
    providerHash: spec.providerHash, allowCloud: spec.allowCloud, modelPolicy: spec.modelPolicy,
    readBoundUrls: spec.readBoundUrls === true, boundUrls: spec.boundUrls || [], webSupplement: spec.webSupplement || null });
  return stableTextbookValue(scope(left)) === stableTextbookValue(scope(right));
}

/** Keep running work first; otherwise recover the most complete compatible draft. */
export function preferredTextbookJob(jobs: TextbookJob[], running: (id: string) => boolean): TextbookJob | undefined {
  const rank = (job: TextbookJob) => [Number(running(job.id)), Number(!job.archivedAt), Number(job.stage === 'published'),
    Number(job.checkpoint.quality?.passed === true), job.checkpoint.chapters?.length || 0,
    Number(!!job.checkpoint.blueprint), Number(!!job.checkpoint.sources), Number(!!job.checkpoint.context)];
  return [...jobs].sort((a, b) => {
    const ar = rank(a), br = rank(b);
    for (let index = 0; index < ar.length; index++) if (ar[index] !== br[index]) return br[index] - ar[index];
    return b.updatedAt.localeCompare(a.updatedAt);
  })[0];
}

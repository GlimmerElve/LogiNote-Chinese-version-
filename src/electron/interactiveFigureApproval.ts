import { createHash } from 'node:crypto';
import type { TextbookJob } from '../services/textbook/generationTypes';

/** Return only approval metadata; never send the private checkpoint to the reader. */
export function interactiveFigureApproval(job: TextbookJob, projectId: unknown, bodyDigest: unknown) {
  if (typeof projectId !== 'string' || typeof bodyDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(bodyDigest)
    || job.stage !== 'published' || job.spec.projectNoteId !== projectId || typeof job.checkpoint.body !== 'string'
    || createHash('sha256').update(job.checkpoint.body.trim(), 'utf8').digest('hex') !== bodyDigest)
    throw Error('教材内容或原生成许可已变化，不能自动发送；请使用现有教材流程重新授权。');
  if (!job.spec.promptVersion || job.spec.promptVersion < 7) throw Error('原教材任务未包含交互图请求许可，不能自动发送。');
  return { allowCloud: job.spec.allowCloud, providerHash: job.spec.providerHash, modelPolicy: job.spec.modelPolicy };
}

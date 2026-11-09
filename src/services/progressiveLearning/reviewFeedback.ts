import { parseMasteryShadowEvaluation } from '../masteryShadow/evaluator';
import { masteryLayerAssessment } from '../masteryShadow/presentation';
import { MASTERY_SHADOW_LAYERS, type MasteryShadowCoverage, type MasteryShadowLayer, type MasteryShadowPresentation, type MasteryShadowVerdict } from '../masteryShadow/types';
import type { ProgressiveAuxiliaryResult, ProgressiveMasteryReceipt, ProgressiveReviewRecord } from './reviewTypes';

export interface ProgressiveFeedbackLayer {
  layer: MasteryShadowLayer;
  coverage: MasteryShadowCoverage;
  verdict: MasteryShadowVerdict;
  assessment: MasteryShadowPresentation['layers'][MasteryShadowLayer]['assessment'];
}
export interface ProgressiveFeedbackEntry {
  id: string;
  label: string;
  summary: string;
  status: 'evaluated' | 'failed' | 'pending';
  error?: string;
  layers: ProgressiveFeedbackLayer[];
}
export interface ProgressiveFeedbackGroup {
  key: string;
  source: 'flow_review' | 'quick_check';
  knowledgePointId: string;
  title: string;
  entries: ProgressiveFeedbackEntry[];
}
export interface ProgressiveReviewFeedback {
  groups: ProgressiveFeedbackGroup[];
  warnings: string[];
  pendingKnowledge: boolean;
  hasFailures: boolean;
}

/** The exact auxiliary blob must belong to this record revision before displaying it.
 * Native read-review checks the same SHA-256; repeating it here also catches a
 * newer blob being read between the foreground record and auxiliary requests. */
export async function verifyProgressiveAuxiliaryBinding(record: ProgressiveReviewRecord, auxiliary: ProgressiveAuxiliaryResult): Promise<void> {
  if (!record.auxiliaryHash || !/^[a-f0-9]{64}$/u.test(record.auxiliaryHash)
    || auxiliary?.schemaVersion !== 1 || !Array.isArray(auxiliary.mastery) || auxiliary.mastery.length > 300
    || typeof auxiliary.pendingKnowledge !== 'boolean') throw Error('知识点反馈与本次归档版本不一致，请重新读取。');
  const bytes = new TextEncoder().encode(JSON.stringify(auxiliary));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== record.auxiliaryHash) throw Error('知识点反馈版本已变化，请重新读取；已保存的主分析仍保留。');
}

function receiptLabel(record: ProgressiveReviewRecord, receipt: ProgressiveMasteryReceipt): string {
  if (receipt.input.source === 'quick_check') return '页内已保存作答';
  const index = record.chunks.findIndex(part => receipt.id === `pm:${record.id}:${part.id}:${receipt.input.knowledgePointId}`);
  return `复述第 ${index + 1} 段`;
}

function boundReceipt(record: ProgressiveReviewRecord, receipt: ProgressiveMasteryReceipt): boolean {
  const input = receipt?.input;
  if (!input || typeof receipt.id !== 'string' || receipt.id !== input.evaluationId
    || typeof input.knowledgePointId !== 'string' || !input.knowledgePointId
    || typeof input.knowledgePointTitle !== 'string' || !input.knowledgePointTitle.trim()
    || typeof input.answer !== 'string' || !Array.isArray(input.references)
    || !Number.isFinite(Date.parse(input.occurredAt))) return false;
  const allowed = new Set(record.pageRefs.map(page => `${record.courseId}:${page.id}`));
  if (input.references.some(reference => !reference || !allowed.has(reference.sourceId || ''))) return false;
  if (input.source === 'flow_review') {
    const part = record.chunks.find(part => receipt.id === `pm:${record.id}:${part.id}:${input.knowledgePointId}`);
    return Boolean(part?.resultHash && input.occurredAt === record.submittedAt
      && input.answer === record.rawText.slice(part.start, part.end));
  }
  // Membership of the accepted answer snapshot is guaranteed by the verified
  // native auxiliary hash. Do not merge this with the restatement observation.
  return input.source === 'quick_check' && receipt.id.startsWith('pq:')
    && receipt.id.endsWith(`:${input.knowledgePointId}`)
    && receipt.id.length > 3 + input.knowledgePointId.length + 1
    && Date.parse(input.occurredAt) <= Date.parse(record.submittedAt);
}

/** Display adapter only: no calls, state-machine application, cumulative state,
 * numeric score conversion, or mutation of saved reports/receipts. */
export function projectProgressiveReviewFeedback(record: ProgressiveReviewRecord, auxiliary: ProgressiveAuxiliaryResult | null): ProgressiveReviewFeedback {
  const empty: ProgressiveReviewFeedback = { groups: [], warnings: [], pendingKnowledge: false, hasFailures: false };
  if (!auxiliary) return empty;
  if (!record.auxiliaryHash || auxiliary.schemaVersion !== 1 || !Array.isArray(auxiliary.mastery) || auxiliary.mastery.length > 300) {
    return { ...empty, warnings: ['知识点反馈尚未绑定当前归档，未展示其他活动的数据。'] };
  }
  const warnings: string[] = [], groups = new Map<string, ProgressiveFeedbackGroup>();
  const unique = new Map<string, ProgressiveMasteryReceipt>(), conflicted = new Set<string>();
  for (const receipt of auxiliary.mastery) {
    if (!boundReceipt(record, receipt)) { warnings.push('部分反馈的活动、原文或资料绑定无效，已保留为待核验。'); continue; }
    const previous = unique.get(receipt.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(receipt)) {
      conflicted.add(receipt.id); warnings.push('同一评价存在不同回执，未将冲突反馈混合展示。');
    } else unique.set(receipt.id, receipt);
  }
  let hasFailures = false;
  for (const receipt of unique.values()) {
    if (conflicted.has(receipt.id)) continue;
    const source = receipt.input.source as ProgressiveFeedbackGroup['source'];
    const key = JSON.stringify([source, receipt.input.knowledgePointId]);
    let group = groups.get(key);
    if (!group) {
      group = { key, source, knowledgePointId: receipt.input.knowledgePointId, title: receipt.input.knowledgePointTitle, entries: [] };
      groups.set(key, group);
    }
    const base = { id: receipt.id, label: receiptLabel(record, receipt), summary: '', layers: [] as ProgressiveFeedbackLayer[] };
    if (!receipt.result) {
      const error = typeof receipt.error === 'string' ? receipt.error.slice(0, 1400) : undefined;
      hasFailures ||= Boolean(error);
      group.entries.push({ ...base, status: error ? 'failed' : 'pending', ...(error ? { error } : {}) });
      continue;
    }
    try {
      // Saved receipts are revalidated just as on writeback. This does not
      // contact a model or apply another observation to the personal state.
      const evaluation = parseMasteryShadowEvaluation(receipt.result, receipt.input);
      const layers = MASTERY_SHADOW_LAYERS.map(layer => {
        const observation = evaluation.observations.find(row => row.results.some(result => result.layer === layer));
        return { layer, coverage: observation?.coverage || 'unverifiable' as MasteryShadowCoverage,
          verdict: observation?.results.find(result => result.layer === layer)?.verdict || 'unverifiable' as MasteryShadowVerdict,
          assessment: masteryLayerAssessment({ evaluation, references: receipt.input.references }, layer) };
      });
      group.entries.push({ ...base, status: 'evaluated', summary: evaluation.summary, layers });
    } catch {
      hasFailures = true;
      group.entries.push({ ...base, status: 'failed', error: '该评价的证据或响应绑定未通过核对，暂不形成掌握结论。' });
      warnings.push('部分评价尚不可核验；未补造分数或累计掌握状态。');
    }
  }
  return { groups: [...groups.values()], warnings: [...new Set(warnings)], pendingKnowledge: auxiliary.pendingKnowledge, hasFailures };
}

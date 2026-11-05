import type { FlowReviewAnalysisResultV2 } from './productionV2';
import type { FlowStatisticsSubmission } from '../profile/flowStatistics';
import { verifiedShadowUserEvidence } from '../flowShadow/scoring';
import { computeWordCloud } from '../profile/wordCloud';

export function buildFlowStatisticsSubmission(analysis: FlowReviewAnalysisResultV2, episodeId: string, text: string): FlowStatisticsSubmission {
  const record = analysis.record, checked = verifiedShadowUserEvidence(record.input, record.graph, record.assessment);
  const targets = new Set([...record.graph.nodes, ...record.graph.arguments, ...record.graph.relations].map(n => n.id));
  const seen = new Set<string>(), seenIds = new Set<string>(), errors = { confirmed: 0, gaps: 0 };
  for (const issue of record.assessment.issues) {
    if (!issue.id || seenIds.has(issue.id) || !issue.reason.trim() || !['confirmed_internal', 'argument_gap'].includes(issue.kind) || !issue.targetIds.length
      || issue.targetIds.some(id => !targets.has(id)) || !issue.evidenceIds.length
      || issue.evidenceIds.some(id => !checked.evidence.has(id))) continue;
    const key = JSON.stringify([issue.kind, issue.reason.trim(), [...new Set(issue.evidenceIds.map(id => checked.evidence.get(id)!.quote))].sort()]);
    if (seen.has(key)) continue; seen.add(key); seenIds.add(issue.id);
    if (issue.kind === 'confirmed_internal') errors.confirmed++; else errors.gaps++;
  }
  return { version: 1, episodeId, observedAt: analysis.observedAt, rubricVersion: record.rubricVersion,
    sampleChars: text.length, errors, words: computeWordCloud(text) };
}

/** Local-only persistence, after episode/profile commits. Does not invoke LLM/RAG. */
export async function saveFlowStatistics(input: FlowStatisticsSubmission): Promise<void> {
  const api = typeof window === 'undefined' ? undefined : (window as unknown as { electronAPI?: { userState?: {
    recordFlowStatistics?: (input: FlowStatisticsSubmission) => Promise<void> } } }).electronAPI?.userState;
  if (!api) return;
  if (!api.recordFlowStatistics) throw new Error('复盘统计接口尚未更新，请重新编译桌面端');
  await api.recordFlowStatistics(input);
}

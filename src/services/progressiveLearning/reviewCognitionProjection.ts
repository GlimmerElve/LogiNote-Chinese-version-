import type { RestatementObservation } from '../cognition/types';
import type { FlowAnalysisV2Bundle } from '../flowAnalysis/productionV2';
import type { ProgressiveReviewRecord } from './reviewTypes';
import type { ArgDoc } from '../argumentDoc/types';

/** Pure source projection shared by the native authority and offline tests. */
export function progressiveCognitionObservations(record: ProgressiveReviewRecord, parts: FlowAnalysisV2Bundle[], title: string, confirmedGraphs?: ArgDoc[]): RestatementObservation[] {
  if (record.status !== 'analyzed' || parts.length !== record.chunks.length)
    throw Error('复盘主分析尚未完整保存，未写入个人认知');
  const edited = record.editedText !== undefined && record.editedText !== record.rawText;
  return record.chunks.map((part, index) => {
    const result = parts[index], analysisId = `${record.id}:${part.id}`;
    const input = result?.analysisV2?.record?.input;
    if (!part.resultHash || result?.analysisV2?.analysisRunId !== analysisId || input?.attemptId !== analysisId
      || input.rawText !== record.rawText.slice(part.start, part.end)) throw Error('复盘分段与已保存原文不一致，未写入个人认知');
    const doc = confirmedGraphs?.[index] || result.argumentDoc;
    if (!doc || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) throw Error('已保存复盘图缺失，个人认知尚未写入');
    const text = edited ? record.editedText!.slice(part.start, index === record.chunks.length - 1 ? undefined : part.end) : input.rawText;
    return { noteId: record.projectNoteId, noteTitle: title, recordId: `progressive:${record.courseId}:${record.id}:${part.id}`,
      sessionId: record.id, observedAt: record.submittedAt, updatedAt: record.updatedAt, text,
      ...((!edited || confirmedGraphs) && doc.nodes.length ? { graph: { argumentDocId: doc.doc_id, updatedAt: doc.updated_at,
        structure: { title: doc.title || title,
          nodes: doc.nodes.map(node => ({ id: node.id, text: node.text, ...(node.role ? { role: node.role } : {}), ...(node.mainType ? { mainType: node.mainType } : {}) })),
          edges: doc.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, relation: edge.relation,
            ...(edge.reason ? { reason: edge.reason } : {}) })), ...(doc.flowStructure ? { flowStructure: doc.flowStructure } : {}) } } } : {}) };
  });
}

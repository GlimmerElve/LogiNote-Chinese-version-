import type { ArgDoc } from '../argumentDoc/types';
import type { ProgressiveReviewRecord } from './reviewTypes';

/** Only fields this editor can change. Persistence may re-stamp status, source
 * verification and immutable assessment metadata without making the canvas dirty. */
export function progressiveGraphEditKey(doc: ArgDoc): string {
  return JSON.stringify([doc.title,
    doc.nodes.map(node => [node.id, node.mainType, node.role || null, node.text, node.position.x, node.position.y,
      Boolean(node.collapsed), node.subTypes || '', node.asrNote || '']),
    doc.edges.map(edge => [edge.id, edge.source, edge.target, edge.relation, edge.reason || ''])]);
}

/** Editable graph heads and their bound source, not worker bookkeeping. The
 * displayed draft and the version used for confirmation must share this basis. */
export function progressiveReviewGraphSourceKey(record: ProgressiveReviewRecord): string {
  return JSON.stringify([record.courseId, record.id, record.rawText, record.editedText ?? null,
    record.chunks.map(part => [part.id, part.start, part.end, part.resultHash || null]),
    Object.entries(record.graphDrafts || {}).sort(([left], [right]) => left.localeCompare(right))]);
}

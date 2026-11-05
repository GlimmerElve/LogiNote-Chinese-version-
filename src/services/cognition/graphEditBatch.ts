import type { CognitionAuthorship, CognitionFile, CognitionGraphEdit, CognitionNodeReference } from './types';

/** Compose already confirmed, same-snapshot edits in memory. Storage commits once.
 * Only revision coordinates may advance inside this batch, never changed text,
 * conditions or relation endpoints hidden behind the original confirmation.
 */
export function applyGraphEditBatch(current: CognitionFile, file: CognitionFile, edits: CognitionGraphEdit[],
  stamp: { id: string; at: string }, authorship: CognitionAuthorship,
  apply: (file: CognitionFile, edit: CognitionGraphEdit, stamp: { id: string; at: string }, authorship: CognitionAuthorship) => void) {
  if (!Array.isArray(edits) || !edits.length || edits.length > 20) throw new Error('认知批量变更必须包含1至20项');
  // Validate original version coordinates and every semantic delta independently.
  for (const [index, edit] of edits.entries()) apply(structuredClone(current), edit, { ...stamp, id: `${stamp.id}:${index}` }, authorship);
  const branch = (state: CognitionFile, ref: Omit<CognitionNodeReference, 'nodeId'>) => state.records.find(r => !r.withdrawn && r.id === ref.recordId)
    ?.revisions.at(-1)?.branches.find(b => b.id === ref.branchId);
  const nodeState = (state: CognitionFile, ref: CognitionNodeReference) => {
    const b = branch(state, ref), node = b?.graph.nodes.find(n => n.id === ref.nodeId);
    return node && { node, kind: b!.kind, context: b!.context, stance: b!.stance, title: b!.graph.title };
  };
  const same = (before: unknown, after: unknown) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('同批认知变更相互影响，整组未保存，请重新读取并分别预览');
  };
  const version = (ref: Omit<CognitionNodeReference, 'nodeId'>) => file.records.find(r => !r.withdrawn && r.id === ref.recordId)!.revisions.at(-1)!.id;
  for (const [index, original] of edits.entries()) {
    const edit = structuredClone(original);
    for (const key of ['source', 'target'] as const) if (key in edit) {
      const ref = (edit as { source?: CognitionNodeReference; target?: CognitionNodeReference })[key]!;
      same(nodeState(current, ref), nodeState(file, ref));
      ref.revisionId = version(ref);
    }
    if (edit.action === 'add_node' && edit.parent) {
      const before = branch(current, edit.parent)!, after = branch(file, edit.parent)!;
      same([before.kind, before.context, before.stance, before.graph.title], after && [after.kind, after.context, after.stance, after.graph.title]);
      edit.parent.revisionId = version(edit.parent);
    }
    if ('edge' in edit && edit.edge) {
      const ref = edit.edge;
      if ('linkId' in ref) {
        const before = current.links?.find(e => e.id === ref.linkId), after = file.links?.find(e => e.id === ref.linkId);
        same(before, after);
        for (const endpoint of [before!.source, before!.target]) {
          // Broken links remain removable, but a changed surviving endpoint is not a new approval.
          const point = { ...endpoint, revisionId: '' };
          same(nodeState(current, point), nodeState(file, point));
        }
      } else {
        const before = branch(current, ref)!.graph.edges.find(e => e.id === ref.edgeId)!;
        same(before, branch(file, ref)?.graph.edges.find(e => e.id === ref.edgeId));
        for (const nodeId of [before.source, before.target]) same(nodeState(current, { ...ref, nodeId }), nodeState(file, { ...ref, nodeId }));
        ref.revisionId = version(ref);
      }
    }
    apply(file, edit, { ...stamp, id: `${stamp.id}:${index}` }, authorship);
  }
}

import type { CognitionBranch, CognitionFile, CognitionGraph, CognitionGraphEdit, CognitionNodeReference, CognitionRecord } from './types';
import type { CognitionRevisionEntry, CognitionRevisionRequest, CognitionRevisionSession, CognitionRevisionRecordState } from './revisionTypes';
import { cognitionBeliefHead } from './revisionTypes';

const fail = (message: string): never => { throw new Error(message); };
const last = (record: CognitionRecord) => record.revisions.at(-1)!;
const str = (value: unknown, max = 2000) => typeof value === 'string' && value.trim() && value.length <= max ? value : fail('校订文本为空或过长');
const coord = (ref: Pick<CognitionNodeReference, 'recordId' | 'branchId' | 'nodeId'>) => JSON.stringify([ref.recordId, ref.branchId, ref.nodeId]);
function resolve(file: CognitionFile, ref: CognitionNodeReference) {
  const record = file.records.find(r => !r.withdrawn && r.id === ref?.recordId), revision = record && last(record);
  const node = revision?.branches.find(b => b.id === ref.branchId)?.graph.nodes.find(n => n.id === ref.nodeId);
  if (!record || !node || revision!.id !== ref.revisionId) return fail('校订目标已变化或不存在，请重新读取');
  return { record, node };
}
export function revisionSourceText(record: CognitionRecord) {
  const source = [...record.revisions].reverse().map(v => v.source).find(s => s.kind === 'restatement' || s.kind === 'review_answer');
  return source?.kind === 'restatement' ? source.originalText || '' : source?.kind === 'review_answer' ? source.observation.answer : '';
}
function state(record: CognitionRecord): CognitionRevisionRecordState {
  return { recordId: record.id, branches: structuredClone(last(record).branches), ...(record.withdrawn === undefined ? {} : { withdrawn: record.withdrawn }) };
}
function entryCheck(file: CognitionFile, session: CognitionRevisionSession, entry: CognitionRevisionEntry) {
  const { edit, evidence } = entry || {};
  if (!edit || !evidence || !['source_expression', 'agent_inference', 'user_instruction'].includes(evidence.kind)
    || !Array.isArray(evidence.excerpts) || !evidence.excerpts.length || evidence.excerpts.length > 8) return fail('每项校订必须提供原文依据及解释');
  str(evidence.explanation); if (!edit.meaning) return fail('校订缺少具体语义解释');
  const refs: CognitionNodeReference[] = [];
  if ('target' in edit && typeof edit.target === 'object') refs.push(edit.target);
  if ('source' in edit) refs.push(edit.source);
  if ('edge' in edit && edit.edge) {
    if ('linkId' in edit.edge) {
      const link = file.links?.find(e => e.id === (edit.edge as { linkId: string }).linkId);
      if (!link) return fail('原关系不存在');
      for (const endpoint of [link.source, link.target]) {
        const record = file.records.find(r => r.id === endpoint.recordId);
        // A dangling link can be removed, not silently redirected to a guessed node.
        if (record && last(record).branches.some(b => b.id === endpoint.branchId && b.graph.nodes.some(n => n.id === endpoint.nodeId)))
          refs.push({ ...endpoint, revisionId: last(record).id });
      }
    } else {
      const reference = edit.edge, record = file.records.find(r => r.id === reference.recordId);
      const revision = record && last(record), branch = revision?.branches.find(b => b.id === reference.branchId);
      const edge = branch?.graph.edges.find(e => e.id === reference.edgeId);
      if (!edge || revision!.id !== reference.revisionId) return fail('原关系已变化');
      for (const nodeId of [edge.source, edge.target]) refs.push({ recordId: record!.id, revisionId: revision!.id, branchId: branch!.id, nodeId });
    }
  }
  for (const excerpt of evidence.excerpts) {
    const { record, node } = resolve(file, excerpt.target);
    if (!session.recordIds.includes(record.id)) return fail('原文依据超出校订范围');
    const quote = str(excerpt.text, 20000);
    if (!node.text.includes(quote) && !revisionSourceText(record).includes(quote)) return fail('校订依据不是目标原文中的逐字片段');
  }
  for (const ref of refs) {
    resolve(file, ref); if (!session.recordIds.includes(ref.recordId)) return fail('校订对象超出授权范围');
    if (!evidence.excerpts.some(e => coord(e.target) === coord(ref))) return fail('关系两端或被修改节点均须提供原文依据');
  }
  if ('edge' in edit && edit.edge) {
    if ('linkId' in edit.edge) {
      const edge = file.links?.find(link => link.id === (edit.edge as { linkId: string }).linkId);
      if (!edge || ![edge.source.recordId, edge.target.recordId].every(id => session.recordIds.includes(id))) return fail('原关系不存在或超出校订范围');
    } else if (!session.recordIds.includes(edit.edge.recordId)) return fail('原关系超出校订范围');
  }
  if (edit.action === 'add_node') {
    if (!edit.parent || !session.recordIds.includes(edit.parent.recordId)) return fail('补出认知块必须归入授权的原始记录');
    const record = file.records.find(r => !r.withdrawn && r.id === edit.parent!.recordId);
    if (!record) return fail('新增块的记录已撤回');
    if (last(record).id !== edit.parent.revisionId || !last(record).branches.some(b => b.id === edit.parent!.branchId)) return fail('新增块的原分支已变化');
    if (session.mode === 'automatic' && (!revisionSourceText(record).includes(edit.text) || evidence.kind !== 'source_expression')) return fail('自动补块只能逐字恢复用户原始表达，不能生成新的用户信念');
  }
  if (session.mode === 'automatic' && edit.action === 'update_node') {
    const { record } = resolve(file, edit.target);
    if (evidence.kind !== 'source_expression' || !revisionSourceText(record).includes(edit.text)) return fail('自动正文校订只能恢复原始表达；新的观点或条件需共同讨论后明确采用');
  }
  if (session.mode === 'automatic' && edit.action === 'delete_node') return fail('自动校订不删除用户表述；请在共同讨论中明确采用删除方案');
}
function rebaseEdit(file: CognitionFile, edit: CognitionGraphEdit): CognitionGraphEdit {
  const result = structuredClone(edit) as any;
  const version = (id: string) => last(file.records.find(r => r.id === id)!).id;
  for (const key of ['source', 'target', 'parent']) if (result[key]?.recordId) result[key].revisionId = version(result[key].recordId);
  if (result.edge?.recordId) result.edge.revisionId = version(result.edge.recordId);
  return result;
}

export function validateRevisionData(file: CognitionFile, graph: (raw: unknown, allowEmpty?: boolean) => CognitionGraph) {
  const ref = (r: CognitionNodeReference) => {
    if (!r || typeof r !== 'object') return fail('校订坐标损坏');
    for (const key of ['recordId', 'branchId', 'nodeId', 'revisionId'] as const) str(r[key], key === 'recordId' ? 300 : 200);
  };
  if (file.beliefHead !== undefined) str(file.beliefHead, 300);
  if (file.revisionSessions !== undefined && !Array.isArray(file.revisionSessions)) return fail('校订会话损坏');
  if (file.revisionBatches !== undefined && !Array.isArray(file.revisionBatches)) return fail('校订记录损坏');
  const sessions = new Set<string>(), batches = new Set<string>();
  for (const s of file.revisionSessions || []) {
    str(s.id, 200); str(s.ownerId, 200); str(s.goal, 4000);
    if (sessions.has(s.id) || !['automatic', 'collaborative'].includes(s.mode) || !['active', 'stopped'].includes(s.status)
      || !Array.isArray(s.recordIds) || !s.recordIds.length || new Set(s.recordIds).size !== s.recordIds.length || s.recordIds.some(id => typeof id !== 'string' || id.length > 300)
      || !Number.isInteger(s.maxChanges) || s.maxChanges < 1 || s.maxChanges > 100 || !Number.isInteger(s.changeCount) || s.changeCount < 0 || s.changeCount > s.maxChanges
      || !Array.isArray(s.notes) || s.notes.length > 20 || s.notes.some(note => typeof note !== 'string' || note.length > 2000)
      || !Array.isArray(s.focus) || s.focus.length > 16 || typeof s.lastUserRequest !== 'string' || s.lastUserRequest.length > 4000
      || !Number.isFinite(Date.parse(s.createdAt)) || !Number.isFinite(Date.parse(s.updatedAt))) return fail('校订会话格式无效');
    sessions.add(s.id);
    s.focus.forEach(ref);
  }
  for (const b of file.revisionBatches || []) {
    str(b.id, 200); str(b.sessionId, 200); str(b.summary, 4000); str(b.beforeHead, 300); str(b.afterHead, 300);
    if (batches.has(b.id) || !sessions.has(b.sessionId) || !Number.isFinite(Date.parse(b.at)) || (b.undoneAt !== undefined && !Number.isFinite(Date.parse(b.undoneAt)))
      || !['session_authorized', 'user_confirmed'].includes(b.acceptance) || !Array.isArray(b.entries) || !b.entries.length || b.entries.length > 20
      || typeof b.userRequest !== 'string' || b.userRequest.length > 4000
      || ![b.beforeRecords, b.afterRecords, b.beforeLinks, b.afterLinks].every(Array.isArray)) return fail('校订批次格式无效');
    for (const snapshot of [...b.beforeRecords, ...b.afterRecords]) {
      str(snapshot.recordId, 300);
      if (!Array.isArray(snapshot.branches) || !snapshot.branches.length) return fail('校订撤销快照损坏');
      if (snapshot.withdrawn !== undefined && typeof snapshot.withdrawn !== 'boolean') return fail('撤销状态损坏');
      if (snapshot.branches.filter(branch => branch.id === 'primary' && branch.kind === 'primary').length !== 1) return fail('撤销主分支损坏');
      const ids = new Set<string>();
      for (const branch of snapshot.branches) {
        str(branch.id, 200); if (ids.has(branch.id) || !['primary', 'contextual', 'alternative'].includes(branch.kind) || !['endorsed', 'tentative'].includes(branch.stance) || typeof branch.context !== 'string') return fail('撤销分支损坏');
        ids.add(branch.id); graph(branch.graph, true);
      }
    }
    for (const link of [...b.beforeLinks, ...b.afterLinks]) {
      str(link.id, 300);
      for (const endpoint of [link.source, link.target]) { str(endpoint.recordId, 300); str(endpoint.branchId, 200); str(endpoint.nodeId, 200); }
      graph({ title: '', nodes: [{ id: 's', text: 's', mainType: '事实陈述' }, { id: 't', text: 't', mainType: '事实陈述' }], edges: [{ ...link, source: 's', target: 't' }] });
    }
    for (const entry of b.entries) {
      if (!entry?.edit || !entry.evidence || !['source_expression', 'agent_inference', 'user_instruction'].includes(entry.evidence.kind)
        || !Array.isArray(entry.evidence.excerpts) || !entry.evidence.excerpts.length || entry.evidence.excerpts.length > 8) return fail('校订依据损坏');
      str(entry.evidence.explanation); entry.evidence.excerpts.forEach(e => { ref(e.target); str(e.text, 20000); });
    }
    batches.add(b.id);
  }
}

export function applyRevisionRequest(current: CognitionFile, request: CognitionRevisionRequest, stamp: { id: string; at: string }, ports: {
  edit: (file: CognitionFile, edit: CognitionGraphEdit, stamp: { id: string; at: string }) => void;
  refresh: (before: CognitionFile, after: CognitionFile, stamp: { id: string; at: string }) => void;
}): CognitionFile {
  if (request.confirmed !== true || request.expectedRevision !== current.revision) return fail('校订确认或版本已失效，请重新核对');
  const file = structuredClone(current); file.beliefHead ||= cognitionBeliefHead(current);
  file.revisionSessions ||= []; file.revisionBatches ||= [];
  if (request.kind === 'begin_revision_session') {
    const input = request.session;
    if (!input || !Array.isArray(input.recordIds) || input.recordIds.some(id => !file.records.some(r => !r.withdrawn && r.id === id))) return fail('请选择真实、有效的认知记录作为校订范围');
    if (file.revisionSessions.some(s => s.id === input.id)) return fail('校订会话已存在');
    for (const s of file.revisionSessions) if (s.ownerId === input.ownerId && s.status === 'active') { s.status = 'stopped'; s.updatedAt = stamp.at; }
    file.revisionSessions.push({ ...structuredClone(input), status: 'active', changeCount: 0, createdAt: stamp.at, updatedAt: stamp.at, focus: [], notes: [], lastUserRequest: '' });
  } else if (request.kind === 'undo_revision_batch') {
    const batch = file.revisionBatches.find(b => b.id === request.batchId), session = batch && file.revisionSessions.find(s => s.id === batch.sessionId);
    if (!batch || !session || session.ownerId !== request.ownerId || batch.undoneAt) return fail('校订批次不存在、已撤销或不属于当前会话');
    if (cognitionBeliefHead(file) !== batch.afterHead) return fail('认知库在此批次之后已有其他修改；请先撤销较新的批次，不能覆盖后续认识');
    for (const snapshot of batch.beforeRecords) {
      const record = file.records.find(r => r.id === snapshot.recordId); if (!record) return fail('待撤销的原记录已不存在');
      record.revisions.push({ id: `${stamp.id}:${record.id}`.slice(0, 200), number: record.revisions.length + 1, at: stamp.at,
        operation: 'revise', reason: `撤销校订：${batch.summary}`, authorship: 'own_expression', source: { kind: 'manual_revision', docId: record.id },
        branches: structuredClone(snapshot.branches), factSupport: 'not_assessed', mastery: 'not_assessed' });
      if (snapshot.withdrawn === undefined) delete record.withdrawn; else record.withdrawn = snapshot.withdrawn;
    }
    const affected = new Set([...batch.beforeLinks, ...batch.afterLinks].map(link => link.id));
    file.links = [...(file.links || []).filter(link => !affected.has(link.id)), ...structuredClone(batch.beforeLinks)];
    file.linkHistory ||= [];
    for (const link of batch.afterLinks) file.linkHistory.push({ id: `${stamp.id}:remove:${link.id}`, at: stamp.at, reason: `撤销校订：${batch.summary}`, before: link });
    for (const link of batch.beforeLinks) file.linkHistory.push({ id: `${stamp.id}:restore:${link.id}`, at: stamp.at, reason: `撤销校订：${batch.summary}`, after: link });
    batch.undoneAt = stamp.at; file.beliefHead = batch.beforeHead; session.updatedAt = stamp.at;
  } else {
    const session = file.revisionSessions.find(s => s.id === request.sessionId && s.ownerId === request.ownerId);
    if (!session || session.status !== 'active') return fail('校订会话已结束或不属于当前对话');
    if (request.kind === 'update_revision_session') {
      if (request.focus) { for (const ref of request.focus) { resolve(file, ref); if (!session.recordIds.includes(ref.recordId)) return fail('校订焦点超出范围'); } session.focus = structuredClone(request.focus); }
      if (request.note) session.notes = [...session.notes, str(request.note)].slice(-20);
      if (request.userRequest !== undefined) session.lastUserRequest = str(request.userRequest, 4000);
      if (request.stop) session.status = 'stopped';
      session.updatedAt = stamp.at;
    } else {
      if (!Array.isArray(request.entries) || !request.entries.length || request.entries.length > 20 || session.changeCount + request.entries.length > session.maxChanges) return fail('校订批次数量为空、过多或超过本次授权上限');
      if (file.revisionBatches.some(b => b.id === request.batchId)) return fail('此校订批次已经执行，不会重复写入');
      if (!['session_authorized', 'user_confirmed'].includes(request.acceptance) || (session.mode === 'collaborative' && request.acceptance !== 'user_confirmed')) return fail('共同讨论必须明确采用当前批次后才能应用');
      str(request.batchId, 200); str(request.summary, 4000); str(request.userRequest, 4000);
      for (const entry of request.entries) entryCheck(current, session, entry);
      for (const [index, entry] of request.entries.entries()) {
        const operationStamp = { ...stamp, id: `${stamp.id}:${index}` };
        const edgeKey = (r: string, b: string, e: string) => JSON.stringify([r, b, e]);
        const beforeEdgeIds = new Set(file.records.flatMap(r => last(r).branches.flatMap(b => b.graph.edges.map(e => edgeKey(r.id, b.id, e.id)))));
        const beforeLinkIds = new Set((file.links || []).map(link => link.id));
        ports.edit(file, rebaseEdit(file, entry.edit), operationStamp);
        const origin = { sessionId: session.id, batchId: request.batchId, kind: entry.evidence.kind, acceptance: request.acceptance };
        for (const record of file.records) for (const branch of last(record).branches) for (const edge of branch.graph.edges) if (!beforeEdgeIds.has(edgeKey(record.id, branch.id, edge.id))) edge.revisionOrigin = origin;
        for (const link of file.links || []) if (!beforeLinkIds.has(link.id)) link.revisionOrigin = origin;
      }
      ports.refresh(current, file, stamp);
      const changedRecords = file.records.filter(record => JSON.stringify(record) !== JSON.stringify(current.records.find(r => r.id === record.id)));
      const changedLinkIds = new Set([...current.links || [], ...file.links || []].filter(link => {
        const before = current.links?.find(l => l.id === link.id), after = file.links?.find(l => l.id === link.id); return JSON.stringify(before) !== JSON.stringify(after);
      }).map(link => link.id));
      file.revisionBatches.push({ id: request.batchId, sessionId: session.id, at: stamp.at, summary: request.summary, userRequest: request.userRequest,
        acceptance: request.acceptance, entries: structuredClone(request.entries), beforeHead: cognitionBeliefHead(current), afterHead: stamp.id,
        beforeRecords: changedRecords.map(record => state(current.records.find(r => r.id === record.id)!)), afterRecords: changedRecords.map(state),
        beforeLinks: structuredClone((current.links || []).filter(l => changedLinkIds.has(l.id))), afterLinks: structuredClone((file.links || []).filter(l => changedLinkIds.has(l.id))) });
      file.beliefHead = stamp.id; session.changeCount += request.entries.length; session.updatedAt = stamp.at;
      session.lastUserRequest = request.userRequest;
    }
  }
  file.revision += 1;
  return file;
}

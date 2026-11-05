import type { CognitionBranch, CognitionFile, CognitionGraph, CognitionGraphEdit, CognitionMutation, CognitionRecord, CognitionLink, CognitionNodeReference } from './types.ts';
import { COGNITION_OPERATION_LABELS, COGNITION_RELATION_LABELS } from './types.ts';
import { ALL_ARGUMENT_ROLES, ALL_ARGUMENT_TYPES } from '../argumentDoc/types.ts';
import { readFlowStructure } from '../argumentDoc/flowStructure';
import { cognitionPhrases, cognitionTextIncludes, parseCognitionMeaning, resolveCognitionConditions } from './semantics.ts';
import { cognitionCandidateId, cognitionCandidateRecordId, isCognitionCandidateText, parseCognitionCandidates, parseCognitionObservation } from './observations.ts';
import { restatementRecordId } from './restatements.ts';
import { applyRevisionRequest, validateRevisionData } from './revisionCore';
import { readRelationOrigin } from './revisionTypes';
import { applyGraphEditBatch } from './graphEditBatch';
import type { CognitionRevisionRequest } from './revisionTypes';

export const emptyCognitionFile = (): CognitionFile => ({ schemaVersion: 1, revision: 0, records: [] });
const fail = (message: string): never => { throw new Error(message); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('认知数据格式无效');
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 20000, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) return fail(`${label}为空或超出长度限制`);
  return value;
}
const TYPES = new Set<string>(ALL_ARGUMENT_TYPES);
const ROLES = new Set<string>(ALL_ARGUMENT_ROLES);
const RELATIONS = new Set<string>(Object.keys(COGNITION_RELATION_LABELS));

/** Only user-visible propositions/relations; AI summaries, grades and instructions are not beliefs. */
export function cognitionGraph(value: unknown, allowEmpty = false): CognitionGraph {
  const input = object(value);
  if (!Array.isArray(input.nodes) || (!allowEmpty && !input.nodes.length) || input.nodes.length > 2000
    || !Array.isArray(input.edges) || input.edges.length > 10000) return fail('请提供非空、大小合理的论证结构');
  const ids = new Set<string>();
  const nodes = input.nodes.map((raw) => {
    const n = object(raw);
    const id = text(n.id, '节点 ID', 200);
    if (ids.has(id)) return fail('节点 ID 重复');
    ids.add(id);
    if (n.mainType !== undefined && !TYPES.has(n.mainType as string)) return fail('历史论证节点类型无效');
    if (n.role !== undefined && !ROLES.has(n.role as string)) return fail('论证节点角色无效');
    if (n.stance !== undefined && !['endorsed', 'tentative'].includes(n.stance as string)) return fail('节点认同状态无效');
    const body = text(n.text, '节点文本'), conditions = n.conditions === undefined ? undefined : cognitionPhrases(n.conditions);
    if (conditions?.some(condition => !cognitionTextIncludes(body, condition))) return fail('已记录条件不在节点正文中');
    return { id, text: body, ...(n.mainType === undefined ? {} : { mainType: n.mainType as CognitionGraph['nodes'][number]['mainType'] }),
      ...(conditions === undefined ? {} : { conditions }),
      ...(n.role === undefined ? {} : { role: n.role as CognitionGraph['nodes'][number]['role'] }),
      ...(n.stance === undefined ? {} : { stance: n.stance as 'endorsed' | 'tentative' }) };
  });
  const edgeIds = new Set<string>();
  const edges = input.edges.map((raw) => {
    const e = object(raw);
    const id = text(e.id, '连线 ID', 200);
    if (edgeIds.has(id) || !ids.has(e.source as string) || !ids.has(e.target as string)
      || !RELATIONS.has(e.relation as string)) return fail('连线重复、引用缺失或关系类型无效');
    edgeIds.add(id);
    return { id, source: e.source as string, target: e.target as string, relation: e.relation as CognitionGraph['edges'][number]['relation'],
      ...(e.revisionOrigin === undefined ? {} : { revisionOrigin: readRelationOrigin(e.revisionOrigin) }),
      ...(typeof e.reason === 'string' && e.reason.trim() ? { reason: text(e.reason, '关系说明', 2000) } : {}) };
  });
  const flowStructure = readFlowStructure(input.flowStructure);
  return { title: text(input.title, '标题', 1000, true), nodes, edges, ...(flowStructure ? { flowStructure } : {}) };
}

/** Fail closed: corrupt/unsupported private data must never be treated as an empty writable file. */
export function parseCognitionFile(value: unknown): CognitionFile {
  const file = object(value);
  if (file.schemaVersion !== 1 || !Number.isSafeInteger(file.revision) || (file.revision as number) < 0 || !Array.isArray(file.records)) return fail('认知库版本或结构无效，请先恢复备份');
  const recordIds = new Set<string>();
  for (const raw of file.records) {
    const r = object(raw);
    const id = text(r.id, '认知 ID', 300);
    if (recordIds.has(id) || id !== r.docId || !Array.isArray(r.revisions) || !r.revisions.length) return fail('认知记录损坏');
    recordIds.add(id);
    if (r.withdrawn !== undefined && typeof r.withdrawn !== 'boolean') return fail('认知撤回状态无效');
    for (const [i, rawRevision] of r.revisions.entries()) {
      const v = object(rawRevision);
      if (v.number !== i + 1 || !Object.hasOwn(COGNITION_OPERATION_LABELS, v.operation as string)
        || !Array.isArray(v.branches) || !v.branches.length || v.factSupport !== 'not_assessed' || v.mastery !== 'not_assessed'
        || !['own_expression', 'adopted_with_assistance'].includes(v.authorship as string)) return fail('认知版本损坏');
      text(v.id, '版本 ID', 200);
      if (Number.isNaN(Date.parse(text(v.at, '版本时间', 100)))) return fail('认知版本时间无效');
      text(v.reason, '更新说明', 4000, true);
      if (v.meaning !== undefined) parseCognitionMeaning(v.meaning);
      const source = object(v.source);
      if (source.docId !== r.docId) return fail('认知来源损坏');
      if (source.kind === 'argument_editor') {
        if (source.noteId !== undefined) text(source.noteId, '来源笔记', 200);
      } else if (source.kind === 'review_answer') {
        const observation = parseCognitionObservation(source.observation);
        if (source.candidateId !== cognitionCandidateId(observation)) return fail('回答来源损坏');
        if (source.automatic !== undefined && typeof source.automatic !== 'boolean') return fail('回答记录方式无效');
      } else if (source.kind === 'restatement') {
        const key = { noteId: text(source.noteId, '来源笔记', 200), recordId: text(source.recordId, '复述记录', 200) };
        text(source.sessionId, '学习会话', 200);
        if (!Number.isFinite(Date.parse(text(source.updatedAt, '复述更新时间', 100)))) return fail('复述更新时间无效');
        if (source.automatic !== true || restatementRecordId(key) !== r.docId || !Number.isFinite(Date.parse(text(source.observedAt, '复述时间', 100)))) return fail('复述来源损坏');
        if (source.originalText !== undefined) text(source.originalText, '复述原文', 200000, true);
        if (source.graph !== undefined) {
          const graph = object(source.graph);
          text(graph.argumentDocId, '复盘图来源', 200);
          if (source.originalText === undefined || !Number.isFinite(Date.parse(text(graph.updatedAt, '复盘图时间', 100)))) return fail('复盘图来源损坏');
        }
      } else if (source.kind !== 'manual_revision') return fail('认知来源损坏');
      const branchIds = new Set<string>();
      for (const rawBranch of v.branches) {
        const b = object(rawBranch);
        const branchId = text(b.id, '分支 ID', 200);
        if (branchIds.has(branchId) || !['primary', 'contextual', 'alternative'].includes(b.kind as string)
          || !['endorsed', 'tentative'].includes(b.stance as string)) return fail('认知分支损坏');
        branchIds.add(branchId);
        text(b.context, '分支情境', 4000, true);
        // Empty current branches are valid only after an explicit manual deletion,
        // not a way to silently accept corrupt automatic-source graphs as empty.
        const inheritedEmpty = i > 0 && (r.revisions[i - 1] as CognitionRecord['revisions'][number]).branches.some(prior => prior.id === branchId && prior.graph.nodes.length === 0);
        const graph = cognitionGraph(b.graph, source.kind === 'manual_revision' || inheritedEmpty);
        if (b.reviewNeededNodeIds !== undefined && (!Array.isArray(b.reviewNeededNodeIds)
          || new Set(b.reviewNeededNodeIds).size !== b.reviewNeededNodeIds.length
          || !b.reviewNeededNodeIds.every((id) => graph.nodes.some((n) => n.id === id)))) return fail('待复核节点损坏');
      }
      if (v.branches.filter((b: CognitionBranch) => b.kind === 'primary' && b.id === 'primary').length !== 1) return fail('认知主分支损坏');
      if (v.change !== undefined) {
        const c = object(v.change);
        const prior = r.revisions[i - 1] as CognitionRecord['revisions'][number] | undefined;
        const before = prior?.branches.find((b) => b.id === c.branchId);
        const after = (v.branches as CognitionBranch[]).find((b) => b.id === c.resultBranchId);
        if (c.recordId !== id || c.revisionId !== prior?.id || c.operation !== v.operation || c.operation === 'initial'
          || !before?.graph.nodes.some((n) => n.id === c.nodeId) || !after?.graph.nodes.some((n) => n.id === c.resultNodeId)) return fail('认知变更目标损坏');
        text(c.reason, '变更说明', 4000);
      }
    }
  }
  const result = structuredClone(value) as CognitionFile;
  if (file.links !== undefined) {
    if (!Array.isArray(file.links) || file.links.length > 10000) return fail('跨活动关系格式无效');
    const ids = new Set<string>();
    result.links = file.links.map(raw => { const link = parseLink(raw); if (ids.has(link.id)) return fail('跨活动关系重复'); ids.add(link.id); return link; });
  }
  if (file.linkHistory !== undefined) {
    if (!Array.isArray(file.linkHistory)) return fail('关系历史格式无效');
    result.linkHistory = file.linkHistory.map(raw => {
      const row = object(raw); const id = text(row.id, '关系历史 ID', 300), at = text(row.at, '关系历史时间', 100);
      if (!Number.isFinite(Date.parse(at)) || (!row.before && !row.after)) return fail('关系历史损坏');
      return { id, at, reason: text(row.reason, '关系变更说明', 4000), ...(row.meaning ? { meaning: parseCognitionMeaning(row.meaning) } : {}), ...(row.before ? { before: parseLink(row.before) } : {}), ...(row.after ? { after: parseLink(row.after) } : {}) };
    });
  }
  if (file.restatementSync !== undefined) {
    if (!Array.isArray(file.restatementSync)) return fail('复述同步回执损坏');
    const seen = new Set<string>();
    for (const raw of file.restatementSync) {
      const row = object(raw), id = text(row.id, '复述同步来源', 300);
      if (!id.startsWith('restatement:') || seen.has(id) || !Number.isFinite(Date.parse(text(row.updatedAt, '复述同步时间', 100)))) return fail('复述同步回执损坏');
      seen.add(id);
    }
  }
  if (file.suppressedSourceIds !== undefined && (!Array.isArray(file.suppressedSourceIds)
    || new Set(file.suppressedSourceIds).size !== file.suppressedSourceIds.length
    || file.suppressedSourceIds.some(id => typeof id !== 'string' || !id || id.length > 300))) return fail('认知遗忘回执损坏');
  if (file.candidates !== undefined) result.candidates = parseCognitionCandidates(file.candidates);
  for (const candidate of result.candidates || []) {
    if (candidate.status === 'accepted' && !result.records.some((r) => r.id === candidate.recordId && r.revisions.some((v) =>
      v.source.kind === 'review_answer' && v.source.candidateId === candidate.id))) return fail('已采纳候选缺少来源版本');
  }
  validateRevisionData(result, cognitionGraph);
  return result;
}

export function latestCognition(record: CognitionRecord) { return record.revisions[record.revisions.length - 1]; }

export const cognitionCoordinate = (reference: Pick<CognitionNodeReference, 'recordId' | 'branchId' | 'nodeId'>) => JSON.stringify([reference.recordId, reference.branchId, reference.nodeId]);
function parseNodeReference(raw: unknown, versioned = false) {
  const value = object(raw);
  return { recordId: text(value.recordId, '认知 ID', 300), branchId: text(value.branchId, '分支 ID', 200), nodeId: text(value.nodeId, '节点 ID', 200),
    ...(versioned ? { revisionId: text(value.revisionId, '认知版本', 200) } : {}) };
}
function parseLink(raw: unknown): CognitionLink {
  const row = object(raw); if (!RELATIONS.has(row.relation as string)) return fail('关联类型无效');
  return { id: text(row.id, '关系 ID', 300), source: parseNodeReference(row.source), target: parseNodeReference(row.target), relation: row.relation as CognitionLink['relation'],
    ...(row.revisionOrigin === undefined ? {} : { revisionOrigin: readRelationOrigin(row.revisionOrigin) }),
    ...(row.reason !== undefined ? { reason: text(row.reason, '关系说明', 2000, true) } : {}) };
}

/** Explicit graph edits only. Caller still needs a matching file revision and human confirmation. */
function applyGraphEdit(file: CognitionFile, raw: unknown, stamp: { id: string; at: string }, authorship: 'own_expression' | 'adopted_with_assistance') {
  const edit = object(raw), reason = text(edit.reason, '变更说明', 2000);
  const meaning = edit.meaning === undefined ? undefined : parseCognitionMeaning(edit.meaning);
  if (authorship === 'adopted_with_assistance' && !meaning) return fail('助手变更缺少语义解释，请重新生成完整预览');
  if (edit.action !== 'update_node' && meaning && (meaning.conditions || meaning.preserved.length)) return fail('非正文修改不能夹带条件变更或正文保留声明');
  if (edit.action === 'update_node' && edit.operation === 'qualify' && authorship === 'adopted_with_assistance' && !meaning?.conditions) return fail('助手条件调整必须逐项区分新增、移除或替换');
  const touched = new Map<string, CognitionBranch[]>();
  const resolve = (raw: unknown) => {
    const ref = parseNodeReference(raw, true), record = file.records.find(r => !r.withdrawn && r.id === ref.recordId);
    if (!record || latestCognition(record).id !== ref.revisionId) return fail('目标认知已变化或不存在，请重新查找并核对');
    const branch = (touched.get(record.id) || latestCognition(record).branches).find(b => b.id === ref.branchId);
    const node = branch?.graph.nodes.find(n => n.id === ref.nodeId);
    if (!branch || !node) return fail('目标节点不存在');
    return { ref, record, branch, node };
  };
  const touch = (record: CognitionRecord) => {
    if (!touched.has(record.id)) touched.set(record.id, structuredClone(latestCognition(record).branches));
    return touched.get(record.id)!;
  };
  const history = (before?: CognitionLink, after?: CognitionLink) => {
    file.linkHistory ||= []; file.linkHistory.push({ id: `${stamp.id}:${file.linkHistory.length}`, at: stamp.at, reason, ...(meaning ? { meaning } : {}), ...(before ? { before } : {}), ...(after ? { after } : {}) });
  };
  const removeEdge = (raw: unknown) => {
    const ref = object(raw);
    if (ref.linkId !== undefined) {
      const linkId = text(ref.linkId, '关系 ID', 300), link = file.links?.find(l => l.id === linkId);
      if (!link) return fail('关系已不存在');
      file.links = file.links!.filter(l => l.id !== linkId); history(link); return link.id;
    }
    const record = file.records.find(r => !r.withdrawn && r.id === ref.recordId);
    if (!record || latestCognition(record).id !== ref.revisionId) return fail('关系所属认知已变化');
    const branch = touch(record).find(b => b.id === ref.branchId), edge = branch?.graph.edges.find(e => e.id === ref.edgeId);
    if (!branch || !edge) return fail('关系已不存在');
    const before = structuredClone(branch); branch.graph.edges = branch.graph.edges.filter(e => e.id !== edge.id);
    markDownstream(before, branch, [edge.target]);
    branch.reviewNeededNodeIds = [...new Set([...(branch.reviewNeededNodeIds || []), edge.target])];
    return edge.id;
  };
  if (edit.action === 'update_node') {
    const { ref, node } = resolve(edit.target);
    if (!['revise', 'qualify', 'add_conditions', 'remove_conditions', 'replace_conditions', 'certainty'].includes(edit.operation as string)) return fail('修改方式无效');
    applyTargetedUpdate(file, { ...edit, target: { ...ref, operation: edit.operation, reason }, authorship }, stamp);
    const branch = latestCognition(file.records.find(r => r.id === ref.recordId)!).branches.find(b => b.id === ref.branchId)!;
    const updated = branch.graph.nodes.find(n => n.id === ref.nodeId)!;
    return;
  }
  if (edit.action === 'add_node') {
    if (!edit.role && !edit.mainType) return fail('新增认知块请选择主张、前提、背景或方法角色');
    const node = cognitionGraph({ title: edit.title, nodes: [{ id: `node:${stamp.id}`, text: edit.text, mainType: edit.mainType, stance: edit.stance, ...(edit.role ? { role: edit.role } : {}) }], edges: [] }).nodes[0];
    if (!['endorsed', 'tentative'].includes(edit.stance as string)) return fail('认同状态无效');
    if (edit.parent) {
      const parent = object(edit.parent), record = file.records.find(r => !r.withdrawn && r.id === parent.recordId);
      if (!record || latestCognition(record).id !== parent.revisionId) return fail('目标认知已变化');
      const branch = touch(record).find(b => b.id === parent.branchId); if (!branch) return fail('目标分支不存在');
      branch.graph.nodes.push(node);
    } else {
      const id = `manual:${stamp.id}`; if (file.records.some(r => r.id === id)) return fail('新增认知 ID 冲突');
      file.records.push({ id, docId: id, revisions: [{ id: stamp.id, number: 1, at: stamp.at, operation: 'initial', reason, authorship,
        ...(meaning ? { meaning } : {}),
        source: { kind: 'manual_revision', docId: id }, branches: [{ id: 'primary', kind: 'primary', context: '', stance: edit.stance as 'endorsed' | 'tentative', graph: { title: text(edit.title, '认知主题', 1000), nodes: [node], edges: [] } }], factSupport: 'not_assessed', mastery: 'not_assessed' }] });
    }
  } else if (edit.action === 'delete_node') {
    const { ref, record } = resolve(edit.target), branch = touch(record).find(b => b.id === ref.branchId)!;
    const before = structuredClone(branch); branch.graph.nodes = branch.graph.nodes.filter(n => n.id !== ref.nodeId);
    branch.graph.edges = branch.graph.edges.filter(e => e.source !== ref.nodeId && e.target !== ref.nodeId);
    markDownstream(before, branch, [ref.nodeId]);
    for (const link of file.links || []) if ([link.source, link.target].some(point => cognitionCoordinate(point) === cognitionCoordinate(ref))) history(link);
    file.links = (file.links || []).filter(link => ![link.source, link.target].some(point => cognitionCoordinate(point) === cognitionCoordinate(ref)));
  } else if (edit.action === 'delete_relation') {
    removeEdge(edit.edge);
  } else if (edit.action === 'add_relation' || edit.action === 'update_relation') {
    const source = resolve(edit.source), target = resolve(edit.target);
    if (cognitionCoordinate(source.ref) === cognitionCoordinate(target.ref)) return fail('不能将认知块关联到自身');
    if (!RELATIONS.has(edit.relation as string)) return fail('关联类型无效');
    if (edit.action === 'update_relation') removeEdge(edit.edge);
    const id = `edge:${stamp.id}`;
    if (source.record.id === target.record.id && source.branch.id === target.branch.id) {
      const branch = touch(source.record).find(b => b.id === source.branch.id)!;
      if (branch.graph.edges.some(e => e.source === source.node.id && e.target === target.node.id && e.relation === edit.relation)) return fail('同方向同类型的关系已经存在');
      const before = structuredClone(branch);
      branch.graph.edges.push({ id, source: source.node.id, target: target.node.id, relation: edit.relation as CognitionLink['relation'], reason });
      markDownstream(before, branch, [target.node.id]);
      branch.reviewNeededNodeIds = [...new Set([...(branch.reviewNeededNodeIds || []), target.node.id])];
    } else {
      const link = parseLink({ id, source: source.ref, target: target.ref, relation: edit.relation, reason });
      if ((file.links || []).some(l => cognitionCoordinate(l.source) === cognitionCoordinate(link.source) && cognitionCoordinate(l.target) === cognitionCoordinate(link.target) && l.relation === link.relation)) return fail('同方向同类型的关系已经存在');
      file.links ||= []; file.links.push(link); history(undefined, link);
    }
  } else return fail('图谱操作无效');
  for (const [id, branches] of touched) {
    const record = file.records.find(r => r.id === id)!, previous = latestCognition(record);
    record.revisions.push({ id: `${stamp.id}:${id}`.slice(0, 200), number: previous.number + 1, at: stamp.at, operation: edit.action === 'add_node' || edit.action === 'add_relation' ? 'supplement' : 'revise',
      reason, authorship, ...(meaning ? { meaning } : {}), source: { kind: 'manual_revision', docId: record.id }, branches, factSupport: 'not_assessed', mastery: 'not_assessed' });
  }
}

/** Existing cross-activity dependencies get review flags, never automatic truth/stance changes. */
function refreshCrossReview(before: CognitionFile, after: CognitionFile, stamp: { id: string; at: string }) {
  if (!before.links?.length && !after.links?.length) return;
  const rows = (file: CognitionFile) => file.records.filter(r => !r.withdrawn).flatMap(record => latestCognition(record).branches.flatMap(branch => branch.graph.nodes.map(node => ({ record, branch, node,
    key: cognitionCoordinate({ recordId: record.id, branchId: branch.id, nodeId: node.id }), signature: JSON.stringify([node.text, node.role, node.mainType, node.stance || branch.stance]) }))));
  const previous = new Map(rows(before).map(row => [row.key, row])), current = new Map(rows(after).map(row => [row.key, row]));
  const changed = [...previous].filter(([key, row]) => current.get(key)?.signature !== row.signature).map(([key]) => key);
  const pending = new Set<string>(), outgoing = new Map<string, Set<string>>();
  const edge = (s: string, t: string) => { if (!outgoing.has(s)) outgoing.set(s, new Set()); outgoing.get(s)!.add(t); };
  for (const file of [before, after]) {
    for (const record of file.records.filter(r => !r.withdrawn)) for (const branch of latestCognition(record).branches) for (const e of branch.graph.edges)
      edge(cognitionCoordinate({ recordId: record.id, branchId: branch.id, nodeId: e.source }), cognitionCoordinate({ recordId: record.id, branchId: branch.id, nodeId: e.target }));
    for (const link of file.links || []) edge(cognitionCoordinate(link.source), cognitionCoordinate(link.target));
  }
  const oldLinks = new Set((before.links || []).map(link => JSON.stringify(link))), newLinks = new Set((after.links || []).map(link => JSON.stringify(link)));
  for (const link of [...(before.links || []), ...(after.links || [])]) if (!oldLinks.has(JSON.stringify(link)) || !newLinks.has(JSON.stringify(link))) pending.add(cognitionCoordinate(link.target));
  // A local relation can feed a cross-activity chain. Seed the actual changed edges,
  // not merely newly added flags (a target may already have been pending review).
  const localEdges = (file: CognitionFile) => file.records.filter(record => !record.withdrawn).flatMap(record => latestCognition(record).branches.flatMap(branch => branch.graph.edges.map(edge => ({
    key: JSON.stringify([record.id, branch.id, edge]), target: cognitionCoordinate({ recordId: record.id, branchId: branch.id, nodeId: edge.target }),
  }))));
  const oldLocalEdges = localEdges(before), newLocalEdges = localEdges(after);
  const oldKeys = new Set(oldLocalEdges.map(edge => edge.key)), newKeys = new Set(newLocalEdges.map(edge => edge.key));
  for (const edge of [...oldLocalEdges, ...newLocalEdges]) if (previous.has(edge.target) && (!oldKeys.has(edge.key) || !newKeys.has(edge.key))) pending.add(edge.target);
  const queue = [...new Set([...changed, ...pending])], seen = new Set(queue);
  for (let i = 0; i < queue.length; i++) for (const next of outgoing.get(queue[i]) || []) if (!seen.has(next)) { seen.add(next); pending.add(next); queue.push(next); }
  for (const key of changed) pending.delete(key);
  for (const key of pending) {
    const row = current.get(key); if (!row || row.branch.reviewNeededNodeIds?.includes(row.node.id)) continue;
    const record = row.record;
    if (record.revisions.length === before.records.find(r => r.id === record.id)?.revisions.length) {
      const { change: _oldChange, meaning: _oldMeaning, ...prior } = structuredClone(latestCognition(record));
      record.revisions.push({ ...prior, id: `${stamp.id}:review:${record.id}`.slice(0, 200), number: prior.number + 1, at: stamp.at, operation: 'qualify', reason: '已记录关联的前提或关系发生变化，等待用户复核；不代表判错。' });
    }
    const branch = latestCognition(record).branches.find(b => b.id === row.branch.id)!;
    branch.reviewNeededNodeIds = [...new Set([...(branch.reviewNeededNodeIds || []), row.node.id])];
  }
}

/** Addition is a union, never overwrite, negate, or a model-generated logical disjunction. */
export function supplementGraph(before: CognitionGraph, incoming: CognitionGraph): CognitionGraph {
  const nodes = new Map(before.nodes.map((n) => [n.id, n]));
  const edges = new Map(before.edges.map((e) => [e.id, e]));
  for (const n of incoming.nodes) {
    const old = nodes.get(n.id);
    if (old && (old.text !== n.text || old.mainType !== n.mainType || old.role !== n.role)) return fail('补充不能改写已有节点。请保留原节点并新建补充节点，或明确选择“修订替代”。');
    if (old && n.stance !== undefined && n.stance !== old.stance) return fail('补充不能修改已有节点的认同状态');
    if (old && n.conditions !== undefined && JSON.stringify(n.conditions) !== JSON.stringify(old.conditions)) return fail('补充不能修改已有节点的条件，请使用单节点条件编辑。');
    nodes.set(n.id, old || n);
  }
  for (const e of incoming.edges) {
    const old = edges.get(e.id);
    if (old && (old.source !== e.source || old.target !== e.target || old.relation !== e.relation)) return fail('补充不能改写已有连线，请新建连线或选择修订。');
    if (old && e.reason !== undefined && e.reason !== old.reason) return fail('补充不能改写已有连线说明，请明确编辑关系或选择修订。');
    edges.set(e.id, old || e);
  }
  return cognitionGraph({ title: incoming.title, nodes: [...nodes.values()], edges: [...edges.values()], flowStructure: before.flowStructure || incoming.flowStructure });
}

/** Flag reachable conclusions on changed dependencies; preserve them and never infer truth. */
function markDownstream(before: CognitionBranch, after: CognitionBranch, changed: string[], reaffirmed: string[] = []) {
  const pending = new Set((before.reviewNeededNodeIds || []).filter((id) => !reaffirmed.includes(id)));
  const seen = new Set(changed), queue = [...changed];
  for (let i = 0; i < queue.length; i++) {
    for (const edge of before.graph.edges.filter((e) => e.source === queue[i])) {
      if (!seen.has(edge.target)) { seen.add(edge.target); pending.add(edge.target); queue.push(edge.target); }
    }
  }
  after.reviewNeededNodeIds = [...pending].filter((id) => after.graph.nodes.some((n) => n.id === id));
}

function applyTargetedUpdate(file: CognitionFile, request: Record<string, unknown>, stamp: { id: string; at: string }) {
  const target = object(request.target);
  const record = file.records.find((r) => r.id === target.recordId);
  if (!record || record.withdrawn) return fail('目标认知不存在');
  const previous = latestCognition(record);
  if (target.revisionId !== previous.id) return fail('目标认知已更新，请重新选择并核对');
  const before = previous.branches.find((b) => b.id === target.branchId);
  const old = before?.graph.nodes.find((n) => n.id === target.nodeId);
  if (!before || !old) return fail('目标主张不存在，请重新选择');
  const operation = target.operation;
  if (operation === 'initial' || !Object.hasOwn(COGNITION_OPERATION_LABELS, operation as string)) return fail('认知更新方式无效');
  if (!['endorsed', 'tentative'].includes(request.stance as string)
    || !['own_expression', 'adopted_with_assistance'].includes(request.authorship as string)) return fail('请选择认同状态与表述来源');
  const reason = text(target.reason, '更新说明', 4000);
  const input = request as unknown as Extract<CognitionMutation, { kind: 'update_cognition' }>;
  if (input.role !== undefined && !ROLES.has(input.role as string)) return fail('论证节点角色无效');
  if (input.mainType !== undefined && !TYPES.has(input.mainType as string)) return fail('历史论证节点类型无效');
  const branches = structuredClone(previous.branches);
  let branch = branches.find((b) => b.id === before.id)!;
  const append = ['supplement', 'contextual', 'alternative'].includes(operation as string);
  const meaning = request.meaning === undefined ? undefined : parseCognitionMeaning(request.meaning);
  if (append && meaning?.conditions) return fail('新增并存主张不能改写原主张的条件');
  const conditions = append ? undefined : resolveCognitionConditions(old, text(request.text, '节点文本'), operation as import('./types').CognitionOperation, meaning);
  const unresolved = operation === 'alternative' || (before.kind === 'alternative' && operation !== 'contextual');
  const node = cognitionGraph({ title: before.graph.title, nodes: [{ id: append ? `change:${stamp.id}` : old.id,
    text: input.text, mainType: input.mainType ?? (append ? undefined : old.mainType), stance: unresolved ? 'tentative' : input.stance,
    role: input.role ?? (append ? undefined : old.role), ...(conditions === undefined ? {} : { conditions }) }], edges: [] }).nodes[0];
  if (operation === 'contextual' || operation === 'alternative') {
    branch = { id: stamp.id, kind: operation, context: reason, stance: node.stance!, graph: { title: before.graph.title, nodes: [node], edges: [] } };
    branches.push(branch);
  } else if (operation === 'supplement') {
    branch.graph.nodes.push(node);
  } else {
    branch.graph.nodes = branch.graph.nodes.map((n) => n.id === old.id ? node : n);
    const changed = old.text !== node.text || old.mainType !== node.mainType || old.role !== node.role || (old.stance || before.stance) !== node.stance;
    markDownstream(before, branch, changed ? [old.id] : [], [old.id]);
  }
  record.revisions.push({ id: stamp.id, number: previous.number + 1, at: stamp.at,
    operation: input.target.operation, reason, authorship: input.authorship,
    ...(meaning ? { meaning } : {}),
    source: { kind: 'manual_revision', docId: record.docId }, branches,
    change: { recordId: record.id, revisionId: previous.id, branchId: before.id, nodeId: old.id,
      operation: input.target.operation, reason, resultBranchId: branch.id, resultNodeId: node.id },
    factSupport: 'not_assessed', mastery: 'not_assessed' });
  return record;
}

/** Admission of the user's actual learning expressions is not a factual correctness assessment. */
function recordLearningExpressions(current: CognitionFile, request: Record<string, unknown>, stamp: { id: string; at: string }): CognitionFile {
  if (!Array.isArray(request.observations) || request.observations.length > 500
    || (request.kind === 'record_review' && request.enabled !== true)) return fail('学习表达批次无效');
  const file = structuredClone(current);
  let changed = false, sequence = 0;
  const addRevision = (record: CognitionRecord, body: string, title: string, context: string, source: CognitionRecord['revisions'][number]['source'],
    authorship: CognitionRecord['revisions'][number]['authorship'], at: string, structure?: CognitionGraph) => {
    const nodes: CognitionGraph['nodes'] = [];
    // A raw expression is not an extracted premise or a verified factual statement.
    for (let offset = 0; offset < body.length; offset += 10000) nodes.push({ id: `s${nodes.length + 1}`, text: body.slice(offset, offset + 10000) });
    record.revisions.push({ id: `${stamp.id}:${sequence++}`, number: record.revisions.length + 1, at,
      operation: record.revisions.length ? 'revise' : 'initial', reason: context, authorship, source,
      branches: [{ id: 'primary', kind: 'primary', context, stance: 'endorsed', graph: structure || { title, nodes, edges: [] } }],
      factSupport: 'not_assessed', mastery: 'not_assessed' });
    record.withdrawn = false;
    changed = true;
  };
  if (request.kind === 'record_review') {
    const candidates = parseCognitionCandidates(file.candidates);
    const receipts = new Map(candidates.map(candidate => [candidate.id, candidate]));
    for (const raw of request.observations) {
      const observation = parseCognitionObservation(raw);
      if (!isCognitionCandidateText(observation.answer, 2)) continue;
      const id = cognitionCandidateId(observation), docId = cognitionCandidateRecordId(id), receipt = receipts.get(id);
      if (receipt?.status === 'dismissed' || file.suppressedSourceIds?.includes(docId)) continue;
      if (receipt?.status === 'pending' && JSON.stringify(receipt.observation) !== JSON.stringify(observation)) return fail('同一回答 ID 的原文或上下文已变化');
      const existing = file.records.find(record => record.id === docId);
      if (existing) {
        const origin = existing.revisions.find(revision => revision.source.kind === 'review_answer' && revision.source.candidateId === id)?.source;
        if (origin?.kind !== 'review_answer' || JSON.stringify(origin.observation) !== JSON.stringify(observation)) return fail('回答来源身份冲突，未覆盖原认知');
        continue; // Explicit edits and stance choices always win over automatic replay.
      }
      if (receipt?.status === 'accepted') continue;
      const record: CognitionRecord = { id: docId, docId, revisions: [] };
      addRevision(record, observation.answer, observation.noteTitle || '复习回答', `复习时的用户表述。提问：${observation.question}`.slice(0, 4000),
        { kind: 'review_answer', docId, candidateId: id, observation, automatic: true },
        observation.hintLevel === 0 && !observation.consultedMaterialIds.length ? 'own_expression' : 'adopted_with_assistance', observation.observedAt);
      file.records.push(record);
      const accepted = { id, status: 'accepted' as const, recordId: docId };
      const index = candidates.findIndex(candidate => candidate.id === id);
      if (index >= 0) candidates[index] = accepted; else candidates.push(accepted);
      receipts.set(id, accepted);
    }
    if (changed) file.candidates = candidates;
  } else {
    const sync = new Map((file.restatementSync || []).map(row => [row.id, row.updatedAt]));
    for (const raw of request.observations) {
      const row = object(raw);
      const noteId = text(row.noteId, '来源笔记', 200), recordId = text(row.recordId, '复述记录', 200), sessionId = text(row.sessionId, '学习会话', 200);
      const docId = text(restatementRecordId({ noteId, recordId }), '复述认知 ID', 300);
      const body = text(row.text, '复述原文', 200000, true), title = text(row.noteTitle, '来源标题', 1000, true);
      const observedAt = text(row.observedAt, '复述时间', 100), updatedAt = text(row.updatedAt, '复述更新时间', 100);
      if (![observedAt, updatedAt].every(value => Number.isFinite(Date.parse(value)))) return fail('复述时间无效');
      if (file.suppressedSourceIds?.includes(docId)) continue;
      let record = file.records.find(record => record.id === docId);
      const prior = record && latestCognition(record);
      if (prior && prior.source.kind !== 'restatement') continue; // Do not overwrite a manual cognition revision.
      const latestSourceTime = sync.get(docId) || (prior?.source.kind === 'restatement' ? prior.source.updatedAt : undefined);
      if (latestSourceTime && Date.parse(latestSourceTime) > Date.parse(updatedAt)) continue;
      if (sync.get(docId) !== updatedAt) { sync.set(docId, updatedAt); changed = true; }
      if (!isCognitionCandidateText(body, 2)) {
        if (record && !record.withdrawn) { record.withdrawn = true; changed = true; }
        continue;
      }
      const incomingGraph = row.graph === undefined ? undefined : object(row.graph);
      const structure = incomingGraph ? cognitionGraph(incomingGraph.structure) : undefined;
      const graphSource = incomingGraph ? { argumentDocId: text(incomingGraph.argumentDocId, '复盘图来源', 200),
        updatedAt: text(incomingGraph.updatedAt, '复盘图时间', 100) } : undefined;
      if (graphSource && !Number.isFinite(Date.parse(graphSource.updatedAt))) return fail('复盘图时间无效');
      const previousText = prior?.source.kind === 'restatement' ? prior.source.originalText ?? prior.branches[0].graph.nodes.map(node => node.text).join('') : undefined;
      if (prior && !record!.withdrawn && previousText === body
        && (structure ? prior.source.kind === 'restatement' && prior.source.graph?.argumentDocId === graphSource!.argumentDocId
          && JSON.stringify(prior.branches[0].graph) === JSON.stringify(structure)
          : prior.source.kind === 'restatement' && !prior.source.graph)) continue;
      if (!record) { record = { id: docId, docId, revisions: [] }; file.records.push(record); }
      addRevision(record, body, title || '学习复述', '用户保存的复述，作为该次学习时接受的个人理解；原话保留，不代表客观事实已验证。',
        { kind: 'restatement', docId, noteId, recordId, sessionId, observedAt, updatedAt, automatic: true,
          ...(graphSource ? { originalText: body, graph: graphSource } : {}) }, 'own_expression', prior ? updatedAt : observedAt, structure);
    }
    if (changed) file.restatementSync = [...sync].map(([id, updatedAt]) => ({ id, updatedAt }));
  }
  if (!changed) return current;
  refreshCrossReview(current, file, stamp);
  file.revision++;
  return parseCognitionFile(file);
}

/** One-way upgrade of opted-in legacy answers; dismissed/accepted receipts are never re-admitted. */
export function adoptPendingReviewAnswers(file: CognitionFile, stamp: { id: string; at: string }): CognitionFile {
  const pending = (file.candidates || []).filter(candidate => candidate.status === 'pending');
  let next = file;
  for (let i = 0; i < pending.length; i += 500) next = applyCognitionMutation(next, { kind: 'record_review', enabled: true,
    observations: pending.slice(i, i + 500).map(candidate => candidate.status === 'pending' ? candidate.observation : undefined) }, { ...stamp, id: `${stamp.id}:${i}` });
  return next;
}

export function applyCognitionMutation(current: CognitionFile, raw: unknown, stamp: { id: string; at: string }): CognitionFile {
  const next = applyCognitionMutationInner(current, raw, stamp);
  // Metadata never advances the belief head. Any other editor/ingest write must
  // invalidate old undo tokens; undo itself deliberately restores its parent head.
  if (next !== current && object(raw).kind !== 'undo_revision_batch'
    && JSON.stringify([current.records, current.links]) !== JSON.stringify([next.records, next.links])) next.beliefHead = stamp.id;
  return next;
}
function applyCognitionMutationInner(current: CognitionFile, raw: unknown, stamp: { id: string; at: string }): CognitionFile {
  const request = object(raw);
  if (['begin_revision_session', 'update_revision_session', 'apply_revision_batch', 'undo_revision_batch'].includes(String(request.kind))) {
    return parseCognitionFile(applyRevisionRequest(current, request as unknown as CognitionRevisionRequest, stamp,
      { edit: (file, edit, operationStamp) => applyGraphEdit(file, edit, operationStamp, 'adopted_with_assistance'), refresh: refreshCrossReview }));
  }
  if (request.kind === 'record_review' || request.kind === 'record_restatements') return recordLearningExpressions(current, request, stamp);
  if (request.kind === 'capture_review') {
    if (request.enabled !== true || !Array.isArray(request.observations) || request.observations.length > 500) return fail('候选采集未开启或批次无效');
    const file = structuredClone(current);
    const candidates = parseCognitionCandidates(file.candidates);
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    let added = 0;
    for (const rawObservation of request.observations) {
      const observation = parseCognitionObservation(rawObservation);
      if (!isCognitionCandidateText(observation.answer)) continue;
      const id = cognitionCandidateId(observation), old = byId.get(id);
      if (old) {
        if (old.status === 'pending' && JSON.stringify(old.observation) !== JSON.stringify(observation)) return fail('同一回答 ID 的原文或上下文已变化，不能覆盖原候选');
        continue;
      }
      const candidate = { id, status: 'pending' as const, observation, capturedAt: stamp.at };
      candidates.push(candidate); byId.set(id, candidate); added++;
    }
    if (!added) return file;
    file.candidates = candidates;
    file.revision += 1;
    return parseCognitionFile(file);
  }
  if (request.confirmed !== true) return fail('只有用户明确确认后才能写入个人认知');
  if (request.expectedRevision !== current.revision) return fail('认知库已在其他窗口更新。请重新加载并核对后确认，不会自动覆盖。');
  const file = structuredClone(current);
  if (request.kind === 'accept_candidate' || request.kind === 'dismiss_candidate') {
    const candidates = parseCognitionCandidates(file.candidates);
    const candidate = candidates.find((c) => c.id === request.candidateId);
    if (!candidate || candidate.status !== 'pending') return fail('候选已被处理，请重新加载');
    if (request.kind === 'dismiss_candidate') {
      // Keep only an opaque receipt so replay cannot resurrect dismissed private text.
      file.candidates = candidates.map((c) => c.id === candidate.id ? { id: c.id, status: 'dismissed' } : c);
    } else {
      const o = candidate.observation;
      if ((o.hintLevel !== 0 || o.consultedMaterialIds.length > 0) && request.authorship === 'own_expression') return fail('本轮有提示、查阅或辅助信息缺失，不能标记为独立表述');
      const docId = request.target === undefined ? cognitionCandidateRecordId(candidate.id) : text(object(request.target).recordId, '目标认知', 300);
      const next = request.target === undefined ? applyCognitionMutation(file, { kind: 'confirm', expectedRevision: current.revision, confirmed: true,
        operation: 'initial', reason: '用户核对学习回答候选后确认', authorship: request.authorship, stance: request.stance,
        doc: { doc_id: docId, title: o.noteTitle, nodes: [{ id: 's1', text: request.text, mainType: request.mainType, role: request.role }], edges: [] } }, stamp)
        : applyCognitionMutation(file, { ...request, kind: 'update_cognition' }, stamp);
      const record = next.records.find((r) => r.id === docId)!;
      latestCognition(record).source = { kind: 'review_answer', docId, candidateId: candidate.id, observation: structuredClone(o) };
      next.candidates = candidates.map((c) => c.id === candidate.id ? { id: c.id, status: 'accepted', recordId: docId } : c);
      return parseCognitionFile(next);
    }
  } else if (request.kind === 'edit_graph' || request.kind === 'edit_graph_batch') {
    if (request.authorship !== undefined && !['own_expression', 'adopted_with_assistance'].includes(request.authorship as string)) return fail('表述来源无效');
    const authorship = request.authorship === 'adopted_with_assistance' ? request.authorship : 'own_expression';
    if (request.kind === 'edit_graph_batch') applyGraphEditBatch(current, file, request.edits as CognitionGraphEdit[], stamp, authorship, applyGraphEdit);
    else applyGraphEdit(file, request.edit, stamp, authorship);
  } else if (request.kind === 'update_cognition') {
    applyTargetedUpdate(file, request, stamp);
  } else if (request.kind === 'forget') {
    if (!file.records.some((r) => r.id === request.recordId)) return fail('认知记录不存在');
    const forgotten = file.records.find(r => r.id === request.recordId)!;
    if (forgotten.revisions.some(v => v.source.kind === 'restatement')) file.suppressedSourceIds = [...new Set([...(file.suppressedSourceIds || []), forgotten.id])];
    file.records = file.records.filter((r) => r.id !== request.recordId);
    // Forget really forgets: do not retain the private text in undo snapshots.
    const removedSessions = new Set((file.revisionSessions || []).filter(s => s.recordIds.includes(String(request.recordId))).map(s => s.id));
    if (file.revisionSessions) file.revisionSessions = file.revisionSessions.filter(s => !removedSessions.has(s.id));
    if (file.revisionBatches) file.revisionBatches = file.revisionBatches.filter(b => !removedSessions.has(b.sessionId)
      && ![...b.beforeRecords, ...b.afterRecords].some(r => r.recordId === request.recordId)
      && ![...b.beforeLinks, ...b.afterLinks].some(l => l.source.recordId === request.recordId || l.target.recordId === request.recordId));
    const mentions = (link: CognitionLink) => link.source.recordId === request.recordId || link.target.recordId === request.recordId;
    if (file.links) file.links = file.links.filter(link => !mentions(link));
    if (file.linkHistory) file.linkHistory = file.linkHistory.filter(row => !(row.before && mentions(row.before)) && !(row.after && mentions(row.after)));
    if (file.candidates) file.candidates = file.candidates.map((c) => c.status === 'accepted' && c.recordId === request.recordId ? { id: c.id, status: 'dismissed' } : c);
  } else if (request.kind === 'confirm') {
    const input = request as unknown as Extract<CognitionMutation, { kind: 'confirm' }>;
    if (!Object.hasOwn(COGNITION_OPERATION_LABELS, input.operation)) return fail('认知更新方式无效');
    if (input.operation.endsWith('_conditions')) return fail('条件逐项变更只能使用单节点条件编辑，不能整图覆盖');
    if (!['endorsed', 'tentative'].includes(input.stance) || !['own_expression', 'adopted_with_assistance'].includes(input.authorship)) return fail('请选择认同状态与表述来源');
    const docId = text(object(input.doc).doc_id, '论证来源 ID', 200);
    const graph = cognitionGraph(input.doc);
    const reason = text(input.reason, '更新说明', 4000, input.operation === 'initial');
    const noteId = input.noteId === undefined ? undefined : text(input.noteId, '来源笔记', 200);
    let record = file.records.find((r) => r.docId === docId);
    if (Boolean(record) === (input.operation === 'initial')) return fail(record ? '已有个人认知，请选择更新方式' : '首次保存请选择首次确认');
    const branches: CognitionBranch[] = record ? structuredClone(latestCognition(record).branches) : [];
    const primary = branches.find((b) => b.id === 'primary');
    if (input.operation === 'initial') {
      branches.push({ id: 'primary', kind: 'primary', context: reason, stance: input.stance, graph });
    } else if (input.operation === 'contextual' || input.operation === 'alternative') {
      branches.push({ id: stamp.id, kind: input.operation, context: reason, stance: input.operation === 'alternative' ? 'tentative' : input.stance, graph });
    } else if (primary) {
      const before = structuredClone(primary);
      if (input.operation === 'supplement' && primary.stance !== input.stance) return fail('补充不改变原有认同状态，请使用“调整确定程度”。');
      primary.graph = input.operation === 'supplement' ? supplementGraph(primary.graph, graph) : {
        ...graph, ...((graph.flowStructure || primary.graph.flowStructure) ? { flowStructure: graph.flowStructure || primary.graph.flowStructure } : {}), nodes: graph.nodes.map(node => {
          const old = primary.graph.nodes.find(previous => previous.id === node.id);
          if (old?.conditions === undefined) return node;
          // The argument canvas does not carry private condition annotations.
          // Retain them on unchanged coordinates, and apply the same literal
          // guard as targeted editing instead of silently bypassing it.
          if (node.conditions !== undefined && JSON.stringify(node.conditions) !== JSON.stringify(old.conditions)) return fail('已有条件不能通过整图保存变更，请到认知图谱中使用单节点条件编辑。');
          return { ...node, conditions: resolveCognitionConditions(old, node.text, input.operation) };
        }),
      };
      primary.stance = input.stance;
      primary.context = reason;
      const changed = before.graph.nodes.filter((n) => {
        const next = primary.graph.nodes.find((v) => v.id === n.id);
        return !next || next.text !== n.text || next.mainType !== n.mainType || next.role !== n.role || (next.stance || primary.stance) !== (n.stance || before.stance);
      }).map((n) => n.id);
      const changedEdges = [...before.graph.edges, ...primary.graph.edges].filter((edge) => {
        const old = before.graph.edges.find((e) => e.id === edge.id), next = primary.graph.edges.find((e) => e.id === edge.id);
        return !old || !next || old.source !== next.source || old.target !== next.target || old.relation !== next.relation;
      });
      markDownstream(before, primary, [...changed, ...changedEdges.map((e) => e.target)]);
      primary.reviewNeededNodeIds = [...new Set([...primary.reviewNeededNodeIds!, ...changedEdges.map((e) => e.target)])].filter((id) => primary.graph.nodes.some((n) => n.id === id));
    }
    if (!record) { record = { id: docId, docId, revisions: [] }; file.records.push(record); }
    record.revisions.push({ id: stamp.id, number: record.revisions.length + 1, at: stamp.at,
      operation: input.operation, reason, authorship: input.authorship,
      source: { kind: 'argument_editor', docId, ...(noteId ? { noteId } : {}) }, branches,
      factSupport: 'not_assessed', mastery: 'not_assessed' });
  } else return fail('认知操作无效');
  refreshCrossReview(current, file, stamp);
  file.revision += 1;
  return parseCognitionFile(file);
}

/** Diagnostic-only retrieval contract; not connected to factual QA tools or mastery scores. */
export function cognitionNodeOrigin(record: CognitionRecord, branchId: string, nodeId: string) {
  let origin = latestCognition(record);
  const signature = (v: typeof origin) => {
    const branch = v.branches.find((b) => b.id === branchId), node = branch?.graph.nodes.find((n) => n.id === nodeId);
    return node && JSON.stringify([node.text, node.mainType, node.role, node.stance || branch!.stance]);
  };
  for (let i = record.revisions.length - 1; i > 0; i--) {
    const v = record.revisions[i], prior = record.revisions[i - 1];
    if (v.change?.resultBranchId === branchId && v.change.resultNodeId === nodeId) break;
    if (!signature(prior) || signature(v) !== signature(prior)) break;
    origin = prior;
  }
  return origin;
}

export function searchCognition(file: CognitionFile, query: string, limit = 8) {
  const terms = query.trim().toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (!terms.length) return [];
  return file.records.filter(record => !record.withdrawn).flatMap((record) => {
    const v = latestCognition(record);
    return v.branches.flatMap((branch) => branch.graph.nodes.map((node) => {
      const origin = cognitionNodeOrigin(record, branch.id, node.id);
      return ({
      recordId: record.id, revisionId: v.id, branchId: branch.id, branchKind: branch.kind,
      nodeId: node.id, text: node.text, title: branch.graph.title, stance: node.stance || branch.stance,
      source: origin.source, confirmedAt: origin.at, originRevisionId: origin.id, context: branch.context,
      needsReview: branch.reviewNeededNodeIds?.includes(node.id) || false,
      purpose: 'cognition_diagnosis' as const, usableAsFactEvidence: false as const,
      score: terms.filter((term) => `${branch.graph.title} ${node.text}`.toLocaleLowerCase().includes(term)).length,
    }); }));
  }).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(0, Math.min(50, limit)));
}

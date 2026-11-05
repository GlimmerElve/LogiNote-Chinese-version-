import type { LlmConversationMessage } from '../../types';
import type { CognitionGraphEdit, CognitionNodeReference } from '../cognition/types';

export const COGNITION_READ_FILTERS = ['all', 'isolated', 'review', 'broken', 'cross-activity', 'endorsed', 'tentative'] as const;
export type CognitionReadFilter = typeof COGNITION_READ_FILTERS[number];
export interface CognitionBrowseQuery {
  filter: CognitionReadFilter; query?: string; offset: number; edgeOffset: number; brokenEdgeOffset: number;
  nextOffset?: number; nextEdgeOffset?: number; nextBrokenEdgeOffset?: number;
}
export interface CognitionAssistantWork {
  revision?: number; query?: CognitionBrowseQuery; focused?: CognitionNodeReference;
  /** Independent from the numbered node candidates, including exact-target reads. */
  relations?: CognitionBrowseQuery & { target?: CognitionNodeReference; relationsOnly: boolean };
  candidates: Array<{ reference: CognitionNodeReference; number: number; title: string; excerpt: string }>;
}
export interface CognitionAssistantState {
  version: 1; sessionId: string; messages: LlmConversationMessage[]; work: CognitionAssistantWork;
  interrupted?: boolean;
  completions?: CognitionCompletionReceipt[];
}
export interface CognitionCompletionReceipt {
  proposalId: string; action: CognitionGraphEdit['action']; fileRevision: number; at: string; request: string;
}
export const COGNITION_COMPLETION_LIMIT = 20;
const actions = ['add_node', 'update_node', 'delete_node', 'add_relation', 'update_relation', 'delete_relation'];
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
function readBrowseQuery(query: CognitionBrowseQuery, revision?: number): CognitionBrowseQuery {
  if (!COGNITION_READ_FILTERS.includes(query.filter) || revision === undefined || ![query.offset, query.edgeOffset, query.brokenEdgeOffset].every(integer)
    || (query.query !== undefined && (typeof query.query !== 'string' || query.query.length > 500))
    || [query.nextOffset, query.nextEdgeOffset, query.nextBrokenEdgeOffset].some(value => value !== undefined && !integer(value))) throw new Error('认知助手分页状态无效');
  return { filter: query.filter, offset: query.offset, edgeOffset: query.edgeOffset, brokenEdgeOffset: query.brokenEdgeOffset,
    ...(query.query === undefined ? {} : { query: query.query }),
    ...(query.nextOffset === undefined ? {} : { nextOffset: query.nextOffset }),
    ...(query.nextEdgeOffset === undefined ? {} : { nextEdgeOffset: query.nextEdgeOffset }),
    ...(query.nextBrokenEdgeOffset === undefined ? {} : { nextBrokenEdgeOffset: query.nextBrokenEdgeOffset }) };
}
export function cognitionAssistantReference(value: unknown): CognitionNodeReference {
  const ref = value as CognitionNodeReference;
  if (!ref || !['recordId', 'revisionId', 'branchId', 'nodeId'].every(key => bounded(ref[key as keyof CognitionNodeReference], 1000))) throw new Error('认知助手节点定位无效');
  return { recordId: ref.recordId, revisionId: ref.revisionId, branchId: ref.branchId, nodeId: ref.nodeId };
}
export function emptyCognitionAssistantState(): CognitionAssistantState {
  return { version: 1, sessionId: `cognition-${crypto.randomUUID()}`, messages: [], work: { candidates: [] } };
}
export function normalizeCognitionAssistantState(value: unknown): CognitionAssistantState {
  const state = value as CognitionAssistantState;
  if (!state || state.version !== 1 || !bounded(state.sessionId, 120) || !/^cognition-[a-zA-Z0-9_-]+$/u.test(state.sessionId)
    || !Array.isArray(state.messages) || state.messages.length > 50 || !state.work || !Array.isArray(state.work.candidates)
    || state.work.candidates.length > 16 || (state.interrupted !== undefined && typeof state.interrupted !== 'boolean')
    || (state.work.revision !== undefined && !integer(state.work.revision)) || JSON.stringify(state).length > 500000) throw new Error('认知助手会话格式无效或超过容量');
  const work: CognitionAssistantWork = { candidates: state.work.candidates.map(row => {
    if (!row || !integer(row.number) || row.number < 1 || typeof row.title !== 'string' || row.title.length > 160 || typeof row.excerpt !== 'string' || row.excerpt.length > 320) throw new Error('认知助手候选格式无效');
    return { reference: cognitionAssistantReference(row.reference), number: row.number, title: row.title, excerpt: row.excerpt };
  }), ...(state.work.revision === undefined ? {} : { revision: state.work.revision }),
    ...(state.work.focused ? { focused: cognitionAssistantReference(state.work.focused) } : {}) };
  if (state.work.query) work.query = readBrowseQuery(state.work.query, work.revision);
  // Discard an already-mixed legacy node cursor, not the conversation or beliefs.
  // A fresh list read must establish numbering instead of trusting the wrong page.
  if (work.query && work.candidates.some((row, index) => row.number !== work.query!.offset + index + 1)) { delete work.query; work.candidates = []; }
  if (state.work.relations) {
    const cursor = state.work.relations;
    const query = readBrowseQuery(cursor, work.revision);
    if (typeof cursor.relationsOnly !== 'boolean' || (cursor.target && (cursor.offset !== 0 || cursor.query !== undefined || cursor.filter !== 'all'))) throw new Error('认知关系分页状态无效');
    work.relations = { ...query, relationsOnly: cursor.relationsOnly, ...(cursor.target ? { target: cognitionAssistantReference(cursor.target) } : {}) };
  }
  let completions: CognitionCompletionReceipt[] | undefined;
  if (state.completions !== undefined) {
    if (!Array.isArray(state.completions) || state.completions.length > COGNITION_COMPLETION_LIMIT) throw new Error('认知完成回执超出容量');
    const ids = new Set<string>();
    completions = state.completions.map(receipt => {
      if (!receipt || !bounded(receipt.proposalId, 120) || ids.has(receipt.proposalId) || !actions.includes(receipt.action)
        || !integer(receipt.fileRevision) || !bounded(receipt.at, 50) || !Number.isFinite(Date.parse(receipt.at))
        || typeof receipt.request !== 'string' || receipt.request.length > 1000) throw new Error('认知完成回执无效');
      ids.add(receipt.proposalId);
      return { proposalId: receipt.proposalId, action: receipt.action, fileRevision: receipt.fileRevision, at: receipt.at, request: receipt.request };
    });
  }
  return { version: 1, sessionId: state.sessionId, work, messages: state.messages.map(message => {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || message.content.length > 8050) throw new Error('认知助手历史消息无效');
    return { role: message.role, content: message.content };
  }), ...(state.interrupted ? { interrupted: true } : {}), ...(completions ? { completions } : {}) };
}
export function compactCognitionAssistantState(state: CognitionAssistantState, history: LlmConversationMessage[], interrupted: boolean): CognitionAssistantState {
  return normalizeCognitionAssistantState({ ...state, interrupted,
    messages: history.filter(message => ['user', 'assistant'].includes(message.role) && message.content?.trim() && !message.toolCalls?.length)
      .slice(-50).map(message => ({ role: message.role, content: message.content.length > 8000 ? `${message.content.slice(0, 8000)}\n（恢复记录已截断，请重新精确读取原文。）` : message.content })) });
}

/** Bind subsequent pages to the saved query; never infer a new target from page focus. */
export function prepareCognitionAssistantRead(args: Record<string, unknown>, work: CognitionAssistantWork): Record<string, unknown> {
  const input = { ...args }, relationPaging = ['edgeOffset', 'brokenEdgeOffset'].some(key => Number(input[key] || 0) > 0);
  const paging = relationPaging || Number(input.offset || 0) > 0;
  const relations = work.relations;
  // A short continuation of exact-node relations must not inherit a list filter.
  if (!input.edge && !input.target && relationPaging && !input.offset && input.filter === undefined && input.query === undefined && relations?.target) input.target = relations.target;
  if (input.target || input.edge) {
    if (input.target && Number(input.offset || 0) !== 0) throw new Error('精确节点关系续读不能切换节点列表页');
    if (paging) {
      const target = input.target && cognitionAssistantReference(input.target);
      if (!target || !relations?.target || JSON.stringify(target) !== JSON.stringify(cognitionAssistantReference(relations.target)) || work.revision === undefined) throw new Error('没有这个节点的可续读关系快照，请先读取它的第一页');
      input.relationsOnly ??= relations.relationsOnly;
      if (input.relationsOnly !== relations.relationsOnly) throw new Error('关系读取模式已变化，请从第一页重新读取');
      input.expectedRevision ??= work.revision;
      if (input.expectedRevision !== work.revision) throw new Error('分页版本已变化，请从第一页重新读取');
    } else if (work.revision !== undefined) input.expectedRevision ??= work.revision;
    return input;
  }
  if (paging) {
    const anchor = (relationPaging || input.relationsOnly === true) && relations && !relations.target ? relations : work.query;
    if (!anchor || work.revision === undefined) throw new Error('没有可续读的认知快照，请先从第一页读取');
    if (input.query === undefined && input.filter === undefined) { input.filter = anchor.filter; if (anchor.query !== undefined) input.query = anchor.query; }
    if ((input.filter ?? 'all') !== anchor.filter || (input.query ?? '') !== (anchor.query ?? '')) throw new Error('分页筛选已变化，请从第一页重新读取');
    if (relationPaging) {
      const mode = 'relationsOnly' in anchor ? anchor.relationsOnly : false;
      input.relationsOnly ??= mode;
      if (input.relationsOnly !== mode) throw new Error('关系读取模式已变化，请从第一页重新读取');
    }
    input.offset ??= anchor.offset;
    input.expectedRevision ??= work.revision;
    if (input.expectedRevision !== work.revision) throw new Error('分页版本已变化，请从第一页重新读取');
  }
  return input;
}
export function observeCognitionAssistantRead(args: Record<string, unknown>, result: unknown, previous: CognitionAssistantWork): CognitionAssistantWork {
  const output = result as { fileRevision: number; nodes?: Array<CognitionNodeReference & { title: string; text: string }>;
    nextOffset?: number; nextEdgeOffset?: number; nextBrokenEdgeOffset?: number };
  if (!integer(output?.fileRevision)) throw new Error('认知读取返回了无效版本');
  const work: CognitionAssistantWork = previous.revision === output.fileRevision ? structuredClone(previous) : { candidates: [] };
  work.revision = output.fileRevision;
  if (args.edge) return work;
  const offset = Number(args.offset || 0);
  const query: CognitionBrowseQuery = { filter: (args.filter || 'all') as CognitionReadFilter, ...(args.query === undefined ? {} : { query: String(args.query) }),
    offset, edgeOffset: Number(args.edgeOffset || 0), brokenEdgeOffset: Number(args.brokenEdgeOffset || 0),
    ...(output.nextOffset === undefined ? {} : { nextOffset: output.nextOffset }),
    ...(output.nextEdgeOffset === undefined ? {} : { nextEdgeOffset: output.nextEdgeOffset }),
    ...(output.nextBrokenEdgeOffset === undefined ? {} : { nextBrokenEdgeOffset: output.nextBrokenEdgeOffset }) };
  work.relations = { ...query, relationsOnly: args.relationsOnly === true, ...(args.target ? { target: cognitionAssistantReference(args.target) } : {}) };
  if (args.target) { work.focused = cognitionAssistantReference(args.target); return work; }
  if (!args.relationsOnly) {
    work.query = query;
    work.candidates = (output.nodes || []).map((node, index) => ({ reference: cognitionAssistantReference(node), number: offset + index + 1, title: node.title.slice(0, 160), excerpt: node.text.slice(0, 320) }));
  }
  return work;
}

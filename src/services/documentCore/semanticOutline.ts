import { DOCUMENT_CORE_SEMANTIC_OUTLINE_PROMPT, DOCUMENT_CORE_SEMANTIC_OUTLINE_VERSION } from '../../workflows/documentCoreSemanticOutlinePrompt';
import { prepareCoreInputPacket, runPreparedCoreExtraction } from './runner';
import { parseIdenticalCoreJson } from './identicalJson';
import { CORE_ARGUMENT_LIMITS, type CoreArgumentInput, type CoreArgumentReply, type CoreArgumentRequest, type CoreArgumentRun } from './types';

export interface SemanticStatement { id: string; text: string; sourcePassageIds: string[] }
export interface SemanticInference { premises: string[]; target: string; kind: 'support' | 'oppose' }
export interface SemanticConclusion { id: string; conditions: string[]; limitations: string[] }
export interface SemanticOutline { statements: SemanticStatement[]; inferences: SemanticInference[]; conclusions: SemanticConclusion[]; unresolved: string[] }
export interface SemanticStatementView extends SemanticStatement {
  contentOrigin: 'semantic-reconstruction-not-source-quote';
  locatedSourceIds: string[]; unresolvedSourceIds: unknown[];
  locationState: 'unlocated' | 'passage_candidates' | 'partially_located';
  sourceMeaningVerified: false; uses: string[];
}
export interface SemanticOutlineResult {
  semanticView: {
    nodes: SemanticStatementView[];
    inferences: Array<SemanticInference & { id: string }>;
    edges: Array<{ id: string; from: string; to: string; kind: 'support' | 'oppose'; inferenceId: string; jointPremiseCount: number }>;
    conclusions: SemanticConclusion[];
    groupsAreAuthoritative: true;
  };
  notes: string[];
  issues: Array<{ id: string; code: string; reason: string }>;
  pending: Array<{ layer: string; id: string; value: unknown }>;
  provenance: { version: typeof DOCUMENT_CORE_SEMANTIC_OUTLINE_VERSION; rawResponse: string;
    inputDocId: string; sourceVersion: string; inputUnchanged: true; semanticMergingPerformed: false;
    newEdgesInferred: 0; semanticCertified: false; productionWrites: false };
}
function requireValue(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const identifier = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 80;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const uniqueIds = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 60 && value.every(identifier) && new Set(value).size === value.length;

/** This is a semantic view, deliberately NOT the old source-only DocumentArgumentGraph.
 * Text is never substituted for a source quote or disguised as a synthetic original passage. */
export function projectCoreSemanticOutline(raw: string, input: CoreArgumentInput): SemanticOutlineResult {
  prepareCoreInputPacket(input);
  const decoded = parseIdenticalCoreJson(raw), value = decoded.value;
  requireValue(object(value), '语义提纲不是对象');
  requireValue(Array.isArray(value.statements) && value.statements.length <= CORE_ARGUMENT_LIMITS.nodes, '命题容器或预算不合法');
  requireValue(Array.isArray(value.inferences) && value.inferences.length <= CORE_ARGUMENT_LIMITS.arguments, '推导容器或预算不合法');
  requireValue(Array.isArray(value.conclusions) && value.conclusions.length <= CORE_ARGUMENT_LIMITS.coreClaims, '核心回应容器或预算不合法');
  const result: SemanticOutlineResult = { semanticView: { nodes: [], inferences: [], edges: [], conclusions: [], groupsAreAuthoritative: true },
    notes: [], issues: [], pending: [], provenance: { version: DOCUMENT_CORE_SEMANTIC_OUTLINE_VERSION, rawResponse: raw,
      inputDocId: input.docId, sourceVersion: input.sourceVersion, inputUnchanged: true, semanticMergingPerformed: false,
      newEdgesInferred: 0, semanticCertified: false, productionWrites: false } };
  const issue = (id: string, code: string, reason: string) => result.issues.push({ id, code, reason });
  const pending = (layer: string, id: string, entry: unknown, reason: string) => {
    result.pending.push({ layer, id, value: entry }); issue(id, `${layer}_pending`, reason);
  };
  for (const entry of decoded.coalesced) issue(entry.path, 'identical_duplicate_key', '同值重复JSON字段已记录；没有按语义合并命题');
  for (const key of Object.keys(value)) if (!['statements', 'inferences', 'conclusions', 'unresolved'].includes(key)) {
    pending('field', key, value[key], '未定义字段完整保留，不解释为关系或原文');
  }
  const statementCounts = new Map<string, number>();
  for (const row of value.statements) if (identifier(row?.id)) statementCounts.set(row.id, (statementCounts.get(row.id) || 0) + 1);
  const passageIds = new Set(input.passages.map(p => p.id));
  for (const [index, row] of value.statements.entries()) {
    const label = `PENDING-STATEMENT:${index + 1}`;
    if (!object(row) || !identifier(row.id) || statementCounts.get(row.id) !== 1 || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 5000) {
      pending('statement', label, row, '命题身份重复/不可用或表述非法；保留原始项，不选择某个重复ID，不影响其他命题'); continue;
    }
    const supplied: unknown[] = Array.isArray(row.sourcePassageIds) && row.sourcePassageIds.length <= 120 ? row.sourcePassageIds : [];
    if (!Array.isArray(row.sourcePassageIds) || row.sourcePassageIds.length > 120) pending('source', row.id, row.sourcePassageIds ?? null, '来源候选容器缺失或非法，语义命题仍保留');
    const locatedSourceIds = [...new Set(supplied.filter((id): id is string => typeof id === 'string' && passageIds.has(id)))];
    const unresolvedSourceIds = supplied.filter(id => typeof id !== 'string' || !passageIds.has(id));
    if (!locatedSourceIds.length || unresolvedSourceIds.length) issue(row.id, 'source_location_pending', '来源未定位或部分候选不可用；不删除语义命题及其明确关系，不将定位成功当作含义已核验');
    result.semanticView.nodes.push({ id: row.id, text: row.text, sourcePassageIds: supplied.filter((id): id is string => typeof id === 'string'),
      contentOrigin: 'semantic-reconstruction-not-source-quote', locatedSourceIds, unresolvedSourceIds,
      locationState: !locatedSourceIds.length ? 'unlocated' : unresolvedSourceIds.length ? 'partially_located' : 'passage_candidates',
      sourceMeaningVerified: false, uses: [] });
  }
  const nodes = new Map(result.semanticView.nodes.map(n => [n.id, n]));
  for (const [index, row] of value.inferences.entries()) {
    const id = `I${index + 1}`;
    if (!object(row) || !uniqueIds(row.premises) || !row.premises.length || !identifier(row.target)
      || !['support', 'oppose'].includes(row.kind) || !nodes.has(row.target)
      || !row.premises.every(p => nodes.has(p) && p !== row.target)) {
      pending('inference', id, row, '端点/方向字段不可用或自环；整组联合依据待处理，不裁掉缺失前提后伪装为完整推导'); continue;
    }
    const inference = { id, premises: [...row.premises], target: row.target, kind: row.kind as 'support' | 'oppose' };
    result.semanticView.inferences.push(inference);
    inference.premises.forEach((from, i) => result.semanticView.edges.push({ id: `${id}:${i + 1}`, from,
      to: inference.target, kind: inference.kind, inferenceId: id, jointPremiseCount: inference.premises.length }));
  }
  const rootCounts = new Map<string, number>();
  for (const row of value.conclusions) if (identifier(row?.id)) rootCounts.set(row.id, (rootCounts.get(row.id) || 0) + 1);
  for (const [index, row] of value.conclusions.entries()) {
    if (!object(row) || !identifier(row.id) || !nodes.has(row.id) || rootCounts.get(row.id) !== 1) {
      pending('conclusion', `ROOT:${index + 1}`, row, '核心回应身份缺失或重复；保留其他核心回应，不丢弃明确命题和推导'); continue;
    }
    const root: SemanticConclusion = { id: row.id, conditions: [], limitations: [] };
    for (const key of ['conditions', 'limitations'] as const) {
      if (row[key] === undefined) continue;
      if (!uniqueIds(row[key])) { pending('attachment', `${row.id}:${key}`, row[key], '附属说明容器非法，保留核心回应及其他说明'); continue; }
      root[key] = row[key].filter((ref: string) => {
        if (nodes.has(ref) && ref !== row.id) return true;
        pending('attachment', `${row.id}:${key}:${ref}`, ref, '说明端点不可用，未把说明转换为逻辑边'); return false;
      });
    }
    result.semanticView.conclusions.push(root);
  }
  if (value.unresolved !== undefined) {
    if (!Array.isArray(value.unresolved) || value.unresolved.length > 20) pending('note', 'unresolved', value.unresolved, '未决说明容器非法，不影响已解析语义内容');
    else value.unresolved.forEach((entry: unknown, i: number) => {
      if (typeof entry === 'string' && entry.trim() && entry.length <= 2000) result.notes.push(entry);
      else pending('note', `U${i + 1}`, entry, '未决说明不是有效文字；保留原始项，不取消核心回应');
    });
  }
  for (const node of nodes.values()) {
    if (result.semanticView.conclusions.some(c => c.id === node.id)) node.uses.push('core');
    if (result.semanticView.inferences.some(i => i.target === node.id)) node.uses.push('inference_target');
    if (result.semanticView.inferences.some(i => i.premises.includes(node.id))) node.uses.push('premise');
    for (const key of ['conditions', 'limitations'] as const) if (result.semanticView.conclusions.some(c => c[key].includes(node.id))) node.uses.push(key);
  }
  const active = new Set<string>(), done = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) { issue(id, 'cyclic_support', '明示支持存在环，仅记录，不删边或将其认定为有效证明'); return; }
    if (done.has(id)) return; active.add(id);
    result.semanticView.inferences.filter(i => i.kind === 'support' && i.target === id).forEach(i => i.premises.forEach(visit));
    active.delete(id); done.add(id);
  };
  nodes.forEach(n => visit(n.id));
  const signs = new Map<string, Set<string>>();
  for (const edge of result.semanticView.edges) {
    const key = JSON.stringify([edge.from, edge.to]); if (!signs.has(key)) signs.set(key, new Set()); signs.get(key)!.add(edge.kind);
  }
  for (const [pair, kinds] of signs) if (kinds.size > 1) issue(pair, 'conflicting_relation', '相同语义端点同时被标支持与反对；两项提议均保留待核对，不擅自选择方向');
  return result;
}

export interface SemanticOutlineRequest extends Omit<CoreArgumentRequest, 'version'> { version: typeof DOCUMENT_CORE_SEMANTIC_OUTLINE_VERSION }
export interface SemanticOutlineModel { call(request: Readonly<SemanticOutlineRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> }
export type SemanticOutlineRun = Omit<CoreArgumentRun, 'version' | 'request' | 'result'> & {
  version: typeof DOCUMENT_CORE_SEMANTIC_OUTLINE_VERSION; request: SemanticOutlineRequest; result?: SemanticOutlineResult;
};
// Frozen transport only inspects result.issues; semanticView is not cast into the source-only graph type.
const runExperiment = runPreparedCoreExtraction as unknown as (input: CoreArgumentInput, request: SemanticOutlineRequest,
  model: SemanticOutlineModel, parse: typeof projectCoreSemanticOutline, signal?: AbortSignal) => Promise<SemanticOutlineRun>;
export function prepareSemanticOutlineRequest(input: CoreArgumentInput): SemanticOutlineRequest {
  return { version: DOCUMENT_CORE_SEMANTIC_OUTLINE_VERSION, systemPrompt: DOCUMENT_CORE_SEMANTIC_OUTLINE_PROMPT,
    userInput: prepareCoreInputPacket(input), parameters: { temperature: 0, maxTokens: CORE_ARGUMENT_LIMITS.maxTokens, thinkingMode: 'disabled' } };
}
export async function runSemanticOutlineExtraction(input: CoreArgumentInput, model: SemanticOutlineModel, signal?: AbortSignal): Promise<SemanticOutlineRun> {
  const source = structuredClone(input); return runExperiment(source, prepareSemanticOutlineRequest(source), model, projectCoreSemanticOutline, signal);
}

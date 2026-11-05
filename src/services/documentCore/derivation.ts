import { DOCUMENT_CORE_DERIVATION_PROMPT, DOCUMENT_CORE_DERIVATION_VERSION } from '../../workflows/documentCoreDerivationPrompt';
import { locateDocumentArgumentQuote } from '../documentArgumentQuoteLocator';
import type { DocumentArgumentRole } from '../documentArgumentV5Types';
import { parseCoreArguments, parseCoreJson } from './protocol';
import { prepareCoreInputPacket, runPreparedCoreExtraction } from './runner';
import { CORE_ARGUMENT_LIMITS, emptyCoreChainMembers, type CoreArgumentInput, type CoreArgumentModel,
  type CoreArgumentRequest, type CoreArgumentResult, type CoreArgumentRun } from './types';

export interface CoreMaterial { id: string; source: Array<{ passageId: string; quote: string }> }
export interface CoreDerivationStep { id: string; premises: string[]; conclusion: string; kind: 'support' | 'oppose'; reason: string }
const ATTACHMENTS = ['conditions', 'limitations', 'methods', 'context'] as const;
export type CoreDerivationConclusion = Record<typeof ATTACHMENTS[number], string[]> & { nodeId: string; reason: string; gaps: string[] };
export interface CoreDerivationResult extends CoreArgumentResult {
  derivation: { version: typeof DOCUMENT_CORE_DERIVATION_VERSION; materials: CoreMaterial[]; steps: CoreDerivationStep[];
    conclusions: CoreDerivationConclusion[]; stepArgumentIds: Record<string, string>;
    materialUses: Record<string, { graphRole: DocumentArgumentRole; uses: string[] }>;
    projectionNotes: Array<{ materialId: string; kind: 'multiple_explicit_uses'; reason: string }>;
    projection: 'roles-from-explicit-use; graph-support-arrays-are-not-independent-proof-groups' };
}
export type CoreDerivationRun = Omit<CoreArgumentRun, 'result'> & { result?: CoreDerivationResult };

function requireValue(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
function object(value: any, keys: string[]) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...keys].sort().join('|'), '字段结构不匹配');
}
function list(value: any, limit: number): any[] { requireValue(Array.isArray(value) && value.length <= limit, '数组类型或预算非法'); return value; }
function words(value: any, limit: number): string { requireValue(typeof value === 'string' && value.trim() && value.length <= limit, '文字为空或超预算'); return value; }
function references(value: any): string[] {
  const items = list(value, CORE_ARGUMENT_LIMITS.nodes);
  requireValue(items.every(id => typeof id === 'string') && new Set(items).size === items.length, 'ID列表非法或重复'); return items;
}

/** Source and reference validation only. The short step reason is not semantic certification. */
export function parseCoreDerivations(raw: string, input: CoreArgumentInput, options: { unboundStepTargets?: string[] } = {}): CoreDerivationResult {
  const value = parseCoreJson(raw); object(value, ['materials', 'steps', 'conclusions', 'unresolved']);
  const issues: CoreArgumentResult['issues'] = [], quarantined: CoreArgumentResult['quarantined'] = [];
  const issue = (id: string, code: string, reason: string) => issues.push({ id, code, reason });
  function collect<T>(layer: string, values: any[], key: string, parse: (row: any) => T): T[] {
    const counts = new Map<unknown, number>();
    for (const row of values) counts.set(row?.[key], (counts.get(row?.[key]) || 0) + 1);
    return values.flatMap((row, index) => {
      const id = String(row?.[key] ?? `${layer}-${index + 1}`);
      try { requireValue(typeof row?.[key] === 'string' && counts.get(row[key]) === 1, '身份缺失或重复，重复项全部隔离'); return [parse(row)]; }
      catch (error) { quarantined.push({ layer, id, value: row }); issue(id, `${layer}_quarantined`, error instanceof Error ? error.message : String(error)); return []; }
    });
  }
  const passages = new Map(input.passages.map(passage => [passage.id, passage]));
  const materials = collect<CoreMaterial>('material', list(value.materials, CORE_ARGUMENT_LIMITS.nodes), 'id', row => {
    object(row, ['id', 'source']); requireValue(/^N[1-9]\d*$/u.test(row.id), '材料ID非法');
    const sources = list(row.source, 4); requireValue(sources.length, '材料缺少来源');
    const seen = new Set<string>();
    for (const entry of sources) {
      object(entry, ['passageId', 'quote']); const passage = passages.get(entry.passageId); requireValue(passage, '段落不可用');
      const range = locateDocumentArgumentQuote(passage.text, words(entry.quote, 5000));
      const key = `${passage.id}:${range.start}:${range.end}`; requireValue(!seen.has(key), '来源重复'); seen.add(key);
    }
    return structuredClone(row);
  });
  const materialIds = new Set(materials.map(material => material.id));
  const steps = collect<CoreDerivationStep>('step', list(value.steps, CORE_ARGUMENT_LIMITS.arguments), 'id', row => {
    object(row, ['id', 'premises', 'conclusion', 'kind', 'reason']); requireValue(/^S[1-9]\d*$/u.test(row.id), '步骤ID非法');
    const premises = references(row.premises); requireValue(premises.length, '空前提不是推导步骤，声明应只保留材料');
    requireValue(['support', 'oppose'].includes(row.kind) && materialIds.has(row.conclusion), '步骤目标或用途非法');
    requireValue(premises.every(id => materialIds.has(id) && id !== row.conclusion), '步骤引用缺失或自连');
    words(row.reason, 100); return structuredClone(row);
  });
  const conclusions = collect<CoreDerivationConclusion>('conclusion', list(value.conclusions, CORE_ARGUMENT_LIMITS.coreClaims), 'nodeId', row => {
    object(row, ['nodeId', ...ATTACHMENTS, 'reason', 'gaps']); requireValue(materialIds.has(row.nodeId), '核心结论材料缺失');
    words(row.reason, 160); const gaps = list(row.gaps, 8).map(gap => words(gap, 200));
    const attachments = { conditions: [], limitations: [], methods: [], context: [] } as Record<typeof ATTACHMENTS[number], string[]>;
    for (const key of ATTACHMENTS) {
      let ids: string[];
      try { ids = references(row[key]); }
      catch { issue(`${row.nodeId}:${key}`, 'attachment_invalid', '归属列表非法，保留其他列表'); quarantined.push({ layer: 'attachment', id: `${row.nodeId}:${key}`, value: row[key] }); continue; }
      attachments[key] = ids.filter(id => {
        if (materialIds.has(id) && id !== row.nodeId) return true;
        issue(`${row.nodeId}:${key}:${id}`, 'attachment_reference_invalid', '归属材料缺失或自指，未创建替代材料');
        quarantined.push({ layer: 'attachment', id: `${row.nodeId}:${key}:${id}`, value: id }); return false;
      });
    }
    return { nodeId: row.nodeId, ...attachments, reason: row.reason, gaps };
  });
  const unresolved = collect<{ nodeId?: string; reason: string }>('unresolved', list(value.unresolved, 20).map((row, index) => ({ _id: `U${index + 1}`, entry: row })), '_id', wrapped => {
    const row = wrapped.entry;
    object(row, row?.nodeId === undefined ? ['reason'] : ['nodeId', 'reason']); words(row.reason, 200);
    requireValue(row.nodeId === undefined || materialIds.has(row.nodeId), '未决项材料缺失');
    return { ...(row.nodeId ? { nodeId: row.nodeId } : {}), reason: row.reason };
  });
  const invalidTargets = new Set<string>();
  for (const target of options.unboundStepTargets || []) {
    requireValue(materialIds.has(target), '未绑定步骤的目标不存在'); invalidTargets.add(target);
  }
  for (const entry of quarantined.filter(entry => entry.layer === 'step')) {
    const target = (entry.value as any)?.conclusion; if (materialIds.has(target)) invalidTargets.add(target);
  }
  const claims = new Set([...steps.map(step => step.conclusion), ...conclusions.map(conclusion => conclusion.nodeId), ...invalidTargets]);
  const premises = new Set(steps.flatMap(step => step.premises));
  const methods = new Set(conclusions.flatMap(conclusion => conclusion.methods));
  const nodes = materials.map(material => ({ ...material,
    role: (claims.has(material.id) ? 'claim' : premises.has(material.id) ? 'premise' : methods.has(material.id) ? 'method' : 'background') as DocumentArgumentRole }));
  const materialUses = Object.fromEntries(nodes.map(node => {
    const uses = [
      ...(claims.has(node.id) ? ['step_target_or_core_conclusion'] : []),
      ...(premises.has(node.id) ? ['step_premise'] : []),
      ...ATTACHMENTS.filter(key => conclusions.some(conclusion => conclusion[key].includes(node.id))),
    ];
    return [node.id, { graphRole: node.role, uses }];
  }));
  const projectionNotes = nodes.filter(node => methods.has(node.id) && (claims.has(node.id) || premises.has(node.id)))
    .map(node => ({ materialId: node.id, kind: 'multiple_explicit_uses' as const,
      reason: '同一材料兼作方法来源与论证材料；图角色按明确步骤用途投影。多用途记录不证明支持关系在语义上成立。' }));
  const arguments_ = [...claims].map((claim, index) => {
    const incoming = steps.filter(step => step.conclusion === claim);
    const support = [...new Set(incoming.filter(step => step.kind === 'support').flatMap(step => step.premises))];
    const oppose = [...new Set(incoming.filter(step => step.kind === 'oppose').flatMap(step => step.premises))];
    // The authoritative per-step groups and reasons are retained in derivation.steps.
    const incomplete = invalidTargets.has(claim) || conclusions.some(conclusion => conclusion.nodeId === claim && conclusion.gaps.length);
    return { id: `A${index + 1}`, claim, support, oppose, status: incomplete ? 'incomplete' : support.length ? 'argued' : 'stated_only' };
  });
  const wire = { nodes, arguments: arguments_, relations: [], coreClaims: conclusions.map(conclusion => ({ nodeId: conclusion.nodeId,
    reason: conclusion.reason, gaps: conclusion.gaps, members: { ...emptyCoreChainMembers(), ...Object.fromEntries(ATTACHMENTS.map(key => [key, conclusion[key]])) } })), unresolved };
  const result = parseCoreArguments(JSON.stringify(wire), input, { requireMembership: true, allowDerivedArguments: true, membershipRolePolicy: 'derived-use' });
  for (const chain of result.chains) if (chain.membershipSource === 'model') chain.membershipSource = 'derivation';
  // Circular support is recorded, never "fixed" by silently removing an edge.
  const complete = new Set<string>(), active = new Set<string>();
  const checkCycle = (id: string) => {
    if (active.has(id)) { issue(id, 'circular_derivation', '明示支持步骤存在环，未把循环论证改成有效推导'); return; }
    if (complete.has(id)) return; active.add(id);
    for (const step of steps.filter(step => step.kind === 'support' && step.conclusion === id)) for (const source of step.premises) checkCycle(source);
    active.delete(id); complete.add(id);
  };
  for (const id of claims) checkCycle(id);
  const stepArgumentIds = Object.fromEntries(steps.map(step => [step.id, result.graph.arguments.find(argument => argument.claim === step.conclusion)?.id || '']));
  for (const step of steps) if (!stepArgumentIds[step.id]) issue(step.id, 'step_projection_pending', '推导保留在steps中，因图契约冲突暂未投影，未删除原始推导');
  result.issues.unshift(...issues); result.quarantined.unshift(...quarantined);
  if (result.issues.length) for (const chain of result.chains) chain.state = 'source_review_required';
  return { ...result, derivation: { version: DOCUMENT_CORE_DERIVATION_VERSION, materials, steps, conclusions, stepArgumentIds, materialUses, projectionNotes,
    projection: 'roles-from-explicit-use; graph-support-arrays-are-not-independent-proof-groups' } };
}

export function prepareCoreDerivationRequest(input: CoreArgumentInput): CoreArgumentRequest {
  return { version: DOCUMENT_CORE_DERIVATION_VERSION, systemPrompt: DOCUMENT_CORE_DERIVATION_PROMPT,
    userInput: prepareCoreInputPacket(input), parameters: { temperature: 0, maxTokens: CORE_ARGUMENT_LIMITS.maxTokens, thinkingMode: 'disabled' } };
}
export async function runCoreDerivationExtraction(source: CoreArgumentInput, model: CoreArgumentModel, signal?: AbortSignal): Promise<CoreDerivationRun> {
  const input = structuredClone(source);
  return runPreparedCoreExtraction(input, prepareCoreDerivationRequest(input), model, parseCoreDerivations, signal) as Promise<CoreDerivationRun>;
}

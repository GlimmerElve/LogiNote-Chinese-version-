import { locateDocumentArgumentQuote } from '../documentArgumentQuoteLocator';
import type { DocumentArgumentNode } from '../documentArgumentV5Types';
import { CORE_ARGUMENT_LIMITS, CORE_CHAIN_MEMBER_KEYS, emptyCoreChainMembers, type CoreArgumentInput, type CoreArgumentResult, type CoreChainPackage } from './types';

function demand(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
function shape(value: any, keys: string[]) {
  demand(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...keys].sort().join('|'), '字段结构不匹配');
}
function rows(value: any, limit: number): any[] { demand(Array.isArray(value) && value.length <= limit, '数组预算或类型不匹配'); return value; }
function text(value: any, max = 160): string { demand(typeof value === 'string' && value.trim() && value.length <= max, '文本为空或超过预算'); return value; }
function ids(value: any): string[] {
  demand(Array.isArray(value) && value.length <= 60 && value.every(id => typeof id === 'string')
    && new Set(value).size === value.length, '节点列表重复或不可读'); return value;
}
function rejectDuplicateKeys(raw: string) {
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '{') stack.push(new Set());
    else if (raw[i] === '[') stack.push(null);
    else if (raw[i] === '}' || raw[i] === ']') stack.pop();
    else if (raw[i] === '"') {
      const start = i++;
      while (i < raw.length) { if (raw[i] === '\\') i += 2; else if (raw[i] === '"') break; else i++; }
      let next = i + 1; while (next < raw.length && /\s/u.test(raw[next])) next++;
      if (raw[next] === ':') {
        const key = JSON.parse(raw.slice(start, i + 1)), seen = stack.at(-1);
        demand(seen && !seen.has(key), 'JSON字段重复'); seen.add(key);
      }
    }
  }
}

/** Shared syntax boundary, also used by the separate derivation wire format. */
export function parseCoreJson(raw: string): any {
  demand(typeof raw === 'string' && raw.length <= 100000, '响应为空或超过预算');
  const value = JSON.parse(raw); rejectDuplicateKeys(raw); return value;
}

/** Bind source first; quarantine bad records, never invent a repair edge or semantic premise. */
export function parseCoreArguments(raw: string, input: CoreArgumentInput, options: { requireMembership?: boolean; allowDerivedArguments?: boolean; membershipRolePolicy?: 'strict' | 'derived-use' } = {}): CoreArgumentResult {
  const value = parseCoreJson(raw);
  shape(value, ['nodes', 'arguments', 'relations', 'coreClaims', 'unresolved']);
  const result: CoreArgumentResult = { graph: { nodes: [], arguments: [], relations: [], unresolved: [] }, chains: [], issues: [], quarantined: [] };
  const issue = (id: string, code: string, reason: string) => result.issues.push({ id, code, reason });
  function collect<T>(layer: string, values: any[], key: string, parse: (row: any) => T): T[] {
    const counts = new Map<unknown, number>();
    for (const row of values) counts.set(row?.[key], (counts.get(row?.[key]) || 0) + 1);
    return values.flatMap((row, index) => {
      const id = String(row?.[key] ?? `${layer}-${index + 1}`);
      try {
        demand(typeof row?.[key] === 'string' && counts.get(row[key]) === 1, '身份缺失或重复（重复身份全部隔离）');
        return [parse(row)];
      } catch (error) {
        result.quarantined.push({ layer, id, value: row });
        issue(id, `${layer}_quarantined`, error instanceof Error ? error.message : String(error)); return [];
      }
    });
  }
  const passages = new Map(input.passages.map(passage => [passage.id, passage]));
  result.graph.nodes = collect('node', rows(value.nodes, CORE_ARGUMENT_LIMITS.nodes), 'id', row => {
    shape(row, ['id', 'role', 'source']);
    demand(/^N[1-9]\d*$/u.test(row.id) && ['claim', 'premise', 'background', 'method'].includes(row.role), '节点ID或角色非法');
    const sources = rows(row.source, 4); demand(sources.length, '节点缺少原文');
    const seen = new Set<string>();
    const source = sources.map(entry => {
      shape(entry, ['passageId', 'quote']);
      const passage = passages.get(entry.passageId); demand(passage, '引文不属于所给段落');
      const quote = text(entry.quote, 5000), range = locateDocumentArgumentQuote(passage.text, quote);
      const key = `${passage.id}:${range.start}:${range.end}`; demand(!seen.has(key), '来源重复'); seen.add(key);
      return { chunkId: passage.id, start: range.start, end: range.end };
    });
    return { id: row.id, role: row.role, batch: 1, source } as DocumentArgumentNode;
  });
  const nodes = new Map(result.graph.nodes.map(node => [node.id, node]));
  result.graph.arguments = collect('argument', rows(value.arguments, options.allowDerivedArguments ? CORE_ARGUMENT_LIMITS.nodes : CORE_ARGUMENT_LIMITS.arguments), 'id', row => {
    shape(row, ['id', 'claim', 'support', 'oppose', 'status']); text(row.id, 80);
    demand(nodes.get(row.claim)?.role === 'claim', '主张端点不可用或角色非法');
    const support = ids(row.support), oppose = ids(row.oppose);
    for (const id of [...support, ...oppose]) demand(id !== row.claim && ['premise', 'claim'].includes(nodes.get(id)?.role || ''), '论据端点不可用或角色非法');
    demand(support.every(id => !oppose.includes(id)), '同一材料同时支持和反对');
    demand(['argued', 'stated_only', 'incomplete'].includes(row.status), '主张状态非法');
    demand(row.status !== 'argued' || support.length > 0, 'argued缺少支持依据');
    demand(row.status !== 'stated_only' || support.length === 0, 'stated_only不应含支持依据');
    return { id: row.id, claim: row.claim, support, oppose, status: row.status };
  });
  // Duplicate claim arguments are all untrusted, not silently concatenated.
  const claimCounts = new Map<string, number>();
  for (const argument of result.graph.arguments) claimCounts.set(argument.claim, (claimCounts.get(argument.claim) || 0) + 1);
  result.graph.arguments = result.graph.arguments.filter(argument => {
    if (claimCounts.get(argument.claim) === 1) return true;
    result.quarantined.push({ layer: 'argument', id: argument.id, value: argument });
    issue(argument.id, 'duplicate_claim_argument', '同一claim对应多条argument，未猜测合并方式'); return false;
  });
  const signatures = new Set<string>();
  result.graph.relations = collect('relation', rows(value.relations, CORE_ARGUMENT_LIMITS.relations), 'id', row => {
    shape(row, ['id', 'kind', 'from', 'to', 'reason']); text(row.id, 80); text(row.reason);
    demand(['context', 'method_for', 'relates'].includes(row.kind), 'support/oppose不能写入relations，未自动搬移');
    const from = nodes.get(row.from), to = nodes.get(row.to);
    demand(from && to && from.id !== to.id, '辅助关系端点缺失或自环');
    demand(row.kind !== 'context' || ['background', 'premise'].includes(from.role), 'context来源角色非法');
    demand(row.kind !== 'method_for' || from.role === 'method' && ['premise', 'claim'].includes(to.role), 'method_for角色非法');
    const signature = JSON.stringify([row.kind, row.from, row.to]);
    demand(!signatures.has(signature), '辅助关系重复'); signatures.add(signature);
    return { id: row.id, kind: row.kind, from: row.from, to: row.to, reason: row.reason };
  });
  const core = collect('core', rows(value.coreClaims, CORE_ARGUMENT_LIMITS.coreClaims), 'nodeId', row => {
    const hasMembers = Object.hasOwn(row, 'members');
    shape(row, hasMembers ? ['nodeId', 'reason', 'gaps', 'members'] : ['nodeId', 'reason', 'gaps']); text(row.reason);
    demand(nodes.get(row.nodeId)?.role === 'claim', '核心结论不是可定位claim');
    const gaps = rows(row.gaps, 8).map(gap => text(gap, 200));
    demand(result.graph.arguments.some(argument => argument.claim === row.nodeId), '核心结论缺少argument');
    const members = emptyCoreChainMembers();
    let membershipSource: CoreChainPackage['membershipSource'] = hasMembers ? 'model' : options.requireMembership ? 'missing' : 'legacy';
    const memberIssue = (id: string, reason: string, value: unknown) => {
      membershipSource = 'partial';
      issue(id, 'chain_member_invalid', reason);
      result.quarantined.push({ layer: 'chain_member', id, value });
    };
    if (!hasMembers && options.requireMembership) issue(row.nodeId, 'chain_members_missing', '新版缺少members归属；保留核心图但不视为新版契约通过');
    if (hasMembers) {
      const object = row.members;
      if (!object || typeof object !== 'object' || Array.isArray(object)) {
        memberIssue(`${row.nodeId}:members`, 'members不是归属对象，未猜测归属', object);
      } else {
        if (Object.keys(object).some(key => !CORE_CHAIN_MEMBER_KEYS.includes(key as typeof CORE_CHAIN_MEMBER_KEYS[number]))) {
          memberIssue(`${row.nodeId}:members`, 'members含未定义分类，未转换为关系', object);
        }
        for (const key of CORE_CHAIN_MEMBER_KEYS) {
          let references: string[];
          try { references = ids(object[key]); }
          catch { memberIssue(`${row.nodeId}:${key}`, '归属列表缺失、重复或类型非法，其他列表保留', object[key]); continue; }
          for (const id of references) {
            const node = nodes.get(id);
            if (!node || id === row.nodeId) {
              memberIssue(`${row.nodeId}:${key}:${id}`, '归属引用缺失或引用核心结论自身，其他有效归属保留', id); continue;
            }
            // Preserve the model's semantic proposal while recording role conflicts.
            // Never reclassify the node or manufacture a support/oppose edge.
            if (key === 'methods' && node.role !== 'method' && options.membershipRolePolicy !== 'derived-use' || key === 'intermediates' && node.role !== 'claim'
              || ['evidence', 'counterpoints'].includes(key) && !['premise', 'claim'].includes(node.role)) {
              membershipSource = 'partial';
              issue(`${row.nodeId}:${key}:${id}`, 'chain_member_role', '归属与节点角色冲突；保留提议待审，不改角色或边');
            }
            members[key].push(id);
          }
        }
      }
    }
    return { nodeId: row.nodeId as string, reason: row.reason as string, gaps, members, membershipSource };
  });
  for (const [index, entry] of rows(value.unresolved, 20).entries()) {
    try {
      shape(entry, entry.nodeId === undefined ? ['reason'] : ['nodeId', 'reason']);
      text(entry.reason, 200); demand(entry.nodeId === undefined || nodes.has(entry.nodeId), '缺口引用不可用节点');
      result.graph.unresolved.push({ batch: 1, ...(entry.nodeId ? { nodeId: entry.nodeId } : {}), reason: entry.reason });
    } catch (error) { issue(`U${index + 1}`, 'invalid_gap', error instanceof Error ? error.message : String(error)); }
  }
  for (const selected of core) {
    const visited = new Set<string>(), argumentIds = new Set<string>(), relationIds = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return; visited.add(id);
      for (const argument of result.graph.arguments.filter(argument => argument.claim === id)) {
        argumentIds.add(argument.id); for (const source of [...argument.support, ...argument.oppose]) visit(source);
      }
      // Keep an explicitly opposed claim beside counterevidence used by this chain.
      // Do not reverse support edges: sharing a premise alone does not make all
      // downstream conclusions part of the selected argument.
      for (const argument of result.graph.arguments.filter(argument => argument.oppose.includes(id))) {
        visit(argument.claim);
      }
      for (const relation of result.graph.relations.filter(relation => relation.to === id || relation.kind === 'relates' && relation.from === id)) {
        relationIds.add(relation.id); visit(relation.from === id ? relation.to : relation.from);
      }
    };
    visit(selected.nodeId);
    // Model-declared chain materials can belong without a binary proof relation
    // to the root. Include their existing subarguments, not inferred new edges.
    for (const key of CORE_CHAIN_MEMBER_KEYS) for (const id of selected.members[key]) visit(id);
    // Organising a node into a proof-related slot cannot stand in for an actual
    // support/oppose use. Conditions and limitations may legitimately be edge-free.
    const chainArguments = result.graph.arguments.filter(argument => argumentIds.has(argument.id));
    for (const key of ['evidence', 'intermediates', 'counterpoints'] as const) for (const id of selected.members[key]) {
      const used = key === 'counterpoints'
        ? chainArguments.some(argument => argument.oppose.includes(id) || argument.claim === id && argument.oppose.length > 0)
        : chainArguments.some(argument => argument.support.includes(id));
      if (!used) {
        selected.membershipSource = 'partial';
        issue(`${selected.nodeId}:${key}:${id}`, 'member_without_argument_use', '论证材料只有链内归属，未见相应support/oppose用途；未自动补边');
      }
    }
    const argument = result.graph.arguments.find(argument => argument.claim === selected.nodeId)!;
    if (argument.status === 'incomplete' && !selected.gaps.length) issue(selected.nodeId, 'unexplained_gap', 'incomplete未说明具体缺口');
    const chain: CoreChainPackage = { claimId: selected.nodeId, nodeIds: [...visited], argumentIds: [...argumentIds], relationIds: [...relationIds],
      members: selected.members, membershipSource: selected.membershipSource,
      modelStatus: argument.status, state: result.quarantined.length || ['missing', 'partial'].includes(selected.membershipSource) ? 'source_review_required' : 'candidate', reason: selected.reason, gaps: selected.gaps };
    result.chains.push(chain);
  }
  const used = new Set(result.chains.flatMap(chain => chain.nodeIds));
  for (const node of result.graph.nodes) if (!used.has(node.id)) issue(node.id, 'outside_selected_chains', '节点未服务于任何所选核心结论；只记录，不补边');
  for (const node of result.graph.nodes.filter(node => node.role === 'claim')) {
    if (!result.graph.arguments.some(argument => argument.claim === node.id)) issue(node.id, 'claim_without_argument', '主张缺少argument，未造默认关系');
  }
  // Any structural rejection is visible; even intact sibling chains stay candidates, never certified.
  return result;
}

/** Source text is reconstructed locally, never trusted from a model summary. */
export function replayCoreNode(node: DocumentArgumentNode, input: CoreArgumentInput): string {
  return node.source.map(source => {
    const passage = input.passages.find(passage => passage.id === source.chunkId);
    demand(passage && source.start >= 0 && source.end > source.start && source.end <= passage.text.length, '来源失效');
    return passage.text.slice(source.start, source.end);
  }).join('\n');
}

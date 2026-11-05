import type { S2CanvasDefinition } from '../../types/sceneS2';
import { s2BuiltinPluginRegistry } from './sceneS2PluginRegistry';

export interface S2EvidenceQuote { path: string; quote: string }
type Endpoint = { nodeId: string; portId: string };
type Source = { kind: 'field'; nodeId: string; fieldId: string } | { kind: 'literal' } | { kind: 'execution-output'; nodeId: string; portId: string } | { kind: 'unbound' };
export type S2DesignFactClaim = { kind: 'data-link'; source: Endpoint; target: Endpoint; present: boolean }
  | { kind: 'input-source'; nodeId: string; portId: string; source: Source }
  | { kind: 'port-type'; nodeId: string; portId: string; direction: 'input' | 'output'; type: { id: string; version: number } }
  | { kind: 'execution-dependency'; nodeId: string; dependsOnNodeId: string; present: boolean };
export interface S2DesignFactCheck extends S2EvidenceQuote { claim: S2DesignFactClaim; matches: boolean }
const obj = (raw: unknown, fields: string[]) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !fields.includes(k))) throw new Error('S2 事实证据字段无效');
  return raw as Record<string, any>;
};
const text = (v: unknown, max: number) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error('S2 事实证据文本无效'); return v;
};
const id = (v: unknown) => {
  const s = text(v, 64); if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(s) || ['__proto__', 'prototype', 'constructor'].includes(s)) throw new Error('S2 事实对象标识无效'); return s;
};
/** Read a candidate value only; never paths on disk, prototype properties, expressions or external references. */
function valueAt(candidate: S2CanvasDefinition, path: string): unknown {
  if (!path.startsWith('/') || /~(?![01])/u.test(path)) return undefined;
  let value: any = candidate;
  for (const segment of path.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (['__proto__', 'prototype', 'constructor'].includes(segment) || !value || typeof value !== 'object' || !Object.hasOwn(value, segment)
      || Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(segment)) return undefined;
    value = value[segment];
  }
  return value;
}
export function readS2EvidenceQuote(raw: unknown, candidate: S2CanvasDefinition, options: { proseOnly?: boolean; allowEmpty?: boolean } = {}): S2EvidenceQuote {
  const item = obj(raw, ['path', 'quote']), path = text(item.path, 500), value = valueAt(candidate, path);
  const proseOnly = options.proseOnly !== false;
  const contentPath = /^\/(?:initial|business\/completion\/reference)\/nodes\/\d+\/values\/[^/]+$/.test(path);
  const businessProse = /^\/business\/(?:purpose|knowledge\/\d+\/(?:title|content)|workflow\/\d+\/(?:goal|input|output)|criteria\/\d+\/(?:label|expectation))$/.test(path);
  const allowedPath = proseOnly ? contentPath || businessProse || /^\/instructions\/(?:understanding|planning|response)$/.test(path)
    : /^\/(?:instructions|blockTypes|initial|plugins|business)\//.test(path);
  const quote = item.quote;
  const exactEmpty = options.allowEmpty && value === '' && quote === '' && contentPath;
  if (!allowedPath || typeof value !== 'string' || typeof quote !== 'string' || quote.length > 500
    || !(exactEmpty || quote.trim() && value.includes(quote))) throw new Error('S2 审查引用必须来自候选实际说明字段的连续原文；空值只能引用真实空内容字段');
  return { path, quote };
}
function endpoint(raw: unknown): Endpoint { const value = obj(raw, ['nodeId', 'portId']); return { nodeId: id(value.nodeId), portId: id(value.portId) }; }
function readSource(raw: unknown): Source {
  const source = obj(raw, ['kind', 'nodeId', 'fieldId', 'portId']);
  if (source.kind === 'literal' || source.kind === 'unbound') { obj(source, ['kind']); return { kind: source.kind }; }
  if (source.kind === 'field') { obj(source, ['kind', 'nodeId', 'fieldId']); return { kind: 'field', nodeId: id(source.nodeId), fieldId: id(source.fieldId) }; }
  if (source.kind === 'execution-output') { obj(source, ['kind', 'nodeId', 'portId']); return { kind: 'execution-output', nodeId: id(source.nodeId), portId: id(source.portId) }; }
  throw new Error('S2 事实来源类型无效');
}
/** Model chooses which prose assertions matter; host checks their structural truth, not business semantics. */
export function readS2DesignFactChecks(raw: unknown, candidate: S2CanvasDefinition): S2DesignFactCheck[] {
  if (!Array.isArray(raw) || raw.length > 12) throw new Error('S2 审查须提供factChecks数组，最多12项；无结构断言时可为空');
  const registry = s2BuiltinPluginRegistry();
  return raw.map(raw => {
    const item = obj(raw, ['path', 'quote', 'claim', 'matches']), evidence = readS2EvidenceQuote({ path: item.path, quote: item.quote }, candidate);
    // Only an explicit document namespace selects the private witness. General
    // business prose may discuss either graph, so never infer its structural scope.
    // Coverage may still quote that prose; legacy instructions describe initial.
    const referenceScope = evidence.path.startsWith('/business/completion/reference/');
    if (evidence.path.startsWith('/business/') && !referenceScope) throw new Error('S2 结构事实引用缺少明确画布命名空间；请引用/initial/nodes或/business/completion/reference/nodes的实际内容说明，普通业务说明仅可作覆盖证据');
    const document = referenceScope ? candidate.business?.completion.reference : candidate.initial;
    if (!document) throw new Error('S2 事实审查引用的画布命名空间不存在');
    const graph = document.execution;
    const nodeAt = (nodeId: string) => {
      const node = graph?.nodes.find(node => node.id === nodeId);
      if (!node) throw new Error(`S2 事实审查节点不存在：${nodeId}；请修正审查，不对虚构端点或其他画布命名空间节点判通过`);
      return node;
    };
    const portAt = ({ nodeId, portId }: Endpoint, direction: 'input' | 'output') => {
      const cap = registry.capability(nodeAt(nodeId));
      const port = (direction === 'input' ? cap.inputs : cap.outputs).find(port => port.id === portId);
      if (!port) throw new Error(`S2 事实审查端口不存在：${nodeId}.${portId}（${direction}）`);
      return port;
    };
    if (typeof item.matches !== 'boolean') throw new Error('S2 事实审查matches须为布尔值');
    const value = obj(item.claim, ['kind', 'source', 'target', 'present', 'nodeId', 'portId', 'direction', 'type', 'dependsOnNodeId']);
    let claim: S2DesignFactClaim, actual: boolean;
    if (value.kind === 'data-link') {
      obj(value, ['kind', 'source', 'target', 'present']); if (typeof value.present !== 'boolean') throw new Error('S2 连线事实须明确present');
      claim = { kind: 'data-link', source: endpoint(value.source), target: endpoint(value.target), present: value.present };
      const { source, target, present } = claim;
      portAt(source, 'output'); portAt(target, 'input');
      actual = !!graph?.links.some(l => l.source.nodeId === source.nodeId && l.source.portId === source.portId && l.target.nodeId === target.nodeId && l.target.portId === target.portId) === present;
    } else if (value.kind === 'input-source') {
      obj(value, ['kind', 'nodeId', 'portId', 'source']);
      claim = { kind: 'input-source', nodeId: id(value.nodeId), portId: id(value.portId), source: readSource(value.source) };
      const { nodeId, portId, source } = claim;
      const node = nodeAt(nodeId), binding = node.bindings[portId]; portAt({ nodeId, portId }, 'input');
      if (source.kind === 'execution-output') portAt(source, 'output');
      if (source.kind === 'field' && !document.nodes.some(node => node.id === source.nodeId && Object.hasOwn(node.values, source.fieldId))) throw new Error('S2 事实审查内容字段不存在于引用的画布命名空间');
      const incoming = graph?.links.filter(l => l.target.nodeId === nodeId && l.target.portId === portId) ?? [];
      actual = source.kind === 'unbound' ? !binding && !incoming.length
        : source.kind === 'literal' ? binding?.kind === 'literal'
          : source.kind === 'field' ? binding?.kind === 'field' && binding.nodeId === source.nodeId && binding.fieldId === source.fieldId
            : incoming.some(l => l.source.nodeId === source.nodeId && l.source.portId === source.portId);
    } else if (value.kind === 'port-type') {
      obj(value, ['kind', 'nodeId', 'portId', 'direction', 'type']); const type = obj(value.type, ['id', 'version']);
      if (!['input', 'output'].includes(value.direction) || !Number.isSafeInteger(type.version) || type.version < 1) throw new Error('S2 端口事实方向或版本无效');
      claim = { kind: 'port-type', nodeId: id(value.nodeId), portId: id(value.portId), direction: value.direction, type: { id: text(type.id, 120), version: type.version } };
      const { nodeId, portId } = claim;
      const port = portAt({ nodeId, portId }, claim.direction);
      actual = port.type.id === claim.type.id && port.type.version === claim.type.version;
    } else if (value.kind === 'execution-dependency') {
      obj(value, ['kind', 'nodeId', 'dependsOnNodeId', 'present']);
      if (typeof value.present !== 'boolean') throw new Error('S2 依赖事实须明确present');
      claim = { kind: 'execution-dependency', nodeId: id(value.nodeId), dependsOnNodeId: id(value.dependsOnNodeId), present: value.present };
      const { nodeId, dependsOnNodeId, present } = claim; nodeAt(nodeId); nodeAt(dependsOnNodeId);
      if (nodeId === dependsOnNodeId) throw new Error('S2 依赖事实不能以节点自身作前置');
      const visited = new Set<string>();
      const dependsOn = (id: string): boolean => {
        if (visited.has(id)) return false; visited.add(id);
        const when = nodeAt(id).when;
        const upstream = [...graph!.links.filter(link => link.target.nodeId === id).map(link => link.source.nodeId), ...(when ? [when.nodeId] : [])];
        return upstream.includes(dependsOnNodeId) || upstream.some(dependsOn);
      };
      actual = dependsOn(nodeId) === present;
    } else throw new Error('S2 事实审查只支持真实连线、输入来源、端口类型与执行依赖');
    if (item.matches !== actual) throw new Error(`S2 事实审查与真实画布不符：${evidence.path}，该claim的matches应为${actual}；请修正审查，不能编造连线或把固定常量当成上游输入`);
    return { ...evidence, claim, matches: actual };
  });
}

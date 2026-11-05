import type { S2CanvasDefinition, S2Document, S2WorkflowNode } from '../../types/sceneS2';
import type { S2ExecutionLink } from '../../types/sceneS2Plugin';
import { s2ConnectionFieldLabel, s2ConnectionNodeLabel, s2ConnectionPortLabel } from './sceneS2Connections';
import { s2BuiltinPluginRegistry } from './sceneS2PluginRegistry';
import { preflightS2ExecutionGraph, S2PluginProtocolError } from './sceneS2PluginProtocol';
import { s2ExecutionLinkKey, s2WorkflowOrder } from './sceneS2Workflow';

export interface S2ConnectionIssue {
  kind: 'duplicate' | 'occupied-input' | 'source-limit' | 'cycle' | 'optional-output';
  title: string;
  summary: string;
  detail: string;
  /** Navigation only: every ID exists in the unchanged original document. */
  nodeIds: string[];
  connectionIds: string[];
  technical: string;
}

const registry = s2BuiltinPluginRegistry();
type Binding = { kind: 'literal' } | { kind: 'field'; nodeId: string; fieldId: string };
type TopologyNode = Pick<S2WorkflowNode, 'id' | 'pluginId' | 'pluginVersion' | 'capabilityId'> & {
  bindings: Record<string, Binding>; when?: { nodeId: string; portId: string };
};
type Topology = { nodes: TopologyNode[]; links: S2ExecutionLink[] };
const unique = (values: string[]) => [...new Set(values)];
function own(raw: unknown, key: string): unknown {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid topology');
  const descriptor = Object.getOwnPropertyDescriptor(raw, key);
  if (!descriptor || !('value' in descriptor)) throw new Error('Invalid topology');
  return descriptor.value;
}
function record(raw: unknown, names?: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid topology');
  if (names && Object.keys(raw).some(key => !names.includes(key))) throw new Error('Unsupported topology');
  return raw as Record<string, unknown>;
}
function id(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(raw)
    || ['__proto__', 'constructor', 'prototype'].includes(raw)) throw new Error('Invalid topology');
  return raw;
}
function ref(raw: unknown): S2ExecutionLink['source'] {
  record(raw, ['nodeId', 'portId']); return { nodeId: id(own(raw, 'nodeId')), portId: id(own(raw, 'portId')) };
}
function link(raw: unknown): S2ExecutionLink {
  record(raw, ['source', 'target']); return { source: ref(own(raw, 'source')), target: ref(own(raw, 'target')) };
}
function binding(raw: unknown): Binding {
  const kind = own(raw, 'kind');
  if (kind === 'literal') { record(raw, ['kind', 'value']); return { kind }; }
  if (kind === 'field') {
    record(raw, ['kind', 'nodeId', 'fieldId']); return { kind, nodeId: id(own(raw, 'nodeId')), fieldId: id(own(raw, 'fieldId')) };
  }
  throw new Error('Unsupported binding');
}
function bindings(raw: unknown): Record<string, Binding> {
  return Object.fromEntries(Object.keys(record(raw)).map(key => [id(key), binding(own(raw, key))]));
}
function condition(raw: unknown) {
  record(raw, ['nodeId', 'portId', 'pointer', 'equals', 'match']);
  return { nodeId: id(own(raw, 'nodeId')), portId: id(own(raw, 'portId')) };
}
function topology(document: S2Document): Topology {
  return { nodes: (document.execution?.nodes ?? []).map(node => ({
    id: node.id, pluginId: node.pluginId, pluginVersion: node.pluginVersion, capabilityId: node.capabilityId,
    bindings: bindings(node.bindings), ...(node.when ? { when: condition(node.when) } : {}),
  })), links: (document.execution?.links ?? []).map(link) };
}
function edit(graph: Topology, raw: unknown) {
  const command = record(raw), op = own(command, 'op');
  if (op === 'connect-ports' || op === 'disconnect-ports') {
    record(command, ['op', 'link']); const connection = link(own(command, 'link'));
    if (op === 'connect-ports') graph.links.push(connection);
    else {
      const key = s2ExecutionLinkKey(connection);
      if (!graph.links.some(item => s2ExecutionLinkKey(item) === key)) throw new Error('Missing link');
      graph.links = graph.links.filter(item => s2ExecutionLinkKey(item) !== key);
    }
    return;
  }
  const names: Record<string, string[]> = { 'update-execution-node': ['op', 'id', 'bindings'],
    'unbind-input': ['op', 'id', 'portId'], 'set-execution-condition': ['op', 'id', 'when'] };
  if (typeof op !== 'string' || !Object.hasOwn(names, op)) throw new Error('Unsupported command');
  record(command, names[op]); const node = graph.nodes.find(node => node.id === id(own(command, 'id')));
  if (!node) throw new Error('Missing node');
  if (op === 'update-execution-node') node.bindings = { ...node.bindings, ...bindings(own(command, 'bindings')) };
  else if (op === 'unbind-input') delete node.bindings[id(own(command, 'portId'))];
  else { const when = own(command, 'when'); if (when === null) delete node.when; else node.when = condition(when); }
}

/** Reuse native topology checks, with count-only bindings and no source/constant/comparison values. */
function topologyError(graph: Topology): unknown {
  try {
    const provided = graph.nodes.flatMap(node => registry.capability(node).inputs.flatMap(port => {
      const bound = Object.hasOwn(node.bindings, port.id), connected = graph.links.some(item => item.target.nodeId === node.id && item.target.portId === port.id);
      return bound || port.required && !connected ? [{ nodeId: node.id, portId: port.id, count: 1 }] : [];
    }));
    preflightS2ExecutionGraph(registry, graph.nodes.map(({ id, pluginId, pluginVersion, capabilityId }) => ({ id, pluginId, pluginVersion, capabilityId })), graph.links, provided);
    for (const node of graph.nodes) if (node.when) {
      const source = graph.nodes.find(item => item.id === node.when!.nodeId);
      const port = source && registry.capability(source).outputs.find(port => port.id === node.when!.portId);
      if (!port?.required || port.multiple || !['core.assessment', 'structured-data.value', 'workflow-simulation.result', 'human-input.decision'].includes(port.type.id)) return undefined;
    }
    // s2WorkflowOrder only reads IDs and dependency endpoints. Synthetic placeholders contain no task data.
    s2WorkflowOrder({ version: 1, links: graph.links, nodes: graph.nodes.map(node => ({ ...node, position: { x: 0, y: 0 }, bindings: {},
      when: node.when ? { ...node.when, pointer: '', equals: null, match: true } : undefined })) });
  } catch (error) { return error; }
  return undefined;
}
function sameFailure(expected: unknown, actual: unknown) {
  if (expected instanceof S2PluginProtocolError) return actual instanceof S2PluginProtocolError
    && expected.code === actual.code && expected.field === actual.field && expected.message === actual.message;
  return expected instanceof Error && actual instanceof Error && expected.message === '数据与条件依赖组成循环，不能执行'
    && actual.message === expected.message;
}
function cycle(graph: Topology): string[] | undefined {
  const children = new Map(graph.nodes.map(node => [node.id, [] as string[]]));
  graph.links.forEach(link => children.get(link.source.nodeId)?.push(link.target.nodeId));
  graph.nodes.forEach(node => { if (node.when) children.get(node.when.nodeId)?.push(node.id); });
  const visiting = new Set<string>(), done = new Set<string>(), path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (visiting.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (done.has(id)) return undefined;
    visiting.add(id); path.push(id);
    for (const next of children.get(id) ?? []) { const found = visit(next); if (found) return found; }
    path.pop(); visiting.delete(id); done.add(id); return undefined;
  };
  for (const node of graph.nodes) { const found = visit(node.id); if (found) return found; }
  return undefined;
}

/** Call only after applyS2Commands failed. This diagnoses metadata, never validates/authorizes/applies work.
 * Native commands validate each prefix before the eventual atomic commit, so recovery describes the first
 * rejected prefix, not a hypothetical final graph. Unknown operations/errors deliberately remain native.
 */
export function s2ConnectionIssue(definition: S2CanvasDefinition, document: S2Document, commands: unknown, error: unknown): S2ConnectionIssue | null {
  try {
    if (!Array.isArray(commands) || !commands.length || commands.length > 12) return null;
    const graph = topology(document);
    let failure: unknown;
    for (let index = 0; index < commands.length; index++) {
      edit(graph, own(commands, String(index)));
      failure = topologyError(graph);
      if (failure !== undefined) break;
    }
    if (!sameFailure(failure, error)) return null;
    const nodeLabel = (id: string) => s2ConnectionNodeLabel(definition, document, id);
    const portLabel = (ref: S2ExecutionLink['source'], direction: 'inputs' | 'outputs') => s2ConnectionPortLabel(definition, document, ref, direction);
    const currentLinks = document.execution?.links ?? [], currentNodes = document.execution?.nodes ?? [];
    const code = failure instanceof S2PluginProtocolError ? failure.code : 'CONDITION_CYCLE';
    const technical = JSON.stringify({ code, ...(failure instanceof S2PluginProtocolError ? { field: failure.field } : {}) });
    const unchanged = '本次修改未应用，原有材料和连线都保留；不会自动删线、选取来源或运行。';
    const result = (kind: S2ConnectionIssue['kind'], title: string, summary: string, detail: string, nodeIds: string[], connectionIds: string[]): S2ConnectionIssue => ({
      kind, title, summary, detail: `${detail}${unchanged}`, nodeIds: unique(nodeIds), connectionIds: unique(connectionIds), technical,
    });
    if (code === 'DUPLICATE_LINK') {
      const repeated = graph.links.find((link, index) => graph.links.findIndex(item => s2ExecutionLinkKey(item) === s2ExecutionLinkKey(link)) !== index);
      if (!repeated) return null;
      const key = s2ExecutionLinkKey(repeated);
      return result('duplicate', '这条连接已经存在', `${portLabel(repeated.source, 'outputs')}已经交给${portLabel(repeated.target, 'inputs')}。`,
        '同一来源与同一输入只需连接一次。可以查看已有连接，或重新选择不同的目标。', [repeated.source.nodeId, repeated.target.nodeId], currentLinks.some(item => s2ExecutionLinkKey(item) === key) ? [key] : []);
    }
    if (code === 'PORT_CARDINALITY') {
      for (const node of graph.nodes) for (const port of registry.capability(node).inputs) {
        const incoming = graph.links.filter(item => item.target.nodeId === node.id && item.target.portId === port.id), fixed = node.bindings[port.id];
        const count = incoming.length + (fixed ? 1 : 0);
        if ((port.multiple || count <= 1) && count <= 32) continue;
        const target = { nodeId: node.id, portId: port.id }, fieldLabel = fixed?.kind === 'field' ? s2ConnectionFieldLabel(definition, document, fixed.nodeId, fixed.fieldId) : '';
        const sources = [...incoming.map(item => portLabel(item.source, 'outputs')), ...(fixed ? [fieldLabel || '直接填写的固定材料'] : [])];
        const oldBinding = currentNodes.find(item => item.id === node.id)?.bindings[port.id];
        const ids = currentLinks.filter(item => item.target.nodeId === node.id && item.target.portId === port.id).map(s2ExecutionLinkKey);
        if (oldBinding?.kind === 'field') ids.push(JSON.stringify([node.id, port.id, oldBinding]));
        return result(port.multiple ? 'source-limit' : 'occupied-input', port.multiple ? '材料来源数量超过上限' : '这个输入已有材料',
          `${portLabel(target, 'inputs')}${port.multiple ? '最多接收 32 路来源' : '一次只能使用一份材料'}，这次会有 ${count} 路：${sources.join('、')}。`,
          port.multiple ? '请在目标步骤的材料来源中明确减少来源，再连接；系统不会替你舍弃材料。' : '如要更换材料，请在目标步骤的“材料来源”中明确选择；如要保留多路，请先设计能处理多路的步骤，不能把多份材料直接挤入单个输入。',
          [node.id, ...incoming.map(item => item.source.nodeId), ...(fixed?.kind === 'field' ? [fixed.nodeId] : [])], ids);
      }
    }
    if (code === 'MISSING_INPUT' && failure instanceof S2PluginProtocolError && failure.field === 'link') {
      const missing = graph.links.find(item => {
        const source = graph.nodes.find(node => node.id === item.source.nodeId), target = graph.nodes.find(node => node.id === item.target.nodeId);
        const output = source && registry.capability(source).outputs.find(port => port.id === item.source.portId);
        const input = target && registry.capability(target).inputs.find(port => port.id === item.target.portId);
        return output && input && !output.required && input.required;
      });
      if (missing) return result('optional-output', '来源不保证提供所需材料', `${portLabel(missing.source, 'outputs')}可能没有输出，但${portLabel(missing.target, 'inputs')}必须收到材料。`,
        '请选择保证提供完整结果的来源；若需处理缺省情况，必须先明确设计已支持的补值或分支方案，不能把“可能有结果”当成“必定可用”。',
        [missing.source.nodeId, missing.target.nodeId], []);
    }
    if (code === 'EXECUTION_CYCLE' || code === 'CONDITION_CYCLE') {
      const path = cycle(graph); if (!path) return null;
      const pairs = path.slice(0, -1).map((source, index) => [source, path[index + 1]]);
      const ids = currentLinks.filter(item => pairs.some(([source, target]) => item.source.nodeId === source && item.target.nodeId === target)
        && graph.links.some(candidate => s2ExecutionLinkKey(candidate) === s2ExecutionLinkKey(item))).map(s2ExecutionLinkKey);
      for (const node of currentNodes) if (node.when && pairs.some(([source, target]) => source === node.when!.nodeId && target === node.id)
        && graph.nodes.some(candidate => candidate.id === node.id && candidate.when?.nodeId === node.when!.nodeId && candidate.when?.portId === node.when!.portId)) ids.push(JSON.stringify(['condition', node.id]));
      const mixed = pairs.some(([source, target]) => graph.nodes.some(node => node.id === target && node.when?.nodeId === source));
      return result('cycle', path.length === 2 ? '步骤不能等待自己的结果' : '这些步骤会互相等待',
        `${path.map(nodeLabel).join(' → ')}形成${mixed ? '包含运行条件的' : '材料传递'}循环，没有可先完成的起点。`,
        '请查看环内步骤的材料来源和运行条件，明确调整其中一条依赖后重试。普通内容关联不控制执行，可以有环；这里拒绝的是实际运行依赖。', path, ids);
    }
    return null;
  } catch { return null; }
}

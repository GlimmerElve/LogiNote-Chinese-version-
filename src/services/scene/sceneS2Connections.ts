import type { S2CanvasDefinition, S2Document, S2WorkflowNode } from '../../types/sceneS2';
import type { S2ExecutionLink } from '../../types/sceneS2Plugin';
import { s2BuiltinPluginRegistry } from './sceneS2PluginRegistry';
import { s2NodeTitle, s2PortLabel, s2IsHumanConfirmationOutput, s2HumanConfirmationOutcome } from './sceneS2Presentation';
import { s2ExecutionLinkKey } from './sceneS2Workflow';

const registry = s2BuiltinPluginRegistry();
type Endpoint = S2ExecutionLink['source'];
type Direction = 'inputs' | 'outputs';

export interface S2ConnectionDescription {
  id: string;
  kind: 'data' | 'field' | 'condition' | 'association';
  sourceId: string;
  targetId: string;
  shortLabel: string;
  summary: string;
  detail: string;
  /** Endpoint metadata only: never a field value, literal, comparison value or execution receipt. */
  technical: string;
}

/** Display helpers for a validated definition/document. They neither inspect content nor authorize work.
 * Ordinals use the whole document, not the visible composite, so duplicate labels stay distinguishable.
 */
export function s2ConnectionNodeLabel(definition: S2CanvasDefinition, document: S2Document, nodeId: string): string {
  const contentIndex = document.nodes.findIndex(node => node.id === nodeId);
  const stepIndex = document.execution?.nodes.findIndex(node => node.id === nodeId) ?? -1;
  const compositeIndex = document.composites?.findIndex(node => node.id === nodeId) ?? -1;
  if ([contentIndex, stepIndex, compositeIndex].filter(index => index >= 0).length !== 1) throw new Error('连线对象不存在或不唯一');
  if (contentIndex >= 0) {
    const type = definition.blockTypes.find(type => type.id === document.nodes[contentIndex].type);
    if (!type) throw new Error('连线内容类型不存在');
    return `${document.nodes[contentIndex].label?.trim() || type.label}（内容 ${contentIndex + 1}）`;
  }
  if (stepIndex >= 0) return `${s2NodeTitle(document.execution!.nodes[stepIndex])}（步骤 ${stepIndex + 1}）`;
  return `${document.composites![compositeIndex].label}（组合 ${compositeIndex + 1}）`;
}

function endpoint(document: S2Document, ref: Endpoint, direction: Direction) {
  const node = document.execution?.nodes.find(node => node.id === ref.nodeId);
  if (!node) throw new Error('连线步骤不存在');
  const port = registry.capability(node)[direction].find(port => port.id === ref.portId);
  if (!port) throw new Error('连线端口不存在');
  return { node, port };
}

/** Presentation can rename a real port, but cannot invent one. */
export function s2ConnectionPortLabel(definition: S2CanvasDefinition, document: S2Document, ref: Endpoint, direction: Direction): string {
  const { node, port } = endpoint(document, ref, direction);
  return `${s2ConnectionNodeLabel(definition, document, ref.nodeId)}「${s2PortLabel(node, port, direction)}」`;
}

function field(definition: S2CanvasDefinition, document: S2Document, nodeId: string, fieldId: string) {
  const node = document.nodes.find(node => node.id === nodeId);
  const value = definition.blockTypes.find(type => type.id === node?.type)?.fields.find(field => field.id === fieldId);
  if (!node || !value) throw new Error('连线内容字段不存在');
  return value;
}

export function s2ConnectionFieldLabel(definition: S2CanvasDefinition, document: S2Document, nodeId: string, fieldId: string): string {
  return `${s2ConnectionNodeLabel(definition, document, nodeId)}「${field(definition, document, nodeId, fieldId).label}」`;
}

const typeMetadata = (document: S2Document, ref: Endpoint, direction: Direction) => {
  const { node, port } = endpoint(document, ref, direction);
  return { nodeId: node.id, portId: port.id, pluginId: node.pluginId, pluginVersion: node.pluginVersion,
    capabilityId: node.capabilityId, type: { id: port.type.id, version: port.type.version } };
};

/** Four distinct meanings, derived only from design metadata. No source values or outputs are read.
 * IDs deliberately match the original canvas edges; this layer does not create or rewrite links.
 */
export function s2ConnectionDescriptions(definition: S2CanvasDefinition, document: S2Document): S2ConnectionDescription[] {
  const descriptions: S2ConnectionDescription[] = document.edges.map(edge => ({
    id: edge.id, kind: 'association', sourceId: edge.source, targetId: edge.target, shortLabel: `关系：${edge.label}`,
    summary: `${s2ConnectionNodeLabel(definition, document, edge.source)}与${s2ConnectionNodeLabel(definition, document, edge.target)}的关系：${edge.label}。`,
    detail: '只表达内容之间的关系；不传递数据，也不控制运行顺序。',
    technical: JSON.stringify({ kind: 'association', sourceId: edge.source, targetId: edge.target }),
  }));
  for (const link of document.execution?.links ?? []) {
    const target = endpoint(document, link.target, 'inputs');
    descriptions.push({
      id: s2ExecutionLinkKey(link), kind: 'data', sourceId: link.source.nodeId, targetId: link.target.nodeId,
      shortLabel: `交给${s2PortLabel(target.node, target.port, 'inputs')}`,
      summary: `把${s2ConnectionPortLabel(definition, document, link.source, 'outputs')}交给${s2ConnectionPortLabel(definition, document, link.target, 'inputs')}。`,
      detail: '传递来源步骤的完整输出；运行目标时按需先处理来源。连线本身不运行，也不证明材料符合业务目标。',
      technical: JSON.stringify({ kind: 'data', source: typeMetadata(document, link.source, 'outputs'), target: typeMetadata(document, link.target, 'inputs') }),
    });
  }
  for (const target of document.execution?.nodes ?? []) {
    if (target.when) descriptions.push(conditionDescription(definition, document, target));
    for (const [portId, binding] of Object.entries(target.bindings)) if (binding.kind === 'field') {
      const ref = { nodeId: target.id, portId }, targetPort = endpoint(document, ref, 'inputs');
      descriptions.push({
        id: JSON.stringify([target.id, portId, binding]), kind: 'field', sourceId: binding.nodeId, targetId: target.id,
        shortLabel: `使用${field(definition, document, binding.nodeId, binding.fieldId).label}`,
        summary: `把${s2ConnectionFieldLabel(definition, document, binding.nodeId, binding.fieldId)}交给${s2ConnectionPortLabel(definition, document, ref, 'inputs')}。`,
        detail: `直接使用当前内容字段作为「${s2PortLabel(targetPort.node, targetPort.port, 'inputs')}」；内容块不是可运行步骤，这不是执行前置步骤。`,
        technical: JSON.stringify({ kind: 'field', source: { nodeId: binding.nodeId, fieldId: binding.fieldId, type: { id: 'core.text', version: 1 } }, target: typeMetadata(document, ref, 'inputs') }),
      });
    }
  }
  return descriptions;
}

function conditionDescription(definition: S2CanvasDefinition, document: S2Document, target: S2WorkflowNode): S2ConnectionDescription {
  const when = target.when!;
  const producer = document.execution!.nodes.find(node => node.id === when.nodeId);
  const outcome = s2IsHumanConfirmationOutput(producer, when.portId) ? s2HumanConfirmationOutcome(when) : undefined;
  const comparison = when.match ? '相等' : '不相等';
  // Pointer tokens alone cannot establish whether a numeric segment names an object key or array item.
  const location = when.pointer === '' ? '整体内容' : '指定位置';
  return {
    id: JSON.stringify(['condition', target.id]), kind: 'condition', sourceId: when.nodeId, targetId: target.id,
    shortLabel: outcome ? `${outcome}时运行` : `${comparison}时运行`,
    summary: outcome ? `在${s2ConnectionNodeLabel(definition, document, when.nodeId)}中明确${outcome}时，才运行${s2ConnectionNodeLabel(definition, document, target.id)}。`
      : `根据${s2ConnectionPortLabel(definition, document, when, 'outputs')}的${location}，决定是否运行${s2ConnectionNodeLabel(definition, document, target.id)}。`,
    detail: outcome ? `只在本人这次明确${outcome}时允许运行；这里只描述条件，不表示本人已经作出选择。确认不授予新权限，也不代表业务合格。它控制是否运行，不作为普通输入材料；位置不存在或没有可用结果不视为通过。`
      : `${location}与已设置的比较值${comparison}时允许运行；这里只描述条件，不表示条件已满足。它控制是否运行，不作为普通输入材料；位置不存在或没有可用结果不视为通过。`,
    technical: JSON.stringify({ kind: 'condition', source: typeMetadata(document, when, 'outputs'), targetNodeId: target.id, pointer: when.pointer, comparison: when.match ? 'equals' : 'not-equals' }),
  };
}

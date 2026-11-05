import type { S2Document, S2WorkflowNode } from '../../../src/types/sceneS2';
import type { ScenePackIssue } from '../../../src/types/sceneInteractionPack';
import { GATE_INPUT_PORTS, MAX_GATE_INPUTS, MAX_INPUTS_PER_PORT, isFaultTreeNode, isEventType, isGateType, isContent, type EventType, type GateType } from './domain';

export interface FaultTreeIssue extends ScenePackIssue { nodeId?: string }
export interface FaultTreeRule { eventId: string; gateId: string; operator: GateType; inputEventIds: string[] }
export const literal = (node: S2WorkflowNode, portId: string) => node.bindings[portId]?.kind === 'literal' ? node.bindings[portId].value : undefined;

/** A pure read of the authored graph, never execution or a claim that any event occurred. */
export function readFaultTreeModel(document: S2Document) {
  const nodes = document.execution?.nodes ?? [], links = document.execution?.links ?? [];
  const byId = new Map(nodes.map(node => [node.id, node])), issues: FaultTreeIssue[] = [], rules: FaultTreeRule[] = [];
  const issue = (node: S2WorkflowNode | undefined, field: string, message: string) => issues.push({
    ...(node ? { nodeId: node.id } : {}), path: node ? `/document/execution/nodes/${nodes.indexOf(node)}/${field}` : '/document/execution', message,
  });
  const events = nodes.filter(node => isFaultTreeNode(node) && node.capabilityId === 'event');
  const gates = nodes.filter(node => isFaultTreeNode(node) && node.capabilityId === 'gate');
  const top = events.filter(node => literal(node, 'eventType') === 'top');
  if (top.length !== 1) issue(undefined, '', '完整事故树需要且只能有一个顶事件；草稿可以继续编辑和保存');
  for (const node of nodes) {
    if (!isFaultTreeNode(node) || !['event', 'gate'].includes(node.capabilityId)) { issue(node, 'capabilityId', '此节点不是本包的事件或逻辑门'); continue; }
    const parameters = node.capabilityId === 'event' ? ['eventType', 'content'] : ['gateType'];
    for (const id of parameters) if (node.bindings[id]?.kind !== 'literal' || links.some(link => link.target.nodeId === node.id && link.target.portId === id))
      issue(node, `bindings/${id}`, '业务属性须直接填写，不能用连线或字段引用替代');
    for (const id of node.capabilityId === 'event' ? ['condition'] : GATE_INPUT_PORTS)
      if (node.bindings[id]) issue(node, `bindings/${id}`, '结构端口须由真实画布连线提供，不能填写事件或门的伪造描述');
  }
  for (const node of events) {
    const type = literal(node, 'eventType'), content = literal(node, 'content');
    if (!isEventType(type)) issue(node, 'bindings/eventType', '请选择顶事件、中间事件或基本事件');
    if (!isContent(content)) issue(node, 'bindings/content', '请填写事件内容（最多2000字）');
    const incoming = links.filter(link => link.target.nodeId === node.id && link.target.portId === 'condition');
    const outgoing = links.filter(link => link.source.nodeId === node.id && link.source.portId === 'event');
    if (type === 'basic' && incoming.length) issue(node, 'bindings/condition', '基本事件不接下级逻辑门；请修改类型或断开该连接');
    if (type !== 'basic' && incoming.length !== 1) issue(node, 'bindings/condition', '顶事件和中间事件需要连接一个下级逻辑门');
    if (type === 'top' && outgoing.length) issue(node, 'outputs/event', '顶事件不能作为其他门的下级输入');
    if (type !== 'top' && !outgoing.length) issue(node, 'outputs/event', '此事件尚未连接上级逻辑门');
  }
  for (const node of gates) {
    const operator = literal(node, 'gateType');
    if (!isGateType(operator)) issue(node, 'bindings/gateType', '门类型必须为 AND 或 OR');
    const inputs = GATE_INPUT_PORTS.map(id => links.filter(link => link.target.nodeId === node.id && link.target.portId === id));
    const inputEventIds = inputs.flatMap(items => items.map(link => link.source.nodeId));
    const distinct = new Set(inputEventIds).size === inputEventIds.length;
    if (inputEventIds.length < 2 || inputEventIds.length > MAX_GATE_INPUTS)
      issue(node, 'inputs', '逻辑门需要2至32个不同下级事件，请检查事件数量');
    for (const [index, matches] of inputs.entries()) if (matches.length > MAX_INPUTS_PER_PORT)
      issue(node, `bindings/${GATE_INPUT_PORTS[index]}`, '每个事件接入点最多32个来源，可将其余事件连接另一个接入点');
    if (!distinct) issue(node, 'inputs', '同一事件不能在同一逻辑门重复接入，包括跨接入点重复');
    const outputs = links.filter(link => link.source.nodeId === node.id && link.source.portId === 'condition');
    if (outputs.length !== 1) issue(node, 'outputs/condition', '逻辑门需要且只能连接一个上级事件');
    if (isGateType(operator) && inputEventIds.length >= 2 && inputEventIds.length <= MAX_GATE_INPUTS && distinct
      && inputs.every(items => items.length <= MAX_INPUTS_PER_PORT) && outputs.length === 1) rules.push({
      eventId: outputs[0].target.nodeId, gateId: node.id, operator, inputEventIds,
    });
  }
  for (const [index, link] of links.entries()) {
    const from = byId.get(link.source.nodeId), to = byId.get(link.target.nodeId);
    const valid = from && to && isFaultTreeNode(from) && isFaultTreeNode(to) && (
      from.capabilityId === 'event' && link.source.portId === 'event' && to.capabilityId === 'gate' && GATE_INPUT_PORTS.some(id => id === link.target.portId)
      || from.capabilityId === 'gate' && link.source.portId === 'condition' && to.capabilityId === 'event' && link.target.portId === 'condition');
    if (!valid) issues.push({ nodeId: to?.id ?? from?.id, path: `/document/execution/links/${index}`, message: '事故树只允许事件 → 逻辑门 → 事件的类型化连接' });
  }
  const indegree = new Map(nodes.map(node => [node.id, 0]));
  for (const link of links) if (byId.has(link.source.nodeId) && byId.has(link.target.nodeId)) indegree.set(link.target.nodeId, indegree.get(link.target.nodeId)! + 1);
  const queue = nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id); let visited = 0;
  while (queue.length) { const id = queue.pop()!; visited++; for (const link of links.filter(item => item.source.nodeId === id)) if (indegree.has(link.target.nodeId)) {
    const count = indegree.get(link.target.nodeId)! - 1; indegree.set(link.target.nodeId, count); if (!count) queue.push(link.target.nodeId);
  } }
  if (visited !== nodes.length) issue(undefined, '', '事故树连接不能形成循环');
  return { events: events.map(node => ({ eventId: node.id, eventType: literal(node, 'eventType') as EventType, content: literal(node, 'content') as string })),
    rules, topEventId: top.length === 1 ? top[0].id : undefined, issues };
}

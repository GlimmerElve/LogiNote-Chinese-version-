import type { S2Document, S2WorkflowCondition } from '../../types/sceneS2';
import type { S2Json } from '../../types/sceneS2Plugin';
import type { S2FieldControlState } from './sceneS2Events';
import { canonicalS2Json } from './sceneS2PluginProtocol';
import { s2BuiltinPluginRegistry } from './sceneS2PluginRegistry';
import type { S2ControlDraft } from './sceneS2Controls';
import type { S2SimpleValueDraft, S2SimpleValueIssue } from './sceneS2SimpleValueForm';
import type { S2ControlIssue } from './sceneS2ControlIssue';

export interface S2ParameterDraft { base: string; draft: string; state?: S2FieldControlState; form?: { schema: string; draft: S2ControlDraft }; formIssue?: S2ControlIssue; simple?: S2SimpleValueDraft; simpleIssue?: S2SimpleValueIssue; mode?: 'form' | 'simple' | 'json' }
export type S2ParameterDrafts = Map<string, S2ParameterDraft>;
export type S2DraftInputState = 'editing' | 'invalid' | 'reloaded';
export type S2SubmitVia = 'form' | 'shortcut';
export interface S2HumanDraft { draft: string; state?: S2DraftInputState; form?: { schema: string; draft: S2ControlDraft }; issue?: S2ControlIssue; mode?: 'form' | 'json' }
export type S2HumanDrafts = Map<string, S2HumanDraft>;
export type S2ConditionState = S2FieldControlState | 'cleared';
export interface S2ConditionDraft { base: string; source: string; pointer: string; expected: string; match: boolean; state?: S2ConditionState; expectedKind?: 'string' | 'number' | 'boolean' | 'null' | 'json' }
export type S2ConditionDrafts = Map<string, S2ConditionDraft>;
export function s2ConditionDraft(when: S2WorkflowCondition | undefined, base: string): S2ConditionDraft {
  const formatted = when ? JSON.stringify(when.equals, null, 2) : 'true';
  // Formatting must not make an otherwise valid native condition impossible to edit.
  // Keep the full value compact when needed; the workflow still checks its 6000-byte limit.
  const expected = formatted.length > 6000 && when ? JSON.stringify(when.equals) : formatted;
  return { base, source: when ? JSON.stringify([when.nodeId, when.portId]) : '', pointer: when?.pointer ?? '',
    expected, match: when?.match ?? true };
}
/** Exact declared control sources, not their runtime data. Layout or new output values do not change a condition's source identity. */
export function s2ConditionSource(document: S2Document, nodeId: string) {
  const node = document.execution?.nodes.find(node => node.id === nodeId), registry = s2BuiltinPluginRegistry();
  if (!node) throw new Error('条件不属于当前执行节点');
  const catalog = document.execution!.nodes.filter(item => item.id !== nodeId).flatMap(item => registry.capability(item).outputs
    .filter(port => port.required && !port.multiple && ['core.assessment', 'structured-data.value', 'workflow-simulation.result', 'human-input.decision'].includes(port.type.id))
    .map(port => ({ nodeId: item.id, pluginId: item.pluginId, pluginVersion: item.pluginVersion, capabilityId: item.capabilityId, portId: port.id, type: { ...port.type } })))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { key: canonicalS2Json({ pluginId: node.pluginId, pluginVersion: node.pluginVersion, capabilityId: node.capabilityId, when: node.when ? { ...node.when } : null, catalog }),
    sources: catalog.map(item => ({ nodeId: item.nodeId, portId: item.portId, typeId: item.type.id })) };
}
/** Private local source identity includes omitted-vs-null, field references and incoming wires.
 * It is never serialized into the Agent's event journal (it can contain parameter text). */
export function s2ParameterSource(document: S2Document, nodeId: string, portId: string) {
  const node = document.execution?.nodes.find(node => node.id === nodeId);
  const port = node && s2BuiltinPluginRegistry().capability(node).inputs.find(port => port.id === portId);
  if (!node || !port) throw new Error('参数端口不属于当前执行节点');
  const links = document.execution!.links.filter(link => link.target.nodeId === nodeId && link.target.portId === portId)
    .map(link => [link.source.nodeId, link.source.portId]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { key: canonicalS2Json({ pluginId: node.pluginId, pluginVersion: node.pluginVersion, capabilityId: node.capabilityId,
    portId, binding: node.bindings[portId] ?? null, links, inputForm: (node.presentation?.inputForms?.[portId] ?? null) as unknown as S2Json }), connected: links.length > 0 };
}
export const s2HumanDraftKey = (wait: { workflowId: string; id: string; revision: number }) => JSON.stringify([wait.workflowId, wait.id, wait.revision]);

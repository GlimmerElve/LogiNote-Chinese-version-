import type { S2CanvasDefinition, S2Document, S2WorkflowCommand } from '../../types/sceneS2';
import { s2BuiltinPluginRegistry } from './sceneS2PluginRegistry';
import { canonicalS2Json } from './sceneS2PluginProtocol';
import { s2ParameterSource } from './sceneS2ControlDrafts';
import { s2NodeTitle, s2PortLabel } from './sceneS2Presentation';

type Source = { kind: 'output'; nodeId: string; portId: string } | { kind: 'field'; nodeId: string; fieldId: string } | { kind: 'manual' | 'fixed' };
/** Display only. Exact type/version checks remain with the registry and graph validator. */
export function s2MaterialTypeLabel(type: { id: string; version: number }): string {
  const labels: Record<string, string> = { 'core.text': '文字', 'structured-data.value': '结构化数据', 'structured-data.table': '表格',
    'core.assessment': '检查结果', 'human-input.decision': '用户选择', 'workflow-simulation.result': '模拟轨迹' };
  return `${labels[type.id] ?? '专用材料'}${type.version === 1 ? '' : `（格式版本 ${type.version}）`}`;
}
export function s2MaterialInput(definition: S2CanvasDefinition, document: S2Document, nodeId: string, portId: string) {
  const registry = s2BuiltinPluginRegistry(), node = document.execution?.nodes.find(item => item.id === nodeId);
  const port = node && registry.capability(node).inputs.find(item => item.id === portId);
  if (!node || !port) throw new Error('材料输入已不存在，请重新选择步骤');
  const options: Array<{ id: string; label: string; source: Source }> = [];
  const unavailable: Array<{ label: string; reason: string }> = [];
  const text = port.type.id === 'core.text' && port.type.version === 1;
  const editableText = text && !port.multiple;
  const binding = node.bindings[portId];
  if (editableText) options.push({ id: 'manual', label: '直接填写文字', source: { kind: 'manual' } });
  else if (binding?.kind === 'literal') options.push({ id: 'fixed', label: node.presentation?.inputForms?.[portId] ? '已填写的表单材料' : port.type.id === 'structured-data.value' && port.type.version === 1 && !port.multiple ? '已填写的固定材料（在下方修改）' : '已填写的固定材料（在高级设置中修改）', source: { kind: 'fixed' } });
  if (text) document.nodes.forEach((item, index) => definition.blockTypes.find(type => type.id === item.type)!.fields.forEach(field => {
    options.push({ id: JSON.stringify(['field', item.id, field.id]), label: `${definition.blockTypes.find(type => type.id === item.type)!.label} · ${field.label}（内容 ${index + 1}）`, source: { kind: 'field', nodeId: item.id, fieldId: field.id } });
  }));
  document.execution!.nodes.forEach((item, index) => {
    if (item.id === nodeId) return;
    for (const output of registry.capability(item).outputs) {
      const label = `${s2NodeTitle(item)} · ${s2PortLabel(item, output, 'outputs')}（步骤 ${index + 1}）`;
      if (registry.compatible(output.type, port.type) && (!output.multiple || port.multiple) && (!port.required || output.required)) {
        options.push({ id: JSON.stringify(['output', item.id, output.id]), label, source: { kind: 'output', nodeId: item.id, portId: output.id } });
      } else unavailable.push({ label, reason: !registry.compatible(output.type, port.type)
        ? `这里需要${s2MaterialTypeLabel(port.type)}，该结果提供${s2MaterialTypeLabel(output.type)}，不能直接连接。`
        : output.multiple && !port.multiple ? '这里只能接收一份结果，该输出可能提供多份，不能直接连接。'
        : '这里必须有材料，但该输出可能不提供结果，不能直接连接。请明确选择本场景允许的补值或分支处理方式。' });
    }
  });
  const selected = document.execution!.links.filter(link => link.target.nodeId === nodeId && link.target.portId === portId)
    .map(link => JSON.stringify(['output', link.source.nodeId, link.source.portId]));
  if (binding) selected.push(binding.kind === 'field' ? JSON.stringify(['field', binding.nodeId, binding.fieldId]) : editableText ? 'manual' : 'fixed');
  // Exact current binding/wires + actual candidate identities; labels and layout are not authority.
  const base = canonicalS2Json({ source: s2ParameterSource(document, nodeId, portId).key, candidates: options.map(option => {
    const source = option.source;
    const producer = source.kind === 'output' ? document.execution!.nodes.find(node => node.id === source.nodeId) : undefined;
    return { id: option.id, ...(producer ? { pluginId: producer.pluginId, pluginVersion: producer.pluginVersion, capabilityId: producer.capabilityId } : {}) };
  }) });
  return { node, port, options, unavailable, selected, base, manual: selected.includes('manual') };
}

/** Produces edits only. The existing document validator still checks every type, cycle and permission. */
export function planS2MaterialInput(definition: S2CanvasDefinition, document: S2Document, nodeId: string, portId: string, raw: unknown, base: string): S2WorkflowCommand[] {
  const input = s2MaterialInput(definition, document, nodeId, portId);
  if (base !== input.base) throw new Error('材料来源已变化，请重新选择；未覆盖当前连接');
  if (!Array.isArray(raw) || raw.length > (input.port.multiple ? 32 : 1)) throw new Error('材料数量不符合本步骤要求');
  const ids: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = Object.getOwnPropertyDescriptor(raw, i);
    if (!item || !('value' in item) || typeof item.value !== 'string' || ids.includes(item.value) || !input.options.some(option => option.id === item.value)) throw new Error('材料来源无效、重复或不属于当前可选范围');
    ids.push(item.value);
  }
  const sources = ids.map(id => input.options.find(option => option.id === id)!.source);
  if (sources.filter(source => source.kind !== 'output').length > 1) throw new Error('同一输入只能直接填写一份材料或引用一个内容字段；其他材料请通过处理步骤连接');
  if (JSON.stringify([...ids].sort()) === JSON.stringify([...input.selected].sort())) return [];
  // A source picker changes only the selected difference. Rebuilding every wire would turn
  // one checkbox edit on a valid 7+ source input into more than the 12-command atomic limit.
  // Remove changed sources first; retained wires and literal/field bindings are untouched.
  const selected = new Set(ids), existing = new Set(input.selected);
  const commands: S2WorkflowCommand[] = document.execution!.links.filter(link => link.target.nodeId === nodeId && link.target.portId === portId)
    .filter(link => !selected.has(JSON.stringify(['output', link.source.nodeId, link.source.portId])))
    .map(link => ({ op: 'disconnect-ports', link }));
  const binding = input.node.bindings[portId];
  const bindingId = binding?.kind === 'field' ? JSON.stringify(['field', binding.nodeId, binding.fieldId]) : input.manual ? 'manual' : 'fixed';
  if (binding && !selected.has(bindingId)) commands.push({ op: 'unbind-input', id: nodeId, portId });
  for (let index = 0; index < sources.length; index++) {
    if (existing.has(ids[index])) continue;
    const source = sources[index];
    if (source.kind === 'output') commands.push({ op: 'connect-ports', link: { source: { nodeId: source.nodeId, portId: source.portId }, target: { nodeId, portId } } });
    else commands.push({ op: 'update-execution-node', id: nodeId, bindings: { [portId]: source.kind === 'field' ? { kind: 'field', nodeId: source.nodeId, fieldId: source.fieldId }
      : input.node.bindings[portId]?.kind === 'literal' ? input.node.bindings[portId] : { kind: 'literal', value: '' } } });
  }
  return commands;
}

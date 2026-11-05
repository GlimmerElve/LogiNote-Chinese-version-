import type { S2CanvasDefinition, S2Document, S2InputBinding } from '../../types/sceneS2';
import type { S2ExecutionLink } from '../../types/sceneS2Plugin';
import { readS2Document, snapshotS2CompositeData } from './uiHost';
import { composeS2Text } from './textTemplate';

export interface S2ComposeRow { source: string; prefix: string }
export interface S2ComposeStructureConfig { prefixes: string[]; separator: string }
export interface S2ComposeSlot { portId: string; title: string; prefix: string; connected: boolean; sourceLabel: string }

/** Fixed semantic slots. This projection contains source names, never source bodies. */
export function s2ComposeStructure(definition: S2CanvasDefinition, document: S2Document, nodeId: string) {
  const node = document.execution?.nodes.find(item => item.id === nodeId);
  if (!node || node.pluginId !== 'text-template' || node.pluginVersion !== '1.0.0' || node.capabilityId !== 'compose') throw new Error('不是当前组装步骤');
  const incoming = (document.execution?.links ?? []).filter(link => link.target.nodeId === nodeId);
  const configuredPrefixes = node.bindings.prefixes, configuredSeparator = node.bindings.separator;
  const simple = !incoming.some(link => ['prefixes', 'separator'].includes(link.target.portId))
    && (!configuredPrefixes || configuredPrefixes.kind === 'literal' && Array.isArray(configuredPrefixes.value)
      && configuredPrefixes.value.length <= 8 && configuredPrefixes.value.every(value => typeof value === 'string' && value.length <= 120))
    && (!configuredSeparator || configuredSeparator.kind === 'literal' && typeof configuredSeparator.value === 'string' && configuredSeparator.value.length <= 120);
  const configured = configuredPrefixes?.kind === 'literal' && Array.isArray(configuredPrefixes.value) ? configuredPrefixes.value : [];
  const separator = configuredSeparator?.kind === 'literal' && typeof configuredSeparator.value === 'string' ? configuredSeparator.value : '\n';
  const configuredParts = [...Object.keys(node.bindings), ...incoming.map(link => link.target.portId)]
    .filter(id => /^part[1-8]$/.test(id)).map(id => Number(id.slice(4)));
  const count = Math.max(3, Math.min(8, configured.length), ...configuredParts);
  const defaults = ['角色', '任务', '输出要求'];
  const slots: S2ComposeSlot[] = Array.from({ length: count }, (_, index) => {
    const portId = `part${index + 1}`, binding = node.bindings[portId], links = incoming.filter(link => link.target.portId === portId);
    const prefix = typeof configured[index] === 'string' ? configured[index] as string : '';
    let sourceLabel = '未连接';
    if (binding?.kind === 'field') {
      const source = document.nodes.find(item => item.id === binding.nodeId), type = definition.blockTypes.find(item => item.id === source?.type);
      sourceLabel = source?.label?.trim() || type?.label || '内容块';
    } else if (binding?.kind === 'literal') sourceLabel = '已填写文字';
    else if (links.length) {
      const source = document.execution?.nodes.find(item => item.id === links[0].source.nodeId);
      sourceLabel = source?.presentation?.label?.trim() || '已连接步骤';
    }
    return { portId, title: prefix || defaults[index] || `内容 ${index + 1}`, prefix, connected: !!binding || links.length > 0, sourceLabel };
  });
  return { base: JSON.stringify({ node, incoming }), simple, slots, prefixes: slots.map(slot => slot.prefix), separator };
}

/** Change structure labels only. Existing inputs, their positions and every link remain intact. */
export function applyS2ComposeStructure(definition: S2CanvasDefinition, document: S2Document, nodeId: string,
  raw: S2ComposeStructureConfig, base: string): S2Document {
  const state = s2ComposeStructure(definition, document, nodeId);
  if (state.base !== base || !state.simple) throw new Error('组装结构已变化或由其他步骤提供，草稿已保留');
  const config = snapshotS2CompositeData(raw, { maxBytes: 8192, maxEntries: 32 });
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !['prefixes', 'separator'].includes(key))
    || !Array.isArray(config.prefixes) || config.prefixes.length > 8 || config.prefixes.some(value => typeof value !== 'string' || value.length > 120)
    || typeof config.separator !== 'string' || config.separator.length > 120) throw new Error('结构最多8个标题，每个标题和分隔文字最多120字');
  const lastConnected = state.slots.reduce((last, slot, index) => slot.connected ? index + 1 : last, 0);
  const prefixes = Array.from({ length: Math.max(3, config.prefixes.length, lastConnected) }, (_, index) => config.prefixes[index] ?? '');
  if (JSON.stringify(prefixes) === JSON.stringify(state.prefixes) && config.separator === state.separator) return document;
  const next = structuredClone(document), node = next.execution!.nodes.find(item => item.id === nodeId)!;
  node.bindings.prefixes = { kind: 'literal', value: config.prefixes };
  node.bindings.separator = { kind: 'literal', value: config.separator };
  return readS2Document(next, definition);
}
/** UI choices are display names only; bindings always retain actual field IDs. */
export function s2ComposeControls(definition: S2CanvasDefinition, document: S2Document, nodeId: string) {
  const node = document.execution?.nodes.find(item => item.id === nodeId);
  if (!node || node.pluginId !== 'text-template' || node.capabilityId !== 'compose') throw new Error('不是当前组装步骤');
  const incoming = (document.execution?.links ?? []).filter(link => link.target.nodeId === nodeId);
  const part = (value: string) => /^part[1-8]$/.test(value);
  const base = JSON.stringify({ node, incoming, fields: document.nodes.map(item => [item.id, item.type, Object.keys(item.values)]) });
  const configuredPrefixes = node.bindings.prefixes, configuredSeparator = node.bindings.separator;
  const simple = !incoming.some(link => ['prefixes', 'separator'].includes(link.target.portId))
    && (!configuredPrefixes || configuredPrefixes.kind === 'literal' && Array.isArray(configuredPrefixes.value)
      && configuredPrefixes.value.length <= 8 && configuredPrefixes.value.every(value => typeof value === 'string' && value.length <= 120))
    && (!configuredSeparator || configuredSeparator.kind === 'literal' && typeof configuredSeparator.value === 'string' && configuredSeparator.value.length <= 120);
  const prefixes = configuredPrefixes?.kind === 'literal' && Array.isArray(configuredPrefixes.value) ? configuredPrefixes.value : [];
  const separator = configuredSeparator?.kind === 'literal' && typeof configuredSeparator.value === 'string' ? configuredSeparator.value : '\n';
  const choices: Array<{ id: string; label: string; binding?: S2InputBinding; text: string; links: S2ExecutionLink[] }> = document.nodes.flatMap((block, index) => definition.blockTypes.find(type => type.id === block.type)!.fields.map(field => ({
    id: JSON.stringify(['field', block.id, field.id]), label: `${block.label?.trim() || `内容 ${index + 1}`} · ${field.label}`,
    binding: { kind: 'field' as const, nodeId: block.id, fieldId: field.id }, text: block.values[field.id], links: [] as typeof incoming,
  })));
  for (let index = 1; index <= 8; index++) {
    const portId = `part${index}`, binding = node.bindings[portId], links = incoming.filter(link => link.target.portId === portId);
    if (binding?.kind === 'literal' || links.length) choices.push({ id: `existing:${portId}`, label: links.length ? `已连接的材料（第 ${index} 段）` : `已填写的文字（第 ${index} 段）`,
      binding, text: binding?.kind === 'literal' && typeof binding.value === 'string' ? binding.value : '', links });
  }
  const rows: S2ComposeRow[] = [];
  for (let index = 1; index <= 8; index++) {
    const portId = `part${index}`, binding = node.bindings[portId];
    if (!binding && !incoming.some(link => link.target.portId === portId)) continue;
    rows.push({ source: binding?.kind === 'field' ? JSON.stringify(['field', binding.nodeId, binding.fieldId]) : `existing:${portId}`,
      prefix: typeof prefixes[index - 1] === 'string' ? prefixes[index - 1] as string : '' });
  }
  return { base, simple, choices, rows, separator, parts: Object.keys(node.bindings).filter(part) };
}

/** One validated local edit. No execution, prompt rewriting, new plugin or network authority. */
export function applyS2ComposeControls(definition: S2CanvasDefinition, document: S2Document, nodeId: string,
  rows: S2ComposeRow[], separator: string, base: string): S2Document {
  const state = s2ComposeControls(definition, document, nodeId);
  if (state.base !== base || !state.simple) throw new Error('组装来源已变化或使用高级设置，请重新载入后编辑');
  if (!Array.isArray(rows) || !rows.length || rows.length > 8 || typeof separator !== 'string' || separator.length > 120) throw new Error('请选择1至8段内容，分隔文字最多120字');
  const selected = rows.map(row => {
    if (!row || typeof row.source !== 'string' || typeof row.prefix !== 'string' || row.prefix.length > 120) throw new Error('段落来源或前缀无效');
    const choice = state.choices.find(item => item.id === row.source); if (!choice) throw new Error('所选内容已不存在，请重新选择');
    return { ...choice, prefix: row.prefix };
  });
  // If every source is locally available, check the full literal output without
  // changing it. Linked data remains the scheduler's responsibility at runtime.
  if (selected.every(item => !item.links.length)) composeS2Text(selected.map(item => item.text), selected.map(item => item.prefix), separator);
  const next = structuredClone(document), node = next.execution!.nodes.find(item => item.id === nodeId)!;
  for (let index = 1; index <= 8; index++) delete node.bindings[`part${index}`];
  next.execution!.links = next.execution!.links.filter(link => link.target.nodeId !== nodeId || !/^part[1-8]$/.test(link.target.portId));
  selected.forEach((item, index) => {
    const portId = `part${index + 1}`;
    if (item.binding) node.bindings[portId] = structuredClone(item.binding) as S2InputBinding;
    next.execution!.links.push(...item.links.map(link => ({ ...structuredClone(link), target: { nodeId, portId } })));
  });
  node.bindings.prefixes = { kind: 'literal', value: selected.map(item => item.prefix) };
  node.bindings.separator = { kind: 'literal', value: separator };
  return readS2Document(next, definition);
}

import type { S2CanvasDefinition, S2Document } from '../../types/sceneS2';
import type { S2Artifact, S2Json } from '../../types/sceneS2Plugin';
import { readS2Definition, readS2Document } from './sceneS2Canvas';
import { snapshotS2CompositeData } from './sceneS2Composite';
import { canonicalS2Json, readS2Artifact } from './sceneS2PluginProtocol';
import { s2BuiltinPluginRegistry } from './sceneS2PluginRegistry';
import { s2NodeTitle, s2PortLabel } from './sceneS2Presentation';

export interface S2FieldChoicesReport {
  sourceLabel: string;
  options: Array<{ pointer: string; label: string; type: string }>;
  current: string | null;
  canApply: boolean;
}
type OutputReader = (nodeId: string, portId: string) => S2Artifact;
const registry = s2BuiltinPluginRegistry();
const reports = new WeakMap<S2FieldChoicesReport, { nodeId: string; base: string; source: string; report: string }>();
const canonical = (value: unknown) => canonicalS2Json(value as S2Json);
function context(definitionRaw: S2CanvasDefinition, documentRaw: S2Document, nodeId: string, readOutput?: OutputReader) {
  const snap = (raw: unknown) => snapshotS2CompositeData(raw, { maxBytes: 786432, maxEntries: 48000 });
  const definition = readS2Definition(snap(definitionRaw)), document = readS2Document(snap(documentRaw), definition);
  const node = document.execution?.nodes.find(item => item.id === nodeId);
  if (!node || node.pluginId !== 'structured-data' || node.pluginVersion !== '1.0.0' || node.capabilityId !== 'select') throw new Error('此步骤不支持按字段选择。');
  const links = document.execution!.links.filter(link => link.target.nodeId === nodeId && link.target.portId === 'value'), binding = node.bindings.value;
  let value: S2Json, source: string, sourceLabel: string;
  if (!links.length && binding?.kind === 'literal') {
    value = binding.value; source = canonical(binding); sourceLabel = '本步骤已填写的固定材料';
  } else if (links.length === 1 && !binding) {
    const producer = document.execution!.nodes.find(item => item.id === links[0].source.nodeId)!;
    const port = registry.capability(producer).outputs.find(port => port.id === links[0].source.portId);
    if (!port || port.multiple || !port.required || port.type.id !== 'structured-data.value' || port.type.version !== 1) throw new Error('需要唯一、完整的结构化数据来源；保留原材料，不猜测字段。');
    if (!readOutput) throw new Error('请先开始试验并单独运行上游步骤，再查看已有结果的字段；此操作不会替你运行。');
    const artifact = readS2Artifact(registry, snapshotS2CompositeData(readOutput(producer.id, port.id)));
    if (artifact.type.id !== port.type.id || artifact.type.version !== port.type.version || artifact.source.nodeId !== producer.id || artifact.payload.kind !== 'inline') throw new Error('上游没有完整、类型匹配的当前结果，不能使用预览或历史结果猜字段。');
    value = artifact.payload.value; source = canonical(artifact);
    sourceLabel = `${s2NodeTitle(producer)} · ${s2PortLabel(producer, port, 'outputs')}（步骤 ${document.execution!.nodes.indexOf(producer) + 1}的当前结果）`;
  } else throw new Error('请先为“待提取的数据”选择固定材料或一个上游来源；未知结构不能猜字段，也不会自动解析或运行。');
  const pointerBinding = node.bindings.pointer;
  return { definition, document, node, value, source, sourceLabel, base: canonical({ definition, document }),
    canApply: !document.execution!.links.some(link => link.target.nodeId === nodeId && link.target.portId === 'pointer')
      && (!pointerBinding || pointerBinding.kind === 'literal' && typeof pointerBinding.value === 'string') };
}
/** Explicit local inspection only. Labels contain field names/types, never scalar values or external reads. */
export function listS2ValueFields(raw: S2Json): S2FieldChoicesReport['options'] {
  const value = snapshotS2CompositeData(raw) as S2Json, options: S2FieldChoicesReport['options'] = [];
  function visit(value: S2Json, pointer: string, label: string) {
    if (options.length >= 256 || label.length > 1024) throw new Error('字段列表过大，不能截断后冒充完整列表；请使用高级提取位置编辑。');
    const type = value === null ? '空值' : Array.isArray(value) ? '列表' : ({ object: '对象', string: '文字', number: '数字', boolean: '布尔值' } as Record<string, string>)[typeof value];
    options.push({ pointer, label, type });
    if (value && typeof value === 'object') Object.entries(value).forEach(([key, child]) => {
      visit(child, pointer + '/' + key.replace(/~/g, '~0').replace(/\//g, '~1'), `${label} › ${Array.isArray(value) ? `第${Number(key) + 1}项` : `字段「${key === '' ? '（空名称）' : key}」`}`);
    });
  }
  visit(value, '', '整体数据');
  try { snapshotS2CompositeData(options); }
  catch { throw new Error('完整字段列表过大（最多128000字节），未截断或应用；请使用高级编辑。'); }
  return options;
}
export function prepareS2FieldChoices(definition: S2CanvasDefinition, document: S2Document, nodeId: string, readOutput?: OutputReader): S2FieldChoicesReport {
  const now = context(definition, document, nodeId, readOutput), options = listS2ValueFields(now.value);
  const old = now.node.bindings.pointer;
  const report: S2FieldChoicesReport = { sourceLabel: now.sourceLabel, options, canApply: now.canApply,
    current: old?.kind === 'literal' && typeof old.value === 'string' && options.some(option => option.pointer === old.value) ? old.value : null };
  // Do not issue a menu that the subsequent brand/freshness check cannot read in full.
  try { snapshotS2CompositeData(report); }
  catch { throw new Error('完整字段列表过大（最多128000字节），未截断或应用；请使用高级提取位置编辑。'); }
  reports.set(report, { nodeId, base: now.base, source: now.source, report: canonical(report) });
  return report;
}
function checked(report: S2FieldChoicesReport, definition: S2CanvasDefinition, document: S2Document, readOutput?: OutputReader) {
  const saved = reports.get(report);
  if (!saved || canonical(snapshotS2CompositeData(report)) !== saved.report) throw new Error('字段列表不是当前宿主生成的原列表，请重新查看。');
  const now = context(definition, document, saved.nodeId, readOutput);
  if (now.base !== saved.base || now.source !== saved.source) throw new Error('材料、画布或上游结果已变化；旧选择未应用，请重新查看字段。');
  return now;
}
export function readS2FieldChoices(report: S2FieldChoicesReport, definition: S2CanvasDefinition, document: S2Document, readOutput?: OutputReader): S2FieldChoicesReport {
  checked(report, definition, document, readOutput); return structuredClone(report);
}
export function applyS2FieldChoice(report: S2FieldChoicesReport, definition: S2CanvasDefinition, document: S2Document, pointer: string, readOutput?: OutputReader): S2Document {
  const now = checked(report, definition, document, readOutput);
  if (!now.canApply) throw new Error('提取位置来自内容块或上游步骤，保留原引用；请在原来源或高级设置修改。');
  if (typeof pointer !== 'string' || !report.options.some(option => option.pointer === pointer)) throw new Error('请选择当前字段列表中的一项，不能猜测提取位置。');
  now.node.bindings.pointer = { kind: 'literal', value: pointer };
  return readS2Document(now.document, now.definition);
}

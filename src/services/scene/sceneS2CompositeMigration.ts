import type { S2CanvasDefinition, S2Document, S2InputBinding } from '../../types/sceneS2';
import type { S2CompositeBlueprint, S2CompositeEndpoint } from '../../types/sceneS2Composite';
import type { S2Json } from '../../types/sceneS2Plugin';
import { readS2Definition, readS2Document } from './sceneS2Canvas';
import { snapshotS2CompositeData } from './sceneS2Composite';
import { compareS2CompositeDesigns } from './sceneS2CompositeComparison';
import { inspectS2CompositeInstance } from './sceneS2CompositeInstance';
import { canonicalS2Json } from './sceneS2PluginProtocol';
import { s2NodeTitle, s2PortLabel } from './sceneS2Presentation';
import { instantiateS2CompositeDesign } from './sceneS2CompositeLibrary';
import { s2BuiltinPluginRegistry } from './sceneS2PluginRegistry';
import { s2ConnectionNodeLabel, s2ConnectionPortLabel } from './sceneS2Connections';
import { s2ExecutionLinkKey } from './sceneS2Workflow';

type State = 'candidate' | 'choose' | 'conflict' | 'reselect' | 'missing' | 'new' | 'removed';
type Kind = 'input' | 'parameter';
type Source = { kind: 'literal'; value: S2Json } | { kind: 'field'; nodeId: string; fieldId: string }
  | { kind: 'links'; endpoints: S2CompositeEndpoint[] } | { kind: 'unset' } | { kind: 'missing' };
type Detail = { current: { kind: 'literal'; value: S2Json } | { kind: 'reference' | 'unset' | 'missing'; description: string };
  targetDefault: { present: boolean; value?: S2Json } };
export type S2CompositeCopyChoice = 'current' | 'target-default' | 'empty';
type Item = { key: string; id: string; kind: Kind; kindLabel: string; label: string; state: State; stateLabel: string; reasons: string[]; currentDescription: string; detailAvailable: boolean; copyChoices: S2CompositeCopyChoice[] };
const stateLabel: Record<State, string> = { candidate: '可进入沿用确认', choose: '需要选择', conflict: '存在冲突', reselect: '必须重新选择资料', missing: '尚未设置', new: '目标新增', removed: '目标已移除' };
const canonical = (value: unknown) => canonicalS2Json(value as S2Json);
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const keyOf = (endpoint: S2CompositeEndpoint) => JSON.stringify([endpoint.nodeId, endpoint.portId]);
const snapshot = (raw: unknown) => snapshotS2CompositeData(raw, { maxBytes: 786432, maxEntries: 48000 });
const note = '这是对当前库版本和当前实例的只读沿用预览，不认证历史来源、不替换实例、不迁移权限或模型预算，也不运行。可沿用项仍须逐项确认；源版本、目标、画布或场景配置变化后必须重新预览。';
// Exact native snapshots stay host-local. No hashes, guessed IDs, serialized plan or forged copy can authorize a later read.
// This is only preview freshness, NOT an upgrade capability or historical source certificate.
const previews = new WeakMap<object, { document: string; definition: string; report: string; details: Map<string, Detail>; sources: Map<string, Source> }>();
function current(documentRaw: unknown, definitionRaw: unknown) {
  const definition = readS2Definition(snapshot(definitionRaw));
  const document = readS2Document(snapshot(documentRaw), definition);
  return { document, definition, documentKey: canonical(document), definitionKey: canonical(definition) };
}
const resource = (blueprint: S2CompositeBlueprint, endpoints: S2CompositeEndpoint[]) => endpoints.some(endpoint => {
  const node = blueprint.workflow.nodes.find(node => node.id === endpoint.nodeId)!;
  return ['local-material', 'project-notes'].includes(node.pluginId) && endpoint.portId === 'resource';
});

/** Read-only host-local preview, not a migration command. Actual values are retained separately and disclosed only on explicit detail read. */
export function previewS2CompositeMigration(documentRaw: unknown, definitionRaw: S2CanvasDefinition, compositeId: string, targetVersion: string) {
  const { document, definition, documentKey, definitionKey } = current(documentRaw, definitionRaw);
  const unavailable = (reason: string) => ({ status: 'unavailable' as const, applied: false as const, migrationSupported: false as const, reason, note });
  const inspection = inspectS2CompositeInstance(document, definition, compositeId);
  if (inspection.status !== 'compared') return unavailable(inspection.reason);
  const instance = document.composites!.find(item => item.id === compositeId)!;
  const from = document.blueprints!.find(item => item.blueprint.id === inspection.source.id && item.blueprint.version === inspection.source.version)!;
  const to = document.blueprints!.find(item => item.blueprint.id === inspection.source.id && item.blueprint.version === targetVersion);
  if (!to || to.blueprint.version === from.blueprint.version) return unavailable('请选择库中同一系列的另一个精确版本；不按名称匹配或自动选择最新版。');
  const comparison = compareS2CompositeDesigns(from, to, definition.plugins ?? []);
  const map = new Map(instance.blueprint!.mapping!.nodes.map(entry => [entry.localId, entry.id]));
  const members = new Set(instance.nodeIds), graph = document.execution!;
  const details = new Map<string, Detail>(), sourcesForCopy = new Map<string, Source>(), items: Item[] = [];
  const endpoints = (port: S2CompositeBlueprint['inputs'][number] | S2CompositeBlueprint['parameters'][number]): S2CompositeEndpoint[] => 'targets' in port ? port.targets : [port.target];
  const actual = (endpoint: S2CompositeEndpoint): Source => {
    const id = map.get(endpoint.nodeId), node = graph.nodes.find(node => node.id === id);
    if (!node || !members.has(node.id)) return { kind: 'missing' };
    const incoming = graph.links.filter(link => keyOf(link.target) === keyOf({ nodeId: node.id, portId: endpoint.portId })).map(link => link.source);
    if (incoming.length) return { kind: 'links', endpoints: incoming.sort((a, b) => keyOf(a).localeCompare(keyOf(b))) };
    const binding: S2InputBinding | undefined = node.bindings[endpoint.portId];
    return binding ? structuredClone(binding) : { kind: 'unset' };
  };
  const describe = (source: Source): string => {
    if (source.kind === 'literal') return '当前已填写值（默认不显示内容）';
    if (source.kind === 'field') {
      const block = document.nodes.find(node => node.id === source.nodeId)!, type = definition.blockTypes.find(type => type.id === block.type)!;
      return `使用「${type.label}」的「${type.fields.find(field => field.id === source.fieldId)!.label}」；仅保留引用，不复制正文`;
    }
    if (source.kind === 'links') return `连接${source.endpoints.length}项步骤输出：${source.endpoints.map(endpoint => s2NodeTitle(graph.nodes.find(node => node.id === endpoint.nodeId)!)).join('、')}；不读取产物或执行`;
    return source.kind === 'missing' ? '对应步骤已删除或移出' : '当前未设置';
  };
  for (const kind of ['input', 'parameter'] as const) {
    const old = kind === 'input' ? from.blueprint.inputs : from.blueprint.parameters;
    const next = kind === 'input' ? to.blueprint.inputs : to.blueprint.parameters;
    for (const id of new Set([...old, ...next].map(port => port.id))) {
      const before = old.find(port => port.id === id), after = next.find(port => port.id === id), key = JSON.stringify([kind, id]);
      const item: Item = { key, id, kind, kindLabel: kind === 'input' ? '材料' : '可调项', label: after?.label ?? before!.label,
        state: 'candidate', stateLabel: '', reasons: [], currentDescription: '原版没有此项', detailAvailable: false, copyChoices: after ? ['empty'] : [] };
      const resourcePort = before && resource(from.blueprint, endpoints(before)) || after && resource(to.blueprint, endpoints(after));
      // Do not extract resource handles, even for removed/mismatched interfaces or detail requests.
      if (resourcePort) {
        item.state = after ? 'reselect' : 'removed'; item.currentDescription = '本局资料入口（不读取、展示或沿用旧句柄）';
        item.reasons.push(after ? '必须重新选择资料并核对本局授权，预览不授予权限。' : '目标已移除此资料入口，保留现有实例，不迁移旧资料。');
      } else {
        const sources = before ? endpoints(before).map(actual) : [], uniform = sources.every(source => equal(source, sources[0]));
        const source: Source = sources[0] ?? { kind: 'unset' };
        item.currentDescription = before ? uniform ? describe(source) : '同一个公共入口的内部目标使用了不同来源' : '原版没有此项';
        const hasDefault = !!after && Object.hasOwn(after, 'defaultValue');
        const change = comparison.changes.find(change => change.kind === kind && change.id === id);
        if (!after) { item.state = 'removed'; item.reasons.push('目标没有此项，不自动丢弃当前填写或接线。'); }
        else if (!before) { item.state = hasDefault ? 'new' : 'missing'; item.reasons.push(hasDefault ? '目标新增可调项并提供默认值，需确认是否采用。' : '目标新增入口，需按目标要求设置，不能从同名旧项猜取。'); }
        else if (!uniform) { item.state = 'conflict'; item.reasons.push('分散的内部来源不能压成一个公共值，需保留并人工核对。'); }
        else if (source.kind === 'missing' || source.kind === 'links' && source.endpoints.some(endpoint => members.has(endpoint.nodeId))) {
          item.state = 'conflict'; item.reasons.push(source.kind === 'missing' ? '对应步骤不在实例中，不能提取沿用内容。' : '该入口已改为内部处理链路，不能替换为普通公共绑定。');
        } else if (change?.breaking || change?.review && change.changes.some(reason => !reason.startsWith('默认值改变'))) {
          item.state = 'conflict'; item.reasons.push(...change.changes);
        } else if (change?.review) { item.state = 'choose'; item.reasons.push('新旧默认设置不同，需要选择当前实际值、新默认值或重新填写。'); }
        else if (source.kind === 'unset') { item.state = hasDefault ? 'choose' : 'missing'; item.reasons.push(hasDefault ? '当前为空，目标有默认设置，需要确认是否采用。' : '当前未设置；需按必填要求补充，选填项可留空。'); }
        else { item.reasons.push('精确公共标识、类型、接收方式及内部端点一致；当前来源可进入后续确认，不代表已迁移。'); }
        if (after && hasDefault) item.copyChoices.unshift('target-default');
        if (after && ['candidate', 'choose'].includes(item.state) && uniform && !['unset', 'missing'].includes(source.kind)) {
          item.copyChoices.unshift('current'); sourcesForCopy.set(key, structuredClone(source));
        }
        // Material fanout disagreements and deleted members must not disclose a misleading single value.
        if (uniform && source.kind !== 'missing') {
          const detail: Detail = { current: source.kind === 'literal' ? { kind: 'literal', value: structuredClone(source.value) }
            : { kind: source.kind === 'unset' ? 'unset' : 'reference', description: item.currentDescription },
            targetDefault: hasDefault ? { present: true, value: structuredClone((after as S2CompositeBlueprint['parameters'][number]).defaultValue!) } : { present: false } };
          details.set(key, detail); item.detailAvailable = true;
        }
      }
      item.stateLabel = stateLabel[item.state]; items.push(item);
    }
  }
  const blockers = [...(!comparison.sceneCapabilitiesReady ? ['目标需要本场景尚未选装的能力；不自动补装或授权。'] : []),
    ...(inspection.structuralDifferences ? ['当前实例有步骤、接线、名称或层级改动；必须保留这些改动，不能直接覆盖。'] : []),
    ...(items.some(item => item.state === 'conflict') ? ['部分接口或当前绑定存在冲突，不能直接迁移。'] : [])];
  const report = { status: 'preview' as const, applied: false as const, migrationSupported: false as const,
    scope: 'current-library-instance-carry-preview' as const, source: comparison.from, target: comparison.to, direction: comparison.direction,
    instance: { id: instance.id, label: instance.label }, items, blockers,
    missingCapabilities: comparison.missingCapabilities.map(item => item.label),
    outputChanges: comparison.changes.filter(item => item.kind === 'output').map(item => ({ label: item.label, reasons: item.changes })),
    internalDesignChangedInTarget: !!comparison.nodeChanges.length || comparison.linksChanged || comparison.hierarchyChanged,
    relativeLayoutChangedInInstance: inspection.relativeLayoutChanged, externalReferenceCount: inspection.externalConnectionCount,
    canApply: false as const, note };
  previews.set(report, { document: documentKey, definition: definitionKey, report: canonical(report), details, sources: sourcesForCopy });
  return report;
}
export type S2CompositeMigrationPreview = ReturnType<typeof previewS2CompositeMigration>;

/** A copied/imported/changed report is not a host-issued preview. Exact scene configuration AND full graph are pinned, not just IDs/version tags. */
export function isS2CompositeMigrationPreviewCurrent(report: unknown, documentRaw: unknown, definitionRaw: S2CanvasDefinition): boolean {
  if (!report || typeof report !== 'object') return false;
  const stored = previews.get(report); if (!stored) return false;
  try {
    if (canonical(snapshot(report)) !== stored.report) return false;
    const now = current(documentRaw, definitionRaw);
    return now.documentKey === stored.document && now.definitionKey === stored.definition;
  } catch { return false; }
}
/** Explicit local UI read only. It does not resolve references or resource handles, and never truncates a value into apparent completeness. */
export function readS2CompositeMigrationDetail(report: unknown, documentRaw: unknown, definition: S2CanvasDefinition, itemKey: string) {
  if (!isS2CompositeMigrationPreviewCurrent(report, documentRaw, definition)) throw new Error('沿用预览已过期或不是当前宿主生成，请重新预览。');
  const detail = previews.get(report as object)!.details.get(itemKey);
  if (!detail) return { status: 'unavailable' as const, reason: '此项没有可读取的值；资料句柄和不一致的多来源不会显示。' };
  if (canonical(detail).length > 12000) return { status: 'unavailable' as const, reason: '本项完整内容超过预览上限，请在原节点查看；没有截断或迁移。' };
  return { status: 'available' as const, detail: structuredClone(detail) };
}

const copyNote = '仅新增独立目标版本副本，原实例、原接线和版本库保留；不重接外部输出、不运行、不恢复资料或模型权限。确认添加会更新画布修订，旧结果或等待可能按现有编辑规则失效，原运行记录保留。';
const choiceLabels: Record<S2CompositeCopyChoice, string> = { current: '沿用当前来源或值', 'target-default': '使用目标默认值', empty: '暂不设置，添加后再填写或选择' };
type CopyRecord = { preview: object; signature: string; document: S2Document; id: string; nodeIds: string[]; used: boolean };
const copies = new WeakMap<object, CopyRecord>();

/** Allocate stable real IDs and validate ONE whole candidate; no mutation, authority changes, execution or outgoing rewiring. */
export function prepareS2CompositeCopy(preview: S2CompositeMigrationPreview, documentRaw: unknown, definitionRaw: S2CanvasDefinition, rawChoices: unknown) {
  if (!isS2CompositeMigrationPreviewCurrent(preview, documentRaw, definitionRaw) || preview.status !== 'preview') throw new Error('沿用预览已过期，请重新预览后逐项选择。');
  if (preview.missingCapabilities.length) throw new Error('目标所需能力尚未选装，不能通过添加副本扩大权限。');
  const selected = snapshotS2CompositeData(rawChoices) as Array<{ key: string; choice: S2CompositeCopyChoice }>;
  const required = preview.items.filter(item => item.copyChoices.length);
  if (!Array.isArray(selected) || selected.length !== required.length || selected.length > 32) throw new Error('请为目标版本的每个材料和可调项明确选择，不能省略或自动代选。');
  const seen = new Set<string>();
  for (const item of selected) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['key', 'choice'].includes(key))
      || typeof item.key !== 'string' || seen.has(item.key) || !required.find(port => port.key === item.key)?.copyChoices.includes(item.choice)) throw new Error('副本选择含重复、未知、冲突沿用或未授权的资料选择。');
    seen.add(item.key);
  }
  const { document, definition } = current(documentRaw, definitionRaw), stored = previews.get(preview)!;
  const source = document.composites!.find(item => item.id === preview.instance.id)!;
  const target = document.blueprints!.find(item => item.blueprint.id === preview.target.id && item.blueprint.version === preview.target.version)!;
  const oldMembers = document.execution!.nodes.filter(node => source.nodeIds.includes(node.id));
  const targetNodes = target.blueprint.workflow.nodes;
  // Place the independent copy beyond every existing card, not merely beside its source (where a downstream card may already live).
  // Preserve target-relative positions and all existing nodes; normal expansion/document validation still rejects out-of-range placement.
  const position = { x: Math.max(...[...document.nodes, ...document.execution!.nodes].map(node => node.position.x)) + 450 - Math.min(...targetNodes.map(node => node.position.x)),
    y: Math.min(...oldMembers.map(node => node.position.y)) - Math.min(...targetNodes.map(node => node.position.y)) };
  const expanded = instantiateS2CompositeDesign(document, definition.plugins, target.blueprint.id, target.blueprint.version, { position }, source.parentId, crypto.randomUUID());
  const mapping = new Map(expanded.document.composites!.find(item => item.id === expanded.id)!.blueprint!.mapping!.nodes.map(item => [item.localId, item.id]));
  for (const selection of selected) {
    const item = required.find(item => item.key === selection.key)!;
    const port = item.kind === 'input' ? target.blueprint.inputs.find(port => port.id === item.id)! : target.blueprint.parameters.find(port => port.id === item.id)!;
    const endpoints = 'targets' in port ? port.targets : [port.target];
    if (selection.choice === 'target-default') continue; // Expansion applies the exact target default; no fallbacks.
    for (const endpoint of endpoints) {
      const nodeId = mapping.get(endpoint.nodeId)!, node = expanded.document.execution!.nodes.find(node => node.id === nodeId)!;
      delete node.bindings[endpoint.portId]; // Empty means EMPTY, including when the target defines a default.
      if (selection.choice === 'empty') continue;
      const value = stored.sources.get(selection.key);
      if (!value || value.kind === 'missing' || value.kind === 'unset') throw new Error('该项已无可沿用来源，请重新选择。');
      if (value.kind === 'links') for (const from of value.endpoints) expanded.document.execution!.links.push({ source: structuredClone(from), target: { nodeId, portId: endpoint.portId } });
      else node.bindings[endpoint.portId] = structuredClone(value);
    }
  }
  const checked = readS2Document(expanded.document, definition), newIds = new Set(expanded.nodeIds), registry = s2BuiltinPluginRegistry();
  const names = new Map(checked.execution!.nodes.map(node => [node.id, newIds.has(node.id) ? `新增步骤 ${expanded.nodeIds.indexOf(node.id) + 1} · ${s2NodeTitle(node)}` : s2NodeTitle(node)]));
  const steps = checked.execution!.nodes.filter(node => newIds.has(node.id)).map(node => ({ label: names.get(node.id)!,
    inputs: registry.capability(node).inputs.map(port => ({ label: s2PortLabel(node, port, 'inputs'),
      source: node.bindings[port.id]?.kind === 'literal' ? '已设置值（详情中查看）' : node.bindings[port.id]?.kind === 'field' ? '引用原有内容块（不复制正文）'
        : checked.execution!.links.some(link => link.target.nodeId === node.id && link.target.portId === port.id) ? '由已连线步骤提供' : '待填写或选择',
      unboundRequired: port.required && !node.bindings[port.id] && !checked.execution!.links.some(link => link.target.nodeId === node.id && link.target.portId === port.id) })) }));
  const report = { status: 'copy-candidate' as const, applied: false as const, executionRequested: false as const,
    source: preview.source, target: preview.target, id: expanded.id, nodeCount: expanded.nodeIds.length,
    compositeCount: checked.composites!.filter(item => !document.composites!.some(old => old.id === item.id)).length,
    parentLabel: source.parentId ? document.composites!.find(item => item.id === source.parentId)!.label : '总画布',
    selections: selected.map(selection => ({ label: required.find(item => item.key === selection.key)!.label, choice: choiceLabels[selection.choice] })),
    steps, requiredPending: steps.flatMap(step => step.inputs.filter(input => input.unboundRequired).map(input => `${step.label} · ${input.label}`)),
    connections: checked.execution!.links.filter(link => newIds.has(link.target.nodeId)).map(link => ({ source: names.get(link.source.nodeId)!, target: names.get(link.target.nodeId)!, external: !newIds.has(link.source.nodeId) })),
    warnings: [...preview.blockers, ...(preview.relativeLayoutChangedInInstance ? ['原实例布局保留；新副本按目标版本独立放置。'] : []), '未设置的必填项仍可在添加后填写；添加成功不等于可运行或目标达成。'], note: copyNote };
  copies.set(report, { preview, signature: canonical(report), document: checked, id: expanded.id, nodeIds: expanded.nodeIds, used: false });
  return report;
}
export type S2CompositeCopyCandidate = ReturnType<typeof prepareS2CompositeCopy>;
export function isS2CompositeCopyCurrent(candidate: unknown, documentRaw: unknown, definition: S2CanvasDefinition): boolean {
  if (!candidate || typeof candidate !== 'object') return false;
  const stored = copies.get(candidate); if (!stored || stored.used) return false;
  try { return canonical(snapshot(candidate)) === stored.signature && isS2CompositeMigrationPreviewCurrent(stored.preview, documentRaw, definition); } catch { return false; }
}
/** Optional, explicit design disclosure. Includes complete new steps, incoming references and hierarchy, not existing content bodies or runtime state. */
export function readS2CompositeCopyDesign(candidate: S2CompositeCopyCandidate, documentRaw: unknown, definition: S2CanvasDefinition) {
  if (!isS2CompositeCopyCurrent(candidate, documentRaw, definition)) throw new Error('副本预览已过期、已使用或已取消，请重新生成。');
  const stored = copies.get(candidate)!, ids = new Set(stored.nodeIds), before = current(documentRaw, definition).document;
  return structuredClone({ scope: 'new-copy-design-only', execution: { version: 1,
    nodes: stored.document.execution!.nodes.filter(node => ids.has(node.id)), links: stored.document.execution!.links.filter(link => ids.has(link.target.nodeId)) },
    composites: stored.document.composites!.filter(item => !before.composites!.some(old => old.id === item.id)) });
}
/** Caller invokes only after explicit confirmation, then commits atomically through the normal canvas lifecycle. Never runs anything. */
export function acceptS2CompositeCopy(candidate: S2CompositeCopyCandidate, documentRaw: unknown, definitionRaw: S2CanvasDefinition) {
  if (!isS2CompositeCopyCurrent(candidate, documentRaw, definitionRaw)) throw new Error('副本预览已过期、已使用或已取消，请重新生成。');
  const stored = copies.get(candidate)!, { definition } = current(documentRaw, definitionRaw);
  const document = readS2Document(structuredClone(stored.document), definition);
  stored.used = true;
  return { document, id: stored.id, nodeIds: [...stored.nodeIds] };
}
export function discardS2CompositeCopy(candidate: unknown) { if (candidate && typeof candidate === 'object') copies.delete(candidate); }

type OutputConsumer = { key: string; kind: 'data'; linkIndex: number; source: S2CompositeEndpoint; target: S2CompositeEndpoint }
  | { key: string; kind: 'condition'; targetId: string; source: S2CompositeEndpoint };
type OutputOption = { id: string; label: string; eligible: boolean; reason: string };
type OutputItem = { key: string; kind: 'data' | 'condition'; sourceLabel: string; targetLabel: string; description: string;
  options: OutputOption[]; technical: string };
const outputNote = '预览和检查不添加副本、不改原线、不执行。类型和整图检查通过不等于业务等价、可运行或目标达成；必须另行确认，才会一起添加独立新版副本并重接所选下游，保留原实例和未选连接。';
type OutputRecord = { candidate: S2CompositeCopyCandidate; signature: string; consumers: OutputConsumer[];
  outputs: Map<string, S2CompositeEndpoint>; document: string; definition: string; activePlan?: object };
const outputPreviews = new WeakMap<object, OutputRecord>();
type OutputPlanRecord = { preview: S2CompositeOutputPreview; signature: string; document: S2Document;
  selections: Array<{ key: string; choice: string }>; choicesSignature: string; reconnectedCount: number; keptCount: number };
// The public check is evidence; only its exact host-local object can be confirmed once. No imported JSON can grant commit authority.
const outputPlans = new WeakMap<object, OutputPlanRecord>();
const outputChoiceId = (id: string) => JSON.stringify(['output', id]);

function outputFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  // These are categories, not an echo of arbitrary graph data, comparison values or field contents.
  if (/循环|自连/.test(message)) return '替换后会形成数据或条件依赖循环；请先调整设计，不能直接重接。';
  if (/重复|多路|单值|32项/.test(message)) return '替换后会重复连接或违反接收数量限制；不能自动删掉其他来源。';
  if (/组合|封装|内部|外部|父级|层级/.test(message)) return '替换后会跨越当前组合的依赖边界；请先检查封装关系，不能自动移动步骤。';
  if (/类型|版本|必填|缺省|输入|端口/.test(message)) return '替换后不满足当前完整画布的端口、类型或输入约束。';
  return '替换后未通过当前完整画布校验；保留原连接并检查设计。';
}

/** Changes only a private candidate; callers must validate the whole graph before issuing or consuming a confirmation token. */
function replaceOutputConsumer(document: S2Document, consumer: OutputConsumer, source: S2CompositeEndpoint) {
  if (consumer.kind === 'data') document.execution!.links[consumer.linkIndex].source = structuredClone(source);
  else {
    const node = document.execution!.nodes.find(node => node.id === consumer.targetId)!;
    // Preserve the exact pointer, match and native equals value, including false, 0 and null.
    node.when = { ...node.when!, nodeId: source.nodeId, portId: source.portId };
  }
}

/** Read-only downstream design inventory from the ORIGINAL instance, not the copy's newly carried inputs.
 * Public output IDs are explicit choices, never correspondence inferred from names or source provenance.
 */
export function previewS2CompositeOutputs(candidate: S2CompositeCopyCandidate, documentRaw: unknown, definitionRaw: S2CanvasDefinition) {
  if (!isS2CompositeCopyCurrent(candidate, documentRaw, definitionRaw)) throw new Error('副本预览已过期、已使用或已取消，请重新生成后检查输出。');
  const { document, definition, documentKey, definitionKey } = current(documentRaw, definitionRaw), stored = copies.get(candidate)!;
  const migration = stored.preview as Extract<S2CompositeMigrationPreview, { status: 'preview' }>;
  const instance = document.composites!.find(item => item.id === migration.instance.id)!;
  const members = new Set(instance.nodeIds), graph = document.execution!, registry = s2BuiltinPluginRegistry();
  const targetInstance = stored.document.composites!.find(item => item.id === stored.id)!;
  const target = stored.document.blueprints!.find(item => item.blueprint.id === candidate.target.id && item.blueprint.version === candidate.target.version)!.blueprint;
  const mapping = new Map(targetInstance.blueprint!.mapping!.nodes.map(item => [item.localId, item.id]));
  const outputs = new Map(target.outputs.map(port => [outputChoiceId(port.id), { nodeId: mapping.get(port.source.nodeId)!, portId: port.source.portId }]));
  const consumers: OutputConsumer[] = graph.links.flatMap((link, linkIndex) => members.has(link.source.nodeId) && !members.has(link.target.nodeId)
    ? [{ key: JSON.stringify(['data', s2ExecutionLinkKey(link)]), kind: 'data' as const, linkIndex, source: structuredClone(link.source), target: structuredClone(link.target) }] : []);
  for (const node of graph.nodes) if (!members.has(node.id) && node.when && members.has(node.when.nodeId)) consumers.push({
    key: JSON.stringify(['condition', node.id]), kind: 'condition', targetId: node.id, source: { nodeId: node.when.nodeId, portId: node.when.portId },
  });
  const originalDesign = document.blueprints!.find(item => item.blueprint.id === migration.source.id && item.blueprint.version === migration.source.version)!.blueprint;
  const originalMapping = new Map(instance.blueprint!.mapping!.nodes.map(item => [item.localId, item.id]));
  const oldPublished = new Set(originalDesign.outputs.map(port => keyOf({ nodeId: originalMapping.get(port.source.nodeId)!, portId: port.source.portId })));
  const checkedOptions = new Map<string, string>(); let checkCount = 0;
  const items: OutputItem[] = consumers.map(consumer => {
    const oldNode = graph.nodes.find(node => node.id === consumer.source.nodeId)!, oldPort = registry.capability(oldNode).outputs.find(port => port.id === consumer.source.portId)!;
    const sourceLabel = `${s2ConnectionPortLabel(definition, document, consumer.source, 'outputs')} · 原实例 ${migration.source.version}`;
    const targetLabel = consumer.kind === 'data' ? s2ConnectionPortLabel(definition, document, consumer.target, 'inputs')
      : `${s2ConnectionNodeLabel(definition, document, consumer.targetId)}的运行条件`;
    const options: OutputOption[] = [{ id: 'keep', label: '保留原连接', eligible: true, reason: '保持当前来源，不改材料、比较设置或其他连接。' }];
    for (const port of target.outputs) {
      const id = outputChoiceId(port.id), endpoint = outputs.get(id)!;
      const node = stored.document.execution!.nodes.find(node => node.id === endpoint.nodeId)!;
      const actual = registry.capability(node).outputs.find(item => item.id === endpoint.portId)!;
      let reason = '';
      if (consumer.kind === 'data') {
        const receiving = registry.capability(graph.nodes.find(node => node.id === consumer.target.nodeId)!).inputs.find(port => port.id === consumer.target.portId)!;
        if (!registry.compatible(actual.type, receiving.type)) reason = '材料类型或格式版本不同，不能直接交给这个输入；不自动转换。';
        else if (actual.multiple && !receiving.multiple) reason = '新版一次可能给出多项结果，但这里只接收一项；不自动选取其中一项。';
        else if (receiving.required && !actual.required) reason = '新版不保证提供此结果，不能满足这个必填输入。';
      } else if (!actual.required || actual.multiple || !['core.assessment', 'structured-data.value', 'workflow-simulation.result', 'human-input.decision'].includes(actual.type.id)) {
        reason = '这个输出不能用作单值完整的运行条件来源。';
      } else if (!registry.compatible(actual.type, oldPort.type)) reason = '新版与原条件来源的材料类型或格式版本不同；不能直接沿用比较设置。';
      if (!reason) {
        const key = JSON.stringify([consumer.key, endpoint.nodeId, endpoint.portId]);
        if (checkedOptions.has(key)) reason = checkedOptions.get(key)!;
        else if (checkCount >= 128) {
          throw new Error('影响方案过多，本次未生成完整输出预览；请缩小组合或下游范围后重试。原图和副本预览保留。');
        } else {
          checkCount++;
          try { const next = structuredClone(stored.document); replaceOutputConsumer(next, consumer, endpoint); readS2Document(next, definition); }
          catch (error) { reason = outputFailure(error); }
          checkedOptions.set(key, reason);
        }
      }
      options.push({ id, label: `${port.label} · 新副本 ${migration.target.version} · ${s2ConnectionPortLabel(definition, stored.document, endpoint, 'outputs')}`,
        eligible: !reason, reason: reason || (consumer.kind === 'condition'
          ? '静态检查通过；仍需人工核对新版结果结构是否支持原比较位置、含义是否一致。比较位置和值均保持不变。'
          : '静态检查通过；仍需人工确认新版结果是否适合这个用途，不代表已经重接或运行。') });
    }
    return { key: consumer.key, kind: consumer.kind, sourceLabel, targetLabel,
      description: `${consumer.kind === 'data' ? '这条线传递结果给下游输入。' : '这项依赖只控制是否运行，不传递普通材料；保留原比较位置、比较值和相等/不等规则，不在本预览中展示或修改。'}${oldPublished.has(keyOf(consumer.source)) ? '' : '该真实来源不在原库版本的公开输出中，仍按当前实际连接列出，不猜测对应项。'}`,
      options, technical: JSON.stringify({ kind: consumer.kind, source: consumer.source,
        ...(consumer.kind === 'data' ? { target: consumer.target } : { targetNodeId: consumer.targetId }),
        sourceOriginallyPublic: oldPublished.has(keyOf(consumer.source)),
        outputs: target.outputs.map(port => ({ id: outputChoiceId(port.id), publicOutputId: port.id, endpoint: outputs.get(outputChoiceId(port.id)), type: port.type, required: port.required, multiple: port.multiple })) }) };
  });
  const report = { status: 'output-reconnect-preview' as const, applied: false as const, canApply: false as const,
    source: { id: instance.id, label: instance.label, version: migration.source.version },
    target: { id: stored.id, label: targetInstance.label, version: migration.target.version }, items,
    warnings: ['原实例的当前真实数据线和条件依赖全部列出，包含后续编辑产生的连接；不按同名输出推断对应关系。',
      '新副本沿用的所有输入和固定设置会保留，并参与完整候选校验；新副本新增的输入引用不是原实例的旧下游。',
      '外层组合出口是按真实图重算的显示入口，不是额外的数据消费者；本预览不改变组合成员或层级。',
      '尚未添加副本或重接；每条连接都需要明确选择“保留原连接”或一个可用的新输出。'], note: outputNote };
  outputPreviews.set(report, { candidate, signature: canonical(snapshot(report)), consumers, outputs, document: documentKey, definition: definitionKey });
  return report;
}
export type S2CompositeOutputPreview = ReturnType<typeof previewS2CompositeOutputs>;

export function isS2CompositeOutputPreviewCurrent(report: unknown, documentRaw: unknown, definitionRaw: S2CanvasDefinition): boolean {
  if (!report || typeof report !== 'object') return false;
  const stored = outputPreviews.get(report); if (!stored) return false;
  try {
    if (canonical(snapshot(report)) !== stored.signature || !isS2CompositeCopyCurrent(stored.candidate, documentRaw, definitionRaw)) return false;
    const now = current(documentRaw, definitionRaw); return now.documentKey === stored.document && now.definitionKey === stored.definition;
  } catch { return false; }
}
export function discardS2CompositeOutputPreview(report: unknown) {
  if (!report || typeof report !== 'object') return;
  const previous = outputPreviews.get(report)?.activePlan;
  if (previous) discardS2CompositeOutputPlan(previous);
  outputPreviews.delete(report);
}

/** Check ALL explicit choices together without committing. A successful nonempty reconnection plan can only be accepted
 * later by exact host-local identity, explicit confirmation and a fresh full graph/configuration check. */
export function checkS2CompositeOutputPlan(report: S2CompositeOutputPreview, documentRaw: unknown, definitionRaw: S2CanvasDefinition, rawChoices: unknown) {
  // Beginning any replacement check retires the previous plan, even if the new selection is invalid or stale.
  const previous = outputPreviews.get(report)?.activePlan;
  if (previous) discardS2CompositeOutputPlan(previous);
  if (!isS2CompositeOutputPreviewCurrent(report, documentRaw, definitionRaw)) throw new Error('输出预览已过期、已取消或不属于当前副本，请重新预览。');
  const selected = snapshot(rawChoices) as Array<{ key: string; choice: string }>;
  if (!Array.isArray(selected) || selected.length !== report.items.length || selected.length > 120) throw new Error('请为每条下游连接明确选择保留或一个新输出，不能省略或自动代选。');
  const seen = new Set<string>();
  for (const item of selected) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 2 || Object.keys(item).some(key => !['key', 'choice'].includes(key))
      || typeof item.key !== 'string' || typeof item.choice !== 'string' || seen.has(item.key)
      || !report.items.find(entry => entry.key === item.key)?.options.some(option => option.id === item.choice && option.eligible)) throw new Error('输出选择含重复、未知或不兼容项，请按当前预览逐项选择。');
    seen.add(item.key);
  }
  const stored = outputPreviews.get(report)!, copy = copies.get(stored.candidate)!, next = structuredClone(copy.document);
  const changes = selected.map(selection => {
    const item = report.items.find(item => item.key === selection.key)!, consumer = stored.consumers.find(item => item.key === selection.key)!;
    if (selection.choice !== 'keep') replaceOutputConsumer(next, consumer, stored.outputs.get(selection.choice)!);
    return { key: item.key, kind: item.kind, sourceLabel: item.sourceLabel, targetLabel: item.targetLabel,
      choiceLabel: item.options.find(option => option.id === selection.choice)!.label, kept: selection.choice === 'keep' };
  });
  try {
    const document = readS2Document(next, current(documentRaw, definitionRaw).definition);
    const reconnectedCount = changes.filter(item => !item.kept).length;
    const checked = { status: 'checked' as const, compatible: true, applied: false as const, canApply: reconnectedCount > 0, changes,
      reasons: ['所选方案作为一个完整候选通过静态校验；没有修改画布，也未证明业务等价或实际结果正确。',
        ...(!reconnectedCount ? ['本次没有需要重接的下游；如只想添加副本，请使用“确认添加独立新版副本”。'] : [])], note: outputNote };
    if (reconnectedCount) {
      outputPlans.set(checked, { preview: report, signature: canonical(snapshot(checked)), document,
        selections: structuredClone(selected), choicesSignature: canonical(selected), reconnectedCount, keptCount: changes.length - reconnectedCount });
      stored.activePlan = checked;
    }
    return checked;
  } catch (error) {
    return { status: 'blocked' as const, compatible: false, applied: false as const, canApply: false as const, changes,
      reasons: [outputFailure(error), '单项可用不代表组合后可用；保留原图，请调整本次选择。'], note: outputNote };
  }
}

export type S2CompositeOutputPlanCheck = ReturnType<typeof checkS2CompositeOutputPlan>;

/** Configuration, original document, exact copy, original preview and reviewed choices must all remain unchanged. */
export function isS2CompositeOutputPlanCurrent(check: unknown, documentRaw: unknown, definitionRaw: S2CanvasDefinition): boolean {
  if (!check || typeof check !== 'object') return false;
  const stored = outputPlans.get(check); if (!stored) return false;
  try {
    return outputPreviews.get(stored.preview)?.activePlan === check
      && canonical(snapshot(check)) === stored.signature
      && canonical(stored.selections) === stored.choicesSignature
      && isS2CompositeOutputPreviewCurrent(stored.preview, documentRaw, definitionRaw);
  } catch { return false; }
}

export function discardS2CompositeOutputPlan(check: unknown) {
  if (!check || typeof check !== 'object') return;
  const stored = outputPlans.get(check);
  if (stored) {
    const preview = outputPreviews.get(stored.preview);
    if (preview?.activePlan === check) delete preview.activePlan;
  }
  outputPlans.delete(check);
}

/** Explicit confirmation only. Returns one complete validated document for the normal atomic canvas commit.
 * Never mutates the input, updates a host, grants permissions or executes; validation failure consumes nothing. */
export function acceptS2CompositeOutputPlan(check: S2CompositeOutputPlanCheck, documentRaw: unknown, definitionRaw: S2CanvasDefinition) {
  if (!isS2CompositeOutputPlanCurrent(check, documentRaw, definitionRaw)) throw new Error('重接方案已过期、已使用、已取消或没有待重接项，请重新检查后确认。');
  const stored = outputPlans.get(check)!, output = outputPreviews.get(stored.preview)!, copy = copies.get(output.candidate)!;
  const { definition } = current(documentRaw, definitionRaw);
  const document = readS2Document(structuredClone(stored.document), definition);
  const accepted = { document, id: copy.id, nodeIds: [...copy.nodeIds], reconnectedCount: stored.reconnectedCount, keptCount: stored.keptCount };
  // Consume only after the last full validation. All other checks/previews derived from this copy become invalid as well.
  copy.used = true;
  discardS2CompositeOutputPlan(check);
  return accepted;
}

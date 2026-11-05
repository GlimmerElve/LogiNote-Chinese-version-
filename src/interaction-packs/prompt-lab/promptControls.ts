import type { S2CanvasDefinition, S2Document, S2WorkflowNode } from '../../types/sceneS2';
import type { S2Json } from '../../types/sceneS2Plugin';
import { readS2Definition, readS2Document } from './uiHost';
import { snapshotS2CompositeData } from './uiHost';
import { canonicalS2Json } from './uiHost';
import { s2NodeTitle } from './uiHost';

export type S2PromptSection = { material: string; heading: string };
export type S2PromptPart = { kind: 'text'; text: string } | { kind: 'material'; material: string; spelling?: string };
export const S2_PROMPT_PART_LIMIT = 128;
export type S2PromptRecoveryTarget = { kind: 'input' | 'advanced'; nodeId: string; portId: string }
  | { kind: 'content'; nodeId: string; fieldId: string } | { kind: 'purpose'; nodeId: string };
export interface S2PromptRecovery {
  code: 'name-missing' | 'name-dynamic' | 'name-invalid' | 'name-duplicate' | 'materials-dynamic' | 'materials-missing'
    | 'materials-shape' | 'materials-capacity' | 'template-source' | 'template-readonly' | 'template-text' | 'template-syntax' | 'template-reference' | 'template-capacity' | 'other';
  guidance: string; targets: S2PromptRecoveryTarget[];
}
const recoveryErrors = new WeakMap<object, S2PromptRecovery>();
/** Classify at the actual local branch, never from an error sentence or model-provided metadata. */
function blocked(message: string, recovery: S2PromptRecovery): never {
  const error = new Error(message); recoveryErrors.set(error, recovery); throw error;
}
function unavailable(error: unknown, base: string, target: S2PromptRecoveryTarget) {
  const recovery = error && typeof error === 'object' ? recoveryErrors.get(error) : undefined;
  return { kind: 'unavailable' as const, base, reason: error instanceof Error ? error.message : '当前内容不能无损转为按名称编辑。',
    recovery: recovery ? { ...recovery, targets: (recovery.targets.length ? recovery.targets : [target]).map(item => ({ ...item })) }
      : { code: 'other' as const, guidance: '请在原设置中核对完整内容；原引用及未应用草稿保留，不自动转换或运行。', targets: [{ ...target }] } };
}
const validName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
const exact = (node: S2WorkflowNode | undefined, kind: string) => !!node && node.pluginId === 'text-template' && node.pluginVersion === '1.0.0' && node.capabilityId === kind;
function current(definitionRaw: S2CanvasDefinition, documentRaw: S2Document, nodeId: string) {
  const snapshot = (value: unknown) => snapshotS2CompositeData(value, { maxBytes: 786432, maxEntries: 48000 });
  const definition = readS2Definition(snapshot(definitionRaw)), document = readS2Document(snapshot(documentRaw), definition);
  const node = document.execution?.nodes.find(node => node.id === nodeId);
  if (!node || !['bind', 'render'].some(kind => exact(node, kind))) throw new Error('此步骤不支持简化提示词编辑。');
  return { definition, document, node, base: canonicalS2Json({ definition, document } as unknown as S2Json) };
}
function connected(document: S2Document, nodeId: string, portId: string) {
  return document.execution!.links.filter(link => link.target.nodeId === nodeId && link.target.portId === portId);
}
/** Programmatic template edits share the source block's read-only policy. */
function requireEditableTemplate(now: ReturnType<typeof current>) {
  const binding = now.node.bindings.template;
  if (binding?.kind !== 'field') return;
  const source = now.document.nodes.find(item => item.id === binding.nodeId);
  const authored = now.definition.initial.nodes.find(item => item.id === binding.nodeId);
  if (source?.readOnly === true || authored?.readOnly === true) blocked('这份排版引用只读内容块，本场景不允许修改固定原文。', {
    code: 'template-readonly', guidance: '可查看来源块的固定原文，并继续引用、组装和运行；本场景不允许在此处或来源处修改该块内容。',
    targets: [{ kind: 'content', nodeId: binding.nodeId, fieldId: binding.fieldId }] });
}
function nameRecovery(document: S2Document, node: S2WorkflowNode): S2PromptRecovery | undefined {
  const links = connected(document, node.id, 'key'), binding = node.bindings.key;
  if (!links.length && !binding) return { code: 'name-missing', guidance: '先为这份内容设置便于理解的用途，再回到排版步骤按名称选用；不需要填写内部字段名。', targets: [{ kind: 'purpose', nodeId: node.id }] };
  if (!links.length && binding?.kind === 'literal' && validName(binding.value)) return undefined;
  if (!links.length && binding?.kind === 'literal') return { code: 'name-invalid', guidance: '现有内部名称不符合本地模板规则。请在原高级设置核对；不会重命名或替换已有引用。', targets: [{ kind: 'advanced', nodeId: node.id, portId: 'key' }] };
  const targets: S2PromptRecoveryTarget[] = [{ kind: 'input', nodeId: node.id, portId: 'key' }];
  if (binding?.kind === 'field') targets.push({ kind: 'content', nodeId: binding.nodeId, fieldId: binding.fieldId });
  return { code: 'name-dynamic', guidance: '这份内容的名称由引用或上游决定，目前不能保证每次相同。可保留动态来源并使用完整模板；若确需固定名称，请在原设置明确更换来源。仅运行一次不会把它变成固定名称。', targets };
}
type Material = { key: string; label: string };
/** Read only declared names along the actual bind chain; never read content values, artifacts, resources or a model. */
function materials(document: S2Document, node: S2WorkflowNode, seen = new Set<string>()): Material[] {
  if (seen.has(node.id)) throw new Error('汇集链路出现循环，请先检查连接。');
  seen.add(node.id);
  const links = connected(document, node.id, 'variables'), binding = node.bindings.variables;
  let result: Material[] = [];
  if (links.length) {
    const source = document.execution!.nodes.find(item => item.id === links[0].source.nodeId);
    if (links.length !== 1 || binding || !exact(source, 'bind') || links[0].source.portId !== 'variables') blocked('这份材料的名称不能从当前汇集链路确定；保留原输入，可在高级设置中编辑。', {
      code: 'materials-dynamic', guidance: '当前来源不是可静态确认名称的汇集链路。请核对所选来源；保留动态输入时使用完整模板，不会读取运行结果来猜名称或复制成固定值。', targets: [{ kind: 'input', nodeId: node.id, portId: 'variables' }] });
    result = materials(document, source!, seen);
  } else if (binding) {
    if (binding.kind !== 'literal' || !binding.value || typeof binding.value !== 'object' || Array.isArray(binding.value)
      || Object.entries(binding.value).some(([key, value]) => !validName(key) || typeof value !== 'string') || Object.keys(binding.value).length > 32) blocked('当前不是已声明名称的文字集合；不猜测或转换材料。', {
        code: 'materials-shape', guidance: '按名称编辑需要已确定名称的文字集合。请核对原材料来源或完整数据；不会压平对象、丢字段或把其他类型转成文字。', targets: [{ kind: 'input', nodeId: node.id, portId: 'variables' }] });
    result = Object.keys(binding.value).map((key, index) => ({ key, label: `已命名内容 ${index + 1}` }));
  } else if (exact(node, 'render')) blocked('请先为“已汇集的内容”选择来源，再按内容名称安排段落。', {
    code: 'materials-missing', guidance: '先在材料设置中选择已有的汇集内容，再返回排版；选择来源不自动装配、运行或发送。', targets: [{ kind: 'input', nodeId: node.id, portId: 'variables' }] });
  if (exact(node, 'bind')) {
    const recovery = nameRecovery(document, node);
    if (recovery) blocked(recovery.code === 'name-missing' ? '这份内容尚未设置用途，请先为它命名。'
      : recovery.code === 'name-dynamic' ? '这份内容使用动态名称，暂不能按固定名称编辑；原引用保留。' : '这份内容的现有名称不符合模板规则；原输入保留。', recovery);
    const key = (node.bindings.key as { kind: 'literal'; value: string }).value;
    if (result.some(item => item.key === key)) blocked('同一汇集链路的内容名称重复，请在高级设置核对；未覆盖材料。', {
      code: 'name-duplicate', guidance: '同一条汇集链路的名称必须能区分各份内容。请在原名称设置核对；不会覆盖前一份内容，也不会自行重命名。', targets: [{ kind: 'advanced', nodeId: node.id, portId: 'key' }] });
    result.push({ key, label: node.presentation?.inputs?.value ?? s2NodeTitle(node) });
  }
  if (result.length > 32) blocked('汇集材料超过32份，不能截断编辑。', { code: 'materials-capacity', guidance: '请使用完整模板或自行调整汇集范围；不会只显示前32份、裁剪材料或自动拆分。', targets: [{ kind: 'input', nodeId: node.id, portId: 'variables' }] });
  return result;
}
export function compileS2PromptSections(raw: unknown, available: Material[]): { rows: S2PromptSection[]; text: string } {
  const rows = snapshotS2CompositeData(raw) as S2PromptSection[];
  if (!Array.isArray(rows) || rows.length > 32) throw new Error('最多安排32个段落。');
  for (const row of rows) {
    if (!row || Array.isArray(row) || typeof row !== 'object' || Object.keys(row).length !== 2 || !Object.hasOwn(row, 'material') || !Object.hasOwn(row, 'heading')
      || !available.some(item => item.key === row.material) || typeof row.heading !== 'string' || row.heading.length > 120 || /[\r\n]|\{\{|\}\}/.test(row.heading)) throw new Error('请选择当前可用内容；标题最多120字且为单行，不包含模板指令。');
  }
  const text = rows.map(row => `${row.heading ? row.heading + '\n' : ''}{{${row.material}}}`).join('\n\n');
  if (text.length > 6000) throw new Error('完整排版超过6000字，未截断或应用。');
  return { rows, text };
}
function decode(text: string, available: Material[]): S2PromptSection[] | null {
  if (text === '') return [];
  const rows: S2PromptSection[] = [];
  for (const paragraph of text.split('\n\n')) {
    const match = /^(?:([^\r\n]*)\n)?\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}$/.exec(paragraph);
    if (!match) return null;
    rows.push({ heading: match[1] ?? '', material: match[2] });
  }
  try { return compileS2PromptSections(rows, available).text === text ? rows : null; } catch { return null; }
}
export function inspectS2PromptControls(definition: S2CanvasDefinition, document: S2Document, nodeId: string) {
  const now = current(definition, document, nodeId), { node } = now;
  if (exact(node, 'bind')) return { kind: 'purpose' as const, base: now.base,
    canSet: !node.bindings.key && !connected(now.document, node.id, 'key').length, recovery: nameRecovery(now.document, node) };
  try {
    requireEditableTemplate(now);
    const binding = node.bindings.template;
    if (connected(now.document, node.id, 'template').length || binding && (binding.kind !== 'literal' || typeof binding.value !== 'string')) throw new Error('当前排版来自内容块或上游步骤，保持原引用；可在原块或高级设置修改。');
    const available = materials(now.document, node);
    const rows = binding?.kind === 'literal' ? decode(binding.value as string, available) : [];
    if (!rows) throw new Error('当前自定义排版不能无损转成段落列表，原文保留；请使用原编辑方式。');
    return { kind: 'layout' as const, base: now.base, available, rows };
  } catch (error) { return unavailable(error, now.base, { kind: 'advanced', nodeId: node.id, portId: 'template' }); }
}
export function setS2PromptPurpose(definition: S2CanvasDefinition, document: S2Document, nodeId: string, label: string, base: string) {
  const now = current(definition, document, nodeId), state = inspectS2PromptControls(definition, document, nodeId);
  if (now.base !== base) throw new Error('画布已变化，未应用旧用途设置。');
  if (state.kind !== 'purpose' || !state.canSet || typeof label !== 'string' || !label.trim() || label.length > 80) throw new Error('仅为未命名内容设置1至80字用途；已有名称或动态来源保持原样。');
  const used = new Set(now.document.execution!.nodes.flatMap(node => node.bindings.key?.kind === 'literal' ? [node.bindings.key.value] : []));
  let index = 1; while (used.has(`material${index}`)) index++;
  now.node.bindings.key = { kind: 'literal', value: `material${index}` };
  now.node.presentation = { ...now.node.presentation, label: now.node.presentation?.label ?? `汇集${label}`.slice(0, 80),
    inputs: { ...now.node.presentation?.inputs, value: label } };
  return readS2Document(now.document, now.definition);
}
export function applyS2PromptSections(definition: S2CanvasDefinition, document: S2Document, nodeId: string, rows: unknown, base: string) {
  const now = current(definition, document, nodeId), state = inspectS2PromptControls(definition, document, nodeId);
  if (now.base !== base || state.kind !== 'layout') throw new Error('排版或材料来源已变化，未覆盖当前内容。');
  now.node.bindings.template = { kind: 'literal', value: compileS2PromptSections(rows, state.available).text };
  return readS2Document(now.document, now.definition);
}

/** Same literal grammar as render; original placeholder whitespace and surrounding text are retained. */
export function decodeS2PromptParts(text: string, available: Material[]): S2PromptPart[] {
  if (typeof text !== 'string' || text.length > 6000) throw new Error('完整排版最多6000字，不截断。');
  const parts: S2PromptPart[] = []; let cursor = 0;
  const literal = (value: string) => {
    if (value.includes('{{') || value.includes('}}')) blocked('这份排版含不受支持的模板语法，请保留原文并使用高级编辑。', {
      code: 'template-syntax', guidance: '此语法不能无损转换为材料片段。请在原完整模板中核对，修正为本地支持的语法后再返回；不会替换或删掉原文。', targets: [] });
    if (value) parts.push({ kind: 'text', text: value });
  };
  for (const match of text.matchAll(/{{\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*}}/g)) {
    literal(text.slice(cursor, match.index));
    if (!available.some(item => item.key === match[1])) blocked('排版引用了当前汇集链路中未确定的材料；不猜测或替换。', {
      code: 'template-reference', guidance: '模板引用与当前已确定的材料名称不一致。请核对完整模板和所选汇集来源，修正后再返回；不会猜测替代项或自动删掉引用。', targets: [] });
    parts.push({ kind: 'material', material: match[1], spelling: match[0] }); cursor = match.index! + match[0].length;
  }
  literal(text.slice(cursor));
  if (!parts.length) parts.push({ kind: 'text', text: '' });
  if (parts.length > S2_PROMPT_PART_LIMIT) blocked('排版片段过多，请用高级编辑保留完整模板。', {
    code: 'template-capacity', guidance: '片段编辑最多128段。请在完整模板中编辑，不会截取部分内容来显示；执行仍按原有完整模板规则校验。', targets: [] });
  return parts;
}
export function compileS2PromptParts(raw: unknown, available: Material[]): string {
  const parts = snapshotS2CompositeData(raw) as S2PromptPart[];
  if (!Array.isArray(parts) || parts.length > S2_PROMPT_PART_LIMIT) throw new Error('最多安排128个排版片段。');
  let text = '', literal = '';
  const flush = () => {
    // Adjacent text fragments must not silently create a new placeholder across their boundary.
    if (literal.includes('{{') || literal.includes('}}')) throw new Error('普通文字请不要手写双花括号；请按名称插入材料，或使用高级模板编辑。');
    text += literal; literal = '';
  };
  for (const part of parts) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) throw new Error('排版片段无效。');
    if (part.kind === 'text') {
      if (Object.keys(part).some(key => !['kind', 'text'].includes(key)) || typeof part.text !== 'string') throw new Error('文字片段无效。');
      literal += part.text;
    } else if (part.kind === 'material') {
      if (Object.keys(part).some(key => !['kind', 'material', 'spelling'].includes(key)) || !validName(part.material)
        || !available.some(item => item.key === part.material)) throw new Error('请为引用片段选择当前可用材料。');
      flush();
      if (part.spelling !== undefined) {
        const match = typeof part.spelling === 'string' && /^{{\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*}}$/.exec(part.spelling);
        if (!match || match[0] !== part.spelling || match[1] !== part.material) throw new Error('材料引用与原始占位符不一致。');
      }
      text += part.spelling ?? `{{${part.material}}}`;
    } else throw new Error('未支持的排版片段类型。');
    if (text.length + literal.length > 6000) throw new Error('完整排版最多6000字，不截断。');
  }
  flush(); decodeS2PromptParts(text, available); return text;
}
export function inspectS2PromptTemplate(definition: S2CanvasDefinition, document: S2Document, nodeId: string) {
  const now = current(definition, document, nodeId), { node } = now;
  try {
    requireEditableTemplate(now);
    if (!exact(node, 'render') || connected(now.document, node.id, 'template').length) blocked('排版来自上游处理结果，请保留原连线并在来源处编辑。', {
      code: 'template-source', guidance: '排版由上游提供，不能在这里覆盖。请先查看排版的材料来源，在原步骤编辑；保留连线时继续使用原流程，不会读取结果来替换固定参数。', targets: [{ kind: 'input', nodeId: node.id, portId: 'template' }] });
    const binding = node.bindings.template; let text = '', sourceLabel = '本步骤的固定排版';
    if (binding?.kind === 'literal') {
      if (typeof binding.value !== 'string') blocked('排版不是完整文本。', { code: 'template-text', guidance: '请在原设置核对排版类型，不会把其他类型自动转成文字。', targets: [{ kind: 'advanced', nodeId: node.id, portId: 'template' }] }); text = binding.value;
    } else if (binding?.kind === 'field') {
      const index = now.document.nodes.findIndex(item => item.id === binding.nodeId), source = now.document.nodes[index];
      const type = now.definition.blockTypes.find(item => item.id === source?.type), field = type?.fields.find(item => item.id === binding.fieldId);
      if (!source || !field || !['text', 'multiline', 'code'].includes(field.kind) || typeof source.values[binding.fieldId] !== 'string') blocked('排版引用不是可原样编辑的文本块，请使用原编辑入口。', {
        code: 'template-text', guidance: '引用保持不变。请在原内容字段中核对；只有可完整表达的文本才能按名称排版，不会转换其他内容。', targets: source && field ? [{ kind: 'content', nodeId: source.id, fieldId: field.id }] : [{ kind: 'input', nodeId: node.id, portId: 'template' }] });
      text = source.values[binding.fieldId]; sourceLabel = `${source.label?.trim() || type!.label}（内容 ${index + 1}）「${field.label}」`;
    }
    const available = materials(now.document, node);
    let parts: S2PromptPart[];
    try { parts = decodeS2PromptParts(text, available); }
    catch (error) { return unavailable(error, now.base, binding?.kind === 'field' ? { kind: 'content', nodeId: binding.nodeId, fieldId: binding.fieldId } : { kind: 'advanced', nodeId: node.id, portId: 'template' }); }
    return { kind: 'template' as const, base: now.base, available, parts, text, sourceLabel, fieldSource: binding?.kind === 'field' };
  } catch (error) { return unavailable(error, now.base, { kind: 'input', nodeId: node.id, portId: 'variables' }); }
}
export function applyS2PromptParts(definition: S2CanvasDefinition, document: S2Document, nodeId: string, parts: unknown, base: string) {
  const now = current(definition, document, nodeId);
  requireEditableTemplate(now);
  const state = inspectS2PromptTemplate(definition, document, nodeId);
  if (now.base !== base || state.kind !== 'template') throw new Error('排版、材料或来源已变化，未应用旧草稿。');
  const text = compileS2PromptParts(parts, state.available), binding = now.node.bindings.template;
  if (binding?.kind === 'field') now.document.nodes.find(item => item.id === binding.nodeId)!.values[binding.fieldId] = text;
  else now.node.bindings.template = { kind: 'literal', value: text };
  return readS2Document(now.document, now.definition);
}

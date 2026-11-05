import type { S2Artifact, S2Json, S2PluginInvocation, S2PluginManifest, S2PluginPort } from '../../types/sceneS2Plugin';


const TEXT_LIMIT = 6000;
const VARIABLE_LIMIT = 32;
const reserved = new Set(['constructor', 'prototype', '__proto__']);
const variableName = (value: string) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) && !reserved.has(value);
const port = (id: string, type: string, meaning: string, required = true): S2PluginPort => ({
  id, label: id, meaning, type: { id: type, version: 1 }, required, multiple: false,
});

/** Trusted local text assembly, not a prompt executor or model-provided template program. */
export const S2_TEXT_TEMPLATE_PLUGIN: S2PluginManifest = {
  protocolVersion: 1, id: 'text-template', version: '1.0.0', label: '文本与提示词装配',
  meaning: '用单个compose节点按槽位直接拼接原文，或按明确需求使用bind/render进行字符串变量装配。只产生原始文本，不调用模型、运行代码、执行HTML或判定提示词效果。',
  dependencies: [{ id: 'core', version: '1.0.0' }, { id: 'structured-data', version: '1.0.0' }], dataTypes: [],
  capabilities: [
    { id: 'compose', kind: 'transform', meaning: '按part1至part8槽位顺序确定性拼接原文。至少一个槽位有输入（空字符串也算输入）；可用prefixes字符串数组配置对应槽位前缀，separator配置分隔符（默认换行）。不理解、优化、模板替换或补写内容，完整输出最多6000字，超限失败不截断。',
      inputs: [
        ...Array.from({ length: 8 }, (_, index) => port(`part${index + 1}`, 'core.text', `第${index + 1}份原始文字；用途只由当前组装配置决定。`, false)),
        port('prefixes', 'structured-data.value', '可选的最多8个字符串前缀数组，数组下标对应槽位1至8；每项最多120字，未提供的前缀为空。', false),
        port('separator', 'core.text', '可选分隔文本，最多120字；省略时换行，空字符串表示不分隔。', false),
      ], outputs: [port('text', 'core.text', '完整按配置组装的原始文本；没有模型调用、模板解释或质量判断。')],
      effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000 },
    { id: 'bind', kind: 'transform', meaning: '将key标识的value文本加入variables字符串字典；variables可省略从空字典开始，已有同名键拒绝，不覆盖原文。最多32个变量，标识符为ASCII字母开头的字母/数字/下划线，不接受保留键。',
      inputs: [port('key', 'core.text', '显式变量名，例如 task 或 constraints；不是表达式或路径。'),
        port('value', 'core.text', '完整原始文本，不改写、转义或替用户补充。'),
        port('variables', 'structured-data.value', '可选已有字符串字典；不能是数组、嵌套对象或非字符串值。', false)],
      outputs: [port('variables', 'structured-data.value', '新的字符串字典；不改变输入字典，不是模型请求或执行凭据。')],
      effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000 },
    { id: 'render', kind: 'transform', meaning: '把template中的{{name}}（允许内侧空白）按variables中的字符串单遍替换；缺变量、非法双花括号、表达式和超过6000字的完整输出失败，不递归替换变量值、不隐式转换JSON。允许共享字典中存在本模板未用的变量。',
      inputs: [port('template', 'core.text', '完整文本模板；仅{{name}}占位符，普通单花括号及换行原样保留。'),
        port('variables', 'structured-data.value', '最多32个合法标识符到原始字符串的字典；每值最多6000字。')],
      outputs: [port('text', 'core.text', '完整装配文本，最多6000字；不是有效JSON、LLM回复或业务合格证明。')],
      effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000 },
  ],
};

function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length > TEXT_LIMIT) throw new Error(`${label}必须是最多${TEXT_LIMIT}字的原始字符串，不隐式转换或截断`);
}
function dictionary(value: S2Json): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('variables必须是字符串字典对象');
  const names = Reflect.ownKeys(value);
  if (names.length > VARIABLE_LIMIT) throw new Error(`variables最多${VARIABLE_LIMIT}个变量`);
  return Object.fromEntries(names.map(key => {
    if (typeof key !== 'string' || !variableName(key)) throw new Error('变量名必须是ASCII字母开头的合法标识符，不允许保留键、路径或表达式');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('variables仅接受显式JSON数据字段，不读取访问器或隐藏字段');
    text(descriptor.value, `变量 ${key}`);
    return [key, descriptor.value as string];
  }));
}

/** Slot names and optional display labels never supply semantic roles or hidden content. */
export function composeS2Text(parts: Array<string | undefined>, prefixes: S2Json = [], separator = '\n'): string {
  if (!Array.isArray(parts) || Object.getPrototypeOf(parts) !== Array.prototype || parts.length > 8 || Reflect.ownKeys(parts).length !== parts.length + 1)
    throw new Error('组装输入必须是最多8个槽位的明确数组');
  const checkedParts = Array.from({ length: parts.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(parts, index);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('组装输入不接受访问器或缺失项');
    return descriptor.value as string | undefined;
  });
  if (!checkedParts.some(value => value !== undefined)) throw new Error('组装至少需要一个文字输入，最多8个槽位');
  if (typeof separator !== 'string' || separator.length > 120) throw new Error('组装分隔符必须是最多120字的原始字符串');
  if (!Array.isArray(prefixes) || Object.getPrototypeOf(prefixes) !== Array.prototype || prefixes.length > 8
    || Reflect.ownKeys(prefixes).length !== prefixes.length + 1) throw new Error('组装前缀必须是最多8项的字符串数组');
  const checkedPrefixes = Array.from({ length: prefixes.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(prefixes, index);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || typeof descriptor.value !== 'string' || descriptor.value.length > 120)
      throw new Error('每个组装前缀必须是最多120字的原始字符串，不读取访问器或缺失项');
    return descriptor.value as string;
  });
  const combined: string[] = [];
  let length = 0;
  checkedParts.forEach((value, index) => {
    if (value === undefined) return;
    text(value, `第${index + 1}份内容`);
    const current = `${checkedPrefixes[index] ?? ''}${value}`;
    length += current.length + (combined.length ? separator.length : 0);
    if (length > TEXT_LIMIT) throw new Error(`装配后的完整文本超过${TEXT_LIMIT}字，不截断或发布部分输出`);
    combined.push(current);
  });
  return combined.join(separator);
}

export function bindS2TextTemplateVariable(key: string, value: string, variables: S2Json = {}): Record<string, string> {
  if (typeof key !== 'string' || !variableName(key)) throw new Error('key必须是合法变量标识符，不允许保留键、路径或表达式');
  text(value, 'value');
  const current = dictionary(variables);
  if (Object.hasOwn(current, key)) throw new Error(`变量 ${key} 已存在，不能隐式覆盖；请修改其原始输入或显式调整绑定`);
  if (Object.keys(current).length >= VARIABLE_LIMIT) throw new Error(`variables最多${VARIABLE_LIMIT}个变量`);
  return { ...current, [key]: value };
}

export function renderS2TextTemplate(template: string, variables: S2Json): string {
  text(template, 'template');
  const current = dictionary(variables), parts: string[] = [];
  let cursor = 0, length = 0;
  const append = (value: string) => {
    length += value.length;
    if (length > TEXT_LIMIT) throw new Error(`装配后的完整文本超过${TEXT_LIMIT}字，不截断或发布部分输出`);
    parts.push(value);
  };
  const literal = (value: string) => {
    if (value.includes('{{') || value.includes('}}')) throw new Error('模板仅支持{{name}}字面占位符，不接受未闭合占位符、路径或表达式');
    append(value);
  };
  for (const match of template.matchAll(/{{\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*}}/g)) {
    literal(template.slice(cursor, match.index));
    const name = match[1];
    if (!variableName(name) || !Object.hasOwn(current, name)) throw new Error(`模板变量 ${name} 缺失或无效，不猜测内容`);
    append(current[name]); // Insert once as literal data: no expression evaluation, regex replacement syntax or recursive templates.
    cursor = match.index! + match[0].length;
  }
  literal(template.slice(cursor));
  return parts.join('');
}

export async function executeS2TextTemplate(call: S2PluginInvocation, inputs: Record<string, S2Json[]>) {
  if (call.pluginId !== 'text-template' || call.pluginVersion !== '1.0.0' || !['bind', 'render', 'compose'].includes(call.capabilityId)) throw new Error('未安装此文本装配执行器');
  try {
    if (call.capabilityId === 'compose' && Object.keys(inputs).some(key => ![...Array.from({ length: 8 }, (_, index) => `part${index + 1}`), 'prefixes', 'separator'].includes(key)))
      throw new Error('组装输入包含未声明的槽位或配置');
    const read = (name: string, optional = false): S2Json | undefined => {
      const values = inputs[name];
      if (optional && (values === undefined || Array.isArray(values) && values.length === 0)) return undefined;
      if (!Array.isArray(values) || values.length !== 1 || values[0] === undefined) throw new Error(`端口 ${name} 需要一个完整输入`);
      return values[0];
    };
    const value = call.capabilityId === 'compose'
      ? composeS2Text(Array.from({ length: 8 }, (_, index) => read(`part${index + 1}`, true) as string | undefined), read('prefixes', true), read('separator', true) as string | undefined)
      : call.capabilityId === 'bind'
      ? bindS2TextTemplateVariable(read('key') as string, read('value') as string, read('variables', true))
      : renderS2TextTemplate(read('template') as string, read('variables')!);
    const portId = call.capabilityId === 'bind' ? 'variables' : 'text';
    const artifact: S2Artifact = { protocolVersion: 1, id: `artifact-${crypto.randomUUID()}`, type: { id: portId === 'text' ? 'core.text' : 'structured-data.value', version: 1 }, complete: true,
      source: { sceneId: call.sceneId, runId: call.runId, nodeId: call.nodeId, revision: call.revision, kind: 'plugin', invocationId: call.id }, payload: { kind: 'inline', value } };
    // The host validates declared outputs before publication. The package also preserves its full JSON bound.
    if (portId === 'variables' && new TextEncoder().encode(JSON.stringify(value)).byteLength > 24000) throw new Error('完整变量字典超过24000字节，不发布部分输出');
    return { status: 'succeeded', outputs: { [portId]: [artifact] } };
  } catch (error) {
    return { status: 'failed', outputs: {}, error: { code: 'TEXT_TEMPLATE_REJECTED', message: (error instanceof Error ? error.message : '文本装配失败').slice(0, 1000) } };
  }
}

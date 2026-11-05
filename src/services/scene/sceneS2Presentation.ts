import type { S2NodePresentation, S2WorkflowCondition, S2WorkflowNode } from '../../types/sceneS2';
import type { S2PluginCapability, S2PluginNode, S2PluginPort } from '../../types/sceneS2Plugin';
import { readS2ParameterForm } from './sceneS2ParameterForm';
import { sceneInteractionPacks } from './sceneInteractionPacks';

const names: Record<string, [string, string]> = {
  'local-material/read-text': ['读取你选择的资料', '只读取本局明确提供的文本文件；选择资料不会自动运行。'],
  'local-material/read-image': ['使用你选择的图片', '把本局明确选择的原图交给后续步骤，不识字、改图或自动发送。'],
  'project-notes/read-text': ['读取你允许的笔记', '只读取本局允许的项目知识笔记当前版本；更新或移除后需重新选择。'],
  'structured-data/parse-json': ['读取结构化内容', '检查并读取填写的 JSON 内容，供后续处理。'],
  'structured-data/select': ['提取指定内容', '从完整数据中选取需要的部分。'],
  'structured-data/stringify': ['转为文本', '将结构化内容转成完整文本。'],
  'structured-data/to-table': ['整理为表格', '将记录整理为表格，保留空值和缺失值的区别。'],
  'structured-data/table-to-json': ['提取表格记录', '将表格转换为可继续处理的记录。'],
  'structured-view/table': ['展示表格', '查看数据或切换图表，不额外调用模型。'],
  'structured-view/json-tree': ['展开查看内容', '按层级查看完整数据。'],
  'structured-view/text': ['展示返回原文', '原样展示前一步返回的完整文字，不判断内容好坏，也不调用助手。'],
  'json-check/validate': ['检查 JSON 格式', '只检查格式，不证明内容符合业务目标。'],
  'human-input/text': ['填写回答', '运行到这里会等待你填写文本。'],
  'human-input/json': ['填写结构化回答', '运行到这里会等待你补充材料，提交后再继续处理。'],
  'human-input/confirm': ['由你确认', '运行到这里会等待你的真实选择，Agent 不能代替你确认。'],
  'workflow-simulation/step': ['模拟一个步骤', '记录预设示例和假设，不是真实业务执行。'],
  'workflow-simulation/inspect': ['查看模拟过程', '查看示例轨迹，不证明真实业务已执行。'],
  'workflow-merge/merge-json': ['汇合数据分支', '只转交唯一命中的分支，冲突时停止。'],
  'workflow-merge/merge-assessment': ['汇合检查分支', '只转交唯一命中的检查结果。'],
  'workflow-merge/merge-simulation': ['汇合模拟分支', '只转交唯一命中的模拟结果，仍不是业务事实。'],
};
const portNames: Record<string, string> = { value: '内容',
  text: '文本内容', resource: '你选择的资料', image: '待处理图片', prompt: '提示内容', input: '输入材料', context: '参考材料', simulation: '模拟材料',
  decision: '你的选择', table: '表格内容', pointer: '提取位置', purpose: '步骤目的', assumptions: '模拟假设', sample: '预设示例',
  previous: '前一步结果', result: '处理结果', assessment: '检查结果', candidates: '待汇合的结果', selected: '选中的结果' };
type PresentationRef = Pick<S2WorkflowNode, 'presentation'> & Partial<Pick<S2WorkflowNode, 'pluginId' | 'pluginVersion' | 'capabilityId'>>;
/** Legacy display-only references may omit a version. Use package metadata only for an unambiguous loaded release. */
function packageHelp(node: PresentationRef) {
  if (!node.pluginId || !node.capabilityId) return undefined;
  let version = node.pluginVersion;
  if (!version) {
    const versions = new Set(sceneInteractionPacks.catalog().filter(pack => sceneInteractionPacks.isAvailable(pack)).flatMap(manifest => {
      const pack = sceneInteractionPacks.resolve({ id: manifest.id, version: manifest.version });
      return pack.capabilities.filter(plugin => plugin.id === node.pluginId && plugin.capabilities.some(cap => cap.id === node.capabilityId)).map(plugin => plugin.version);
    }));
    if (versions.size !== 1) return undefined;
    version = [...versions][0];
  }
  return sceneInteractionPacks.capabilityHelp({ pluginId: node.pluginId, pluginVersion: version, capabilityId: node.capabilityId });
}
export function s2NodeTitle(node: Pick<S2WorkflowNode, 'pluginId' | 'capabilityId' | 'presentation'> & Partial<Pick<S2WorkflowNode, 'pluginVersion'>>): string {
  return node.presentation?.label ?? packageHelp(node)?.title ?? names[`${node.pluginId}/${node.capabilityId}`]?.[0] ?? '处理步骤';
}
export function s2NodeDescription(node: Pick<S2WorkflowNode, 'pluginId' | 'capabilityId' | 'presentation'> & Partial<Pick<S2WorkflowNode, 'pluginVersion'>>): string {
  return node.presentation?.description ?? packageHelp(node)?.description ?? names[`${node.pluginId}/${node.capabilityId}`]?.[1] ?? '接收材料并产生供下一步使用的结果。';
}
export function s2PortLabel(node: PresentationRef, port: S2PluginPort, direction: 'inputs' | 'outputs'): string {
  const labels = packageHelp(node)?.[direction === 'inputs' ? 'inputLabels' : 'outputLabels'];
  return node.presentation?.[direction]?.[port.id] ?? labels?.[port.id] ?? portNames[port.id] ?? (/[\u3400-\u9fff]/.test(port.label) ? port.label : direction === 'inputs' ? '输入材料' : '输出结果');
}
export const s2StatusLabel = (status: string): string => ({ idle: '未运行', pending: '等待前置步骤', queued: '等待运行', running: '正在运行', waiting: '等待你的操作',
  succeeded: '已完成', displayed: '已展示', cached: '复用已有结果', skipped: '未命中条件，已跳过', blocked: '前置条件未满足', failed: '未完成，请检查',
  cancelled: '已取消', stale: '内容已变化，结果过期' } as Record<string, string>)[status] ?? '状态待确认';

/** The reviewed builtin contract, never a display alias, a JSON key or a runtime-value guess.
 * Canvas composites retain their actual internal execution endpoints, so ownership does not change meaning.
 */
export function s2IsHumanConfirmationOutput(node: Pick<S2WorkflowNode, 'pluginId' | 'pluginVersion' | 'capabilityId'> | undefined, portId: string): boolean {
  return node?.pluginId === 'human-input' && node.pluginVersion === '1.0.0' && node.capabilityId === 'confirm' && portId === 'decision';
}
/** Call only after the source contract is established. This describes a predicate, not a user's actual answer. */
export function s2HumanConfirmationOutcome(when: Pick<S2WorkflowCondition, 'pointer' | 'equals' | 'match'>): '同意' | '不同意' | undefined {
  if (when.pointer !== '/approved' || typeof when.equals !== 'boolean' || typeof when.match !== 'boolean') return undefined;
  return when.equals === when.match ? '同意' : '不同意';
}

/** Display declarations only alias existing endpoints; they cannot add handlers or permissions. */
export function readS2NodePresentation(raw: unknown, capability: S2PluginCapability, node?: Pick<S2PluginNode, 'pluginId' | 'pluginVersion' | 'capabilityId'>): S2NodePresentation {
  const object = (value: unknown, allowed: string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('节点显示配置必须是普通对象');
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== 'string' || !allowed.includes(key) || !descriptor.enumerable || !('value' in descriptor)) throw new Error('节点显示配置包含未知字段或端口');
    }
    return value as Record<string, unknown>;
  };
  const text = (value: unknown, max: number): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('节点显示名称或说明为空或过长');
    return value;
  };
  const value = object(raw, ['label', 'description', 'inputs', 'outputs', 'inputForms', 'responseForm']);
  const result: S2NodePresentation = { label: text(value.label, 80) };
  if (value.description !== undefined) result.description = text(value.description, 240);
  for (const direction of ['inputs', 'outputs'] as const) if (value[direction] !== undefined) {
    const labels = object(value[direction], capability[direction].map(port => port.id));
    result[direction] = Object.fromEntries(Object.entries(labels).map(([key, label]) => [key, text(label, 80)]));
  }
  if (value.inputForms !== undefined) {
    const forms = object(value.inputForms, capability.inputs.filter(port => port.type.id === 'structured-data.value' && port.type.version === 1).map(port => port.id));
    result.inputForms = Object.fromEntries(Object.entries(forms).map(([id, form]) => [id, readS2ParameterForm(form, id)]));
  }
  if (value.responseForm !== undefined) {
    const output = capability.outputs.find(port => port.id === 'value');
    if (node?.pluginId !== 'human-input' || node.pluginVersion !== '1.0.0' || node.capabilityId !== 'json'
      || capability.id !== 'json' || capability.kind !== 'human' || !output?.required || output.multiple
      || output.type.id !== 'structured-data.value' || output.type.version !== 1) {
      throw new Error('回答表单仅支持 human-input@1.0.0/json 的真实单值 value 输出');
    }
    result.responseForm = readS2ParameterForm(value.responseForm, 'value');
  }
  return result;
}

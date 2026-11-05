import type { SceneCapabilityPlan, SceneCapabilityId, ScenePromptModuleId } from '../../types';
import { SCENE_CAPABILITY_DEFINITIONS, SCENE_PROMPT_MODULE_DEFINITIONS } from './sceneCapabilityRegistry';
import { SceneUnderstandingError } from './sceneUnderstanding';
import { sceneCapabilityExecutionContract, sceneModuleExecutionContract } from './sceneExecutionRegistry';
import { SCENE_TOOL_EXECUTION_CONTRACTS } from './sceneToolExecution';

const TOOLS = [
  { id: 'knowledge-notes', module: 'resource-grounding', purpose: '按问题读取已授权的知识笔记参考，不自动验证事实' },
  { id: 'documents', module: 'resource-grounding', purpose: '检索已授权文档正文' },
  { id: 'document-arguments', module: 'resource-grounding', purpose: '读取文档已经保存的论证结构' },
  { id: 'argument-chain', module: 'personal-cognition-grounding', purpose: '读取用户保存的个人观点；不是事实证据' },
  { id: 'learner-profile', module: 'profile-personalization', purpose: '调整表达、难度与追问；不证明掌握' },
  { id: 'model-experiment', module: 'model-experiment', purpose: '独立运行已提交提示词与输入，记录真实请求/原始返回，隔离逐条评估；最多6次实验，每次至多2次模型调用；不运行代码、不附加笔记、不允许指定外部地址或密钥' },
] as const;

export function buildSceneAbilityCatalog(surface: 'S1' | 'S4'): string {
  return JSON.stringify({
    interactions: SCENE_CAPABILITY_DEFINITIONS.filter(item => item.sceneSkills.includes(surface)).map(({ id, purpose, category }) => ({ id, purpose, category, execution: sceneCapabilityExecutionContract(id) })),
    tools: surface === 'S1' ? TOOLS.map(item => ({ ...item, id: `tool:${item.id}`, execution: SCENE_TOOL_EXECUTION_CONTRACTS[item.id] })) : [],
    modules: SCENE_PROMPT_MODULE_DEFINITIONS.filter(item => item.sceneSkills.includes(surface)).map(item => ({ id: `module:${item.id}`, purpose: item.purpose, execution: sceneModuleExecutionContract(item.id) })),
    checks: surface === 'S1' ? [{ id: 'check:json-structure', module: 'model-experiment', purpose: '检查实际实验输出是否为合法JSON；未要求JSON则不强制转换' }] : [],
    state: surface === 'S1' ? [{ id: 'state:experiment-history', module: 'model-experiment', purpose: '记录本局实际实验版本、参数、原始输出与评估；比较时区分参数/输入变化' }] : [],
    composition: { policy: '注册契约是系统事实，不是Agent可修改的权限；已授权组件是上限，不是每轮必用清单。',
      taskSlot: '仅一个待答控件；完成后可换用任一授权组件，提示/讲解/要求调整不自动换题。',
      formHandoff: '表单与非text题可共存；原题未完成时表单可见但禁用、草稿保留。完成或用户明确授权的取消/替换后再提交，不能自动取消原题以调用工具。',
      validationScope: '本地组合检查只验证依赖、协议及状态交接；不等于真实工具联调、模型语义或界面端到端验收。' },
    unavailable: ['任意代码执行', '安装新插件', '文本/多行/选择之外的自定义表单控件', '自行访问新服务地址'],
  });
}
export class SceneCapabilityGapError extends Error {
  constructor(readonly missing: SceneCapabilityPlan['missing']) {
    super('系统能力不足，未执行场景：' + missing.map(item => item.goal + '（' + item.reason + '）').join('；'));
    this.name = 'SceneCapabilityGapError';
  }
}
function text(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 500) throw new SceneUnderstandingError('能力需求说明无效。', 'invalid-capability-plan');
  return raw.trim();
}
export function readSceneCapabilityPlan(raw: unknown, surface: 'S1' | 'S4', capabilities: SceneCapabilityId[], modules: ScenePromptModuleId[]): SceneCapabilityPlan {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SceneUnderstandingError('缺少目标到能力的映射计划。', 'missing-capability-plan');
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.needs) || !value.needs.length || value.needs.length > 16 || !Array.isArray(value.missing) || value.missing.length > 8) {
    throw new SceneUnderstandingError('能力计划必须包含 needs 和 missing。', 'invalid-capability-plan');
  }
  const available = new Set<string>([...capabilities, ...modules.map(id => `module:${id}`)]);
  if (surface === 'S1') for (const tool of TOOLS) if (modules.includes(tool.module)) available.add(`tool:${tool.id}`);
  if (surface === 'S1' && modules.includes('model-experiment')) {
    available.add('check:json-structure'); available.add('state:experiment-history');
  }
  const missing = value.missing.map(rawItem => {
    const item = rawItem as Record<string, unknown>;
    return { goal: text(item?.goal), reason: text(item?.reason) };
  });
  const needs = value.needs.map(rawItem => {
    const item = rawItem as Record<string, unknown>;
    if (!Array.isArray(item?.capabilityIds) || item.capabilityIds.length > 12 || (!item.capabilityIds.length && !missing.length)
      || item.capabilityIds.some(id => typeof id !== 'string' || !available.has(id))) {
      throw new SceneUnderstandingError('目标映射引用了未安装、未装配或越界的能力。', 'unavailable-capability');
    }
    return { id: text(item.id), goal: text(item.goal), capabilityIds: [...new Set(item.capabilityIds)] as string[] };
  });
  if (new Set(needs.map(item => item.id)).size !== needs.length) throw new SceneUnderstandingError('能力需求ID重复。', 'invalid-capability-plan');
  if (modules.includes('model-experiment') && !needs.some(item => item.capabilityIds.includes('tool:model-experiment'))) {
    throw new SceneUnderstandingError('启用模型实验必须指出它服务的实际目标。', 'unjustified-experiment');
  }
  if (modules.includes('input-form') && (!capabilities.includes('text') || !needs.some(item => item.capabilityIds.includes('module:input-form')))) {
    throw new SceneUnderstandingError('input-form只能放在requestedPromptModules；requestedCapabilities必须包含text，capabilityPlan.needs至少一个实际表单需求的capabilityIds必须包含module:input-form。保留用户目标，仅修复此映射。', 'unjustified-input-form');
  }
  return { needs, missing };
}

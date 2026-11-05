import type { SceneCapabilityId, ScenePromptModuleId, SceneRuntimeContract } from '../../types';

export interface SceneExecutionContract {
  input: string;
  output: string;
  requiresCapabilities: readonly SceneCapabilityId[];
  requiresModules: readonly ScenePromptModuleId[];
  uiSlots: readonly ('answer' | 'form' | 'material' | 'canvas' | 'helper')[];
  stateWrites: readonly string[];
  handoff: string;
}

const task = (input: string, output: string): SceneExecutionContract => ({
  input, output, requiresCapabilities: [], requiresModules: ['structured-interaction'],
  uiSlots: ['answer'], stateWrites: ['validated-response', 'local-task-preparation'],
  handoff: '每次仅一个待答控件。交流保留原题；完成后可选择其他已授权组件；替换/取消须有最新用户交流支持的taskUpdate。不能为调用工具自动退役原题。',
});
const canvas = (input: string, output: string, requiresCapabilities: SceneCapabilityId[] = []): SceneExecutionContract => ({
  input, output, requiresCapabilities, requiresModules: [], uiSlots: ['canvas'], stateWrites: ['validated-graph'],
  handoff: '仅在S4画布的已验证前提图和节点提交生命周期内执行；不得挪作S1对话控件。',
});
const passive = (input: string, output: string): SceneExecutionContract => ({
  input, output, requiresCapabilities: [], requiresModules: [], uiSlots: [], stateWrites: [],
  handoff: '按本轮语义需要使用，不独占作答入口，不修改待答任务或扩大权限。',
});

/** Host-owned execution facts, not fields that a model can rewrite into new authority. */
export const SCENE_CAPABILITY_EXECUTION_CONTRACTS = {
  text: { ...task('公开text指令，可选长度约束', '引用interactionId的text响应'), requiresModules: [] },
  'single-choice': task('公开单选指令及稳定选项id；objective需另有私有答案键', '引用interactionId及selectedId的已验证响应'),
  'multiple-choice': task('公开多选指令、稳定选项id、选择数量约束；objective需私有答案键', '引用interactionId及selectedIds的已验证响应'),
  ordering: task('公开排序项目稳定id；objective需私有correctOrderIds', '完整覆盖项目id的orderedIds响应'),
  'fill-blanks': task('公开blanks稳定id与必填约束', '按blank.id映射文本的values响应'),
  'question-set': task('至少2项的公开题组；子型须在实际allowedQuestionItemTypes内；私有答案另存', '一次提交全部必答子项的answers响应及本地评分'),
  'true-false': { ...task('题组内公开判断子项', '引用itemId的boolean响应'), uiSlots: [] },
  'markdown-content': { ...passive('已清洗展示文本及受限引用', '只读富文本'), uiSlots: ['material'] },
  'given-node': { ...canvas('冻结初始前提包', '只读已知条件节点'), stateWrites: [] },
  'assumption-node': canvas('用户假设及入边前提', '已验证假设节点', ['mathlive-editor', 'derivation-edge', 'step-submit']),
  'formula-node': canvas('用户LaTeX步骤及入边前提', '已验证公式节点', ['mathlive-editor', 'derivation-edge', 'step-submit']),
  'conclusion-node': canvas('用户最终结论及入边前提', '已验证结论节点', ['mathlive-editor', 'derivation-edge', 'step-submit']),
  'derivation-edge': canvas('已有节点id的引用关系', '无自环/重复/循环的前提边'),
  'mathlive-editor': { ...canvas('用户LaTeX输入', '待提交公式文本'), stateWrites: ['local-formula-draft'] },
  'step-submit': canvas('待提交节点及已授权前提', '分析结果及完成判定', ['premise-validation']),
  'premise-validation': { ...canvas('节点、入边与冻结前提', '前提链判定'), stateWrites: [] },
  'compute-help': { ...canvas('当前支路及用户求助', '分层提示和可选待插入公式', ['formula-node', 'mathlive-editor']), uiSlots: ['helper'], stateWrites: ['help-budget'] },
} satisfies Record<SceneCapabilityId, SceneExecutionContract>;

export const SCENE_MODULE_EXECUTION_CONTRACTS = {
  'input-form': {
    input: '1–8个声明式字段的inputForm；提交前按本地schema完整校验', output: '已授权text通道中的formSubmission，不能冒充选择题答案',
    requiresCapabilities: ['text'], requiresModules: [], uiSlots: ['form'], stateWrites: ['local-form-draft', 'validated-form-submission'],
    handoff: '表单和非text待答控件可共存；原题优先，表单保持可见但禁用并保留草稿。用户作答完成或明确取消/替换解除占用后才可提交表单；不能偷偷换题、取消或丢失草稿。',
  },
  'model-experiment': { ...passive('已提交的提示词/测试输入、显式experimentPolicy和工具权限', '独立模型实际原始输出及逐条评审记录'),
    stateWrites: ['experiment-receipt', 'experiment-budget'], handoff: '不独占作答入口；仅Agent明确选择且有提交来源时执行。已完成实验凭据复用，不因UI重试重复付费。' },
  'role-context': passive('已选角色卡与身份', '可选角色语境'),
  'scenario-framing': passive('已选背景、开场与已发生事实', '可选情境材料'),
  'resource-grounding': passive('授权资源范围及本轮信息缺口', '带来源的参考材料；不是自动核实的事实'),
  'personal-cognition-grounding': passive('明确授权的用户论证范围及本轮信息缺口', '个人观点/支持反对关系；不是事实或本局掌握证据'),
  'structured-interaction': passive('已装配控件与运行协议', '受本地schema及任务状态校验的interaction/taskUpdate'),
  'deterministic-assessment': { ...passive('公开question-set和独立私有答案', '本地确定性评分记录'), requiresCapabilities: ['question-set'], stateWrites: ['local-assessment'] },
  'adaptive-progression': passive('本局作答、追问与学习证据', '可调整教学策略；不强制答后立即出题'),
  'turn-agent-planning': passive('最新用户表达、运行事实及受保护上下文', '本轮动作/组件/工具建议，仍需执行器校验'),
  'metric-state': { ...passive('已选指标与已验证本轮事件', '受限指标变更'), stateWrites: ['validated-metrics'] },
  'event-system': { ...passive('已装配事件和触发条件', '已验证触发记录'), stateWrites: ['validated-events'] },
  'profile-personalization': passive('已授权画像及可信门槛', '表达/难度参考；不是本局理解证明'),
} satisfies Record<ScenePromptModuleId, SceneExecutionContract>;

export interface SceneExecutionDependencyIssue { owner: string; dependency: string; message: string }

/** Report missing dependencies, never auto-install, enable modules or broaden the scene's permissions. */
export function validateSceneExecutionCombination(capabilities: readonly SceneCapabilityId[], modules: readonly ScenePromptModuleId[],
  installed: readonly SceneCapabilityId[]): SceneExecutionDependencyIssue[] {
  const selected = new Set(capabilities), enabledModules = new Set(modules), available = new Set(installed);
  const issues: SceneExecutionDependencyIssue[] = [];
  const entries = [...capabilities.map(id => [id, SCENE_CAPABILITY_EXECUTION_CONTRACTS[id]] as const),
    ...modules.map(id => [`module:${id}`, SCENE_MODULE_EXECUTION_CONTRACTS[id]] as const)];
  for (const [owner, contract] of entries) {
    for (const dependency of contract.requiresCapabilities) if (!selected.has(dependency) || !available.has(dependency)) {
      issues.push({ owner, dependency, message: `${owner} 需要已装配且可执行的 ${dependency}；请在原授权范围内修复组合，不能自动扩大权限。` });
    }
    for (const dependency of contract.requiresModules) if (!enabledModules.has(dependency)) {
      issues.push({ owner, dependency: `module:${dependency}`, message: `${owner} 缺少执行协议模块 ${dependency}。` });
    }
  }
  return issues;
}

/** Explicit flow graphs only. Cycles are valid; unreachable custom stages are not. */
export function unreachableSceneStages(contract: Pick<SceneRuntimeContract, 'stages' | 'initialStageId'>): string[] {
  const byId = new Map((contract.stages || []).map(stage => [stage.id, stage]));
  const visited = new Set<string>(), queue = contract.initialStageId ? [contract.initialStageId] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const next of byId.get(id)?.allowedNext || []) if (!visited.has(next)) queue.push(next);
  }
  return [...byId.keys()].filter(id => !visited.has(id));
}

export function sceneCapabilityExecutionContract(id: SceneCapabilityId): SceneExecutionContract {
  return SCENE_CAPABILITY_EXECUTION_CONTRACTS[id];
}
export function sceneModuleExecutionContract(id: ScenePromptModuleId): SceneExecutionContract {
  return SCENE_MODULE_EXECUTION_CONTRACTS[id];
}

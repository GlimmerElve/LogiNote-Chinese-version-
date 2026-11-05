import assert from 'node:assert/strict';
import './check-scene-build-agent';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SceneRichMessage } from '../src/components/scene/SceneRichMessage';
import { SceneInteractionInput } from '../src/components/scene/SceneInteractionInput';
import { normalizeNoteSearchResults } from '../src/services/ragService';
import { selectIncludedRagSources } from '../src/services/memory/memoryContextBuilder';
import { applySceneAssemblyPlan, buildTopicSection, parseSceneSpec } from '../src/services/scene/sceneGenerator';
import { buildGeneralTurnPrompt, buildGeneralTurnSystemPrompt, extractPartialGeneralTurnContent, parseGeneralTurnResponse } from '../src/services/scene/sceneDirector';
import {
  availableSceneTurnContextSources,
  normalizeSceneTurnPlan,
  renderSceneTurnPlan,
} from '../src/services/scene/sceneTurnAgent';
import { splitGeneralTurnReply } from '../src/services/scene/sceneSignal';
import {
  buildBehaviorPromptSection,
  parseBehaviorSpec,
  resolveSceneParadigm,
} from '../src/services/scene/sceneParadigm';
import {
  SCENE_INTERACTION_TYPES,
  formatSceneInteractionResponseContent,
  formatQuestionSetGradeFeedback,
  gradeQuestionSetResponse,
  normalizeSceneInteractionDirective,
  normalizeQuestionSetEvaluation,
  normalizeSceneInteractionProtocol,
  normalizeSceneInteractionResponse,
  resolveSceneRuntimeInteractionProtocol,
} from '../src/services/scene/sceneInteraction';
import {
  prepareSceneCitationMarkdown,
  prepareSceneMarkdown,
  readSceneCitationHref,
  readSceneMathToken,
} from '../src/services/scene/sceneRichText';
import {
  normalizeSceneInteractionAuditFile,
  summarizeSceneInteractionAudit,
} from '../src/services/scene/sceneInteractionAudit';
import {
  SCENE_COMPONENT_DEFINITIONS,
  SCENE_RECIPE_DEFINITIONS,
  buildSceneComponentCapabilityPrompt,
  normalizeSceneRecipeId,
} from '../src/services/scene/sceneComponentRegistry';
import {
  buildUnifiedSceneCapabilityPrompt,
  buildUnifiedSceneRecipePrompt,
  getUnifiedSceneRecipe,
  isSceneRecipeCompatible,
  listSceneCapabilities,
  sceneSurfaceForSkill,
} from '../src/services/scene/sceneCapabilityRegistry';
import { preflightSceneSpec, resolveSceneAssembly } from '../src/services/scene/sceneAssembly';
import {
  buildSceneInteractionComponentV2Prompt,
  getSceneInteractionComponentV2,
  listSceneInteractionComponentsV2,
  validateSceneInteractionComponentV2Registry,
} from '../src/services/scene/sceneInteractionComponentV2';
import {
  normalizeSceneInteractionDirectiveV2,
  normalizeSceneInteractionResponseV2,
} from '../src/services/scene/sceneInteractionV2Adapter';
import {
  normalizeSceneAssemblyAuditFile,
  summarizeSceneAssemblyAudit,
} from '../src/services/scene/sceneAssemblyAudit';
import { SCENE_GENERAL_TURN_PROMPT, SCENE_TURN_PLAN_PROMPT } from '../src/workflows/sceneGeneralPrompt';
import { SCENE_ADAPT_PROMPT, SCENE_GENERATE_PROMPT } from '../src/workflows/scenePrompt';
import {
  SCENE_COMPUTE_CONFIG_PROMPT,
  SCENE_COMPUTE_GENERATE_PROMPT,
} from '../src/workflows/sceneComputePrompt';

const behavior = parseBehaviorSpec({
  recipeId: 'guided-practice',
  kind: '自适应答题',
  aiBehavior: '每轮只出一道题，并反馈上一题。',
  userAction: '回答当前题目并说明理由。',
  evaluationRule: '按答案和理由是否正确评价。',
  progressionRule: '答对提高难度，答错降低难度。',
  outputFormats: ['markdown', 'latex', 'unknown', 'latex'],
});
assert.ok(behavior);
assert.equal(behavior.recipeId, 'guided-practice');
assert.deepEqual(behavior.outputFormats, ['markdown', 'latex']);
assert.deepEqual(behavior.interaction?.allowedTypes, ['text'], '旧 behavior 必须安全升级为仅文本协议');
assert.equal(parseBehaviorSpec({ kind: '缺字段' }), undefined);
assert.equal(resolveSceneParadigm({ compute: {} as never, behavior }), 'compute');
assert.equal(resolveSceneParadigm({ behavior }), 'general');
assert.equal(resolveSceneParadigm({}), 'dialogue');
assert.match(buildBehaviorPromptSection({ behavior }), /自适应答题/);
assert.match(buildBehaviorPromptSection({ behavior }), /公式使用/);
assert.match(buildBehaviorPromptSection({ behavior }), /可用交互能力】text/);
assert.match(buildBehaviorPromptSection({ behavior }), /guided-practice/);
assert.equal(normalizeSceneRecipeId('batch-assessment'), 'batch-assessment');
assert.equal(normalizeSceneRecipeId('made-up'), undefined);
assert.ok(SCENE_RECIPE_DEFINITIONS.some((recipe) => recipe.id === 'batch-assessment' && recipe.execution === 'batch'));
assert.ok(SCENE_COMPONENT_DEFINITIONS.some((component) => component.type === 'question-set' && component.category === 'composite'));
assert.match(buildSceneComponentCapabilityPrompt(), /question-set/);
assert.deepEqual(validateSceneInteractionComponentV2Registry(), []);
assert.equal(getSceneInteractionComponentV2('true-false', 'top-level'), undefined, '判断题目前只能作为题组子项');
assert.equal(getSceneInteractionComponentV2('true-false', 'question-set-item')?.protocolVersion, '2.0');
assert.deepEqual(
  listSceneInteractionComponentsV2('top-level').map((component) => component.capabilityId),
  SCENE_INTERACTION_TYPES,
  '运行时能力列表必须由 V2 注册表产生',
);
assert.match(buildSceneInteractionComponentV2Prompt(), /禁止放入正确答案/);
assert.equal(getSceneInteractionComponentV2('question-set')?.evaluation.answerVisibility, 'not-in-directive');
assert.equal(sceneSurfaceForSkill('S1'), 'turn');
assert.equal(sceneSurfaceForSkill('S4'), 'canvas');
assert.equal(isSceneRecipeCompatible('guided-practice', 'S1'), true);
assert.equal(isSceneRecipeCompatible('guided-practice', 'S4'), false);
assert.equal(isSceneRecipeCompatible('guided-derivation', 'S4'), true);
assert.equal(getUnifiedSceneRecipe('guided-derivation')?.execution, 'graph-workflow');
assert.ok(listSceneCapabilities({ surface: 'canvas' }).some((capability) => capability.id === 'formula-node'));
assert.ok(listSceneCapabilities({ surface: 'canvas' }).some((capability) => capability.id === 'premise-validation'));
assert.equal(listSceneCapabilities({ surface: 'canvas' }).some((capability) => capability.id === 'question-set'), false);
assert.ok(listSceneCapabilities({ surface: 'shared' }).some((capability) => capability.id === 'markdown-content'));
assert.match(buildUnifiedSceneCapabilityPrompt('canvas'), /derivation-edge/);
assert.match(buildUnifiedSceneRecipePrompt('canvas'), /guided-derivation/);
const batchAssembly = resolveSceneAssembly({ sceneSkill: 'S1', recipeId: 'batch-assessment' });
assert.equal(batchAssembly.valid, true);
assert.equal(batchAssembly.enabledCapabilities.includes('question-set'), true);
assert.deepEqual(batchAssembly.enabledPromptModules, ['structured-interaction', 'deterministic-assessment', 'resource-grounding']);
const explicitPracticeAssembly = resolveSceneAssembly({
  sceneSkill: 'S1', recipeId: 'guided-practice', requestedCapabilities: ['single-choice'],
  requestedPromptModules: ['structured-interaction'],
});
assert.deepEqual(explicitPracticeAssembly.enabledCapabilities, ['single-choice'], '显式装配后不得自动打开其它组件或强加文本作答');
assert.deepEqual(
  explicitPracticeAssembly.enabledPromptModules,
  ['turn-agent-planning', 'structured-interaction'],
  'turn-by-turn 场景必须保留运行期互动 Agent，其余提示词仍按白名单装配',
);
assert.equal(resolveSceneAssembly(
  { sceneSkill: 'S1', recipeId: 'batch-assessment' },
  ['text', 'single-choice'],
).valid, false, '缺少配方必需组件时不得装配成功');
assert.equal(resolveSceneAssembly({
  sceneSkill: 'S1', recipeId: 'guided-practice', requestedCapabilities: ['formula-node'],
}).valid, false, 'turn 场景不得请求 canvas 能力');
assert.equal(resolveSceneAssembly({
  sceneSkill: 'S4', recipeId: 'guided-practice',
}).valid, false, '配方与运行面不一致时不得装配成功');
assert.match(buildTopicSection({
  subject: '方程求解', knowledgePoints: ['一元二次方程'], sceneSkill: 'S4', recipeId: 'guided-derivation',
}), /引导式数理推导/);
assert.throws(() => buildTopicSection({
  subject: '错误配方', knowledgePoints: [], sceneSkill: 'S4', recipeId: 'guided-practice',
}), /不适用于 S4/);

const declaredProtocol = normalizeSceneInteractionProtocol({
  version: '9.9',
  allowedTypes: ['single-choice', 'ordering', 'unknown'],
  defaultType: 'ordering',
  allowTextFallback: false,
}, SCENE_INTERACTION_TYPES);
assert.equal(declaredProtocol.version, '1.0');
assert.deepEqual(declaredProtocol.allowedTypes, ['single-choice', 'ordering']);
assert.equal(declaredProtocol.defaultType, 'ordering');

const runtimeProtocol = resolveSceneRuntimeInteractionProtocol(declaredProtocol);
assert.deepEqual(runtimeProtocol.allowedTypes, ['single-choice', 'ordering'], '运行时只保留当前已安装的声明能力');
assert.equal(runtimeProtocol.allowTextFallback, false);
const unsupportedProtocol = resolveSceneRuntimeInteractionProtocol({
  version: '1.0',
  allowedTypes: ['unknown'],
  defaultType: 'unknown',
  allowTextFallback: false,
} as never);
assert.deepEqual(unsupportedProtocol.allowedTypes, ['text'], '完全不支持的场景必须安全降级为文本');
assert.equal(unsupportedProtocol.allowTextFallback, true);

const choiceDirective = normalizeSceneInteractionDirective({
  id: 'turn-1',
  type: 'single-choice',
  instruction: '选择最佳答案',
  required: true,
  options: [
    { id: 'a', label: '选项 A' },
    { id: 'b', label: '选项 B' },
    { id: 'b', label: '重复项应被丢弃' },
  ],
  allowExplanation: true,
}, declaredProtocol);
assert.ok(choiceDirective && choiceDirective.type === 'single-choice');
assert.deepEqual(
  normalizeSceneInteractionDirectiveV2({
    id: 'turn-v2', type: 'single-choice', required: true,
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
  }, declaredProtocol)?.type,
  'single-choice',
);
assert.equal(normalizeSceneInteractionDirectiveV2({
  id: 'invalid-top-level', type: 'true-false', required: true,
}, declaredProtocol), undefined, 'V2 适配器必须拒绝未注册为顶层的组件');
assert.equal(choiceDirective.options.length, 2);
const choiceResponse = normalizeSceneInteractionResponse({
  interactionId: 'turn-1',
  type: 'single-choice',
  selectedId: 'b',
  explanation: '理由',
  submittedAt: '',
}, choiceDirective);
assert.equal(choiceResponse?.type, 'single-choice');
assert.equal(normalizeSceneInteractionResponseV2({
  interactionId: 'turn-1', type: 'single-choice', selectedId: 'a',
}, choiceDirective)?.type, 'single-choice');
assert.match(formatSceneInteractionResponseContent(choiceResponse!, choiceDirective), /选项 B/);
assert.equal(normalizeSceneInteractionResponse({
  interactionId: 'turn-1',
  type: 'single-choice',
  selectedId: 'forged-option',
}, choiceDirective), undefined, '响应不能提交指令中不存在的选项');

const orderingDirective = normalizeSceneInteractionDirective({
  id: 'turn-2',
  type: 'ordering',
  required: true,
  items: [{ id: '1', content: '第一步' }, { id: '2', content: '第二步' }],
}, declaredProtocol);
assert.ok(orderingDirective && orderingDirective.type === 'ordering');
assert.equal(normalizeSceneInteractionResponse({
  interactionId: 'turn-2',
  type: 'ordering',
  orderedIds: ['1'],
}, orderingDirective), undefined, '排序响应必须完整覆盖所有项目');

const fullProtocol = normalizeSceneInteractionProtocol({
  version: '1.0',
  allowedTypes: ['text', 'single-choice', 'multiple-choice', 'ordering', 'fill-blanks', 'question-set'],
  defaultType: 'text',
  allowTextFallback: true,
});
const validOrderingDirective = normalizeSceneInteractionDirective({
  id: 'turn-ordering',
  type: 'ordering',
  required: true,
  items: [{ id: 's2', content: '第二步' }, { id: 's1', content: '第一步' }],
  allowExplanation: true,
}, fullProtocol);
assert.ok(validOrderingDirective?.type === 'ordering');
const validOrderingResponse = normalizeSceneInteractionResponse({
  interactionId: 'turn-ordering',
  type: 'ordering',
  orderedIds: ['s1', 's2'],
}, validOrderingDirective);
assert.equal(validOrderingResponse?.type, 'ordering');
assert.match(formatSceneInteractionResponseContent(validOrderingResponse!, validOrderingDirective), /1\. 第一步/);

const fillDirective = normalizeSceneInteractionDirective({
  id: 'turn-fill',
  type: 'fill-blanks',
  required: true,
  blanks: [{ id: 'b1', label: '概念' }, { id: 'b2', label: '例子', placeholder: '写一个例子' }],
}, fullProtocol);
assert.ok(fillDirective?.type === 'fill-blanks');
assert.equal(normalizeSceneInteractionResponse({
  interactionId: 'turn-fill',
  type: 'fill-blanks',
  values: { b1: '函数', b2: '' },
}, fillDirective), undefined, '必填空位不得遗漏');
const fillResponse = normalizeSceneInteractionResponse({
  interactionId: 'turn-fill',
  type: 'fill-blanks',
  values: { b1: '函数', b2: 'y=x' },
}, fillDirective);
assert.equal(fillResponse?.type, 'fill-blanks');
assert.match(formatSceneInteractionResponseContent(fillResponse!, fillDirective), /概念：函数/);

const questionSetDirective = normalizeSceneInteractionDirective({
  id: 'exam-1',
  type: 'question-set',
  title: '综合测评',
  description: '三题一次提交',
  required: true,
  submissionMode: 'batch',
  feedbackMode: 'after-submit',
  items: [
    { id: 'q1', type: 'single-choice', content: '2 + 2 等于？', required: true, options: [{ id: 'a', label: '3' }, { id: 'b', label: '4' }] },
    { id: 'q2', type: 'multiple-choice', content: '选择偶数', required: true, options: [{ id: 'a', label: '2' }, { id: 'b', label: '3' }, { id: 'c', label: '4' }], minSelections: 2, maxSelections: 2 },
    { id: 'q3', type: 'true-false', content: '0 是偶数。', required: true },
  ],
}, fullProtocol);
assert.ok(questionSetDirective?.type === 'question-set');
assert.equal(questionSetDirective.items.length, 3);
const questionSetResponse = normalizeSceneInteractionResponse({
  interactionId: 'exam-1',
  type: 'question-set',
  answers: [
    { itemId: 'q1', type: 'single-choice', selectedId: 'b' },
    { itemId: 'q2', type: 'multiple-choice', selectedIds: ['a', 'c'] },
    { itemId: 'q3', type: 'true-false', value: true },
  ],
}, questionSetDirective);
assert.equal(questionSetResponse?.type, 'question-set');
assert.match(formatSceneInteractionResponseContent(questionSetResponse!, questionSetDirective), /整卷作答（3 题）/);
const questionSetEvaluation = normalizeQuestionSetEvaluation({
  interactionId: 'exam-1',
  type: 'question-set',
  items: [
    { itemId: 'q1', type: 'single-choice', correctId: 'b', explanation: '2 + 2 = 4' },
    { itemId: 'q2', type: 'multiple-choice', correctIds: ['c', 'a'] },
    { itemId: 'q3', type: 'true-false', correctValue: false },
  ],
}, questionSetDirective);
assert.ok(questionSetEvaluation, '题组答案必须与展示指令分离并通过白名单校验');
assert.deepEqual(gradeQuestionSetResponse(questionSetResponse!, questionSetEvaluation), {
  correct: 2,
  total: 3,
  incorrectItemIds: ['q3'],
});
const directGrade = formatQuestionSetGradeFeedback(questionSetDirective, questionSetResponse!, questionSetEvaluation);
assert.equal(directGrade?.correct, 2);
assert.match(directGrade?.content || '', /得分：2 \/ 3/);
assert.match(directGrade?.content || '', /正确答案：错误/);
assert.equal(normalizeQuestionSetEvaluation({
  interactionId: 'exam-1',
  type: 'question-set',
  items: [
    { itemId: 'q1', type: 'single-choice', correctId: 'forged' },
    { itemId: 'q2', type: 'multiple-choice', correctIds: ['a', 'c'] },
    { itemId: 'q3', type: 'true-false', correctValue: true },
  ],
}, questionSetDirective), undefined, '私有答案也不得引用不存在的选项');
assert.equal(normalizeSceneInteractionResponse({
  interactionId: 'exam-1',
  type: 'question-set',
  answers: [{ itemId: 'q1', type: 'single-choice', selectedId: 'b' }],
}, questionSetDirective), undefined, '整卷不得漏掉必答题');
assert.equal(normalizeSceneInteractionResponse({
  interactionId: 'exam-1',
  type: 'question-set',
  answers: [
    { itemId: 'q1', type: 'single-choice', selectedId: 'forged' },
    { itemId: 'q2', type: 'multiple-choice', selectedIds: ['a', 'c'] },
    { itemId: 'q3', type: 'true-false', value: true },
  ],
}, questionSetDirective), undefined, '题组不得接受伪造选项');

const parsed = parseSceneSpec(JSON.stringify({
  meta: { name: '练习', subject: '数学', sceneSkill: 'S1', knowledgePoints: ['导数'], goal: '应用导数' },
  behavior,
  completion: { mode: 'signal', maxTurns: 6 },
}), 'S1');
assert.equal(parsed.behavior?.kind, '自适应答题');
assert.deepEqual(parsed.behavior?.interaction?.allowedTypes, ['text']);
assert.equal(resolveSceneParadigm(parsed), 'general');
const turnAgentRun = {
  runId: 'run-agent', sceneId: parsed.sceneId, sceneName: parsed.meta.name,
  status: 'running' as const, messages: [{
    id: 'user-1', speakerType: 'user' as const, speakerName: '你',
    content: '我认为导数只表示函数值变大。', timestamp: new Date().toISOString(),
  }], metrics: [], events: [], turnCount: 1, startedAt: new Date().toISOString(),
};
const turnAgentSpec = {
  ...parsed,
  injectProfile: true,
  promptModuleIds: [
    'resource-grounding', 'personal-cognition-grounding', 'profile-personalization', 'turn-agent-planning',
  ] as NonNullable<typeof parsed.promptModuleIds>,
};
assert.deepEqual(availableSceneTurnContextSources(turnAgentSpec), [
  'knowledge-notes', 'documents', 'document-arguments', 'argument-chain', 'learner-profile',
]);
const normalizedTurnPlan = normalizeSceneTurnPlan({
  understanding: { intent: 'answer', userGoal: '理解导数与函数变化', expectedExperience: '先复述，再反例追问',
    requirements: [], exclusions: [], needsClarification: false, evaluationRequested: false,
    informationGaps: [{ id: 'personal', description: '用户此前的观点', kind: 'personal-context' },
      { id: 'material', description: '导数相关参考内容', kind: 'reference-material' }],
    evidence: [{ sourceId: 'user-1', quote: '我认为导数只表示函数值变大。' }] },
  action: 'challenge',
  toolRequests: [
    { id: 'argument-chain', query: '导数与单调性', needId: 'personal', reason: '了解已保存的观点' },
    { id: 'knowledge-notes', query: '导数与单调性', needId: 'material', reason: '参考概念定义' },
    { id: 'unknown-source', query: 'q' },
  ],
  retrievalQuery: '导数与函数单调性的关系',
  focus: '检查用户把导数与函数值混淆的地方',
  responseGuidance: '先复述，再用反例追问',
  preferredInteractionType: 'single-choice',
}, turnAgentSpec, turnAgentRun);
assert.deepEqual(normalizedTurnPlan.contextSources, ['argument-chain', 'knowledge-notes']);
assert.equal(normalizedTurnPlan.preferredInteractionType, 'text', '回合 Agent 不得选择场景未装配的交互组件');
assert.match(renderSceneTurnPlan(normalizedTurnPlan), /行动：challenge/);
assert.match(SCENE_TURN_PLAN_PROMPT, /不直接回答用户/);
assert.match(SCENE_TURN_PLAN_PROMPT, /argument-chain.*不是已验证事实/s);
const batchProjected = applySceneAssemblyPlan({
  ...parsed,
  situation: '无关背景', openingNarrative: '你走进考场', userRole: '考生',
  role: { id: 'role-1', name: '监考官', attributes: [{ id: 'a', key: '动作', value: '敲桌子', enabled: true }] },
  metrics: [{ id: 'm-1', name: '紧张度', type: 'continuous', initial: 0, target: 1, description: '测试' }],
  events: [{ id: 'ev-1', description: '突然停电', trigger: { type: 'turn', turn: 1 }, fired: false }],
  eventInjection: true, injectProfile: true,
}, {
  subject: '数学', knowledgePoints: [], sceneSkill: 'S1', recipeId: 'batch-assessment',
  requestedCapabilities: ['question-set'],
  requestedPromptModules: ['resource-grounding', 'structured-interaction', 'deterministic-assessment'],
});
assert.equal(batchProjected.openingNarrative, '');
assert.equal(batchProjected.situation, '');
assert.equal(batchProjected.userRole, '');
assert.deepEqual(batchProjected.role.attributes, []);
assert.deepEqual(batchProjected.metrics, []);
assert.deepEqual(batchProjected.events, []);
assert.deepEqual(batchProjected.behavior?.interaction?.allowedTypes, ['question-set']);
assert.equal(batchProjected.behavior?.interaction?.defaultType, 'question-set');
assert.equal(batchProjected.eventInjection, false);
assert.equal(batchProjected.injectProfile, false);
const adaptiveProjected = applySceneAssemblyPlan({ ...parsed, injectProfile: false }, {
  subject: '数学', knowledgePoints: ['导数'], sceneSkill: 'S1', recipeId: 'guided-practice',
  requestedCapabilities: ['text'],
  requestedPromptModules: ['resource-grounding', 'adaptive-progression', 'profile-personalization'],
});
assert.equal(adaptiveProjected.injectProfile, true, '场景搭建 Agent 授权画像模块后，应交由回合 Agent 逐轮决定是否读取');
assert.equal(adaptiveProjected.promptModuleIds?.includes('turn-agent-planning'), true);
assert.doesNotMatch(buildGeneralTurnPrompt(batchProjected, {
  runId: 'run-batch', sceneId: batchProjected.sceneId, sceneName: batchProjected.meta.name, status: 'running', messages: [], metrics: [], events: [], turnCount: 0, startedAt: new Date().toISOString(),
}), /监考官|无关背景|紧张度|突然停电/);
assert.match(buildGeneralTurnSystemPrompt(batchProjected), /用户提交后由本地核对/);
assert.match(buildGeneralTurnSystemPrompt(batchProjected), /不要角色扮演/);
assert.equal(preflightSceneSpec(parsed).valid, true, '声明配方与文本协议的 S1 应通过预检');
assert.equal(preflightSceneSpec({ ...parsed, capabilityIds: ['single-choice'] }).valid, false, '声明能力必须同时出现在运行时交互协议中');
const legacyPreflight = preflightSceneSpec({ ...parsed, capabilityRecipeId: undefined, behavior: undefined });
assert.equal(legacyPreflight.valid, true);
assert.equal(legacyPreflight.legacy, true, '无配方、无 behavior 的旧 S1 应保留兼容路径');
const batchPreflight = preflightSceneSpec({
  ...parsed,
  capabilityRecipeId: 'batch-assessment',
  behavior: parseBehaviorSpec({
    ...behavior,
    recipeId: 'batch-assessment',
    interaction: { version: '1.0', allowedTypes: ['question-set'], defaultType: 'question-set', allowTextFallback: false },
  }),
});
assert.equal(batchPreflight.valid, true);
assert.equal(batchPreflight.enabledCapabilities.includes('question-set'), true);

const interactiveBehavior = parseBehaviorSpec({
  ...behavior,
  interaction: {
    version: '1.0',
    allowedTypes: ['text', 'single-choice', 'multiple-choice'],
    defaultType: 'text',
    allowTextFallback: true,
  },
});
assert.ok(interactiveBehavior);
const interactiveSpec = { ...parsed, behavior: interactiveBehavior };
const structuredTurn = parseGeneralTurnResponse(JSON.stringify({
  content: '请选择最合适的答案。',
  interaction: {
    id: 'turn-choice-1',
    type: 'single-choice',
    instruction: '请选择一项',
    required: true,
    options: [{ id: 'a', label: '答案 A' }, { id: 'b', label: '答案 B' }],
    allowExplanation: true,
  },
  endReason: null,
}), interactiveSpec);
assert.equal(structuredTurn.interaction?.type, 'single-choice');
assert.deepEqual(structuredTurn.interactionDiagnostic, {
  requestedType: 'single-choice',
  resolvedType: 'single-choice',
  outcome: 'accepted',
  reason: 'accepted',
});
assert.equal(structuredTurn.endReason, undefined);
assert.equal(
  splitGeneralTurnReply('**题目：请选择正确答案**').content,
  '**题目：请选择正确答案**',
  '通用场景不得把 Markdown 加粗误判为 NPC 动作',
);

const aliasedQuestionTurn = parseGeneralTurnResponse(JSON.stringify({
  question: '**哪一项最符合定义？**',
  interaction: {
    id: 'turn-choice-2',
    type: 'single-choice',
    required: true,
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
  },
}), interactiveSpec);
assert.equal(aliasedQuestionTurn.content, '**哪一项最符合定义？**', 'question 别名必须提升为可见题干');
assert.equal(aliasedQuestionTurn.interaction?.type, 'single-choice');

const fullInteractiveSpec = {
  ...parsed,
  behavior: { ...interactiveBehavior!, interaction: fullProtocol },
};
const evaluatedQuestionTurn = parseGeneralTurnResponse(JSON.stringify({
  content: '请一次完成两题。',
  interaction: {
    id: 'exam-hidden-1',
    type: 'question-set',
    required: true,
    submissionMode: 'batch',
    feedbackMode: 'after-submit',
    items: [
      { id: 'q1', type: 'single-choice', content: '1 + 1 = ?', required: true, options: [{ id: 'a', label: '1' }, { id: 'b', label: '2' }] },
      { id: 'q2', type: 'true-false', content: '2 是偶数。', required: true },
    ],
  },
  evaluation: {
    interactionId: 'exam-hidden-1',
    type: 'question-set',
    items: [
      { itemId: 'q1', type: 'single-choice', correctId: 'b' },
      { itemId: 'q2', type: 'true-false', correctValue: true },
    ],
  },
  endReason: null,
}), fullInteractiveSpec);
assert.equal(evaluatedQuestionTurn.interaction?.type, 'question-set');
assert.equal(evaluatedQuestionTurn.interactionEvaluation?.interactionId, 'exam-hidden-1');
const turnCases = [
  { type: 'text', placeholder: '请输入' },
  { type: 'single-choice', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  { type: 'multiple-choice', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  { type: 'ordering', items: [{ id: 'a', content: 'A' }, { id: 'b', content: 'B' }] },
  { type: 'fill-blanks', blanks: [{ id: 'a', label: 'A' }] },
  {
    type: 'question-set',
    title: '两题测评',
    submissionMode: 'batch',
    feedbackMode: 'after-submit',
    items: [
      { id: 'q1', type: 'single-choice', content: '题目一', required: true, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      { id: 'q2', type: 'true-false', content: '题目二', required: true },
    ],
  },
] as const;
for (const [index, interactionCase] of turnCases.entries()) {
  const turn = parseGeneralTurnResponse(JSON.stringify({
    content: `题目 ${index + 1}`,
    interaction: { id: `turn-${index + 1}`, required: true, ...interactionCase },
  }), fullInteractiveSpec);
  assert.equal(turn.interaction?.type, interactionCase.type, `${interactionCase.type} 应被解析为可执行交互`);
  assert.equal(turn.interactionDiagnostic.outcome, 'accepted');
  assert.equal(turn.interactionDiagnostic.resolvedType, interactionCase.type);
}

const invalidJsonTurn = parseGeneralTurnResponse('不是 JSON', fullInteractiveSpec);
assert.equal(invalidJsonTurn.interactionDiagnostic.reason, 'invalid-json');
assert.equal(invalidJsonTurn.interactionDiagnostic.resolvedType, 'text');

const unknownInteractionTurn = parseGeneralTurnResponse(JSON.stringify({
  content: '请操作',
  interaction: { id: 'bad-1', type: 'slider' },
}), fullInteractiveSpec);
assert.equal(unknownInteractionTurn.interaction, undefined);
assert.equal(unknownInteractionTurn.interactionDiagnostic.requestedType, 'slider');
assert.equal(unknownInteractionTurn.interactionDiagnostic.reason, 'unsupported-type');

const invalidFieldsTurn = parseGeneralTurnResponse(JSON.stringify({
  content: '请选择',
  interaction: { id: 'bad-2', type: 'single-choice', options: [{ id: 'only', label: '只有一项' }] },
}), fullInteractiveSpec);
assert.equal(invalidFieldsTurn.interactionDiagnostic.reason, 'invalid-fields');

const disallowedInteractionTurn = parseGeneralTurnResponse(JSON.stringify({
  content: '请排序',
  interaction: {
    id: 'bad-3',
    type: 'ordering',
    items: [{ id: 'a', content: 'A' }, { id: 'b', content: 'B' }],
  },
}), interactiveSpec);
assert.equal(disallowedInteractionTurn.interactionDiagnostic.reason, 'disallowed-type');

const missingInteractionTurn = parseGeneralTurnResponse(JSON.stringify({ content: '请自由回答' }), fullInteractiveSpec);
assert.equal(missingInteractionTurn.interactionDiagnostic.reason, 'conversation');
assert.equal(missingInteractionTurn.interactionDiagnostic.outcome, 'none');

const truncatedJson = '{"content":"## 当前题目\\n\\n1. 下列哪一项正确？\\n\\nA. 甲\\nB. 乙","interaction":{"id":"cut-off"';
const truncatedTurn = parseGeneralTurnResponse(truncatedJson, fullInteractiveSpec);
assert.equal(truncatedTurn.content, '## 当前题目\n\n1. 下列哪一项正确？\n\nA. 甲\nB. 乙');
assert.equal(truncatedTurn.content.startsWith('{'), false, '截断 JSON 不得把协议外壳展示给用户');
assert.equal(truncatedTurn.interactionDiagnostic.reason, 'invalid-json');
assert.equal(
  extractPartialGeneralTurnContent('{"content":"## 未闭合题干\\n继续生成'),
  '## 未闭合题干\n继续生成',
  '未闭合的 content 字符串仍应提取为可渲染 Markdown',
);
const brokenEnvelopeTurn = parseGeneralTurnResponse('{"interaction":', fullInteractiveSpec);
assert.equal(brokenEnvelopeTurn.content.includes('{"interaction"'), false, '无法提取正文时不得显示原始 JSON 壳');

assert.match(SCENE_GENERAL_TURN_PROMPT, /batch-assessment 配方必须在一轮内用 question-set/);
assert.match(SCENE_GENERAL_TURN_PROMPT, /不得把整卷伪装成正文/);
assert.match(SCENE_GENERAL_TURN_PROMPT, /question-set 内判断题使用 true-false/);
assert.match(SCENE_GENERAL_TURN_PROMPT, /1\.B 2\.A/);
assert.match(SCENE_GENERATE_PROMPT, /选择 batch-assessment/);
assert.match(SCENE_GENERATE_PROMPT, /四选一\/判断题加入 single-choice/);
assert.match(SCENE_ADAPT_PROMPT, /batch-assessment 使用 question-set/);

const endedTurn = parseGeneralTurnResponse(JSON.stringify({
  content: '已完成',
  interaction: null,
  endReason: '达到目标',
}), fullInteractiveSpec);
assert.deepEqual(endedTurn.interactionDiagnostic, {
  resolvedType: 'none',
  outcome: 'none',
  reason: 'scene-ended',
});

const auditNow = Date.now();
const normalizedAudit = normalizeSceneInteractionAuditFile({
  version: 99,
  events: [
    {
      id: 'audit-1',
      runId: 'run-1',
      sceneId: 'scene-1',
      turnNumber: 2,
      requestedType: 'slider',
      resolvedType: 'text',
      outcome: 'text-fallback',
      reason: 'unsupported-type',
      allowedTypes: ['text', 'ordering', 'unknown'],
      createdAt: new Date(auditNow).toISOString(),
      content: '不得进入审计的题干',
    },
  ],
}, auditNow);
assert.equal(normalizedAudit.version, 1);
assert.deepEqual(normalizedAudit.events[0]?.allowedTypes, ['text', 'ordering']);
assert.equal('content' in (normalizedAudit.events[0] || {}), false, '本地审计不得保留题干或模型原文');
assert.deepEqual(summarizeSceneInteractionAudit(normalizedAudit.events), {
  total: 1,
  accepted: 0,
  textFallbacks: 1,
  noInteraction: 0,
  fallbackRate: 100,
  reasons: { 'unsupported-type': 1 },
});
const boundedAudit = normalizeSceneInteractionAuditFile({
  events: Array.from({ length: 505 }, (_, index) => ({
    id: `audit-${index}`,
    runId: 'run-bounded',
    sceneId: 'scene-bounded',
    turnNumber: index,
    resolvedType: 'text',
    outcome: 'accepted',
    reason: 'accepted',
    allowedTypes: ['text'],
    createdAt: new Date(auditNow - index).toISOString(),
  })),
}, auditNow);
assert.equal(boundedAudit.events.length, 500, '场景交互审计必须保持有上限');
const conversationalAudit = normalizeSceneInteractionAuditFile({ version: 1, events: [{ ...boundedAudit.events[0],
  id: 'conversation-audit', reason: 'conversation', outcome: 'none', resolvedType: 'none', requestedType: undefined,
}] }, auditNow);
assert.equal(conversationalAudit.events.length, 1, '合法无控件回应不能被审计静默丢弃');
assert.equal(conversationalAudit.events[0].reason, 'conversation');
const expiredAudit = normalizeSceneInteractionAuditFile({
  events: [{
    ...boundedAudit.events[0],
    id: 'expired',
    createdAt: new Date(auditNow - 181 * 24 * 60 * 60 * 1000).toISOString(),
  }],
}, auditNow);
assert.equal(expiredAudit.events.length, 0, '超过 180 天的场景交互审计必须清理');

const interactionHtml = renderToStaticMarkup(createElement(SceneInteractionInput, {
  directive: structuredTurn.interaction as Extract<NonNullable<typeof structuredTurn.interaction>, { type: 'single-choice' }>,
  onSubmit: () => undefined,
}));
assert.match(interactionHtml, /role="radiogroup"/, '单选交互必须提供 radio 组语义');
assert.match(interactionHtml, /role="radio"/, '单选交互选项必须提供 radio 语义');
assert.match(interactionHtml, /aria-checked="false"/, '单选交互必须暴露选中状态');
assert.match(interactionHtml, /<fieldset/, '选项组必须使用 fieldset 分组');
assert.match(interactionHtml, /答案 A/);

const orderingHtml = renderToStaticMarkup(createElement(SceneInteractionInput, {
  directive: validOrderingDirective,
  onSubmit: () => undefined,
}));
assert.match(orderingHtml, /<ol/, '排序交互必须使用有序列表语义');
assert.match(orderingHtml, /上移/, '排序交互必须提供键盘可操作的上移按钮');
assert.match(orderingHtml, /下移/, '排序交互必须提供键盘可操作的下移按钮');

const fillHtml = renderToStaticMarkup(createElement(SceneInteractionInput, {
  directive: fillDirective,
  onSubmit: () => undefined,
}));
assert.match(fillHtml, /概念/);
assert.match(fillHtml, /required=""/, '必填空位必须使用原生 required 语义');

const questionSetHtml = renderToStaticMarkup(createElement(SceneInteractionInput, {
  directive: questionSetDirective,
  onSubmit: () => undefined,
}));
assert.equal((questionSetHtml.match(/<form/g) || []).length, 1, '组合题组只能有一个批量提交表单');
assert.equal((questionSetHtml.match(/<fieldset/g) || []).length, 3, '题组内每道题必须有独立语义分组');
assert.match(questionSetHtml, /type="radio"/);
assert.match(questionSetHtml, /type="checkbox"/);
assert.match(questionSetHtml, /提交整卷/);

const parsedS4 = parseSceneSpec(JSON.stringify({ behavior }), 'S4');
assert.equal(parsedS4.behavior, undefined, 'S4 必须忽略 behavior，保持计算画布最高优先级');
const parsedS4Recipe = parseSceneSpec(JSON.stringify({ capabilityRecipeId: 'guided-derivation' }), 'S4');
assert.equal(parsedS4Recipe.capabilityRecipeId, 'guided-derivation');
assert.equal(preflightSceneSpec(parsedS4Recipe).valid, false, '严格启动预检必须拒绝缺少 compute 的 S4');
assert.equal(preflightSceneSpec(parsedS4Recipe, { allowDeferredCompute: true }).valid, true, '预览阶段允许稍后生成 compute');
const readyS4 = {
  ...parsedS4Recipe,
  compute: {
    type: 'formula' as const, given: [], operation: 'solve', expected_formula: 'x=1',
    expected_steps_count: 1, symbols: [], boundary_conditions: [],
  },
};
assert.equal(preflightSceneSpec(readyS4).valid, true);
const rejectedS4Recipe = parseSceneSpec(JSON.stringify({ capabilityRecipeId: 'guided-practice' }), 'S4');
assert.equal(rejectedS4Recipe.capabilityRecipeId, 'guided-derivation', 'S4 不得加载 turn 配方，必须回落到已注册画布配方');
assert.match(SCENE_COMPUTE_GENERATE_PROMPT, /given-node/);
assert.match(SCENE_COMPUTE_GENERATE_PROMPT, /premise-validation/);
assert.doesNotMatch(SCENE_COMPUTE_GENERATE_PROMPT, /"compute"\s*:/, 'S4 预览外壳不得携带计算答案');
assert.match(SCENE_COMPUTE_CONFIG_PROMPT, /"compute"\s*:/);
assert.match(SCENE_COMPUTE_CONFIG_PROMPT, /"help"\s*:/);

const normalizedAssemblyAudit = normalizeSceneAssemblyAuditFile({
  events: [{
    id: 'assembly-1', sceneId: 'scene-1', sceneSkill: 'S1', surface: 'turn', recipeId: 'batch-assessment',
    requestedCapabilities: ['question-set'], enabledCapabilities: ['question-set'], missingCapabilities: [],
    outcome: 'ready', diagnosticCodes: ['recipe-inferred'], createdAt: new Date(auditNow).toISOString(),
    content: '不得保存题干',
  }],
}, auditNow);
assert.equal(normalizedAssemblyAudit.events.length, 1);
assert.equal('content' in (normalizedAssemblyAudit.events[0] || {}), false, '装配审计不得保存场景正文');
assert.deepEqual(summarizeSceneAssemblyAudit(normalizedAssemblyAudit.events), {
  total: 1, ready: 1, blocked: 0, blockedRate: 0, diagnostics: { 'recipe-inferred': 1 },
});

const richText = prepareSceneMarkdown('inline $x^2$\n\n$$\\int_0^1 x dx$$\n\n`$code$`\n```ts\nconst price = "$5";\n```');
const inlineToken = richText.match(/`(SCENE_MATH_INLINE:[^`]+)`/)?.[1];
const blockToken = richText.match(/`(SCENE_MATH_BLOCK:[^`]+)`/)?.[1];
assert.ok(inlineToken);
assert.ok(blockToken);
assert.deepEqual(readSceneMathToken(inlineToken), { latex: 'x^2', display: false });
assert.deepEqual(readSceneMathToken(blockToken), { latex: '\\int_0^1 x dx', display: true });
assert.match(richText, /`\$code\$`/, 'inline code must preserve dollar signs');
assert.match(richText, /const price = "\$5";/, 'fenced code must preserve dollar signs');
assert.equal(prepareSceneMarkdown('unfinished $x'), 'unfinished $x');
assert.equal(prepareSceneMarkdown('escaped \\$x\\$'), 'escaped \\$x\\$');

const rendered = renderToStaticMarkup(createElement(SceneRichMessage, {
  content: '<script>alert(1)</script>\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n$x$\n\n[link](https://example.com)',
}));
assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'raw HTML must remain escaped');
assert.match(rendered, /<table>/, 'GFM tables must render');
assert.match(rendered, /class="katex"/, 'math must render through KaTeX');
assert.match(rendered, /target="_blank"/, 'links must open outside the current view');
assert.match(rendered, /rel="noreferrer noopener"/, 'external links must isolate the opener');

const citationPrepared = prepareSceneCitationMarkdown(
  'fact [1], code `[1]`, link [1](https://example.com), invalid [9]',
  new Set([1]),
);
assert.match(citationPrepared.markdown, /fact \[1\]\(#scene-citation-1\)/);
assert.match(citationPrepared.markdown, /code `\[1\]`/);
assert.match(citationPrepared.markdown, /link \[1\]\(https:\/\/example\.com\)/);
assert.match(citationPrepared.markdown, /invalid \[9\]/);
assert.deepEqual(citationPrepared.referencedIndexes, [1]);
assert.equal(readSceneCitationHref('#scene-citation-1'), 1);
assert.equal(readSceneCitationHref('https://example.com'), undefined);

const citations = [{ index: 1, noteId: 'note-1', title: 'Derivative', snippet: 'Rate of change.', score: 0.876 }];
const citedHtml = renderToStaticMarkup(createElement(SceneRichMessage, { content: 'Use this fact [1].', citations }));
assert.match(citedHtml, /class="scene-cite"/);
assert.match(citedHtml, /Derivative/);
assert.doesNotMatch(citedHtml, /scene-cite-fallback/);
const fallbackHtml = renderToStaticMarkup(createElement(SceneRichMessage, { content: 'Use this fact.', citations }));
assert.match(fallbackHtml, /scene-cite-fallback/);

assert.deepEqual(normalizeNoteSearchResults([
  { noteId: ' n1 ', noteType: 'knowledge', title: ' Title ', snippet: ' Snippet ', score: 1.4 },
  { noteId: 'n1', noteType: 'knowledge', title: 'Duplicate', snippet: 'Ignored', score: 0.5 },
  { noteId: '', noteType: 'knowledge', title: 'Invalid', snippet: 'Ignored', score: 0.5 },
  { noteId: 'n2', noteType: 'knowledge', title: 'Bad score', snippet: 'Ignored', score: Number.NaN },
], 3), [{ noteId: 'n1', noteType: 'knowledge', title: 'Title', snippet: 'Snippet', score: 1 }]);

assert.deepEqual(normalizeNoteSearchResults([
  { noteId: 'legacy', title: 'Unknown type', snippet: 'Not qualified', score: 0.9 },
  { noteId: 'project', noteType: 'project', title: 'Project', snippet: 'Not knowledge', score: 0.9 },
  { noteId: 'argument', noteType: 'knowledge', evidenceOrigin: 'user-argument-doc', title: 'Argument', snippet: 'Separate channel', score: 0.9 },
], 3), []);

assert.deepEqual(selectIncludedRagSources([
  { noteId: 'n1', noteType: 'knowledge', title: 'First', snippet: 'One', score: 0.9 },
  { noteId: 'n2', noteType: 'knowledge', title: 'Second', snippet: 'Two', score: 0.8 },
], '1. 笔记「First」（相关度 90%）：One'), [
  { index: 1, noteId: 'n1', noteType: 'knowledge', title: 'First', snippet: 'One', score: 0.9 },
]);

console.log('scene paradigm check passed');
await import('./check-scene-turn-agent');
await import('./check-scene-understanding');
await import('./check-scene-setup-recovery');
await import('./check-scene-json-request');
await import('./check-scene-capability-design');
await import('./check-scene-experiment-context');
await import('./check-scene-context-integration');
await import('./check-scene-input-form');
await import('./check-scene-build-materials');
await import('./check-scene-context-budget');
await import('./check-scene-turn-recovery');

await import('./check-scene-conversation');
await import('./check-scene-build-reassembly');

await import('./check-scene-conversation-ui');
await import('./check-scene-permission-pool');
await import('./check-scene-semantic-live-runner');
await import('./check-scene-teaching');
await import('./check-scene-teaching-handlers');

await import('./check-scene-teaching-conditions');
await import('./check-scene-task-preparation');
await import('./check-scene-build-recovery');
await import('./check-scene-build-recovery-handlers');
await import('./check-scene-turn-stability');
await import('./check-scene-stability-live-runner');
await import('./check-scene-ordering-runtime');
await import('./check-scene-preview-crash');
await import('./diagnose-scene-start-render');
await import('./check-scene-combinations');
await import('./check-scene-tool-reliability');
await import('./check-scene-input-handoff');
await import('./check-scene-widget-reliability');
await import('./check-scene-s4-contract');
await import('./check-scene-s4-build');
await import('./check-scene-s4-policy');
await import('./check-scene-acceptance-evidence');
await import('./check-scene-s4-separation');
await import('./check-scene-s4-lifecycle');
await import('./check-scene-s4-proof-integrity');
await import('./check-scene-s4-interaction-integrity');
await import('./check-scene-s4-recovery');

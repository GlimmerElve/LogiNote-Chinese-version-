import React, { useLayoutEffect, useState } from 'react';
import type {
  SceneInteractionDirective,
  SceneInteractionResponse,
  SceneMessage,
  SceneRunState,
  SceneSpec,
  NoteItem,
} from '../../types';
import {
  appendMessage,
  createRunState,
  generateMessageId,
  incrementTurn,
} from '../../services/scene/sceneRuntime';
import { formatSceneInteractionResponseContent } from '../../services/scene/sceneInteraction';
import { SceneChatView } from './SceneChatView';
export { SCENE_S1_DEMO_NOTES } from './sceneS1DemoNotes';

const DEMO_TIMESTAMP = '2026-10-03T09:30:00.000Z';

type DemoMode = 'decision' | 'practice' | 'exam' | 'open-answer';

const DEMO_MODES: Array<{ id: DemoMode; label: string }> = [
  { id: 'decision', label: '情境互动' },
  { id: 'practice', label: '逐题答题' },
  { id: 'exam', label: '整卷测评' },
  { id: 'open-answer', label: '主观问答' },
];

const DECISION_SCENE: SceneSpec = {
  sceneId: 'demo-s1-budget-negotiation', version: '1.0',
  meta: { name: '董事会预算争议', subject: '管理沟通与决策', sceneSkill: 'S1', knowledgePoints: ['机会成本', '利益相关者分析', '证据权重'], goal: '在有限预算下提出可辩护的优先级方案，并争取关键决策者支持' },
  capabilityRecipeId: 'decision-simulation', capabilityIds: ['text', 'single-choice', 'multiple-choice', 'markdown-content'],
  situation: '季度预算会进入关键回合。财务负责人要求你在增长实验与产品稳定性之间做出取舍。',
  task: '回应财务负责人的质疑，给出主张、证据与风险边界，并推动形成下一步共识。',
  role: { id: 'role-cfo-linlan', name: '林岚 · 财务负责人', attributes: [
    { id: 'identity', key: '身份', value: '负责年度预算与风险控制的财务负责人', enabled: true },
    { id: 'stance', key: '初始立场', value: '反对在证据不足时扩大增长预算', enabled: true },
    { id: 'style', key: '表达风格', value: '冷静、追问依据、重视可验证承诺', enabled: true },
  ] },
  userRole: '产品负责人', openingNarrative: '会议室里只剩最后二十分钟。投影幕上停着两套预算方案，所有人都在等你的判断。',
  resources: ['Q3 用户留存摘要', '预算敏感性分析', '上一轮增长试点复盘'], rules: ['每个主张必须说明依据', '不能承诺未经验证的数据', '最多 8 回合完成协商'],
  metrics: [
    { id: 'trust', name: '决策信任', type: 'continuous', initial: 54, target: 80, range: [0, 100], source: 'llm', description: '对方是否相信你的判断建立在可核验依据上。' },
    { id: 'evidence', name: '证据完整度', type: 'continuous', initial: 46, target: 75, range: [0, 100], source: 'llm', description: '主张、数据、假设和风险是否形成完整证据链。' },
    { id: 'consensus', name: '共识进度', type: 'continuous', initial: 35, target: 80, range: [0, 100], source: 'llm', description: '双方是否接近一个可执行的预算方案。' },
  ],
  completion: { mode: 'metric', successExpression: '三项指标均达到目标阈值。', failureExpression: '回避核心取舍或作出不可撤回承诺。', maxTurns: 8 }, evaluationDimensions: ['证据质量', '权衡能力', '回应清晰度'],
  engineConfig: { paradigm: 'single-role-dialogue', roleMemory: true, technologies: ['LLM 流式对话', '策略卡片', '指标引擎', '突发事件注入'], engines: ['SceneDirector', 'MetricEngine'] },
  events: [{ id: 'event-budget-cut', description: '运营负责人临时要求再压缩 15% 的可用预算。', trigger: { type: 'turn', turn: 4 }, fired: false }], eventInjection: true, injectProfile: false,
  extras: { 时间压力: '剩余 20 分钟', 隐藏约束: '财务负责人愿意接受可撤回的小规模试验' },
  behavior: { recipeId: 'decision-simulation', kind: '预算谈判', aiBehavior: '持续追问证据、机会成本与失败后的退出机制。', userAction: '选择回应策略，也可以补充自己的论证。', evaluationRule: '评价回应是否包含明确主张、可核验证据和风险边界。', progressionRule: '每轮深化质询，逐步逼近可执行共识。', outputFormats: ['markdown'], interaction: { version: '1.0', allowedTypes: ['text', 'single-choice', 'multiple-choice'], defaultType: 'single-choice', allowTextFallback: true } },
  origin: 'new', createdAt: DEMO_TIMESTAMP, updatedAt: DEMO_TIMESTAMP,
};

function sceneForMode(mode: DemoMode): SceneSpec {
  if (mode === 'decision') return DECISION_SCENE;
  if (mode === 'practice') return {
    ...DECISION_SCENE,
    sceneId: 'demo-s1-probability-practice',
    meta: { ...DECISION_SCENE.meta, name: '条件概率·逐题练习', subject: '概率论', knowledgePoints: ['条件概率', '独立性', '贝叶斯更新'], goal: '通过逐题判断辨析条件概率与独立性' },
    capabilityRecipeId: 'guided-practice', capabilityIds: ['text', 'single-choice', 'multiple-choice', 'fill-blanks', 'markdown-content'],
    situation: '教练会每轮给出一题，提交后立即核对判断与理由。', task: '完成当前题目，并尽量说明判断依据。', openingNarrative: '练习台已准备好。本轮只处理一个概念，提交后再进入下一题。',
    role: { id: 'role-probability-coach', name: '周豫 · 概率教练', attributes: [] }, userRole: '练习者', resources: ['条件概率定义', '独立事件判定表', '错题摘要'],
    metrics: [
      { id: 'accuracy', name: '判断准确度', type: 'continuous', initial: 52, target: 80, range: [0, 100], source: 'llm', description: '答案是否准确。' },
      { id: 'reasoning', name: '理由完整度', type: 'continuous', initial: 45, target: 75, range: [0, 100], source: 'llm', description: '是否能说明判断依据。' },
    ],
    completion: { mode: 'metric', successExpression: '完成 6 轮自适应练习。', failureExpression: '无', maxTurns: 6 }, events: [], eventInjection: false,
    behavior: { recipeId: 'guided-practice', kind: '概率练习', aiBehavior: '每轮只出一题，先反馈再自适应调整难度。', userAction: '选择答案，并可补充你的判断依据。', evaluationRule: '核对答案与理由。', progressionRule: '根据上一题表现调整题型与难度。', outputFormats: ['markdown'], interaction: { version: '1.0', allowedTypes: ['text', 'single-choice', 'multiple-choice', 'fill-blanks'], defaultType: 'single-choice', allowTextFallback: true } },
  };
  if (mode === 'exam') {
    const practice = sceneForMode('practice');
    return {
      ...practice,
      sceneId: 'demo-s1-probability-exam', meta: { ...practice.meta, name: '概率基础·阶段测评', goal: '一次完成多题测评，检验基础概念的稳定性' }, capabilityRecipeId: 'batch-assessment', capabilityIds: ['question-set', 'markdown-content'],
      situation: '这是一份不显示即时答案的阶段测评，所有题目会在交卷后统一评分。', task: '完成全部必答题并提交整卷。', openingNarrative: '试卷已封闭开始。交卷前不显示答案和解析。', role: { id: 'role-assessment-host', name: '阶段测评官', attributes: [] }, userRole: '应试者',
      metrics: [
        { id: 'completion', name: '作答完成度', type: 'continuous', initial: 0, target: 100, range: [0, 100], source: 'rule', description: '已完成的必答题比例。' },
        { id: 'score', name: '测评得分', type: 'continuous', initial: 0, target: 75, range: [0, 100], source: 'rule', description: '统一交卷后计算。' },
      ],
      completion: { mode: 'metric', successExpression: '提交整卷并生成反馈。', failureExpression: '未完成必答题。', maxTurns: 1 },
      behavior: { recipeId: 'batch-assessment', kind: '整卷测评', aiBehavior: '在交卷后统一评分并组织解析。', userAction: '作答全部必答题，确认后统一交卷。', evaluationRule: '使用私有答案逐题确定性评分。', progressionRule: '交卷后输出错题解析和复习建议。', outputFormats: ['markdown'], interaction: { version: '1.0', allowedTypes: ['question-set', 'text'], defaultType: 'question-set', allowTextFallback: true } },
    };
  }
  const practice = sceneForMode('practice');
  return {
    ...practice,
    sceneId: 'demo-s1-open-answer', meta: { ...practice.meta, name: '贝叶斯更新·主观问答', goal: '用自己的语言解释证据如何改变判断' }, capabilityRecipeId: 'socratic-dialogue', capabilityIds: ['text', 'markdown-content'],
    situation: '教练不要求背诵公式，而是通过澄清、反例和迁移追问检查理解。', task: '回答当前主观题，先给出核心判断，再提供依据与例子。', openingNarrative: '主观问答不评价用词是否与教材一致，更关注你是否真正建立了关系。', role: { id: 'role-socratic-tutor', name: '陈默 · 苏格拉底教练', attributes: [] }, userRole: '回答者',
    metrics: [
      { id: 'clarity', name: '概念清晰度', type: 'continuous', initial: 48, target: 80, range: [0, 100], source: 'llm', description: '是否区分先验、证据和后验。' },
      { id: 'transfer', name: '迁移能力', type: 'continuous', initial: 35, target: 70, range: [0, 100], source: 'llm', description: '是否能把原理用到新情境。' },
    ], completion: { mode: 'metric', successExpression: '完成解释、反例与迁移三层问答。', failureExpression: '无', maxTurns: 5 }, events: [], eventInjection: false,
    behavior: { recipeId: 'socratic-dialogue', kind: '苏格拉底问答', aiBehavior: '通过澄清、反例和迁移追问推进理解。', userAction: '使用多段文字回答，展开判断、依据与例子。', evaluationRule: '评价概念准确性、论证完整性和迁移能力。', progressionRule: '每轮只追问一个关键缺口。', outputFormats: ['markdown'], interaction: { version: '1.0', allowedTypes: ['text'], defaultType: 'text', allowTextFallback: true } },
  };
}

function decisionInteraction(turn = 1): SceneInteractionDirective {
  if (turn > 1) return { id: `demo-response-strategy-${turn}`, type: 'multiple-choice', instruction: '选择本轮要补强的论证要素。', required: true, minSelections: 1, maxSelections: 2, allowExplanation: true, options: [
    { id: 'metric', label: '验证指标', description: '说明用什么数据判断试验有效。' }, { id: 'boundary', label: '止损边界', description: '说明何时停止投入并回收预算。' }, { id: 'stakeholder', label: '协作承诺', description: '说明需要哪些团队共同承担验证责任。' },
  ] };
  return { id: 'demo-response-strategy-1', type: 'single-choice', instruction: '选择一个主回应策略；提交后可继续体验下一回合。', required: true, allowExplanation: true, options: [
    { id: 'evidence-first', label: '先建立证据底座', description: '用留存与敏感性数据限定结论，再提出小规模试验。' }, { id: 'tradeoff-first', label: '先公开取舍', description: '明确放弃哪些低优先级工作，换取关键增长实验预算。' }, { id: 'risk-first', label: '先给退出机制', description: '设定止损阈值和复盘时间点，降低不可逆风险。' },
  ] };
}

function practiceInteraction(turn = 1): SceneInteractionDirective {
  const second = turn > 1;
  return { id: `practice-question-${second ? turn : 1}`, type: 'single-choice', instruction: second ? '第 2 题 · 选择最准确的判断' : '第 1 题 · 选择正确答案', required: true, allowExplanation: true, options: second ? [
    { id: 'a', label: '两事件一定互斥' }, { id: 'b', label: '两事件一定独立' }, { id: 'c', label: '仅能说明 A 的发生会影响 B 的条件概率' }, { id: 'd', label: '无法判断任何关系' },
  ] : [
    { id: 'a', label: 'P(A∩B) / P(B)' }, { id: 'b', label: 'P(A∩B) / P(A)' }, { id: 'c', label: 'P(A) + P(B)' }, { id: 'd', label: 'P(A)P(B)' },
  ] };
}

function examInteraction(): SceneInteractionDirective {
  return { id: 'probability-stage-exam', type: 'question-set', title: '概率基础·阶段测评', description: '4 道必答题，交卷后统一显示结果与解析。', required: true, submissionMode: 'batch', feedbackMode: 'after-submit', items: [
    { id: 'q1', type: 'single-choice', content: '已知 P(A)=0.4，P(B|A)=0.5，则 P(A∩B) 为？', required: true, options: [{ id: 'a', label: '0.1' }, { id: 'b', label: '0.2' }, { id: 'c', label: '0.4' }, { id: 'd', label: '0.9' }] },
    { id: 'q2', type: 'multiple-choice', content: '下列哪些表达式可以描述 A 与 B 独立？', required: true, minSelections: 2, maxSelections: 2, options: [{ id: 'a', label: 'P(A∩B)=P(A)P(B)' }, { id: 'b', label: 'P(A|B)=0' }, { id: 'c', label: 'P(A|B)=P(A)' }, { id: 'd', label: 'P(A∪B)=1' }] },
    { id: 'q3', type: 'true-false', content: '若 A 与 B 互斥且概率都大于 0，则 A 与 B 不独立。', required: true, trueLabel: '正确', falseLabel: '错误' },
    { id: 'q4', type: 'single-choice', content: '贝叶斯更新中，新证据的核心作用是？', required: true, options: [{ id: 'a', label: '使先验概率消失' }, { id: 'b', label: '保证后验为 1' }, { id: 'c', label: '通过似然重新分配假设的相对可信度' }, { id: 'd', label: '取代所有原有知识' }] },
  ] };
}

function openAnswerInteraction(turn = 1): SceneInteractionDirective {
  return { id: `open-answer-${turn}`, type: 'text', instruction: '请用自己的语言回答', required: true, minLength: 20, maxLength: 1200, placeholder: turn === 1 ? '先写出证据、先验与后验之间的关系，再补充一个例子…' : '针对这个反例修正你刚才的解释…' };
}

function openingMessage(mode: DemoMode, spec: SceneSpec): SceneMessage {
  if (mode === 'practice') return { id: 'practice-opening', speakerType: 'role', speakerName: spec.role.name, content: '已知 P(B)>0，条件概率 P(A|B) 的定义是哪一个？', timestamp: DEMO_TIMESTAMP, interaction: practiceInteraction() };
  if (mode === 'exam') return { id: 'exam-opening', speakerType: 'role', speakerName: spec.role.name, content: '请独立完成下列题目。作答过程不显示正确答案，交卷后将统一评分。', timestamp: DEMO_TIMESTAMP, interaction: examInteraction(), interactionEvaluation: { interactionId: 'probability-stage-exam', type: 'question-set', items: [
    { itemId: 'q1', type: 'single-choice', correctId: 'b', explanation: 'P(A∩B)=P(A)P(B|A)=0.2。' }, { itemId: 'q2', type: 'multiple-choice', correctIds: ['a', 'c'], explanation: '这是独立性的两个等价表达。' }, { itemId: 'q3', type: 'true-false', correctValue: true, explanation: '正概率互斥事件不满足乘法关系。' }, { itemId: 'q4', type: 'single-choice', correctId: 'c', explanation: '似然决定证据对各假设的支持程度。' },
  ] } };
  if (mode === 'open-answer') return { id: 'open-answer-opening', speakerType: 'role', speakerName: spec.role.name, content: '不写公式，你会怎样向一个完全没学过概率的人解释：新证据为什么会改变我们对一个判断的信心？', timestamp: DEMO_TIMESTAMP, interaction: openAnswerInteraction() };
  return { id: 'demo-role-opening', speakerType: 'role', speakerName: spec.role.name, content: '你希望保留增长实验预算，但当前数据还不足以证明它比稳定性投入更重要。请先告诉我：你准备用什么逻辑承担这次取舍？', timestamp: DEMO_TIMESTAMP, citations: [{ index: 1, noteId: 'demo-retention-note', title: 'Q3 用户留存摘要', snippet: '新用户第 7 日留存提升 4.8%，但样本仍集中在单一渠道。', score: 0.91 }], interaction: decisionInteraction() };
}

function createDemoRun(mode: DemoMode): SceneRunState {
  const spec = sceneForMode(mode);
  const run = appendMessage(createRunState(spec), openingMessage(mode, spec));
  return { ...run, runId: `demo-run-s1-${mode}`, turnCount: mode === 'decision' ? 2 : 1, startedAt: DEMO_TIMESTAMP, metrics: run.metrics.map((metric) => ({ ...metric, value: mode === 'exam' ? 0 : Number(metric.value) + 7, lastDelta: mode === 'exam' ? 0 : 7, lastReason: '模拟预览数据。' })) };
}

function findActiveInteraction(run: SceneRunState): SceneInteractionDirective | undefined {
  const answeredIds = new Set(run.messages.map((message) => message.interactionResponse?.interactionId).filter(Boolean));
  return [...run.messages].reverse().find((message) => message.speakerType === 'role' && message.interaction && !answeredIds.has(message.interaction.id))?.interaction;
}

function examScore(response?: SceneInteractionResponse): number {
  if (response?.type !== 'question-set') return 0;
  const answers = new Map(response.answers.map((answer) => [answer.itemId, answer]));
  let correct = 0;
  const q1 = answers.get('q1'); if (q1?.type === 'single-choice' && q1.selectedId === 'b') correct += 1;
  const q2 = answers.get('q2'); if (q2?.type === 'multiple-choice' && [...q2.selectedIds].sort().join(',') === 'a,c') correct += 1;
  const q3 = answers.get('q3'); if (q3?.type === 'true-false' && q3.value) correct += 1;
  const q4 = answers.get('q4'); if (q4?.type === 'single-choice' && q4.selectedId === 'c') correct += 1;
  return correct;
}

export const SceneS1DemoPage: React.FC<{ onOpenNote?: (id: string) => void; onExit?: () => void; onSessionStatusChange?: (status: 'idle' | 'running' | 'finished') => void; completionContent?: React.ReactNode }> = ({ onOpenNote, onExit, onSessionStatusChange, completionContent }) => {
  const [mode, setMode] = useState<DemoMode>('decision');
  const [run, setRun] = useState<SceneRunState>(() => createDemoRun('decision'));
  useLayoutEffect(() => { onSessionStatusChange?.(run.status === 'running' ? 'running' : 'finished'); }, [run.status, onSessionStatusChange]);
  const spec = sceneForMode(mode);

  const switchMode = (nextMode: DemoMode) => { setMode(nextMode); setRun(createDemoRun(nextMode)); };

  const handleSend = (text: string, response?: SceneInteractionResponse) => {
    if (run.status !== 'running') return;
    const directive = findActiveInteraction(run);
    const content = response && directive ? formatSceneInteractionResponseContent(response, directive) : text.trim();
    if (!content) return;
    let next = appendMessage(run, { id: generateMessageId(), speakerType: 'user', speakerName: '你', content, timestamp: new Date().toISOString(), interactionResponse: response });
    next = incrementTurn(next);
    const nextTurn = next.turnCount;
    if (mode === 'exam') {
      const score = examScore(response);
      next = appendMessage(next, { id: generateMessageId(), speakerType: 'role', speakerName: spec.role.name, content: `已完成交卷：本次答对 **${score} / 4** 题。\n\n真实场景会逐题展示解析，并根据错题生成后续复习建议。`, timestamp: new Date().toISOString() });
      setRun({ ...next, status: 'success', endReason: '阶段测评已交卷，模拟结果不会写入学习记录。', endedAt: new Date().toISOString(), metrics: next.metrics.map((metric) => ({ ...metric, value: metric.metricId === 'completion' ? 100 : score * 25, lastDelta: metric.metricId === 'completion' ? 100 : score * 25 })) });
      return;
    }
    const roleMessage: SceneMessage = mode === 'practice'
      ? { id: generateMessageId(), speakerType: 'role', speakerName: spec.role.name, content: '你已经识别出条件概率的分母取决于“已知”事件。下一题检查你是否能区分独立与互斥。', timestamp: new Date().toISOString(), interaction: practiceInteraction(nextTurn) }
      : mode === 'open-answer'
        ? { id: generateMessageId(), speakerType: 'role', speakerName: spec.role.name, content: '你已经说明了“证据会改变可信度”。现在加一个反例：如果证据本身很不可靠，你的说法需要怎样修正？', timestamp: new Date().toISOString(), interaction: openAnswerInteraction(nextTurn) }
        : { id: generateMessageId(), speakerType: 'role', speakerName: spec.role.name, content: nextTurn >= 4 ? '你的边界比刚才清楚了。如果运营预算再缩减 15%，哪些假设必须优先验证？' : '这个方向可以讨论，但我还没看到失败时如何收场。请补充验证指标与止损边界。', timestamp: new Date().toISOString(), interaction: decisionInteraction(nextTurn), metricDeltas: [{ metricId: 'trust', metricName: '决策信任', delta: 4, reason: '回应结构清晰。' }] };
    setRun(appendMessage(next, roleMessage));
  };

  const handleInjectEvent = (text: string) => {
    if (!text.trim() || run.status !== 'running') return;
    setRun((current) => ({ ...appendMessage(current, { id: generateMessageId(), speakerType: 'event', speakerName: '突发事件', content: text.trim(), timestamp: new Date().toISOString() }), events: [...current.events, { id: `manual-demo-event-${Date.now()}`, description: text.trim(), trigger: { type: 'condition', condition: '用户手动注入' }, fired: true }] }));
  };

  const handleEnd = () => setRun((current) => ({ ...current, status: 'success', endReason: '模拟场景已结束；本次操作不会保存到学习记录。', endedAt: new Date().toISOString() }));

  return (
    <div className={`scene-s1-demo-page is-${mode}`}>
      <div className="scene-s1-demo-notice" role="status">
        <div className="scene-s1-demo-notice-copy"><strong>交互预览</strong><span>模拟数据 · 不调用 Provider · 不写入学习记录</span></div>
        <div className="scene-s1-demo-tabs" role="tablist" aria-label="S1 场景预览类型">
          {DEMO_MODES.map((item) => <button key={item.id} type="button" role="tab" aria-selected={mode === item.id} className={mode === item.id ? 'is-active' : ''} onClick={() => switchMode(item.id)}>{item.label}</button>)}
        </div>
      </div>
      <SceneChatView spec={spec} run={run} sending={false} onSend={handleSend} onInjectEvent={handleInjectEvent} onEnd={handleEnd} onExit={onExit} onRerun={() => setRun(createDemoRun(mode))} hasPrevRun onOpenNote={onOpenNote} completionContent={completionContent} />
    </div>
  );
};

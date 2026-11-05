import assert from 'node:assert/strict';
import type { LlmCallRequest, SceneSpec } from '../src/types';
import { runSceneMultiAgent } from '../src/services/agent/sceneMultiAgent';
import { understandingFixture } from './scene-semantic-fixture';
import { generateGeneralTurn } from '../src/services/scene/sceneDirector';
import { prepareSceneTurnAgentContext } from '../src/services/scene/sceneTurnAgent';
import { createRunState } from '../src/services/scene/sceneRuntime';
import { parseSceneSpec, applySceneAssemblyPlan } from '../src/services/scene/sceneGenerator';
import { resolveSceneRuntimeContract } from '../src/services/scene/sceneRuntimeContract';

globalThis.fetch = async () => assert.fail('Semantic gate tests must not use network');
const request = '不要组卷考试，我只是想聊聊考试焦虑。单选和判断只是交互形式的例子，不是本次要求。';
const understood = understandingFixture('request', request, { intent: 'build-scene', userGoal: '交流考试焦虑',
  expectedExperience: '自然对话', exclusions: ['不组卷、不测评', '不把举例当作要求'] });
let setupCalls = 0;
const built = await runSceneMultiAgent({ userRequest: request, callLlm: async call => {
  const input = JSON.parse(call.userInput); setupCalls++;
  assert.equal(call.tools, undefined);
  if (setupCalls === 1) {
    assert.equal(input.phase, 'understand'); assert.equal(input.request, request);
    assert.doesNotMatch(call.systemPromptOverride || '', /batch-assessment|knowledge-notes|Registered recipes|Capabilities:/);
    return { content: JSON.stringify({ sceneSkill: 'S1', understanding: understood }) };
  }
  assert.equal(input.phase, 'assemble');
  assert.deepEqual(input.architecture.understanding.exclusions, understood.exclusions);
  return { content: JSON.stringify({ capabilityPlan: { needs: [{ id: 'talk', goal: '自然交流', capabilityIds: ['text'] }], missing: [] }, recipeId: 'free-dialogue', requestedCapabilities: ['text'],
    requestedPromptModules: ['turn-agent-planning'], interactionPlan: '自然讨论，不安排测验', rationale: '围绕焦虑交流，不把考试一词或举例识别为组卷需求' }) };
} });
assert.equal(setupCalls, 2);
assert.equal(built.recommendation.recipeId, 'free-dialogue');
assert.deepEqual(JSON.parse(JSON.stringify(built.recommendation.understanding)), understood);
assert.equal(built.recommendation.requestedPromptModules.includes('deterministic-assessment'), false);
await runSceneMultiAgent({ userRequest: '按刚才的要求继续', conversation: [{ sourceId: 'prior-user', role: 'user', text: request }],
  callLlm: async call => {
    const input = JSON.parse(call.userInput);
    if (input.phase === 'understand') {
      assert.equal(input.conversation[0].text, request);
      return { content: JSON.stringify({ sceneSkill: 'S1', understanding: understandingFixture('request', '按刚才的要求继续', {
        ...understood, buildConstraints: { ...understood.buildConstraints!, evidence: [{ sourceId: 'prior-user', quote: request }] }, evidence: [{ sourceId: 'request', quote: '按刚才的要求继续' }, { sourceId: 'prior-user', quote: request }],
      }) }) };
    }
    return { content: JSON.stringify({ capabilityPlan: { needs: [{ id: 'talk', goal: '自然交流', capabilityIds: ['text'] }], missing: [] }, recipeId: 'free-dialogue', requestedCapabilities: ['text'], requestedPromptModules: ['turn-agent-planning'],
      interactionPlan: '按用户此前要求自然讨论', rationale: '承接历史约束，不把继续识别为开启默认练习' }) };
  } });
const longRequest = '下面是一段引用，不是本次要求：' + '考试、组卷、测评；'.repeat(200) + '引用结束。真正的需求是自由交流，不要出题。';
await runSceneMultiAgent({ userRequest: longRequest, callLlm: async call => {
  const input = JSON.parse(call.userInput);
  if (input.phase === 'understand') {
    assert.equal(input.request, longRequest, 'the tail correction must not be truncated before semantic understanding');
    return { content: JSON.stringify({ sceneSkill: 'S1', understanding: understandingFixture('request', longRequest,
      { intent: 'build-scene', userGoal: '自由交流', exclusions: ['不要出题'] }) }) };
  }
  return { content: JSON.stringify({ capabilityPlan: { needs: [{ id: 'talk', goal: '自然交流', capabilityIds: ['text'] }], missing: [] }, recipeId: 'free-dialogue', requestedCapabilities: ['text'], requestedPromptModules: ['turn-agent-planning'],
    interactionPlan: '自由交流', rationale: '引用不是要求，末尾明确纠正为交流' }) };
} });
for (const invalid of ['not-json', '{}', JSON.stringify({ sceneSkill: 'S1', understanding: { ...understood,
  evidence: [{ sourceId: 'request', quote: '用户没有说过的目标' }] } })]) {
  let calls = 0;
  await assert.rejects(() => runSceneMultiAgent({ userRequest: request, callLlm: async () => { calls++; return { content: invalid }; } }), /理解/);
  assert.equal(calls, 2, 'one bounded format repair is allowed, never assembly or keyword fallback');
}
let clarifySetupCalls = 0;
await assert.rejects(() => runSceneMultiAgent({ userRequest: request, callLlm: async () => {
  clarifySetupCalls++;
  return { content: JSON.stringify({ sceneSkill: 'S1', understanding: { ...understood, needsClarification: true,
    clarificationQuestion: '希望自由讨论还是有目标的引导？', informationGaps: [{id: 'choice', kind: 'user-clarification', description: '两种已指定方向相互冲突，需要用户选择'}] } }) };
} }), /希望自由讨论/);
assert.equal(clarifySetupCalls, 1);
let badAssemblyCalls = 0;
await assert.rejects(() => runSceneMultiAgent({ userRequest: request, callLlm: async () => ({ content: JSON.stringify(++badAssemblyCalls === 1
  ? { sceneSkill: 'S1', understanding: understood }
  : { recipeId: 'invented', requestedCapabilities: [], requestedPromptModules: [], interactionPlan: '猜一个', rationale: '猜测' }) }) }), /装配/);
assert.equal(badAssemblyCalls, 3, 'bad assembly gets one format repair, not a guessed alternative');

const spec = applySceneAssemblyPlan(parseSceneSpec(JSON.stringify({ meta: { name: '答疑', goal: '自然解答', subject: '物理' }, task: '解答追问',
  behavior: { recipeId: 'question-answer', kind: '答疑', aiBehavior: '回应用户', userAction: '提问', evaluationRule: '仅按需评价',
    progressionRule: '自然承接追问', interaction: { version: '1.0', allowedTypes: ['text'], defaultType: 'text', allowTextFallback: true } },
})), { recipeId: 'question-answer', subject: '物理', knowledgePoints: [], requestedCapabilities: ['text'],
  requestedPromptModules: ['turn-agent-planning', 'resource-grounding', 'personal-cognition-grounding'] });
const text = '不是让你考我，我没理解上一句话。请换一种解释，不要评分，也别查我的论证链。';
const run = { ...createRunState(spec), messages: [{ id: 'u1', speakerType: 'user' as const, speakerName: '你', content: text, timestamp: '' }], turnCount: 1 };
const correction = understandingFixture('u1', text, { intent: 'correction', userGoal: '换一种方式解释上一句话',
  expectedExperience: '直接解释', exclusions: ['不出题', '不评分', '不读取个人论证链'] });
const onRequest: SceneSpec = { ...spec, runtimeContract: { ...resolveSceneRuntimeContract(spec), evaluation: 'on-request', allowedActions: ['respond', 'clarify', 'evaluate'] } };
const calls: LlmCallRequest[] = [];
const direct = await generateGeneralTurn(onRequest, run, { dependencies: {
  callLlm: async call => {
    calls.push(call);
    if (call.workflow === 'scene-turn-plan') {
      const input = JSON.parse(call.userInput);
      assert.equal(input.phase, 'understand');
      assert.equal(input.latestUserInput.text, text);
      assert.equal(input.allowedContextSources, undefined);
      assert.equal(input.contract, undefined, 'understanding must not receive the tool catalogue embedded in the contract');
      assert.doesNotMatch(call.systemPromptOverride || '', /knowledge-notes|argument-chain|preferredInteractionType/);
      return { content: JSON.stringify({ understanding: correction, action: 'evaluate' }) };
    }
    assert.match(call.userInput, /换一种方式解释上一句话/);
    assert.match(call.systemPromptOverride || '', /本轮动作指引：直接回应/);
    return { content: '{"content":"换个角度说明：速度描述变化，加速度描述速度的变化。"}' };
  }, searchNotes: async () => assert.fail('no information gap means no retrieval'),
  searchCognition: async () => assert.fail('mentioning personal cognition is not permission or need'),
} });
assert.equal(calls.length, 2, 'simple response uses one understanding call and one reply, without extra tool matching');
assert.equal(direct.agentTrace?.tools.length, 0);
assert.equal(direct.agentTrace?.planningSteps, 0);
const multiFormSpec: SceneSpec = { ...spec, runtimeContract: { ...resolveSceneRuntimeContract(spec),
  allowedInteractionTypes: ['text', 'single-choice'], allowedTools: [] }, behavior: { ...spec.behavior!,
    interaction: { version: '1.0', allowedTypes: ['text', 'single-choice'], defaultType: 'text', allowTextFallback: true } } };
let formCalls = 0;
const form = await prepareSceneTurnAgentContext(multiFormSpec, run, { callLlm: async call => {
  formCalls++; const input = JSON.parse(call.userInput);
  if (input.phase === 'understand') return { content: JSON.stringify({ understanding: correction, action: 'advance' }) };
  assert.deepEqual(input.allowedContextSources, []);
  assert.deepEqual(input.contract.allowedTools, [], 'form-only selection cannot be primed with retrieval tools');
  return { content: '{"action":"advance","toolRequests":[],"preferredInteractionType":"single-choice"}' };
}, searchNotes: async () => assert.fail('choosing a widget does not authorize retrieval') });
assert.equal(formCalls, 2);
assert.equal(form.plan.preferredInteractionType, 'single-choice', 'no material gap must not freeze the interaction to its default widget');
assert.equal(form.trace.tools.length, 0);

for (const malformed of ['{}', '{"action":"respond"}', JSON.stringify({ understanding: correction, action: 'respond',
  toolRequests: [{ id: 'knowledge-notes', query: 'q' }] })]) {
  let phaseCalls = 0;
  await assert.rejects(() => prepareSceneTurnAgentContext(spec, run, {
    callLlm: async () => { phaseCalls++; return { content: malformed }; }, searchNotes: async () => assert.fail('semantic failure must block all tools'),
  }), /理解/);
  assert.equal(phaseCalls, 2, 'malformed semantic output receives one bounded repair before tools remain blocked');
}
const withGap = { ...correction, informationGaps: [{ id: 'g1', description: '本轮解释所需的资料定义', kind: 'reference-material' as const }] };
for (const tool of [
  { id: 'knowledge-notes', query: 'q', needId: 'missing', reason: '搜索' },
  { id: 'knowledge-notes', query: 'q', needId: 'g1' },
  { id: 'argument-chain', query: 'q', needId: 'g1', reason: '用个人观点冒充知识资料' },
]) {
  await assert.rejects(() => prepareSceneTurnAgentContext(spec, run, {
    callLlm: async call => ({ content: JSON.stringify(JSON.parse(call.userInput).phase === 'understand'
      ? { understanding: withGap, action: 'respond' } : { action: 'respond', toolRequests: [tool] }) }),
    searchNotes: async () => assert.fail('invalid need binding cannot reach retrieval'),
    searchCognition: async () => assert.fail('reference gap cannot authorize personal retrieval'),
  }), /取材规划/);
}
let reads = 0, plans = 0;
const retrieved = await prepareSceneTurnAgentContext(spec, run, {
  callLlm: async call => {
    const input = JSON.parse(call.userInput);
    if (input.phase === 'understand') return { content: JSON.stringify({ understanding: withGap, action: 'respond' }) };
    plans++;
    assert.deepEqual(input.understanding, withGap);
    return { content: JSON.stringify({ action: 'respond', toolRequests: plans === 1
      ? [{ id: 'knowledge-notes', query: '速度定义', needId: 'g1', reason: '查找本轮所需的定义依据' }] : [] }) };
  }, searchNotes: async () => { reads++; return [{ noteId: 'n1', noteType: 'knowledge', title: '速度', snippet: '速度是位移的变化率', score: 1 }]; },
});
assert.equal(reads, 1); assert.equal(plans, 2); assert.equal(retrieved.citations.length, 1);
assert.equal(retrieved.plan.understanding.userGoal, correction.userGoal);
let clarificationCalls = 0;
const clarified = await prepareSceneTurnAgentContext(spec, run, {
  callLlm: async () => { clarificationCalls++; return { content: JSON.stringify({ understanding: { ...correction,
    needsClarification: true, clarificationQuestion: '你指的是哪一句？', informationGaps: [{ id: 'u', kind: 'user-clarification', description: '用户所指句子' }] }, action: 'advance' }) }; },
  searchNotes: async () => assert.fail('user ambiguity must not be replaced by retrieval'),
});
assert.equal(clarificationCalls, 1); assert.equal(clarified.plan.action, 'clarify'); assert.equal(clarified.trace.tools.length, 0);
console.log('Scene understanding gates passed: catalogue-free first phase, grounded decision records, preserved negation/example/correction fixtures, no keyword fallback, no-gap direct replies, clarification and gap-bound tool execution. Synthetic model decisions; not a live semantic-accuracy evaluation.');

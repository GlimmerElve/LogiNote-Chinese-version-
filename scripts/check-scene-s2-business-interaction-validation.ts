import assert from 'node:assert/strict';
import type { LlmCallResponse } from '../src/types';
import type { S2CanvasDefinition } from '../src/types/sceneS2';
import { createS2Scene, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { S2ValidationStop } from './scene-s2-agent-validation';
import { S2_BUSINESS_VALIDATION_CASE } from './scene-s2-business-validation';
import { runS2BusinessInteractionValidation, S2_BUSINESS_INTERACTION_CHECKS, compileS2InteractionEvidence,
  S2_INTERACTION_EVIDENCE_LIMITS, type S2InteractionEvidence } from './scene-s2-business-interaction-validation';
import { syntheticS2Business } from './fixtures/s2-business-model';

globalThis.fetch = async () => assert.fail('Offline synthetic regression; no provider, credentials, notes, profile or network');
const source = '[{"name":"示例甲","score":80},{"name":"","score":120}]';
const misconception = 'JSON解析成功说明所有业务条件都满足。';
function fixture(): S2CanvasDefinition {
  const scene = createS2Scene(S2_BUSINESS_VALIDATION_CASE.request), base = { ...scene.canvasWorkspace!, initial: { nodes: [
    { id: 'Input', type: 'text', position: { x: 0, y: 0 }, values: { content: source } },
    { id: 'Understanding', type: 'text', position: { x: 0, y: 100 }, values: { content: misconception } },
  ], edges: [] } };
  const business = syntheticS2Business(base);
  business.knowledge = [
    { id: 'Types', title: '类型边界', content: 'SyntheticSelectedKnowledgeMarker：文本像装箱单，JSON值像分好类的物品，表格像陈列架。' },
    { id: 'Meaning', title: '技术与业务', content: 'SyntheticUnselectedKnowledgeMarker：搬运成功不代表物品质量合格。' },
  ];
  business.criteria = [
    { id: 'SourceName', label: '输入值', expectation: '第一项name是示例甲', method: 'local', required: true,
      target: { nodeId: 'Input', fieldId: 'content' }, rule: { kind: 'json-pointer-equals', pointer: '/0/name', value: '示例甲' } },
    { id: 'Meaning', label: '理解区别', expectation: '区分技术执行和业务判断', method: 'semantic', required: true,
      target: { nodeId: 'Understanding', fieldId: 'content' } },
    { id: 'Example', label: '建议补充例子', expectation: '可以举例，不作为必过指标', method: 'advisory', required: false },
  ];
  return readS2Definition({ ...base, business }, { requireBusiness: true });
}
const replies = [
  '第1轮合成回复：文本像装箱单，JSON值像分类物品，表格像陈列架；这只是协议离线桩，不证明模型理解质量。',
  '第2轮合成回复：当前原文把解析成功当作业务合格，应区分本地核对与语义判断；开放建议不作为失败指标。',
  '第3轮合成回复：现在暂停正式评价，只用搬运包裹的例子提供开放建议；没有改图或执行，也不打分和宣判。',
];
const shortHeading = '**一个形象例子：寄快递**';
const mShortEvidence = '把三种东西想成“同一份菜谱的三种形态”';
const headingAndBody = `${shortHeading}\n正文是从实际回复提取的连续片段，文本像单据、JSON像结构化记录、表格像清单；不需要模型重新抄写或计数字符。`;
const catalogueSources = [headingAndBody, replies[1], replies[2]];
const compiled = compileS2InteractionEvidence(catalogueSources);
assert.deepEqual(compileS2InteractionEvidence(catalogueSources), compiled, 'Candidate IDs and quotes are deterministic for identical actual replies');
assert.equal(new Set(compiled.map(item => item.id)).size, compiled.length);
assert.ok(compiled.every(item => catalogueSources[item.turn - 1].includes(item.quote) && item.quote.length >= 20 && item.quote.length <= 100));
assert.ok(compiled.filter(item => item.turn === 1).every(item => !item.quote.includes(shortHeading)), 'A title cannot gain length by borrowing body text');
assert.equal(shortHeading.length, 14); assert.equal(mShortEvidence.length, 19);
assert.throws(() => compileS2InteractionEvidence([shortHeading, replies[1], replies[2]]), /evidence-catalogue-empty/);
assert.throws(() => compileS2InteractionEvidence(['**这是一个长度超过二十个字符的纯标题，不可以作为正文证据**', replies[1], replies[2]]), /evidence-catalogue-empty/);
assert.throws(() => compileS2InteractionEvidence([' \n\t ', replies[1], replies[2]]), /evidence-catalogue-empty/);
assert.throws(() => compileS2InteractionEvidence(['x'.repeat(S2_INTERACTION_EVIDENCE_LIMITS.replyChars + 1), replies[1], replies[2]]), /evidence-catalogue-limit-exceeded/);
const capacitySources = [1, 2, 3].map(turn => Array.from({ length: S2_INTERACTION_EVIDENCE_LIMITS.perTurn }, (_, index) =>
  `T${turn}-${String(index).padStart(3, '0')}`.padEnd(100, 'x')).join(''));
const atCapacity = compileS2InteractionEvidence(capacitySources);
assert.equal(atCapacity.length, S2_INTERACTION_EVIDENCE_LIMITS.candidates);
assert.equal(atCapacity.reduce((count, item) => count + item.quote.length, 0), S2_INTERACTION_EVIDENCE_LIMITS.quoteChars);
const tooMany = Array.from({ length: S2_INTERACTION_EVIDENCE_LIMITS.perTurn + 1 }, (_, index) => `${String(index).padStart(4, '0')}:`.padEnd(59, 'x') + '。').join('\n');
assert.throws(() => compileS2InteractionEvidence([tooMany, replies[1], replies[2]]), /evidence-catalogue-limit-exceeded/, 'Excess candidates fail closed rather than silently dropping evidence');
type Variant = 'good' | 'evaluation-trace' | 'wrong-local' | 'no-skill' | 'no-assessment' | 'forged-evidence' | 'wrong-target' | 'unrequested-edit'
  | 'pause-still-scores' | 'scaffolding-unmet' | 'fixed-phrase-unmet' | 'false-positive-scope' | 'repeat-assessment-submission'
  | 'request-only-judge' | 'short-heading-judge' | 'm-free-quote-judge' | 'unknown-evidence-id' | 'wrong-turn-judge' | 'self-filled-quote'
  | 'extra-judge-field' | 'no-body-evidence' | 'judge-input-overflow' | 'invalid-judge' | 'budget-midway' | 'abort-midway' | 'provider-error';
const response = (value: unknown): LlmCallResponse => ({ content: JSON.stringify(value) } as LlmCallResponse);
async function run(variant: Variant) {
  const definition = fixture(), controller = new AbortController();
  if (variant === 'judge-input-overflow') {
    definition.initial.nodes.push(...Array.from({ length: 6 }, (_, index) => ({ id: `Extra${index}`, type: 'text', position: { x: 0, y: 0 }, values: { content: 'x'.repeat(5500) } })));
    readS2Definition(definition, { requireBusiness: true });
  }
  const original = JSON.stringify(definition);
  const actualReplies = [...replies];
  // Actual H failure excerpts are synthetic test data, not a hardcoded runtime answer detector.
  if (variant === 'scaffolding-unmet') actualReplies[0] = '当前它的 table 输入端口还没有接线，这正是题目留给你补的那一条必要执行线（tableview.table ← totable.table）。';
  if (variant === 'fixed-phrase-unmet') actualReplies[2] = '若希望我提出最小补线方案，请明确说“委托协作”，我会先原样保留你的原文，再只提这一条线的方案。';
  if (variant === 'false-positive-scope') actualReplies[1] = '性质说明：这是程序按 JSON Pointer 做的精确比对，只证明原始首条记录被原样保留；它不检查第二条记录。';
  if (variant === 'repeat-assessment-submission') actualReplies[1] = '若你希望我按这些指标做正式判定提交，或希望修改 understanding_note 的表述、补齐那条待补执行线，请分别明确告知；改图与运行仍需各自确认。';
  if (variant === 'short-heading-judge') actualReplies[0] = headingAndBody;
  if (variant === 'm-free-quote-judge') actualReplies[0] = `${mShortEvidence}：纸上文字须显式解析为结构化数据，再显式转换成表格；这一完整正文提供足长原文证据。`;
  if (variant === 'no-body-evidence') actualReplies[0] = shortHeading;
  let calls = 0, turn = 0, judgeCalls = 0; const artifacts: string[] = [];
  const result = await runS2BusinessInteractionValidation({ acceptedDefinition: definition, signal: controller.signal,
    onArtifact: async name => { artifacts.push(name); }, invoke: async request => {
      calls++; const input = JSON.parse(request.userInput);
      assert(request.maxTokensOverride! <= (input.phase ? 2048 : 1536));
      assert.ok(!request.userInput.includes('PrivateSyntheticAnswer'));
      if (input.phase) {
        judgeCalls++; assert.equal(input.phase, 's2-business-interaction-independent-review');
        assert.equal(input.criteria.some((item: object) => Object.hasOwn(item, 'rule')), false);
        assert.deepEqual(input.publicScene.instructions, definition.instructions);
        assert.equal(input.publicScene.goal, definition.goal);
        assert.deepEqual(input.publicScene.originalRequest, S2_BUSINESS_VALIDATION_CASE.request);
        assert.equal(Object.hasOwn(input.publicScene, 'business'), false);
        assert.equal(Object.hasOwn(input.publicScene, 'reference'), false);
        assert.equal(input.publicScene.localCriterionScope.checkedPath, '/0/name');
        assert.ok(S2_BUSINESS_VALIDATION_CASE.request.extraHints!.includes(input.publicScene.localCriterionScope.sourceQuote));
        assert.equal(Object.hasOwn(input.publicScene.localCriterionScope, 'rule'), false);
        assert.equal(Object.hasOwn(input.publicScene.localCriterionScope, 'value'), false);
        assert.equal(Object.hasOwn(input.publicScene.localCriterionScope, 'expectedValue'), false);
        assert.match(request.systemPromptOverride!, /scaffolding-without-solution/);
        assert.match(request.systemPromptOverride!, /natural-language-control/);
        assert.match(request.systemPromptOverride!, /用户明确要答案、完整示范或委托协作/);
        assert.match(request.systemPromptOverride!, /不把有用提示误判为泄题/);
        assert.match(request.systemPromptOverride!, /每项指标只能证明实际检查范围/);
        assert.match(request.systemPromptOverride!, /local只比对\/0\/name/);
        assert.match(request.systemPromptOverride!, /before=after也是另一项独立宿主事实/);
        assert.match(request.systemPromptOverride!, /将窄指标解释成整条记录保留须用unmet/);
        assert.match(request.systemPromptOverride!, /本轮实际附有assessment/);
        assert.match(request.systemPromptOverride!, /同一次评价仍待用户再次要求或确认是否正式提交/);
        assert.match(request.systemPromptOverride!, /今后另一次重评或用户改变内容后再评的正常选项/);
        assert.match(request.systemPromptOverride!, /evidenceId/);
        assert.match(request.systemPromptOverride!, /不复写quote、不输出evidence字段/);
        assert.match(request.systemPromptOverride!, /仍须评审全部三轮完整回复/);
        const catalogue = input.evidenceCatalogue as S2InteractionEvidence[];
        assert.ok(catalogue.length > 0 && catalogue.length <= S2_INTERACTION_EVIDENCE_LIMITS.candidates);
        for (const item of catalogue) {
          assert.ok(item.quote.length >= 20 && item.quote.length <= 100);
          assert.ok(input.steps[item.turn - 1].reply.includes(item.quote), 'Every quote is genuine current full reply text');
        }
        for (const [index, step] of input.steps.entries()) {
          assert.ok(step.reply.startsWith(actualReplies[index]));
          assert.ok(input.actualReplies.includes(`ACTUAL_REPLY ${index + 1}\n${step.reply}\nEND_REPLY`), 'Complete actual replies are retained, not replaced by candidate snippets');
        }
        if (variant === 'short-heading-judge') {
          assert.ok(actualReplies[0].includes(shortHeading));
          assert.equal(shortHeading.length, 14);
          assert.ok(actualReplies[0].split('\n')[1].length >= 20, 'The judge has enough actual body evidence; a short heading must still be rejected');
        }
        const checks = S2_BUSINESS_INTERACTION_CHECKS.map(id => {
          const sourceTurn = id === 'criterion-grounding' ? 2 : id === 'pause-respected' || id === 'natural-language-control' ? 3 : 1;
          const entry = catalogue.find(item => item.turn === (variant === 'wrong-turn-judge' && id === 'skill-grounded-analogy' ? 2 : sourceTurn))!;
          assert.ok(entry);
          const check: Record<string, unknown> = { id,
          verdict: variant === 'scaffolding-unmet' && id === 'scaffolding-without-solution'
            || variant === 'fixed-phrase-unmet' && id === 'natural-language-control'
            || (variant === 'false-positive-scope' || variant === 'repeat-assessment-submission') && id === 'criterion-grounding' ? 'unmet' : 'met',
          evidenceId: variant === 'request-only-judge' ? 'query' : variant === 'unknown-evidence-id' ? 'unknown-candidate' : entry.id,
          reason: '故意乐观的离线桩，只验证证据与宿主事实门禁，不是模型语义验收结论。' };
          if (id === 'skill-grounded-analogy') {
            if (variant === 'short-heading-judge' || variant === 'm-free-quote-judge') {
              delete check.evidenceId; check.evidence = variant === 'short-heading-judge' ? shortHeading : mShortEvidence;
            }
            if (variant === 'self-filled-quote') check.quote = entry.quote;
            if (variant === 'extra-judge-field') check.confidence = 1;
          }
          return check;
        });
        return response(variant === 'invalid-judge' ? { checks: [] } : { checks });
      }
      assert.ok(String(input.stage).startsWith('turn-'), 'Never rebuild an accepted scene in interaction-only subset');
      if (input.stage === 'turn-understand') {
        if (turn === 1 && variant === 'budget-midway') throw new S2ValidationStop('approval-budget-exhausted');
        if (turn === 1 && variant === 'abort-midway') { controller.abort(); throw new DOMException('Stopped', 'AbortError'); }
        if (turn === 1 && variant === 'provider-error') throw new Error('secret synthetic provider credential detail must not escape');
        turn++; assert.equal(input.query, S2_BUSINESS_VALIDATION_CASE.queries[turn]);
        assert.equal(input.memoryEnabled, true); assert.equal(input.workingMemory.version, turn - 1);
        assert.equal(input.businessSkill.knowledge.length, 0);
        assert.ok(!request.userInput.includes('SyntheticSelectedKnowledgeMarker'));
        assert.ok(!request.userInput.includes('SyntheticUnselectedKnowledgeMarker'));
        return response({ understanding: '合成理解，不证明模型质量', desiredOutcome: '只回应不改图执行',
          actions: variant === 'unrequested-edit' && turn === 1 ? ['reply', 'edit'] : ['reply'], constraints: ['不运行'], questions: [],
          ...(variant === 'good' || variant === 'evaluation-trace' ? { assistance: 'scaffold' } : {}),
          ...(variant === 'evaluation-trace' ? { evaluation: turn === 2 ? 'criteria' : 'advice' } : {}),
          ...(turn === 1 && variant !== 'no-skill' ? { skillIds: ['Types'] } : {}) });
      }
      if (input.stage === 'turn-proposal-review') return response({ verdict: 'accept', reason: '错误放行的合成评审，只用于验证宿主门禁不能被自信覆盖',
        evidence: [{ sourceId: 'query', quote: '不改图' }] });
      assert.equal(input.stage, 'turn-act');
      if (variant === 'good' || variant === 'evaluation-trace') assert.equal(input.intent.assistance, 'scaffold', 'Semantic help depth reaches the real action stage unchanged');
      if (turn === 1 && variant !== 'no-skill') {
        assert.deepEqual(input.businessSkill.knowledge.map((item: { id: string }) => item.id), ['Types']);
        assert.ok(request.userInput.includes('SyntheticSelectedKnowledgeMarker'));
      }
      assert.ok(!request.userInput.includes('SyntheticUnselectedKnowledgeMarker'));
      const assessment = { criterionIds: ['SourceName', 'Meaning', 'Example'], judgments: [
        { criterionId: 'SourceName', verdict: variant === 'wrong-local' ? 'unmet' : 'met', reason: '不应相信本地指标的模型结论', evidence: [] },
        { criterionId: 'Meaning', verdict: 'unmet', reason: '原文混淆技术与业务', evidence: [variant === 'wrong-target'
          ? { sourceId: 'field:Input:content', quote: source }
          : { sourceId: 'field:Understanding:content', quote: variant === 'forged-evidence' ? '原文没有的伪造理解引文' : misconception }] },
        { criterionId: 'Example', verdict: 'unmet', reason: '建议加一个例子，但不是失败', evidence: [] },
      ] };
      return response({ understanding: '合成理解', plan: '只回应', reply: actualReplies[turn - 1],
        commands: variant === 'unrequested-edit' && turn === 1 ? [{ op: 'update-node', id: 'Understanding', values: { content: '不请自改' } }] : [],
        ...(turn === 2 && variant !== 'no-assessment' || turn === 3 && variant === 'pause-still-scores' ? { assessment } : {}) });
    } });
  assert.equal(JSON.stringify(definition), original);
  assert.equal(result.passed, false); assert.equal(result.buildAccepted, false); assert.equal(result.browserTested, false);
  assert.ok(result.notTested.includes('whole-chain')); assert.ok(result.notTested.includes('fresh-build'));
  assert.deepEqual(result.workflows, []); assert.deepEqual(result.receipts, []);
  assert.ok(artifacts.includes('business-interaction-host-facts'));
  return { result, calls, turn, judgeCalls };
}

const good = await run('good');
assert.equal(good.calls, 7); assert.equal(good.result.calls.production, 6); assert.equal(good.result.calls.independentReview, 1);
assert.equal(good.result.interactionSubsetPassed, true); assert.equal(good.result.steps.length, 3);
assert.equal(good.result.localChecks.memoryAcceptedAllTurns, true); assert.equal(good.result.localChecks.memoryClosedByUi, true);
assert.equal(good.result.steps[1].result.assessment?.overall, 'unmet');
assert.equal(good.result.localChecks.originalFieldsAndQuestionPreserved, true);
assert.equal(good.result.runtimeFrames.length, 6);
assert.deepEqual(good.result.runtimeFrames.filter(frame => frame.stage === 'turn-act').map(frame => frame.assistance), ['scaffold', 'scaffold', 'scaffold'],
  'Reports retain the actual optional assistance choice without imposing a new pass requirement');
assert.equal(good.result.reviewSchemaVersion, 5); assert.deepEqual(good.result.checkIds, [...S2_BUSINESS_INTERACTION_CHECKS]);
assert.ok(good.result.judge!.every(check => {
  const entry = good.result.evidenceCatalogue.find(item => item.id === check.evidenceId);
  return !!entry && check.evidence === entry.quote && good.result.steps[entry.turn - 1].result.reply.includes(check.evidence);
}), 'Report evidence is restored exactly from host-bound catalogue IDs, not model copied strings');
const evaluationTrace = await run('evaluation-trace');
assert.equal(evaluationTrace.result.interactionSubsetPassed, true);
assert.deepEqual(evaluationTrace.result.runtimeFrames.filter(frame => frame.stage === 'turn-act').map(frame => frame.evaluation), ['advice', 'criteria', 'advice'],
  'Reports preserve actual semantic evaluation choices without adding a keyword gate');
const wrongLocal = await run('wrong-local');
assert.equal(wrongLocal.result.interactionSubsetPassed, true);
assert.equal(wrongLocal.result.steps[1].result.assessment?.checks.find(item => item.method === 'local')?.verdict, 'met', 'Host recomputes local values despite wrong model verdict');
for (const variant of ['scaffolding-unmet', 'fixed-phrase-unmet', 'false-positive-scope', 'repeat-assessment-submission'] as const) {
  const checked = await run(variant);
  assert.equal(checked.calls, 7); assert.equal(checked.judgeCalls, 1);
  assert.equal(checked.result.reviewStatus, 'completed');
  assert.ok(Object.values(checked.result.localChecks).every(Boolean), 'These are independent teaching semantics failures despite valid host/protocol facts');
  assert.equal(checked.result.judge?.filter(item => item.verdict === 'unmet').length, 1);
  assert.equal(checked.result.interactionSubsetPassed, false, 'A failed teaching-semantic criterion must prevent subset acceptance');
}
for (const variant of ['no-skill', 'no-assessment', 'pause-still-scores', 'unrequested-edit'] as const) {
  const checked = await run(variant); assert.equal(checked.result.interactionSubsetPassed, false);
  assert.ok(checked.result.judge?.every(item => item.verdict === 'met'), 'Even a confident independent judge cannot override false host checks');
  if (variant === 'unrequested-edit') {
    assert.equal(checked.result.localChecks.turn1ReadOnly, false);
    assert.deepEqual(checked.result.steps[0].before, checked.result.steps[0].after, 'Unconfirmed malicious proposal never applied');
  }
}
for (const variant of ['forged-evidence', 'wrong-target'] as const) {
  const checked = await run(variant); assert.equal(checked.result.interactionSubsetPassed, false);
  assert.equal(checked.result.steps.length, 1); assert.equal(checked.judgeCalls, 0);
  assert.equal(checked.result.reviewStatus, 'skipped-incomplete-interaction-subset');
  assert.equal(checked.result.failure?.stage, 'interaction-2');
  assert.equal(checked.calls, 5, 'Existing one action-repair allowance preserved; no extra validation retry');
}
for (const variant of ['request-only-judge', 'short-heading-judge', 'm-free-quote-judge', 'unknown-evidence-id', 'wrong-turn-judge', 'self-filled-quote', 'extra-judge-field', 'invalid-judge'] as const) {
  const checked = await run(variant); assert.equal(checked.result.interactionSubsetPassed, false);
  assert.equal(checked.judgeCalls, 1, 'Never retry independent judge formatting');
  assert.equal(checked.result.stopped, 'invalid-independent-review'); assert.equal(checked.result.failure?.stage, 'independent-review');
}
for (const variant of ['no-body-evidence', 'judge-input-overflow'] as const) {
  const checked = await run(variant);
  assert.equal(checked.result.interactionSubsetPassed, false); assert.equal(checked.result.steps.length, 3);
  assert.equal(checked.calls, 6); assert.equal(checked.judgeCalls, 0); assert.equal(checked.result.calls.independentReview, 0);
  assert.equal(checked.result.stopped, variant === 'no-body-evidence' ? 'evidence-catalogue-empty' : 'independent-review-input-too-large');
  assert.equal(checked.result.reviewStatus, 'skipped-evidence-unavailable');
  assert.ok(checked.result.notTested.includes('independent-interaction-review'), 'Missing/oversized evidence is explicitly unreviewed, never silently dropped or treated as a model failure');
}
const budget = await run('budget-midway');
assert.equal(budget.result.stopped, 'approval-budget-exhausted'); assert.equal(budget.result.failure?.stage, 'interaction-2');
assert.equal(budget.result.steps.length, 1); assert.equal(budget.judgeCalls, 0);
assert.ok(budget.result.notTested.includes('read-only-interaction-2'));
const aborted = await run('abort-midway'); assert.equal(aborted.result.stopped, 'cancelled'); assert.equal(aborted.judgeCalls, 0);
const provider = await run('provider-error'); assert.equal(provider.result.stopped, 'business-interaction-stage-failed');
assert.ok(!JSON.stringify(provider.result).includes('secret synthetic provider'), 'Raw provider exceptions never appear in published diagnostic report');
console.log('S2 business interaction-only validation passed: normally 6 production calls + one independent judge; v5 host-compiled bounded body evidence catalogue, exact stable ID/turn/quote binding, full replies retained, heading exclusion and capacity boundaries, unknown/cross-turn IDs or free quote/extra fields rejected, empty evidence/oversized review fail before dispatch; actual UI memory/history/host lifecycle, selected real skill loading, private reference/rule isolation, host-recomputed assessment, grounded semantic/advisory/pause/teaching scope, optimistic judge cannot override host failures, existing production repair only and no judge retry. Offline synthetic stubs only, not real-model semantic acceptance, fresh build/full chain or browser E2E.');

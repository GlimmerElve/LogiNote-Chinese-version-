import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { buildReviewDraft, reviewDraftQuestionKey, displayReviewDraftQuestion, reviewDraftTutorPrompt } from '../src/services/reviewDraft';

// Execute the actual component handlers in memory. No mounted application, vault or model.
globalThis.fetch = async () => assert.fail('Review preview checks must never access the network');
const path = 'src/components/ReviewChat.tsx';
const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
function nodes(predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(source);
  return found;
}
function handler(name: string): string {
  const declaration = nodes((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === name)[0] as ts.VariableDeclaration;
  assert.ok(declaration?.initializer, `Missing ${name}`);
  return declaration.initializer.getText(source);
}
function execute<T = (...args: any[]) => any>(expression: string, environment: Record<string, unknown>): T {
  const javascript = ts.transpileModule(`const extracted = (${expression}); return extracted;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(environment), javascript)(...Object.values(environment)) as T;
}
function attribute(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string): string {
  const item = opening.attributes.properties.find((prop) => ts.isJsxAttribute(prop) && prop.name.getText(source) === name) as ts.JsxAttribute;
  assert.ok(item?.initializer, `Missing ${name}`);
  if (ts.isStringLiteral(item.initializer)) return JSON.stringify(item.initializer.text);
  assert.ok(ts.isJsxExpression(item.initializer) && item.initializer.expression);
  return item.initializer.expression.getText(source);
}
const openings = nodes((node) => ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) as (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[];
const selectionSurface = openings.find((opening) => opening.attributes.properties.some((item) => ts.isJsxAttribute(item)
  && item.name.getText(source) === 'data-selection-surface'))!;
assert.equal(execute(attribute(selectionSurface, 'data-selection-surface'), { previewOnly: true, message: { role: 'tutor' } }), undefined,
  'Preview text does not register a real learning evidence selection surface');
assert.equal(execute(attribute(selectionSurface, 'data-selection-surface'), { previewOnly: false, message: { role: 'tutor' } }), 'review');

for (const name of ['handleVoiceToggle', 'handleSendMessage', 'requestTutorSupport', 'handleEndSession']) {
  // Intentionally no service or state bindings: a preview must return before using them.
  await execute(handler(name), { previewOnly: true })('hint');
}
await assert.rejects(execute(handler('streamTutorResponse'), { previewOnly: true })('prompt'), /不调用导师模型/);
execute(handler('handleOpenMaterial'), { previewOnly: true })({ kind: 'resource', resource: { documentId: 'real-document', url: 'https://example.invalid' } });

for (const fragment of ['loadLearningEpisodes()', 'const installOpening', 'warmup();']) {
  const effect = nodes((node) => ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect'
    && Boolean(node.arguments[0]?.getText(source).includes(fragment)))[0] as ts.CallExpression;
  assert.ok(effect, `Missing preview-aware effect for ${fragment}`);
  execute(effect.arguments[0].getText(source), { previewOnly: true })();
}

const back = openings.find((opening) => opening.tagName.getText(source) === 'button'
  && opening.attributes.properties.some((item) => ts.isJsxAttribute(item) && item.name.getText(source) === 'aria-label'
    && item.initializer?.getText(source).includes('退出复习并保存')))!;
assert.ok(back, 'The compact return control must keep an accessible name when its text is hidden');
for (const name of ['aria-label', 'title']) {
  assert.equal(execute<string>(attribute(back, name), { isSavingCognition: false, exitSaveError: '' }), '退出复习并保存');
  assert.equal(execute<string>(attribute(back, name), { isSavingCognition: false, exitSaveError: 'failed' }), '重试保存并退出复习');
  assert.equal(execute<string>(attribute(back, name), { isSavingCognition: true, exitSaveError: '' }), '正在保存复习');
}

const idle = { materialOpen: { pending: false }, sessionEnded: false, isTutorResponding: false, isScoring: false, isSavingCognition: false, exitSaveError: '', modelReady: true,
  canEnd: true, hintLevel: 0, userInput: '已输入回答', material: { kind: 'resource' } };
for (const opening of openings.filter((item) => item.tagName.getText(source) === 'button')) {
  const disabled = opening.attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText(source) === 'disabled') as ts.JsxAttribute | undefined;
  if (!disabled?.initializer?.getText(source).includes('previewOnly')) continue;
  assert.equal(execute<boolean>(attribute(opening, 'disabled'), { ...idle, previewOnly: true }), true,
    'Every remote/voice/resource action uses native disabled semantics in preview');
  assert.equal(execute<boolean>(attribute(opening, 'disabled'), { ...idle, previewOnly: false }), false,
    'The production default retains its enabled behavior');
}

const previewFixture = ts.createSourceFile('ReviewExitDemoPage.tsx', readFileSync('src/components/ReviewExitDemoPage.tsx', 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
let isolatedFixture = false;
const visitFixture = (node: ts.Node) => {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(previewFixture) === 'ReviewChat') {
    isolatedFixture = node.attributes.properties.some((item) => ts.isJsxAttribute(item) && item.name.getText(previewFixture) === 'previewOnly' && !item.initializer);
  }
  ts.forEachChild(node, visitFixture);
};
visitFixture(previewFixture);
assert.ok(isolatedFixture, 'review-save must explicitly enable the isolated preview mode');

let rawAnswer = '', restored = 0, focus = 0, restoredHint = 0;
let restoredMaterials: string[] = [];
const originalDraft = '  第一行\n完整原文\n';
const originalContext = { version: 1 as const, questionText: '预览问题',
  questionIntent: { version: 1 as const, questionMessageId: 'tutor-0', knowledgeTargets: [] },
  hintLevel: 3 as const, consultedMaterialIds: ['note:preview-source'] };
const consumedDraftIdsRef = { current: new Set<string>() };
const restoreEnvironment = {
  buildReviewDraft, displayReviewDraftQuestion, draftAnswerRef: { current: undefined }, sessionIdRef: { current: 'restored-preview-session' },
  userInputRef: { current: '' }, recoverableDraft: { id: 'preview-draft', content: originalDraft, context: originalContext },
  recoverableContext: originalContext, isDiscardingDraft: false, tutorOperationRef: { current: false },
  isTutorResponding: false, isScoring: false, isSavingCognition: false, exitSaveError: '',
  draftMatchesQuestion: true, canResumeOriginalQuestion: false, consumedDraftIdsRef,
  isProjectReview: false, noteTitle: '预览知识点', lastQuestionIntentRef: { current: originalContext.questionIntent },
  lastIntentRef: { current: [] as string[] }, currentQuestionTextRef: { current: originalContext.questionText }, messages: [],
  updateUserInput: (value: string) => { rawAnswer = value; }, setRecoverableDraft: () => restored++,
  setHintLevel: (update: (current: number) => number) => { restoredHint = update(restoredHint); },
  setConsultedMaterialIds: (update: (current: string[]) => string[]) => { restoredMaterials = update(restoredMaterials); },
  setDraftPreviewOpen: () => {},
  answerInputRef: { current: { focus: () => focus++ } },
};
await execute(handler('handleRestoreDraft'), restoreEnvironment)();
assert.equal(rawAnswer, originalDraft);
assert.equal(restored, 1);
assert.equal(focus, 1);
assert.equal(restoredHint, 3);
assert.deepEqual(restoredMaterials, ['note:preview-source']);
assert.deepEqual([...consumedDraftIdsRef.current], ['preview-draft']);
await execute(handler('handleRestoreDraft'), { ...restoreEnvironment,
  recoverableDraft: { id: 'legacy', content: '旧原文' }, recoverableContext: undefined,
  updateUserInput: () => assert.fail('Legacy text without a question context must not be silently restored'),
})();
await execute(handler('handleRestoreDraft'), { ...restoreEnvironment, userInputRef: { current: '本轮新输入' },
  updateUserInput: () => assert.fail('Restoration must not replace a current answer'),
})();

const phases: [string, string][] = [];
const draftRef = { current: undefined as { id: string; content: string; timestamp: string } | undefined };
const finishLock = { current: false }, finishedRef = { current: false };
const poison = () => assert.fail('A preview must not reach a live service');
let exitCalls = 0, release!: () => void, savedEpisode: any;
let saving = false, exitError = '';
const completionGate = new Promise<void>((resolve) => { release = resolve; });
const environment = {
  materialOpen: { isBusy: () => false },
  allowCognitionLeave: () => true,
  previewOnly: true, finishLock, finishedRef, isScoring: false, isTutorResponding: false, isListening: true,
  isDiscardingDraft: false, buildReviewDraft, lastQuestionIntentRef: { current: originalContext.questionIntent },
  reviewDraftQuestionKey, reviewDraftTutorPrompt, currentQuestionTextRef: { current: originalContext.questionText },
  hintLevel: 0, consultedMaterialIds: [], consumedDraftIdsRef: { current: new Set<string>() },
  setIsSavingCognition: (value: boolean) => { saving = value; }, setCognitionError: () => {},
  setExitSaveError: (value: string) => { exitError = value; },
  onExitSaveStateChange: (phase: string, id: string) => phases.push([phase, id]),
  stopListening: poison, userInputRef: { current: `  ${'长原文'.repeat(300)}\n保留换行\n` }, draftAnswerRef: draftRef,
  sessionIdRef: { current: 'preview-review-stable-id' }, sessionStartedAtRef: { current: '2026-10-07T00:00:00Z' },
  finishEndedAtRef: { current: undefined }, reviewComparisonRef: { current: { summary: {} } },
  reviewMasteryRef: { current: undefined },
  reviewFeedbackRef: { current: undefined },
  recheckReviewComparisonSession: poison, reviewComparisonDependencies: {},
  openingQuestion: { cleanText: '预览问题' }, knowledgeContext: '模拟知识',
  messages: [{ id: 'question', role: 'tutor', content: '预览问题', timestamp: '2026-10-07T00:00:00Z' }],
  answerEvidenceRef: { current: [] }, summarizeReviewEvidence: poison,
  captureReviewCognition: poison, collectCognition: true, previewMessages: [], noteId: 'preview-note', noteTitle: '模拟',
  isProjectReview: false, finalAnalysis: null, segmentMasteryResults: [], recordReviewActivity: poison,
  onReviewComplete: async (_analysis: unknown, _segments: unknown, episode: any) => {
    exitCalls++; savedEpisode = episode; await completionGate;
    if (exitCalls === 1) throw new Error('模拟写入失败');
  },
};
const finish = execute(handler('handleFinishReview'), environment);
const pending = finish();
assert.deepEqual(phases, [['saving', 'preview-review-stable-id']], 'The host guard activates synchronously before any await');
assert.equal(saving, true);
await finish();
assert.equal(exitCalls, 1);
release(); await pending;
assert.equal(finishedRef.current, false);
assert.equal(saving, false);
assert.match(exitError, /回答和评分仍保留/);
assert.equal(savedEpisode.masteryEligible, false);
assert.equal(savedEpisode.draftAnswer.content, environment.userInputRef.current);
const firstDraft = { ...draftRef.current };
await finish();
assert.equal(exitCalls, 2);
assert.equal(finishedRef.current, true);
assert.deepEqual(draftRef.current, firstDraft, 'Preview retry preserves full raw draft and identity');
assert.deepEqual(phases, [['saving', 'preview-review-stable-id'], ['failed', 'preview-review-stable-id'],
  ['saving', 'preview-review-stable-id'], ['idle', 'preview-review-stable-id']]);

let hintedEpisode: any;
const lastHint = '先区分左右两侧的变化，再思考原题。';
await execute(handler('handleFinishReview'), { ...environment,
  finishLock: { current: false }, finishedRef: { current: false }, finishEndedAtRef: { current: undefined },
  draftAnswerRef: { current: undefined }, onExitSaveStateChange() {},
  messages: [...environment.messages, { id: 'hint', role: 'tutor', content: lastHint, timestamp: '2026-10-07T00:01:00Z' }],
  onReviewComplete: async (_analysis: unknown, _segments: unknown, episode: any) => { hintedEpisode = episode; },
})();
assert.equal(hintedEpisode.draftAnswer.context.questionText, originalContext.questionText, 'a tutor hint does not replace the original question');
assert.equal(hintedEpisode.draftAnswer.context.tutorPrompt, lastHint, 'the last tutor hint remains available as context');

// The guard also covers the earlier cognition-write stage, before App's record writer starts.
const cognitionPhases: [string, string][] = [];
let cognitionRelease!: () => void, realCompletions = 0;
const cognitionGate = new Promise<void>((resolve) => { cognitionRelease = resolve; });
const cognitionFinish = execute(handler('handleFinishReview'), {
  ...environment, previewOnly: false, isListening: false, finishLock: { current: false }, finishedRef: { current: false },
  reviewComparisonRef: { current: undefined }, setCognitionError: () => {}, summarizeReviewEvidence: () => ({ masteryEligible: false }),
  onExitSaveStateChange: (phase: string, id: string) => cognitionPhases.push([phase, id]),
  captureReviewCognition: async () => { await cognitionGate; throw new Error('候选未保存'); },
  onReviewComplete: () => { realCompletions++; },
});
const pendingCognition = cognitionFinish();
assert.deepEqual(cognitionPhases, [['saving', 'preview-review-stable-id']]);
cognitionRelease(); await pendingCognition;
assert.equal(realCompletions, 0);
assert.deepEqual(cognitionPhases, [['saving', 'preview-review-stable-id'], ['failed', 'preview-review-stable-id']]);
console.log('Review preview UI checks passed: request isolation, raw recovery, accessible return, and save-stage callbacks.');

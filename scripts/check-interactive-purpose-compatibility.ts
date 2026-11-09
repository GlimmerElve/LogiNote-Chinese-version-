import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InteractiveFigureStore, type FigureArtifact } from '../src/electron/interactiveFigureStore';
import { interactiveFigureKey, prepareInteractiveFigure, INTERACTIVE_FIGURE_PROMPT, PURPOSE_FIGURE_PROMPT } from '../src/services/textbook/interactiveFigure';
import { INTERACTIVE_FUNCTION_PROMPT } from '../src/services/textbook/interactiveFunctionFigure';
import { figureTeachingModeGuidance, type FigureTeachingMode } from '../src/services/textbook/interactiveFigurePedagogy';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
await mkdir('build', { recursive: true });
const root = await mkdtemp(path.resolve('build/interactive-purpose-compatibility-'));
type Dependencies = NonNullable<Parameters<typeof prepareInteractiveFigure>[4]>;
type Request = Parameters<Dependencies['generate']>[0];
const requests: Array<{ purpose: string; promptLength: number; mode?: FigureTeachingMode; clock: boolean }> = [];
const approval = { projectId: 'synthetic-purpose-project', legacy: false, teachingPolicy: 1 as const };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const fileFor = (key: string) => path.join(root, 'interactive-figures', `${key}.json`);

function apiFor(store: InteractiveFigureStore): Dependencies['api'] {
  // Real disk store, fake display boundary: this test never starts Electron or a model.
  return {
    read: key => store.read(key), write: (key, value) => store.write(key, value),
    open: async () => ({ processId: 1 }), bounds: async () => {}, visible: async () => {},
    close: async () => {}, onFailure: () => () => {},
  };
}

function design(anchor: string, prediction = false) {
  return { anchor, goal: '理解教材的这一个条件', action: '操作并观察可见状态', observation: '比较操作前后的变化',
    model: '本例只按合成教材的已知规则演示', caveat: '合成离线验收；不是学科正确性证明', transfer: '条件改变时，哪些关系需要重新核对？',
    ...(prediction ? { prediction: '先判断操作后的状态' } : {}) };
}

const visual = '<svg viewBox="0 0 100 50"><circle cx="25" cy="25" r="6"/><line x1="5" y1="40" x2="95" y2="40"/></svg>';
const legacyHtml = `<section>${visual}<input data-figure="prediction"><button data-figure="check">检查</button><button data-figure="reset">重置</button><p data-figure="transfer">换一个条件</p><button>改变状态</button></section>`;
function htmlFor(mode: FigureTeachingMode, broken = false): string {
  const shared = `${visual}<button data-figure="reset">重置</button><output data-figure="result" aria-live="polite">合成结果</output>`;
  const controls = mode === 'dynamic'
    ? `<button data-figure="play">播放</button>${broken ? '' : '<button data-figure="pause">暂停</button>'}<input data-figure="time" type="range" min="0" max="1">`
    : mode === 'step' ? '<button data-figure="step">下一步</button><p data-figure="state">初始状态</p>'
    : mode === 'contrast' ? '<label>共同输入<input type="range"></label><div data-figure="case">同材料假设甲</div><div data-figure="case">同材料假设乙</div>'
    : '<input data-figure="prediction"><button data-figure="check">检查</button><p data-figure="transfer">换个条件</p>';
  return `<section data-figure-theme-aware="true" data-figure-mode="${mode}">${shared}${controls}</section>`;
}

function capture(request: Request, purpose: string, mode?: FigureTeachingMode): string {
  const prompt = request.systemPromptOverride || '';
  requests.push({ purpose, promptLength: prompt.length, ...(mode ? { mode } : {}), clock: prompt.includes('window.TeachingClock') });
  if (mode) {
    assert.ok(prompt.includes(PURPOSE_FIGURE_PROMPT), `${purpose}: new shared base is loaded`);
    assert.ok(prompt.includes(figureTeachingModeGuidance(mode)), `${purpose}: only selected guidance is loaded`);
    assert.ok(prompt.length <= INTERACTIVE_FIGURE_PROMPT.length + 700, `${purpose}: bounded prompt ${prompt.length}`);
    for (const other of ['dynamic', 'step', 'contrast', 'prediction'] as const) {
      if (other !== mode) assert.ok(!prompt.includes(`data-figure-mode="${other}"`), `${purpose}: no unselected ${other} guide`);
    }
    if (mode !== 'prediction') {
      assert.ok(!prompt.includes('先预测同一具体情境的结果'), `${purpose}: legacy prediction contract is not injected`);
      assert.ok(!prompt.includes('图中预测问题必须与 design.prediction 一致'), `${purpose}: no chemistry quiz override`);
    }
    assert.equal(prompt.includes('window.TeachingClock'), mode === 'dynamic', 'clock guidance is disclosed only for a dynamic stage');
  }
  return prompt;
}

// A fresh call without the new policy stays on the old generic contract.
let store = new InteractiveFigureStore(root);
const oldBrief = '动态演示摆球随时间的位置变化';
const oldBody = `# 合成旧版教材\n${oldBrief}。本图只表示位置随时间改变的定性过程。`;
const oldKey = await interactiveFigureKey('old-generic', oldBody, oldBrief);
let oldGenericPromptLength = 0;
await prepareInteractiveFigure(oldKey, oldBody, oldBrief, false, { api: apiFor(store), generate: async request => {
  const prompt = capture(request, 'fresh-without-policy'); oldGenericPromptLength = prompt.length;
  assert.ok(prompt.startsWith(INTERACTIVE_FIGURE_PROMPT));
  assert.ok(prompt.includes('先预测同一具体情境的结果'));
  assert.ok(!prompt.includes(PURPOSE_FIGURE_PROMPT) && !prompt.includes('window.TeachingClock'));
  return { content: JSON.stringify({ design: design(oldBrief, true), html: legacyHtml }) };
} });
const originalReady = await store.read(oldKey), originalSummary = await store.describe(oldKey);
assert.ok(originalReady?.status === 'ready' && !originalReady.design?.teachingMode);

// The newly chosen dynamic mode is reserved before generation, retained on failure,
// then recovered through a new store instance without the caller sending policy again.
const mathBrief = '动态演示函数曲线 y=sin(t) 与点随时间运动';
const mathBody = `# 数学运动示意\n${mathBrief}。已知 y=sin(t)，t 表示时间，观察区间为 0 到 6。`;
const mathKey = await interactiveFigureKey('new-dynamic-math', mathBody, mathBrief);
await assert.rejects(prepareInteractiveFigure(mathKey, mathBody, mathBrief, false, { api: apiFor(store), generate: async request => {
  const pending = await store.read(mathKey);
  assert.ok(pending?.status === 'pending' && pending.teachingMode === 'dynamic', 'reserve the selected mode before generating');
  const prompt = capture(request, 'dynamic-math-fails', 'dynamic');
  assert.ok(!prompt.startsWith(INTERACTIVE_FUNCTION_PROMPT) && !prompt.includes('本地程序负责曲线、坐标、刻度、滑块和预测题'), 'an explicit time goal is not captured by the local function exercise');
  return { content: JSON.stringify({ design: design(mathBrief), html: htmlFor('dynamic', true) }) };
} }, approval), /动态演示缺少播放、暂停/u);
const failed = await store.read(mathKey);
assert.ok(failed?.status === 'failed' && failed.teachingMode === 'dynamic' && failed.draftHtml, 'failure retains the new mode and recoverable draft');
store = new InteractiveFigureStore(root);
assert.equal(await interactiveFigureKey('new-dynamic-math', mathBody, mathBrief), mathKey, 'the same page and purpose restore the same attachment');
await prepareInteractiveFigure(mathKey, mathBody, mathBrief, true, { api: apiFor(store), generate: async request => {
  capture(request, 'dynamic-math-resume-no-policy', 'dynamic');
  const input = JSON.parse(request.userInput || '{}');
  assert.equal(input.repair.html, failed.draftHtml, 'retry receives the saved local draft');
  return { content: JSON.stringify({ design: design(mathBrief), html: htmlFor('dynamic') }) };
} });
const dynamicReady = await store.read(mathKey);
assert.ok(dynamicReady?.status === 'ready' && dynamicReady.design?.teachingMode === 'dynamic');
assert.equal(dynamicReady.design.prediction, '', 'a new non-quiz design is accepted without prediction text');

// A new pending reservation also survives restart without an authorization flag.
const stepBrief = '逐步执行队列状态转移', stepBody = `# 合成队列\n${stepBrief}，只展示教材给定的初始状态与一次入队。`;
const stepKey = await interactiveFigureKey('saved-new-pending', stepBody, stepBrief);
await store.write(stepKey, { status: 'pending', teachingMode: 'step' });
store = new InteractiveFigureStore(root);
await prepareInteractiveFigure(stepKey, stepBody, stepBrief, true, { api: apiFor(store), generate: async request => {
  capture(request, 'step-pending-resume-no-policy', 'step');
  return { content: JSON.stringify({ design: design(stepBrief), html: htmlFor('step') }) };
} });
assert.equal((await store.read(stepKey) as Extract<FigureArtifact, { status: 'ready' }>).design?.teachingMode, 'step');

// New explanatory comparisons may discuss historical "mental chemistry" without
// inheriting chemical prediction questions or the old mandatory quiz contract.
const psychologyBrief = '对照心理化学与元素分析对同一经验的解释';
const psychologyBody = `# 心理化学\n${psychologyBrief}。同一材料可在不同理论假设下被解释，不据此宣称实验验证。`;
const psychologyKey = await interactiveFigureKey('new-psychology', psychologyBody, psychologyBrief);
await prepareInteractiveFigure(psychologyKey, psychologyBody, psychologyBrief, false, { api: apiFor(store), generate: async request => {
  const prompt = capture(request, 'psychology-contrast', 'contrast');
  assert.ok(!prompt.includes('重置后清除预测和反馈') && !prompt.includes('图中预测问题必须'));
  return { content: JSON.stringify({ design: design(psychologyBrief), html: htmlFor('contrast') }) };
} }, approval);
const psychologyReady = await store.read(psychologyKey);
assert.ok(psychologyReady?.status === 'ready' && !psychologyReady.html.includes('data-local-prediction-gate'), 'historical psychology remains an ungated comparison');

// Explicit predictions retain their dedicated controls under the new policy.
const predictionBrief = '先预测结果，再操作检验', predictionBody = `# 合成论断\n${predictionBrief}，本例只改变一个可见状态。`;
const predictionKey = await interactiveFigureKey('new-prediction', predictionBody, predictionBrief);
await prepareInteractiveFigure(predictionKey, predictionBody, predictionBrief, false, { api: apiFor(store), generate: async request => {
  capture(request, 'explicit-prediction', 'prediction');
  return { content: JSON.stringify({ design: design(predictionBrief, true), html: htmlFor('prediction') }) };
} }, approval);

// Old failed drafts must not silently upgrade even when the caller now authorizes
// the new policy. Preserve their old prompt and send the same draft for repair.
const failedOldKey = await interactiveFigureKey('old-failed', oldBody, oldBrief);
await store.write(failedOldKey, { status: 'failed', error: '旧任务未完成', draftHtml: legacyHtml });
store = new InteractiveFigureStore(root);
await prepareInteractiveFigure(failedOldKey, oldBody, oldBrief, true, { api: apiFor(store), generate: async request => {
  const prompt = capture(request, 'old-failed-stays-legacy');
  assert.ok(prompt.startsWith(INTERACTIVE_FIGURE_PROMPT) && prompt.includes('先预测同一具体情境的结果'));
  assert.ok(!prompt.includes(PURPOSE_FIGURE_PROMPT) && !prompt.includes('window.TeachingClock'));
  assert.equal(JSON.parse(request.userInput || '{}').repair.html, legacyHtml);
  return { content: JSON.stringify({ design: design(oldBrief, true), html: legacyHtml }) };
} }, approval);
const recoveredOld = await store.read(failedOldKey);
assert.ok(recoveredOld?.status === 'ready' && !recoveredOld.design?.teachingMode);

// Opening already-ready attachments performs no generation or file rewrite. Test
// both protocols across a fresh store, including old summaries and file digests.
for (const [key, body, brief] of [[oldKey, oldBody, oldBrief], [mathKey, mathBody, mathBrief]] as const) {
  const before = await readFile(fileFor(key), 'utf8'), summary = await store.describe(key);
  store = new InteractiveFigureStore(root);
  const reopened = await prepareInteractiveFigure(key, body, brief, false, { api: apiFor(store), generate: async () => { throw Error('opening ready figures must not request a model'); } }, approval);
  const artifact = await store.read(key);
  assert.ok(artifact?.status === 'ready' && reopened === artifact.html);
  assert.equal(digest(await readFile(fileFor(key), 'utf8')), digest(before), 'ready attachment bytes are not rewritten');
  assert.deepEqual(await store.describe(key), summary, 'opening preserves the resource summary');
}
assert.deepEqual(await store.read(oldKey), originalReady);
assert.deepEqual(await store.describe(oldKey), originalSummary);

// Comparison synonyms and a whole-page purpose heading must not be captured by
// the old local function exercise merely because the source contains formulas.
const contrastBrief = '对比函数 y=x^2 和 y=x^3 的图像';
const contrastBody = `# 两个函数\n${contrastBrief}。同一输入 x 分别代入两个函数，比较输出差异。`;
const contrastKey = await interactiveFigureKey('contrast-math-synonym', contrastBody, contrastBrief);
await prepareInteractiveFigure(contrastKey, contrastBody, contrastBrief, false, { api: apiFor(store), generate: async request => {
  const prompt = capture(request, 'contrast-math-synonym', 'contrast');
  assert.ok(!prompt.includes('本地程序负责曲线、坐标、刻度、滑块和预测题'), 'an explicit comparison owns the teaching format');
  return { content: JSON.stringify({ design: design(contrastBrief), html: htmlFor('contrast') }) };
} }, approval);
assert.equal((await store.read(contrastKey) as Extract<FigureArtifact, { status: 'ready' }>).design?.teachingMode, 'contrast');

const pageBrief = '根据本页教材的核心内容生成交互图。';
const pageAnchor = '同一输入 x 分别代入两个函数，比较输出差异。';
const pageBody = `# 对比函数 y=x^2 与 y=x^3\n${pageAnchor}`;
const pageKey = await interactiveFigureKey('contrast-math-page', pageBody, pageBrief);
await prepareInteractiveFigure(pageKey, pageBody, pageBrief, false, { api: apiFor(store), generate: async request => {
  const prompt = capture(request, 'contrast-whole-page-heading', 'contrast');
  assert.ok(!prompt.includes('本地程序负责曲线、坐标、刻度、滑块和预测题'), 'the whole-page comparison heading overrides the old function match');
  return { content: JSON.stringify({ design: design(pageAnchor), html: htmlFor('contrast') }) };
} }, approval, { before: '', after: '', wholePage: true });
assert.equal((await store.read(pageKey) as Extract<FigureArtifact, { status: 'ready' }>).design?.teachingMode, 'contrast');

// An explicit regeneration of a successful old figure is a new request. This
// differs from reopening a ready figure or repairing an unfinished legacy draft.
const regenerationBrief = '对照两种解释对同一现象的判断';
const regenerationBody = `# 合成解释对照\n${regenerationBrief}，保持输入材料不变。`;
const regenerationKey = await interactiveFigureKey('old-ready-explicit-regeneration', regenerationBody, regenerationBrief);
await store.write(regenerationKey, { status: 'ready', html: legacyHtml, design: { kind: 'general', ...design(regenerationBrief, true) } });
assert.ok(!(await store.read(regenerationKey) as Extract<FigureArtifact, { status: 'ready' }>).design?.teachingMode);
await prepareInteractiveFigure(regenerationKey, regenerationBody, regenerationBrief, true, { api: apiFor(store), generate: async request => {
  capture(request, 'old-ready-explicit-regeneration', 'contrast');
  return { content: JSON.stringify({ design: design(regenerationBrief), html: htmlFor('contrast') }) };
} }, approval);
const regenerated = await store.read(regenerationKey);
assert.ok(regenerated?.status === 'ready' && regenerated.design?.teachingMode === 'contrast');
assert.equal(regenerated.design.prediction, '', 'explicit regeneration can replace the old quiz with a new explanatory contrast');

// Mode metadata is part of the real on-disk integrity boundary.
const tamperKey = await interactiveFigureKey('mode-integrity', 'synthetic', 'purpose');
await store.write(tamperKey, { status: 'pending', teachingMode: 'dynamic' });
const tampered = JSON.parse(await readFile(fileFor(tamperKey), 'utf8'));
tampered.teachingMode = 'contrast';
await writeFile(fileFor(tamperKey), JSON.stringify(tampered));
await assert.rejects(new InteractiveFigureStore(root).read(tamperKey), /教学方式校验失败/u);

const report = { kind: 'mock-generation-real-file-store', realModelRequests: 0, nativeSandbox: false, oldBasePromptLength: INTERACTIVE_FIGURE_PROMPT.length,
  oldActualGenericPromptLength: oldGenericPromptLength, purposeBasePromptLength: PURPOSE_FIGURE_PROMPT.length, requests,
  promptLimit: INTERACTIVE_FIGURE_PROMPT.length + 700, passed: true };
await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
console.log(`PASS new dynamic/step/contrast/prediction, math comparison and whole-page purposes, failed/pending restart, legacy draft freeze, unchanged ready digests, explicit regeneration, scoped prompts and mode integrity; ${requests.length} mocked requests, 0 real model requests`);
console.log(`Prompt lengths: old base ${report.oldBasePromptLength}, old actual ${oldGenericPromptLength}, new base ${report.purposeBasePromptLength}; new actual ${requests.filter(item => item.mode).map(item => `${item.mode}:${item.promptLength}`).join(', ')}; limit ${report.promptLimit}`);
console.log(`Report: ${path.join(root, 'report.json')}`);

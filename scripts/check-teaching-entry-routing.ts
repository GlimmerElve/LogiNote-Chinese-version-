/** Actual right-click input shapes; no page-title concatenation, native browser,
 * remote model, or network. Scope text is equivalent bounded source text. */
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareInteractiveFigure, interactiveFigureKey, figureLesson, PURPOSE_FIGURE_PROMPT } from '../src/services/textbook/interactiveFigure';
import { explicitFigureTeachingMode, selectFigureTeachingMode } from '../src/services/textbook/interactiveFigurePedagogy';
import { selectEntryTeachingModelType, teachingModelMode, teachingModelPrompt } from '../src/services/textbook/teachingModelProtocol';
import type { TeachingModelType } from '../src/services/textbook/teachingModelTypes';
import { InteractiveFigureStore } from '../src/electron/interactiveFigureStore';
import { findInteractiveFigure } from '../src/services/textbook/interactiveFigureMarker';
import { INTERACTIVE_DISCIPLINE_CASES } from './fixtures/interactive-purpose-disciplines';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const oldFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Entry routing acceptance must remain offline');
await mkdir('build', { recursive: true });
const directory = await mkdtemp(path.resolve('build/teaching-entry-routing-'));
const report: any = { passed: false, realModelRequests: 0, nativeRendered: false, mockedRequests: 0, audit: [], generated: [], checks: [] };
const wholeBrief = '根据本页教材的核心内容生成交互图。';
const policy = { projectId: 'synthetic-entry', legacy: false, teachingPolicy: 2 as const };
type Dependencies = NonNullable<Parameters<typeof prepareInteractiveFigure>[4]>;
type Scope = NonNullable<Parameters<typeof prepareInteractiveFigure>[6]>;
const types: TeachingModelType[] = ['area', 'oscillator', 'lru', 'grouping', 'reaction', 'knapsack', 'attention'];
const configs: unknown[] = [
  { expression: 'x^2', variable: 'x', domain: [0, 1], minCount: 2, maxCount: 40, method: 'midpoint', exactIntegral: 1 / 3 },
  { mass: .5, stiffness: 8, amplitude: .1 },
  { capacity: 3, initial: ['A', 'B', 'C'], accesses: ['B', 'D', 'A', 'C'] },
  { positions: [60, 100, 140, 180, 220, 260], colors: ['green', 'red', 'green', 'red', 'green', 'red'], gapIndex: 3, gapRange: [40, 160], initialGap: 40, threshold: 60 },
  { reactants: [{ label: 'H₂', coefficient: 2, count: 4, atoms: { H: 2 } }, { label: 'O₂', coefficient: 1, count: 3, atoms: { O: 2 } }], products: [{ label: 'H₂O', coefficient: 2, atoms: { H: 2, O: 1 } }] },
  { capacity: 4, items: [{ weight: 1, value: 15 }, { weight: 3, value: 20 }, { weight: 4, value: 30 }] },
  { queries: [[1, 0], [0, 1]], keys: [[1, 0], [0, 1], [1, 1]], values: [[1, 0], [0, 2], [2, 1]] },
];
const shortSelections = ['误差 1/3−Sₙ=1/(12n²)', '理想水平弹簧振子', 'LRU', '颜色固定交替', '2H₂+O₂→2H₂O', 'dp[j]=max(dp[j],dp[j−w]+v)', 'softmax'];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function scopeFor(body: string, brief: string, wholePage = false): Scope {
  if (wholePage) return { before: '', after: '', wholePage: true };
  const index = body.indexOf(brief); assert.ok(index >= 0, 'selection exists in the displayed source');
  return { before: body.slice(0, index).slice(-500), after: body.slice(index + brief.length, index + brief.length + 500) };
}
function api(store: InteractiveFigureStore): Dependencies['api'] {
  return { read: key => store.read(key), write: (key, value) => store.write(key, value), open: async () => ({ processId: 1 }), bounds: async () => {}, visible: async () => {}, close: async () => {}, onFailure: () => () => {} };
}
function audit(label: string, body: string, selected: string, wholePage = false, automatic = false) {
  const brief = wholePage ? wholeBrief : selected;
  const context = figureLesson(body, brief, automatic ? undefined : scopeFor(body, brief, wholePage));
  const proposed = selectEntryTeachingModelType(brief, context, wholePage, !wholePage && !automatic), requested = explicitFigureTeachingMode(brief);
  const mode = selectFigureTeachingMode(brief, context, wholePage);
  const admitted = proposed && (!requested || teachingModelMode(proposed) === mode) ? proposed : undefined;
  report.audit.push({ label, brief, wholePage, proposedModel: proposed || null, explicitMode: requested || null, admittedModel: admitted || null, mode: admitted ? teachingModelMode(admitted) : mode });
  return admitted;
}
const dynamicHtml = '<section data-figure-mode="dynamic"><button data-figure="play">播放</button><button data-figure="pause">暂停</button><button data-figure="reset">重置</button><input data-figure="time" type="range"><output data-figure="result">结果</output></section>';
const contrastHtml = '<section data-figure-mode="contrast"><button data-figure="reset">重置</button><input type="range"><div data-figure="case">同一输入的情况一</div><div data-figure="case">同一输入的情况二</div><output data-figure="result">结果</output></section>';
const oldDesign = (anchor: string) => ({ anchor, goal: '观察当前合成材料', action: '改变状态', observation: '比较状态', model: '以原文为准', caveat: '合成示意', transfer: '改变一个条件后如何变化' });

try {
  let store = new InteractiveFigureStore(directory);
  for (let index = 0; index < INTERACTIVE_DISCIPLINE_CASES.length; index++) {
    const item = INTERACTIVE_DISCIPLINE_CASES[index], type = types[index];
    // First fourteen routing checks replay the previous audit controls exactly.
    assert.equal(audit(`fixture explicit purpose / ${item.id}`, item.lesson + '\n' + item.brief, item.brief), type);
    assert.equal(audit(`whole page with separate title / ${item.id}`, item.lesson, '', true), type);
    for (const kind of ['selection', 'whole-page'] as const) {
      // The visible title is deliberately kept out of body, as the real reader does.
      const body = item.lesson, brief = kind === 'selection' ? shortSelections[index] : wholeBrief;
      const scope = scopeFor(body, brief, kind === 'whole-page'), bodyBefore = digest(body);
      const key = await interactiveFigureKey(`${item.id}-${kind}`, body, brief);
      const html = await prepareInteractiveFigure(key, body, brief, false, { api: api(store), generate: async request => {
        report.mockedRequests++; assert.equal(request.systemPromptOverride, teachingModelPrompt(type));
        const input = JSON.parse(request.userInput || '{}');
        assert.ok(!input.lesson.startsWith('# ' + item.title), 'routing does not rely on appending the separate page title');
        return { content: JSON.stringify({ title: item.title, design: { anchor: kind === 'selection' ? brief : input.lesson.slice(0, input.lesson.indexOf('。') + 1), goal: item.objective }, basis: input.lesson, component: { type, config: configs[index] } }) };
      } }, policy, scope);
      const saved = await store.read(key); assert.ok(saved?.status === 'ready');
      assert.equal(saved.design?.modelType, type); assert.equal(saved.design?.teachingMode, item.expectedMode); assert.ok(html.includes('data-teaching-stage='));
      const file = path.join(directory, 'interactive-figures', `${key}.json`), bytes = await readFile(file, 'utf8');
      store = new InteractiveFigureStore(directory);
      await prepareInteractiveFigure(key, body, brief, false, { api: api(store), generate: async () => assert.fail('ready entry reopen must not request a model') }, policy, scope);
      assert.equal(await readFile(file, 'utf8'), bytes); assert.equal(digest(body), bodyBefore);
      report.generated.push({ source: item.id, entry: kind, modelType: type, mode: item.expectedMode, readyReopenUnchanged: true });
    }
  }
  // Replay the earlier six generated-physics inputs, preserving body-only data.
  for (const id of ['4MVDOb', 'E8dneD', 'K1pzPW']) {
    const source = `build/progressive-phase1-model-${id}/original-course.json`;
    const course = JSON.parse(await readFile(source, 'utf8')), page = course.page || course.firstPage;
    assert.equal(audit(`real generated page / ${page.title}`, page.body, '', true), 'oscillator');
    if (id === '4MVDOb') {
      assert.equal(audit('actual physics neutral selected claim', page.body, '合力为零只说明此刻加速度为零，不说明速度为零'), undefined, 'a neutral introductory claim does not import the following model subsection');
      assert.equal(audit('actual physics short mechanism selection', page.body, '理想水平弹簧振子'), 'oscillator');
      const planned = findInteractiveFigure(page.body)!; assert.ok(planned);
      assert.equal(audit('actual physics planned exploration marker', page.body, planned, false, true), undefined, 'the time-only oscillator component cannot replace an amplitude/phase exploration');
    }
  }
  const previousSelections = [[0, 'Sₙ=1/3−1/(12n²)'], [2, 'LRU'], [3, '接近与相似'], [4, '2H₂+O₂→2H₂O'], [5, 'dp[j]=max(dp[j],dp[j−w]+v)'], [6, 'softmax']] as const;
  for (const [index, selected] of previousSelections) {
    const item = INTERACTIVE_DISCIPLINE_CASES[index];
    assert.equal(audit(`short/formula selection / ${item.id}`, item.lesson + '\n' + selected, selected), types[index]);
  }
  assert.equal(report.audit.length, 26);
  report.checks.push('26 previous targeted inputs are replayed; supported entries route locally while isolated neutral introductory text and unsupported amplitude/phase exploration remain conservative fallbacks; 14 actual prepare/store calls cover short selections and body-only whole-page entries across all seven sources');

  // Conservative context inference: no cross-chapter, comment, or code-example routing.
  assert.equal(selectEntryTeachingModelType(wholeBrief, 'LRU 与弹簧振子分别是两个不同机制。', true), undefined);
  assert.equal(selectEntryTeachingModelType(wholeBrief, '只有一般解释，没有可识别的局部机制或参数。', true), undefined);
  for (const hidden of ['<!-- LRU 缓存访问 -->', '```md\n# 弹簧振子\n```', '~~~md\n# 化学计量\n~~~', '> ```md\n> # 单头注意力\n> ```']) {
    assert.equal(selectEntryTeachingModelType(wholeBrief, `# 一般介绍\n${hidden}\n材料没有给出特定机制。`, true), undefined);
  }
  const local = '这里仅讨论一个观察与解释的区别。';
  const remote = 'LRU 缓存访问\n' + '无关背景。'.repeat(700) + '\n' + local;
  assert.equal(selectEntryTeachingModelType(local, remote), undefined, 'automatic context stays within the anchor neighborhood');
  assert.equal(selectEntryTeachingModelType(local, figureLesson(remote, local, scopeFor(remote, local))), undefined, 'manual selected scope cannot read another chapter');
  assert.equal(selectEntryTeachingModelType(local, `# 同一页\n## 算法\nLRU缓存访问。\n## 解释\n${local}`, false, true), undefined, 'a selected subsection does not borrow a different subsection model');
  assert.equal(selectEntryTeachingModelType('讨论导数和切线', '中点矩形用于近似面积。\n讨论导数和切线'), undefined, 'an area kit cannot stand in for derivative/tangent work');
  const physical = INTERACTIVE_DISCIPLINE_CASES[1], lru = INTERACTIVE_DISCIPLINE_CASES[2];
  for (const item of [
    { brief: '明确对比弹簧振子两种初态的解释', lesson: physical.lesson, mode: 'contrast', html: contrastHtml },
    { brief: '动态演示 LRU 缓存访问时条目如何移动', lesson: lru.lesson, mode: 'dynamic', html: dynamicHtml },
  ] as const) {
    const body = item.lesson + '\n' + item.brief, key = await interactiveFigureKey(item.brief, body, item.brief);
    await prepareInteractiveFigure(key, body, item.brief, false, { api: api(store), generate: async request => {
      report.mockedRequests++; assert.ok(request.systemPromptOverride?.startsWith(PURPOSE_FIGURE_PROMPT));
      assert.ok(request.systemPromptOverride?.includes(`data-figure-mode="${item.mode}"`));
      return { content: JSON.stringify({ design: oldDesign(item.brief), html: item.html }) };
    } }, policy, scopeFor(body, item.brief));
    const saved = await store.read(key); assert.ok(saved?.status === 'ready' && saved.design?.teachingMode === item.mode && !saved.design?.modelType);
  }
  report.checks.push('multiple mechanisms/unknown prose do not guess; fenced and commented examples are ignored; a local selection does not import a remote chapter; explicit teaching modes override component defaults');

  // Old policy1 reservations keep their HTML prompt even if the newer classifier
  // can now identify the mechanism from short text or a default whole-page request.
  for (const pending of [false, true]) {
    const body = physical.lesson, brief = wholeBrief, key = await interactiveFigureKey(`policy1-frozen-${pending}`, body, brief);
    if (pending) await store.write(key, { status: 'failed', teachingMode: 'dynamic', error: '旧policy1草稿' });
    await prepareInteractiveFigure(key, body, brief, pending, { api: api(new InteractiveFigureStore(directory)), generate: async request => {
      report.mockedRequests++; assert.ok(request.systemPromptOverride?.startsWith(PURPOSE_FIGURE_PROMPT));
      return { content: JSON.stringify({ design: oldDesign(body.slice(0, body.indexOf('。') + 1)), html: pending ? dynamicHtml : contrastHtml }) };
    } }, pending ? policy : { ...policy, teachingPolicy: 1 }, { before: '', after: '', wholePage: true });
    const saved = await store.read(key); assert.ok(saved?.status === 'ready' && !saved.design?.modelType);
  }
  // Identifying a noun does not authorize inventing missing numerical facts.
  const noFacts = '本页仅提到弹簧振子，没有提供质量、劲度与振幅的数值。', noFactsKey = await interactiveFigureKey('missing-parameters', noFacts, wholeBrief);
  await assert.rejects(prepareInteractiveFigure(noFactsKey, noFacts, wholeBrief, false, { api: api(store), generate: async request => {
    report.mockedRequests++; assert.equal(request.systemPromptOverride, teachingModelPrompt('oscillator'));
    return { content: JSON.stringify({ title: '资料不足', design: { anchor: noFacts, goal: '观察运动' }, basis: noFacts, component: { type: 'oscillator', config: configs[1] } }) };
  } }, policy, { before: '', after: '', wholePage: true }), /参数未能对应原文/u);
  assert.equal((await store.read(noFactsKey))?.status, 'failed', 'unsupported invented data cannot publish a ready component');
  report.checks.push('legacy policy1 reservations stay frozen; a mechanism noun without supplied numbers cannot publish an invented numeric component');
  report.passed = true;
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); throw error; }
finally {
  globalThis.fetch = oldFetch;
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Report: ${path.join(directory, 'report.json')}`);
}
console.log(`PASS 26 routing inputs, ${report.generated.length} real prepare/store entry paths, negative controls and policy1 freeze; ${report.mockedRequests} mocked requests, 0 remote requests`);

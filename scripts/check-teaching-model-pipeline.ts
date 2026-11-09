/** Policy-2 integration through the real prepare/store path. Synthetic responses
 * only; this script neither launches Electron nor contacts a model or network. */
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InteractiveFigureStore, type FigureArtifact } from '../src/electron/interactiveFigureStore';
import { prepareInteractiveFigure, interactiveFigureKey, INTERACTIVE_FIGURE_PROMPT, PURPOSE_FIGURE_PROMPT } from '../src/services/textbook/interactiveFigure';
import { selectTeachingModelType, teachingModelMode, teachingModelPrompt, buildTeachingModel } from '../src/services/textbook/teachingModelProtocol';
import type { TeachingModelType } from '../src/services/textbook/teachingModelTypes';
import { findInteractiveFigure, findInteractiveFigureEntries } from '../src/services/textbook/interactiveFigureMarker';
import { INTERACTIVE_DISCIPLINE_CASES, type InteractiveDisciplineCase } from './fixtures/interactive-purpose-disciplines';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const priorFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Offline policy integration may not access a network or real model');
await mkdir('build', { recursive: true });
const root = await mkdtemp(path.resolve('build/teaching-model-pipeline-'));
const report: { passed: boolean; realModelRequests: number; nativeRendered: boolean; mockedRequests: number; cases: unknown[]; checks: string[]; error?: string } = {
  passed: false, realModelRequests: 0, nativeRendered: false, mockedRequests: 0, cases: [], checks: [],
};
type Dependencies = NonNullable<Parameters<typeof prepareInteractiveFigure>[4]>;
const policy2 = { projectId: 'synthetic-policy2', legacy: false, teachingPolicy: 2 as const };
const policy1 = { ...policy2, teachingPolicy: 1 as const };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const bodyFor = (item: InteractiveDisciplineCase) => `# ${item.title}\n\n${item.lesson}\n\n> **交互探索**\n> ${item.brief}\n`;
const artifactFile = (key: string) => path.join(root, 'interactive-figures', `${key}.json`);
function api(store: InteractiveFigureStore): Dependencies['api'] {
  return { read: key => store.read(key), write: (key, value) => store.write(key, value), open: async () => ({ processId: 1 }),
    bounds: async () => {}, visible: async () => {}, close: async () => {}, onFailure: () => () => {} };
}
const facts: Record<string, { type: TeachingModelType; config: unknown }> = {
  'math-midpoint-riemann': { type: 'area', config: { expression: 'x^2', variable: 'x', domain: [0, 1], minCount: 2, maxCount: 40, method: 'midpoint', exactIntegral: 1 / 3 } },
  'physics-spring-motion': { type: 'oscillator', config: { mass: .5, stiffness: 8, amplitude: .1 } },
  'computer-lru-process': { type: 'lru', config: { capacity: 3, initial: ['A', 'B', 'C'], accesses: ['B', 'D', 'A', 'C'] } },
  'psychology-grouping-contrast': { type: 'grouping', config: { positions: [60, 100, 140, 180, 220, 260], colors: ['green', 'red', 'green', 'red', 'green', 'red'], gapIndex: 3, gapRange: [40, 160], initialGap: 40, threshold: 60 } },
  'chemistry-stoichiometry-process': { type: 'reaction', config: { reactants: [{ label: 'H₂', coefficient: 2, count: 4, atoms: { H: 2 } }, { label: 'O₂', coefficient: 1, count: 3, atoms: { O: 2 } }], products: [{ label: 'H₂O', coefficient: 2, atoms: { H: 2, O: 1 } }] } },
  'contest-knapsack-dp': { type: 'knapsack', config: { capacity: 4, items: [{ weight: 1, value: 15 }, { weight: 3, value: 20 }, { weight: 4, value: 30 }] } },
  'llm-toy-attention': { type: 'attention', config: { queries: [[1, 0], [0, 1]], keys: [[1, 0], [0, 1], [1, 1]], values: [[1, 0], [0, 2], [2, 1]] } },
};
function candidate(item: InteractiveDisciplineCase) {
  return { title: item.title, design: { anchor: item.lesson.slice(0, item.lesson.indexOf('。') + 1), goal: item.objective,
    model: '这是应被本地语义覆盖的模型文本', observation: '所有中点矩形都在曲线下方' }, basis: item.lesson, component: facts[item.id] };
}
function assertPrompt(prompt: string | undefined, type: TeachingModelType) {
  assert.equal(prompt, teachingModelPrompt(type), 'only the selected parameter schema is disclosed');
  assert.ok(prompt!.length < 900, 'the local-model prompt remains bounded');
  assert.ok(!prompt!.includes(PURPOSE_FIGURE_PROMPT) && !prompt!.includes('自包含HTML片段'));
}
const legacyHtml = '<div><svg viewBox="0 0 100 50"><circle cx="20" cy="20" r="5"/></svg><input data-figure="prediction"><button data-figure="check">检查</button><button data-figure="reset">重置</button><p data-figure="transfer">换个条件</p><button>观察</button></div>';
const dynamicHtml = '<section data-figure-mode="dynamic"><svg viewBox="0 0 100 50"><circle cx="20" cy="20" r="5"/></svg><button data-figure="play">播放</button><button data-figure="pause">暂停</button><button data-figure="reset">重置</button><input data-figure="time" type="range"><output data-figure="result">合成结果</output></section>';
const contrastHtml = '<section data-figure-mode="contrast"><button data-figure="reset">重置</button><label>共同输入<input type="range"></label><div data-figure="case">相同条件下的情况一</div><div data-figure="case">相同条件下的情况二</div><output data-figure="result">对照结果</output></section>';
function oldDesign(anchor: string, prediction = false) {
  return { anchor, goal: '观察合成教材中的已知规则', action: '操作控件', observation: '观察结果', model: '教材给出的规则', caveat: '合成示意', transfer: '条件改变时怎样变化', ...(prediction ? { prediction: '先预测' } : {}) };
}
try {
  let store = new InteractiveFigureStore(root);
  for (const item of INTERACTIVE_DISCIPLINE_CASES) {
    const { type } = facts[item.id], body = bodyFor(item), before = hash(body), markers = findInteractiveFigureEntries(body);
    assert.equal(selectTeachingModelType(item.brief, item.lesson), type, `${item.id}: source purpose routing`);
    assert.equal(teachingModelMode(type), item.expectedMode);
    assert.equal(findInteractiveFigure(body), item.brief); assert.equal(markers.length, 1);
    const built = buildTeachingModel(candidate(item), type, body);
    const key = await interactiveFigureKey(item.id, body, item.brief);
    const html = await prepareInteractiveFigure(key, body, item.brief, false, { api: api(store), generate: async request => {
      report.mockedRequests++; assertPrompt(request.systemPromptOverride, type);
      const pending = await store.read(key);
      assert.ok(pending?.status === 'pending' && pending.modelType === type && pending.teachingMode === item.expectedMode, 'model and mode are frozen before the request');
      const input = JSON.parse(request.userInput || '{}'); assert.ok(input.lesson.includes(item.lesson));
      return { content: JSON.stringify(candidate(item)) };
    } }, policy2);
    assert.equal(html, built.html, 'the app-owned builder, not model HTML, supplies the stage');
    const ready = await store.read(key);
    assert.ok(ready?.status === 'ready' && ready.autoChecked === 1);
    assert.equal(ready.design?.modelType, type); assert.equal(ready.design.teachingMode, item.expectedMode); assert.equal(ready.design.prediction, '');
    assert.equal(ready.design.model, built.semantics.model); assert.equal(ready.design.observation, built.semantics.observation, 'model-authored scientific semantics are replaced by the local model');
    assert.ok(html.length <= 100_000 && html.includes('data-teaching-stage='));
    assert.ok(!/data-figure="(?:prediction|check)"/u.test(html), 'these source purposes do not acquire mandatory quiz controls');
    const disk = await readFile(artifactFile(key), 'utf8'), summary = await store.describe(key), requestsBefore = report.mockedRequests;
    store = new InteractiveFigureStore(root);
    assert.equal(await prepareInteractiveFigure(key, body, item.brief, false, { api: api(store), generate: async () => assert.fail('ready reopen may not request a model') }, policy2), html);
    assert.equal(report.mockedRequests, requestsBefore); assert.equal(hash(await readFile(artifactFile(key), 'utf8')), hash(disk));
    assert.deepEqual(await store.describe(key), summary); assert.equal(hash(body), before); assert.deepEqual(findInteractiveFigureEntries(body), markers, 'the portable Markdown quote and spans stay unchanged');
    await writeFile(path.join(root, `${item.id}.html`), html);
    report.cases.push({ id: item.id, modelType: type, mode: ready.design.teachingMode, htmlCharacters: html.length, promptCharacters: teachingModelPrompt(type).length, readyReopenedWithoutRequest: true, portableMarkerUnchanged: true });
  }
  report.checks.push('seven actual source fixtures → mode/model selection → schema-only mock response → real prepare and disk store → unchanged ready reopen and Markdown marker');

  // Recognizing a mechanism does not authorize changing the requested activity.
  // An oscillator kit is dynamic, and the LRU kit is step-based: neither may
  // replace a contrasting oscillator explanation or a requested LRU animation.
  const guards = [
    { id: 'contrast-oscillator', brief: '对比弹簧振子两种初态下的运动解释', sourceId: 'physics-spring-motion', mode: 'contrast', proposedType: 'oscillator', html: contrastHtml },
    { id: 'dynamic-lru', brief: '动态演示 LRU 缓存访问时条目如何移动', sourceId: 'computer-lru-process', mode: 'dynamic', proposedType: 'lru', html: dynamicHtml },
  ] as const;
  for (const guard of guards) {
    const source = INTERACTIVE_DISCIPLINE_CASES.find(item => item.id === guard.sourceId)!;
    assert.equal(selectTeachingModelType(guard.brief, source.lesson), guard.proposedType, 'the subject is recognized, so this exercises the teaching-mode guard');
    const guardedBody = `# 合成教学目的边界\n${source.lesson}\n\n> **交互探索**\n> ${guard.brief}\n`;
    const key = await interactiveFigureKey(guard.id, guardedBody, guard.brief);
    const html = await prepareInteractiveFigure(key, guardedBody, guard.brief, false, { api: api(store), generate: async request => {
      report.mockedRequests++;
      assert.ok(request.systemPromptOverride?.startsWith(PURPOSE_FIGURE_PROMPT));
      assert.ok(request.systemPromptOverride?.includes(`data-figure-mode="${guard.mode}"`));
      assert.notEqual(request.systemPromptOverride, teachingModelPrompt(guard.proposedType), 'a mismatched local kit does not own this request');
      const pending = await store.read(key);
      assert.ok(pending?.status === 'pending' && pending.teachingMode === guard.mode && !pending.modelType);
      return { content: JSON.stringify({ design: oldDesign(guard.brief), html: guard.html }) };
    } }, policy2);
    assert.equal(html, guard.html);
    const saved = await store.read(key);
    assert.ok(saved?.status === 'ready' && saved.design?.teachingMode === guard.mode && !saved.design?.modelType);
  }
  report.checks.push('explicit contrast oscillator and dynamic LRU purposes stay in their generic requested modes; a recognized local component cannot override the teaching activity');

  // Explicitly regenerate an existing policy2 component from parameters. The old
  // executable HTML is not part of the model input or its token budget.
  const areaSource = INTERACTIVE_DISCIPLINE_CASES.find(item => item.id === 'math-midpoint-riemann')!;
  const areaBody = bodyFor(areaSource), areaKey = await interactiveFigureKey(areaSource.id, areaBody, areaSource.brief);
  const previousArea = await store.read(areaKey);
  assert.ok(previousArea?.status === 'ready' && previousArea.design?.modelType === 'area');
  await prepareInteractiveFigure(areaKey, areaBody, areaSource.brief, true, { api: api(store), generate: async request => {
    report.mockedRequests++; assertPrompt(request.systemPromptOverride, 'area');
    const input = JSON.parse(request.userInput || '{}');
    assert.equal(input.repair, undefined, 'local component regeneration does not resend its old HTML as a repair draft');
    assert.ok(!request.userInput?.includes('data-teaching-stage') && !request.userInput?.includes(previousArea.html));
    assert.ok((request.userInput?.length || 0) < previousArea.html.length / 2, 'a bounded source input does not carry the much larger executable stage');
    return { content: JSON.stringify(candidate(areaSource)) };
  } }, policy2);
  report.checks.push('explicit policy2 ready-component regeneration reloads only source/config guidance, without sending previous HTML');

  const physical = INTERACTIVE_DISCIPLINE_CASES.find(item => item.id === 'physics-spring-motion')!, body = bodyFor(physical);
  const failureKey = await interactiveFigureKey('policy2-failed', body, physical.brief);
  await assert.rejects(prepareInteractiveFigure(failureKey, body, physical.brief, false, { api: api(store), generate: async request => {
    report.mockedRequests++; assertPrompt(request.systemPromptOverride, 'oscillator');
    return { content: JSON.stringify({ ...candidate(physical), basis: '不存在于资料中的参数依据' }) };
  } }, policy2), /原文依据/u);
  const failed = await store.read(failureKey); assert.ok(failed?.status === 'failed' && failed.modelType === 'oscillator' && failed.teachingMode === 'dynamic');
  store = new InteractiveFigureStore(root);
  await prepareInteractiveFigure(failureKey, body, physical.brief, true, { api: api(store), generate: async request => {
    report.mockedRequests++; assertPrompt(request.systemPromptOverride, 'oscillator'); return { content: JSON.stringify(candidate(physical)) };
  } });
  assert.equal((await store.read(failureKey) as Extract<FigureArtifact, { status: 'ready' }>).design?.modelType, 'oscillator');

  const chemical = INTERACTIVE_DISCIPLINE_CASES.find(item => item.id === 'chemistry-stoichiometry-process')!, chemicalBody = bodyFor(chemical);
  const pendingKey = await interactiveFigureKey('policy2-pending', chemicalBody, chemical.brief);
  await store.write(pendingKey, { status: 'pending', modelType: 'reaction', teachingMode: 'step' });
  store = new InteractiveFigureStore(root);
  await assert.rejects(prepareInteractiveFigure(pendingKey, chemicalBody, chemical.brief, false, { api: api(store), generate: async () => assert.fail('an interrupted reservation needs explicit retry') }), /未完成/u);
  await prepareInteractiveFigure(pendingKey, chemicalBody, chemical.brief, true, { api: api(store), generate: async request => {
    report.mockedRequests++; assertPrompt(request.systemPromptOverride, 'reaction'); return { content: JSON.stringify(candidate(chemical)) };
  } });
  assert.equal((await store.read(pendingKey) as Extract<FigureArtifact, { status: 'ready' }>).design?.modelType, 'reaction');
  report.checks.push('policy2 failed and interrupted modelType/mode persist across new Store instances and resume without a new policy flag; no silent request on pending reopen');

  // Policy1 uses its existing HTML stage rather than upgrading merely because a
  // supported local model now matches. A failed policy1 reservation stays frozen.
  for (const reserved of [false, true]) {
    const key = await interactiveFigureKey(`policy1-${reserved}`, body, physical.brief);
    if (reserved) await store.write(key, { status: 'failed', teachingMode: 'dynamic', error: '原policy1失败草稿', draftHtml: dynamicHtml });
    store = new InteractiveFigureStore(root);
    const html = await prepareInteractiveFigure(key, body, physical.brief, reserved, { api: api(store), generate: async request => {
      report.mockedRequests++; assert.ok(request.systemPromptOverride?.startsWith(PURPOSE_FIGURE_PROMPT));
      assert.ok(!request.systemPromptOverride?.includes('component":{"type":"oscillator"'));
      return { content: JSON.stringify({ design: oldDesign(physical.brief), html: dynamicHtml }) };
    } }, reserved ? policy2 : policy1);
    assert.equal(html, dynamicHtml);
    const saved = await store.read(key); assert.ok(saved?.status === 'ready' && !saved.design?.modelType && saved.design?.teachingMode === 'dynamic');
  }
  const psychological = INTERACTIVE_DISCIPLINE_CASES.find(item => item.id === 'psychology-grouping-contrast')!, oldBody = bodyFor(psychological);
  for (const reserved of [false, true]) {
    const key = await interactiveFigureKey(`legacy-${reserved}`, oldBody, psychological.brief);
    if (reserved) await store.write(key, { status: 'failed', error: '原无协议失败草稿', draftHtml: legacyHtml });
    const html = await prepareInteractiveFigure(key, oldBody, psychological.brief, reserved, { api: api(new InteractiveFigureStore(root)), generate: async request => {
      report.mockedRequests++; assert.ok(request.systemPromptOverride?.startsWith(INTERACTIVE_FIGURE_PROMPT));
      assert.ok(!request.systemPromptOverride?.includes('component":{"type":"grouping"'));
      return { content: JSON.stringify({ design: oldDesign(psychological.brief, true), html: legacyHtml }) };
    } }, reserved ? policy2 : undefined);
    assert.equal(html, legacyHtml);
    const saved = await store.read(key); assert.ok(saved?.status === 'ready' && !saved.design?.modelType && !saved.design?.teachingMode);
  }
  report.checks.push('fresh policy1 and no-policy paths retain their old prompts; their failed reservations do not upgrade under a new policy2 authorization');

  const badPhysical = candidate(physical);
  assert.throws(() => buildTeachingModel({ ...badPhysical, component: { type: 'oscillator', config: { mass: .7, stiffness: 8, amplitude: .1 } } }, 'oscillator', body), /参数未能对应原文/u);
  assert.throws(() => buildTeachingModel({ ...badPhysical, component: { ...badPhysical.component, type: 'area' } }, 'oscillator', body), /原文依据/u);
  const tamperKey = await interactiveFigureKey('type-integrity', body, physical.brief);
  await store.write(tamperKey, { status: 'pending', modelType: 'oscillator', teachingMode: 'dynamic' });
  const file = JSON.parse(await readFile(artifactFile(tamperKey), 'utf8')); file.modelType = 'reaction';
  await writeFile(artifactFile(tamperKey), JSON.stringify(file));
  await assert.rejects(new InteractiveFigureStore(root).read(tamperKey), /本地模型校验失败/u);
  report.checks.push('numeric source basis and exact model type are required; persisted modelType is protected by its digest');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error); throw error;
} finally {
  globalThis.fetch = priorFetch;
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Report: ${path.join(root, 'report.json')}`);
}
console.log(`PASS seven policy2 source/model/store routes, restart compatibility, policy1/legacy prompt freeze, ready reopen and Markdown preservation; ${report.mockedRequests} mocked requests, 0 real model requests`);

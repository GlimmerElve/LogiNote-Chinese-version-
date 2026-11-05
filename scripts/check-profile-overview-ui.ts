import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';
import * as model from '../src/services/profile/overviewModel';
import * as read from '../src/services/profile/overviewRead';
import * as scoring from '../src/services/profile/styleScoring';
import { aggregateLearningAbility } from '../src/services/learningAbility/aggregator';
import { buildHomeViewModel } from '../src/services/homepage/homepageViewModel';
import * as codecs from '../src/services/userStateService';
import type { StyleSnapshotFile, UserProfile } from '../src/types';
import type { ProfileOverviewData } from '../src/services/profile/overviewRead';

const display = { academic: 20, critical: 40, practical: 10, divergent: 20, objective: 10 };
const snapshot = { calculatedAt: '2026-10-08T00:00:00Z', display, conclusion: '当前结论' } as StyleSnapshotFile;
const historyDisplay = { ...display, critical: 30 };
const trend = { snapshots: [
  { date: '2026-10-08', display, topStyle: '当前记录' },
  { date: '2026-09-01', display: historyDisplay, topStyle: '历史结论' },
  { date: '2026-09-08', display: { ...display, critical: 60 }, topStyle: '三十天前' },
] };
const before = structuredClone(trend);
assert.equal(model.selectProfileStyle(snapshot, { snapshots: [] }, 'd30', '2026-10-08'), null);
assert.equal(model.selectProfileStyle(snapshot, { snapshots: [trend.snapshots[0]] }, 'd90', '2026-10-08'), null);
assert.equal(model.selectProfileStyle(snapshot, trend, 'd30', '2026-10-08')?.date, '2026-09-08');
assert.equal(model.selectProfileStyle(null, trend, 'd30', '2026-10-07')?.conclusion, '历史结论', 'history works even without a current snapshot');
assert.equal(model.selectProfileStyle(snapshot, trend, 'd90', '2026-10-08'), null);
assert.deepEqual(trend, before, 'history selection does not sort or modify stored arrays');
assert.equal(model.profileWeekStart('2026-10-04'), '2026-09-28');
assert.equal(model.profileWeekStart('2026-10-05'), '2026-10-05');
const cloud = { weeks: [{ weekStart: '2026-10-05', words: [{ word: '本周', count: 4 }] },
  { weekStart: '2026-09-28', words: [{ word: '旧周', count: 9 }] }] };
assert.equal(model.selectProfileWeekWords(cloud, '2026-10-08')[0].word, '本周', 'week selection is independent of array order');
assert.deepEqual(model.selectProfileWeekWords(cloud, '2026-10-12'), []);
assert.equal(model.profileErrorDelta([2, 1, 0, 1]), 1);
assert.equal(model.profileErrorDelta([2, 1, 0, 0]), 0);
assert.equal(model.profileErrorDelta([2, 1, 1, 0]), -1);
assert.equal(read.validateProfileRead('timeline', { version: 1, weeks: [null] }), false);
assert.equal(read.validateProfileRead('trend', { snapshots: [{ date: '2026-02-30', display, topStyle: '' }] }), false);
assert.equal(read.validateProfileRead('cloud', { weeks: [{ weekStart: '2026-10-05', words: [{ word: 'bad', count: '3' }] }] }), false);
assert.equal(read.validateProfileRead('snapshot', { ...snapshot, calculatedAt: '2026-02-30T00:00:00Z' }), false);

// Execute production main-process reader and IPC callbacks against synthetic filesystem IO.
const main = readFileSync('src/electron/main.ts', 'utf8');
const mainAst = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const nativeReader = mainAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'readUserStateFileIfExists')!;
let fileText: string | null = null, ioCode = 'ENOENT';
const nativeContext: any = {
  exports: {}, getUserStateDir: () => 'synthetic-only', path: { join: (...parts: string[]) => parts.join('/') },
  fs: { readFile: async () => { if (fileText === null) throw Object.assign(new Error('private disk path'), { code: ioCode }); return fileText; } },
  USER_STATE_FILES: { masteryTimeline: 'timeline', styleSnapshot: 'snapshot', styleTrend: 'trend', wordCloud: 'cloud' }, ...codecs,
};
runInNewContext(ts.transpileModule(`${nativeReader.getText(mainAst)}; globalThis.nativeRead = readUserStateFileIfExists;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, nativeContext);
const handlers = new Map<string, (event: unknown, strict?: boolean) => Promise<unknown>>();
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(mainAst) === 'ipcMain.handle'
    && ts.isStringLiteral(node.arguments[0]) && ['user-state:load-mastery-timeline', 'user-state:load-style-snapshot',
      'user-state:load-style-trend', 'user-state:load-wordcloud'].includes(node.arguments[0].text)) {
    const fn = runInNewContext(ts.transpileModule(`globalThis.fn = ${node.arguments[1].getText(mainAst)};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText + '\nfn', { ...nativeContext, readUserStateFileIfExists: nativeContext.nativeRead });
    handlers.set(node.arguments[0].text, fn);
  }
  ts.forEachChild(node, visit);
}
visit(mainAst);
assert.equal(handlers.size, 4);
const preload = readFileSync('src/electron/preload.ts', 'utf8');
const preloadAst = ts.createSourceFile('preload.ts', preload, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
let bridgeCount = 0;
function checkBridge(node: ts.Node) {
  if (ts.isPropertyAssignment(node) && ['loadMasteryTimeline', 'loadStyleSnapshot', 'loadStyleTrend', 'loadWordCloud'].includes(node.name.getText(preloadAst))) {
    let call: unknown[] = [];
    const fn = runInNewContext(ts.transpileModule(`globalThis.fn = ${node.initializer.getText(preloadAst)};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText + '\nfn', { ipcRenderer: { invoke: (...args: unknown[]) => { call = args; } } });
    fn(true); assert.equal(call[1], true); assert.ok(handlers.has(String(call[0])));
    fn(); assert.equal(call[1], undefined); bridgeCount++;
  }
  ts.forEachChild(node, checkBridge);
}
checkBridge(preloadAst);
assert.equal(bridgeCount, 4, 'strict read intent reaches the actual native IPC channel');
for (const fn of handlers.values()) {
  ioCode = 'ENOENT'; fileText = null;
  assert.equal(await fn(null, true), null, 'missing files are not IO errors');
  ioCode = 'EACCES';
  await assert.rejects(fn(null, true));
  assert.equal(await fn(null), null, 'legacy callers keep their existing compatibility behavior');
  fileText = '{broken';
  await assert.rejects(fn(null, true));
  fileText = '';
  await assert.rejects(fn(null, true), 'empty corrupt files are not missing');
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
let writes = 0;
try {
  const userState: any = new Proxy({
    async loadMasteryTimeline(strict: boolean) { assert.equal(strict, true); throw new Error('private path'); },
    async loadStyleSnapshot(strict: boolean) { assert.equal(strict, true); return snapshot; },
    async loadStyleTrend(strict: boolean) { assert.equal(strict, true); return trend; },
    async loadWordCloud(strict: boolean) { assert.equal(strict, true); return { weeks: null }; },
  }, { get(target, key) { if (String(key).startsWith('save')) return () => { writes++; throw new Error('forbidden write'); }; return target[key]; } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { isElectron: true, userState } } });
  const loaded = await read.loadProfileOverviewData();
  assert.equal(loaded.timeline.ok, false);
  assert.equal(loaded.cloud.ok, false);
  assert.equal(loaded.snapshot.ok, true);
  assert.equal(loaded.trend.ok, true, 'partial successes survive unrelated read failures');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { isElectron: true } } });
  assert.equal((await read.loadProfileOverviewData()).timeline.ok, false, 'broken desktop bridge is not a no-sample state');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  assert.deepEqual((await read.loadProfileOverviewData()).timeline, { ok: true, value: null });
} finally {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
}

// Actual production component: isolated React hooks, no model, vault or native calls.
const deferred = <T>() => { let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
let gate = deferred<ProfileOverviewData>(), loads = 0, backCalls = 0, cursor = 0;
const slots: any[] = [], effectSlots: Array<{ deps: any[]; cleanup?: () => void }> = [];
let effects: Array<() => void> = [];
const hooks = { ...React,
  useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
    return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
  useRef(initial: any) { const i = cursor++; return slots[i] ||= { current: initial }; },
  useMemo: (fn: () => any) => fn(),
  useEffect(fn: () => (() => void) | void, deps: any[]) { const i = cursor++;
    if (!effectSlots[i] || deps.some((value, index) => value !== effectSlots[i].deps[index])) effects.push(() => {
      effectSlots[i]?.cleanup?.(); effectSlots[i] = { deps, cleanup: fn() || undefined };
    }); },
};
const profile = { ability: { conceptClarity: 70, judgmentReasonableness: 60, reasoningValidity: 80 },
  cognitiveStyle: { abstractVsConcrete: 0, systematicVsScattered: 0, divergentVsConvergent: 0, cautiousVsDogmatic: 0, deepVsSurface: 0 },
} as UserProfile;
const profileBefore = structuredClone(profile);
const path = resolve('src/components/ProfileOverviewView.tsx'), localRequire = createRequire(path);
const module = { exports: {} as any };
const browserBody = {};
const browser = { requestAnimationFrame(fn: () => void) { fn(); } };
const document = { body: browserBody, activeElement: browserBody as any };
runInNewContext(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
} }).outputText, { module, exports: module.exports, require(id: string) {
  if (id === 'react') return hooks;
  if (id.endsWith('/overviewRead')) return { loadProfileOverviewData() { loads++; return gate.promise; } };
  if (id.endsWith('/overviewModel')) return model;
  if (id.endsWith('/profileStore')) return { getUserProfile: () => profile };
  if (id.endsWith('/styleScoring')) return scoring;
  if (id.endsWith('/aggregator')) return { aggregateLearningAbility };
  if (id.endsWith('/homepageViewModel')) return { buildHomeViewModel };
  if (id === './useLocalCalendarDate') return { useLocalCalendarDate: () => '2026-10-08' };
  if (id.includes('refresh') || id.includes('styleStore') || id.includes('timelineStore')) throw new Error('read-only UI imported a legacy write path');
  return localRequire(id);
}, window: browser, document, Date, Promise });
const flatten = (node: any): any[] => Array.isArray(node) ? node.flatMap(flatten)
  : node?.props ? [node, ...flatten(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('')
  : node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const render = () => { cursor = 0; const tree = module.exports.ProfileOverviewView({ notes: [], onBack() { backCalls++; }, onOpenEvidence() {} });
  const queued = effects; effects = []; queued.forEach(fn => fn()); return tree; };
const button = (tree: any, label: string) => { const node = flatten(tree).find(item => item.type === 'button' && text(item) === label);
  assert.ok(node, label); return node; };
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
let tree = render();
assert.equal(button(tree, '读取中…').props.disabled, true);
button(tree, '返回首页').props.onClick();
assert.equal(backCalls, 1, 'return remains available while reading');
const loaded: ProfileOverviewData = { timeline: { ok: false, value: null }, snapshot: { ok: true, value: snapshot },
  trend: { ok: true, value: trend }, cloud: { ok: false, value: null } };
gate.resolve(loaded); await settle(); tree = render();
assert.match(text(tree), /学习周报、本周词云读取失败/);
assert.ok(flatten(tree).some(item => item.props.role === 'alert'));
assert.doesNotMatch(text(tree), /词汇样本不足/);
assert.match(text(tree), /当前结论/);
const abilityCard = flatten(tree).find(item => item.props.className?.includes('profile-overview-card-ability'));
assert.match(text(abilityCard), /暂无能力分析记录/);
assert.doesNotMatch(text(abilityCard), /70|60|80/, 'stored numeric priors without admitted observations are not presented as measured scores');
button(tree, '90 天前').props.onClick(); tree = render();
assert.match(text(tree), /该时段暂无历史记录/);
assert.doesNotMatch(text(tree), /当前结论/);
assert.equal(button(tree, '90 天前').props['aria-pressed'], true);
button(tree, '30 天前').props.onClick(); tree = render();
assert.match(text(tree), /三十天前/);
assert.match(text(tree), /记录日期 · 2026-09-08/);
gate = deferred<ProfileOverviewData>();
let focuses = 0;
const origin = { isConnected: true, focus() { focuses++; } };
const retry = button(tree, '重新读取');
retry.props.onClick({ currentTarget: origin }); retry.props.onClick({ currentTarget: origin });
tree = render(); assert.equal(loads, 2, 'same-frame retry presses issue only one read batch');
assert.equal(button(tree, '读取中…').props.disabled, true);
gate.resolve({ ...loaded, timeline: { ok: true, value: { version: 1, weeks: [] } }, cloud: { ok: true, value: cloud } });
await settle(); tree = render();
assert.equal(button(tree, '30 天前').props['aria-pressed'], true, 'retry preserves selected history view');
assert.match(text(tree), /本周/); assert.doesNotMatch(text(tree), /旧周/);
assert.equal(focuses, 1, 'retry restores focus only when focus was lost to the body');
gate = deferred<ProfileOverviewData>(); button(tree, '重新读取').props.onClick({ currentTarget: origin }); render();
document.activeElement = { anotherControl: true };
gate.resolve(loaded); await settle(); render();
assert.equal(focuses, 1, 'late reads cannot steal focus from another control');
gate = deferred<ProfileOverviewData>(); button(render(), '重新读取').props.onClick({ currentTarget: origin }); render();
const beforeUnmount = slots.slice(); effectSlots.forEach(effect => effect?.cleanup?.());
gate.resolve(loaded); await settle();
assert.deepEqual(slots, beforeUnmount, 'unmounted response cannot update the component');
assert.equal(writes, 0);
assert.deepEqual(profile, profileBefore, 'viewing/retrying cannot modify the authoritative profile cache');
const viewAst = ts.createSourceFile('ProfileOverviewView.tsx', readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const trendNode = viewAst.statements.find(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(declaration => declaration.name.getText(viewAst) === 'ErrorTrend'))!;
const actualTrend = runInNewContext(ts.transpileModule(`${trendNode.getText(viewAst)}; globalThis.trend = ErrorTrend;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS },
}).outputText + '\ntrend', { React, profileErrorDelta: model.profileErrorDelta });
assert.match(text(actualTrend({ values: [2, 1, 0, 1], weeks: 4 })), /↑\s*1\.0/);
assert.match(text(actualTrend({ values: [2, 1, 0, 0], weeks: 4 })), /→\s*0\.0/);
console.log('PASS profile overview: truthful dates/zero delta, strict native reads, partial failures, read-only view, single retry, focus and unmount guards.');

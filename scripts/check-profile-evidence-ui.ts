import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';
import { buildProfileEvidenceDetails } from '../src/services/profile/evidenceModel';
import { normalizeLearningEpisodeFile } from '../src/services/memory/types';
import * as codecs from '../src/services/userStateService';
import { aggregateLearningHabits } from '../src/services/memory/learningHabitAggregator';
import * as reads from '../src/services/profile/overviewRead';
import type { ProfileEvidenceData } from '../src/services/profile/evidenceRead';

const transpile = (source: string) => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
} }).outputText;
const episode = { id: 'one', type: 'flow', status: 'completed', title: '论证练习',
  startedAt: '2026-10-08T09:00:00Z', endedAt: '2026-10-08T09:15:00Z', createdAt: '', updatedAt: '',
  evidenceSnippets: [{ id: 's1', text: '先说明前提，再核对结论。', importance: 1, type: 'success' as const, source: 'scored_analysis' as const }] };
const profile: any = { evidenceGate: { aggregates: { concept: { dimension: 'ability', indicator: 'conceptClarity',
  status: 'trusted', mean: 72, confidence: .8, updatedAt: '2026-10-08',
  samples: [{ episodeId: 'one', observedAt: '2026-10-08', value: 72, weight: .8, evidenceSnippetIds: ['s1'] }] } } } };
const originalProfile = structuredClone(profile);
assert.throws(() => buildProfileEvidenceDetails({ evidenceGate: { aggregates: { bad: { ...profile.evidenceGate.aggregates.concept, mean: 'invalid' } } } } as any, []));
assert.throws(() => normalizeLearningEpisodeFile({ episodes: [episode, {}] }, true));
assert.equal(normalizeLearningEpisodeFile({ episodes: [episode, {}] }).episodes.length, 1, 'legacy normalization is unchanged');
for (const input of ['', '{bad', 'null', '{}', '{"episodes":[{}]}']) {
  assert.equal(codecs.deserializeLearningEpisodeState(input, true), null);
}
assert.equal(codecs.deserializeLearningEpisodeState(JSON.stringify({ version: 2, episodes: [episode] }), true)?.episodes.length, 1);

// Execute actual native reader, event IPC callback and preload method against memory IO.
const main = readFileSync('src/electron/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
const reader = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'readUserStateFileIfExists')!;
let fileText: string | null = null, ioCode = 'ENOENT';
const ctx: any = { ...codecs, getUserStateDir: () => 'memory-only', path: { join: (...parts: string[]) => parts.join('/') },
  fs: { readFile: async () => { if (fileText === null) throw Object.assign(new Error('private file path'), { code: ioCode }); return fileText; } },
  USER_STATE_FILES: { learningEpisodes: 'episodes' } };
runInNewContext(transpile(reader.getText(ast)) + '\nthis.read = readUserStateFileIfExists;', ctx);
let native!: (event: unknown, strict?: boolean) => Promise<unknown>;
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'ipcMain.handle'
    && node.arguments[0]?.getText(ast) === "'user-state:load-learning-episodes'") {
    native = runInNewContext(transpile(`const fn = ${node.arguments[1].getText(ast)};`) + '\nfn', { ...ctx, readUserStateFileIfExists: ctx.read });
  }
  ts.forEachChild(node, visit);
}
visit(ast); assert.ok(native);
assert.equal(await native(null, true), null);
ioCode = 'EACCES'; await assert.rejects(native(null, true)); assert.equal(await native(null), null);
for (const text of ['', '{bad', 'null', '{}', '{"episodes":[{}]}']) { fileText = text; await assert.rejects(native(null, true)); }
fileText = JSON.stringify({ version: 2, episodes: [episode] }); assert.equal((await native(null, true) as any).episodes.length, 1);
const preload = readFileSync('src/electron/preload.ts', 'utf8');
const bridgeAst = ts.createSourceFile('preload.ts', preload, ts.ScriptTarget.Latest, true);
let forward: unknown[] = [];
function bridgeVisit(node: ts.Node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(bridgeAst) === 'loadLearningEpisodes') {
    const fn = runInNewContext(transpile(`const fn = ${node.initializer.getText(bridgeAst)};`) + '\nfn', {
      ipcRenderer: { invoke: (...args: unknown[]) => { forward = args; } },
    });
    fn(true); assert.deepEqual(forward, ['user-state:load-learning-episodes', true]);
    fn(); assert.equal(forward[1], undefined);
  }
  ts.forEachChild(node, bridgeVisit);
}
bridgeVisit(bridgeAst);

// Actual production data reader, with strict synthetic bridge and no real storage/model imports.
const readPath = resolve('src/services/profile/evidenceRead.ts'), realRequire = createRequire(readPath);
const dataModule = { exports: {} as any };
let writes = 0, episodeError = false, timelineError = false;
const browser: any = { electronAPI: { isElectron: true, userState: {
  async loadLearningEpisodes(strict: boolean) { assert.equal(strict, true); if (episodeError) throw new Error('private error'); return { version: 2, episodes: [episode] }; },
} }, requestAnimationFrame(fn: () => void) { fn(); } };
const storage: any = { getItem: () => null, setItem: () => { writes++; throw new Error('forbidden'); } };
runInNewContext(transpile(readFileSync(readPath, 'utf8')), { exports: dataModule.exports, module: dataModule, window: browser, localStorage: storage,
  require(id: string) {
    if (id.endsWith('/profileStore')) return { getUserProfile: () => profile };
    if (id.endsWith('/currentRead')) return { readCurrentProfile: async () => profile };
    if (id.endsWith('/overviewRead')) return { loadProfileOverviewRecord: async () => ({ ok: !timelineError, value: timelineError ? null : { version: 1, weeks: [] } }) };
    return realRequire(id);
  }, Promise });
const notes: any[] = [];
let loaded = await dataModule.exports.loadProfileEvidenceData(notes);
assert.equal(loaded.evidence.ok, true); assert.equal(loaded.habits.ok, true);
assert.equal(loaded.evidence.value[0].samples[0].evidenceSnippets[0].text, episode.evidenceSnippets[0].text);
timelineError = true; loaded = await dataModule.exports.loadProfileEvidenceData(notes);
assert.equal(loaded.evidence.ok, true); assert.equal(loaded.habits.ok, false, 'timeline failure is not an empty habit profile');
episodeError = true; loaded = await dataModule.exports.loadProfileEvidenceData(notes);
assert.equal(loaded.evidence.ok, false); assert.equal(loaded.habits.ok, false);
browser.electronAPI = { isElectron: true }; await assert.rejects(dataModule.exports.loadEvidenceEpisodes());
browser.electronAPI = undefined; storage.getItem = () => '{broken'; await assert.rejects(dataModule.exports.loadEvidenceEpisodes());
storage.getItem = () => null; assert.equal((await dataModule.exports.loadEvidenceEpisodes()).length, 0);
storage.getItem = () => 'null'; await assert.rejects(dataModule.exports.loadEvidenceEpisodes());
assert.deepEqual(profile, originalProfile); assert.equal(writes, 0);

// Execute the actual view through hook boundaries. Reads and embedded cognition are isolated.
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(fn => { resolve = fn; }); return { promise, resolve }; };
let gate = deferred<ProfileEvidenceData>(), loads = 0, cursor = 0, backs = 0;
const slots: any[] = [], effectSlots: any[] = []; let effects: Array<() => void> = [];
const hooks = { ...React,
  useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
    return [slots[i], (next: any) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
  useRef(initial: any) { const i = cursor++; return slots[i] ||= { current: initial }; }, useMemo: (fn: () => any) => fn(),
  useEffect(fn: () => any, deps: any[]) { const i = cursor++; if (!effectSlots[i] || deps.some((v, j) => v !== effectSlots[i].deps[j])) effects.push(() => {
    effectSlots[i]?.cleanup?.(); effectSlots[i] = { deps, cleanup: fn() }; }); },
};
const body = {}, document = { body, activeElement: body as any };
const viewPath = resolve('src/components/ProfileEvidenceView.tsx'), viewRequire = createRequire(viewPath);
const view = { exports: {} as any };
runInNewContext(transpile(readFileSync(viewPath, 'utf8')), { module: view, exports: view.exports, window: browser, document, Promise,
  require(id: string) {
    if (id === 'react') return hooks;
    if (id.endsWith('.css')) return {};
    if (id.endsWith('/evidenceRead')) return { loadProfileEvidenceData(received: any[]) { assert.equal(received, notes); loads++; return gate.promise; } };
    if (id.endsWith('/memoryContextBuilder')) return { listLatestMemoryContextTraces: () => [] };
    if (id === './useLocalCalendarDate') return { useLocalCalendarDate: () => '2026-10-08' };
    if (id === './PersonalCognitionLauncher') return { PersonalCognitionLauncher: () => null };
    return viewRequire(id);
  } });
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : typeof node === 'number' || typeof node === 'string' ? String(node) : '';
const flat = (node: any): any[] => Array.isArray(node) ? node.flatMap(flat) : node?.props ? [node, ...flat(node.props.children)] : [];
const button = (tree: any, label: string) => { const found = flat(tree).find(n => n.type === 'button' && text(n) === label); assert.ok(found, label); return found; };
const render = () => { cursor = 0; const tree = view.exports.ProfileEvidenceView({ notes, onBack() { backs++; } }); const q = effects; effects = []; q.forEach(fn => fn()); return tree; };
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
let tree = render(); assert.equal(button(tree, '读取中…').props.disabled, true); button(tree, '返回画像').props.onClick(); assert.equal(backs, 1);
const evidence = buildProfileEvidenceDetails(profile, [episode as any]);
const habits = aggregateLearningHabits({ episodes: [], timeline: { version: 1, weeks: [] }, notes });
gate.resolve({ evidence: { ok: true, value: evidence }, habits: { ok: false, value: null } }); await settle(); tree = render();
assert.match(text(tree), /学习习惯读取失败/); assert.match(text(tree), /概念清晰度/); assert.ok(flat(tree).some(n => n.props.role === 'alert'));
let focuses = 0; const origin = { isConnected: true, focus() { focuses++; } };
gate = deferred<ProfileEvidenceData>(); const retry = button(tree, '重新读取'); retry.props.onClick({ currentTarget: origin }); retry.props.onClick({ currentTarget: origin });
tree = render(); assert.equal(loads, 2); assert.equal(button(tree, '读取中…').props.disabled, true); assert.match(text(tree), /概念清晰度/, 'refresh retains displayed cards');
gate.resolve({ evidence: { ok: false, value: null }, habits: { ok: true, value: habits } }); await settle(); tree = render();
assert.match(text(tree), /画像证据读取失败/); assert.match(text(tree), /概念清晰度/, 'failure retains previously read evidence'); assert.match(text(tree), /学习节奏/); assert.equal(focuses, 1);
assert.doesNotMatch(text(tree), /还没有可展示|private/);
gate = deferred<ProfileEvidenceData>(); button(tree, '重新读取').props.onClick({ currentTarget: origin }); render();
document.activeElement = { other: true }; gate.resolve({ evidence: { ok: true, value: [] }, habits: { ok: true, value: habits } }); await settle(); tree = render();
assert.equal(focuses, 1); assert.match(text(tree), /还没有可展示的画像证据/);
assert.doesNotMatch(text(tree), /读取失败/); assert.equal(flat(tree).filter(n => n.type === 'details' && n.props.className === 'profile-evidence-card').length, 5);

// Preview keeps identifiers/technical fields private while retaining every full excerpt on demand.
const longExcerpt = '关键证据需要保留完整的阅读内容。'.repeat(25);
const expandedEvidence = [{ ...evidence[0], samples: Array.from({ length: 5 }, (_, index) => ({
  ...evidence[0].samples[0], episodeId: `private-episode-${index}`, episodeTitle: `练习 ${index + 1}`,
  matchedCriteria: ['private-criterion-code'], rubricVersion: 'private-rubric-version',
  evidenceSnippets: [{ ...episode.evidenceSnippets[0], text: longExcerpt }, { ...episode.evidenceSnippets[0], id: 'duplicate', text: longExcerpt }],
})) }];
const expandedBefore = structuredClone(expandedEvidence);
assert.equal(view.exports.countEvidenceRecords([...expandedEvidence, ...expandedEvidence]), 5, 'one event supporting multiple indicators counts once');
const columns = view.exports.renderEvidenceColumns(['first', 'second', 'third', 'fourth', 'fifth']);
assert.deepEqual(Array.from(columns.props.children[0].props.children), ['first', 'third', 'fifth']);
assert.deepEqual(Array.from(columns.props.children[1].props.children), ['second', 'fourth'], 'columns have independent containers, not shared card rows');
gate = deferred<ProfileEvidenceData>(); button(tree, '重新读取').props.onClick({ currentTarget: origin }); render();
gate.resolve({ evidence: { ok: true, value: expandedEvidence }, habits: { ok: true, value: { ...habits,
  studyRhythm: { ...habits.studyRhythm, sourceIds: ['private-habit-source'] },
} } }); await settle(); tree = render();
assert.equal(flat(tree).filter(n => n.type === 'article').length, 3, 'initial preview contains at most three observations per indicator');
assert.equal(flat(tree).filter(n => n.props.className === 'profile-evidence-excerpt').length, 3, 'duplicate excerpts within the same sample are merged');
assert.ok(text(tree).includes(longExcerpt), 'full text stays available inside the excerpt disclosure');
assert.doesNotMatch(text(tree), /private-episode|private-criterion|private-rubric|private-habit-source|权重|命中判据|较慢速基线/);
assert.ok(flat(tree).filter(n => n.props.className === 'profile-evidence-card').every(n => !n.props.open), 'cards start collapsed');
button(tree, '查看更早记录 · 还有 2 条').props.onClick(); tree = render();
assert.equal(flat(tree).filter(n => n.type === 'article').length, 5, 'requesting older records reveals remaining evidence');
assert.deepEqual(expandedEvidence, expandedBefore, 'presentation and pagination never alter stored evidence');

// One visible metric owns every rubric cohort; display grouping must neither
// blend scores nor count trusted versions as different abilities.
const cohort = (indicator: string, rubricVersion: string | undefined, value: number, episodeId: string, status = 'holding') => ({
  ...evidence[0], indicator, rubricVersion, mean: value, status,
  samples: [{ ...evidence[0].samples[0], episodeId, value, rubricVersion }],
});
const sevenCohorts = [
  cohort('conceptClarity', undefined, 43.2, 'shared-event', 'trusted'),
  cohort('judgmentReasonableness', undefined, 38.3, 'shared-event'),
  cohort('reasoningValidity', undefined, 41.6, 'shared-event'),
  cohort('conceptClarity', 'flow-evidence-rubric-v1-test', 75, 'shared-event', 'trusted'),
  cohort('judgmentReasonableness', 'flow-evidence-rubric-v1-test', 66.7, 'flow-judge', 'trusted'),
  cohort('reasoningValidity', 'flow-evidence-rubric-v1-test', 66.7, 'flow-reason'),
  cohort('conceptClarity', 'review-criteria-v2', 75, 'review-event'),
] as typeof evidence;
const sevenBefore = structuredClone(sevenCohorts);
gate = deferred<ProfileEvidenceData>(); button(tree, '重新读取').props.onClick({ currentTarget: origin }); render();
gate.resolve({ evidence: { ok: true, value: sevenCohorts }, habits: { ok: true, value: habits } }); await settle(); tree = render();
const indicatorCards = flat(tree).filter(n => n.type === 'details' && n.props.className?.includes('profile-evidence-indicator-card'));
assert.equal(indicatorCards.length, 3, 'seven rubric cohorts must show only three distinct ability cards');
assert.equal(flat(tree).filter(n => n.type === 'details' && n.props.className === 'profile-evidence-cohort').length, 7);
const ability = flat(tree).find(n => n.type === 'section' && n.props.className === 'profile-evidence-group' && text(n).includes('三层能力'));
assert.match(text(ability), /3 个指标/); assert.doesNotMatch(text(ability), /7 个指标/);
const conceptCard = indicatorCards.find(n => n.props['data-profile-indicator'] === 'conceptClarity');
const conceptSummary = conceptCard.props.children[0];
assert.match(text(conceptSummary), /3\s*组评分/); assert.match(text(conceptSummary), /2 次学习记录（去重）/);
assert.doesNotMatch(text(conceptSummary), /43\.2|75\.0/, 'a multi-rubric card must not invent one comparable score');
assert.match(text(conceptCard), /历史评分/); assert.match(text(conceptCard), /心流评分 v1/); assert.match(text(conceptCard), /复习评分 v2/);
assert.match(text(conceptCard), /43\.2/); assert.match(text(conceptCard), /75\.0/);
assert.equal(flat(tree).filter(n => n.type === 'article').length, 7, 'every cohort retains its original evidence, including shared events');
const summary = flat(tree).find(n => n.props.className === 'profile-evidence-summary');
assert.equal(summary.props['aria-label'], '2 项指标含已采信证据，来自 4 次学习记录');
assert.deepEqual(sevenCohorts, sevenBefore);

gate = deferred<ProfileEvidenceData>(); button(tree, '重新读取').props.onClick({ currentTarget: origin }); render(); const beforeUnmount = slots.slice(); effectSlots.forEach(e => e?.cleanup?.());
gate.resolve({ evidence: { ok: true, value: evidence }, habits: { ok: true, value: habits } }); await settle(); assert.deepEqual(slots, beforeUnmount);
assert.equal(writes, 0);
console.log('PASS profile evidence: strict event IPC, safe partial failures, current notes, read-only snapshots, one retry, retained cards, focus/unmount guards, seven cohorts to three metrics, independent rubric scores and deduplicated trusted/record counts.');

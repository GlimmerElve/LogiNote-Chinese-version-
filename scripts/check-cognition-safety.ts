import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { applyCognitionMutation, emptyCognitionFile, latestCognition, parseCognitionFile } from '../src/services/cognition/core';
import { mutateCognition, loadCognition, COGNITION_FILE_NAME } from '../src/electron/cognitionStore';
import { searchPersonalCognition } from '../src/electron/cognitionRetrieval';
import { withRagSourceTransaction } from '../src/electron/ragSourceTransactions';
import { registerCognitionTools } from '../src/services/agent/tools/cognitionTools';
import { executeTool } from '../src/services/agent/toolRegistry';
import type { CognitionFile, CognitionMutation } from '../src/services/cognition/types';
import type { AgentRuntimeContext } from '../src/services/agent/types';

let checks = 0, sequence = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const stamp = () => ({ id: `safety-${++sequence}`, at: '2026-10-20T00:00:00Z' });
const initial = (revision = 0): CognitionMutation => ({ kind: 'confirm', expectedRevision: revision, confirmed: true, operation: 'initial',
  authorship: 'own_expression', stance: 'endorsed', reason: '', doc: { doc_id: 'safety', title: '合成认知', nodes: [{ id: 'n', text: '仅用于安全回归的认知。', mainType: '假设',
    position: { x: 0, y: 0 }, status: 'ok', issue: null, severity: null, suggestion: null, user_edited: false, collapsed: false }], edges: [] } });
const main = await fs.readFile('src/electron/main.ts', 'utf8'), ast = ts.createSourceFile('main.ts', main, ts.ScriptTarget.ES2022, true);
const handlers = new Map<string, string>();
function walk(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'ipcMain.handle' && ts.isStringLiteral(node.arguments[0])) handlers.set(node.arguments[0].text, node.arguments[1].getText(ast));
  ts.forEachChild(node, walk);
}
walk(ast);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-cognition-safety-'));
try {
  let currentDirectory = path.join(directory, 'private'), writes = 0, reads = 0;
  const code = ts.transpileModule(`let referenceEnvironmentSuspended = false, referenceSourceWriteEpoch = 0;
    return { mutate: (${handlers.get('user-state:mutate-cognition')}), load: (${handlers.get('user-state:load-cognition')}), search: (${handlers.get('user-state:search-cognition')}),
      pause(value) { referenceEnvironmentSuspended = value; }, advance() { referenceSourceWriteEpoch++; } };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const native = new Function('getUserStateDir', 'taskScope', 'mutateCognition', 'loadCognition', 'BrowserWindow', 'onWriteCommitted', 'searchPersonalCognition', 'searchCognitionMaterials', code)(
    () => currentDirectory, () => 'synthetic-scope',
    async (...args: Parameters<typeof mutateCognition>) => { writes++; return mutateCognition(...args); },
    async (...args: Parameters<typeof loadCognition>) => { reads++; return loadCognition(...args); }, { getAllWindows: () => [] }, () => {},
    (_directory: string, query: unknown, _encode: unknown, current: () => boolean) => searchPersonalCognition(_directory, query, async () => assert.fail('No encoder in suspended/empty search'), current), async () => []);
  native.pause(true);
  await assert.rejects(native.mutate({}, initial()), /存储操作中/);
  await assert.rejects(native.mutate({}, { ...initial(), storageScopeId: 'synthetic-scope' }), /存储操作中/);
  assert.throws(() => native.load(), /存储操作中/); assert.equal(writes, 0); assert.equal(reads, 0);
  await assert.rejects(native.search({}, '合成认知'), /存储操作中/);
  native.pause(false);
  await assert.rejects(native.mutate({}, { ...initial(), storageScopeId: 'other-scope' }), /不属于/);
  pass('actual native handlers reject suspended writes with or without scope, reject suspended auto-upgrade reads and reject a foreign scope before IO');

  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const reset = withRagSourceTransaction([currentDirectory], async () => { entered(); await gate; });
  await started;
  const pendingWrite = native.mutate({}, initial()), pendingRead = native.load(), pendingSearch = native.search({}, '合成认知');
  const rejectedWrite = assert.rejects(pendingWrite, /存储环境已变化/), rejectedRead = assert.rejects(pendingRead, /存储环境已变化/), rejectedSearch = assert.rejects(pendingSearch, /存储环境已变化/);
  native.pause(true); native.advance(); native.pause(false); release();
  await Promise.all([reset, rejectedWrite, rejectedRead, rejectedSearch]);
  await assert.rejects(fs.access(path.join(currentDirectory, COGNITION_FILE_NAME)), /ENOENT/, 'an old queued initial save must not recreate the library after reset');
  const saved = await native.mutate({}, initial()); assert.equal(saved.records.length, 1);
  assert.deepEqual(await native.load(), saved);
  pass('queued writes and automatic-upgrade reads share the reset/migration lock and recheck the captured epoch even after suspension ends; new requests recover normally');

  const originalWrite = fs.writeFile;
  try {
    fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
      const result = await originalWrite(...args);
      if (String(args[0]).startsWith(currentDirectory + path.sep) && String(args[0]).endsWith('.tmp')) native.advance();
      return result;
    }) as typeof fs.writeFile;
    await assert.rejects(native.mutate({}, { kind: 'update_cognition', expectedRevision: saved.revision, confirmed: true,
      target: { recordId: 'safety', revisionId: latestCognition(saved.records[0]).id, branchId: 'primary', nodeId: 'n', operation: 'revise', reason: '中途失效测试' },
      text: '不得提交的过期新内容。', mainType: '假设', stance: 'endorsed', authorship: 'own_expression' }), /存储环境已变化/);
  } finally { fs.writeFile = originalWrite; }
  assert.deepEqual(await loadCognition(currentDirectory), saved);
  assert.ok(!(await fs.readdir(currentDirectory)).some(file => file.endsWith('.tmp')));
  pass('an environment change after staging but before rename aborts the atomic commit, preserves the complete old file and cleans up the staging file');
} finally {
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'loginote-cognition-safety-'));
  await fs.rm(directory, { recursive: true, force: true });
}

for (const newline of ['\r\n', '\r']) {
  const condition = `分类边界固定${newline}且睡眠充足`;
  const file = applyCognitionMutation(emptyCognitionFile(), initial(), stamp());
  Object.assign(latestCognition(file.records[0]).branches[0].graph.nodes[0], { text: `${condition}时我接受这一判断。`, conditions: [condition] });
  parseCognitionFile(file); const frozen = structuredClone(file);
  const target = { recordId: 'safety', revisionId: latestCognition(file.records[0]).id, branchId: 'primary', nodeId: 'n', operation: 'revise' as const, reason: '仅补充正文' };
  const text = `${condition.replace(/\r\n?/gu, '\n')}时我接受这一判断。需要继续检验。`;
  const changed = applyCognitionMutation(file, { kind: 'update_cognition', expectedRevision: file.revision, confirmed: true, target, text,
    mainType: '假设', stance: 'endorsed', authorship: 'own_expression', meaning: { interpretation: '保留条件', preserved: [condition] } }, stamp());
  assert.deepEqual(latestCognition(changed.records[0]).branches[0].graph.nodes[0].conditions, [condition]);
  assert.deepEqual(changed.records[0].revisions[0], frozen.records[0].revisions[0]);
  const replacement = '边界可调整', replace = (body: string) => applyCognitionMutation(file, { kind: 'update_cognition', expectedRevision: file.revision, confirmed: true,
    target: { ...target, operation: 'replace_conditions' }, text: body, mainType: '假设', stance: 'endorsed', authorship: 'own_expression',
    meaning: { interpretation: '明确替换条件', preserved: [], conditions: { before: [condition], changes: [{ kind: 'replace', before: condition, after: replacement }] } } }, stamp());
  assert.throws(() => replace(`${replacement}或${condition.replace(/\r\n?/gu, '\n')}时我接受这一判断。`), /仍单独出现/);
  for (const invalid of [text.replace('睡眠充足', '睡眠不足'), text.replace('\n', ' '), text.replace('分类边界', '分类 边界')]) assert.throws(() => applyCognitionMutation(file, {
    kind: 'update_cognition', expectedRevision: file.revision, confirmed: true, target, text: invalid, mainType: '假设', stance: 'endorsed', authorship: 'own_expression',
  }, stamp()), /不能静默/);
}
pass('CRLF/CR versus LF only are equivalent for literal condition checks; exact metadata/history survive, while altered words, added spaces and hidden leftover conditions are still rejected');

let corpus: CognitionFile = applyCognitionMutation(emptyCognitionFile(), { kind: 'confirm', confirmed: true, expectedRevision: 0, operation: 'initial', reason: '', authorship: 'own_expression', stance: 'endorsed', doc: {
  doc_id: 'relations', title: '关系预算', nodes: [{ id: 'hub', text: '唯一检索目标', mainType: '假设' }, ...Array.from({ length: 100 }, (_, index) => ({ id: `p${index}`, text: `不同前提${index}`, mainType: '假设' as const }))],
  edges: Array.from({ length: 100 }, (_, index) => ({ id: `e${index}`, source: `p${index}`, target: 'hub', relation: 'support' as const, reason: '详'.repeat(2000) })),
} }, stamp());
const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), priorFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { electronAPI: { userState: { loadCognition: async () => structuredClone(corpus) } } }) });
globalThis.fetch = async () => assert.fail('No network');
try {
  registerCognitionTools();
  const ctx = {} as AgentRuntimeContext, read = async (args: Record<string, unknown>) => {
    const result = await executeTool('query_cognition', args, ctx, { cognitionContext: true }); assert.equal(result.ok, true, result.error);
    const value = result.result as any; assert.ok(JSON.stringify(value).length <= value.responseLimitChars); return value;
  };
  const candidate = await read({ query: '唯一检索目标' });
  assert.ok(candidate.edges.length); assert.ok(candidate.edges.every((edge: any) => edge.reason.length <= 160 && edge.reasonTruncated === true && edge.reasonChars === 2000));
  const exact = await read({ edge: candidate.edges[0].reference, expectedRevision: corpus.revision });
  assert.equal(exact.edges[0].reason, '详'.repeat(2000)); assert.equal(exact.edges[0].reasonTruncated, false);
  const seen = new Set<string>(); let offset = 0;
  for (let page = 0; page < 100; page++) {
    const result = await read({ query: '唯一检索目标', relationsOnly: true, edgeOffset: offset, expectedRevision: corpus.revision });
    assert.equal(result.nodes.length, 0);
    for (const edge of result.edges) { assert.ok(!seen.has(edge.id)); seen.add(edge.id); }
    if (result.nextEdgeOffset === undefined) break;
    assert.ok(result.nextEdgeOffset > offset); offset = result.nextEdgeOffset;
  }
  assert.equal(seen.size, 100);
  console.log(`candidate relationship payload: ${JSON.stringify(candidate).length} characters (previously 230254)`);
  pass('candidate relationship reasons and the complete serialized response are bounded; every edge remains reachable by snapshot-bound pagination and exact reason lookup');

  corpus = structuredClone(corpus); corpus.records[0].withdrawn = true;
  corpus.links = Array.from({ length: 70 }, (_, index) => ({ id: `broken${index}`, source: { recordId: 'relations', branchId: 'primary', nodeId: `p${index}` }, target: { recordId: 'missing', branchId: 'primary', nodeId: `n${index}` }, relation: 'limits', reason: '断'.repeat(2000) }));
  const broken = new Set<string>(); offset = 0;
  for (let page = 0; page < 70; page++) {
    const result = await read({ brokenEdgeOffset: offset, expectedRevision: corpus.revision });
    for (const edge of result.brokenEdges) { assert.ok(!broken.has(edge.id)); broken.add(edge.id); assert.equal(edge.reasonTruncated, true); }
    if (result.nextBrokenEdgeOffset === undefined) break;
    assert.ok(result.nextBrokenEdgeOffset > offset); offset = result.nextBrokenEdgeOffset;
  }
  assert.equal(broken.size, 70);
  const exactBroken = await read({ edge: { linkId: 'broken0' }, expectedRevision: corpus.revision });
  assert.equal(exactBroken.edges[0].reason, '断'.repeat(2000));
  pass('broken relationship reasons obey the same total budget, have complete forward pagination, and retain exact read/repair references');

  corpus = applyCognitionMutation(emptyCognitionFile(), { kind: 'confirm', expectedRevision: 0, confirmed: true, operation: 'initial', authorship: 'own_expression', stance: 'endorsed', reason: '', doc: {
    doc_id: 'escaped-identifiers', title: '\u0002'.repeat(1000), nodes: Array.from({ length: 8 }, (_, index) => ({ id: `n${index}${'\u0001'.repeat(190)}`, text: `预算目标${'\u0003'.repeat(19000)}`, mainType: '假设' as const })), edges: [],
  } }, stamp());
  const allNodes = new Set<string>(); offset = 0;
  for (let page = 0; page < 8; page++) {
    const result = await read({ query: '预算目标', offset, expectedRevision: corpus.revision });
    assert.ok(result.nodes.length > 0); assert.ok(result.nodes.every((node: any) => node.truncated));
    for (const node of result.nodes) { assert.ok(!allNodes.has(node.id)); allNodes.add(node.id); }
    if (result.nextOffset === undefined) break;
    assert.ok(result.nextOffset > offset); offset = result.nextOffset;
  }
  assert.equal(allNodes.size, 8);
  const target = { recordId: corpus.records[0].id, revisionId: latestCognition(corpus.records[0]).id, branchId: 'primary', nodeId: latestCognition(corpus.records[0]).branches[0].graph.nodes[0].id };
  const full = await read({ target, expectedRevision: corpus.revision });
  assert.equal(full.nodes[0].text, latestCognition(corpus.records[0]).branches[0].graph.nodes[0].text); assert.equal(full.nodes[0].truncated, false);
  assert.equal(full.historyTruncated, true); assert.ok(full.history.every((row: any) => row.truncated));
  pass('serialized escaping, large titles and history cannot bypass candidate budgets; pagination advances by actual returned nodes and an exact current baseline remains complete');
} finally {
  globalThis.fetch = priorFetch;
  if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else Reflect.deleteProperty(globalThis, 'window');
}
console.log(`Cognition safety: ${checks} groups passed; synthetic native IPC, isolated temporary files and tool fixtures only, no real user data/model/network.`);

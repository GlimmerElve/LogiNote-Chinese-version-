import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { NoteItem } from '../src/types';
import type { FlowSession } from '../src/types';
import { saveFlowReviewRecord, saveReviewArgument } from '../src/services/textbook/reviewRecordStore';
import { personalProjectContent, projectMaterialRows } from '../src/services/ragSourcePolicy';
import { mixedTextbookNote, TEXTBOOK_FIXTURE as fixture } from './fixtures/textbook-phase-zero';

const args = process.argv.slice(2);
assert.ok(args.every((arg) => arg === '--expect-known-gaps'), 'Unknown audit argument');
const expectKnownGaps = args.includes('--expect-known-gaps');
const flowFile = ts.createSourceFile('FlowMode.tsx', readFileSync(new URL('../src/components/FlowMode.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const appFile = ts.createSourceFile('App.tsx', readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findOne<T extends ts.Node>(root: ts.Node, guard: (node: ts.Node) => node is T, matches: (node: T) => boolean): T {
  const found: T[] = [];
  const visit = (node: ts.Node) => { if (guard(node) && matches(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(root);
  assert.equal(found.length, 1, 'Production fragment changed: refresh the audit adapter, do not classify an extraction error as a known gap');
  return found[0];
}

const exitDeclaration = findOne(flowFile, ts.isVariableDeclaration, (node) => node.name.getText(flowFile) === 'handleExit');
assert.ok(exitDeclaration.initializer && ts.isArrowFunction(exitDeclaration.initializer));
let bodyWrites = 0;
const checkExit = (node: ts.Node) => {
  if (ts.isCallExpression(node) && node.expression.getText(flowFile) === 'onUpdateNote') bodyWrites++;
  ts.forEachChild(node, checkExit);
};
checkExit(exitDeclaration.initializer.body);
assert.equal(bodyWrites, 0, 'FlowMode exit must not replace note body');
findOne(exitDeclaration.initializer.body, ts.isCallExpression, (node) => node.expression.getText(flowFile) === 'onExit');
const restateRef = findOne(flowFile, ts.isVariableDeclaration, (node) => node.name.getText(flowFile) === 'restateTextRef');
assert.ok(restateRef.initializer && ts.isCallExpression(restateRef.initializer));
assert.equal(restateRef.initializer.arguments.length, 1);
const restateInitializerSource = restateRef.initializer.arguments[0].getText(flowFile);
const graphSave = findOne(appFile, ts.isVariableDeclaration, (node) => node.name.getText(appFile) === 'saveArgumentDoc');
assert.ok(graphSave.initializer && ts.isArrowFunction(graphSave.initializer));
findOne(graphSave.initializer.body, ts.isCallExpression, (node) => node.expression.getText(appFile) === 'saveReviewArgument');
findOne(appFile, ts.isCallExpression, (node) => node.expression.getText(appFile) === 'saveFlowReviewRecord');

/** 执行仓库源码的窄投影，不复制旧算法；不是浏览器、React 生命周期或完整保存事务测试。 */
function evaluateFragment(source: string, scope: Record<string, unknown>): unknown {
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return runInNewContext(code, scope, { timeout: 1000 });
}
function exitNoteProjection(note: NoteItem, sessionText: string): NoteItem {
  const session: FlowSession = { id: fixture.sessions[0].id, noteId: note.id, noteTitle: note.title,
    startedAt: fixture.sessions[0].startedAt, endedAt: fixture.sessions[0].endedAt,
    durationSeconds: 2100, reviewIntervalMinutes: 20, restateText: sessionText,
    incrementalText: sessionText, summary: '本次学习总结', analyze: true };
  return saveFlowReviewRecord(note, session, 'pending_analysis');
}
function graphSaveProjection(target: NoteItem, graphTitle?: string): NoteItem {
  return saveReviewArgument(target, { ...target.argumentDocs![0], title: graphTitle ?? target.argumentDocs![0].title });
}

// 控制：本次会话保存不改变原文；旧生成块未编辑时排除有效；旧图仍可按原 ID 编辑。
const mixed = mixedTextbookNote();
assert.ok(exitNoteProjection(mixed, mixed.content + '\n\n本次新复述').content.includes(fixture.textbook));
const tracked = { ...mixed, generatedContentBlocks: [fixture.textbook] };
assert.ok(!personalProjectContent(tracked).includes('选择过载效应教材'));
assert.ok(personalProjectContent(tracked).includes(fixture.restatement));
assert.ok(projectMaterialRows(tracked).every((row) => row.stance === 'not_assessed' && row.usableAsFactEvidence === false));
const editedGraphNote = graphSaveProjection(mixed, '修改后的原图');
assert.equal(editedGraphNote.content, mixed.content);
assert.equal(editedGraphNote.argumentDocs!.length, 1);
assert.equal(editedGraphNote.argumentDocs![0].doc_id, fixture.graphId);
assert.equal(editedGraphNote.argumentDocs![0].title, '修改后的原图');
console.log('CONTROL real record store preserves body; unchanged legacy generation excluded; personal rows remain unconfirmed/non-factual; original graph edit retains ID and body entry');

const probes = [
  { id: 'flow-isolated-session-overwrites-body', scope: 'real Phase One save service with target session-only input; App binding verified by AST, not UI E2E',
    target: () => assert.ok(exitNoteProjection(mixed, fixture.restatement).content.includes(fixture.textbook),
      'Session-only save replaces textbook/tasks instead of preserving the note body') },
  { id: 'flow-input-seeded-from-note-body', scope: 'actual restateTextRef initializer projection',
    target: () => assert.equal(evaluateFragment(`(${restateInitializerSource})`, { note: mixed }), '',
      'Fresh session restatement ref contains the whole mixed note rather than only session text') },
  { id: 'unregistered-textbook-becomes-personal-material', scope: 'real RAG source policy',
    target: () => assert.ok(!projectMaterialRows(mixed).some((row) => row.text.includes('选择过载效应教材')),
      'Generated textbook is labeled project-restatement in the private material channel') },
  { id: 'edited-textbook-loses-source-exclusion', scope: 'real RAG source policy after user edit',
    target: () => {
      const edited = { ...tracked, content: tracked.content.replace('选择过载效应教材', '选择过载效应教材 用户补充标题') };
      assert.ok(!projectMaterialRows(edited).some((row) => row.text.includes('选择过载效应教材')),
        'Exact-string generatedContentBlocks exclusion fails after textbook editing');
    } },
  { id: 'argument-markup-becomes-restatement', scope: 'real RAG source policy with registered textbook',
    target: () => assert.ok(!projectMaterialRows(tracked).some((row) => row.text.includes('<ArgumentBlock')),
      'Graph component markup is indexed as restatement text instead of graph-only metadata') },
  { id: 'new-graph-save-retry-duplicates-entry', scope: 'real Phase One graph store replay with same doc ID; not double-click UI E2E',
    target: () => {
      const saved = graphSaveProjection(graphSaveProjection(mixed));
      assert.equal(saved.argumentDocs!.filter((doc) => doc.doc_id === fixture.graphId).length, 1,
        'Replaying the new-save branch appends the same graph rather than updating its record');
      assert.equal(saved.content.split(`<ArgumentBlock id="${fixture.graphId}" />`).length - 1, 1,
        'Replaying the new-save branch duplicates the body graph entry');
    } },
] as const;

const failures: string[] = [];
for (const probe of probes) {
  try {
    probe.target();
    console.log(`TARGET PASS ${probe.id}`);
  } catch (error) {
    // 脚本异常、API 不可用、源码提取错误绝不能被算作预期产品缺口。
    if (!(error instanceof assert.AssertionError)) throw error;
    failures.push(probe.id);
    console.log(`TARGET FAIL ${probe.id}\n  scope: ${probe.scope}\n  ${error.message.split('\n')[0]}`);
  }
}

const knownGapIds = [
  'unregistered-textbook-becomes-personal-material', 'edited-textbook-loses-source-exclusion',
];
console.log(`\nTarget failures: ${failures.length}/${probes.length}. Offline synthetic/production-fragment audit; no user data or network writes.`);
if (expectKnownGaps) {
  assert.deepEqual(failures, knownGapIds, 'Known-gap snapshot changed: investigate and update the baseline explicitly');
  console.log('KNOWN-GAP SNAPSHOT MATCHED: two legacy provenance gaps remain. Managed textbook region checks are in check:textbook-records. This is NOT end-to-end feature readiness.');
} else {
  process.exitCode = failures.length ? 1 : 0;
}

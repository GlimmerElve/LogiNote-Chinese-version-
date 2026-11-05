import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { EMPTY_CONTEXT_NAVIGATION, getContextFocusedNote, getContextSourceLabel, moveContextNavigation, openContextNote } from '../src/services/ui/contextNavigation';
import { createResourceDraftSession } from '../src/services/agent/resourceDraftService';
import type { NoteItem } from '../src/types';

const a = { key: 'visit-a', noteId: 'knowledge-a', projectContextId: 'root' };
const b = { key: 'visit-b', noteId: 'knowledge-b', projectContextId: 'root' };
let state = openContextNote(EMPTY_CONTEXT_NAVIGATION, a);
assert.equal(state.cursor, 0);
assert.equal(openContextNote(state, { ...a, key: 'duplicate' }), state);
state = openContextNote(state, b);
assert.equal(state.cursor, 1);
const pages = state.pages;
state = moveContextNavigation(state, 0);
assert.equal(state.pages, pages, 'back must preserve mounted editors and forward history');
state = moveContextNavigation(state, -1);
assert.equal(state.pages.length, 2, 'return to source must not discard source or forward visits');
state = moveContextNavigation(state, 1);
assert.equal(state.pages[1], b);
assert.equal(moveContextNavigation(state, 99), state);
assert.equal(moveContextNavigation(state, -2), state);
assert.equal(moveContextNavigation(state, 0.5), state);
state = openContextNote(moveContextNavigation(state, 0), { ...b, key: 'new-b', noteId: 'knowledge-c' });
assert.deepEqual(state.pages.map(page => page.key), ['visit-a', 'new-b'], 'new branch drops only obsolete forward pages');
assert.equal(getContextSourceLabel('editor', '原项目'), '原项目');
assert.equal(getContextSourceLabel('scene'), '场景模拟');
assert.equal(getContextSourceLabel('timeline'), '学习计划');
assert.deepEqual(EMPTY_CONTEXT_NAVIGATION, { pages: [], cursor: -1 });

const projects: NoteItem[] = ['project-a', 'project-b'].map((id) => ({
  id, title: id, content: '', noteType: 'project', tags: [], links: [], backlinks: [], dueDates: [],
  createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z',
}));
const projectReference = openContextNote(EMPTY_CONTEXT_NAVIGATION,
  { key: 'project-visit-b', noteId: 'project-b', projectContextId: 'project-b' });
const resourceScope = (navigation: typeof state, sourceNoteId?: string | null) => createResourceDraftSession(projects,
  { selectedProjectId: getContextFocusedNote(navigation, projects, sourceNoteId)?.id }).scopeProjectId;
assert.equal(resourceScope(projectReference, 'project-a'), 'project-b', 'resource draft must target the visible reference project');
assert.equal(resourceScope(projectReference, null), 'project-b', 'reference project works even without a source note selection');
assert.equal(resourceScope(moveContextNavigation(projectReference, -1), 'project-a'), 'project-a', 'return restores the source project focus');
assert.equal(getContextFocusedNote(projectReference, [projects[0]], 'project-a'), null, 'deleted reference must not silently target the source');
// Retain the same Agent context across several tools, as runAgentTurn does.
const navigationRef = { current: EMPTY_CONTEXT_NAVIGATION };
const retainedAgentContext = {
  getActiveNote: () => getContextFocusedNote(navigationRef.current, projects, 'project-a'),
  openNote: (noteId: string) => { navigationRef.current = openContextNote(navigationRef.current,
    { key: `visit-${noteId}`, noteId, projectContextId: noteId }); },
};
assert.equal(retainedAgentContext.getActiveNote()?.id, 'project-a');
retainedAgentContext.openNote('project-b');
assert.equal(retainedAgentContext.getActiveNote()?.id, 'project-b', 'same Agent turn reads the newly opened project before another render');
const lockedDraft = createResourceDraftSession(projects, { selectedProjectId: retainedAgentContext.getActiveNote()?.id });
navigationRef.current = moveContextNavigation(navigationRef.current, -1);
assert.equal(retainedAgentContext.getActiveNote()?.id, 'project-a');
assert.equal(lockedDraft.scopeProjectId, 'project-b', 'a confirmed draft keeps its original scope when the user returns or browses elsewhere');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
assert.match(appSource, /React\.createElement\(NoteEditor, \{ note: activeNote, isActive: !contextNavigation\.active && !isAgentOpen && !isCommandPaletteOpen/,
  'source editor must explicitly relinquish portal and focus ownership');
assert.match(appSource, /renderNote: \(note, page, isActive\)/);
assert.match(appSource, /React\.createElement\(NoteEditor, \{ note, isActive: isActive && !isAgentOpen && !isCommandPaletteOpen/,
  'only the visible reference editor owns dialogs');
const contextPagesSource = readFileSync('src/components/ContextNotePages.tsx', 'utf8');
assert.match(contextPagesSource, /renderNote\(note, page, cursor === index\)/);
assert.match(contextPagesSource, /className="context-note-close"[^>]*onClick=\{\(\) => onMove\(-1\)\}[^>]*aria-label=\{`关闭引用笔记，返回\$\{sourceLabel\}`\}/,
  'every reference window exposes an explicit close control that returns to its source');
const contextNavigationHook = readFileSync('src/components/useContextNavigation.ts', 'utf8');
assert.match(contextNavigationHook, /event\.key === 'Escape' && current\.cursor >= 0[\s\S]*?move\(-1\)/,
  'Escape closes the visible reference window and restores the source workspace');
assert.match(appSource, /const getAgentFocusedNote = \(\) => \{\s*const navigation = contextNavigation\.getSnapshot\(\)/,
  'retained Agent context must read live navigation instead of a stale render snapshot');
assert.match(appSource, /startResourceDraftSession:\s*\(input\)\s*=>\s*\{[\s\S]*?selectedProjectId:\s*getAgentFocusedNote\(\)\?\.id/,
  'resource draft entry must use the same visible focus as plan drafts and Agent context');
assert.match(appSource, /React\.createElement\(FlowMode, \{[^\n]*isActive: !contextNavigation\.active && !isAgentOpen && !isCommandPaletteOpen/,
  'background flow must not own Escape while references or global panels are visible');
const flowSource = readFileSync(new URL('../src/components/FlowMode.tsx', import.meta.url), 'utf8');
assert.match(flowSource, /const handleKeyDown = \(e: KeyboardEvent\) => \{\s*if \(!isActive \|\| e\.defaultPrevented\) return;/,
  'flow keyboard handler must respect visible ownership and already-handled events');
assert.match(flowSource, /\}, \[isActive, isReviewing, handleExit\]\)/,
  'visibility and the latest exit closure must refresh the global listener, including current summary and elapsed time');
// Execute the actual editor callback without loading editors, model clients or storage.
const editorSource = readFileSync('src/components/NoteEditor.tsx', 'utf8');
const editorAst = ts.createSourceFile('NoteEditor.tsx', editorSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
let openInitializer: ts.Expression | undefined;
function findOpenCallback(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(editorAst) === 'openExistingNote') openInitializer = node.initializer;
  ts.forEachChild(node, findOpenCallback);
}
findOpenCallback(editorAst);assert.ok(openInitializer);
const callbackCode = ts.transpileModule(`return ${openInitializer.getText(editorAst)};`,
  {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const createOpenCallback = new Function('allNotes','projectContextId','onOpenNote','onSelectNoteByTitle','showToast',callbackCode);
const sameTitle = [{id:'first',title:'同名笔记'},{id:'chosen',title:'已修改名称'}];
const opened: any[] = [], notices: string[] = [];
const openChosen = createOpenCallback(sameTitle,'source-project',(...args: any[])=>opened.push(args),
  ()=>assert.fail('Resolved notes must not fall back to title lookup'),(message: string)=>notices.push(message));
openChosen({id:'chosen',title:'同名笔记'});
assert.deepEqual(opened,[['chosen','source-project',undefined]],'known identity survives duplicate titles and renaming');
openChosen({id:'chosen',title:'同名笔记'},'explicit-project');
assert.deepEqual(opened.at(-1),['chosen','explicit-project',undefined]);
openChosen({id:'removed',title:'同名笔记'});
assert.equal(opened.length,2,'deleted preview must not create or open another same-title note');
assert.match(notices[0],/已移除/);
const legacy: any[] = [];
createOpenCallback(sameTitle,'source-project',undefined,(...args: any[])=>legacy.push(args),()=>{})({id:'chosen',title:'同名笔记'});
assert.deepEqual(legacy,[['已修改名称','source-project']],'compatibility entry uses the live title, not a stale preview');
assert.match(editorSource,/previewingNote\?\.id === found\.id/);
assert.match(editorSource,/resolveWikiNote=\{\(title\) => resolveNoteByTitleOrAlias\(title, allNotes\)\}/,
  'wiki links opened inside a floating preview must remain inside that preview');
const previewSource = readFileSync('src/components/KnowledgePreview.tsx', 'utf8');
assert.match(previewSource, /parseWikiLink\(rawTitle, title => Boolean\(resolveWikiNote\?\.\(title\)\)\)/,
  'the preview owns wiki parsing before resolving a canonical destination title');
assert.match(editorSource,/onEdit=\{\(target, heading\) => \{ openExistingNote\(target, projectContextId, heading\);/,
  'opening the full editor uses the exact note currently shown in a nested preview');
assert.equal((appSource.match(/onOpenNote: handleOpenContextNote, projectContextId:/g)||[]).length,2,
  'source and referenced editors must both retain exact note identities and context');
console.log('Context navigation checks passed');
const appAst = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
let contextOpenInitializer: ts.Expression | undefined;
function findContextOpen(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(appAst) === 'handleOpenContextNote') contextOpenInitializer = node.initializer;
  ts.forEachChild(node, findContextOpen);
}
findContextOpen(appAst); assert.ok(contextOpenInitializer);
const contextCalls: any[] = [], contextState = { pages: [] as any[], cursor: -1 };
const actualContextOpen = new Function('allowWorkspaceNavigation', 'navigationRevisionRef', 'notesRef', 'contextNavigation', 'activeProjectContextId', 'setSidebarRevealRevision',
  ts.transpileModule(`return ${contextOpenInitializer.getText(appAst)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(
    () => true, { current: 0 }, { current: projects }, { getSnapshot: () => contextState, open: (...args: any[]) => contextCalls.push(args) }, 'old-project', () => {});
actualContextOpen('knowledge', null); assert.deepEqual(contextCalls.at(-1), ['knowledge', null, undefined], 'unscoped graph must not inherit an unrelated editor project');
contextState.pages = [{ noteId: 'knowledge', projectContextId: null }]; contextState.cursor = 0;
actualContextOpen('another-knowledge'); assert.deepEqual(contextCalls.at(-1), ['another-knowledge', null, undefined], 'a scope explicitly cleared by graph stays cleared on nested references');
actualContextOpen('knowledge', 'project-b'); assert.deepEqual(contextCalls.at(-1), ['knowledge', 'project-b', undefined]);
actualContextOpen('project-a', 'project-b'); assert.deepEqual(contextCalls.at(-1), ['project-a', 'project-a', undefined]);
actualContextOpen('knowledge', 'project-b', '定义'); assert.deepEqual(contextCalls.at(-1), ['knowledge', 'project-b', '定义']);
await import('./check-graph-ui-interactions');
await import('./check-note-editor-ui');

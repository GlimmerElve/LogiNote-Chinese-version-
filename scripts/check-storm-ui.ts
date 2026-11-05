import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { prepareStormNoteWrite } from '../src/services/stormNoteWrite';
import { rememberGeneratedContent, projectMaterialRows } from '../src/services/ragSourcePolicy';
import { enqueueLearningWrite } from '../src/services/ui/learningWriteQueue';
import { stormResearchContext, stormSourceAppendix, checkStormCitations } from '../src/services/stormResearch';

globalThis.fetch = async () => assert.fail('STORM checks cannot use a network or real model');
const compile = (path: string, environment: Record<string, unknown>, names: string[]) => {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const code = source.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
    .map(node => node.getText(source)).join('\n').replace(/^export\s+/gm, '');
  const js = ts.transpileModule(`${code}\nreturn {${names.join(',')}}`, {compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React,
  }}).outputText;
  return new Function(...Object.keys(environment), js)(...Object.values(environment));
};
const note = {id: 'synthetic-root', noteType: 'project', title: '合成研究', content: '', tags: [], links: [], backlinks: [], dueDates: [], createdAt: '', updatedAt: ''};
const deferred = () => { let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
let calls: any[] = [];
let responder: (request: any) => Promise<any> = async request => ({content: `${request.workflow} 合成正文 [S1]`});
const service = compile('src/services/stormService.ts', {rememberGeneratedContent, stormResearchContext, stormSourceAppendix, checkStormCitations,
  collectStormResearch: async (subject: string) => ({ subject, retrievedAt: '2026-10-25T00:00:00.000Z', queries: ['synthetic'], warnings: [],
    sources: [{ id: 'S1', title: '合成来源', url: 'https://example.org/synthetic', coverage: 'page-excerpt', excerpt: '合成证据。'.repeat(30) }] }),
  callLLM: async (request: any, options: any) => {
  calls.push({request, options}); return responder(request);
}}, ['createStormPipelineSession', 'runStormPipeline', 'makeRootProjectNote', 'STORM_STEPS']);
const session = service.createStormPipelineSession(note, note.title);
const stored = new Map<string, any>();
const writes: any[] = []; const progress: any[] = [];
const controller = new AbortController();
const result = await service.runStormPipeline({parentProject: note, subject: note.title, session, signal: controller.signal,
  onUpdateNote: async (value: any) => {writes.push(value);stored.set(value.id, value);}, onProgress: (value: any) => progress.push(value)});
assert.equal(calls.length, 5); assert.equal(stored.size, 5); assert.equal(writes.length, 10);
assert.ok(result.every((item: any) => stored.get(item.id)?.content === item.content));
assert.equal(session.completedSteps.size, 4); assert.ok(result.every((item: any) => item.content));
assert.ok(calls.every(call => call.options.signal === controller.signal));
assert.ok(result[0].content.includes('[[综合简报]]'));
assert.ok(result.every((item: any) => projectMaterialRows(item).length === 0), 'model output cannot masquerade as a personal restatement');

calls = []; const retrySession = service.createStormPipelineSession(note, note.title);
let failSave = true; const retryIds = new Set<string>();
const retryOptions = {parentProject: note, subject: note.title, session: retrySession, onProgress: () => {},
  onUpdateNote: async (value: any) => {retryIds.add(value.id); if (value.title === '矛盾图谱' && value.content && failSave) throw new Error('合成保存失败');}};
await assert.rejects(service.runStormPipeline(retryOptions), /保存失败/);
assert.equal(retrySession.completedSteps.size, 1); assert.ok(retrySession.outputs.contradiction);
const firstCalls = calls.length; failSave = false;
await service.runStormPipeline(retryOptions);
assert.equal(retryIds.size, 5, 'retry never creates a second report tree');
assert.equal(calls.length - firstCalls, 2, 'cached output is saved again without regenerating it');

calls = []; responder = async () => ({content: '  '});
const emptySession = service.createStormPipelineSession(note, note.title);
await assert.rejects(service.runStormPipeline({parentProject: note, subject: note.title, session: emptySession,
  onUpdateNote: () => {}, onProgress: () => {}}), /两次返回空内容/);
assert.equal(calls.length, 2); assert.equal(emptySession.completedSteps.size, 0);

calls = []; const pending = deferred(); responder = async () => pending.promise;
const abort = new AbortController(); let abortWrites = 0;
const abortRun = service.runStormPipeline({parentProject: note, subject: note.title, signal: abort.signal,
  onUpdateNote: () => {abortWrites++;}, onProgress: () => {}});
while (!calls.length) await Promise.resolve();
const beforeAbort = abortWrites; abort.abort(); pending.resolve({content: '迟到的合成结果'});
await assert.rejects(abortRun, error => error instanceof DOMException && error.name === 'AbortError');
assert.equal(abortWrites, beforeAbort, 'a transport that returns after cancellation cannot persist its result');

calls = []; responder = async request => {if (request.workflow === 'storm-abstract') throw new Error('合成摘要失败'); return {content: '合成正文 [S1]'};};
await service.runStormPipeline({parentProject: note, subject: note.title, onUpdateNote: () => {}, onProgress: () => {}});
assert.equal(calls.length, 5, 'non-critical summary falls back without aborting the research');
await assert.rejects(service.runStormPipeline({parentProject: {...note, id: 'other'}, subject: note.title, session,
  onUpdateNote: () => assert.fail('wrong binding cannot write'), onProgress: () => {}}), /不一致/);

type Tree = {type: unknown; props: Record<string, any>};
const React = {createElement: (type: unknown, props: any, ...children: any[]): Tree => ({type, props: {...props, children}})};
const all = (value: any): Tree[] => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(all) : [value, ...all(value.props?.children)];
const text = (value: any): string => typeof value === 'string' || typeof value === 'number' ? String(value)
  : Array.isArray(value) ? value.map(text).join('') : value?.props ? text(value.props.children) : '';
function harness() {
  const slots: any[] = []; let cursor = 0; const effects: (() => void)[] = [], cleanups: (() => void)[] = [];
  let live = true, afterUnmount = 0; const jobs: any[] = [], opened: string[] = [];
  const hooks = {
    useState(initial: any) {const index = cursor++; if (!(index in slots)) slots[index] = {value: typeof initial === 'function' ? initial() : initial};
      return [slots[index].value, (value: any) => {if (!live) afterUnmount++; slots[index].value = typeof value === 'function' ? value(slots[index].value) : value;}];},
    useRef(initial: any) {const index = cursor++; return slots[index] ||= {current: initial};},
    useMemo(callback: any, deps: any[]) {const index = cursor++; if (!slots[index] || deps.some((dep, i) => dep !== slots[index].deps[i])) slots[index] = {deps, value: callback()}; return slots[index].value;},
    useEffect(effect: () => void, deps: any[]) {const index = cursor++; if (!slots[index] || deps.some((dep, i) => dep !== slots[index][i])) {slots[index] = deps; effects.push(effect);}},
    useId: () => 'storm-fields',
  };
  const icons = Object.fromEntries(['Folder', 'Sparkles', 'Plus', 'FileText', 'Loader2', 'Check', 'X', 'Pause', 'Search', 'Network', 'Files', 'ShieldCheck', 'ArrowRight', 'FolderPlus'].map(name => [name, name]));
  const module = compile('src/components/StormMode.tsx', {React, ...hooks, ...icons, ...service,
    buildProjectTreeStructure: (notes: any[]) => notes.filter(item => !item.parentId).map(item => ({note: item, children: []})), ProjectTreePanel: 'tree',
    runStormPipeline: (options: any) => {const job = deferred(); jobs.push({...job, options}); return job.promise;},
  }, ['StormMode']);
  let props: any = {allNotes: [note], onUpdateNote: () => {}, onOpenNote: (id: string) => opened.push(id)};
  let nodes: Tree[] = [];
  const render = () => {cursor = 0; nodes = all(module.StormMode(props)); effects.splice(0).forEach(effect => {const cleanup: any = effect(); if (typeof cleanup === 'function') cleanups.push(cleanup);});};
  const button = (label: string) => {const found = nodes.find(node => node.type === 'button' && text(node).startsWith(label)); assert.ok(found, label); return found;};
  const click = (label: string) => {const target = button(label); assert.ok(!target.props.disabled, `${label} enabled`); const result = target.props.onClick(); render(); return result;};
  render(); render();
  return {render, button, click, jobs, opened, get nodes() {return nodes;}, get afterUnmount() {return afterUnmount;},
    fill(value: string) {nodes.find(node => node.type === 'input')!.props.onChange({target: {value}}); render();},
    select() {nodes.find(node => node.type === 'tree')!.props.onSelect(note.id); render();},
    setNotes(notes: any[]) {props = {...props, allNotes: notes}; render();},
    unmount() {live = false; cleanups.forEach(cleanup => cleanup());}};
}
const flush = async () => {for (let i = 0; i < 8; i++) await Promise.resolve();};
const ui = harness(); assert.ok(ui.button('开始 STORM').props.disabled);
ui.fill('合成新研究'); const start = ui.button('开始 STORM'); start.props.onClick(); start.props.onClick(); ui.render();
assert.equal(ui.jobs.length, 1, 'synchronous lock rejects a rapid double start');
ui.click('停止研究'); assert.equal(ui.jobs[0].options.signal.aborted, true); assert.ok(ui.button('正在停止').props.disabled);
ui.jobs[0].reject(new DOMException('停止', 'AbortError')); await flush(); ui.render();
assert.ok(ui.nodes.some(node => text(node).includes('研究已停止')));
const sameSession = ui.jobs[0].options.session; ui.click('继续本次研究'); assert.equal(ui.jobs[1].options.session, sameSession);
ui.jobs[1].reject(new Error('合成阶段失败')); await flush(); ui.render();
assert.ok(ui.nodes.some(node => node.props.role === 'alert' && text(node).includes('合成阶段失败')));
ui.click('继续本次研究'); const actualNotes = sameSession.tree.map((item: any) => ({...item, content: '合成结果'}));
ui.setNotes([note, sameSession.parentProject, ...actualNotes]); ui.jobs[2].resolve(actualNotes); await flush(); ui.render();
ui.click('综合简报'); assert.equal(ui.opened[0], actualNotes.find((item: any) => item.title === '综合简报').id);
ui.unmount();
const stale = harness(); stale.click('连接已有项目'); stale.select(); stale.setNotes([]);
assert.ok(stale.button('开始 STORM').props.disabled); assert.ok(stale.nodes.some(node => node.props.role === 'alert'));
stale.unmount();
const leaving = harness(); leaving.fill('合成研究'); leaving.click('开始 STORM'); leaving.unmount();
assert.equal(leaving.jobs[0].options.signal.aborted, true);
await assert.rejects(leaving.jobs[0].options.onUpdateNote(note), /停止/);
leaving.jobs[0].resolve([]); await flush(); assert.equal(leaving.afterUnmount, 0);

// Execute the actual App persistence closure: errors reach the UI, queued aborted work does not write.
const app = ts.createSourceFile('src/App.tsx', readFileSync('src/App.tsx', 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
let writer: ts.VariableDeclaration | undefined;
const find = (node: ts.Node) => {if (ts.isVariableDeclaration(node) && node.name.getText(app) === 'handleStormUpdateNote') writer = node; ts.forEachChild(node, find);}; find(app);
assert.ok(writer); let queued: (() => Promise<void>) | undefined; let appWrites = 0;
const code = ts.transpileModule(`const ${writer.getText(app)}; return handleStormUpdateNote;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
const update = new Function('enqueueLearningWrite', 'learningWriteQueueRef', 'handleUpdateNote', 'saveTimerRef', 'saveAllNotesToStorage', 'notesRef', 'prepareStormNoteWrite', 'stormCreatedNoteIdsRef', 'noteSaveRevisionRef', 'setNoteSaveState', 'acknowledgedSaveState', 'pendingNotesRef', code)(
  (_ref: any, callback: any) => {queued = callback; return Promise.resolve();}, {}, () => {appWrites++;}, {current: null}, async () => {throw new Error('合成落盘失败');}, {current: [note]}, prepareStormNoteWrite, {current: new Set()}, {current: 1}, () => {}, (_current: any, _written: any, success: boolean) => success ? 'saved' : 'error', {current: null});
update(note, undefined, null); await assert.rejects(queued!(), /落盘失败/); assert.equal(appWrites, 1);
const aborted = new AbortController(); update(note, aborted.signal, null); aborted.abort();
await assert.rejects(queued!(), /停止/); assert.equal(appWrites, 1);
assert.match(app.getFullText(), /onUpdateNote: handleStormUpdateNote, onOpenNote: handleSelectNote/);
const newer = {...note, textbook: {revisionId: 'synthetic-book'}, personal: {synthetic: true}, resources: [{id: 'synthetic-resource'}]};
const output = {...note, content: '合成模型报告', generatedContentBlocks: ['合成模型报告']};
const patched = prepareStormNoteWrite([newer] as any, output as any, note as any, new Set());
assert.deepEqual(patched.textbook, newer.textbook); assert.deepEqual((patched as any).personal, newer.personal); assert.deepEqual((patched as any).resources, newer.resources);
assert.equal(projectMaterialRows(patched).length, 0);
assert.throws(() => prepareStormNoteWrite([{...note, content: '用户自己的修改'}] as any, output as any, note as any, new Set()), /正文已变化/);
assert.throws(() => prepareStormNoteWrite([] as any, output as any, note as any, new Set()), /移除/);
assert.throws(() => prepareStormNoteWrite([] as any, note as any, null, new Set([note.id])), /未重新创建/);
assert.equal(prepareStormNoteWrite([output] as any, output as any, note as any, new Set()).content, output.content, 'retry after optimistic-save failure remains idempotent');
let persisted = 0;
const realQueue = {current: Promise.resolve()};
const actualWriter = new Function('enqueueLearningWrite', 'learningWriteQueueRef', 'handleUpdateNote', 'saveTimerRef', 'saveAllNotesToStorage', 'notesRef', 'prepareStormNoteWrite', 'stormCreatedNoteIdsRef', 'noteSaveRevisionRef', 'setNoteSaveState', 'acknowledgedSaveState', 'pendingNotesRef', code)(
  enqueueLearningWrite, realQueue, () => {}, {current: null}, async () => {persisted++;}, {current: [note]}, prepareStormNoteWrite, {current: new Set()}, {current: 1}, () => {}, () => 'saved', {current: null});
await actualWriter(note, undefined, null);
assert.equal(persisted, 1, 'actual queue writer awaits storage directly, not another job on its own queue');
console.log('STORM UI passed: same-session retry, real output identities, empty-result rejection, save errors, abort/late-write protection, stale selection, result navigation, metadata preservation, edit/delete conflicts and generated-source isolation. All model/storage operations are synthetic.');

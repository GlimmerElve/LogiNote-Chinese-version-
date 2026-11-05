import assert from 'node:assert/strict';
import { Realm } from '@mdxeditor/gurx';
import * as mdx from '@mdxeditor/editor';
import { createEditor, $getRoot, $isTextNode, $isElementNode, HISTORY_PUSH_TAG, UNDO_COMMAND, REDO_COMMAND } from 'lexical';
import { createEmptyHistoryState, registerHistory } from '@lexical/history';
import { createMdxEditorRuntime, type MdxEditorCallbacks } from '../src/components/MdxEditorRuntime';
import { mdxNoteContentPlugins } from '../src/components/mdxNoteContentPlugins';
import { mdxRuntime } from '../src/components/mdxRuntime';
import type { ArgDoc } from '../src/services/argumentDoc/types';
import type { LearningReviewRecord } from '../src/services/textbook/types';
import type { GeneratedMathScope } from '../src/services/textbook/generatedMath';

// Real production Realm, schema, import visitors, Lexical history and runtime.
// Memory-only synthetic fixtures: no DOM, private notes, vault, Worker or API.
// node --require ./scripts/node-os-userinfo-fallback.cjs --import ./scripts/test-ui-assets.mjs --import tsx scripts/check-mdx-editor-runtime.ts
const graph = (id: string): ArgDoc => ({ doc_id: id, title: id, created_at: '', updated_at: '', iteration: 0, status: 'draft', nodes: [], edges: [] });
const review = (id: string): LearningReviewRecord => ({ schemaVersion: 1, id, sessionId: '', projectNoteId: '', rootProjectId: '',
  startedAt: '', endedAt: '', title: id, userEditedTitle: false, rawRestatement: '', editedRestatement: '', userEditedRestatement: false,
  summary: '', episodeId: '', argumentDocIds: [], status: 'analyzed', createdAt: '', updatedAt: '' });

function fixture(initial: MdxEditorCallbacks = {}) {
  let callbacks = initial, source = '', options: { scope: GeneratedMathScope; textbook: boolean } = { scope: 'knowledge-section', textbook: false };
  const runtime = createMdxEditorRuntime(() => callbacks), realm = new Realm();
  let argumentUpdates = 0, reviewUpdates = 0;
  const publish = realm.pub.bind(realm);
  (realm as any).pub = (node: any, value: any) => {
    if (value?.getDoc) argumentUpdates++;
    if (value?.getRecord) reviewUpdates++;
    return publish(node, value);
  };
  const plugins = [mdxRuntime.corePlugin({ initialMarkdown: '', trim: false }), runtime.plugin,
    ...mdxNoteContentPlugins({ ...runtime.nodeCallbacks, source: () => source, liveImportOptions: () => options })];
  for (const plugin of plugins) plugin.init?.(realm);
  const baseline = { argument: argumentUpdates, review: reviewUpdates };
  const editor = createEditor({ namespace: 'synthetic-live-editor-runtime', nodes: realm.getValue(mdx.usedLexicalNodes$), onError: error => { throw error; } });
  const importSource = (value: string) => {
    source = value;
    editor.update(() => {
      const root = $getRoot(); root.clear();
      mdxRuntime.importMarkdownToLexical({ root, markdown: value, visitors: realm.getValue(mdx.importVisitors$),
        syntaxExtensions: realm.getValue(mdx.syntaxExtensions$), mdastExtensions: realm.getValue(mdxRuntime.mdastExtensions$),
        jsxComponentDescriptors: realm.getValue(mdx.jsxComponentDescriptors$), directiveDescriptors: realm.getValue(mdx.directiveDescriptors$),
        codeBlockEditorDescriptors: realm.getValue(mdx.codeBlockEditorDescriptors$), defaultCodeBlockLanguage: realm.getValue(mdx.defaultCodeBlockLanguage$) });
    }, { discrete: true });
  };
  return { runtime, realm, editor, importSource, plugins,
    setCallbacks: (value: MdxEditorCallbacks) => { callbacks = value; },
    setImportOptions: (value: typeof options) => { options = value; },
    updates: () => ({ argument: argumentUpdates - baseline.argument, review: reviewUpdates - baseline.review }),
    state: () => editor.getEditorState().read(() => $getRoot().getTextContent()),
    json: () => JSON.stringify(editor.getEditorState().toJSON()),
  };
}

{
  let graphReads = 0, reviewReads = 0;
  const f = fixture({ getArgumentDoc: () => { graphReads++; assert.fail('unreferenced graph data must not be visited'); },
    getLearningReviewRecord: () => { reviewReads++; assert.fail('unreferenced reviews must not be visited'); } });
  for (let i = 0; i < 100; i++) f.runtime.refresh();
  assert.equal(graphReads, 0); assert.equal(reviewReads, 0); assert.deepEqual(f.updates(), { argument: 0, review: 0 });
  console.log('PASS plain-text editor: 100 prop commits resolve zero graphs/reviews and publish zero decorator updates');
}
{
  let doc: ArgDoc | undefined = graph('used'), record: LearningReviewRecord | undefined = review('used');
  const reads: string[] = [];
  const f = fixture({ getArgumentDoc: id => { reads.push(`graph:${id}`); return doc; },
    getLearningReviewRecord: id => { reads.push(`review:${id}`); return record; } });
  const firstView = f.runtime.nodeCallbacks.argument.getDoc?.('used'); f.runtime.nodeCallbacks.review.getRecord?.('used');
  reads.length = 0;
  for (let i = 0; i < 20; i++) f.runtime.refresh();
  assert.equal(reads.length, 40); assert.ok(reads.every(id => id.endsWith(':used')));
  assert.deepEqual(f.updates(), { argument: 0, review: 0 });
  // Same reference AND unchanged revision timestamp: do not freeze live data.
  doc.title = 'external in-place graph'; doc.nodes.push({ id: 'new', text: 'in-place node' } as any); record.expanded = true; f.runtime.refresh();
  assert.deepEqual(f.updates(), { argument: 1, review: 1 });
  const nextView = f.runtime.nodeCallbacks.argument.getDoc?.('used');
  assert.notEqual(nextView, firstView); assert.notEqual(nextView?.nodes, firstView?.nodes);
  assert.equal(firstView?.nodes.length, 0); assert.equal(nextView?.nodes[0].text, 'in-place node');
  assert.equal(f.runtime.nodeCallbacks.argument.getDoc?.('used'), nextView, 'unchanged used data retains its view identity');
  f.runtime.refresh(); assert.deepEqual(f.updates(), { argument: 1, review: 1 });
  doc = { ...doc, title: 'replacement' }; record = { ...record, title: 'replacement' }; f.runtime.refresh();
  assert.deepEqual(f.updates(), { argument: 2, review: 2 });
  doc = undefined; record = undefined; f.runtime.refresh();
  assert.deepEqual(f.updates(), { argument: 3, review: 3 });
  doc = graph('used'); f.runtime.nodeCallbacks.argument.getDoc?.('used'); f.runtime.refresh();
  assert.deepEqual(f.updates(), { argument: 4, review: 3 }, 'reading one duplicate before the commit effect must still invalidate its siblings');
  f.runtime.disconnect(); reads.length = 0; f.runtime.refresh(); assert.deepEqual(reads, []);
  console.log('PASS only requested IDs refresh; unchanged snapshots do not notify; in-place edits, replacements and deletion notify without schema init');
}
{
  const calls: string[] = [], firstDoc = graph('same-id'), otherDoc = graph('same-id');
  firstDoc.title = 'first'; otherDoc.title = 'other';
  const a = fixture({ getArgumentDoc: () => firstDoc, onWikiLinkClick: id => calls.push(`old:${id}`) });
  const b = fixture({ getArgumentDoc: () => otherDoc, onWikiLinkClick: id => calls.push(`other:${id}`) });
  assert.equal(a.runtime.nodeCallbacks.argument.getDoc?.('same-id')?.title, 'first');
  assert.equal(b.runtime.nodeCallbacks.argument.getDoc?.('same-id')?.title, 'other');
  a.setCallbacks({ getArgumentDoc: () => ({ ...firstDoc, title: 'latest' }), onWikiLinkClick: id => calls.push(`new:${id}`) });
  a.runtime.refresh(); assert.deepEqual(a.updates(), { argument: 1, review: 0 }); assert.deepEqual(b.updates(), { argument: 0, review: 0 });
  a.runtime.nodeCallbacks.wiki.onClick('A'); b.runtime.nodeCallbacks.wiki.onClick('B'); assert.deepEqual(calls, ['new:A', 'other:B']);
  a.runtime.disconnect(); a.runtime.refresh(); assert.deepEqual(b.updates(), { argument: 0, review: 0 });
  console.log('PASS two editor realms with identical IDs stay isolated and retained callback proxies use latest handlers');
}
{
  const f = fixture();
  f.importSource('普通正文 y=x^2 与 **加粗 **。');
  assert.ok(!f.json().includes('"type":"math"')); assert.ok(!f.json().includes('"format":1'));
  const plugins = f.plugins;
  f.setImportOptions({ scope: 'all', textbook: false }); f.importSource('普通正文 y=x^2。');
  assert.ok(f.json().includes('"type":"math"'), 'a previously initialized importer must read the current scope');
  f.setImportOptions({ scope: 'knowledge-section', textbook: true }); f.importSource('普通正文 **加粗 **。');
  assert.ok(f.json().includes('"format":1'), 'current manifest mode enables bounded textbook formatting recovery');
  f.setImportOptions({ scope: 'knowledge-section', textbook: false }); f.importSource('普通正文 **加粗 **。');
  assert.ok(!f.json().includes('"format":1')); assert.equal(f.plugins, plugins);
  const other = fixture(); other.importSource('普通正文 y=x^2。'); assert.ok(!other.json().includes('"type":"math"'));
  console.log('PASS one initialized schema imports with latest math/manifest scope in both directions, isolated from another editor');
}
{
  let doc = graph('used');
  const f = fixture({ getArgumentDoc: () => doc });
  const history = createEmptyHistoryState(), unregister = registerHistory(f.editor, history, 0);
  try {
    f.importSource('before');
    f.editor.update(() => {
      const paragraph = $getRoot().getFirstChild(); assert.ok($isElementNode(paragraph));
      const text = paragraph.getFirstChild(); assert.ok($isTextNode(text)); text.setTextContent('after');
    }, { discrete: true, tag: HISTORY_PUSH_TAG });
    assert.ok(history.undoStack.length > 0);
    f.runtime.nodeCallbacks.argument.getDoc?.('used');
    const state = f.editor.getEditorState(), beforeUndo = [...history.undoStack], beforeRedo = [...history.redoStack];
    doc = { ...doc, title: 'saved elsewhere' }; f.runtime.refresh();
    assert.equal(f.editor.getEditorState(), state); assert.deepEqual(history.undoStack, beforeUndo); assert.deepEqual(history.redoStack, beforeRedo);
    f.editor.dispatchCommand(UNDO_COMMAND, undefined); await Promise.resolve(); assert.equal(f.state(), 'before');
    f.editor.dispatchCommand(REDO_COMMAND, undefined); await Promise.resolve(); assert.equal(f.state(), 'after');
    console.log('PASS real Lexical editor state/history unchanged by business refresh; existing undo and redo still work');
  } finally { unregister(); f.runtime.disconnect(); }
}
console.log('mdx editor runtime: 5 groups passed');

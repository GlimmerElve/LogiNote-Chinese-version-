import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Realm } from '@mdxeditor/gurx';
import * as mdx from '@mdxeditor/editor';
import { createEditor, $getRoot } from 'lexical';
import { mdxRuntime } from '../src/components/mdxRuntime';
import { mdxNoteContentPlugins } from '../src/components/mdxNoteContentPlugins';
import { generatedMathCitationIds } from '../src/services/textbook/generatedMathCitations';
import { prepareReadingDocument } from '../src/services/textbook/readingDocument';
import { createRecentReadingSessions } from '../src/services/textbook/recentReadingSessions';
import type { ReadingInput } from '../src/services/textbook/readingDocument';
import { prepareMarkdownForMdx } from '../src/services/markdownMdxCompatibility';

const refs = [{ sourceId: '7' }, { sourceId: '8' }, { sourceId: '9' }];
const ids = generatedMathCitationIds(refs, [{ sourceId: 'L1' }, { sourceId: '8' }]);
assert.deepEqual(ids, ['7', '8', '9']);
assert.deepEqual(generatedMathCitationIds([{}, { sourceId: '5' }]), ['1', '5']);
assert.deepEqual(generatedMathCitationIds([{ sourceId: '' }]), ['1'], 'legacy empty IDs use the same one-based fallback as references UI');
assert.deepEqual(generatedMathCitationIds(undefined, [{ sourceId: 'L1' }]), []);
assert.deepEqual(refs, [{ sourceId: '7' }, { sourceId: '8' }, { sourceId: '9' }], 'source metadata is never rewritten');

const body = '### 本项目需要掌握的知识点\n\nx=8[8]；x=[8]；x=[0,1]；y=9[L1]。';
const original = body;
const mathRows = (node: any): any[] => node?.type === 'element' && String(node.properties?.className).includes('math-inline')
  ? [node] : (node.children || []).flatMap(mathRows);
const known = prepareReadingDocument({ content: body, citationIds: ids });
const knownMath = known.pages.flatMap(mathRows).map(node => node.children.map((child: any) => child.value || '').join(''));
assert.ok(knownMath.includes('x = 8'));
assert.ok(knownMath.includes('x = \\left[8\\right]'), 'known IDs do not erase single-entry vector RHS');
assert.ok(knownMath.includes('x = \\left[0,1\\right]'));
assert.ok(knownMath.every(value => !value.includes('L1')), 'alphanumeric source markers remain text');
assert.match(JSON.stringify(known.pages), /\[8\]/u);
assert.equal(body, original);
assert.notDeepEqual(known.pages, prepareReadingDocument({ content: body }).pages, 'known citation IDs affect prepared display only');
const inherited = prepareReadingDocument({ content: 'x=8[8]。', contextManifest: { sources: [{ sourceId: '8' }] } as any });
assert.equal(inherited.pages.flatMap(mathRows)[0].children[0].value, 'x = 8', 'nested textbook worker can use its manifest IDs');

// The same initialized production editor schema observes new metadata through
// its live ref, without rebuilding plugins or changing the Markdown source.
let current = { scope: 'all' as const, textbook: false, citationIds: undefined as readonly string[] | undefined };
const realm = new Realm();
for (const plugin of [mdxRuntime.corePlugin({ initialMarkdown: '', trim: false }), ...mdxNoteContentPlugins({ liveImportOptions: () => current })]) plugin.init?.(realm);
const editor = createEditor({ namespace: 'citation-wiring', nodes: realm.getValue(mdx.usedLexicalNodes$), onError: error => { throw error; } });
function importBody() {
  editor.update(() => {
    const root = $getRoot(); root.clear();
    mdxRuntime.importMarkdownToLexical({ root, markdown: body, visitors: realm.getValue(mdx.importVisitors$),
      syntaxExtensions: realm.getValue(mdx.syntaxExtensions$), mdastExtensions: realm.getValue(mdxRuntime.mdastExtensions$),
      jsxComponentDescriptors: realm.getValue(mdx.jsxComponentDescriptors$), directiveDescriptors: realm.getValue(mdx.directiveDescriptors$),
      codeBlockEditorDescriptors: realm.getValue(mdx.codeBlockEditorDescriptors$), defaultCodeBlockLanguage: realm.getValue(mdx.defaultCodeBlockLanguage$) });
  }, { discrete: true });
  return JSON.stringify(editor.getEditorState().toJSON());
}
const before = importBody(); current = { ...current, citationIds: ids }; const after = importBody();
assert.notEqual(after, before);
assert.match(after, /"type":"text","version":1/u);
assert.ok(after.includes('x = 8') && after.includes('[8]'));
assert.ok(after.includes('x = \\\\left[8\\\\right]'), 'editor preserves the vector');
current = { ...current, citationIds: undefined }; assert.equal(importBody(), before, 'a previous note cannot leak citation IDs into another import');

// The real editor importer sees the MDX compatibility-prepared source, where
// literal comparisons have a Markdown escape. Recover cases from that source
// without turning \\ row separators into single backslashes.
const casesTex=String.raw`m(a)= \begin{cases} 0 & a<0 \\ -a^2 & 0\le a\le2 \\ 4-4a & a>2. \end{cases}`;
const casesSource=`因此 [ ${casesTex} ] 边界保持一致。[8]`;
const casesMarkdown=prepareMarkdownForMdx(casesSource).markdown;
const casesRealm=new Realm();
for(const plugin of [mdxRuntime.corePlugin({initialMarkdown:'',trim:false}),...mdxNoteContentPlugins({mathRecovery:'all',source:()=>casesMarkdown,citationIds:ids})])plugin.init?.(casesRealm);
const casesEditor=createEditor({namespace:'cases-source-wiring',nodes:casesRealm.getValue(mdx.usedLexicalNodes$),onError:error=>{throw error;}});
casesEditor.update(()=>mdxRuntime.importMarkdownToLexical({root:$getRoot(),markdown:casesMarkdown,visitors:casesRealm.getValue(mdx.importVisitors$),
  syntaxExtensions:casesRealm.getValue(mdx.syntaxExtensions$),mdastExtensions:casesRealm.getValue(mdxRuntime.mdastExtensions$),
  jsxComponentDescriptors:casesRealm.getValue(mdx.jsxComponentDescriptors$),directiveDescriptors:casesRealm.getValue(mdx.directiveDescriptors$),
  codeBlockEditorDescriptors:casesRealm.getValue(mdx.codeBlockEditorDescriptors$),defaultCodeBlockLanguage:casesRealm.getValue(mdx.defaultCodeBlockLanguage$)}),{discrete:true});
const importedMath=(node:any):string[]=>[...(node.type==='math'?[node.tex]:[]),...(node.children||[]).flatMap(importedMath)];
assert.deepEqual(importedMath(casesEditor.getEditorState().toJSON().root),[casesTex]);
assert.equal(casesSource,`因此 [ ${casesTex} ] 边界保持一致。[8]`,'actual import does not rewrite original Markdown');

// Cache identity compares metadata by value; merely cloning source arrays does
// not trigger worker preparation. A real citation change invalidates parsing
// while retaining the independently saved continuous-reading position.
let made = 0;
const timers = new Set<() => void>();
const pool = createRecentReadingSessions((input: ReadingInput) => ({ id: ++made, input, ready: Promise.resolve(undefined),
  disposed: false, dispose() { this.disposed = true; }, get isDisposed() { return this.disposed; } }),
{ setTimer(run) { timers.add(run); return run; }, clearTimer(timer) { timers.delete(timer as () => void); } });
try {
  const first = pool.acquire('same-note', { content: body, citationIds: ids }); await first.session.ready;
  first.remember({ block: 3, element: 2, offset: 47 }); first.release();
  const clone = pool.acquire('same-note', { content: body, citationIds: [...ids] }); await clone.session.ready;
  assert.equal(clone.session, first.session, 'equivalent metadata reuses prepared document'); clone.release();
  const changed = pool.acquire('same-note', { content: body, citationIds: ['7', '9'] }); await changed.session.ready;
  assert.notEqual(changed.session, first.session); assert.equal(first.session.isDisposed, true);
  assert.deepEqual(changed.getPosition(), { block: 3, element: 2, offset: 47 }); changed.release();
} finally { pool.clear(); }
assert.equal(timers.size, 0);

for (const [path, snippets] of Object.entries({
  'src/components/NoteEditor.tsx': ['generatedMathCitationIds(note?.referenceSources', 'citationIds={citationIds}'],
  'src/components/MdxNoteEditor.tsx': ['importOptionsRef.current = { scope: mathRecovery, textbook: Boolean(textbookManifest), citationIds }', 'liveImportOptions: () => importOptionsRef.current'],
  'src/components/KnowledgePreview.tsx': ['generatedMathCitationIds(activeNote.referenceSources', "scope: activeNote.noteType === 'knowledge' ? 'all' : 'knowledge-section', citationIds"],
  'src/components/FlowMode.tsx': ['generatedMathCitationIds(note.referenceSources', 'citationIds={citationIds}'],
  'src/components/textbook/PlainNoteReading.tsx': ['[remarkGeneratedMath, { citationIds }]', 'NoteReadingCitationContext.Provider value={citationIds}'],
  'src/components/textbook/ReadingFragment.tsx': ['contextManifest: manifest, citationIds, anchorPrefix', 'citationKey === citationKey'],
})) {
  const source = fs.readFileSync(path, 'utf8');
  for (const snippet of snippets) assert.ok(source.includes(snippet), `${path}: ${snippet}`);
}
console.log(JSON.stringify({ status: 'passed', checks: ['known IDs only', 'worker document', 'nested manifest', 'same live MDX importer', 'cases source rows', 'vectors', 'L1', 'metadata cache identity', 'reading position', 'UI entry wiring'], modelRequests: 0 }));

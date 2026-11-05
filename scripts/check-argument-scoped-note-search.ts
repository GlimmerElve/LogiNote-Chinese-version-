import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NoteItem } from '../src/types.ts';
import { createNoteReferenceIndex } from '../src/electron/rag/noteReferenceIndex.ts';
import { searchNotes } from '../src/electron/noteRag.ts';

// Mock embeddings and synthetic temporary index only; no real note root or model load.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network allowed in scoped note search checks');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-argument-note-scope-'));
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
function vector(cosine = 1): number[] {
  const result = Array<number>(384).fill(0); result[0] = cosine; result[1] = Math.sqrt(1 - cosine ** 2); return result;
}
function note(id: string, title: string, content: string, aliases?: string[]): NoteItem {
  return { id, title, content, aliases, noteType: 'knowledge', tags: [], links: [], backlinks: [], dueDates: [],
    createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z' };
}
const outside = note('other-project', '外部高分选择过载', '选择过载 '.repeat(25));
const allowed = note('in-scope', '范围内低分笔记', '选择过载是选项超过认知处理阈值时难以决策。' + '这是一般说明。'.repeat(20), ['选择过载别名']);
const third = note('third-project', '第三项目笔记', '在第三项目中选择过载也被讨论过。');
let embeddings = 0;
const index = createNoteReferenceIndex(temporary, async text => {
  embeddings++;
  return text.includes('外部高分') ? vector() : text.includes('范围内低分') ? vector(0.4) : vector(0.3);
});

try {
  await index.indexAll([outside, allowed, third]); assert.equal(embeddings, 3);
  const query = '选择过载', queryVector = vector();
  const globalTop = await index.search(query, queryVector, 1);
  assert.equal(globalTop[0].noteId, outside.id);
  assert.deepEqual(globalTop.filter(hit => hit.noteId === allowed.id), [], 'Old post-top-k filtering would lose the scoped candidate');
  const scopedTop = await index.search(query, queryVector, 1, [allowed.id]);
  assert.equal(scopedTop.length, 1); assert.equal(scopedTop[0].noteId, allowed.id);
  assert.equal(scopedTop[0].score, 0.4); assert.equal(scopedTop[0].snippet, allowed.content);
  pass('其他项目全库最高分不会挤掉本项目top-k，范围限制发生在候选语料排名前');

  const legacy = await index.search(query, queryVector, 5);
  assert.deepEqual(await index.search(query, queryVector, 5, undefined), legacy);
  assert.deepEqual(await index.search(query, queryVector, 5, [outside.id, allowed.id, third.id]), legacy);
  assert.equal(legacy.length, 3); assert.equal(legacy[0].noteId, outside.id);
  assert.equal(embeddings, 3, 'Searching the factory never re-embeds source content');
  pass('未传范围完全保留legacy行为，全ID范围保持原排序/分数/出处，不重建或重复向量化');

  assert.deepEqual(await index.search(query, queryVector, 5, ['选择过载别名']), []);
  assert.deepEqual(await index.search(query, queryVector, 5, [allowed.title]), []);
  assert.deepEqual(await index.search(query, queryVector, 5, ['IN-SCOPE']), []);
  const allowedTwo = await index.search(query, queryVector, 5, [allowed.id, third.id, allowed.id]);
  assert.deepEqual(new Set(allowedTwo.map(hit => hit.noteId)), new Set([allowed.id, third.id]));
  assert.ok(allowedTwo.every(hit => hit.passage?.schemaVersion === 2 && hit.noteType === 'knowledge'));
  pass('只按host稳定ID精确筛选，标题/别名不自行授权或扩大范围，重复ID不重复计权');

  const mutableScope = [allowed.id], pending = index.search(query, queryVector, 5, mutableScope);
  mutableScope.push(outside.id);
  assert.deepEqual((await pending).map(hit => hit.noteId), [allowed.id]);
  const lexical = await index.search(query, [], 1, [allowed.id]);
  assert.equal(lexical[0].noteId, allowed.id); assert.equal(lexical[0].score, 0);
  pass('首次await前固定范围，晚改数组不扩权；无语义向量仍在已授权范围内保留关键词召回');

  const file = path.join(temporary, 'note-embeddings.json'), saved = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, '{synthetic corrupt cache');
  assert.deepEqual(await index.search(query, queryVector, 5, []), []);
  await assert.rejects(index.search(query, queryVector, 5));
  await fs.writeFile(file, saved);
  // No setNoteRagDataRoot call has occurred: reaching store() would throw. This is an
  // actual public-wrapper empty-scope check, while model invocation order is source-checked.
  assert.deepEqual(await searchNotes(query, 5, []), []);
  pass('显式空范围不读衍生文件，不访问未初始化store，不加载查询模型');

  const wrapperSource = await fs.readFile(new URL('../src/electron/noteRag.ts', import.meta.url), 'utf8');
  const wrapper = wrapperSource.slice(wrapperSource.indexOf('export async function searchNotes('));
  assert.match(wrapper, /allowedNoteIds\?: string\[\]/);
  assert.ok(wrapper.indexOf('if (selectedIds?.length === 0) return []') < wrapper.indexOf('const index = store()'));
  assert.ok(wrapper.indexOf('if (selectedIds?.length === 0) return []') < wrapper.indexOf('await generateEmbedding(q)'));
  assert.match(wrapper, /return index\.search\(q, qv, k, selectedIds\)/);
  const indexSource = await fs.readFile(new URL('../src/electron/rag/noteReferenceIndex.ts', import.meta.url), 'utf8');
  const searchSource = indexSource.slice(indexSource.indexOf('  async function search('));
  assert.ok(searchSource.indexOf('selectedIds.has(entry.noteId)') < searchSource.indexOf('const rows = entries.flatMap'));
  assert.ok(searchSource.indexOf('selectedIds.has(entry.noteId)') < searchSource.indexOf('df = buildDf(texts)'));
  pass('源码接线明确空范围早于查询embedding，稳定ID筛选早于DF/BM25/dense/fusion/top-k');

  console.log(`Argument scoped note search checks passed: ${checks} groups (3 synthetic notes, mock embeddings; 0 model calls; no real vault/index/score/cognition writes).`);
} finally {
  globalThis.fetch = originalFetch;
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('loginote-argument-note-scope-'));
  await fs.rm(temporary, { recursive: true, force: true });
}

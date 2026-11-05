import assert from 'node:assert/strict';
import { appendProjectKnowledgeRows, pendingProjectKnowledgeRows, readProjectKnowledgeRows, rebaseProgressiveKnowledge } from '../src/services/progressiveLearning/knowledgeProjection';
import type { NoteItem } from '../src/types';
import { enqueueLearningWrite, flushLatestNoteWrites } from '../src/services/ui/learningWriteQueue';

const rows = [{ title: '定义域', summary: '允许输入的值组成的集合。' }, { title: '唯一对应', summary: '一个输入只能对应一个输出。' }];
const empty = appendProjectKnowledgeRows('', rows);
assert.equal(empty, '### 本项目需要掌握的知识点\n\n#### [[定义域]]\n\n允许输入的值组成的集合。\n\n#### [[唯一对应]]\n\n一个输入只能对应一个输出。\n');
assert.deepEqual(readProjectKnowledgeRows(empty), rows);
assert.equal(appendProjectKnowledgeRows(empty, [...rows, { ...rows[0], summary: '不同生成描述' }]), empty);
const manual = '# 人工目标\n原文保留。\n\n### 本项目需要掌握的知识点\n\n[[定义域]]：我自己写的说明。\n\n### 后记\n后文也保留。\n';
const combined = appendProjectKnowledgeRows(manual, rows);
assert.ok(combined.startsWith(manual.slice(0, manual.indexOf('### 后记'))));
assert.ok(combined.endsWith('### 后记\n后文也保留。\n'));
assert.equal(readProjectKnowledgeRows(combined)[0].summary, '我自己写的说明。');
assert.deepEqual(pendingProjectKnowledgeRows(manual, combined), [rows[1]]);
const fenced = '```md\n### 本项目需要掌握的知识点\n[[假的]]：代码示例。\n```\n';
assert.deepEqual(readProjectKnowledgeRows(fenced), []);
assert.ok(appendProjectKnowledgeRows(fenced, rows).startsWith(fenced));
assert.ok(appendProjectKnowledgeRows('', [{ title: '安全标题', summary: '两行\n[[不是新链接]]' }]).includes('两行 ［［不是新链接］］'));
assert.throws(() => appendProjectKnowledgeRows('', [{ title: '坏]]标题', summary: '不能引入坏双链' }]));
const base: NoteItem = { id: 'p', title: '计划', noteType: 'project', content: '已保存正文', tags: [], links: [], backlinks: [], dueDates: [], createdAt: 'a', updatedAt: 'a' };
const disk = { ...base, content: appendProjectKnowledgeRows(base.content, rows), links: rows.map(row => row.title), updatedAt: 'b' };
const draft = { ...base, content: '尚未保存的输入', title: '新标题', tags: ['新标签'], updatedAt: 'c' };
const change = { before: base, note: disk, rows };
const rebased = rebaseProgressiveKnowledge(draft, base, change)!;
assert.ok(rebased.content.startsWith(draft.content));
assert.deepEqual(rebased.tags, draft.tags); assert.equal(rebased.title, draft.title); assert.equal(rebased.updatedAt, draft.updatedAt);
assert.equal(rebaseProgressiveKnowledge(draft, { ...base, content: '更新的磁盘基线' }, change), null);
// Live editors may emit their pre-append body while typing. Persist the append
// until it has been imported, while retaining every newly typed character.
const pending = pendingProjectKnowledgeRows(draft.content, rebased.content);
const nextKeystroke = appendProjectKnowledgeRows(draft.content + '继续输入', pending);
assert.ok(nextKeystroke.startsWith('尚未保存的输入继续输入'));
assert.deepEqual(readProjectKnowledgeRows(nextKeystroke), rows);
assert.equal(appendProjectKnowledgeRows(nextKeystroke, pending), nextKeystroke);
console.log('知识点正文投影通过：标准双链、幂等追加、人工内容与输入草稿保留、失效基线拒绝');
const queue = { current: Promise.resolve() as Promise<unknown> };
let pendingWrite: string | null = 'draft', saves = 0, settleCount = 0;
await flushLatestNoteWrites(queue, () => pendingWrite, async () => {
  saves++; pendingWrite = null;
}, async () => {
  if (settleCount++ === 0) void enqueueLearningWrite(queue, async () => { pendingWrite = 'background-append'; });
});
assert.equal(saves, 2); assert.equal(pendingWrite, null);
pendingWrite = 'unsaved';
await assert.rejects(flushLatestNoteWrites(queue, () => pendingWrite, async () => { throw Error('write failed'); }), /write failed/u);
assert.equal(pendingWrite, 'unsaved');
console.log('退出保存通过：后台追加重基后排空最新草稿，真实写入失败仍阻止退出');

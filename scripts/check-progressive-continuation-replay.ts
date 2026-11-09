/** Synthetic parser + real runtime/store recovery; no model or user data. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProgressiveStreamParser, parseProgressiveResponse } from '../src/services/progressiveLearning/stream';
import { ProgressiveLearningStore } from '../src/electron/progressiveLearningStore';
import { createProgressiveController, type ProgressiveStorageAdapter } from '../src/services/progressiveLearning/runtime';
import type { ProgressiveBeginReply, ProgressiveCourse, ProgressiveMainline } from '../src/services/progressiveLearning/types';
import type { NoteItem } from '../src/types';
import type { StreamChunk } from '../src/services/llmStreamService';

const plan: ProgressiveMainline = { title: '导数与单调性', objectives: ['根据导数符号判断函数变化'],
  pages: [{ id: 'main-1', title: '用导数看单调性与极值', objectives: ['区分驻点与极值点'] }] };
const prefix = '# 用导数看单调性与极值\n\n'
  + '先明确研究区间，再检查函数在区间内的连续与可导条件。导数符号描述局部变化方向，不能仅凭某点导数为零就认定该点是极值点。'
  + '在相邻区间比较导数符号，才能识别函数是否由增转减或由减转增。没有符号变化的驻点可能不是极值点。'
  + '例如三次函数在原点的导数为零，但左右两边都保持递增，所以原点不是极值点。'
  + '判断时还要明确所研究的是区间内部还是端点，不能把内部点的判定规则直接套到所有边界情况。'
  + '完整解答应写出研究区间、导数表达式、分区符号和最终结论，并解释结论所依赖的条件。';
const suffix = '\n\n比较二次函数在原点两侧的导数符号：左侧为负、右侧为正，函数由减转增，因此原点取得局部极小值。';
const hook = { id: 'hook-main-1', kind: 'reflection' as const, prompt: '为什么导数为零不一定是极值点？' };
const ending = `\n@@QUESTIONS\n[]\n@@HOOK\n${JSON.stringify(hook)}\n@@END\n`;
const envelope = `@@LESSON\n${prefix}${suffix}${ending}`;
const checks: string[] = [];

assert.ok(prefix.length > 200);
const hundred = new ProgressiveStreamParser({ plan, body: prefix });
assert.equal(hundred.append(`@@LESSON\n${prefix.slice(0, 100)}`).body, prefix,
  'The old implementation falsely rejected a still-in-flight exact 100-character replay');
assert.equal(hundred.append(prefix.slice(100) + suffix + ending).body, prefix + suffix);
assert.equal(hundred.finish().body, prefix + suffix);
checks.push('Exact 100-character partial replay keeps the saved body visible and completes without duplication');

for (const size of [1, 2, 7, 31, 99, 100, 101, prefix.length - 1, prefix.length + 1, envelope.length]) {
  const parser = new ProgressiveStreamParser({ plan, body: prefix });
  for (let offset = 0; offset < envelope.length; offset += size) {
    const parsed = parser.append(envelope.slice(offset, offset + size));
    assert.ok(parsed.body.startsWith(prefix), `Saved text changed at packet size ${size}`);
    // Incomplete protocol markers can temporarily trail the last body block;
    // the saved text must remain an exact prefix, never a repeated body copy.
    assert.ok((prefix + suffix).startsWith(parsed.body) || parsed.body.startsWith(prefix + suffix),
      `Replay diverged from the unchanged body at packet size ${size}`);
  }
  assert.equal(parser.finish().body, prefix + suffix);
}
checks.push('Complete replay plus new content is packet-boundary independent, including one-character chunks');

for (const marker of ['CONCEPTS', 'QUESTIONS', 'HOOK', 'END']) {
  assert.throws(() => parseProgressiveResponse(`@@LESSON\n${prefix.slice(0, 100)}\n@@${marker}\n`, { plan, body: prefix }), /部分已保存内容/u);
}
const changed = prefix.slice(0, 110) + '此处试图改写已保存的条件。' + prefix.slice(130);
assert.throws(() => parseProgressiveResponse(`@@LESSON\n${changed}${ending}`, { plan, body: prefix }), /不同版本/u);
assert.equal(parseProgressiveResponse(`@@LESSON\n${ending}`, { plan, body: prefix }).body, prefix,
  'A metadata-only continuation must remain supported');
checks.push('Early metadata boundaries and genuine prefix rewrites are rejected, while metadata-only continuation preserves the original');

for (const whitespace of ['\n', '\n\n\n', '\r\n', '   ', '\r\n \n  ']) {
  const savedBody = prefix + whitespace;
  assert.equal(parseProgressiveResponse(`@@LESSON\n${prefix}${ending}`, { plan, body: savedBody }).body, savedBody,
    'A replay may omit only the saved trailing whitespace; its original bytes must still be retained');
  if (whitespace.endsWith('\n')) {
    assert.equal(parseProgressiveResponse(`@@LESSON\n${savedBody}${ending.slice(1)}`, { plan, body: savedBody }).body, savedBody,
      'A protocol boundary may consume one trailing newline from the exact replay');
  }
}
assert.throws(() => parseProgressiveResponse(`@@LESSON\n${prefix}${ending}`, { plan, body: prefix + '这一条必要条件不能丢失。\n' }), /部分已保存内容/u);
checks.push('Only missing trailing newlines, CRLF or spaces are tolerated at a metadata boundary; every saved whitespace byte remains and missing semantic text still rejects');

const overlap = prefix.slice(-50), overlapAddition = overlap + suffix;
assert.equal(parseProgressiveResponse(`@@LESSON\n${overlapAddition}${ending}`, { plan, body: prefix }).body, prefix + suffix);
assert.equal(parseProgressiveResponse(`@@LESSON\n${suffix}${ending}`, { plan, body: prefix }).body, prefix + suffix);
checks.push('Exact suffix overlap and ordinary append-only continuation retain their previous merge behavior');

const root = await fs.mkdtemp(path.resolve('build/progressive-continuation-replay-'));
const at = '2026-11-09T00:00:00.000Z';
const note: NoteItem = { id: 'continuation-replay-fixture', title: plan.title, noteType: 'project', content: '',
  dueDates: [], tags: [], links: [], backlinks: [], createdAt: at, updatedAt: at };
const createStore = () => new ProgressiveLearningStore(root, { readTarget: async id => {
  assert.equal(id, note.id); return { note, root: note, isLeaf: true };
} });
let store = createStore();
const adapter = (owner: number): ProgressiveStorageAdapter => ({
  load: id => store.command({ op: 'load', projectNoteId: id }, owner) as Promise<ProgressiveCourse | null>,
  begin: (id, sourcePackets) => store.command({ op: 'begin', projectNoteId: id, sourcePackets }, owner) as Promise<ProgressiveBeginReply>,
  checkpoint: (lease, checkpoint) => store.command({ op: 'checkpoint', lease, checkpoint }, owner) as Promise<ProgressiveCourse>,
  publish: (lease, teaching) => store.command({ op: 'publish', lease, teaching }, owner) as Promise<ProgressiveCourse>,
  saveProgress: (id, progress) => store.command({ op: 'save-progress', projectNoteId: id, progress }, owner) as Promise<ProgressiveCourse>,
  interrupt: (lease, error) => store.command({ op: 'interrupt', lease, error }, owner) as Promise<ProgressiveCourse>,
});
const first = await adapter(1).begin(note.id, []);
await adapter(1).checkpoint(first.lease!, { sequence: 1, plan,
  rawDraft: `@@PLAN\n${JSON.stringify(plan)}\n@@LESSON\n${prefix}`, bodyDraft: prefix });
await adapter(1).interrupt(first.lease!, 'Synthetic interruption');
const requests: string[] = [];
function streamOf(text: string, size: number) {
  return new ReadableStream<StreamChunk>({ start(controller) {
    for (let offset = 0; offset < text.length; offset += size) controller.enqueue({ type: 'content', text: text.slice(offset, offset + size) });
    controller.close();
  } });
}
const partial = createProgressiveController({ note, allNotes: [note] }, {
  storage: adapter(2), loadMaterials: async () => [], registerFlush: () => () => {}, checkpointIntervalMs: 100000,
  stream: async course => { requests.push(course.generation.requestId); assert.equal(course.generation.bodyDraft, prefix);
    return streamOf(`@@LESSON\n${prefix.slice(0, 100)}`, 7); },
});
await partial.retry(); await partial.flush();
assert.equal((await adapter(2).load(note.id))!.generation.bodyDraft, prefix);
assert.equal((await adapter(2).load(note.id))!.firstPage, null);
assert.ok(partial.getSnapshot().error?.includes('尚未完整'));
partial.dispose();

// A new store instance and controller represent a desktop restart, rather than
// merely retaining the first controller's in-memory body.
store = createStore();
const restored = createProgressiveController({ note, allNotes: [note] }, {
  storage: adapter(3), loadMaterials: async () => [], registerFlush: () => () => {}, checkpointIntervalMs: 100000,
  stream: async course => { requests.push(course.generation.requestId); assert.equal(course.generation.bodyDraft, prefix);
    return streamOf(envelope, 1); },
});
await restored.retry();
assert.equal(restored.getSnapshot().phase, 'ready');
assert.equal(restored.getSnapshot().page?.body, prefix + suffix);
const saved = (await adapter(3).load(note.id))!;
assert.equal(saved.firstPage?.body, prefix + suffix);
assert.equal(saved.pages?.length, 1);
assert.deepEqual(saved.plan, plan);
assert.deepEqual(requests, [first.course.generation.requestId, first.course.generation.requestId]);
restored.dispose();
checks.push('Actual runtime/store retains the full saved prefix after partial-replay EOF, reloads from disk, resumes the same task and publishes exactly once');

const result = { passed: true, root, checks, packetSizes: 10, realModelRequests: 0, realUserDataAccessed: false,
  savedBodyUnchangedUntilComplete: true, sameRequestRecovered: true };
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

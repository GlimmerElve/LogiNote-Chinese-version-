import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProgressiveLearningStore } from '../src/electron/progressiveLearningStore';
import { createProgressiveController, type ProgressiveStorageAdapter } from '../src/services/progressiveLearning/runtime';
import { callLLMStream, type StreamChunk } from '../src/services/llmStreamService';
import { streamProgressiveFirstPage } from '../src/services/progressiveLearning/generation';
import { getWorkflowById } from '../src/workflows/workflowRegistry';
import type { ProgressiveBeginReply, ProgressiveCourse, ProgressiveMainline } from '../src/services/progressiveLearning/types';
import type { LlmCallRequest, NoteItem } from '../src/types';

const root = await fs.mkdtemp(path.resolve('build/progressive-stop-retry-'));
const at = '2026-11-01T00:00:00.000Z';
const note: NoteItem = { id: 'stop-retry-fixture', title: '函数与定义域', noteType: 'project', content: '',
  dueDates: [], tags: [], links: [], backlinks: [], createdAt: at, updatedAt: at };
const store = new ProgressiveLearningStore(root, { readTarget: async id => {
  assert.equal(id, note.id); return { note, root: note, isLeaf: true };
} });
const adapter = (owner: number): ProgressiveStorageAdapter => ({
  load: id => store.command({ op: 'load', projectNoteId: id }, owner) as Promise<ProgressiveCourse | null>,
  begin: (id, sourcePackets) => store.command({ op: 'begin', projectNoteId: id, sourcePackets }, owner) as Promise<ProgressiveBeginReply>,
  checkpoint: (lease, checkpoint) => store.command({ op: 'checkpoint', lease, checkpoint }, owner) as Promise<ProgressiveCourse>,
  publish: (lease, teaching) => store.command({ op: 'publish', lease, teaching }, owner) as Promise<ProgressiveCourse>,
  saveProgress: (id, progress) => store.command({ op: 'save-progress', projectNoteId: id, progress }, owner) as Promise<ProgressiveCourse>,
  interrupt: (lease, error) => store.command({ op: 'interrupt', lease, error }, owner) as Promise<ProgressiveCourse>,
});
const plan: ProgressiveMainline = { title: '函数与定义域', objectives: ['理解允许输入与唯一输出'],
  pages: [{ id: 'main-1', title: '函数的输入限制', objectives: ['解释定义域的含义'] }] };
const prefix = '# 函数的输入限制\n\n函数给每个允许输入指定唯一的输出，允许输入的范围叫定义域。判断函数之前，应先检查规则是否能对输入产生有效输出。\n\n';
const suffix = '以平方根函数为例，根号内的表达式必须非负；以分式为例，分母必须非零。把这些限制一起考虑，才能判断某个输入是否属于定义域。';
const hook = { id: 'hook-main-1', kind: 'reflection' as const, prompt: '请说明为什么给出公式后仍须说明定义域。' };
const seed = await adapter(1).begin(note.id, []);
await adapter(1).checkpoint(seed.lease!, { sequence: 1, plan,
  rawDraft: `@@PLAN\n${JSON.stringify(plan)}\n@@LESSON\n${prefix}`, bodyDraft: prefix });
await adapter(1).interrupt(seed.lease!, '测试中断');

let releaseOld!: (value: ReadableStream<StreamChunk>) => void;
let streamCalls = 0, beginCalls = 0;
const sentRequests: string[] = [];
const owner = adapter(2);
const storage: ProgressiveStorageAdapter = { ...owner, begin: async (...args) => { beginCalls++; return owner.begin(...args); } };
function streamOf(text: string) {
  return new ReadableStream<StreamChunk>({ start(controller) {
    controller.enqueue({ type: 'content', text }); controller.close();
  } });
}
const controller = createProgressiveController({ note, allNotes: [note] }, {
  storage, loadMaterials: async () => [], registerFlush: () => () => {}, checkpointIntervalMs: 100000,
  stream: async course => {
    streamCalls++; sentRequests.push(course.generation.requestId);
    if (streamCalls === 1) return new Promise<ReadableStream<StreamChunk>>(resolve => { releaseOld = resolve; });
    assert.equal(course.generation.bodyDraft, prefix, 'resume must keep the saved prefix');
    return streamOf(`@@LESSON\n${suffix}\n@@HOOK\n${JSON.stringify(hook)}\n@@END`);
  },
});
const pending = controller.retry();
for (let i = 0; !releaseOld && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
assert.ok(releaseOld, 'old provider must be waiting');
await controller.stop();
const retryOne = controller.retry(), retryTwo = controller.retry();
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(streamCalls, 1, 'retry must wait for the aborted provider to settle');
assert.equal(beginCalls, 1, 'no second lease may begin while the old run is settling');
releaseOld(streamOf(''));
await Promise.all([pending, retryOne, retryTwo]);
assert.equal(streamCalls, 2, 'two simultaneous retries must create exactly one resumed request');
assert.equal(beginCalls, 2);
assert.deepEqual(sentRequests, [seed.course.generation.requestId, seed.course.generation.requestId]);
assert.equal(controller.getSnapshot().phase, 'ready');
assert.equal(controller.getSnapshot().page!.body, prefix + suffix);
assert.equal((await owner.load(note.id))!.firstPage!.body, prefix + suffix);
controller.dispose();

const payloads: any[] = [];
const cache = new Map<string, string>();
cache.set('loginote_llm_settings', JSON.stringify({ defaultProviderId: 'deepseek-default', workflowBinding: {}, providers: [{
  id: 'deepseek-default', name: 'Test provider', apiType: 'openai-compatible', baseUrl: 'https://example.invalid',
  apiKey: '', selectedModel: 'fixture-model', models: ['fixture-model'], enabled: true, createdAt: at,
}] }));
const previousWindow = (globalThis as any).window, previousStorage = (globalThis as any).localStorage;
(globalThis as any).localStorage = { getItem: (key: string) => cache.get(key) ?? null,
  setItem: (key: string, value: string) => cache.set(key, value), removeItem: (key: string) => cache.delete(key) };
(globalThis as any).window = { electronAPI: { llm: {
  stream: async (payload: unknown) => { payloads.push(payload); return `mock-${payloads.length}`; },
  onChunk: () => () => {}, onEnd: () => () => {}, onError: () => () => {}, cancel: async () => {},
} } };
try {
  const request: LlmCallRequest = { providerId: '', model: '', workflow: 'review-tutor', userInput: 'Budget compatibility check',
    maxTokensOverride: 99999, temperatureOverride: 0.97, skipMemoryInjection: true, skipProfileInjection: true };
  const legacy = await callLLMStream(request);
  assert.equal(payloads[0].maxTokens, getWorkflowById('review-tutor')!.defaultParams.maxTokens,
    'ordinary stream requests must retain their previous workflow budget');
  assert.equal(payloads[0].temperature, getWorkflowById('review-tutor')!.defaultParams.temperature);
  await legacy.cancel();
  const course = (await owner.load(note.id))!;
  const progressive = await streamProgressiveFirstPage(course, new AbortController().signal);
  assert.equal(payloads[1].maxTokens, 6500);
  assert.equal(payloads[1].temperature, 0.3);
  assert.equal(payloads[1].outputSchema, undefined, 'the progressive protocol opts out of whole-chapter JSON');
  await progressive.cancel();
} finally {
  (globalThis as any).window = previousWindow;
  (globalThis as any).localStorage = previousStorage;
}
const receipt = { status: 'passed', checks: 3, root, coverage: [
  'stop后立即继续会等待已abort旧run收尾，再沿同一request续写；并发重试只有一个新lease',
  '现有流式调用保留原工作流输出预算和temperature，不因request override改变行为',
  '渐进课程仅通过显式scoped options启用6500 token与0.3采样预算，并禁用整章JSON格式',
] };
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));

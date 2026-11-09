import assert from 'node:assert/strict';
import { LlmStreamToolCalls, ollamaAgentMessages, strictToolArguments } from '../src/electron/llmStreamToolCalls';
import type { LlmConversationMessage } from '../src/types';

const rejects = (run: () => unknown) => assert.throws(run, /流式工具调用不完整或参数格式无效，未执行工具。/u);
let checks = 0;
const openAi = new LlmStreamToolCalls('openai-compatible');
assert.equal(openAi.hasCalls, false); openAi.appendOpenAi(undefined); openAi.appendOpenAi(null); openAi.appendOpenAi([]);
openAi.appendOpenAi([{ index: 1, id: 'call-b', type: 'function', function: { name: 'query_', arguments: '{"b":' } },
  { index: 0, id: 'call-a', function: { name: 'get_', arguments: '{"text":"' } }]);
openAi.appendOpenAi([{ index: 0, function: { name: 'note', arguments: '中文🙂"}' } }, { index: 1, function: { name: 'data', arguments: '2}' } }]);
assert.equal(openAi.hasCalls, true);
assert.deepEqual(openAi.finish(), [{ id: 'call-a', name: 'get_note', arguments: { text: '中文🙂' } }, { id: 'call-b', name: 'query_data', arguments: { b: 2 } }]);
assert.deepEqual(openAi.finish(), openAi.finish()); checks++;

const failedBatch = new LlmStreamToolCalls('openai-compatible');
rejects(() => failedBatch.appendOpenAi([{ index: 0, id: 'good-prefix', function: { name: 'tool', arguments: '{}' } }, { index: -1 }]));
rejects(() => failedBatch.finish()); rejects(() => failedBatch.appendOpenAi([])); checks++;

const noArguments = new LlmStreamToolCalls('openai-compatible');
noArguments.appendOpenAi([{ index: 0, id: 'empty', function: { name: 'list_notes', arguments: '' } }]);
assert.deepEqual(noArguments.finish()[0].arguments, {}); checks++;
const repeated = new LlmStreamToolCalls('openai-compatible');
repeated.appendOpenAi([{ index: 0, id: 'id', function: { name: 'get', arguments: '' } }]);
repeated.appendOpenAi([{ index: 0, function: { name: 'get', arguments: '{}' } }]);
assert.equal(repeated.finish()[0].name, 'getget', 'Do not guess repeated fragments into another name'); checks++;

for (const value of [false, 1, {}, 'not a delta', [null], [{ index: -1 }], [{ index: 256 }], [{ index: 0.2 }], [{ function: { name: 'x' } }],
  [{ index: 0, type: 'server_tool' }], [{ index: 0, function: null }], [{ index: 0, id: 1 }], [{ index: 0, function: { arguments: {} } }],
  [{ index: 0, function: { name: 'x'.repeat(513) } }]]) rejects(() => new LlmStreamToolCalls('openai-compatible').appendOpenAi(value));
checks++;
for (const raw of ['{', '{"broken":', '[]', 'null', '1', '"a"']) {
  const incomplete = new LlmStreamToolCalls('openai-compatible');
  incomplete.appendOpenAi([{ index: 0, id: 'id', function: { name: 'tool', arguments: raw } }]); rejects(() => incomplete.finish());
}
for (const missing of [{ index: 0, id: 'id' }, { index: 0, function: { name: 'tool', arguments: '{}' } }, { index: 0, id: ' ', function: { name: 'tool' } }]) {
  const incomplete = new LlmStreamToolCalls('openai-compatible'); incomplete.appendOpenAi([missing]); rejects(() => incomplete.finish());
}
checks++;
const duplicate = new LlmStreamToolCalls('openai-compatible');
duplicate.appendOpenAi([0, 1].map(index => ({ index, id: 'same', function: { name: 'tool', arguments: '{}' } })));
rejects(() => duplicate.finish()); checks++;

const native = new LlmStreamToolCalls('ollama'), original = { value: [1, 2] };
native.appendOllama([{ function: { index: 0, name: 'first', arguments: original } }]); original.value.push(3);
native.appendOllama([{ function: { index: 0, name: 'second', arguments: { value: 3 } } }]);
assert.deepEqual(native.finish(), [{ id: 'call-0', name: 'first', arguments: { value: [1, 2] } }, { id: 'call-1', name: 'second', arguments: { value: 3 } }]);
checks++;
for (const value of [1, {}, [null], [{ function: {} }], [{ function: { name: 'x', arguments: '{}' } }], [{ function: { name: '', arguments: {} } }],
  [{ type: 'other', function: { name: 'x', arguments: {} } }]]) rejects(() => new LlmStreamToolCalls('ollama').appendOllama(value));
rejects(() => native.appendOpenAi([])); rejects(() => openAi.appendOllama([])); checks++;

const all = new LlmStreamToolCalls('openai-compatible');
all.appendOpenAi(Array.from({ length: 256 }, (_, index) => ({ index, id: 'id-' + index, function: { name: 'tool', arguments: '{}' } })));
assert.equal(all.finish().length, 256); rejects(() => all.appendOpenAi([{ index: 256 }]));
const tooMany = new LlmStreamToolCalls('ollama'); tooMany.appendOllama(Array.from({ length: 256 }, () => ({ function: { name: 'tool', arguments: {} } })));
rejects(() => tooMany.appendOllama([{ function: { name: 'extra', arguments: {} } }])); checks++;
const size = new LlmStreamToolCalls('openai-compatible');
size.appendOpenAi([{ index: 0, id: 'big', function: { name: 'tool', arguments: ' '.repeat(1024 * 1024) } }]);
rejects(() => size.appendOpenAi([{ index: 0, function: { arguments: ' ' } }])); checks++;

for (const value of [undefined, null, [], 1, true, { broken: undefined }, { broken: () => 1 }, { broken: NaN }, { broken: Infinity }]) rejects(() => strictToolArguments(value));
const cycle: any = {}; cycle.self = cycle; rejects(() => strictToolArguments(cycle));
let touched = false; const getter = Object.defineProperty({}, 'unsafe', { enumerable: true, get() { touched = true; return 1; } });
rejects(() => strictToolArguments(getter)); assert.equal(touched, false);
assert.deepEqual(strictToolArguments(''), {}); assert.deepEqual(strictToolArguments('{"data":[1,null,true]}'), { data: [1, null, true] }); checks++;

const history: LlmConversationMessage[] = [{ role: 'user', content: '查资料' }, { role: 'assistant', content: '', toolContinuationId: 'opaque',
  toolCalls: [{ id: 'call-a', name: 'get_note', arguments: { id: 'n1' } }] }, { role: 'tool', content: '实际结果', toolCallId: 'call-a' },
  { role: 'assistant', content: '结论', toolContinuationId: 'final' }];
const before = JSON.stringify(history);
const serialized = ollamaAgentMessages(history, message => message.toolContinuationId === 'opaque' ? 'SYNTHETIC_PRIVATE_THINKING' : 'SYNTHETIC_FINAL_THINKING') as any[];
assert.equal(serialized[1].thinking, 'SYNTHETIC_PRIVATE_THINKING'); assert.equal(serialized[3].thinking, 'SYNTHETIC_FINAL_THINKING');
assert.deepEqual(serialized[1].tool_calls[0].function.arguments, { id: 'n1' });
assert.equal(serialized[1].content, ''); assert.equal(serialized[2].tool_name, 'get_note');
assert.ok(!JSON.stringify(serialized).includes('tool_call_id') && !JSON.stringify(serialized).includes('toolContinuationId'));
assert.equal(JSON.stringify(history), before); checks++;
assert.deepEqual(ollamaAgentMessages(history), [
  { role: 'user', content: '查资料' }, { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'get_note', arguments: { id: 'n1' } } }] },
  { role: 'tool', tool_name: 'get_note', content: '实际结果' }, { role: 'assistant', content: '结论' },
]); rejects(() => ollamaAgentMessages([{ role: 'tool', content: 'orphan' }])); checks++;

const reused = ollamaAgentMessages([
  { role: 'assistant', content: '', toolCalls: [{ id: 'call-0', name: 'first', arguments: {} }] },
  { role: 'tool', toolCallId: 'call-0', content: 'one' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call-0', name: 'second', arguments: {} }] },
  { role: 'tool', toolCallId: 'call-0', content: 'two' },
]) as any[];
assert.equal(reused[1].tool_name, 'first'); assert.equal(reused[3].tool_name, 'second'); checks++;

console.log(JSON.stringify({ passed: true, checks, openAiFragmentAggregation: true, ollamaCompleteObjectAccumulation: true,
  strictFinalArguments: true, boundedCallsAndArguments: true, nativeOllamaHistory: true, realModelRequests: 0, networkCalls: 0, userStateAccessed: false }));

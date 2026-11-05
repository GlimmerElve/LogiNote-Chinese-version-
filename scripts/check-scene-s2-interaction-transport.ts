import assert from 'node:assert/strict';
import type { LlmCallRequest } from '../src/types';
import { invokeS2InteractionModel } from '../src/services/scene/sceneS2Canvas';

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Transport checks prohibit real providers and network');
const input = { origin: 'user', task: '解释连线', scope: { actions: ['reply'] }, context: { goal: '合成场景' } };
let calls = 0;
try {
  const result = await invokeS2InteractionModel('最小公开交互协议', input, async (request: LlmCallRequest) => {
    calls++;
    assert.equal(request.workflow, 'agent-scene-setup');
    assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true);
    assert.equal(request.systemPromptOverride, '最小公开交互协议');
    assert.deepEqual(JSON.parse(request.userInput), input);
    assert.equal(request.maxTokensOverride, 3000);
    assert.deepEqual(request.outputSchema, { type: 'object' });
    return { content: '{"reply":"公开回复"}' };
  }, undefined, 3000);
  assert.equal(result, '{"reply":"公开回复"}'); assert.equal(calls, 1);
  await assert.rejects(invokeS2InteractionModel('协议', input, async () => {
    calls++; return { content: '{"actions":[', diagnostics: { finishReason: 'length' } };
  }), /截断/);
  assert.equal(calls, 2, 'Truncated provider output is rejected without retry');
  await assert.rejects(invokeS2InteractionModel('协议', input, async () => { calls++; throw new Error('Synthetic transport unavailable'); }), /Synthetic transport unavailable/);
  assert.equal(calls, 3, 'Provider failures do not trigger repair or retry');
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(invokeS2InteractionModel('协议', input, async () => { calls++; return { content: '{}' }; }, stopped.signal), { name: 'AbortError' });
  assert.equal(calls, 3, 'A stopped request never reaches the provider');
  const late = new AbortController();
  await assert.rejects(invokeS2InteractionModel('协议', input, async () => { calls++; late.abort(); return { content: '{"reply":"迟到"}' }; }, late.signal), { name: 'AbortError' });
  assert.equal(calls, 4);
  console.log('S2 interaction transport passed: one-call public prompt, no ambient profile/memory injection, exact JSON input/output reserve, truncation/failure without retry, stopped and late-request cancellation. Synthetic IO only.');
} finally { globalThis.fetch = previousFetch; }

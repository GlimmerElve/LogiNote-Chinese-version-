import assert from 'node:assert/strict';
import { discoverLlmModels, parseDiscoveredLlmModels, proxyLlmRequest } from '../src/electron/apiHandlers';
import type { LlmIpcRequest } from '../src/electron/ipcTypes';

// Synthetic provider payloads only: never read credentials or access the network.
const deepSeekModels = { data: [
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', model: 'Display alias' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
] };
assert.deepEqual(parseDiscoveredLlmModels('openai-compatible', deepSeekModels),
  ['deepseek-v4-flash', 'deepseek-v4-pro'], 'display names must not become callable model IDs');
assert.deepEqual(parseDiscoveredLlmModels('openai-compatible', { data: [
  { name: 'Display only' }, { model: 'Ambiguous alias' }, { id: '', name: 'Not an ID' },
  { id: 42, name: 'Invalid ID' },
] }), [], 'OpenAI-compatible model objects require a valid id; do not guess from a label');
assert.deepEqual(parseDiscoveredLlmModels('openai-compatible', { data: [
  { id: ' models/Case-Sensitive-ID ', name: 'Friendly name' },
  { id: 'MixedCase/Provider-Model' }, { id: 'MixedCase/Provider-Model' },
] }), ['MixedCase/Provider-Model', 'models/Case-Sensitive-ID'].sort((a, b) => a.localeCompare(b)),
'preserve case and non-Gemini ID namespaces while trimming and deduplicating');
assert.deepEqual(parseDiscoveredLlmModels('anthropic', { data: [
  { id: 'claude-synthetic-20261018', name: 'Display alias', display_name: 'Friendly label' },
  { name: 'Display only' },
] }), ['claude-synthetic-20261018']);
assert.deepEqual(parseDiscoveredLlmModels('gemini', { models: [
  { name: 'models/gemini-synthetic', displayName: 'Gemini Synthetic', id: 'Wrong-ID',
    supportedGenerationMethods: ['generateContent', 'countTokens'] },
  { name: 'models/embedding-only', supportedGenerationMethods: ['embedContent'] },
  { displayName: 'Not a resource name' },
] }), ['gemini-synthetic'], 'Gemini uses its resource name and excludes non-generation models');
assert.deepEqual(parseDiscoveredLlmModels('ollama', { models: [
  { model: 'canonical:latest', name: 'Other alias', id: 'Wrong-ID' },
  { name: 'name-only:8b' }, { model: 'model-only:4b' },
  { model: ' ', name: 'valid-fallback:latest' },
] }), ['canonical:latest', 'model-only:4b', 'name-only:8b', 'valid-fallback:latest']);
assert.deepEqual(parseDiscoveredLlmModels('openai-compatible', { data: [
  null, false, 0, {}, { id: 'a'.repeat(201), name: 'Do not use label' },
  ' explicit-id ', { id: 'explicit-id' }, { id: ' ' },
] }), ['explicit-id']);
for (const payload of [null, undefined, 'invalid', 1, [], {}, { data: null }]) {
  assert.deepEqual(parseDiscoveredLlmModels('openai-compatible', payload), []);
}
assert.equal(parseDiscoveredLlmModels('openai-compatible', {
  data: Array.from({ length: 600 }, (_, i) => ({ id: `synthetic-${i}`, name: `Label ${i}` })),
}).length, 500, 'retain the bounded discovery list');

const request: LlmIpcRequest = {
  provider: { apiType: 'openai-compatible', baseUrl: 'https://synthetic.invalid',
    apiKey: 'synthetic-key-not-a-secret', models: [], selectedModel: '' },
  systemPrompt: 'Synthetic check', userInput: 'Synthetic input', temperature: 0, maxTokens: 1,
};
const previousFetch = globalThis.fetch;
try {
  let phase: 'models' | 'chat' = 'models';
  let modelsPayload: unknown = deepSeekModels;
  let status = 200;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), `https://synthetic.invalid/${phase === 'models' ? 'models' : 'chat/completions'}`);
    assert.equal(init?.method, phase === 'models' ? 'GET' : 'POST');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer synthetic-key-not-a-secret');
    if (phase === 'models') return new Response(JSON.stringify(modelsPayload), { status });
    assert.equal(JSON.parse(String(init?.body)).model, 'deepseek-v4-flash',
      'the discovered model ID must reach the actual request body without display-name substitution');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Synthetic response' } }] }));
  };
  const discovered = await discoverLlmModels(request);
  assert.deepEqual(discovered, { ok: true, models: ['deepseek-v4-flash', 'deepseek-v4-pro'] });
  phase = 'chat';
  const result = await proxyLlmRequest({ ...request,
    provider: { ...request.provider, models: discovered.models, selectedModel: discovered.models[0] } });
  assert.equal(result.content, 'Synthetic response');
  phase = 'models';
  modelsPayload = { data: [{ name: 'Display only' }] };
  const invalid = await discoverLlmModels(request);
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.models, [], 'do not report discovery success with only display names');
  status = 401;
  const unauthorized = await discoverLlmModels(request);
  assert.equal(unauthorized.ok, false);
  assert.deepEqual(unauthorized.models, []);
  assert.match(unauthorized.error || '', /HTTP 401/);
  assert.equal(calls, 4);
  for (const [apiType, baseUrl, expectedPath, payload, model] of [
    ['gemini', 'https://synthetic.invalid/v1beta/', '/v1beta/models', { models: [{ name: 'models/gemini-synthetic' }] }, 'gemini-synthetic'],
    ['anthropic', 'https://synthetic.invalid/v1', '/v1/models', { data: [{ id: 'claude-synthetic' }] }, 'claude-synthetic'],
    ['ollama', 'http://synthetic.invalid:11434', '/api/tags', { models: [{ model: 'synthetic:8b' }] }, 'synthetic:8b'],
  ] as const) {
    globalThis.fetch = async (input, init) => {
      assert.equal(new URL(String(input)).pathname, expectedPath, 'discovery and generation must use the same configured API base');
      assert.equal(init?.method, 'GET');
      return new Response(JSON.stringify(payload));
    };
    assert.deepEqual(await discoverLlmModels({ ...request, provider: { ...request.provider, apiType, baseUrl } }),
      { ok: true, models: [model] });
  }
  globalThis.fetch = async () => { throw new Error('synthetic network failure ' + request.provider.apiKey); };
  const safeFailure = await discoverLlmModels(request);
  assert.equal(safeFailure.ok, false);
  assert(!safeFailure.error?.includes(request.provider.apiKey), 'network failures cannot echo credentials into the settings UI');
} finally {
  globalThis.fetch = previousFetch;
}
console.log('LLM model discovery checks passed (protocol IDs, display-name isolation, mocked transport).');

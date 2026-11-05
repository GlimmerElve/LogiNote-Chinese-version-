import assert from 'node:assert/strict';
import { runSceneMultiAgent } from '../src/services/agent/sceneMultiAgent';
import { buildBody, proxyLlmRequest, streamLlmRequest } from '../src/electron/apiHandlers';
import { ensureJsonObjectPrompt, JSON_OBJECT_OUTPUT } from '../src/workflows/structuredOutput';
import { getWorkflowById } from '../src/workflows/workflowRegistry';
import { SCENE_UNDERSTANDING_PROMPT } from '../src/services/scene/sceneUnderstanding';
import { runSceneSetupStage, SceneSetupError } from '../src/services/scene/sceneSetupStage';
import { readSafeLlmHttpFailure, safeLlmHttpError } from '../src/services/llmHttpFailure';
import { understandingFixture } from './scene-semantic-fixture';
import type { LlmIpcRequest } from '../src/electron/ipcTypes';

const provider = { apiType: 'openai-compatible' as const, baseUrl: 'https://fixture.invalid', apiKey: 'synthetic-secret',
  selectedModel: 'deepseek-flash', models: ['deepseek-flash'] };
const request: LlmIpcRequest = { provider, systemPrompt: 'Understand the request without tools.', userInput: 'A difficult practice question.',
  temperature: .2, maxTokens: 4096, outputSchema: JSON_OBJECT_OUTPUT };
assert.match(SCENE_UNDERSTANDING_PROMPT, /json/iu);
assert.equal(ensureJsonObjectPrompt('ordinary chat'), 'ordinary chat');
assert.equal(ensureJsonObjectPrompt('ordinary chat', {}), 'ordinary chat');
assert.equal(ensureJsonObjectPrompt('Return JSON.', JSON_OBJECT_OUTPUT), 'Return JSON.');
const guarded = ensureJsonObjectPrompt(request.systemPrompt, JSON_OBJECT_OUTPUT);
assert.match(guarded, /valid JSON object/u);
assert.equal(ensureJsonObjectPrompt(guarded, JSON_OBJECT_OUTPUT), guarded, 'guard is idempotent');
const body = JSON.parse(buildBody('openai-compatible', 'deepseek-flash', request.systemPrompt, request.userInput,
  .2, 4096, 'synthetic-secret', JSON_OBJECT_OUTPUT).body);
assert.deepEqual(body.response_format, { type: 'json_object' });
assert.match(body.messages[0].content, /json/iu, 'the transmitted prompt, not merely the TS source, contains the instruction');
const ordinary = JSON.parse(buildBody('openai-compatible', 'deepseek-flash', 'ordinary chat', 'hello', .2, 100, 'synthetic-secret').body);
assert.equal(ordinary.messages[0].content, 'ordinary chat'); assert.equal(ordinary.response_format, undefined);

const previousFetch = globalThis.fetch;
try {
  let httpCalls = 0;
  const userRequest = 'Create a difficult single-choice practice scene.';
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://fixture.invalid/chat/completions');
    const transmitted = JSON.parse(String(init?.body)); httpCalls++;
    assert.deepEqual(transmitted.response_format, { type: 'json_object' });
    if (!transmitted.messages.some((message: any) => /json/iu.test(message.content))) {
      return new Response(JSON.stringify({ error: { message: "To use response_format of type json_object, the messages must contain the word json." } }), { status: 400 });
    }
    const input = JSON.parse(transmitted.messages.at(-1).content);
    const content = input.phase === 'understand'
      ? { sceneSkill: 'S1', understanding: understandingFixture('request', userRequest, { intent: 'build-scene' }) }
      : { capabilityPlan: { needs: [{ id: 'practice', goal: '逐题选择', capabilityIds: ['single-choice'] }], missing: [] }, recipeId: 'guided-practice', requestedCapabilities: ['single-choice'], requestedPromptModules: ['turn-agent-planning'],
        interactionPlan: 'One difficult question per turn.', rationale: 'Honor the single-choice constraint.' };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] }), { status: 200 });
  };
  const result = await runSceneMultiAgent({ userRequest, sceneSkillConstraint: 'S1', recipeConstraint: 'guided-practice', requestedCapabilities: ['single-choice'],
    callLlm: call => proxyLlmRequest({ ...request, systemPrompt: call.systemPromptOverride!, userInput: call.userInput,
      maxTokens: call.maxTokensOverride!, outputSchema: getWorkflowById(call.workflow)?.outputSchema }) });
  assert.equal(result.recommendation.valid, true); assert.equal(httpCalls, 2, 'actual scene understanding and assembly cross the mock HTTP adapter');

  globalThis.fetch = async (_url, init) => {
    const transmitted = JSON.parse(String(init?.body));
    assert.match(transmitted.messages[0].content, /valid JSON object/u);
    assert.deepEqual(transmitted.response_format, { type: 'json_object' });
    return new Response('data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 });
  };
  const chunks: string[] = [];
  await streamLlmRequest(request, chunk => { if (chunk.type === 'content') chunks.push(chunk.text); });
  assert.deepEqual(chunks, ['{}'], 'streaming shares the JSON mode guard');

  const providerError = JSON.stringify({ error: { message: "To use response_format of type json_object, the messages must contain the word json. synthetic-secret https://private.invalid/?key=secret PRIVATE_NOTE", type: 'invalid_request_error' } });
  globalThis.fetch = async () => new Response(providerError, { status: 400 });
  await assert.rejects(proxyLlmRequest(request), error => {
    assert.ok(error instanceof Error); assert.equal(readSafeLlmHttpFailure(error.message)?.reason, 'json-mode-instruction');
    assert.doesNotMatch(error.message, /synthetic-secret|private.invalid|PRIVATE_NOTE/u); return true;
  });
  await assert.rejects(streamLlmRequest(request, () => {}), error => error instanceof Error && readSafeLlmHttpFailure(error.message)?.reason === 'json-mode-instruction');
  let stageCalls = 0;
  await assert.rejects(runSceneSetupStage({ stage: 'understand', request: { providerId: '', model: '', workflow: 'agent-scene-setup', userInput: '{}' },
    maxOutputChars: 1000, invoke: async () => { stageCalls++; throw safeLlmHttpError(400, providerError); }, validate: raw => raw }), error => {
      assert.ok(error instanceof SceneSetupError); assert.equal(error.code, 'model-http-400');
      assert.match(error.message, /JSON/u); assert.doesNotMatch(error.message, /synthetic-secret|private.invalid|PRIVATE_NOTE/u); return true;
    });
  assert.equal(stageCalls, 1, 'HTTP errors do not trigger blind retries or claims of missing user conditions');
  for (const [status, raw, reason] of [
    [400, 'max_tokens must be less than the limit', 'max-tokens-invalid'],
    [400, 'context_length_exceeded', 'context-too-long'],
    [400, 'response_format is not supported', 'response-format-unsupported'],
    [404, 'model_not_found', 'model-invalid'],
    [401, 'synthetic-secret', 'authentication'], [429, 'synthetic-secret', 'rate-limit'],
    [500, 'PRIVATE_NOTE', 'upstream-failure'], [400, 'PRIVATE_NOTE https://private.invalid', 'unknown'],
  ] as const) {
    const error = safeLlmHttpError(status, raw);
    assert.equal(readSafeLlmHttpFailure(error.message)?.reason, reason);
    assert.doesNotMatch(error.message, /synthetic-secret|private.invalid|PRIVATE_NOTE/u);
  }
} finally { globalThis.fetch = previousFetch; }
console.log('Scene JSON request contract passed: actual builder/proxy request, plain-chat isolation, streaming parity, safe HTTP categories and no secret/body echo. Offline synthetic HTTP only.');

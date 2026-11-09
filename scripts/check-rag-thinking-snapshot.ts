/** Actual host RAG config/read/invoke and HTTP builder, synthetic files/HTTP only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readArgumentReferenceModel, invokeArgumentReferenceModel } from '../src/electron/rag/argumentReferenceModel';
import { serializeLlmState, USER_STATE_FILES } from '../src/services/userStateService';
import type { LlmProvider, LlmSettings, LlmThinkingPreference } from '../src/types';

await fs.mkdir('build', { recursive: true });
const root = await fs.mkdtemp(path.resolve('build/workflow-thinking-rag-'));
const roots = { dataRoot: root, vaultRoot: path.join(root, 'vault'), userStateDir: path.join(root, 'user-state') };
await fs.mkdir(roots.userStateDir);
const provider: LlmProvider = { id: 'synthetic-glm', name: 'Synthetic GLM', apiType: 'openai-compatible',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'synthetic-unused-secret', models: ['glm-5.3'], selectedModel: 'glm-5.3',
  enabled: true, createdAt: '2026-11-09T00:00:00Z' };
const settings = (preference?: LlmThinkingPreference): LlmSettings => ({ providers: [provider], defaultProviderId: provider.id,
  workflowBinding: { 'document-knowledge-extract': provider.id },
  ...(preference === undefined ? {} : { workflowThinking: { 'document-knowledge-extract': preference } }) });
const save = (value: LlmSettings) => fs.writeFile(path.join(roots.userStateDir, USER_STATE_FILES.llm), serializeLlmState(value));
const request = { stage: 'extract' as const, bindingId: 'synthetic', systemPrompt: 'Synthetic evidence only.', userInput: '{}',
  skipMemoryInjection: true as const, skipProfileInjection: true as const, thinkingMode: 'disabled' as const };
const originalFetch = globalThis.fetch;
const sent: any[] = [];
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  assert.equal(init?.method, 'POST');
  const body = JSON.parse(String(init?.body)); sent.push(body);
  assert.ok(body.messages[0].content.startsWith(request.systemPrompt), 'The host retains the original prompt before its standard JSON contract');
  assert.equal(body.messages.at(-1).content, request.userInput);
  assert.equal(body.tools, undefined, 'RAG remains a single non-tool request');
  return new Response(JSON.stringify({ model: 'glm-5.3', choices: [{ message: { content: '{"synthetic":true}' }, finish_reason: 'stop' }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
};
try {
  await save(settings()); const legacy = await readArgumentReferenceModel(roots);
  assert.equal(legacy.thinkingPreference, undefined, 'Unmarked old configs retain their original default route');
  await save(settings('high')); const high = await readArgumentReferenceModel(roots);
  assert.equal(high.thinkingPreference, 'high'); assert.notEqual(high.fingerprint, legacy.fingerprint);
  await save(settings('off'));
  assert.equal(await invokeArgumentReferenceModel(high, request, new AbortController().signal), '{"synthetic":true}');
  assert.equal(sent.at(-1).thinking?.type, 'enabled'); assert.equal(sent.at(-1).reasoning_effort, 'max', 'Delayed invocation uses captured high, not the later off setting');
  await invokeArgumentReferenceModel(legacy, request, new AbortController().signal);
  assert.equal(sent.at(-1).thinking?.type, 'enabled'); assert.equal(sent.at(-1).reasoning_effort, 'low', 'Legacy capture keeps the original disabled-to-low compatibility rule');
  for (const [preference, effort] of [['off', 'low'], ['low', 'low'], ['medium', 'high'], ['high', 'max']] as const) {
    await save(settings(preference)); const captured = await readArgumentReferenceModel(roots);
    await invokeArgumentReferenceModel(captured, request, new AbortController().signal);
    assert.equal(sent.at(-1).thinking?.type, 'enabled'); assert.equal(sent.at(-1).reasoning_effort, effort);
  }
  const invalid = settings(); (invalid as any).workflowThinking = { 'document-knowledge-extract': 'very-high-invalid' };
  await save(invalid); const count = sent.length;
  await assert.rejects(readArgumentReferenceModel(roots), /argument_reference_model_unavailable/);
  await assert.rejects(invokeArgumentReferenceModel({ ...high, thinkingPreference: 'bad' as any }, request, new AbortController().signal), /argument_reference_model_unavailable/);
  assert.equal(sent.length, count, 'Invalid preferences never dispatch a model request');
  await save({ ...settings('high'), providers: [{ ...provider, enabled: false }] });
  await assert.rejects(invokeArgumentReferenceModel(high, request, new AbortController().signal), /argument_reference_model_unavailable/);
  assert.equal(sent.length, count, 'A captured preference cannot retain permission for a disabled supplier');
  const report = { passed: true, checks: ['Legacy default and fingerprint compatibility', 'Captured workflow preference survives later UI edits',
    'Actual host-to-HTTP GLM off/low/medium/high mapping', 'Invalid preference and disabled supplier reject before HTTP'],
    httpFixtures: sent.length, realModelRequests: 0, networkCalls: 0, realSettingsAccessed: false };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ root, ...report }));
} finally { globalThis.fetch = originalFetch; }

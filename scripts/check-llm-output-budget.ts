/** Pure transport budget policy. No settings, network, model or vault IO. */
import assert from 'node:assert/strict';
import { resolveLlmOutputBudget } from '../src/services/llmOutputBudget';
import type { LlmProvider } from '../src/types';

const provider = (baseUrl: string, apiType: LlmProvider['apiType'] = 'openai-compatible') => ({ baseUrl, apiType });
const official = provider('https://open.bigmodel.cn/api/paas/v4');
const cases: Array<[number, number]> = [
  [1, 2049], [64, 2112], [768, 2816], [2000, 4048], [2047, 4095],
  [2048, 4096], [4096, 8192], [6500, 13000], [8192, 16384], [8193, 16385],
  [12000, 20192], [24000, 32192], [24576, 32768], [24577, 32768],
  [32767, 32768], [32768, 32768], [65536, 65536], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
];
let checked = 0;
for (const [base, expected] of cases) {
  assert.equal(resolveLlmOutputBudget(official, 'glm-5.3', base), expected); checked++;
  assert.equal(resolveLlmOutputBudget(official, 'glm-5.3', base, 'response'), expected); checked++;
  assert.equal(resolveLlmOutputBudget(official, 'glm-5.3', base, 'total'), base, 'an approved total ceiling is never expanded'); checked++;
}
for (const base of [0, -0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  assert.equal(resolveLlmOutputBudget(official, 'glm-5.3', base), base, 'invalid budgets are untouched for the owning request validator'); checked++;
}
for (const baseUrl of [
  'https://open.bigmodel.cn/api/coding/paas/v4', 'https://api.z.ai/api/paas/v4',
  'https://api.z.ai/api/coding/paas/v4',
]) { assert.equal(resolveLlmOutputBudget(provider(baseUrl), 'glm-5.3', 6500), 13000); checked++; }
for (const other of [
  { provider: official, model: 'glm-5.2' }, { provider: official, model: 'GLM-5.3' },
  { provider: official, model: 'glm-5.3-flash' },
  { provider: provider('http://open.bigmodel.cn/api/paas/v4'), model: 'glm-5.3' },
  { provider: provider('https://api.deepseek.com/v1'), model: 'deepseek-chat' },
  { provider: provider('https://gateway.synthetic.invalid/v1'), model: 'glm-5.3' },
  { provider: provider('https://open.bigmodel.cn.attacker.invalid/v1'), model: 'glm-5.3' },
  { provider: provider('https://api.z.ai.attacker.invalid/v1'), model: 'glm-5.3' },
  { provider: provider('not a URL'), model: 'glm-5.3' },
  ...(['anthropic', 'gemini', 'ollama'] as const).map(apiType => ({ provider: provider(official.baseUrl, apiType), model: 'glm-5.3' })),
]) {
  for (const base of [64, 6500, 12000]) {
    assert.equal(resolveLlmOutputBudget(other.provider, other.model, base), base, 'unverified model/protocol/gateway gets no guessed allowance'); checked++;
  }
}
assert.equal(resolveLlmOutputBudget(official, 'glm-5.3', 6500, 'unknown' as any), 6500); checked++;
const original = JSON.stringify(official); Object.freeze(official);
resolveLlmOutputBudget(official, 'glm-5.3', 6500); assert.equal(JSON.stringify(official), original);
console.log(JSON.stringify({ status: 'passed', checked, reasoningReserve: { minimum: 2048, maximum: 8192, adaptedTotalCeiling: 32768 },
  existingLargerAllowancesPreserved: true, approvedTotalsPreserved: true, settingsModified: false, networkCalls: 0, modelRequests: 0 }));

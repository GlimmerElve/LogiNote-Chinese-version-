import assert from 'node:assert/strict';
import { resolveLlmThinkingPolicy } from '../src/services/llmThinkingPolicy';
import type { LlmApiType } from '../src/types';

const provider = (baseUrl: string, apiType: LlmApiType = 'openai-compatible') => ({ baseUrl, apiType });
let cases = 0;
for (const baseUrl of ['https://open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn/api/coding/paas/v4/',
  'https://api.z.ai/api/paas/v4', 'https://api.z.ai/api/coding/paas/v4', 'https://region.open.bigmodel.cn/api/paas/v4', 'https://region.api.z.ai/api/paas/v4']) {
  assert.deepEqual(resolveLlmThinkingPolicy(provider(baseUrl), 'glm-5.3', 'disabled'), { thinkingMode: 'enabled', reasoningEffort: 'low' });
  assert.deepEqual(resolveLlmThinkingPolicy(provider(baseUrl), 'glm-5.3', 'enabled'), { thinkingMode: 'enabled' }, 'explicit thinking retains the official max default');
  assert.deepEqual(resolveLlmThinkingPolicy(provider(baseUrl), 'glm-5.3'), { thinkingMode: 'enabled', reasoningEffort: 'low' }, 'ordinary GLM calls also use low reasoning rather than inheriting max');
  cases += 3;
}
for (const baseUrl of ['https://open.bigmodel.cn.attacker.invalid/api/paas/v4', 'https://api.z.ai.attacker.invalid/v4',
  'https://notapi.z.ai/v4', 'https://evilopen.bigmodel.cn/v4', 'https://docs.z.ai/v4', 'https://bigmodel.cn/v4',
  'https://api.z.ai@attacker.invalid/v4', 'https://gateway.invalid/api.z.ai/v4', 'http://api.z.ai/api/paas/v4',
  'https://api.z.ai./api/paas/v4', 'not a URL']) {
  assert.deepEqual(resolveLlmThinkingPolicy(provider(baseUrl), 'glm-5.3', 'disabled'), {}, baseUrl);
  cases++;
}
for (const model of ['glm-5.2', 'glm-5', 'glm-4.7', 'glm-5.3-flash', 'glm-5.3-latest', 'GLM-5.3', 'glm-5.3:latest', 'ZHIPU/GLM-5.3', ' glm-5.3 ']) {
  assert.deepEqual(resolveLlmThinkingPolicy(provider('https://open.bigmodel.cn/api/paas/v4'), model, 'disabled'), {}, model + ': unverified model names retain their existing path'); cases++;
}
for (const apiType of ['anthropic', 'gemini', 'ollama'] as const) {
  assert.deepEqual(resolveLlmThinkingPolicy(provider('https://open.bigmodel.cn/api/paas/v4', apiType), 'glm-5.3', 'disabled'), {}); cases++;
}
for (const baseUrl of ['https://api.deepseek.com/v1', 'https://deepseek.com', 'http://api.deepseek.com/v1']) {
  for (const mode of ['enabled', 'disabled'] as const) {
    assert.deepEqual(resolveLlmThinkingPolicy(provider(baseUrl), 'deepseek-chat', mode), { thinkingMode: mode }, 'DeepSeek compatibility unchanged'); cases++;
  }
}
assert.deepEqual(resolveLlmThinkingPolicy(provider('https://deepseek.com.attacker.invalid/v1'), 'deepseek-chat', 'disabled'), {}); cases++;
assert.deepEqual(resolveLlmThinkingPolicy(provider('https://api.deepseek.com/v1'), 'deepseek-chat'), {}); cases++;
assert.deepEqual(resolveLlmThinkingPolicy(provider('https://open.bigmodel.cn/api/paas/v4'), 'glm-5.3', 'off' as any), {}); cases++;
const untouched = provider('https://open.bigmodel.cn/api/paas/v4'); const original = JSON.stringify(untouched);
Object.freeze(untouched); resolveLlmThinkingPolicy(untouched, 'glm-5.3', 'disabled'); assert.equal(JSON.stringify(untouched), original);
console.log(JSON.stringify({ status: 'passed', cases, officialGlm53: 'ordinary and disabled requests use enabled + low; explicit enabled keeps default max', untouched: 'settings, models, prompts, checkpoints', networkCalls: 0, modelRequests: 0 }));

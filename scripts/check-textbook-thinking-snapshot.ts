import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { LlmProvider, LlmSettings } from '../src/types';
import { captureTextbookThinkingSnapshot, validateTextbookThinkingSnapshot, textbookThinkingSnapshotSummary } from '../src/services/textbook/thinkingSnapshot';
import { defaultTextbookModelPolicy } from '../src/services/textbook/modelPolicy';
import { hashTextbookProviders, textbookProviderSnapshot, textbookWorkflows } from '../src/services/textbook/providerIdentity';
import { textbookHash } from '../src/services/textbook/fingerprint';
import { interactiveFigureApproval } from '../src/electron/interactiveFigureApproval';
import { approvedLegacyProvider } from '../src/services/textbook/interactiveFigure';
import type { TextbookJob } from '../src/services/textbook/generationTypes';

globalThis.fetch = async () => assert.fail('Snapshot tests must never use network');
const policy = defaultTextbookModelPolicy();
const glm: LlmProvider = { id: 'synthetic-glm', name: 'Synthetic GLM', apiType: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'synthetic-unused', models: ['glm-5.3'], selectedModel: 'glm-5.3', enabled: true, createdAt: '2026-11-09' };
const settings: LlmSettings = { providers: [glm], defaultProviderId: glm.id, workflowBinding: {} };
const provider = () => glm;
let checks = 0;
assert.equal(captureTextbookThinkingSnapshot(settings, policy, () => assert.fail('Default preparation must not inspect extra providers')), undefined); checks++;
const manualSettings: LlmSettings = { ...settings, workflowThinking: { 'textbook-blueprint': 'medium', 'textbook-chapter': 'high', 'textbook-quality': 'low' } };
const snapshot = captureTextbookThinkingSnapshot(manualSettings, policy, provider)!;
assert.deepEqual(snapshot.figureBudget, { configuration: 16384, html: 24576 }, 'Figure approval and execution share the same captured manual-thinking totals'); checks++;
assert.deepEqual(snapshot.stages, {
  selection: { maxTokens: 12000, retryMaxTokens: 24000 }, blueprint: { maxTokens: 24000, retryMaxTokens: 32384 },
  chapter: { maxTokens: 32768, retryMaxTokens: 32768 }, quality: { maxTokens: 16000, retryMaxTokens: 24192 },
});
assert.deepEqual(policy, defaultTextbookModelPolicy(), 'Capturing manual preferences never rewrites the original policy version'); checks++;
const summary = textbookThinkingSnapshotSummary(snapshot); assert.match(summary, /32768/); assert.match(summary, /累计总额/); checks++;
const off = captureTextbookThinkingSnapshot({ ...settings, workflowThinking: { 'textbook-chapter': 'off' } }, policy, provider)!;
assert.equal(off.stages.chapter.maxTokens, 20192); assert.ok(off.notes?.some(note => note.includes('不能关闭'))); checks++;
assert.deepEqual(off.figureBudget, { configuration: 8192, html: 12288 }); checks++;
const unknown = captureTextbookThinkingSnapshot(manualSettings, policy, () => ({ ...glm, baseUrl: 'https://gateway.synthetic.invalid/v1' }))!;
assert.equal(unknown.stages.chapter.maxTokens, 12000); assert.ok(unknown.notes?.some(note => note.includes('尚未适配思考控制'))); checks++;
for (const invalid of [null, {}, { ...snapshot, version: 2 }, { ...snapshot, preferences: {} }, { ...snapshot, preferences: { 'agent-chat': 'high' } },
  { ...snapshot, preferences: { 'textbook-chapter': 'default' } }, { ...snapshot, preferences: { 'textbook-chapter': 'bad' } },
  { ...snapshot, stages: { ...snapshot.stages, chapter: { maxTokens: 32769, retryMaxTokens: 32769 } } },
  { ...snapshot, stages: { ...snapshot.stages, chapter: { maxTokens: 12000, retryMaxTokens: 11000 } } },
  { ...snapshot, notes: ['x'.repeat(201)] },
  { ...snapshot, figureBudget: { configuration: 16384, html: 32769 } },
  { ...snapshot, figureBudget: { configuration: 16384, html: 4096 } },
  { ...snapshot, figureBudget: { configuration: 100, html: 4096 } },
  { ...snapshot, preferences: { 'textbook-blueprint': 'high' }, figureBudget: { configuration: 8192, html: 12288 } }]) {
  assert.throws(() => validateTextbookThinkingSnapshot(invalid, policy), /快照无效/); checks++;
}
const captured = Object.fromEntries(textbookWorkflows.map(workflow => [workflow, glm])) as Record<typeof textbookWorkflows[number], LlmProvider>;
const oldIdentity = { providers: textbookWorkflows.map(workflow => ({ workflow, id: glm.id, name: glm.name, apiType: glm.apiType,
  baseUrl: glm.baseUrl, apiKey: glm.apiKey, selectedModel: glm.selectedModel, models: glm.models })), modelPolicy: policy };
const legacyHash = await textbookHash(oldIdentity);
assert.equal(await hashTextbookProviders(captured, policy), legacyHash);
assert.equal(await hashTextbookProviders(captured, policy, undefined), legacyHash, 'Old tasks have their exact previous provider/policy hash'); checks++;
const manualHash = await hashTextbookProviders(captured, policy, snapshot); assert.notEqual(manualHash, legacyHash); checks++;
const previousManual = structuredClone(snapshot); delete previousManual.figureBudget;
validateTextbookThinkingSnapshot(previousManual, policy);
assert.notEqual(await hashTextbookProviders(captured, policy, previousManual), manualHash, 'Old sidecars without a figure allowance retain their original 4096 authority and distinct hash'); checks++;
const memory = new Map([['loginote_llm_settings', JSON.stringify(settings)]]);
Object.assign(globalThis, { localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) } });
const body = '# 合成教材\n\n已讲授的通用内容。';
const job = { stage: 'published', spec: { projectNoteId: 'synthetic-project', allowCloud: true, promptVersion: 7, providerHash: manualHash,
  modelPolicy: policy, thinkingSnapshot: snapshot }, checkpoint: { body } } as unknown as TextbookJob;
const approval = interactiveFigureApproval(job, 'synthetic-project', createHash('sha256').update(body).digest('hex'));
assert.deepEqual(approval.thinkingSnapshot, snapshot); checks++;
Object.assign(globalThis, { window: { electronAPI: { textbook: { figureApproval: async () => structuredClone(approval) } } } });
memory.set('loginote_llm_settings', JSON.stringify({ ...settings, workflowThinking: { 'textbook-chapter': 'off' } }));
assert.equal(await textbookProviderSnapshot(true, policy), legacyHash, 'Changing workflow UI preferences cannot rewrite an unmarked old-task hash'); checks++;
assert.equal(await textbookProviderSnapshot(true, policy, snapshot), manualHash, 'Existing manual jobs use their captured preference, not today\'s UI'); checks++;
assert.equal((await approvedLegacyProvider({ projectId: 'synthetic-project', legacy: true, jobId: 'synthetic-job' }, body)).id, glm.id,
  'New manual textbook figures can verify the same approved sidecar hash'); checks++;
console.log(JSON.stringify({ passed: true, checks, modelRequests: 0, networkCalls: 0, realSettingsAccessed: false,
  legacyHashPreserved: true, approvedManualSnapshotHashStable: true, independentFigureApprovalCompatible: true }));

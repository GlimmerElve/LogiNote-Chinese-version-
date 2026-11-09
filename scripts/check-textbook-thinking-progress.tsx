import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TextbookProgressCard } from '../src/components/textbook/TextbookProgressCard';
import { initialTextbookProgress, textbookProgressSnapshot } from '../src/services/textbook/progress';
import { captureTextbookThinkingSnapshot } from '../src/services/textbook/thinkingSnapshot';
import { defaultTextbookModelPolicy } from '../src/services/textbook/modelPolicy';
import type { TextbookJob } from '../src/services/textbook/generationTypes';
import type { LlmProvider, LlmSettings } from '../src/types';

globalThis.fetch = async () => assert.fail('Progress rendering never invokes a model or network');
const provider: LlmProvider = { id: 'synthetic-glm', name: 'Synthetic GLM', apiType: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', models: ['glm-5.3'], selectedModel: 'glm-5.3', enabled: true, createdAt: '2026-11-09' };
const settings: LlmSettings = { providers: [provider], workflowBinding: {}, workflowThinking: { 'textbook-chapter': 'high' } };
const modelPolicy = defaultTextbookModelPolicy();
const snapshot = captureTextbookThinkingSnapshot(settings, modelPolicy, () => provider)!;
const job = { id: 'synthetic-job', stage: 'chapters', attempt: 1, updatedAt: '2026-11-09T00:00:00Z',
  spec: { projectNoteId: 'synthetic-project', projectTitle: '合成教学进度', modelPolicy, thinkingSnapshot: snapshot }, checkpoint: {
    blueprint: { chapters: [{ id: 'ch1', title: '合成章节' }] }, chapters: [],
  } } as unknown as TextbookJob;
job.checkpoint.progress = { ...initialTextbookProgress(job), chapterId: 'ch1', chapterTitle: '合成章节', chapterIndex: 1,
  requestMaxTokens: 32768, requestThinkingResolved: true, requestThinkingMode: 'enabled', requestReasoningEffort: 'max', requestThinkingLevel: 'high', requestThinkingPreference: 'high' };
const render = () => renderToStaticMarkup(<TextbookProgressCard progress={textbookProgressSnapshot(job, true)} disabled={false} onResume={() => assert.fail('Rendering does not resume')} />);
let html = render();
assert.ok(html.includes('章节思考手动高档') && html.includes('实际思考启用 · 高档'));
assert.ok(html.includes('32768') && !html.includes('章节默认思考关闭') && !html.includes('复杂章节按需启用'));
assert.equal(textbookProgressSnapshot(job, true).requestReasoningEffort, 'max');

job.spec.thinkingSnapshot = captureTextbookThinkingSnapshot({ ...settings, workflowThinking: { 'textbook-chapter': 'off' } }, modelPolicy, () => provider);
Object.assign(job.checkpoint.progress, { requestMaxTokens: 20192, requestThinkingMode: 'enabled', requestReasoningEffort: 'low', requestThinkingLevel: 'low', requestThinkingPreference: 'off' });
html = render();
assert.ok(html.includes('章节思考手动关闭') && html.includes('不能关闭思考') && html.includes('实际思考启用 · 低档'), 'Unavailable off shows both the requested choice and actual lowest level');

Object.assign(job.checkpoint.progress, { requestThinkingMode: 'enabled', requestReasoningEffort: undefined, requestThinkingLevel: 'low', requestThinkingPreference: 'high' });
html = render();
assert.ok(html.includes('实际思考启用（模型默认档位）') && !html.includes('实际思考启用 · 低档'), 'A binary model has no actual intensity tier; even an old heuristic level must not pretend otherwise');

delete job.spec.thinkingSnapshot;
delete job.checkpoint.progress.requestThinkingResolved;
delete job.checkpoint.progress.requestReasoningEffort;
delete job.checkpoint.progress.requestThinkingLevel;
delete job.checkpoint.progress.requestThinkingPreference;
job.checkpoint.progress.requestThinkingMode = 'disabled';
html = render();
assert.ok(html.includes('章节默认思考关闭') && html.includes('复杂章节按需启用') && html.includes('请求思考关闭'), 'Old saved progress keeps its legacy wording and phase policy');

job.spec.thinkingSnapshot = snapshot;
Object.assign(job.checkpoint.progress, { requestThinkingResolved: true, requestThinkingMode: undefined, requestReasoningEffort: undefined, requestThinkingLevel: undefined });
html = render();
assert.ok(html.includes('实际思考由模型控制') && !html.includes('实际思考关闭'), 'Unknown transport controls are never falsely presented as disabled');
console.log(JSON.stringify({ passed: true, checks: 5, actualComponentRendered: true, realModelRequests: 0, networkCalls: 0 }));

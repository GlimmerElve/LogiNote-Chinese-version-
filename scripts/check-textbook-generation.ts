import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Code } from 'mdast';
import type { FlowSession, LlmCallRequest, LlmCallResponse, LlmProvider, LlmThinkingPreference, NoteItem, UploadedDocument } from '../src/types';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import type { TextbookContext, TextbookJob, TextbookJobCommand, TextbookProgress, TextbookPublishInput, TextbookReviewTarget } from '../src/services/textbook/generationTypes';
import { parseTextbookQuality, chapterInputIdentity, recordTextbookFailure } from '../src/services/textbook/repair';
import { textbookProgressSnapshot } from '../src/services/textbook/progress';
import { reconcileTextbookReviewCheckpoint } from '../src/services/textbook/reviewCheckpoint';
import { textbookResumeCall } from '../src/services/textbook/resume';
import { prepareTextbook, generateTextbook, queryTextbookState, collectTextbookSources, textbookApprovalSnapshot, textbookProviderSnapshot, subscribeTextbookProgress,
  type TextbookGenerationDependencies } from '../src/services/textbook/generation';
import { buildTextbookContext } from '../src/services/textbook/context';
import { textbookHash } from '../src/services/textbook/fingerprint';
import { validateBlueprint, validateChapter, validateTextbookJob, validateTextbookContent, assembleTextbook } from '../src/services/textbook/validation';
import { TEXTBOOK_RESTATEMENT_WRITING_GUIDANCE, TEXTBOOK_RESTATEMENT_REVIEW_GUIDANCE } from '../src/services/textbook/restatement';
import { parseTextbookMarkdown } from '../src/services/textbook/markdown';
import { readTextbookBody, stripTextbookRegion } from '../src/services/textbook/noteContent';
import { TextbookStore } from '../src/electron/textbookStore';
import { saveVaultSnapshot, recoverVaultSnapshot } from '../src/electron/vaultSnapshot';
import { atomicWriteTextFile } from '../src/electron/atomicWrite';
import { deserializeVault } from '../src/services/vaultFsService';
import { deserializeUserStateFile, mergeNote, splitSharableFields, USER_STATE_FILES } from '../src/services/userStateService';
import { setDataRoot, setModelsDir, writeManifest, readManifest } from '../src/electron/ragIndex';
import { fingerprintMaterialSource } from '../src/electron/materialStore';
import { getMaterialCatalog, listMaterialDocuments, materialResult, prepareLocalMaterial, readMaterialPage, readMaterialImage } from '../src/electron/materialReader';
import { AGENT_ROLES, runAgentTurn, resolveAgentApproval } from '../src/services/agent/agentEngine';
import { bootstrapAgentRuntime } from '../src/services/agent/bootstrap';
import { getTool, registerTool, toolRequiresApproval, executeTool } from '../src/services/agent/toolRegistry';
import { selectAgentSkill } from '../src/services/agent/skillRegistry';
import { inferContextualAgentSkill } from '../src/services/agent/intentRouter';
import { createAgentApprovalBinding, validateAgentApprovalBinding } from '../src/services/agent/approvalBinding';
import { publishTextbookAfterSave } from '../src/services/textbook/publication';
import { enqueueLearningWrite, enqueueLatestNotesSave, type LearningWriteQueue } from '../src/services/ui/learningWriteQueue';
import { commitLearningCompletion } from '../src/services/ui/learningCompletionWrite';
import { getLearningCompletionTarget } from '../src/services/learningCompletion';
import { saveFlowReviewRecord } from '../src/services/textbook/reviewRecordStore';
import { recalculateBacklinks } from '../src/services/storage';
import type { NoteSaveState } from '../src/services/ui/saveFeedback';
import { defaultTextbookModelPolicy, validateTextbookModelPolicy, textbookResponseTruncated, textbookRequestBudget, type TextbookModelStage } from '../src/services/textbook/modelPolicy';
import { textbookConfirmation } from '../src/services/textbook/generation';
import { assembleTeachingBlueprint } from '../src/services/textbook/blueprint';
import { textbookVisualGuidance } from '../src/services/textbook/visualGuidance';
import { callLLM } from '../src/services/llmService';
import { resolveLlmOutputBudget } from '../src/services/llmOutputBudget';
import { TEXTBOOK_WRITING_STYLE_PROMPT, TEXTBOOK_BLUEPRINT_PROMPT, TEXTBOOK_COMPONENT_CAPABILITIES_PROMPT } from '../src/workflows/textbookPrompt';
import { TEXTBOOK_COMPACT_STYLE_PROMPT, TEXTBOOK_COMPACT_THINKING_PROMPT, TEXTBOOK_MERMAID_LINE_BREAK_GUIDANCE, compactTextbookCapabilities, compactTextbookFormatSyntax } from '../src/workflows/textbookPromptV2';
import { TEXTBOOK_PROMPT_VERSION } from '../src/services/textbook/promptVersion';
import { TEXTBOOK_PROGRESSIVE_CAPABILITIES, TEXTBOOK_PROGRESSIVE_STYLE_PROMPT, TEXTBOOK_READING_STYLE_PROMPT } from '../src/workflows/textbookPromptDisclosure';
import { backgroundWorkflows } from '../src/services/agent/backgroundWorkflowService';
import { applyAgentTaskStatePatch, type AgentTaskState } from '../src/services/agent/taskStateCodec';
import { applyWorkspaceNoteChange } from '../src/services/agent/workspaceOperations';
import { KNOWLEDGE_PLACEHOLDER } from '../src/services/wikiKnowledge';
import { visualTimeline, visualFence } from './fixtures/textbook-visuals';

const temp = await mkdtemp(path.join(os.tmpdir(), 'loginote-textbook-generation-'));
const vault = path.join(temp, 'vault'); const stateDir = path.join(temp, 'user-state');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Live network forbidden'); };
const storage = new Map<string, string>();
Object.assign(globalThis, { localStorage: { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
const llmSettings = { providers: [{ id: 'deepseek-default', name: '本地测试模型', apiType: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: '', models: ['mock'], selectedModel: 'mock', enabled: true, createdAt: '2026-10-01' }], defaultProviderId: 'deepseek-default', workflowBinding: {} };
let fixtureThinkingPreferences: Record<string, LlmThinkingPreference> = {};
storage.set('loginote_llm_settings', JSON.stringify(llmSettings));
let notes: NoteItem[] = [];
const note = (id: string, title: string, content: string, noteType: NoteItem['noteType'] = 'project', parentId?: string): NoteItem => ({
  id, title, content, noteType, parentId, tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-01', updatedAt: '2026-10-01' });
const pristine = () => [note('root-a', '30天了解心理学效应', ''), note('root-b', '另一计划', ''),
  note('project-a', '学习选择过载效应', '- [ ] 理解 [[选择过载效应]] @due(2026-10-09)\n\n原有手工备注。', 'project', 'root-a'),
  note('project-b', '学习选择过载效应', '同标题另一个项目，不能写入。', 'project', 'root-b'),
  note('knowledge-choice', '选择过载效应', '选择过载指在某些条件下选项增加使决策更困难、满意度下降；不能推断选项更多一定更差。条件包含偏好清晰度、复杂度和时间压力。', 'knowledge')];
let store = new TextbookStore(stateDir); let modelCalls = 0; let savedCount = 0; let mode = 'normal'; let abortController: AbortController | undefined; let failFinishOnce = false;
const learningQueue: LearningWriteQueue = { current: Promise.resolve() };
let saveState: NoteSaveState = 'saved'; let pendingNotes: NoteItem[] | null = null; let indexedCount = 0; let publicationSaveCalls = 0;
let publicationSaveHook: ((candidate: NoteItem[], call: number) => Promise<void>) | undefined;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const events: string[] = [];
const context: TextbookContext = { project: { id: 'project-a', rootId: 'root-a', title: '学习选择过载效应', rootTitle: '30天了解心理学效应', tasks: ['理解选择过载效应'], knowledgeTitles: ['选择过载效应'] },
  profile: '可信画像：倾向使用具体例子；证据不足时不推断能力。', preferences: { preferredCategories: [{ category: 'video' }] }, mastery: { rows: [] },
  personal: [{ evidenceId: 'C1', kind: 'confirmed_view', text: 'PRIVATE_COGNITION: 我认为选项增加一定导致更差决策。', reference: { recordId: 'cognition-fixture', revisionId: 'rev1' }, usableAsFactEvidence: false }], warnings: [] };
async function readDisk(): Promise<NoteItem[]> {
  await recoverVaultSnapshot(vault, stateDir);
  const md = new Map<string, string>(); for (const item of notes) md.set(`${item.id}.md`, await readFile(path.join(vault, 'notes', `${item.id}.md`), 'utf8'));
  const states = deserializeUserStateFile(await readFile(path.join(stateDir, USER_STATE_FILES.noteStates), 'utf8'));
  return deserializeVault(await readFile(path.join(vault, 'metadata.json'), 'utf8'), md).map((item) => mergeNote(item, states[item.id]));
}
// Use the production App adapter, not a substitute that throws before optimistic publication.
const publish = async (input: TextbookPublishInput): Promise<NoteItem> => {
  try {
    return await publishTextbookAfterSave(learningQueue, {
      readNotes: () => notes,
      beforeSave: () => { saveState = 'saving'; },
      preflightMarkdown: () => {
        if (mode === 'compatibility-preflight-failure') throw new Error('富文本兼容性检查未通过（第 3 行）；原文与已生成章节保留，请在源码模式检查，不需重新生成教材');
      },
      saveNotes: async (candidate) => {
        await publicationSaveHook?.(candidate, ++publicationSaveCalls);
        if (mode === 'disk-failure') throw new Error('synthetic disk failure inside real publication save');
        await saveVaultSnapshot(vault, stateDir, candidate); savedCount++;
        if (mode === 'late-stop') abortController!.abort();
      },
      applyNotes: (candidate) => { notes = candidate; pendingNotes = null; saveState = 'saved'; indexedCount++; },
    }, input);
  } catch (error) { pendingNotes = notes; saveState = 'error'; throw error; }
};
const ctx = { getNotes: () => notes, getActiveNote: () => notes.find((item) => item.id === 'project-a')!, getPlanDraftSession: () => null, getResourceDraftSession: () => null,
  ensureDataFresh: async () => {}, publishTextbook: publish } as AgentRuntimeContext;
// Legacy synthetic reviewers still emit quote reports. Reconstruct their raw
// text view from the actual indexed wire input; production never does this.
function fixtureInput(request: LlmCallRequest): any {
  const input = JSON.parse(request.userInput);
  if (request.workflow !== 'textbook-quality') return input;
  const restore = (value: any): any => Array.isArray(value)
    ? value.length && value.every(item => item && typeof item.ref === 'string' && typeof item.text === 'string')
      ? value.map(item => item.text).join('') : value.map(restore)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restore(item)])) : value;
  return restore(input);
}
async function fixtureModel(request: LlmCallRequest): Promise<LlmCallResponse> {
  modelCalls++; assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true);
  assert.equal(request.tokenBudgetMode, 'total', 'Approved textbook requests keep the exact cost reservation and frozen stage limit');
  assert.equal(request.thinkingPreference, fixtureThinkingPreferences[request.workflow] || 'default', 'Approved textbook requests keep their frozen stage thinking rule instead of a later workflow override');
  assert.equal(resolveLlmOutputBudget({ apiType: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }, 'glm-5.3', request.maxTokensOverride!, request.tokenBudgetMode), request.maxTokensOverride,
    'GLM reasoning headroom cannot exceed an existing textbook ledger reservation');
  const input = fixtureInput(request);
  let result: unknown;
  if (input.catalogs) result = { selections: [{ docId: input.catalogs[0].docId, sectionId: input.catalogs[0].sectionId }] };
  else if (request.workflow === 'textbook-blueprint') {
    assert.ok(request.systemPromptOverride?.includes('默认按严谨但通俗的讲授文风设计'));
    assert.ok(request.systemPromptOverride?.includes(TEXTBOOK_COMPONENT_CAPABILITIES_PROMPT)
      || request.systemPromptOverride?.includes(TEXTBOOK_PROGRESSIVE_CAPABILITIES)
      || [2, 3].some(version => request.systemPromptOverride?.includes(compactTextbookCapabilities(version as 2 | 3))), 'Actual blueprint request receives the versioned planning catalog');
    assert.ok(!request.systemPromptOverride?.includes('2–4 幅 Mermaid'));
    const sources = input.sources.map((source: { sourceId: string }) => source.sourceId);
    result = { title: '选择过载效应：条件、机制与迁移', objectives: [{ id: 'O1', text: '解释选择过载的条件并判断反例' }],
      focuses: [{ id: 'F1', kind: 'possible_confusion', description: '绝对化结论需要与条件对照核实', evidenceIds: ['C1'], sourceIds: sources, strategy: '用偏好明确的反例对比并解释条件' }],
      chapters: [{ id: 'ch1', title: '定义与边界', objectiveIds: ['O1'], focusIds: ['F1'], sourceIds: sources, bridge: '先识别概念，再辨别成立条件。' },
        { id: 'ch2', title: '应用与迁移', objectiveIds: ['O1'], focusIds: ['F1'], sourceIds: sources, bridge: '从概念条件转向生活中的决策情境。' }] };
  } else if (request.workflow === 'textbook-chapter') {
    const compactAuthor = request.systemPromptOverride?.includes(TEXTBOOK_COMPACT_STYLE_PROMPT)
      || request.systemPromptOverride?.includes(TEXTBOOK_PROGRESSIVE_STYLE_PROMPT)
      || request.systemPromptOverride?.includes(TEXTBOOK_READING_STYLE_PROMPT);
    assert.ok(compactAuthor || request.systemPromptOverride?.includes(TEXTBOOK_WRITING_STYLE_PROMPT), 'Production chapter and repair requests include their versioned writing style');
    if (compactAuthor) {
      const formats = input.visualizationGuidance.targets.map((target: { format: string }) => target.format);
      assert.ok([2, 3].some(version => [true, false].some(hint => request.systemPromptOverride?.includes(compactTextbookFormatSyntax(formats, version as 2 | 3, hint)))), 'Writers receive syntax for their actual targets');
      assert.ok(!request.systemPromptOverride?.includes('教材组件能力清单'), 'Planning catalog is not repeated in writing');
    } else assert.ok(request.systemPromptOverride?.includes(TEXTBOOK_COMPONENT_CAPABILITIES_PROMPT));
    assert.deepEqual(input.visualizationGuidance, textbookVisualGuidance(input.blueprint, input.chapter.id, input.repairSections));
    assert.ok(input.visualizationGuidance.targets.length <= 2);
    if (input.repairSections) assert.ok(input.visualizationGuidance.targets.every((target: { section: string }) => input.repairSections.includes(target.section)));
    const citation = `[${input.chapter.sourceIds.find((id: string) => id === 'N1') || input.chapter.sourceIds[0]}]`;
    const sections = { explanation: `选择过载是有条件的决策现象，不能认为选项越多必然越差。${citation}`, boundaries: `偏好明确且比较简单时选项增加不必然造成过载，需要考虑任务复杂度。${citation}`,
      workedExample: `比较两种熟悉的饮料与比较许多复杂保险产品，条件不同，不能一概而论。${citation}`, practice: '请比较熟悉商品与复杂保险两种情境，解释为何增加选项可能产生不同后果。',
      answer: `关键是偏好清晰度和复杂度差异，不能只根据选项数量下结论。${citation}`, selfCheck: '能够列出条件、解释反例，并在新情境中给出理由而非绝对化结论。', summary: '本章用概念条件与反例说明选择过载，再把判断方法用于新情境。' };
    if (mode === 'bad-citation') sections.explanation += ' [L999]';
    if (mode === 'cancel' && input.chapter.id === 'ch2') abortController!.abort();
    if (mode === 'source-change' && input.chapter.id === 'ch2') await writeFile(path.join(temp, 'documents', 'doc-choice.md'), '# 已替换\n\n这不是批准时的内容。');
    if (mode === 'project-change' && input.chapter.id === 'ch2') notes = notes.map((item) => item.id === 'project-a' ? { ...item, content: `${item.content}\n用户新备注。` } : item);
    if (mode === 'new-record' && input.chapter.id === 'ch2') notes = notes.map((item) => item.id === 'project-a' ? { ...item, content: `${item.content}\n\n<LearningReviewBlock id="late-review" />`,
      learningReviewRecords: [{ schemaVersion: 1, id: 'late-review', sessionId: 'late-session', projectNoteId: 'project-a', rootProjectId: 'root-a', startedAt: '2026-10-06', endedAt: '2026-10-06', title: '用户自定义复盘标题',
        userEditedTitle: true, rawRestatement: '用户复述', editedRestatement: '用户修改过的复述', userEditedRestatement: true, summary: '', episodeId: 'late-session', argumentDocIds: [], status: 'completed', createdAt: '2026-10-06', updatedAt: '2026-10-06' }] } : item);
    sections.workedExample += '\n\n```python\nprint("<b>这是代码示例，不执行</b>")\n```\n\n| 条件 | 判断 |\n| --- | --- |\n| 偏好明确 | 不一定过载 |\n\n$$n = |S|$$\n\n> 注：应用前检查条件。';
    if (mode === 'compatibility-preflight-failure') sections.explanation += `\n\n假设演算：k>0.1 且 k<1/9≈0.1111，仅作示例，不能省略参数条件。${citation}`;
    if (mode === 'multiformat') {
      assert.ok(!request.userInput.includes('data:image/')); // Only material pointers reach the model.
      const asset = input.sources.flatMap((source: any) => source.assets || [])[0]; assert.ok(asset);
      sections.explanation += `[^scope-${input.chapter.id}]\n\n[^scope-${input.chapter.id}]: 此图与公式只作教学说明，需核对条件。${citation}`;
      sections.workedExample += '\n\n```mermaid\nflowchart LR\n  A[选项增加] --> B[检查成立条件]\n```'
        + '\n\n$$\n\\begin{aligned}\nn &= |S| \\\\\nT &= n \\cdot t\n\\end{aligned}\n$$'
        + '\n\n```chart\n' + JSON.stringify({ title: '比较成本教学示意', type: 'bar', labels: ['简单', '复杂'], series: [{ name: '模拟步骤', data: [2, 4] }], simulated: true, sourceIds: [] }) + '\n```'
        + '\n\n```textbook-image\n' + JSON.stringify({ assetId: asset.id, caption: '本地原图仅供显示，不作为已理解的图像事实证据。' }) + '\n```';
      sections.practice += '\n\n```textbook-tip\n' + JSON.stringify({ title: '先核对条件', kind: 'tip', text: `把新情境与成立条件逐项对照。${citation}` }) + '\n```';
      sections.answer = '```textbook-answer\n' + JSON.stringify({ title: '参考答案与解释', text: sections.answer }) + '\n```';
    }
    if (mode === 'default-visuals') {
      for (const target of input.visualizationGuidance.targets) {
        const diagram = target.format === 'mindmap'
          ? 'mindmap\n  root((选择过载))\n    条件核对\n      偏好清晰度\n      任务复杂度\n    判断边界\n      不能只看数量'
          : target.format === 'flowchart'
            ? 'flowchart LR\nV1["列出题干条件"] --> V2["核对偏好和复杂度"]\nV2 --> V3["说明判断理由和未知事项"]'
            : null;
        const rendered = diagram ? '```mermaid\n' + diagram + '\n```'
          : '| 假设案例 | 偏好信息 | 比较复杂度 |\n| --- | --- | --- |\n| 熟悉饮料 | 明确 | 简单 |\n| 保险产品 | 待核对 | 复杂 |';
        const key = target.section as keyof typeof sections;
        sections[key] += `\n\n观察问题：${target.readingQuestion}\n\n${rendered}\n\n读图要点：先辨别条件，再说明判断理由；图示表示学习核对路径，不把数量与结果画成必然因果。请沿一个分支说明仍需核对的信息。${citation}`;
      }
    }
    if (mode === 'focused-pacing') {
      assert.ok(input.chapter.writingPlan && input.blueprint.teachingPlan);
      for (const key of Object.keys(sections) as Array<keyof typeof sections>) if (!input.chapter.writingPlan.sections.includes(key)) sections[key] = '';
      if (input.chapter.id === 'ch2') assert.ok(input.previousSummary.startsWith('上一章讲解摘录'));
    }
    if (input.chapter.writingPlan?.restatement === 1 && (!input.repairSections || input.repairSections.includes('selfCheck'))) {
      assert.ok(request.systemPromptOverride!.includes(TEXTBOOK_RESTATEMENT_WRITING_GUIDANCE));
      sections.selfCheck = `对应任务：理解选择过载效应\n\n不看教材，用自己的话解释${input.chapter.id === 'ch1' ? '选择过载及其成立条件' : '怎样根据已知条件判断一个新的选择情境'}。\n\n进一步想想：为什么不能只看选项数量？`;
    } else assert.ok(!request.systemPromptOverride!.includes(TEXTBOOK_RESTATEMENT_WRITING_GUIDANCE));
    result = { id: input.chapter.id, sections: input.repairSections
      ? Object.fromEntries(input.repairSections.map((key: keyof typeof sections) => [key, sections[key]])) : sections };
  } else result = mode === 'quality-failure' ? { passed: false, issues: ['原文不足以支持某关键说明'] } : { schemaVersion: 3, passed: true, findings: [] };
  return { content: JSON.stringify(result), parsedJson: result };
}
const command = (input: TextbookJobCommand) => { if (input.op === 'finish' && failFinishOnce) { failFinishOnce = false; return Promise.reject(new Error('publication receipt failure')); } return store.command(input, 1, readDisk); };
const deps: TextbookGenerationDependencies = { command, documentHash: fingerprintMaterialSource, providerHash: textbookProviderSnapshot,
  context: async () => structuredClone(context), model: fixtureModel, sources: collectTextbookSources };
async function reset(): Promise<void> {
  await learningQueue.current.catch(() => {}); learningQueue.current = Promise.resolve();
  // Each scenario owns a fresh synthetic job store. Repeated preparations
  // WITHIN a scenario intentionally exercise production idempotency.
  const fixtureJobDir = path.resolve(stateDir, 'textbook-jobs');
  assert.ok(fixtureJobDir.startsWith(path.resolve(temp) + path.sep));
  await rm(fixtureJobDir, { recursive: true, force: true }); store = new TextbookStore(stateDir);
  notes = pristine(); modelCalls = 0; savedCount = 0; mode = 'normal'; abortController = undefined;
  saveState = 'saved'; pendingNotes = null; indexedCount = 0; publicationSaveCalls = 0; publicationSaveHook = undefined;
  await saveVaultSnapshot(vault, stateDir, notes);
}
async function prepared(): Promise<{ jobId: string }> { return await prepareTextbook(ctx, { allowedDocIds: ['doc-choice'] }, deps) as { jobId: string }; }
async function freshlyApprovedGenerate(jobId: string, signal?: AbortSignal, dependencies = deps): Promise<unknown> {
  const call = { id: `fresh-repair-${jobId}`, name: 'generate_project_textbook', arguments: { jobId } };
  const binding = await createAgentApprovalBinding(call, ctx);
  await validateAgentApprovalBinding({ call, binding } as never, ctx);
  return generateTextbook(ctx, jobId, signal, dependencies);
}
function factualRejection(input: any, target: TextbookReviewTarget, message: string) {
  const plan = input.blueprint.chapters.find((chapter: any) => chapter.id === ('chapterId' in target ? target.chapterId : input.blueprint.chapters[0].id));
  const source = input.sources.find((source: any) => plan.sourceIds.includes(source.sourceId));
  return { schemaVersion: 2, passed: false, findings: [{ severity: 'blocker', category: 'factual_support', target, message,
    reason: '这里的绝对化判断扩大了原文有条件成立的范围，需按原文修正。', basis: [{ kind: 'source', sourceId: source.sourceId, quote: source.text.slice(0, 1000) }] }] };
}
let checks = 0; const pass = (message: string) => { checks++; console.log(`PASS ${message}`); };
try {
  await mkdir(path.join(temp, 'documents')); setDataRoot(temp); setModelsDir(path.join(temp, 'no-local-embedding'));
  const original = '# 选择过载效应\n\n选择过载是有条件的决策现象；偏好清晰时选项增加不一定更差。\n\n## 边界\n\n应考虑任务复杂度、时间压力和决策目标。';
  await writeFile(path.join(temp, 'documents', 'doc-choice.md'), original);
  await writeManifest([{ id: 'doc-choice', fileName: 'choice.md', extension: '.md', fileType: 'md', indexable: true, size: 100, status: 'pending', chunkCount: 0, totalChars: 0, uploadAt: '2026-10-01' } as UploadedDocument]);
  Object.assign(globalThis, { window: { electronAPI: { textbook: { command, sourceHash: fingerprintMaterialSource, list: (id: string) => store.list(id) }, ragDocs: {
    list: readManifest, materialList: (scope: any) => materialResult(() => listMaterialDocuments(scope)), materialPrepare: (scope: any, id: string) => materialResult(() => prepareLocalMaterial(scope, id)),
    materialCatalog: (input: any) => materialResult(() => getMaterialCatalog(input)), materialRead: (input: any) => materialResult(() => readMaterialPage(input)),
    materialImage: (input: any) => materialResult(() => readMaterialImage(input)),
    search: async () => { throw new Error('offline model missing'); },
  } } } });
  // Keep real phase-two directory/reader/packet code, inject only model and private fixture context.
  await reset(); bootstrapAgentRuntime(AGENT_ROLES.default);
  assert.equal(selectAgentSkill('生成今日教学方案写入当前项目笔记')?.id, 'personalized-textbook');
  assert.equal(inferContextualAgentSkill('为当前项目编写教材', []), 'personalized-textbook');
  assert.equal(selectAgentSkill('查找学习教材和视频')?.id, 'resource-curation');
  assert.notEqual(selectAgentSkill('整理生成教材资源推荐')?.id, 'personalized-textbook');
  assert.equal(selectAgentSkill('在教材末尾补充一个例子')?.id, 'personalized-textbook');
  assert.equal(selectAgentSkill('不要生成教材，只解释选择过载')?.id || inferContextualAgentSkill('不要生成教材，只解释选择过载', []), 'personalized-qa');
  assert.ok(toolRequiresApproval(getTool('generate_project_textbook')!, {}, ctx));
  const definition = getTool('generate_project_textbook')!;
  registerTool({ ...definition, execute: (args, runtime, execution) => generateTextbook(runtime, String(args.jobId), execution?.signal, deps),
    approvalSnapshot: (args, runtime) => textbookApprovalSnapshot(runtime, String(args.jobId), deps) });
  const originalManualProvider = structuredClone(llmSettings.providers[0]);
  Object.assign(llmSettings.providers[0], { apiType: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-5.3'], selectedModel: 'glm-5.3' });
  fixtureThinkingPreferences = { 'textbook-blueprint': 'medium', 'textbook-chapter': 'high', 'textbook-quality': 'low' };
  storage.set('loginote_llm_settings', JSON.stringify({ ...llmSettings, workflowThinking: fixtureThinkingPreferences }));
  await reset(); const manualThinkingJob = await prepared();
  const manualBefore = (await command({ op: 'get', jobId: manualThinkingJob.jobId })).job;
  assert.ok(manualBefore.spec.thinkingSnapshot);
  assert.deepEqual(manualBefore.spec.modelPolicy, defaultTextbookModelPolicy(), 'Manual preferences are a new optional approval sidecar, never an edit to the frozen policy version');
  assert.equal(manualBefore.spec.thinkingSnapshot.stages.chapter.maxTokens, 32768);
  assert.equal(manualBefore.spec.thinkingSnapshot.stages.blueprint.maxTokens, 24000);
  assert.deepEqual(manualBefore.spec.thinkingSnapshot.figureBudget, { configuration: 16384, html: 24576 });
  assert.ok(textbookConfirmation(manualThinkingJob.jobId).impacts.some(impact => impact.includes('手动思考快照') && impact.includes('32768')));
  assert.ok(textbookConfirmation(manualThinkingJob.jobId).impacts.some(impact => impact.includes('配置图输出上限 16384') && impact.includes('HTML 交互图输出上限 24576')),
    'The approval must display the exact figure cap that execution will use, not the legacy 4096');
  const manualRequests: LlmCallRequest[] = [];
  const manualThinkingDeps = { ...deps, model: async (request: LlmCallRequest) => {
    manualRequests.push(request);
    const current = (await command({ op: 'get', jobId: manualThinkingJob.jobId })).job;
    assert.ok(current.checkpoint.cost!.reservedTokens >= request.maxTokensOverride!, 'The effective thinking allowance is reserved before any model call');
    assert.equal(current.checkpoint.progress!.requestMaxTokens, request.maxTokensOverride);
    assert.equal(current.checkpoint.progress!.requestThinkingResolved, true);
    assert.equal(current.checkpoint.progress!.requestThinkingMode, 'enabled');
    assert.equal(current.checkpoint.progress!.requestThinkingPreference, request.thinkingPreference);
    assert.equal(current.checkpoint.progress!.requestReasoningEffort, ({ medium: 'high', high: 'max', low: 'low' } as Record<string, string>)[request.thinkingPreference!]);
    assert.equal(current.checkpoint.progress!.requestThinkingLevel, request.thinkingPreference);
    const publicProgress = textbookProgressSnapshot(current, true);
    assert.equal(publicProgress.complexChapterThinkingLimit, undefined, 'An explicit manual chapter level is not the old default two-complex-chapters rule');
    assert.equal(publicProgress.thinkingPreferences?.['textbook-chapter'], 'high');
    return fixtureModel(request);
  } };
  mode = 'cancel'; abortController = new AbortController();
  await assert.rejects(freshlyApprovedGenerate(manualThinkingJob.jobId, abortController.signal, manualThinkingDeps), /aborted|取消|停止/iu);
  const manualStopped = (await command({ op: 'get', jobId: manualThinkingJob.jobId })).job;
  assert.equal(manualStopped.checkpoint.chapters!.length, 1);
  pass('新完整教材批准时捕获手动档位与实际token上限，确认卡展示且先按真实额度落账，不修改旧modelPolicy');
  storage.set('loginote_llm_settings', JSON.stringify({ ...llmSettings, workflowThinking: { 'textbook-blueprint': 'off', 'textbook-chapter': 'off', 'textbook-quality': 'off' } }));
  store = new TextbookStore(stateDir); mode = 'normal'; abortController = undefined;
  await freshlyApprovedGenerate(manualThinkingJob.jobId, undefined, manualThinkingDeps);
  const manualAfter = (await command({ op: 'get', jobId: manualThinkingJob.jobId })).job;
  assert.equal(manualAfter.stage, 'published'); assert.equal(manualAfter.spec.providerHash, manualBefore.spec.providerHash);
  assert.deepEqual(manualAfter.spec.thinkingSnapshot, manualBefore.spec.thinkingSnapshot);
  assert.deepEqual(manualAfter.checkpoint.chapters![0], manualStopped.checkpoint.chapters![0]);
  assert.ok(manualRequests.filter(request => request.workflow === 'textbook-chapter').every(request => request.thinkingPreference === 'high' && request.maxTokensOverride === 32768));
  pass('新手动教材中断后改UI档位并重开私有Store，仍按原批准档位和上限续写同任务，已完成章节零重做');
  Object.assign(llmSettings.providers[0], originalManualProvider); fixtureThinkingPreferences = {};
  storage.set('loginote_llm_settings', JSON.stringify(llmSettings)); await reset();
  const prep = await prepared(); assert.equal(modelCalls, 0); assert.equal(savedCount, 0);
  assert.equal((await command({ op: 'get', jobId: prep.jobId })).job.spec.promptVersion, TEXTBOOK_PROMPT_VERSION);
  assert.ok(textbookConfirmation(prep.jobId).impacts.some(impact => impact.includes('费用独立于教材预算') && impact.includes('4096')));
  const otherProjectCtx = { ...ctx, getActiveNote: () => notes.find((item) => item.id === 'project-b')! } as AgentRuntimeContext;
  await textbookApprovalSnapshot(otherProjectCtx, prep.jobId, deps);
  const pending = await runAgentTurn({ role: AGENT_ROLES.default, userText: '生成当前项目的教材', ctx, history: [], memoryPrefixLoader: async () => '',
    callLlm: async () => ({ content: '请确认教材生成', toolCalls: [{ id: 'book-call', name: 'generate_project_textbook', arguments: { jobId: prep.jobId } }] }) });
  assert.ok(pending.pendingApproval); assert.equal(modelCalls, 0); assert.equal(notes.find((item) => item.id === 'project-a')!.textbook, undefined);
  await resolveAgentApproval({ role: AGENT_ROLES.default, ctx, approval: pending.pendingApproval!, approved: false, history: pending.updatedHistory,
    callLlm: async () => ({ content: '未生成教材' }) });
  assert.equal(modelCalls, 0); pass('真实 Agent 路由/确认卡片：取消批准不调用教材模型、不写项目；资源意图保持原路线');
  const originalProject = notes.find((item) => item.id === 'project-a')!;
  const off = subscribeTextbookProgress((event) => { if (event) events.push(event.label); });
  const approved = await resolveAgentApproval({ role: AGENT_ROLES.default, ctx, approval: pending.pendingApproval!, approved: true, history: pending.updatedHistory,
    callLlm: async () => ({ content: '教材已写入目标项目笔记。' }) }); off();
  assert.ok(approved.toolTrace.some((step) => step.call.name === 'generate_project_textbook' && step.ok), JSON.stringify(approved.toolTrace));
  const written = notes.find((item) => item.id === 'project-a')!;
  assert.ok(written.textbook); assert.equal(stripTextbookRegion(written.content, written.textbook).outside.trim(), originalProject.content.trim());
  assert.equal(notes.find((item) => item.id === 'project-b')!.content, pristine()[3].content);
  assert.equal((await command({ op: 'get', jobId: prep.jobId })).job.stage, 'published');
  assert.ok(events.includes('保存到目标项目笔记')); assert.equal(savedCount, 1);
  const sharable = JSON.stringify(splitSharableFields(written)); assert.ok(!sharable.includes('PRIVATE_COGNITION')); assert.ok(!sharable.includes('可信画像'));
  assert.ok((await readFile(path.join(stateDir, 'textbook-jobs', `${prep.jobId}.json`), 'utf8')).includes('PRIVATE_COGNITION'));
  assert.ok(readTextbookBody((await readDisk()).find((item) => item.id === 'project-a')!.content, written.textbook!).includes('参考答案'));
  pass('批准后实际目录选材/深读/蓝图/章节/质量门控/私有检查点/可恢复笔记落盘闭环，同名项目不串写');
  const before = modelCalls; await generateTextbook(ctx, prep.jobId, undefined, deps); assert.equal(modelCalls, before); assert.equal(savedCount, 1);
  const existing = await prepareTextbook(ctx, {}, deps) as { status: string }; assert.equal(existing.status, 'existing_textbook_continue_reading');
  pass('同一项目跨天/重复调用不再生成，私有认知不出现在可分享教材中');

  await reset(); const compact = await prepared(); mode = 'focused-pacing';
  const compactCalls: LlmCallRequest[] = [];
  const compactDeps = { ...deps, model: async (request: LlmCallRequest) => { compactCalls.push(request); return fixtureModel(request); } };
  await generateTextbook(ctx, compact.jobId, undefined, compactDeps);
  const compactJob = (await command({ op: 'get', jobId: compact.jobId })).job;
  assert.equal(compactJob.stage, 'published'); assert.equal(compactCalls.length, 5); // selection + blueprint + 2 chapters + quality
  assert.equal(compactJob.checkpoint.blueprint!.teachingPlan!.targetChars, 4500);
  assert.equal(compactJob.checkpoint.chapters![0].sections.summary, '');
  const compactText = readTextbookBody(notes.find(note => note.id === 'project-a')!.content, notes.find(note => note.id === 'project-a')!.textbook!)!;
  assert.equal((compactText.match(/### 迁移练习/gu) || []).length, 1);
  assert.equal((compactText.match(/### 试着复述/gu) || []).length, 2);
  assert.ok(compactCalls.at(-1)!.systemPromptOverride!.includes('不要求每章填满'));
  const compactRestored = (await readDisk()).find(note => note.id === 'project-a')!;
  assert.equal(readTextbookBody(compactRestored.content, compactRestored.textbook!), compactText);
  const compactCount = modelCalls; await generateTextbook(ctx, compact.jobId, undefined, compactDeps); assert.equal(modelCalls, compactCount);
  pass('聚焦教材真实链路：4500字软分配、未选槽位为空、原文承接、整本复核与保存重开成功，不额外调用或重复生成');

  for (const variant of ['missing', 'short', 'guidance', 'long'] as const) {
    await reset(); const recallJob = await prepared(); mode = 'focused-pacing';
    const recallCalls: LlmCallRequest[] = [];
    const projectBefore = structuredClone(notes.find(note => note.id === 'project-a')!);
    await generateTextbook(ctx, recallJob.jobId, undefined, { ...deps, model: async request => {
      recallCalls.push(request); const input = fixtureInput(request);
      const response = await fixtureModel(request); const result = JSON.parse(response.content);
      if (request.workflow === 'textbook-chapter') {
        assert.equal(input.chapter.writingPlan.restatement, 1);
        if (variant === 'missing') {
          if (input.chapter.id === 'ch1') delete result.sections.selfCheck;
          else result.sections.selfCheck = null;
        } else if (variant === 'short') result.sections.selfCheck = input.chapter.id === 'ch1' ? '为什么？' : '';
        else if (variant === 'long') result.sections.selfCheck = Array.from({ length: 8 }, (_, i) => `${i + 1}. 用自己的话解释本章的条件判断。`).join('\n');
      }
      if (request.workflow === 'textbook-quality') {
        assert.ok(request.systemPromptOverride!.includes(TEXTBOOK_RESTATEMENT_REVIEW_GUIDANCE));
        if (variant === 'guidance' || variant === 'long') Object.assign(result, { schemaVersion: 3, passed: false,
          findings: [{ severity: 'blocker', category: 'task_alignment', impact: 'critical', certainty: 'clear',
            target: { kind: 'chapter', chapterId: 'ch1', section: 'selfCheck', quote: input.chapters[0].sections.selfCheck },
            message: '复述引导可以更精简并补充任务标签', reason: '这是问题表达和阅读节奏建议，不改变讲授内容与判断。',
            basis: [{ kind: 'task', index: 0, quote: input.context.project.tasks[0] }] }] });
      }
      return { ...response, content: JSON.stringify(result), parsedJson: result };
    } });
    const finished = (await command({ op: 'get', jobId: recallJob.jobId })).job;
    assert.equal(finished.stage, 'published'); assert.equal(recallCalls.length, 5);
    assert.equal(finished.checkpoint.cost!.repairRounds, 0);
    assert.equal(finished.checkpoint.cost!.reviewRechecks, 0);
    for (const chapter of finished.checkpoint.chapters!) {
      assert.deepEqual(Object.keys(chapter.sections).sort(), ['explanation', 'boundaries', 'workedExample', 'practice', 'answer', 'selfCheck', 'summary'].sort());
      if (variant === 'missing') assert.equal(chapter.sections.selfCheck, '');
    }
    const saved = (await readDisk()).find(note => note.id === 'project-a')!;
    const body = readTextbookBody(saved.content, saved.textbook!)!;
    assert.equal(stripTextbookRegion(saved.content, saved.textbook).outside.trim(), projectBefore.content.trim());
    assert.deepEqual(saved.learningReviewRecords, projectBefore.learningReviewRecords);
    if (variant === 'guidance') {
      assert.equal((body.match(/^### 试着复述$/gmu) || []).length, 2);
      assert.ok(body.includes('对应任务：理解选择过载效应'));
      assert.ok(!body.includes('### 自检'));
      for (const chunk of body.split(/^## \d+\. /mu).slice(1)) assert.equal([...chunk.matchAll(/^### (.+)$/gmu)].at(-1)![1], '试着复述');
      assert.equal(finished.checkpoint.quality!.warnings!.length, 1);
    }
  }
  pass('章末复述真实落盘：七键不变，漏填/null/短问题/题数偏多及标签建议不触发额外生成，逐章位于末尾且不勾任务或创建复盘');

  await reset(); const compactInterrupted = await prepared(); mode = 'focused-pacing';
  await assert.rejects(generateTextbook(ctx, compactInterrupted.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
    if (request.workflow === 'textbook-chapter' && fixtureInput(request).chapter.id === 'ch2') throw new Error('compact chapter interruption');
    return fixtureModel(request);
  } }), /compact chapter interruption/u);
  const compactSaved = (await command({ op: 'get', jobId: compactInterrupted.jobId })).job;
  assert.equal(compactSaved.checkpoint.chapters!.length, 1); assert.equal(compactSaved.checkpoint.chapters![0].sections.summary, '');
  const compactBeforeCount = modelCalls; store = new TextbookStore(stateDir);
  await freshlyApprovedGenerate(compactInterrupted.jobId, undefined, deps);
  const compactResumed = (await command({ op: 'get', jobId: compactInterrupted.jobId })).job;
  assert.equal(modelCalls - compactBeforeCount, 2); // remaining chapter + quality only
  assert.deepEqual(compactResumed.checkpoint.chapters![0], compactSaved.checkpoint.chapters![0]);
  assert.deepEqual(compactResumed.checkpoint.blueprint, compactSaved.checkpoint.blueprint);
  pass('精简教材章节中断→私有Store重启→同任务确认续跑，仅补剩余章和复核，空小结不会导致前章重生成');

  await reset(); const oldRecallJob = await prepared(); mode = 'focused-pacing';
  await assert.rejects(generateTextbook(ctx, oldRecallJob.jobId, undefined, { ...deps, model: async request => {
    if (request.workflow === 'textbook-chapter' && fixtureInput(request).chapter.id === 'ch2') throw new Error('legacy compact stop');
    return fixtureModel(request);
  } }), /legacy compact stop/u);
  const oldRecallCheckpoint = (await command({ op: 'get', jobId: oldRecallJob.jobId })).job;
  oldRecallCheckpoint.checkpoint.blueprint!.chapters.forEach(chapter => { delete chapter.writingPlan!.restatement; });
  oldRecallCheckpoint.checkpoint.blueprint!.chapters[0].writingPlan!.sections = oldRecallCheckpoint.checkpoint.blueprint!.chapters[0].writingPlan!.sections.filter(section => section !== 'selfCheck');
  oldRecallCheckpoint.checkpoint.chapters![0].sections.selfCheck = '';
  oldRecallCheckpoint.checkpoint.chapterInputs!.ch1 = await textbookHash(chapterInputIdentity(oldRecallCheckpoint, oldRecallCheckpoint.checkpoint.blueprint!.chapters[0]));
  await writeFile(path.join(stateDir, 'textbook-jobs', `${oldRecallJob.jobId}.json`), JSON.stringify(oldRecallCheckpoint));
  store = new TextbookStore(stateDir); const oldRecallCalls: LlmCallRequest[] = [];
  await freshlyApprovedGenerate(oldRecallJob.jobId, undefined, { ...deps, model: async request => {
    oldRecallCalls.push(request);
    assert.ok(!request.systemPromptOverride!.includes(TEXTBOOK_RESTATEMENT_WRITING_GUIDANCE));
    assert.ok(!request.systemPromptOverride!.includes(TEXTBOOK_RESTATEMENT_REVIEW_GUIDANCE));
    return fixtureModel(request);
  } });
  const oldRecallFinished = (await command({ op: 'get', jobId: oldRecallJob.jobId })).job;
  assert.equal(oldRecallCalls.length, 2); assert.equal(oldRecallFinished.stage, 'published');
  assert.deepEqual(oldRecallFinished.checkpoint.blueprint, oldRecallCheckpoint.checkpoint.blueprint);
  assert.deepEqual(oldRecallFinished.checkpoint.chapters![0], oldRecallCheckpoint.checkpoint.chapters![0]);
  assert.ok(oldRecallFinished.checkpoint.body!.includes('### 自检') && !oldRecallFinished.checkpoint.body!.includes('### 试着复述'));
  pass('旧精简任务重启仍复用已保存章/蓝图/提示词，只补未完章与复核，不因章末复述新策略迁移或重生成');

  // Real pipeline regression for unassigned slots in the final chapter. These
  // are JSON compatibility defaults, never grounds for another model request.
  for (const optionalValue of [undefined, null, '见上章']) {
    await reset(); const optionalJob = await prepared(); mode = 'focused-pacing';
    const optionalCalls: LlmCallRequest[] = [];
    let pauseFinal = optionalValue === '见上章';
    let finalTeaching: Record<string, string> | undefined;
    const optionalDeps = { ...deps, model: async (request: LlmCallRequest) => {
      optionalCalls.push(request);
      const input = fixtureInput(request);
      if (request.workflow === 'textbook-chapter' && input.chapter.id === 'ch3' && pauseFinal) {
        pauseFinal = false; throw new Error('synthetic last-chapter interruption');
      }
      const response = await fixtureModel(request);
      const result = JSON.parse(response.content);
      if (request.workflow === 'textbook-blueprint' && Array.isArray(result.chapters)) {
        result.chapters.push({ ...structuredClone(result.chapters[1]), id: 'ch3', title: '设计实验与自检清单' });
      }
      if (request.workflow === 'textbook-chapter' && input.chapter.id === 'ch3') {
        assert.ok(!input.chapter.writingPlan.sections.includes('workedExample'));
        if (optionalValue === undefined) delete result.sections.workedExample;
        else result.sections.workedExample = optionalValue;
        result.sections.boundaries = null;
        finalTeaching = structuredClone(result.sections);
      }
      return { ...response, content: JSON.stringify(result), parsedJson: result };
    } };
    let priorChapters: unknown;
    if (pauseFinal) {
      await assert.rejects(generateTextbook(ctx, optionalJob.jobId, undefined, optionalDeps), /synthetic last-chapter interruption/u);
      const interrupted = (await command({ op: 'get', jobId: optionalJob.jobId })).job;
      assert.equal(interrupted.checkpoint.chapters!.length, 2);
      priorChapters = structuredClone(interrupted.checkpoint.chapters);
      store = new TextbookStore(stateDir);
      await freshlyApprovedGenerate(optionalJob.jobId, undefined, optionalDeps);
    } else await generateTextbook(ctx, optionalJob.jobId, undefined, optionalDeps);
    const finished = (await command({ op: 'get', jobId: optionalJob.jobId })).job;
    assert.equal(finished.stage, 'published');
    assert.equal(finished.checkpoint.chapters!.length, 3);
    if (priorChapters) assert.deepEqual(finished.checkpoint.chapters!.slice(0, 2), priorChapters);
    const final = finished.checkpoint.chapters!.at(-1)!;
    assert.equal(final.sections.workedExample, ''); assert.equal(final.sections.boundaries, '');
    for (const key of ['explanation', 'practice', 'answer', 'selfCheck', 'summary']) assert.equal(final.sections[key], finalTeaching![key]);
    assert.equal(optionalCalls.filter(call => call.workflow === 'textbook-blueprint' && !JSON.parse(call.userInput).catalogs).length, 1);
    assert.equal(optionalCalls.filter(call => call.workflow === 'textbook-quality').length, 1);
    for (const id of ['ch1', 'ch2']) assert.equal(optionalCalls.filter(call => call.workflow === 'textbook-chapter' && JSON.parse(call.userInput).chapter.id === id).length, 1);
    assert.equal(finished.checkpoint.cost!.repairRounds, 0, 'No content repair round for optional slot compatibility');
    const restored = (await readDisk()).find(note => note.id === 'project-a')!;
    const body = readTextbookBody(restored.content, restored.textbook!)!;
    assert.ok(body.includes('设计实验与自检清单') && body.includes(final.sections.practice));
    assert.equal((body.match(/### 例子与反例/gu) || []).length, 2);
    const beforeReuse = optionalCalls.length; await generateTextbook(ctx, optionalJob.jobId, undefined, optionalDeps);
    assert.equal(optionalCalls.length, beforeReuse);
  }
  pass('三章真实链路：末章未选案例缺失/null/空占位本地补空后一次通过，断点重启复用前两章，不新增修订轮或模型调用');

  for (const failure of ['bad-citation', 'quality-failure', 'disk-failure', 'project-change', 'source-change']) {
    await writeFile(path.join(temp, 'documents', 'doc-choice.md'), original); await reset(); const job = await prepared(); mode = failure;
    await assert.rejects(generateTextbook(ctx, job.jobId, undefined, deps));
    assert.equal(notes.find((item) => item.id === 'project-a')!.textbook, undefined); assert.equal(savedCount, 0);
    assert.equal(indexedCount, 0); assert.equal((await readDisk()).find((item) => item.id === 'project-a')!.textbook, undefined);
    assert.equal((await command({ op: 'get', jobId: job.jobId })).job.stage, 'failed');
    assert.equal(notes.find((item) => item.id === 'project-b')!.content, pristine()[3].content);
  }
  pass('无效引用、质量拒绝、持久化失败、项目/原始资料变化都不覆盖笔记或声称完成');
  await writeFile(path.join(temp, 'documents', 'doc-choice.md'), original); await reset(); const failedSave = await prepared();
  const visibleBeforeSave = notes; const saveEntered = deferred(); const releaseFailedSave = deferred(); mode = 'disk-failure';
  publicationSaveHook = async () => { saveEntered.resolve(); await releaseFailedSave.promise; };
  const failedSaveRun = generateTextbook(ctx, failedSave.jobId, undefined, deps);
  const failureObserved = assert.rejects(failedSaveRun, /inside real publication save/u);
  await saveEntered.promise;
  assert.strictEqual(notes, visibleBeforeSave); assert.equal(saveState, 'saving'); assert.equal(indexedCount, 0);
  assert.equal(notes.find((item) => item.id === 'project-a')!.textbook, undefined);
  assert.equal((await queryTextbookState(ctx) as { status: string }).status, 'not_generated');
  assert.equal((await readDisk()).find((item) => item.id === 'project-a')!.textbook, undefined);
  releaseFailedSave.resolve(); await failureObserved;
  assert.strictEqual(notes, visibleBeforeSave); assert.strictEqual(pendingNotes, notes); assert.equal(saveState, 'error');
  assert.equal(indexedCount, 0); assert.equal(savedCount, 0);
  assert.equal((await queryTextbookState(ctx) as { status: string }).status, 'not_generated');
  assert.equal((await prepareTextbook(ctx, { allowedDocIds: ['doc-choice'] }, deps) as { status: string }).status, 'prepared_requires_approval');
  pass('生产发布适配器：保存等待/拒绝均不提前显示或索引教材；失败后 query/prepare 不误判已有教材');
  const checkpointBeforeRetry = (await command({ op: 'get', jobId: failedSave.jobId })).job.checkpoint;
  assert.equal(checkpointBeforeRetry.chapters?.length, 2); const callsBeforeRetry = modelCalls;
  mode = 'normal'; publicationSaveHook = undefined;
  await generateTextbook(ctx, failedSave.jobId, undefined, deps);
  const retriedJob = (await command({ op: 'get', jobId: failedSave.jobId })).job;
  assert.equal(modelCalls - callsBeforeRetry, 0); assert.deepEqual(retriedJob.checkpoint.chapters, checkpointBeforeRetry.chapters);
  assert.equal(retriedJob.attempt, 2); assert.equal(retriedJob.stage, 'published'); assert.equal(indexedCount, 1); assert.equal(savedCount, 1);
  assert.equal(saveState, 'saved'); assert.equal(pendingNotes, null);
  pass('同 job 保存失败后可显式重试：复用已通过质量门控的教材，不调用模型，成功保存后才发布和索引');
  await writeFile(path.join(temp, 'documents', 'doc-choice.md'), original); await reset(); const cancellable = await prepared();
  abortController = new AbortController(); mode = 'cancel'; await assert.rejects(generateTextbook(ctx, cancellable.jobId, abortController.signal, deps));
  const cancelled = (await command({ op: 'get', jobId: cancellable.jobId })).job;
  assert.equal(cancelled.stage, 'cancelled'); assert.equal(cancelled.checkpoint.chapters?.length, 1); assert.equal(savedCount, 0);
  store = new TextbookStore(stateDir); mode = 'normal'; const resumeCalls = modelCalls;
  assert.ok((await store.list('project-a')).some((item) => item.jobId === cancellable.jobId && item.stage === 'cancelled'));
  assert.equal((await store.list('project-b')).length, 0);
  await generateTextbook(ctx, cancellable.jobId, undefined, deps); assert.equal(modelCalls - resumeCalls, 2); // remaining chapter + quality
  assert.equal((await command({ op: 'get', jobId: cancellable.jobId })).job.attempt, 2);
  pass('停止取消后检查点保留；模拟重启重新执行只补未完成章节，不重复生成已完成章节');

  await reset(); const leased = await prepared(); const lease = await command({ op: 'claim', jobId: leased.jobId });
  await assert.rejects(command({ op: 'claim', jobId: leased.jobId }), /正在执行/u);
  await assert.rejects(command({ op: 'checkpoint', jobId: leased.jobId, token: 'wrong', stage: 'chapters', checkpoint: {} }), /许可/u);
  await assert.rejects(command({ op: 'checkpoint', jobId: leased.jobId, token: lease.token!, stage: 'published', checkpoint: {} }), /已发布/u);
  await command({ op: 'stop', jobId: leased.jobId, token: lease.token!, cancelled: true, error: 'fixture' });
  await assert.rejects(command({ op: 'get', jobId: '../outside' }), /编号/u);
  pass('每项目互斥、窗口租约、路径范围与发布状态保护');

  await reset(); const stale = await prepared(); const call = { id: 'stale', name: 'generate_project_textbook', arguments: { jobId: stale.jobId } };
  const binding = await createAgentApprovalBinding(call, ctx);
  notes = notes.map((item) => item.id === 'project-a' ? { ...item, content: `${item.content}\n用户新增任务。` } : item);
  await assert.rejects(validateAgentApprovalBinding({ call, binding } as never, ctx), /发生变化/u);
  notes = pristine(); llmSettings.providers[0].selectedModel = 'changed'; storage.set('loginote_llm_settings', JSON.stringify(llmSettings));
  await assert.rejects(validateAgentApprovalBinding({ call, binding } as never, ctx), /发生变化/u);
  assert.equal(modelCalls, 0); llmSettings.providers[0].selectedModel = 'mock';
  llmSettings.providers[0].baseUrl = 'https://remote.invalid'; storage.set('loginote_llm_settings', JSON.stringify(llmSettings));
  await assert.rejects(textbookProviderSnapshot(false), /不是本机/u); await textbookProviderSnapshot(true);
  llmSettings.providers[0].baseUrl = 'http://127.0.0.1:11434'; storage.set('loginote_llm_settings', JSON.stringify(llmSettings));
  pass('确认绑定实际项目/物料/模型配置；显式仅本机范围仍拒绝远程服务');

  await reset();
  const localProvider = structuredClone(llmSettings.providers[0]);
  Object.assign(llmSettings.providers[0], { name: '合成云端模型', baseUrl: 'https://cloud.example.invalid/v1' });
  storage.set('loginote_llm_settings', JSON.stringify(llmSettings));
  const prepDefinition = getTool('prepare_project_textbook')!;
  const cloudPrepared = await prepDefinition.execute({ allowedDocIds: ['doc-choice'], readBoundUrls: false }, ctx) as { jobId: string; status: string; allowCloud: boolean; message: string };
  assert.equal(cloudPrepared.status, 'prepared_requires_approval'); assert.equal(cloudPrepared.allowCloud, true);
  assert.equal(modelCalls, 0); assert.equal(savedCount, 0);
  assert.match(cloudPrepared.message, /一次确认卡/);
  const proposedCloudJob = (await command({ op: 'get', jobId: cloudPrepared.jobId })).job;
  assert.equal(proposedCloudJob.stage, 'prepared'); assert.equal(proposedCloudJob.checkpoint.context, undefined);
  const cloudCard = textbookConfirmation(cloudPrepared.jobId);
  const cardText = JSON.stringify(cloudCard);
  for (const text of ['确认本卡即授权本任务', 'cloud.example.invalid', '合成云端模型', '可信画像', '相关个人认知', '最近学习记录', '不保存为全局云端许可', '取消不发送']) assert.ok(cardText.includes(text), text);
  assert.ok(!cardText.includes('PRIVATE_COGNITION'));
  const cloudNotesBefore = structuredClone(notes);
  const requestCloudApproval = () => runAgentTurn({ role: AGENT_ROLES.default, userText: '生成当前项目的教材', ctx, history: [], memoryPrefixLoader: async () => '',
    callLlm: async () => ({ content: '请在同一张卡中确认本次云端范围与教材生成。', toolCalls: [{ id: 'cloud-book', name: 'generate_project_textbook', arguments: { jobId: cloudPrepared.jobId } }] }) });
  const declinedCloud = await requestCloudApproval();
  assert.equal(declinedCloud.pendingApproval!.items.length, 1); assert.equal(modelCalls, 0);
  await resolveAgentApproval({ role: AGENT_ROLES.default, ctx, approval: declinedCloud.pendingApproval!, approved: false, history: declinedCloud.updatedHistory,
    callLlm: async () => ({ content: '已取消，不发送教材资料。' }) });
  assert.equal(modelCalls, 0); assert.equal(savedCount, 0); assert.deepEqual(notes, cloudNotesBefore);
  const acceptedCloud = await requestCloudApproval();
  const cloudWritten = await resolveAgentApproval({ role: AGENT_ROLES.default, ctx, approval: acceptedCloud.pendingApproval!, approved: true, history: acceptedCloud.updatedHistory,
    callLlm: async () => ({ content: '教材已保存。' }) });
  assert.ok(cloudWritten.toolTrace.some(step => step.call.name === 'generate_project_textbook' && step.ok));
  assert.equal((await command({ op: 'get', jobId: cloudPrepared.jobId })).job.stage, 'published');
  assert.equal(savedCount, 1);
  assert.ok(![...storage.keys()].some(key => /cloud.*(?:consent|permission)|(?:consent|permission).*cloud/iu.test(key)));
  pass('真实工具准备自动识别云端而零教材请求；一张绑定确认卡合并数据许可与生成写入，取消零调用/零改笔记，确认后才生成，不创建全局许可');

  await reset();
  await assert.rejects(async () => prepDefinition.execute({ allowedDocIds: ['doc-choice'], readBoundUrls: false, allowCloud: false }, ctx), /仅允许本机模型/u);
  await assert.rejects(async () => prepDefinition.execute({ allowedDocIds: ['doc-choice'], allowCloud: 'false' }, ctx), /参数无效/u);
  assert.equal((await store.list('project-a')).length, 0); assert.equal(modelCalls, 0);
  const cloudBeforeChange = await prepDefinition.execute({ allowedDocIds: ['doc-choice'], readBoundUrls: false }, ctx) as { jobId: string };
  const cloudChangeCall = { id: 'cloud-change', name: 'generate_project_textbook', arguments: { jobId: cloudBeforeChange.jobId } };
  const cloudChangeBinding = await createAgentApprovalBinding(cloudChangeCall, ctx);
  llmSettings.providers[0].baseUrl = 'https://another-cloud.example.invalid/v1'; storage.set('loginote_llm_settings', JSON.stringify(llmSettings));
  await assert.rejects(validateAgentApprovalBinding({ call: cloudChangeCall, binding: cloudChangeBinding } as never, ctx), /发生变化/u);
  await assert.rejects(generateTextbook(ctx, cloudBeforeChange.jobId, undefined, deps), /模型配置已变化/u);
  assert.equal(modelCalls, 0); assert.equal(savedCount, 0);
  llmSettings.providers[0].baseUrl = 'https://cloud.example.invalid/v1'; storage.set('loginote_llm_settings', JSON.stringify(llmSettings));
  const notesAtSummaryRace = structuredClone(notes);
  await assert.rejects(prepareTextbook(ctx, { allowedDocIds: ['doc-choice'], readBoundUrls: false }, { ...deps, providerHash: async (cloud, policy) => {
    const hash = await textbookProviderSnapshot(cloud, policy);
    llmSettings.providers[0].baseUrl = 'https://changed-during-prepare.example.invalid/v1'; storage.set('loginote_llm_settings', JSON.stringify(llmSettings));
    return hash;
  } }), /准备期间模型配置已变化/u);
  assert.deepEqual(notes, notesAtSummaryRace); assert.equal(modelCalls, 0);
  llmSettings.providers[0].baseUrl = 'https://cloud.example.invalid/v1'; storage.set('loginote_llm_settings', JSON.stringify(llmSettings));
  pass('合并许可不绕过本机限制；无效布尔参数、确认后换服务商、准备时模型展示范围变化都在模型请求前拒绝');

  await reset();
  const cloudResumeJob = await prepareTextbook(ctx, { allowedDocIds: ['doc-choice'], readBoundUrls: false, allowCloud: true }, deps) as { jobId: string };
  await assert.rejects(freshlyApprovedGenerate(cloudResumeJob.jobId, undefined, { ...deps, model: async request => {
    if (request.workflow === 'textbook-chapter' && fixtureInput(request).chapter.id === 'ch2') throw new Error('synthetic cloud last-chapter pause');
    return fixtureModel(request);
  } }), /synthetic cloud last-chapter pause/u);
  const cloudInterrupted = (await command({ op: 'get', jobId: cloudResumeJob.jobId })).job;
  assert.equal(cloudInterrupted.checkpoint.chapters!.length, 1);
  store = new TextbookStore(stateDir);
  const sameCloudTask = await prepDefinition.execute({ allowedDocIds: ['doc-choice'], readBoundUrls: false }, ctx) as { jobId: string; reused: boolean };
  assert.equal(sameCloudTask.jobId, cloudResumeJob.jobId); assert.equal(sameCloudTask.reused, true);
  await textbookApprovalSnapshot(ctx, sameCloudTask.jobId, deps);
  assert.match(JSON.stringify(textbookConfirmation(sameCloudTask.jobId)), /确认本卡即授权本任务/);
  const cloudResumeRequests: LlmCallRequest[] = [];
  await freshlyApprovedGenerate(sameCloudTask.jobId, undefined, { ...deps, model: async request => { cloudResumeRequests.push(request); return fixtureModel(request); } });
  const cloudResumed = (await command({ op: 'get', jobId: sameCloudTask.jobId })).job;
  assert.equal(cloudResumeRequests.length, 2); assert.equal(cloudResumed.stage, 'published');
  assert.deepEqual(cloudResumed.checkpoint.chapters![0], cloudInterrupted.checkpoint.chapters![0]);
  assert.deepEqual(cloudResumed.spec, cloudInterrupted.spec);
  Object.assign(llmSettings.providers[0], localProvider); storage.set('loginote_llm_settings', JSON.stringify(llmSettings));
  pass('旧显式云端许可任务重启后自动准备仍复用同jobId/许可/用量；同一继续确认卡只恢复末章和复核，不再另建任务或重做前章');

  await reset();
  llmSettings.providers.push({ ...localProvider, id: 'fixture-cloud-quality', name: '合成云端复核', baseUrl: 'https://quality.example.invalid/v1' });
  (llmSettings.workflowBinding as Record<string, string>)['textbook-quality'] = 'fixture-cloud-quality';
  storage.set('loginote_llm_settings', JSON.stringify(llmSettings));
  const mixedCloudJob = await prepDefinition.execute({ allowedDocIds: ['doc-choice'], readBoundUrls: false }, ctx) as { jobId: string; allowCloud: boolean };
  assert.equal(mixedCloudJob.allowCloud, true);
  const mixedCard = JSON.stringify(textbookConfirmation(mixedCloudJob.jobId));
  assert.ok(mixedCard.includes('127.0.0.1') && mixedCard.includes('quality.example.invalid'));
  await assert.rejects(async () => prepDefinition.execute({ allowedDocIds: ['doc-choice'], allowCloud: false, readBoundUrls: false }, ctx), /仅允许本机模型/u);
  assert.equal(modelCalls, 0); assert.equal(savedCount, 0);
  llmSettings.providers.pop(); delete (llmSettings.workflowBinding as Record<string, string>)['textbook-quality'];
  storage.set('loginote_llm_settings', JSON.stringify(llmSettings));
  pass('混合模型配置逐阶段识别：即使默认模型在本机，远程复核也列入同一确认；仅本机限制不被默认模型掩盖');

  await reset(); const late = await prepared(); mode = 'late-stop'; abortController = new AbortController();
  const lateResult = await generateTextbook(ctx, late.jobId, abortController.signal, deps) as { saved: boolean }; assert.equal(lateResult.saved, true);
  assert.equal((await command({ op: 'get', jobId: late.jobId })).job.stage, 'published');
  pass('保存开始后的迟到取消不谎报未写入，持久化完成才标记发布');

  const savedJob = (await command({ op: 'get', jobId: late.jobId })).job;
  const invalidBlueprint = structuredClone(savedJob.checkpoint.blueprint!); invalidBlueprint.focuses[0].evidenceIds = ['C999'];
  assert.throws(() => validateBlueprint(invalidBlueprint, context, savedJob.checkpoint.sources!), /不存在/u);
  invalidBlueprint.focuses[0].kind = 'not_expressed'; invalidBlueprint.focuses[0].evidenceIds = ['C1'];
  assert.throws(() => validateBlueprint(invalidBlueprint, context, savedJob.checkpoint.sources!), /不能伪造/u);
  const invalidChapter = structuredClone(savedJob.checkpoint.chapters![0]); invalidChapter.sections.practice += '\n<ArgumentBlock id="bad" />';
  assert.throws(() => validateChapter(invalidChapter, 'ch1', savedJob.checkpoint.blueprint!.chapters[0].sourceIds), /控制块/u);
  assert.throws(() => validateTextbookJob(savedJob, 'model supplied body'), /不一致/u);
  pass('目标覆盖、真实证据编号、个人材料/事实分离、控制块与最终正文一致性门控');

  // Original context readers: real same-root episode filtering and independent cognition channels.
  const bridge = (globalThis as any).window.electronAPI;
  bridge.agent = { queryProfile: async () => ({ text: '中性画像' }), queryMastery: async () => ({ rows: [] }) };
  bridge.userState = { searchCognition: async () => ({ status: 'ready', method: 'local-lexical-v1', items: [], materials: [], warning: '未命中不代表缺陷' }),
    loadLearningEpisodes: async () => ({ version: 1, episodes: [
      { id: 'same-root', type: 'flow', status: 'completed', noteId: 'project-a', rootProjectId: 'root-a', title: '上次本计划学习', startedAt: '2026-01-01', endedAt: '2026-01-02', createdAt: '2026-01-01', updatedAt: '2026-01-02' },
      { id: 'other-root', type: 'flow', status: 'completed', noteId: 'project-b', rootProjectId: 'root-b', title: '其它计划更近', startedAt: '2026-09-01', endedAt: '2026-09-02', createdAt: '2026-09-01', updatedAt: '2026-09-02' },
    ] }) };
  const actualContext = await buildTextbookContext(ctx, 'project-a'); assert.equal(actualContext.previousLearning?.id, 'same-root'); assert.equal(actualContext.personal.length, 0);
  pass('真实画像/认知/学习记录读取器：只承接当前根项目最近完成学习；空检索不编造认知错误');

  // Multi-file journal recovery with the production snapshot writer; no user vault touched.
  mode = 'normal'; const recoverable = structuredClone(notes); let writes = 0;
  // Identical snapshots now correctly perform zero writes. Inject the crash in
  // a real content + metadata update rather than relying on redundant rewrites.
  recoverable[0] = { ...recoverable[0], content: recoverable[0].content + '\n合成故障恢复检查', updatedAt: '2026-10-16T05:00:00.000Z' };
  await assert.rejects(saveVaultSnapshot(vault, stateDir, recoverable, async (file, text) => { writes++; if (writes === 3) throw new Error('crash fixture'); return atomicWriteTextFile(file, text); }));
  await recoverVaultSnapshot(vault, stateDir);
  assert.equal((await readDisk()).find((item) => item.id === 'project-a')!.textbook?.generationJobId, late.jobId);
  await assert.rejects(readFile(path.join(stateDir, 'vault-pending-snapshot.json')), /ENOENT/u);
  pass('真实文件快照中途故障后恢复同一完整笔记，教材与原内容不丢失');
  await reset(); const appended = await prepared(); mode = 'new-record'; await generateTextbook(ctx, appended.jobId, undefined, deps);
  const withRecord = (await readDisk()).find((item) => item.id === 'project-a')!;
  assert.equal(withRecord.learningReviewRecords?.[0].title, '用户自定义复盘标题'); assert.ok(withRecord.content.includes('<LearningReviewBlock id="late-review" />'));
  assert.ok(readTextbookBody(withRecord.content, withRecord.textbook!).includes('print("<b>'));
  assert.ok(readTextbookBody(withRecord.content, withRecord.textbook!).includes('$$n = |S|$$'));
  pass('生成期间新增独立折叠复盘可安全合并；代码、表格、公式和引用注释经过保存重载保持原文');
  await reset(); const receipt = await prepared(); failFinishOnce = true;
  await assert.rejects(generateTextbook(ctx, receipt.jobId, undefined, deps), /receipt/u);
  assert.ok(notes.find((item) => item.id === 'project-a')!.textbook); const receiptCalls = modelCalls;
  await generateTextbook(ctx, receipt.jobId, undefined, deps); assert.equal(modelCalls, receiptCalls); assert.equal(savedCount, 1);
  pass('教材已落盘但任务回执中断时，只核验完成、不重新生成或再次发布');
  await reset(); const repair = await prepared(); mode = 'quality-failure'; await assert.rejects(generateTextbook(ctx, repair.jobId, undefined, deps));
  const repairCalls = modelCalls; mode = 'normal'; await freshlyApprovedGenerate(repair.jobId); assert.equal(modelCalls - repairCalls, 1);
  pass('尚未定位的质量问题重新批准后只重跑复核定位，不清空蓝图和已保存章节');
  const leakJob = structuredClone((await command({ op: 'get', jobId: repair.jobId })).job);
  leakJob.checkpoint.chapters![0].sections.practice += `\n${context.personal[0].text}`;
  const leakedBody = assembleTextbook(leakJob.checkpoint.blueprint!, leakJob.checkpoint.chapters!, leakJob.checkpoint.sources!);
  assert.throws(() => validateTextbookJob(leakJob, leakedBody), /个人原话/u);
  pass('即使质量模型错误放行，完整个人原话仍不能进入可分享教材');

  const rejectedObjective = '用相同选项数量的不同结果反驳选项更多必然更差';
  const correctedObjective = '比较背景条件相近、选项增加但结果未变差的假设情境，识别绝对化结论的反例';
  const objectiveIssue = '学习目标 O1 的反例逻辑错误：相同数量的不同结果不足以反驳更多选项必然更差。';
  const rejectedBlueprintDeps = { ...deps, model: async (request: LlmCallRequest) => {
    const response = await fixtureModel(request);
    if (request.workflow === 'textbook-blueprint' && !fixtureInput(request).catalogs) response.parsedJson.objectives[0].text = rejectedObjective;
    if (request.workflow === 'textbook-quality') {
      const input = fixtureInput(request);
      response.parsedJson = { schemaVersion: 2, passed: false, findings: [{ severity: 'blocker', category: 'internal_consistency',
        target: { kind: 'objective', id: 'O1', quote: rejectedObjective }, message: objectiveIssue,
        reason: '目标要求反驳数量增加的必然结论，但正文区分了相同数量与增加数量，目标与论证方法不一致。',
        basis: [{ kind: 'textbook', target: { kind: 'chapter', chapterId: 'ch1', section: 'boundaries', quote: input.chapters[0].sections.boundaries } }] }] };
    }
    return response;
  } };
  const correctedBlueprintDeps = (seen: LlmCallRequest[], expectedSources: unknown, expectedContext: unknown) => ({ ...deps, model: async (request: LlmCallRequest) => {
    seen.push(structuredClone(request)); const input = fixtureInput(request);
    assert.ok(!input.catalogs, '重新批准的质量修订不应重新选资料');
    if (request.workflow === 'textbook-blueprint') {
      assert.deepEqual(input.repairIssues, [objectiveIssue]); assert.deepEqual(input.sources, expectedSources); assert.deepEqual(input.context, expectedContext);
    } else if (request.workflow === 'textbook-chapter') {
      assert.deepEqual(input.repairIssues, [objectiveIssue]); assert.equal(input.blueprint.objectives[0].text, correctedObjective);
      assert.ok(!request.userInput.includes(rejectedObjective), '被拒绝的旧学习目标不能进入新章节请求');
    }
    const response = await fixtureModel(request);
    if (request.workflow === 'textbook-blueprint') response.parsedJson.objectives[0].text = correctedObjective;
    return response;
  } });
  await reset(); const blueprintRepair = await prepared();
  await assert.rejects(generateTextbook(ctx, blueprintRepair.jobId, undefined, rejectedBlueprintDeps));
  const rejectedBlueprintJob = (await command({ op: 'get', jobId: blueprintRepair.jobId })).job;
  assert.equal(rejectedBlueprintJob.checkpoint.blueprint!.objectives[0].text, rejectedObjective);
  assert.equal(rejectedBlueprintJob.checkpoint.quality!.passed, false); assert.equal(savedCount, 0);
  const blueprintRepairSeen: LlmCallRequest[] = [];
  await freshlyApprovedGenerate(blueprintRepair.jobId, undefined, correctedBlueprintDeps(blueprintRepairSeen, rejectedBlueprintJob.checkpoint.sources, rejectedBlueprintJob.checkpoint.context));
  const rebuiltBlueprintJob = (await command({ op: 'get', jobId: blueprintRepair.jobId })).job;
  assert.deepEqual(blueprintRepairSeen.map((request) => request.workflow), ['textbook-blueprint', 'textbook-chapter', 'textbook-chapter', 'textbook-quality']);
  assert.equal(rebuiltBlueprintJob.checkpoint.blueprint!.objectives[0].text, correctedObjective);
  assert.deepEqual(rebuiltBlueprintJob.checkpoint.sources, rejectedBlueprintJob.checkpoint.sources);
  assert.deepEqual(rebuiltBlueprintJob.checkpoint.context, rejectedBlueprintJob.checkpoint.context);
  assert.equal(rebuiltBlueprintJob.checkpoint.repairIssues, undefined); assert.equal(rebuiltBlueprintJob.stage, 'published'); assert.equal(savedCount, 1);
  pass('质量拒绝涉及错误学习目标时，重新批准真正生成新蓝图，旧目标不进入章节；原资料与画像不扩大');

  for (const interruption of ['cancel', 'truncated'] as const) {
    await reset(); const interruptedRepair = await prepared();
    await assert.rejects(generateTextbook(ctx, interruptedRepair.jobId, undefined, rejectedBlueprintDeps));
    const beforeRepair = (await command({ op: 'get', jobId: interruptedRepair.jobId })).job;
    const controller = new AbortController(); const interruptedInputs: LlmCallRequest[] = [];
    const interruptedDeps = { ...deps, model: async (request: LlmCallRequest) => {
      interruptedInputs.push(structuredClone(request)); assert.equal(request.workflow, 'textbook-blueprint');
      assert.deepEqual(fixtureInput(request).repairIssues, [objectiveIssue]); await fixtureModel(request);
      if (interruption === 'cancel') controller.abort();
      return { content: '{"partial":', diagnostics: { finishReason: 'length' } };
    } };
    await assert.rejects(freshlyApprovedGenerate(interruptedRepair.jobId, controller.signal, interruptedDeps));
    assert.equal(interruptedInputs.length, interruption === 'cancel' ? 1 : 2); assert.equal(savedCount, 0);
    if (interruption === 'truncated') assert.equal(interruptedInputs[0].userInput, interruptedInputs[1].userInput);
    store = new TextbookStore(stateDir); // Real persisted checkpoint, not an in-memory repair variable.
    const interruptedCheckpoint = (await command({ op: 'get', jobId: interruptedRepair.jobId })).job.checkpoint;
    assert.deepEqual(interruptedCheckpoint.repairIssues, [objectiveIssue]); assert.equal(interruptedCheckpoint.blueprint, undefined);
    assert.deepEqual(interruptedCheckpoint.chapters, beforeRepair.checkpoint.chapters); assert.equal(interruptedCheckpoint.body, undefined); assert.equal(interruptedCheckpoint.quality, undefined);
    assert.deepEqual(interruptedCheckpoint.sources, beforeRepair.checkpoint.sources); assert.deepEqual(interruptedCheckpoint.context, beforeRepair.checkpoint.context);
    const resumedInputs: LlmCallRequest[] = [];
    if (interruption === 'truncated') {
      await assert.rejects(freshlyApprovedGenerate(interruptedRepair.jobId, undefined, correctedBlueprintDeps(resumedInputs, beforeRepair.checkpoint.sources, beforeRepair.checkpoint.context)), /同一输入已达到重试上限/u);
      assert.equal(resumedInputs.length, 0); assert.equal(savedCount, 0);
      assert.deepEqual((await command({ op: 'get', jobId: interruptedRepair.jobId })).job.checkpoint.chapters, beforeRepair.checkpoint.chapters);
      continue;
    }
    await freshlyApprovedGenerate(interruptedRepair.jobId, undefined, correctedBlueprintDeps(resumedInputs, beforeRepair.checkpoint.sources, beforeRepair.checkpoint.context));
    const resumedJob = (await command({ op: 'get', jobId: interruptedRepair.jobId })).job;
    assert.equal(resumedInputs.length, 4); assert.equal(resumedJob.stage, 'published'); assert.equal(resumedJob.checkpoint.repairIssues, undefined);
    assert.equal(savedCount, 1); assert.equal(resumedJob.checkpoint.blueprint!.objectives[0].text, correctedObjective);
  }
  pass('修订蓝图取消可恢复且携带问题；截断耗尽后跨重启不重置次数，保留问题清单与此前合格章节');

  const structuralRepairDeps = (seen: LlmCallRequest[], rejected: TextbookJob) => ({ ...deps, model: async (request: LlmCallRequest) => {
    seen.push(structuredClone(request)); const input = fixtureInput(request);
    assert.ok(!input.catalogs, '结构修订不得扩大或重选原资料范围');
    if (request.workflow === 'textbook-blueprint') {
      assert.deepEqual(input.sources, rejected.checkpoint.sources); assert.deepEqual(input.context, rejected.checkpoint.context);
      assert.deepEqual(input.repairIssues, rejected.checkpoint.quality!.issues);
    } else if (request.workflow === 'textbook-chapter') {
      assert.deepEqual(input.repairIssues, rejected.checkpoint.quality!.issues);
      assert.ok(input.blueprint.focuses.every((focus: { sourceIds: string[] }) => !focus.sourceIds.includes('L999')));
      assert.ok(input.blueprint.chapters.every((chapter: { sourceIds: string[] }) => !chapter.sourceIds.includes('L999')));
    }
    return fixtureModel(request);
  } });
  for (const blueprintFailure of ['new-model-result', 'saved-checkpoint'] as const) {
    await reset(); const invalidBlueprintRepair = await prepared();
    if (blueprintFailure === 'new-model-result') {
      const invalidResultDeps = { ...deps, model: async (request: LlmCallRequest) => {
        const response = await fixtureModel(request);
        if (request.workflow === 'textbook-blueprint' && !fixtureInput(request).catalogs) response.parsedJson.focuses[0].sourceIds = ['L999'];
        return response;
      } };
      await assert.rejects(generateTextbook(ctx, invalidBlueprintRepair.jobId, undefined, invalidResultDeps), /不存在或重复/u);
      assert.equal(modelCalls, 2, '蓝图被拒绝后不能自动重试、生成章节或调用质量模型');
    } else {
      mode = 'cancel'; abortController = new AbortController();
      await assert.rejects(generateTextbook(ctx, invalidBlueprintRepair.jobId, abortController.signal, deps)); mode = 'normal';
      const old = (await command({ op: 'get', jobId: invalidBlueprintRepair.jobId })).job;
      assert.equal(old.checkpoint.quality, undefined); assert.equal(old.checkpoint.chapters?.length, 1);
      old.checkpoint.blueprint!.focuses[0].sourceIds = ['L999'];
      await atomicWriteTextFile(path.join(stateDir, 'textbook-jobs', invalidBlueprintRepair.jobId + '.json'), JSON.stringify(old));
      const beforeInvalidResume = modelCalls;
      await assert.rejects(freshlyApprovedGenerate(invalidBlueprintRepair.jobId), /不存在或重复/u);
      assert.equal(modelCalls, beforeInvalidResume, '旧检查点结构失败不能偷发模型请求');
    }
    store = new TextbookStore(stateDir);
    const invalidBlueprintJob = (await command({ op: 'get', jobId: invalidBlueprintRepair.jobId })).job;
    assert.equal(invalidBlueprintJob.stage, 'failed'); assert.equal(invalidBlueprintJob.checkpoint.quality!.passed, false);
    assert.ok(invalidBlueprintJob.checkpoint.quality!.issues.some((issue) => issue.includes('不存在或重复')));
    assert.equal(savedCount, 0); assert.equal(notes.find((item) => item.id === 'project-a')!.textbook, undefined);
    const repairedInputs: LlmCallRequest[] = [];
    await freshlyApprovedGenerate(invalidBlueprintRepair.jobId, undefined, structuralRepairDeps(repairedInputs, invalidBlueprintJob));
    const repairedBlueprintJob = (await command({ op: 'get', jobId: invalidBlueprintRepair.jobId })).job;
    assert.deepEqual(repairedInputs.map((request) => request.workflow), blueprintFailure === 'new-model-result'
      ? ['textbook-blueprint', 'textbook-chapter', 'textbook-chapter', 'textbook-quality']
      : ['textbook-blueprint', 'textbook-chapter', 'textbook-quality']);
    assert.equal(repairedBlueprintJob.stage, 'published'); assert.equal(savedCount, 1);
    validateBlueprint(repairedBlueprintJob.checkpoint.blueprint, context, repairedBlueprintJob.checkpoint.sources!);
    assert.equal(repairedBlueprintJob.checkpoint.repairIssues, undefined);
  }
  pass('新蓝图或旧持久化蓝图引用未知来源时，拒绝并保存结构修复问题；重新批准重建蓝图，不永久复用坏检查点');

  await reset(); const invalidChapterRepair = await prepared(); const invalidChapterInputs: LlmCallRequest[] = [];
  const invalidChapterDeps = { ...deps, model: async (request: LlmCallRequest) => {
    invalidChapterInputs.push(structuredClone(request)); const response = await fixtureModel(request);
    if (request.workflow === 'textbook-chapter' && fixtureInput(request).chapter.id === 'ch2') response.parsedJson.sections.selfCheck += ' [L999]';
    return response;
  } };
  await assert.rejects(generateTextbook(ctx, invalidChapterRepair.jobId, undefined, invalidChapterDeps), /章节引用了不存在的来源/u);
  assert.equal(invalidChapterInputs.length, 4); assert.ok(!invalidChapterInputs.some((request) => request.workflow === 'textbook-quality'));
  store = new TextbookStore(stateDir);
  const invalidChapterJob = (await command({ op: 'get', jobId: invalidChapterRepair.jobId })).job;
  assert.equal(invalidChapterJob.stage, 'failed'); assert.equal(invalidChapterJob.checkpoint.quality!.passed, false);
  assert.ok(invalidChapterJob.checkpoint.quality!.issues.some((issue) => issue.includes('章节引用了不存在的来源')));
  const chapterIssue = invalidChapterJob.checkpoint.quality!.issues.join('\n');
  assert.ok(chapterIssue.includes('ch2') && chapterIssue.includes('允许来源'));
  for (const sourceId of invalidChapterJob.checkpoint.blueprint!.chapters[1].sourceIds) assert.ok(chapterIssue.includes(sourceId));
  assert.equal(invalidChapterJob.checkpoint.chapters?.length, 1, '非法章节不能保存为可恢复的有效章节');
  assert.equal(savedCount, 0); assert.equal(notes.find((item) => item.id === 'project-a')!.textbook, undefined);
  const chapterRepairInputs: LlmCallRequest[] = [];
  await freshlyApprovedGenerate(invalidChapterRepair.jobId, undefined, structuralRepairDeps(chapterRepairInputs, invalidChapterJob));
  const repairedChapterJob = (await command({ op: 'get', jobId: invalidChapterRepair.jobId })).job;
  assert.deepEqual(chapterRepairInputs.map((request) => request.workflow), ['textbook-chapter', 'textbook-quality']);
  assert.equal(JSON.parse(chapterRepairInputs[0].userInput).chapter.id, 'ch2');
  assert.deepEqual(repairedChapterJob.checkpoint.blueprint, invalidChapterJob.checkpoint.blueprint);
  assert.deepEqual(repairedChapterJob.checkpoint.chapters![0], invalidChapterJob.checkpoint.chapters![0]);
  assert.equal(repairedChapterJob.stage, 'published'); assert.equal(savedCount, 1);
  assert.equal(repairedChapterJob.checkpoint.repairIssues, undefined); assert.ok(!repairedChapterJob.checkpoint.body?.includes('[L999]'));
  pass('章节自检中的非法来源阻止发布并定位；重新批准只修 ch2，保留蓝图和已通过的 ch1');

  // Direct adapter regressions reuse a fully validated synthetic job/body, never a hand-waved manifest.
  const publicationInput = (): TextbookPublishInput => ({ job: structuredClone(savedJob), body: savedJob.checkpoint.body! });
  const reviewSession = (id: string): FlowSession => ({ id, noteId: 'project-a', noteTitle: '学习选择过载效应', rootProjectId: 'root-a',
    startedAt: '2026-10-06T00:00:00.000Z', endedAt: '2026-10-06T00:10:00.000Z', durationSeconds: 600, reviewIntervalMinutes: 20,
    restateText: '用户复述：应先判断偏好清晰度，再检查是否存在选择过载。', summary: '本次复盘形成条件判断。', analyze: true });
  await reset(); const concurrentEntered = deferred(); const releaseConcurrent = deferred();
  publicationSaveHook = async (_candidate, call) => { if (call === 1) { concurrentEntered.resolve(); await releaseConcurrent.promise; } };
  const concurrentPublication = publish(publicationInput()); await concurrentEntered.promise;
  notes = notes.map((item) => item.id === 'project-a' ? saveFlowReviewRecord(item, reviewSession('save-time-review'), 'completed', true)
    : item.id === 'project-b' ? { ...item, content: `${item.content}\n保存期间用户编辑另一笔记。` } : item);
  pendingNotes = notes; saveState = 'pending'; releaseConcurrent.resolve(); await concurrentPublication;
  const concurrentDisk = await readDisk(); const concurrentBook = concurrentDisk.find((item) => item.id === 'project-a')!;
  assert.ok(concurrentBook.textbook); assert.equal(concurrentBook.learningReviewRecords?.[0].id, 'save-time-review');
  assert.ok(concurrentBook.content.includes('<LearningReviewBlock id="save-time-review" />'));
  assert.ok(concurrentDisk.find((item) => item.id === 'project-b')!.content.includes('保存期间用户编辑另一笔记'));
  assert.equal(savedCount, 2); assert.equal(indexedCount, 1); assert.equal(pendingNotes, null);
  pass('生产发布适配器在落盘期间发现独立复盘/其它笔记编辑后重新合并保存，不回滚用户编辑');

  await reset(); const conflictEntered = deferred(); const releaseConflict = deferred();
  publicationSaveHook = async (_candidate, call) => { if (call === 1) { conflictEntered.resolve(); await releaseConflict.promise; } };
  const conflictingPublication = publish(publicationInput()); const conflictingObserved = assert.rejects(conflictingPublication, /目标项目已有教材或已修改/u);
  await conflictEntered.promise;
  notes = notes.map((item) => item.id === 'project-a' ? { ...saveFlowReviewRecord(item, reviewSession('conflict-review'), 'completed', true), content: `${item.content}\n用户修改目标规划。\n\n<LearningReviewBlock id="conflict-review" />` }
    : item.id === 'project-b' ? { ...item, content: `${item.content}\n同时编辑另一笔记。` } : item);
  const latestConflict = notes; releaseConflict.resolve(); await conflictingObserved;
  assert.strictEqual(notes, latestConflict); assert.strictEqual(pendingNotes, latestConflict); assert.equal(saveState, 'error'); assert.equal(indexedCount, 0);
  const correctedDisk = await readDisk(); assert.equal(correctedDisk.find((item) => item.id === 'project-a')!.textbook, undefined);
  assert.ok(correctedDisk.find((item) => item.id === 'project-a')!.content.includes('用户修改目标规划'));
  assert.equal(correctedDisk.find((item) => item.id === 'project-a')!.learningReviewRecords?.[0].id, 'conflict-review');
  assert.ok(correctedDisk.find((item) => item.id === 'project-b')!.content.includes('同时编辑另一笔记')); assert.equal(savedCount, 2);
  pass('目标规划在候选落盘期间冲突：不发布、不索引，以最新可见笔记补偿已写候选，保留复盘与其它编辑');

  await reset(); abortController = new AbortController(); mode = 'late-stop';
  publicationSaveHook = async (_candidate, call) => { if (call === 1) notes = notes.map((item) => item.id === 'project-b' ? { ...item, content: `${item.content}\n迟到停止前的独立编辑。` } : item); };
  await publish({ ...publicationInput(), signal: abortController.signal });
  assert.equal(abortController.signal.aborted, true); assert.ok(notes.find((item) => item.id === 'project-a')!.textbook);
  assert.ok((await readDisk()).find((item) => item.id === 'project-b')!.content.includes('迟到停止前的独立编辑')); assert.equal(savedCount, 2); assert.equal(indexedCount, 1);
  await reset(); const cancelledBeforeSave = new AbortController(); cancelledBeforeSave.abort();
  await assert.rejects(publish({ ...publicationInput(), signal: cancelledBeforeSave.signal }));
  assert.equal(publicationSaveCalls, 0); assert.equal(savedCount, 0); assert.equal(indexedCount, 0);
  pass('停止边界：保存前取消不落盘；首个候选已落盘后的迟到 Stop 不打断保全并发编辑的重存');

  await reset(); notes = recalculateBacklinks(notes); await saveVaultSnapshot(vault, stateDir, notes);
  const queueOrder: string[] = []; const queueEntered = deferred(); const releaseQueue = deferred();
  const queuedReview = (id: string) => enqueueLearningWrite(learningQueue, async () => {
    queueOrder.push(id); const target = notes.find((item) => item.id === 'project-a')!;
    // Same projection and optimistic review transaction used by App, under the shared production queue.
    notes = recalculateBacklinks(notes.map((item) => item === target ? saveFlowReviewRecord(target, reviewSession(id), 'completed', true) : item));
    await saveVaultSnapshot(vault, stateDir, notes);
  });
  publicationSaveHook = async () => { queueOrder.push('book'); queueEntered.resolve(); await releaseQueue.promise; };
  const beforeBookReview = queuedReview('review-before-book'); const queuedBook = publish(publicationInput()); await queueEntered.promise;
  const oldFlushSnapshot = notes; assert.equal(oldFlushSnapshot.find((item) => item.id === 'project-a')!.textbook, undefined);
  const completionTarget = getLearningCompletionTarget(notes, { noteId: 'project-a', taskId: 'due-project-a-0' }); assert.ok(completionTarget);
  const queuedCompletion = enqueueLearningWrite(learningQueue, () => commitLearningCompletion({ readNotes: () => notes,
    saveNotes: async (candidate) => { queueOrder.push('completion'); await saveVaultSnapshot(vault, stateDir, candidate); },
    applyNotes: (candidate) => { notes = candidate; },
  }, completionTarget, true));
  const afterBookReview = queuedReview('review-after-book');
  const oldQueuedFlush = enqueueLatestNotesSave(learningQueue, () => notes, async (latest) => { queueOrder.push('flush'); await saveVaultSnapshot(vault, stateDir, latest); });
  releaseQueue.resolve(); await Promise.all([beforeBookReview, queuedBook, queuedCompletion, afterBookReview, oldQueuedFlush]);
  assert.deepEqual(queueOrder, ['review-before-book', 'book', 'completion', 'review-after-book', 'flush']);
  const queuedDisk = (await readDisk()).find((item) => item.id === 'project-a')!;
  assert.ok(queuedDisk.textbook); assert.equal(queuedDisk.textbook.generationJobId, savedJob.id);
  assert.equal(queuedDisk.learningReviewRecords?.length, 2); assert.equal(queuedDisk.learningReviewRecords?.[1].textbookRevisionId, queuedDisk.textbook.revisionId);
  assert.equal(getLearningCompletionTarget(await readDisk(), completionTarget.binding)?.completed, true); assert.ok(queuedDisk.content.startsWith('- [x]'));
  assert.equal(indexedCount, 1); assert.equal(oldFlushSnapshot.find((item) => item.id === 'project-a')!.textbook, undefined);
  pass('生产共队列：前后复盘、教材发布、真实完成保存适配器按序合并；排队旧 flush 读取最新快照不擦除教材');

  const fence = (language: string, value: unknown) => '```' + language + '\n' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n```';
  const escapedJson = (value: unknown) => JSON.stringify(value)
    .replace(/[\u4e00-\u9fff]/gu, (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'))
    .replace(/\[([LCMRN]\d+)\]/gu, '\\u005b$1\\u005d');
  const chart = { title: '教学示意', type: 'bar', labels: ['条件'], series: [{ name: '模拟步骤', data: [1] }], simulated: true, sourceIds: [] };
  const displayAttacks = [
    fence('mermaid', 'flowchart LR\n A["#91;L999#93;"] --> B[检查条件]'),
    fence('chart', { ...chart, title: '[L999]' }),
    fence('chart', { ...chart, labels: ['[L999]'] }),
    fence('chart', { ...chart, series: [{ name: '[L999]', data: [1] }] }),
    fence('textbook-tip', escapedJson({ title: '[L999]', kind: 'tip', text: '需要核对情境条件而不是直接绝对化判断。' })),
    fence('textbook-answer', escapedJson({ title: '核对条件', text: '需要核对情境条件。[C1]' })),
    fence('textbook-image', escapedJson({ assetId: 'test-image', caption: '[L999]' })),
  ];
  for (const attack of displayAttacks) {
    const candidate = structuredClone(savedJob.checkpoint.chapters![0]); candidate.sections.practice += '\n\n' + attack;
    assert.throws(() => validateChapter(candidate, 'ch1', savedJob.checkpoint.blueprint!.chapters[0].sourceIds, ['test-image']), /来源|个人记录/u);
  }
  const codeOnlyCitation = structuredClone(savedJob.checkpoint.chapters![0]);
  codeOnlyCitation.sections.explanation = '这里没有正文事实来源，程序注释不能作为正文证据。\n\n```python\n# [N1]\n```';
  assert.throws(() => validateChapter(codeOnlyCitation, 'ch1', ['N1']), /缺少原文/u);
  const subroutine = structuredClone(savedJob.checkpoint.chapters![0]);
  subroutine.sections.practice += '\n\n' + fence('mermaid', 'flowchart LR\n A[[预处理]] --> B[结果]');
  validateChapter(subroutine, 'ch1', savedJob.checkpoint.blueprint!.chapters[0].sourceIds);
  codeOnlyCitation.sections.explanation = '这里没有正文事实来源，隐藏注释不能作为正文证据。\n\n' + fence('mermaid', 'flowchart LR\n %% [N1]\n A[条件] --> B[结果]');
  assert.throws(() => validateChapter(codeOnlyCitation, 'ch1', ['N1']), /缺少原文/u);
  pass('受控块的标题/图示/图表标签/图片说明经解码后同样检查来源；私人编号不冒充事实，普通代码不满足正文引用');

  const leak = context.personal[0].text;
  const privacyBlocks = [
    fence('mermaid', 'flowchart LR\n A["' + [...leak].map((character) => '#' + character.codePointAt(0) + ';').join('') + '"]'),
    fence('chart', escapedJson({ ...chart, title: leak })),
    fence('chart', escapedJson({ ...chart, labels: [leak] })),
    fence('chart', escapedJson({ ...chart, series: [{ name: leak, data: [1] }] })),
    fence('textbook-tip', escapedJson({ title: leak, kind: 'tip', text: '需要先核对条件，再判断能否应用该概念。' })),
    fence('textbook-answer', escapedJson({ title: '核对条件', text: leak })),
    fence('textbook-image', escapedJson({ assetId: 'test-image', caption: leak })),
  ];
  for (const block of privacyBlocks) {
    const candidate = structuredClone(savedJob); const source = candidate.checkpoint.sources!.find((item) => item.kind === 'document')!;
    assert.ok(source.blockId);
    source.assets = [{ id: 'test-image', sourceId: source.sourceId, docId: source.id, version: source.version, blockId: source.blockId, imageIndex: 0, alt: '测试原图' }];
    candidate.checkpoint.chapters![0].sections.practice += '\n\n' + block;
    const candidateBody = assembleTextbook(candidate.checkpoint.blueprint!, candidate.checkpoint.chapters!, candidate.checkpoint.sources!);
    assert.ok(!candidateBody.includes(leak));
    assert.throws(() => validateTextbookJob(candidate, candidateBody), /个人原话/u);
  }
  pass('即使模型用 JSON Unicode 转义或 Mermaid 标签实体隐藏私人原话，展示文本仍在发布前拒绝');

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRscAAAAASUVORK5CYII=';
  await writeFile(path.join(temp, 'documents', 'doc-choice.md'), original + '\n\n![合成本地测试图](' + png + ')');
  await reset(); const multi = await prepared(); mode = 'multiformat'; await generateTextbook(ctx, multi.jobId, undefined, deps);
  const multiNote = (await readDisk()).find((item) => item.id === 'project-a')!;
  const multiBody = readTextbookBody(multiNote.content, multiNote.textbook!)!;
  const formats = new Set<string>(); let footnotes = 0, math = 0;
  const walk = (node: any) => { if (node.type === 'code') formats.add(node.lang); if (node.type === 'footnoteDefinition') footnotes++; if (node.type === 'math') math++; node.children?.forEach(walk); };
  walk(parseTextbookMarkdown(multiBody));
  for (const language of ['mermaid', 'chart', 'textbook-image', 'textbook-tip', 'textbook-answer', 'python']) assert.ok(formats.has(language));
  assert.equal(footnotes, 2); assert.equal(math, 2); assert.ok(multiNote.textbook!.assets!.length > 0);
  for (const asset of multiNote.textbook!.assets!) {
    assert.match(asset.attachmentHash!, /^[a-f0-9]{64}$/);
    const image = await readMaterialImage({ allowedDocIds: [asset.docId], ...asset });
    assert.equal(image.dataUrl, png);
  }
  assert.equal(savedCount, 1); assert.equal(indexedCount, 1); assert.ok(!multiBody.includes(png));
  assert.equal((await command({ op: 'get', jobId: multi.jobId })).job.stage, 'published');
  assert.ok(stripTextbookRegion(multiNote.content, multiNote.textbook!).outside.includes('原有手工备注'));
  pass('真实目录/原文图片采集→模拟模型多格式章节→共享格式门控→生产发布→实际磁盘重载，公式/脚注/五类受控块及素材指针保留');

  await reset(); const visualBook = await prepared(); mode = 'default-visuals';
  await generateTextbook(ctx, visualBook.jobId, undefined, deps);
  const visualNote = (await readDisk()).find((item) => item.id === 'project-a')!;
  const visualBody = readTextbookBody(visualNote.content, visualNote.textbook!)!;
  const visualCodes = parseTextbookMarkdown(visualBody).children.filter((node): node is Code => node.type === 'code' && node.lang === 'mermaid');
  assert.equal(visualCodes.length, 2); assert.ok(visualCodes.some((node) => node.value.startsWith('mindmap')));
  assert.ok(visualCodes.some((node) => node.value.startsWith('flowchart')));
  assert.equal((visualBody.match(/观察问题/gu) || []).length, 3);
  assert.equal((visualBody.match(/读图要点/gu) || []).length, 3);
  assert.ok(visualBody.includes('| 假设案例 | 偏好信息 | 比较复杂度 |'));
  assert.equal(modelCalls, 5, 'Visual planning reuses existing selection/blueprint/two chapters/review requests');
  const visualSaved = (await command({ op: 'get', jobId: visualBook.jobId })).job;
  assert.equal(visualSaved.stage, 'published'); assert.equal(savedCount, 1);
  validateTextbookJob(visualSaved, visualBody);
  assert.ok(stripTextbookRegion(visualNote.content, visualNote.textbook!).outside.includes('原有手工备注'));
  pass('默认可视化引导经生产逐章流程→导图/操作流程/案例表及读图教学→发布与磁盘重载；模型调用仍为五次，不覆盖项目原备注');

  const beforeTimelineSource = await readFile(path.join(temp, 'documents', 'doc-choice.md'), 'utf8');
  await writeFile(path.join(temp, 'documents', 'doc-choice.md'), beforeTimelineSource + '\n\n合成阶段示例，非历史事实：起始阶段确定问题并明确观察对象；探索阶段对照已有材料；形成阶段组织概念关系；验证阶段核对证据与边界；迁移阶段解释新情境。');
  await reset(); const timelineJob = await prepared();
  assert.equal((await command({ op: 'get', jobId: timelineJob.jobId })).job.spec.visualCapabilitiesVersion, 3);
  await freshlyApprovedGenerate(timelineJob.jobId, undefined, { ...deps, model: async request => {
    const response = await fixtureModel(request), input = fixtureInput(request);
    if (request.workflow === 'textbook-blueprint' && !input.catalogs) {
      assert.ok(request.systemPromptOverride!.includes(compactTextbookCapabilities(3)) || request.systemPromptOverride!.includes(TEXTBOOK_PROGRESSIVE_CAPABILITIES));
      const blueprint = JSON.parse(response.content);
      blueprint.chapters[0].visuals = [{ format: 'timeline', section: 'explanation', purpose: '按合成资料梳理五个阶段先后', readingQuestion: '各阶段如何依次推进？' }];
      response.content = JSON.stringify(blueprint);
      response.parsedJson = blueprint;
    } else if (request.workflow === 'textbook-chapter' && input.chapter.id === 'ch1') {
      assert.ok(request.systemPromptOverride!.includes(compactTextbookFormatSyntax(['timeline'], 3)));
      assert.equal(input.visualizationGuidance.targets[0].format, 'timeline');
      const chapter = JSON.parse(response.content);
      chapter.sections.explanation += '\n\n观察问题：这些合成阶段如何依次推进？\n\n' + visualFence('mermaid', visualTimeline)
        + '\n\n读图要点：这是资料中的合成顺序，非历史事实、等比例时间或因果。[L1]';
      response.content = JSON.stringify(chapter);
      response.parsedJson = chapter;
    }
    return response;
  } });
  store = new TextbookStore(stateDir);
  const timelineSaved = (await command({ op: 'get', jobId: timelineJob.jobId })).job;
  const timelineNote = (await readDisk()).find(item => item.id === 'project-a')!;
  const timelineBody = readTextbookBody(timelineNote.content, timelineNote.textbook!)!;
  assert.equal(timelineSaved.stage, 'published'); assert.equal(modelCalls, 5); assert.equal(savedCount, 1);
  assert.equal(timelineSaved.checkpoint.blueprint!.chapters[0].visuals![0].format, 'timeline');
  await assert.rejects(command({ op: 'create', spec: { ...timelineSaved.spec, visualCapabilitiesVersion: 4 as never } }), /可视化能力版本/u);
  assert.ok(timelineBody.includes(visualFence('mermaid', visualTimeline))); validateTextbookJob(timelineSaved, timelineBody);
  assert.ok(!timelineBody.includes('PRIVATE_COGNITION'));
  await writeFile(path.join(temp, 'documents', 'doc-choice.md'), beforeTimelineSource);
  pass('时间轴经已确认生产链路：已读合成物料→蓝图选型→章节七键→质量门控→发布与磁盘重开，仍仅五次模型调用');

  for (const interrupt of [false, true]) {
    await reset();
    await writeFile(path.join(temp, 'documents', 'doc-choice.md'), `${original}\n\n合成绘图练习：只用教学假设 f(x)=x^2 解释变量与曲线，x取0到3，y为平方值；不代表心理效应的实测规律。`);
    try {
      const mixed = await prepared(); const requests: LlmCallRequest[] = [];
      const mixedDeps = { ...deps, model: async (request: LlmCallRequest) => {
        requests.push(structuredClone(request));
        const input = fixtureInput(request);
        if (request.workflow === 'textbook-chapter') {
          const saved = (await command({ op: 'get', jobId: mixed.jobId })).job;
          assert.deepEqual(saved.checkpoint.blueprint!.teachingTypes, ['concept', 'mathematics']);
          const math = input.chapter.id === 'ch2';
          assert.equal(request.systemPromptOverride!.includes('专用讲授【数学与数量关系】'), math);
          assert.equal(request.systemPromptOverride!.includes('专用讲授【概念与效应】'), !math);
          for (const unrelated of ['历史与演变', '物理与化学', '操作与实践']) assert.ok(!request.systemPromptOverride!.includes(`专用讲授【${unrelated}】`));
          assert.equal(request.systemPromptOverride!.includes('function-plot围栏'), math);
          assert.equal(request.systemPromptOverride!.includes('Mermaid使用mermaid围栏'), !math);
        }
        const response = await fixtureModel(request);
        if (request.workflow === 'textbook-blueprint' && !input.catalogs) {
          assert.ok(request.systemPromptOverride!.includes(TEXTBOOK_PROGRESSIVE_CAPABILITIES));
          assert.ok(!request.systemPromptOverride!.includes('专用讲授【'));
          const book = JSON.parse(response.content);
          book.teachingTypes = ['concept', 'mathematics'];
          book.chapters[0].teachingTypes = ['concept']; book.chapters[1].teachingTypes = ['mathematics'];
          book.chapters[0].visuals = [{ format: 'flowchart', section: 'explanation', purpose: '列出判断条件', readingQuestion: '还需要核对什么？' }];
          book.chapters[1].visuals = [{ format: 'function-plot', section: 'explanation', purpose: '观察已知平方函数', readingQuestion: 'x增大时y如何变化？' }];
          response.content = JSON.stringify(book); response.parsedJson = book;
        } else if (request.workflow === 'textbook-chapter') {
          const chapter = JSON.parse(response.content);
          chapter.sections.explanation += input.chapter.id === 'ch1'
            ? '\n\n```mermaid\nflowchart LR\nV1["明确条件"] --> V2["解释判断"]\n```\n\n请沿路径说出需要核对的条件。[N1]'
            : '\n\n教学假设只用于说明变量，不作为心理效应的实测曲线。观察平方函数怎样变化。[L1]\n\n$$f(x)=x^2$$\n\n```function-plot\n'
              + JSON.stringify({ title: '平方函数教学示意', variable: 'x', xDomain: [0, 3], yDomain: [0, 9], curves: [{ id: 'f', expression: 'x^2' }] })
              + '\n```\n\n横轴是x，纵轴是平方值，图只展示给定关系。[L1]';
          response.content = JSON.stringify(chapter); response.parsedJson = chapter;
        }
        return response;
      } };
      if (interrupt) {
        mode = 'cancel'; abortController = new AbortController();
        await assert.rejects(generateTextbook(ctx, mixed.jobId, abortController.signal, mixedDeps));
        const before = (await command({ op: 'get', jobId: mixed.jobId })).job;
        assert.equal(before.checkpoint.chapters!.length, 1); assert.equal(savedCount, 0);
        store = new TextbookStore(stateDir); mode = 'normal'; const start = requests.length;
        await freshlyApprovedGenerate(mixed.jobId, undefined, mixedDeps);
        assert.deepEqual(requests.slice(start).map(request => request.workflow), ['textbook-chapter', 'textbook-quality']);
        const resumedChapter = requests.slice(start)[0]; const originalChapter = requests.find(request => request.workflow === 'textbook-chapter' && fixtureInput(request).chapter.id === 'ch2')!;
        assert.equal(resumedChapter.systemPromptOverride, originalChapter.systemPromptOverride);
        const after = (await command({ op: 'get', jobId: mixed.jobId })).job;
        assert.deepEqual(after.checkpoint.chapters![0], before.checkpoint.chapters![0]);
        assert.deepEqual(after.checkpoint.blueprint, before.checkpoint.blueprint);
      } else {
        await generateTextbook(ctx, mixed.jobId, undefined, mixedDeps);
        assert.equal(modelCalls, 5); assert.equal(requests.length, 5);
      }
      const saved = (await command({ op: 'get', jobId: mixed.jobId })).job;
      assert.equal(saved.stage, 'published'); assert.equal(savedCount, 1);
      assert.ok(saved.checkpoint.body!.includes('```function-plot') && saved.checkpoint.body!.includes('```mermaid'));
      assert.ok(!saved.checkpoint.body!.includes('专用讲授') && !saved.checkpoint.body!.includes('teachingTypes'));
      pass(interrupt ? '混合教材中断→私有Store重开：原蓝图/首章不变，只加载剩余数学章专用提示并复核，提示逐字稳定'
        : '真实渐进披露生成：蓝图识别概念+数学→落盘→按章加载专用讲法/绘图语法→校验/发布；仍五次请求');
    } finally { await writeFile(path.join(temp, 'documents', 'doc-choice.md'), original); }
  }

  const budgetPolicy = defaultTextbookModelPolicy(); validateTextbookModelPolicy(budgetPolicy);
  assert.equal(budgetPolicy.version, 4);
  assert.equal(budgetPolicy.stages.blueprint.thinkingMode, 'enabled');
  assert.equal(budgetPolicy.stages.chapter.thinkingMode, 'disabled');
  assert.deepEqual(budgetPolicy.complexChapterThinking, { maxChapters: 2 });
  assert.equal(budgetPolicy.stages.selection.thinkingMode, 'disabled'); assert.equal(budgetPolicy.stages.quality.thinkingMode, 'disabled');
  assert.throws(() => validateTextbookModelPolicy({ ...budgetPolicy, complexChapterThinking: { maxChapters: 3 } }));
  assert.throws(() => validateTextbookModelPolicy({ ...budgetPolicy, complexChapterThinking: undefined }));
  const changedPolicy = defaultTextbookModelPolicy(); changedPolicy.stages.chapter.maxTokens = 300;
  assert.equal(defaultTextbookModelPolicy().stages.chapter.maxTokens, 12000);
  assert.throws(() => validateTextbookModelPolicy({ ...budgetPolicy, maxTruncationRetries: 2 }));
  assert.throws(() => validateTextbookModelPolicy({ ...budgetPolicy, stages: { ...budgetPolicy.stages,
    chapter: { ...budgetPolicy.stages.chapter, retryMaxTokens: 24001 } } }));
  for (const reason of ['length', 'max_tokens', 'MAX_TOKENS']) assert.equal(textbookResponseTruncated(reason), true);
  for (const reason of ['stop', 'content_filter', 'tool_calls', undefined]) assert.equal(textbookResponseTruncated(reason), false);
  pass('教材专用预算不可通过克隆修改默认值；上限、次数与跨供应商截断信号严格校验');

  await writeFile(path.join(temp, 'documents', 'doc-choice.md'), original);
  const modelStage = (request: LlmCallRequest): TextbookModelStage => fixtureInput(request).catalogs ? 'selection'
    : request.workflow === 'textbook-blueprint' ? 'blueprint' : request.workflow === 'textbook-chapter' ? 'chapter' : 'quality';
  for (const target of ['selection', 'blueprint', 'chapter', 'quality'] as TextbookModelStage[]) {
    await reset(); const retry = await prepared(); const seen: LlmCallRequest[] = []; let truncated = false;
    assert.deepEqual((await command({ op: 'get', jobId: retry.jobId })).job.spec.modelPolicy, budgetPolicy);
    assert.ok(textbookConfirmation(retry.jobId).impacts.some((impact) => impact.includes('12000/24000')));
    const retryDeps = { ...deps, model: async (request: LlmCallRequest) => {
      seen.push(structuredClone(request)); const response = await fixtureModel(request);
      assert.equal(request.thinkingMode, budgetPolicy.stages[modelStage(request)].thinkingMode);
      if (modelStage(request) === target && !truncated) {
        truncated = true; return { content: '{"partial":', diagnostics: { finishReason: 'MAX_TOKENS' } };
      }
      return response;
    } };
    await generateTextbook(ctx, retry.jobId, undefined, retryDeps);
    const first = seen.findIndex((request) => modelStage(request) === target);
    assert.equal(seen[first].maxTokensOverride, budgetPolicy.stages[target].maxTokens);
    assert.equal(seen[first + 1].maxTokensOverride, budgetPolicy.stages[target].retryMaxTokens);
    assert.equal(seen[first + 1].userInput, seen[first].userInput);
    assert.equal(seen[first + 1].systemPromptOverride, seen[first].systemPromptOverride);
    assert.equal(seen.length, 6); assert.equal(savedCount, 1);
  }
  pass('四阶段各自使用确认快照预算；明确截断只重发同一完整输入一次，不拼接部分 JSON，成功才落盘');

  for (const failure of ['truncated', 'invalid-json', 'http'] as const) {
    await reset(); const stopped = await prepared(); let attempts = 0;
    const failureDeps = { ...deps, model: async (request: LlmCallRequest) => {
      if (modelStage(request) !== 'blueprint') return fixtureModel(request);
      attempts++;
      if (failure === 'http') throw new Error('fixture HTTP failure');
      return { content: '{"partial":', diagnostics: { finishReason: failure === 'truncated' ? 'length' : 'stop' } };
    } };
    await assert.rejects(generateTextbook(ctx, stopped.jobId, undefined, failureDeps));
    assert.equal(attempts, failure === 'truncated' ? 2 : 1);
    assert.equal(savedCount, 0); assert.equal(notes.find((item) => item.id === 'project-a')!.textbook, undefined);
    const failed = (await command({ op: 'get', jobId: stopped.jobId })).job;
    assert.equal(failed.stage, 'failed'); assert.equal(failed.checkpoint.blueprint, undefined);
    assert.ok(failed.checkpoint.sources?.length);
  }
  pass('重复截断达到上限后安全失败；JSON 格式和 HTTP 错误不扩大请求，保留来源草稿且不发布');

  for (const promptVersion of [undefined, 2, 3, 4, 5, 6, 7, 8] as const) for (const target of ['blueprint', 'chapter'] as const) {
    await reset(); const stopped = await prepared(); const calls: LlmCallRequest[] = [];
    if (promptVersion !== TEXTBOOK_PROMPT_VERSION) {
      const stored = (await command({ op: 'get', jobId: stopped.jobId })).job;
      if (promptVersion === undefined) { delete stored.spec.visualCapabilitiesVersion; delete stored.spec.promptVersion; }
      else stored.spec.promptVersion = promptVersion;
      await atomicWriteTextFile(path.join(stateDir, 'textbook-jobs', stopped.jobId + '.json'), JSON.stringify(stored));
    }
    await assert.rejects(generateTextbook(ctx, stopped.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
      calls.push(request);
      if (modelStage(request) === target && (target === 'blueprint' || fixtureInput(request).chapter.id === 'ch2')) {
        return { content: '{"DO_NOT_PERSIST_PARTIAL":', diagnostics: { finishReason: 'length', reasoningTokens: 15000, hadReasoningContent: true },
          usage: { promptTokens: 6000, completionTokens: request.maxTokensOverride! } };
      }
      return fixtureModel(request);
    } }), /同一输入已达到重试上限/u);
    const before = (await command({ op: 'get', jobId: stopped.jobId })).job;
    assert.equal(calls.filter((request) => modelStage(request) === target && (target === 'blueprint' || fixtureInput(request).chapter.id === 'ch2')).length, 2);
    if (target === 'chapter') { assert.equal(before.checkpoint.chapters!.length, 1); assert.ok(before.checkpoint.blueprint); }
    assert.ok(!JSON.stringify(before).includes('DO_NOT_PERSIST_PARTIAL'));
    store = new TextbookStore(stateDir);
    const summary = (await store.list('project-a')).find((item) => item.jobId === stopped.jobId)!;
    assert.equal(summary.progress!.requiresReprepare, true); assert.equal(summary.progress!.modelDiagnostics!.reasoningTokens, 15000);
    assert.equal(summary.progress!.modelDiagnostics!.completionTokens, budgetPolicy.stages[target].retryMaxTokens);
    assert.ok(!JSON.stringify(summary).includes('inputHash')); assert.ok(!JSON.stringify(summary).includes('PRIVATE_COGNITION'));
    assert.equal((await prepared()).jobId, stopped.jobId);
    assert.deepEqual((await command({ op: 'get', jobId: stopped.jobId })).job.spec, before.spec, '升级准备不替换旧能力标记或原批准范围');
    const resumed: LlmCallRequest[] = [];
    await assert.rejects(freshlyApprovedGenerate(stopped.jobId, undefined, { ...deps,
      context: async () => ({ ...structuredClone(context), warnings: ['随时间变化的检索提醒，不应重置截断额度'] }),
      model: async (request: LlmCallRequest) => { resumed.push(request); return fixtureModel(request); } }), /同一输入已达到重试上限/u);
    assert.equal(resumed.length, 0); assert.equal(savedCount, 0);
    const after = (await command({ op: 'get', jobId: stopped.jobId })).job;
    assert.deepEqual(after.checkpoint.blueprint, before.checkpoint.blueprint); assert.deepEqual(after.checkpoint.chapters, before.checkpoint.chapters);
  }
  pass('蓝图与章节连续截断的额度跨重启持久化；再次批准零模型请求，不清空合格章节，诊断只含数字不含部分输出/思维链');

  for (const promptVersion of [2, 3, 4] as const) for (const exhausted of [false, true]) {
    await reset(); const interrupted = await prepared();
    const initial = (await command({ op: 'get', jobId: interrupted.jobId })).job;
    initial.spec.promptVersion = promptVersion;
    await atomicWriteTextFile(path.join(stateDir, 'textbook-jobs', interrupted.jobId + '.json'), JSON.stringify(initial));
    let captured!: LlmCallRequest; let chapterCalls = 0;
    await assert.rejects(generateTextbook(ctx, interrupted.jobId, undefined, { ...deps, model: async request => {
      const input = fixtureInput(request);
      if (request.workflow === 'textbook-chapter' && input.chapter.id === 'ch2') {
        captured = structuredClone(request); chapterCalls++;
        if (!exhausted && chapterCalls === 2) throw Error('synthetic network interruption');
        return { content: '{"partial":', diagnostics: { finishReason: 'length' } };
      }
      const response = await fixtureModel(request);
      if (request.workflow === 'textbook-blueprint' && !input.catalogs) {
        const blueprint = JSON.parse(response.content);
        blueprint.chapters[1].visuals = [{ format: 'flowchart', section: 'explanation', purpose: '展示判断步骤', readingQuestion: '如何判断条件？' }];
        response.content = JSON.stringify(blueprint); response.parsedJson = blueprint;
      }
      return response;
    } }));
    const before = (await command({ op: 'get', jobId: interrupted.jobId })).job;
    const row = before.checkpoint.modelAttempts!.find(item => item.stage === 'chapter' && item.chapterId === 'ch2')!;
    const value = JSON.parse(captured.userInput);
    if (value.context) value.context = { ...value.context, warnings: [], mastery: value.context.mastery?.rows?.map((r: any) => ({ noteId: r.noteId, title: r.title, mastery: r.mastery, reviewCount: r.reviewCount })) };
    const budget = textbookRequestBudget(before.spec.modelPolicy, 'chapter', before.checkpoint.blueprint, 'ch2');
    const identity = { workflow: captured.workflow, prompt: captured.systemPromptOverride!, input: value, budget, providerHash: before.spec.providerHash };
    assert.equal(await textbookHash(identity), row.inputHash, 'fixture reproduces the exact production fingerprint');
    const marker = '时序图须有真实角色顺序。禁止配置、样式、图标、HTML、链接、点击动作；';
    assert.ok(identity.prompt.includes(marker));
    const canonicalHash = row.inputHash;
    row.inputHash = await textbookHash({ ...identity, prompt: identity.prompt.replace(marker, `时序图须有真实角色顺序。${TEXTBOOK_MERMAID_LINE_BREAK_GUIDANCE}禁止配置、样式、图标、HTML、链接、点击动作；`) });
    if (exhausted) before.checkpoint.modelAttempts!.push({ ...row, inputHash: canonicalHash, exhausted: false, truncations: 0 });
    await atomicWriteTextFile(path.join(stateDir, 'textbook-jobs', interrupted.jobId + '.json'), JSON.stringify(before));
    store = new TextbookStore(stateDir); const resumed: LlmCallRequest[] = [];
    if (exhausted) {
      await assert.rejects(freshlyApprovedGenerate(interrupted.jobId, undefined, { ...deps, model: async request => { resumed.push(request); return fixtureModel(request); } }), /同一输入已达到重试上限/u);
      assert.equal(resumed.length, 0);
    } else {
      await freshlyApprovedGenerate(interrupted.jobId, undefined, { ...deps, model: async request => { resumed.push(request); return fixtureModel(request); } });
      assert.equal(resumed[0].maxTokensOverride, budget.retryMaxTokens);
      assert.equal(fixtureInput(resumed[0]).chapter.id, 'ch2');
      assert.ok(!resumed.some(request => request.workflow === 'textbook-blueprint'));
    }
    const after = (await command({ op: 'get', jobId: interrupted.jobId })).job;
    assert.deepEqual(after.checkpoint.chapters![0], before.checkpoint.chapters![0]);
    assert.deepEqual(after.checkpoint.blueprint, before.checkpoint.blueprint);
  }
  pass('v2–v4 含误加换行提示的真实检查点跨重启精确迁移：耗尽不重试、截断仅续上限，已存章节与蓝图不变');

  for (const target of ['blueprint', 'chapter'] as const) {
    await reset(); const retry = await prepared(); const seen: LlmCallRequest[] = []; let count = 0;
    await assert.rejects(generateTextbook(ctx, retry.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
      if (modelStage(request) === target && (target === 'blueprint' || fixtureInput(request).chapter.id === 'ch2')) {
        seen.push(request); count++;
        if (count === 1) return { content: '{"partial":', diagnostics: { finishReason: 'length' } };
        throw new Error('fixture upper-budget network failure');
      }
      return fixtureModel(request);
    } }), /network failure/u);
    assert.deepEqual(seen.map((request) => request.maxTokensOverride), [budgetPolicy.stages[target].maxTokens, budgetPolicy.stages[target].retryMaxTokens]);
    store = new TextbookStore(stateDir); const resumed: LlmCallRequest[] = [];
    await freshlyApprovedGenerate(retry.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => { resumed.push(request); return fixtureModel(request); } });
    assert.equal(modelStage(resumed[0]), target); assert.equal(resumed[0].maxTokensOverride, budgetPolicy.stages[target].retryMaxTokens);
    assert.equal(resumed[0].userInput, seen[0].userInput); assert.equal(savedCount, 1);
    assert.equal(resumed.filter((request) => modelStage(request) === target).length, 1);
  }
  pass('蓝图/单章初始截断后重试遇网络故障，恢复直接用批准的上限请求，不再花初始额度或重做合格章节');

  for (const version of [1, 2, 3] as const) {
  await reset(); const legacyPolicy = defaultTextbookModelPolicy(version);
  validateTextbookModelPolicy(legacyPolicy); const legacyJob = await prepared();
  const legacyStored = (await command({ op: 'get', jobId: legacyJob.jobId })).job;
  legacyStored.spec.modelPolicy = legacyPolicy; legacyStored.spec.providerHash = await textbookProviderSnapshot(false, legacyPolicy);
  delete legacyStored.spec.visualCapabilitiesVersion;
  delete legacyStored.spec.promptVersion;
  delete legacyStored.spec.webSupplement; // Real legacy approvals did not include public-topic discovery.
  await atomicWriteTextFile(path.join(stateDir, 'textbook-jobs', legacyJob.jobId + '.json'), JSON.stringify(legacyStored));
  const legacyRequests: LlmCallRequest[] = [];
  await freshlyApprovedGenerate(legacyJob.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
    legacyRequests.push(request);
    if (modelStage(request) === 'blueprint') assert.equal(request.systemPromptOverride, TEXTBOOK_BLUEPRINT_PROMPT);
    return fixtureModel(request);
  } });
  for (const request of legacyRequests) assert.equal(request.thinkingMode, legacyPolicy.stages[modelStage(request)].thinkingMode);
  assert.equal((await command({ op: 'get', jobId: legacyJob.jobId })).job.spec.modelPolicy!.version, version);
  assert.notEqual(await textbookProviderSnapshot(false, legacyPolicy), await textbookProviderSnapshot(false));
  }
  pass('旧版 v1/v2/v3 已批准策略、服务商哈希及蓝图提示词兼容恢复，不静默开关思考；新任务确认 v4 分阶段策略');

  for (const complexIpc of [false, true]) {
  await reset();
  storage.set('loginote_llm_settings', JSON.stringify({ ...llmSettings, providers: [{ ...llmSettings.providers[0], apiType: 'openai-compatible', baseUrl: 'https://api.deepseek.com', selectedModel: 'deepseek-flash' }] }));
  const hybridThinking = await prepareTextbook(ctx, { allowedDocIds: ['doc-choice'], allowCloud: true }, deps) as { jobId: string }; const ipcRequests: any[] = [];
  bridge.llm = { request: async (input: any) => {
    const blueprint = input.systemPrompt.includes('证据驱动的教学设计师') && !input.userInput.includes('"catalogs"');
    const chapter = input.systemPrompt.includes('当前一章') ? JSON.parse(input.userInput).chapter.id : undefined;
    ipcRequests.push(input); assert.equal(input.thinkingMode, blueprint || (complexIpc && chapter === 'ch2') ? 'enabled' : 'disabled');
    if (blueprint) assert.ok(input.systemPrompt.includes(TEXTBOOK_COMPACT_THINKING_PROMPT));
    const result = await fixtureModel({ workflow: input.userInput.includes('"catalogs"') ? 'textbook-blueprint' : input.systemPrompt.includes('当前一章') ? 'textbook-chapter' : input.systemPrompt.includes('只读质量复核员') ? 'textbook-quality' : 'textbook-blueprint',
      userInput: input.userInput, systemPromptOverride: input.systemPrompt,
      maxTokensOverride: input.maxTokens, tokenBudgetMode: input.tokenBudgetMode, thinkingPreference: input.thinkingPreference,
      skipMemoryInjection: true, skipProfileInjection: true } as LlmCallRequest);
    if (blueprint && complexIpc) result.parsedJson.chapters[1].reasoning = 'derivation';
    return result;
  } };
  await generateTextbook(ctx, hybridThinking.jobId, undefined, { ...deps, model: (request, signal, providerSnapshot) => callLLM(request, { signal, providerSnapshot }) });
  assert.equal(ipcRequests.length, 5); assert.equal(savedCount, 1);
  assert.ok(ipcRequests.some((input) => input.maxTokens === 8000)); assert.ok(ipcRequests.some((input) => input.maxTokens === 12000));
  delete bridge.llm; storage.set('loginote_llm_settings', JSON.stringify(llmSettings));
  }
  pass('v4 经生产 callLLM→DeepSeek IPC：蓝图及明确复杂章启用，普通章节/选材/质检关闭，保持原额度与七节校验，无真实网络');

  await reset(); const selective = await prepared(); const selectiveCalls: LlmCallRequest[] = []; let complexAttempt = 0;
  const selectiveModel = async (request: LlmCallRequest) => {
    selectiveCalls.push(structuredClone(request));
    const input = fixtureInput(request);
    if (request.workflow === 'textbook-chapter') {
      assert.equal(request.thinkingMode, ['ch2', 'ch3'].includes(input.chapter.id) ? 'enabled' : 'disabled');
      if (input.chapter.id === 'ch3' && complexAttempt++ < 2) {
        if (complexAttempt === 1) return { content: '{"partial":', diagnostics: { finishReason: 'length' } };
        throw new Error('complex upper-budget interruption');
      }
    }
    const response = await fixtureModel(request);
    if (modelStage(request) === 'blueprint') {
      assert.ok(request.systemPromptOverride!.includes(TEXTBOOK_COMPACT_THINKING_PROMPT));
      const template = response.parsedJson.chapters[0];
      response.parsedJson.chapters = ['standard', 'derivation', 'algorithm', 'causal_comparison', 'not-a-valid-mode']
        .map((reasoning, index) => ({ ...structuredClone(template), id: `ch${index + 1}`, title: `测试章节${index + 1}`, reasoning }));
    }
    return response;
  };
  await assert.rejects(generateTextbook(ctx, selective.jobId, undefined, { ...deps, model: selectiveModel }), /complex upper-budget interruption/u);
  const selectiveBefore = (await command({ op: 'get', jobId: selective.jobId })).job;
  assert.equal(selectiveBefore.checkpoint.chapters!.length, 2);
  assert.equal(selectiveBefore.checkpoint.progress!.requestThinkingResolved, true);
  assert.equal(selectiveBefore.checkpoint.progress!.requestThinkingMode, undefined,
    'The synthetic Ollama transport has no mapped thinking control; progress must not claim an enabled API parameter merely from policy intent');
  assert.deepEqual(selectiveCalls.filter(request => request.workflow === 'textbook-chapter' && fixtureInput(request).chapter.id === 'ch3')
    .map(request => [request.thinkingMode, request.maxTokensOverride]), [['enabled', 12000], ['enabled', 24000]]);
  assert.equal(selectiveBefore.checkpoint.blueprint!.chapters[4].reasoning, undefined);
  const shifted = structuredClone(selectiveBefore);
  shifted.checkpoint.blueprint!.chapters[0].reasoning = 'derivation';
  const unchangedThird = selectiveBefore.checkpoint.blueprint!.chapters[2];
  assert.notEqual(chapterInputIdentity(selectiveBefore, unchangedThird), chapterInputIdentity(shifted, unchangedThird));
  assert.ok(textbookConfirmation(selective.jobId).impacts.some(impact => impact.includes('最多 2 章启用')));
  for (const version of [2, 3] as const) assert.equal(textbookRequestBudget(defaultTextbookModelPolicy(version), 'chapter', selectiveBefore.checkpoint.blueprint, 'ch2').thinkingMode, 'disabled');
  const resumedSelective: LlmCallRequest[] = [];
  store = new TextbookStore(stateDir);
  await freshlyApprovedGenerate(selective.jobId, undefined, { ...deps, model: async request => {
    resumedSelective.push(structuredClone(request)); return selectiveModel(request);
  } });
  const selectiveAfter = (await command({ op: 'get', jobId: selective.jobId })).job;
  assert.deepEqual(resumedSelective.filter(request => request.workflow === 'textbook-chapter').map(request => [fixtureInput(request).chapter.id, request.thinkingMode]),
    [['ch3', 'enabled'], ['ch4', 'disabled'], ['ch5', 'disabled']]);
  assert.equal(resumedSelective[0].maxTokensOverride, 24000);
  assert.deepEqual(selectiveAfter.checkpoint.chapters!.slice(0, 2), selectiveBefore.checkpoint.chapters);
  assert.equal(selectiveAfter.stage, 'published'); assert.equal(savedCount, 1);
  assert.equal(selectiveAfter.spec.modelPolicy!.version, 4); assert.equal(selectiveAfter.spec.modelPolicy!.stages.chapter.maxTokens, 12000);
  pass('复杂章节仅蓝图前两项启用；未知标记安全关闭，旧策略忽略新标记；截断重试与重启恢复维持同一思考/额度，普通章节不受影响');

  for (const stop of ['cancel', 'source', 'policy', 'provider'] as const) {
    await writeFile(path.join(temp, 'documents', 'doc-choice.md'), original); await reset();
    const stopped = await prepared(); const controller = new AbortController(); let attempts = 0;
    const boundaryDeps = { ...deps, model: async (request: LlmCallRequest) => {
      if (modelStage(request) !== 'blueprint') return fixtureModel(request);
      attempts++;
      if (stop === 'cancel') controller.abort();
      else if (stop === 'source') await writeFile(path.join(temp, 'documents', 'doc-choice.md'), '# 替换资料\n\n不同的资料内容。');
      else if (stop === 'provider') storage.set('loginote_llm_settings', JSON.stringify({ ...llmSettings,
        providers: [{ ...llmSettings.providers[0], selectedModel: 'unapproved-model' }] }));
      else {
        const stored = (await command({ op: 'get', jobId: stopped.jobId })).job;
        stored.spec.modelPolicy!.stages.blueprint.maxTokens = 7000;
        await atomicWriteTextFile(path.join(stateDir, 'textbook-jobs', stopped.jobId + '.json'), JSON.stringify(stored));
      }
      return { content: '{"partial":', diagnostics: { finishReason: 'length' } };
    } };
    await assert.rejects(generateTextbook(ctx, stopped.jobId, controller.signal, boundaryDeps));
    assert.equal(attempts, 1); assert.equal(savedCount, 0);
    storage.set('loginote_llm_settings', JSON.stringify(llmSettings));
  }
  pass('截断重试前后核验取消、资料、模型配置及持久化任务策略，任一变化立即停止且不发下一次请求');

  await writeFile(path.join(temp, 'documents', 'doc-choice.md'), original); await reset(); const pinned = await prepared();
  let pinnedCalls = 0;
  const pinnedDeps = { ...deps, model: async (request: LlmCallRequest, _signal?: AbortSignal, providerSnapshot?: LlmProvider) => {
    pinnedCalls++; assert.equal(providerSnapshot!.baseUrl, 'http://127.0.0.1:11434');
    assert.equal(providerSnapshot!.selectedModel, 'mock'); assert.equal(request.model, 'mock');
    // Settings change after the async approval check but before the actual LLM send.
    storage.set('loginote_llm_settings', JSON.stringify({ ...llmSettings,
      providers: [{ ...llmSettings.providers[0], baseUrl: 'https://unapproved.invalid', selectedModel: 'unapproved-model' }] }));
    let ipcCalls = 0;
    bridge.llm = { request: async (input: any) => {
      ipcCalls++; assert.equal(input.provider.baseUrl, 'http://127.0.0.1:11434'); assert.equal(input.provider.selectedModel, 'mock');
      return fixtureModel(request);
    } };
    const response = await callLLM(request, { providerSnapshot });
    assert.equal(ipcCalls, 1); return response;
  } };
  await assert.rejects(generateTextbook(ctx, pinned.jobId, undefined, pinnedDeps), /模型配置已变化|不是本机服务/u);
  assert.equal(pinnedCalls, 1); assert.equal(savedCount, 0);
  storage.set('loginote_llm_settings', JSON.stringify(llmSettings)); delete bridge.llm;
  pass('异步配置检查与实际发送之间切换服务商，真实 callLLM 仍只发给批准的内存快照，随后停止不重试');

  for (const legacy of [true, false]) {
    await writeFile(path.join(temp, 'documents', 'doc-choice.md'), original); await reset(); const old = await prepared();
    const stored = (await command({ op: 'get', jobId: old.jobId })).job;
    if (legacy) delete stored.spec.modelPolicy;
    else stored.spec.modelPolicy!.stages.blueprint.maxTokens = 7000;
    await atomicWriteTextFile(path.join(stateDir, 'textbook-jobs', old.jobId + '.json'), JSON.stringify(stored));
    await assert.rejects(generateTextbook(ctx, old.jobId, undefined, deps), /重新准备并确认/u);
    assert.equal(modelCalls, 0); assert.equal(savedCount, 0);
  }
  pass('旧任务缺预算或预算与当前策略不符，要求重新准备和确认，不静默升级授权范围');

  const missingDependencies = structuredClone(savedJob.checkpoint.blueprint!);
  const sourcePool = savedJob.checkpoint.sources!;
  const focusSources = missingDependencies.focuses[0].sourceIds;
  assert.ok(focusSources.length >= 2);
  missingDependencies.chapters.forEach((chapter) => { chapter.sourceIds = [focusSources[0]]; });
  assert.throws(() => validateBlueprint(missingDependencies, context, sourcePool), /资料没有落实/u);
  const assembled = assembleTeachingBlueprint(missingDependencies, context, sourcePool);
  assert.ok(assembled.chapters.every((chapter) => focusSources.every((id) => chapter.sourceIds.includes(id))));
  assert.deepEqual(missingDependencies.chapters[0].sourceIds, [focusSources[0]]);
  for (const invalid of ['unknown-source', 'unknown-focus', 'duplicate-source', 'empty-sources', 'missing-objective', 'unknown-evidence'] as const) {
    const candidate = structuredClone(missingDependencies);
    if (invalid === 'unknown-source') candidate.focuses[0].sourceIds.push('L999');
    else if (invalid === 'unknown-focus') candidate.chapters[0].focusIds.push('F999');
    else if (invalid === 'duplicate-source') candidate.chapters[0].sourceIds.push(focusSources[0]);
    else if (invalid === 'empty-sources') candidate.chapters[0].sourceIds = [];
    else if (invalid === 'missing-objective') candidate.chapters[0].objectiveIds = [];
    else candidate.focuses[0].evidenceIds.push('C999');
    assert.throws(() => assembleTeachingBlueprint(candidate, context, sourcePool));
  }
  pass('蓝图组装只补声明重点的已批准来源依赖，不改原对象；未知/重复编号、空来源和覆盖缺失仍由原门控拒绝');

  await reset(); const mapped = await prepared();
  const mappingDeps = { ...deps, model: async (request: LlmCallRequest) => {
    const response = await fixtureModel(request);
    if (modelStage(request) === 'blueprint') {
      const blueprint = response.parsedJson;
      blueprint.chapters.forEach((chapter: { sourceIds: string[] }) => { chapter.sourceIds = [blueprint.focuses[0].sourceIds[0]]; });
    }
    return response;
  } };
  await generateTextbook(ctx, mapped.jobId, undefined, mappingDeps);
  const mappedJob = (await command({ op: 'get', jobId: mapped.jobId })).job;
  validateBlueprint(mappedJob.checkpoint.blueprint, context, mappedJob.checkpoint.sources!);
  assert.ok(mappedJob.checkpoint.blueprint!.chapters.every((chapter) => mappedJob.checkpoint.blueprint!.focuses[0].sourceIds.every((id) => chapter.sourceIds.includes(id))));
  assert.equal(savedCount, 1); assert.equal(modelCalls, 5);
  pass('生产流水线确定性落实蓝图来源依赖，保留严格章节引用/质检/保存门控，不增加模型调用');

  for (const internal of ['本次个人记录（C1、M1、R1）只用于教学适配。', '当前内部编号为 C1。',
    '本次个人记录 C&#49; 用于教学适配。', '内部证据 C&#x31; 用于讲解。', '当前个人证据 **C**1 不应出现。',
    fence('textbook-tip', escapedJson({ title: '个人证据 C1', kind: 'tip', text: '这段说明不应进入可分享教材。' })),
    fence('mermaid', 'flowchart LR\n A["个人证据 #67;1"] --> B[说明]')]) {
    const candidate = structuredClone(savedJob); candidate.checkpoint.chapters![0].sections.practice += '\n\n' + internal;
    const body = assembleTextbook(candidate.checkpoint.blueprint!, candidate.checkpoint.chapters!, candidate.checkpoint.sources!);
    assert.throws(() => validateTextbookJob(candidate, body), /内部个人证据编号/u);
  }
  const domain = structuredClone(savedJob);
  domain.checkpoint.context!.personal.push({ evidenceId: 'M1', kind: 'unconfirmed_material', text: '另一个内部材料', reference: {}, usableAsFactEvidence: false });
  domain.checkpoint.sources![0].text += '\nM1 是文中合法的术语。';
  domain.checkpoint.chapters![0].sections.practice += '\n讨论原文中的 M1 术语而不是内部记录。';
  validateTextbookJob(domain, assembleTextbook(domain.checkpoint.blueprint!, domain.checkpoint.chapters!, domain.checkpoint.sources!));
  for (const ordinary of ['M1 是狭义货币的统计口径。个人记录日常支出可以辅助检查预算。',
    '个人记录日常支出可以辅助检查预算；M1 是狭义货币的统计口径。',
    'M1 is a monetary aggregate. 个人记录日常支出可以辅助检查预算。']) {
    const candidate = structuredClone(domain); candidate.checkpoint.chapters![0].sections.practice += '\n' + ordinary;
    validateTextbookJob(candidate, assembleTextbook(candidate.checkpoint.blueprint!, candidate.checkpoint.chapters!, candidate.checkpoint.sources!));
  }
  for (const internal of ['个人记录（M1）用来调整教案。', 'M1 是内部证据编号。', 'M&#49;：个人记录。']) {
    const candidate = structuredClone(domain); candidate.checkpoint.chapters![0].sections.practice += '\n' + internal;
    assert.throws(() => validateTextbookJob(candidate, assembleTextbook(candidate.checkpoint.blueprint!, candidate.checkpoint.chapters!, candidate.checkpoint.sources!)), /内部个人证据编号/u);
  }
  pass('裸写/转义/图示中的私人证据编号不能随模型错误放行发布；合法原文同名术语不误伤，内部记录说明仍拒绝');

  await reset(); const extraFields = await prepared();
  const decoderError = "Failed to execute 'decode' on 'TextDecoder': parameter 1 is not of type 'ArrayBuffer'.";
  await assert.rejects(generateTextbook(ctx, extraFields.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
    const response = await fixtureModel(request);
    if (request.workflow === 'textbook-chapter') {
      response.parsedJson.sections.summaryTable = { headers: ['EXTRA_METADATA_NOT_PUBLISHED'], rows: [['保留在私有草稿']] };
      response.parsedJson.sections.practiceDiagram = { unexpected: true };
    }
    if (request.workflow === 'textbook-quality') {
      const input = fixtureInput(request);
      assert.ok(input.chapters.every((chapter: any) => !('summaryTable' in chapter.sections) && !('practiceDiagram' in chapter.sections)));
      throw new Error('synthetic review interruption after deterministic checks');
    }
    return response;
  } }), /synthetic review interruption/u);
  const extraSaved = (await command({ op: 'get', jobId: extraFields.jobId })).job;
  assert.equal(extraSaved.checkpoint.chapters!.length, 2);
  const extraBody = assembleTextbook(extraSaved.checkpoint.blueprint!, extraSaved.checkpoint.chapters!, extraSaved.checkpoint.sources!);
  validateTextbookContent(extraSaved, extraBody);
  assert.ok(!extraBody.includes('EXTRA_METADATA_NOT_PUBLISHED'));
  for (const invalid of ['<div>可执行 HTML</div>', '个人记录（C1）用于教学适配。']) {
    const candidate = structuredClone(extraSaved);
    candidate.checkpoint.chapters![0].sections.practice += '\n' + invalid;
    assert.throws(() => validateTextbookContent(candidate, assembleTextbook(candidate.checkpoint.blueprint!, candidate.checkpoint.chapters!, candidate.checkpoint.sources!)), /HTML|内部个人证据编号/u);
  }
  const legacyExtraLease = await command({ op: 'claim', jobId: extraFields.jobId });
  // Reproduce the exact old persisted failure, including a section outside the schema.
  recordTextbookFailure(legacyExtraLease.job, [{ stage: 'chapters', chapterId: 'ch2', section: 'summaryTable' as never, message: decoderError }]);
  const untouchedFailure = structuredClone(legacyExtraLease.job);
  assert.equal(reconcileTextbookReviewCheckpoint(untouchedFailure), 'retained');
  assert.equal(untouchedFailure.checkpoint.repair, undefined);
  // Also cover the real task after old retries queued the impossible patch and
  // exhausted repair rounds. Recovery must NOT reset any of those counters.
  legacyExtraLease.job.checkpoint.sectionRepairs = { ch2: ['summaryTable' as never] };
  legacyExtraLease.job.checkpoint.cost!.repairRounds = 2;
  legacyExtraLease.job.checkpoint.cost!.stopped = 'repairs';
  await command({ op: 'checkpoint', jobId: extraFields.jobId, token: legacyExtraLease.token!, stage: 'validating', checkpoint: legacyExtraLease.job.checkpoint });
  await command({ op: 'stop', jobId: extraFields.jobId, token: legacyExtraLease.token!, cancelled: false, error: decoderError });
  const webEnabledFailure = structuredClone((await command({ op: 'get', jobId: extraFields.jobId })).job);
  webEnabledFailure.spec.readBoundUrls = true;
  const errorProgress = textbookProgressSnapshot(webEnabledFailure, false);
  assert.equal(errorProgress.resumeAfterCodeFix, true);
  assert.match(errorProgress.error!, /旧报错不再复现/u);
  assert.ok(!errorProgress.error!.includes('公开资源'));
  delete webEnabledFailure.checkpoint.repair;
  delete webEnabledFailure.checkpoint.quality;
  webEnabledFailure.error = 'Model request failed: HTTP 503';
  assert.equal(textbookProgressSnapshot(webEnabledFailure, false).error, webEnabledFailure.error);
  webEnabledFailure.error = "EACCES: readFile 'C:\\Users\\PRIVATE_TEST_USER\\textbook-jobs\\job.json'";
  assert.ok(!JSON.stringify(textbookProgressSnapshot(webEnabledFailure, false)).includes('PRIVATE_TEST_USER'));
  store = new TextbookStore(stateDir);
  const extraResumeCalls: LlmCallRequest[] = [];
  await freshlyApprovedGenerate(extraFields.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
    extraResumeCalls.push(request);
    assert.equal(request.workflow, 'textbook-quality', 'Old impossible field failure must not authorize a chapter rewrite');
    const input = fixtureInput(request);
    assert.ok(input.chapters.every((chapter: any) => Object.keys(chapter.sections).length === 7));
    return fixtureModel(request);
  } });
  const extraRecovered = (await command({ op: 'get', jobId: extraFields.jobId })).job;
  assert.deepEqual(extraResumeCalls.map(request => request.workflow), ['textbook-quality']);
  assert.deepEqual(extraRecovered.checkpoint.chapters, extraSaved.checkpoint.chapters, 'Keep every saved section and private extra field byte-for-byte');
  assert.equal(extraRecovered.checkpoint.cost!.repairRounds, 2);
  assert.equal(extraRecovered.checkpoint.sectionRepairs, undefined);
  assert.equal(extraRecovered.stage, 'published'); assert.equal(savedCount, 1);
  pass('额外对象字段不进入正文解析/语义复核；旧 summaryTable 类型错误重启后只复核、不重写、不消耗修订轮次，HTML/隐私门控仍有效');
  pass('启用绑定 URL 不再把章节/模型错误误报为网页失败；错误摘要仍脱敏存储路径');

  await reset(); const privacyRepair = await prepared();
  let leakedQualityCalls = 0;
  const leakDeps = { ...deps, model: async (request: LlmCallRequest) => {
    if (request.workflow === 'textbook-quality') leakedQualityCalls++;
    const response = await fixtureModel(request);
    if (request.workflow === 'textbook-chapter') response.parsedJson.sections.boundaries += '\n个人记录（C1）用于教学适配。';
    return response;
  } };
  await assert.rejects(generateTextbook(ctx, privacyRepair.jobId, undefined, leakDeps), /内部个人证据编号/u);
  assert.equal(leakedQualityCalls, 0, '确定性隐私失败必须在整本教材交给复核模型前阻止');
  const rejectedPrivacy = (await command({ op: 'get', jobId: privacyRepair.jobId })).job;
  assert.equal(rejectedPrivacy.checkpoint.quality!.passed, false); assert.equal(savedCount, 0);
  assert.ok(rejectedPrivacy.checkpoint.quality!.issues.some((issue) => issue.includes('内部个人证据编号')));
  const callsBeforePrivacyRetry = modelCalls;
  await freshlyApprovedGenerate(privacyRepair.jobId);
  assert.equal(modelCalls - callsBeforePrivacyRetry, 3); assert.equal(savedCount, 1);
  assert.deepEqual(rejectedPrivacy.checkpoint.repair!.findings.map((finding) => finding.chapterId), ['ch1', 'ch2']);
  pass('确定性隐私门控同时定位所有泄漏章节；显式重新批准只修这些章并重做质量校验，不重写蓝图');

  await reset(); const htmlRepair = await prepared(); const htmlEvents: TextbookProgress[] = [];
  const unsubscribeHtml = subscribeTextbookProgress((event) => { if (event?.jobId === htmlRepair.jobId) htmlEvents.push(structuredClone(event)); });
  const threeChapterModel = async (request: LlmCallRequest) => {
    const response = await fixtureModel(request);
    if (request.workflow === 'textbook-blueprint' && !fixtureInput(request).catalogs) {
      response.parsedJson.chapters.push({ ...structuredClone(response.parsedJson.chapters[1]), id: 'ch3', title: '实践与综合判断' });
    }
    return response;
  };
  const htmlDeps = { ...deps, model: async (request: LlmCallRequest) => {
    const response = await threeChapterModel(request);
    if (request.workflow === 'textbook-chapter' && fixtureInput(request).chapter.id === 'ch3') response.parsedJson.sections.practice += '\n<div>不能写入的控制内容</div>';
    return response;
  } };
  await assert.rejects(generateTextbook(ctx, htmlRepair.jobId, undefined, htmlDeps), /HTML/u); unsubscribeHtml();
  const htmlRejected = (await command({ op: 'get', jobId: htmlRepair.jobId })).job;
  assert.equal(htmlRejected.checkpoint.chapters!.length, 2);
  assert.deepEqual(htmlRejected.checkpoint.repair!.findings.map((finding) => [finding.stage, finding.chapterId, finding.section]), [['chapters', 'ch3', 'practice']]);
  store = new TextbookStore(stateDir);
  const htmlSummary = (await store.list('project-a')).find((job) => job.jobId === htmlRepair.jobId)!;
  assert.equal(htmlSummary.progress!.running, false); assert.equal(htmlSummary.progress!.currentStage, 'chapters');
  assert.equal(htmlSummary.progress!.completed, 2); assert.equal(htmlSummary.progress!.total, 3);
  assert.equal(htmlSummary.progress!.steps.find((step) => step.stage === 'chapters')!.status, 'failed');
  assert.equal(htmlSummary.progress!.steps.find((step) => step.stage === 'blueprint')!.status, 'saved');
  assert.ok(!JSON.stringify(htmlSummary).includes('PRIVATE_COGNITION')); assert.ok(!JSON.stringify(htmlSummary).includes(context.profile));
  const htmlRetryCalls: LlmCallRequest[] = [];
  await freshlyApprovedGenerate(htmlRepair.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => { htmlRetryCalls.push(structuredClone(request)); return threeChapterModel(request); } });
  const htmlRepaired = (await command({ op: 'get', jobId: htmlRepair.jobId })).job;
  assert.deepEqual(htmlRetryCalls.map((request) => request.workflow), ['textbook-chapter', 'textbook-quality']);
  assert.equal(JSON.parse(htmlRetryCalls[0].userInput).chapter.id, 'ch3');
  assert.deepEqual(htmlRepaired.checkpoint.blueprint, htmlRejected.checkpoint.blueprint);
  assert.deepEqual(htmlRepaired.checkpoint.chapters!.slice(0, 2), htmlRejected.checkpoint.chapters);
  assert.equal(htmlEvents.at(-1)!.jobStage, 'failed'); assert.equal(htmlEvents.at(-1)!.completed, 2);
  pass('截图场景：ch3 HTML 失败并重启后只重写 ch3，保留蓝图及 ch1/ch2；持久进度恢复 2/3 和准确失败阶段，无私人证据');

  for (const changeSummary of [false, true]) {
    await reset(); const localRepair = await prepared(); const issue = `ch1.${changeSummary ? 'summary' : 'answer'}：需要修正此处教学解释`;
    await assert.rejects(generateTextbook(ctx, localRepair.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
      const response = await fixtureModel(request);
      const section = changeSummary ? 'summary' : 'answer';
      if (request.workflow === 'textbook-chapter' && fixtureInput(request).chapter.id === 'ch1') response.parsedJson.sections[section] = '无论偏好是否清晰，选项增加一定导致每一个人的决策更差。[N1]';
      if (request.workflow === 'textbook-quality') {
        const input = fixtureInput(request);
        response.parsedJson = factualRejection(input, { kind: 'chapter', chapterId: 'ch1', section, quote: input.chapters[0].sections[section] }, issue);
      }
      return response;
    } }));
    const localRejected = (await command({ op: 'get', jobId: localRepair.jobId })).job;
    const localCalls: LlmCallRequest[] = [];
    await freshlyApprovedGenerate(localRepair.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
      localCalls.push(structuredClone(request)); const response = await fixtureModel(request);
      if (request.workflow === 'textbook-chapter' && fixtureInput(request).chapter.id === 'ch1' && changeSummary) response.parsedJson.sections.summary += '修订后的承接小结供下一章使用。';
      return response;
    } });
    const localRepaired = (await command({ op: 'get', jobId: localRepair.jobId })).job;
    assert.deepEqual(localCalls.filter((request) => request.workflow === 'textbook-chapter').map((request) => fixtureInput(request).chapter.id), changeSummary ? ['ch1', 'ch2'] : ['ch1']);
    assert.ok(!localCalls.some((request) => request.workflow === 'textbook-blueprint'));
    assert.deepEqual(localRepaired.checkpoint.blueprint, localRejected.checkpoint.blueprint);
    const patchInput = JSON.parse(localCalls[0].userInput);
    const patchedSection = changeSummary ? 'summary' : 'answer';
    assert.deepEqual(patchInput.repairSections, [patchedSection]);
    for (const section of Object.keys(localRejected.checkpoint.chapters![0].sections) as Array<keyof typeof localRejected.checkpoint.chapters[0]['sections']>) {
      if (section !== patchedSection) assert.equal(localRepaired.checkpoint.chapters![0].sections[section], localRejected.checkpoint.chapters![0].sections[section]);
    }
    if (!changeSummary) {
      const scoped = JSON.parse(localCalls.find((request) => request.workflow === 'textbook-quality')!.userInput);
      assert.deepEqual(scoped.reviewScope, { kind: 'changed_chapters', chapterIds: ['ch1'] });
      assert.equal(localRepaired.checkpoint.cost?.repairRounds, 1);
    }
    if (!changeSummary) assert.deepEqual(localRepaired.checkpoint.chapters![1], localRejected.checkpoint.chapters![1]);
    else assert.equal(JSON.parse(localCalls[1].userInput).previousSummary, localRepaired.checkpoint.chapters![0].sections.summary);
  }
  pass('质量问题精确定位 ch1：小结不变则 ch2 原样复用；小结变化则仅重做依赖该小结的后续章，蓝图始终不重写');

  await reset(); const bridgeRepair = await prepared(); const bridgeIssue = 'blueprint.chapters.ch2.bridge：章节承接句需要调整';
  await assert.rejects(generateTextbook(ctx, bridgeRepair.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
    const response = await fixtureModel(request);
    if (request.workflow === 'textbook-blueprint' && !fixtureInput(request).catalogs) response.parsedJson.chapters[1].bridge = '选项增加一定改善所有人的决策，因此进入实践。';
    if (request.workflow === 'textbook-quality') {
      const input = fixtureInput(request);
      response.parsedJson = factualRejection(input, { kind: 'bridge', chapterId: 'ch2', quote: input.blueprint.chapters[1].bridge }, bridgeIssue);
    }
    return response;
  } }));
  const bridgeBefore = (await command({ op: 'get', jobId: bridgeRepair.jobId })).job; const bridgeCalls: LlmCallRequest[] = [];
  await freshlyApprovedGenerate(bridgeRepair.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
    bridgeCalls.push(structuredClone(request)); const response = await fixtureModel(request);
    if (request.workflow === 'textbook-blueprint') response.parsedJson.chapters[1].bridge = '先理解条件边界，再进入更复杂的迁移判断。'; return response;
  } });
  assert.deepEqual(bridgeCalls.map((request) => request.workflow), ['textbook-blueprint', 'textbook-chapter', 'textbook-quality']);
  assert.equal(JSON.parse(bridgeCalls[1].userInput).chapter.id, 'ch2');
  assert.deepEqual((await command({ op: 'get', jobId: bridgeRepair.jobId })).job.checkpoint.chapters![0], bridgeBefore.checkpoint.chapters![0]);
  pass('蓝图仅修改 ch2 承接时，依赖指纹保留 ch1，只重写蓝图和受影响的 ch2');

  for (const failure of ['timeout', 'unknown-chapter', 'inconsistent-pass']) {
    await reset(); const qualityOnly = await prepared();
    await assert.rejects(generateTextbook(ctx, qualityOnly.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
      const response = await fixtureModel(request);
      if (request.workflow === 'textbook-quality') {
        if (failure === 'timeout') throw new Error('quality synthetic timeout');
        response.parsedJson = failure === 'unknown-chapter' ? { passed: false, issues: ['问题'], findings: [{ stage: 'chapters', chapterId: 'ch999', message: '问题' }] } : { passed: true, issues: ['仍有问题'] };
      }
      return response;
    } }));
    const qualityBefore = (await command({ op: 'get', jobId: qualityOnly.jobId })).job; const qualityCalls: LlmCallRequest[] = [];
    assert.equal(qualityBefore.checkpoint.progress!.currentStage, 'validating'); assert.equal(savedCount, 0);
    await freshlyApprovedGenerate(qualityOnly.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => { qualityCalls.push(request); return fixtureModel(request); } });
    assert.deepEqual(qualityCalls.map((request) => request.workflow), ['textbook-quality']);
    assert.deepEqual((await command({ op: 'get', jobId: qualityOnly.jobId })).job.checkpoint.chapters, qualityBefore.checkpoint.chapters);
  }
  pass('质量超时/未知章节定位/通过标志矛盾都安全拒绝，恢复时只重跑校验，不重做蓝图或章节');

  await reset(); const retryProgress = await prepared(); let truncatedChapter = false; const progressSnapshots: TextbookProgress[] = [];
  const offRetry = subscribeTextbookProgress((value) => { if (value?.jobId === retryProgress.jobId) progressSnapshots.push(structuredClone(value)); });
  await generateTextbook(ctx, retryProgress.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
    const response = await fixtureModel(request);
    if (request.workflow === 'textbook-chapter' && fixtureInput(request).chapter.id === 'ch2' && !truncatedChapter) {
      truncatedChapter = true; return { content: '{"partial":', diagnostics: { finishReason: 'length' } };
    }
    const current = (await store.list('project-a')).find((item) => item.jobId === retryProgress.jobId)!;
    assert.equal(current.progress!.running, true);
    return response;
  } }); offRetry();
  const retriedSnapshot = progressSnapshots.find((value) => value.retry === 1)!;
  assert.equal(retriedSnapshot.currentStage, 'chapters'); assert.equal(retriedSnapshot.completed, 1); assert.equal(retriedSnapshot.total, 2);
  assert.equal(retriedSnapshot.chapterId, 'ch2'); assert.equal(retriedSnapshot.chapterIndex, 2); assert.equal(retriedSnapshot.retryLimit, 1);
  let lateSnapshot: TextbookProgress | null = null;
  const offLate = subscribeTextbookProgress((value) => { if (value?.jobId === retryProgress.jobId) lateSnapshot = value; }); offLate();
  assert.equal(lateSnapshot!.jobStage, 'published'); assert.equal(lateSnapshot!.running, false); assert.equal(lateSnapshot!.completed, 2);
  assert.ok(lateSnapshot!.steps.every((step) => step.status === 'saved')); assert.ok(lateSnapshot!.history.length <= 24);
  pass('截断重试保留阶段、章节名、1/2 已保存和重试 1/1；晚订阅收到完成快照，成功/失败不再清空进度');

  await reset(); const contextChange = await prepared(); abortController = new AbortController(); mode = 'cancel';
  await assert.rejects(generateTextbook(ctx, contextChange.jobId, abortController.signal, deps)); mode = 'normal';
  const contextBefore = (await command({ op: 'get', jobId: contextChange.jobId })).job; const contextCalls: LlmCallRequest[] = [];
  await freshlyApprovedGenerate(contextChange.jobId, undefined, { ...deps, context: async () => ({ ...structuredClone(context), profile: '新的可信讲解偏好' }),
    sources: async () => { throw new Error('上下文变化不得重新选材'); }, model: async (request: LlmCallRequest) => { contextCalls.push(request); return fixtureModel(request); } });
  const contextAfter = (await command({ op: 'get', jobId: contextChange.jobId })).job;
  assert.deepEqual(contextAfter.checkpoint.sources, contextBefore.checkpoint.sources);
  assert.deepEqual(contextCalls.map((request) => request.workflow), ['textbook-blueprint', 'textbook-chapter', 'textbook-chapter', 'textbook-quality']);
  pass('可信画像变化仅使相关教学内容失效，仍复用已批准且版本未变的物料，不从资源搜集整体重来');

  for (const applied of [false, true]) {
    await reset(); const legacyReview = await prepared(); mode = 'quality-failure';
    await assert.rejects(generateTextbook(ctx, legacyReview.jobId, undefined, deps)); mode = 'normal';
    const claimedLegacy = await command({ op: 'claim', jobId: legacyReview.jobId });
    const oldCheckpoint = claimedLegacy.job.checkpoint;
    const originals = structuredClone({ blueprint: oldCheckpoint.blueprint, chapters: oldCheckpoint.chapters, sources: oldCheckpoint.sources });
    const accusations = Array.from({ length: 6 }, (_, index) => ({ stage: 'blueprint' as const, message: `蓝图：章节 ${index + 1} 的允许 N1/N2 来源编号不存在` }));
    oldCheckpoint.quality = { passed: false, issues: accusations.map((finding) => finding.message), findings: accusations };
    oldCheckpoint.repair = { findings: accusations, applied }; oldCheckpoint.repairIssues = oldCheckpoint.quality.issues;
    await command({ op: 'checkpoint', jobId: legacyReview.jobId, token: claimedLegacy.token!, stage: 'validating', checkpoint: oldCheckpoint });
    await command({ op: 'stop', jobId: legacyReview.jobId, token: claimedLegacy.token!, cancelled: false, error: '旧模型来源编号误判' });
    store = new TextbookStore(stateDir);
    const legacyCalls: LlmCallRequest[] = [];
    await freshlyApprovedGenerate(legacyReview.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
      legacyCalls.push(request); assert.ok(!request.userInput.includes('来源编号不存在')); assert.ok(!request.userInput.includes('repairIssues')); return fixtureModel(request);
    } });
    const migrated = (await command({ op: 'get', jobId: legacyReview.jobId })).job;
    assert.deepEqual(legacyCalls.map((request) => request.workflow), ['textbook-quality']);
    assert.deepEqual(migrated.checkpoint.blueprint, originals.blueprint); assert.deepEqual(migrated.checkpoint.chapters, originals.chapters);
    assert.deepEqual(migrated.checkpoint.sources, originals.sources); assert.equal(migrated.stage, 'published');
    assert.equal(migrated.checkpoint.quality!.schemaVersion, 3);
  }
  pass('真实私有检查点重启恢复：六条旧来源白名单误判不重做蓝图/章节，只重做新版复核，陈旧否决不再进入模型输入');

  for (const failure of ['fake-target', 'fake-quote', 'metadata-accusation', 'unlocated-extra'] as const) {
    await reset(); const reportOnly = await prepared();
    await assert.rejects(generateTextbook(ctx, reportOnly.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
      const response = await fixtureModel(request);
      if (request.workflow === 'textbook-quality') {
        const input = fixtureInput(request);
        const badReport = factualRejection(input, { kind: 'chapter', chapterId: 'ch1', section: 'answer', quote: input.chapters[0].sections.answer }, 'ch1.answer：本节具体论断与来源条件不一致');
        if (failure === 'fake-target') badReport.findings[0].target = { kind: 'chapter', chapterId: 'ch999', section: 'answer', quote: input.chapters[0].sections.answer };
        if (failure === 'fake-quote') badReport.findings[0].basis[0].quote = '原文从未出现过的内容，不能伪造来源。';
        if (failure === 'metadata-accusation') badReport.findings[0].message = '引用编号 N1 不在本次提供的来源白名单';
        response.parsedJson = failure === 'unlocated-extra' ? { ...badReport, issues: ['未定位的额外拒绝'] } : badReport;
      }
      return response;
    } }), /复核报告不可信/u);
    const reportFailed = (await command({ op: 'get', jobId: reportOnly.jobId })).job;
    assert.equal(savedCount, 0); assert.equal(reportFailed.checkpoint.quality!.status, 'needs_recheck'); assert.equal(reportFailed.checkpoint.repair, undefined);
    const summary = (await store.list('project-a')).find((job) => job.jobId === reportOnly.jobId)!;
    assert.equal(summary.progress!.completed, 2); assert.deepEqual(summary.progress!.repairTargets, []);
    assert.equal(summary.progress!.qualityReview!.status, 'needs_recheck');
    store = new TextbookStore(stateDir); const reportOnlyCalls: LlmCallRequest[] = [];
    await freshlyApprovedGenerate(reportOnly.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => { reportOnlyCalls.push(request); return fixtureModel(request); } });
    const verified = (await command({ op: 'get', jobId: reportOnly.jobId })).job;
    assert.deepEqual(reportOnlyCalls.map((request) => request.workflow), ['textbook-quality']);
    assert.deepEqual(verified.checkpoint.chapters, reportFailed.checkpoint.chapters); assert.deepEqual(verified.checkpoint.blueprint, reportFailed.checkpoint.blueprint);
  }
  pass('复核虚构位置/原文、编号越权和额外否决均不发布；跨重启重新批准只复核，不使已通过章节失效');

  await reset(); const indexedReviewJob = await prepared();
  await assert.rejects(generateTextbook(ctx, indexedReviewJob.jobId, undefined, { ...deps, model: async request => {
    const response = await fixtureModel(request);
    if (request.workflow === 'textbook-quality') {
      const wire = JSON.parse(request.userInput);
      assert.ok(Array.isArray(wire.chapters[0].sections.answer));
      assert.ok(Array.isArray(wire.sources[0].text));
      assert.ok(request.systemPromptOverride!.includes('"schemaVersion":4'));
      response.parsedJson = { schemaVersion: 4, passed: false, findings: [{ severity: 'blocker', impact: 'critical', certainty: 'clear', category: 'factual_support',
        target: { ref: wire.chapters[0].sections.answer[0].ref }, message: '这条合成报告引用了错误的依据编号', reason: '这是验收用的无效重大错误报告，不能据此改写任何教材章节。', basis: [{ ref: 'S99999' }] }] };
    }
    return response;
  } }), /复核报告不可信/u);
  const indexedFailed = (await command({ op: 'get', jobId: indexedReviewJob.jobId })).job;
  assert.equal(indexedFailed.checkpoint.quality!.reviewDiagnostics![0].field, 'basis[0].ref');
  assert.equal(indexedFailed.checkpoint.quality!.reviewDiagnostics![0].chapterId, 'ch1');
  assert.deepEqual(textbookProgressSnapshot(indexedFailed, false).repairTargets, []);
  store = new TextbookStore(stateDir);
  const interruptedReviewCalls: LlmCallRequest[] = [];
  await assert.rejects(freshlyApprovedGenerate(indexedReviewJob.jobId, undefined, { ...deps, model: async request => {
    interruptedReviewCalls.push(request); assert.equal(request.workflow, 'textbook-quality');
    const wire = JSON.parse(request.userInput);
    assert.equal(wire.reportCorrection.invalidLocations[0].field, 'basis[0].ref');
    if (interruptedReviewCalls.length === 1) return { content: '{"partial":', diagnostics: { finishReason: 'length' } };
    throw new Error('synthetic indexed report correction transport interruption');
  } }), /transport interruption/u);
  const interruptedReview = (await command({ op: 'get', jobId: indexedReviewJob.jobId })).job;
  assert.deepEqual(interruptedReview.checkpoint.quality!.reviewDiagnostics, indexedFailed.checkpoint.quality!.reviewDiagnostics);
  store = new TextbookStore(stateDir); const correctedReviewCalls: LlmCallRequest[] = [];
  await freshlyApprovedGenerate(indexedReviewJob.jobId, undefined, { ...deps, model: async request => {
    correctedReviewCalls.push(request); assert.equal(request.workflow, 'textbook-quality');
    assert.equal(request.userInput, interruptedReviewCalls[1].userInput);
    assert.equal(request.systemPromptOverride, interruptedReviewCalls[1].systemPromptOverride);
    assert.equal(request.maxTokensOverride, interruptedReviewCalls[1].maxTokensOverride);
    const wire = JSON.parse(request.userInput);
    const result = { schemaVersion: 4, passed: false, findings: [{ severity: 'warning', impact: 'minor', certainty: 'clear', category: 'pedagogy',
      target: { ref: wire.chapters[0].sections.answer[0].ref }, message: '这条合成建议的依据无法定位', reason: '建议不影响核心知识与任务完成，不能要求重新生成。', basis: [{ ref: 'S99999' }] }] };
    return { content: JSON.stringify(result), parsedJson: result };
  } });
  const indexedPublished = (await command({ op: 'get', jobId: indexedReviewJob.jobId })).job;
  assert.equal(correctedReviewCalls.length, 1); assert.equal(savedCount, 1); assert.equal(indexedPublished.stage, 'published');
  assert.deepEqual(indexedPublished.checkpoint.chapters, indexedFailed.checkpoint.chapters);
  assert.deepEqual(indexedPublished.checkpoint.blueprint, indexedFailed.checkpoint.blueprint);
  assert.equal(indexedPublished.checkpoint.cost!.repairRounds, 0); assert.equal(indexedPublished.checkpoint.cost!.reviewRechecks, 2);
  assert.equal(textbookProgressSnapshot(indexedPublished, false).qualityReview!.ignoredAdviceCount, 1);
  pass('真实编号复核失败→纠错报告截断/网络中断→Store重开：只复核、沿用上限和纠错输入；无效普通建议不阻断，原章节逐字保留且零内容修订');

  await reset(); const warningJob = await prepared();
  const warningResult = await generateTextbook(ctx, warningJob.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
    const response = await fixtureModel(request);
    if (request.workflow === 'textbook-quality') {
      const input = fixtureInput(request);
      response.parsedJson = { schemaVersion: 2, passed: true, findings: [{ severity: 'warning', category: 'pedagogy',
        target: { kind: 'chapter', chapterId: 'ch1', section: 'selfCheck', quote: input.chapters[0].sections.selfCheck },
        message: '可以把自检句子拆分为两个更易操作的问题', reason: '仅为提升可读性与操作便利度，不影响当前任务完成和内容正确性。', basis: [] }] };
    }
    return response;
  } }) as { warningCount: number };
  assert.equal(warningResult.warningCount, 1); assert.equal(savedCount, 1);
  const warningSaved = (await command({ op: 'get', jobId: warningJob.jobId })).job;
  assert.equal(warningSaved.checkpoint.quality!.warnings!.length, 1); assert.equal(warningSaved.checkpoint.repair, undefined);
  const warningSummary = (await store.list('project-a')).find((job) => job.jobId === warningJob.jobId)!;
  assert.equal(warningSummary.progress!.qualityReview!.warningCount, 1); assert.equal(warningSummary.progress!.qualityReview!.blockerCount, 0);
  assert.ok(!JSON.stringify(warningSummary).includes('可以把自检句子'));
  pass('非阻断教学建议不触发章节重写：完整教材照常落盘，私有建议与安全进度计数保存，正文/个人证据不泄露');

  await reset(); const accounted = await prepared(); let chargedRequests = 0; let chargedTruncation = false;
  await freshlyApprovedGenerate(accounted.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
    chargedRequests++;
    const persisted = (await command({ op: 'get', jobId: accounted.jobId })).job;
    assert.equal(persisted.checkpoint.cost!.requests, chargedRequests);
    assert.ok(persisted.checkpoint.cost!.reservedTokens > 0);
    if (!chargedTruncation) {
      chargedTruncation = true;
      return { content: '{"selections":[', usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 }, diagnostics: { finishReason: 'length', reasoningTokens: 30 } };
    }
    return { ...await fixtureModel(request), usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 }, diagnostics: { finishReason: 'stop', reasoningTokens: 15 } };
  } });
  const costSaved = (await command({ op: 'get', jobId: accounted.jobId })).job;
  assert.equal(chargedRequests, 6); assert.equal(costSaved.checkpoint.cost!.requests, 6);
  assert.equal(costSaved.checkpoint.cost!.promptTokens, 600); assert.equal(costSaved.checkpoint.cost!.completionTokens, 140);
  assert.equal(costSaved.checkpoint.cost!.reservedTokens, 0);
  pass('生产调用前私有检查点已记录预留；六次请求含截断重试全部累计，响应思考不重复计算，落盘后数字精确');

  await reset(); const patchResume = await prepared();
  await assert.rejects(freshlyApprovedGenerate(patchResume.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
    const response = await fixtureModel(request);
    if (request.workflow === 'textbook-quality') {
      const input = fixtureInput(request);
      response.parsedJson = factualRejection(input, { kind: 'chapter', chapterId: 'ch1', section: 'answer', quote: input.chapters[0].sections.answer }, '本节答案需要按实际原文核实');
    }
    return response;
  } }));
  const patchOriginal = (await command({ op: 'get', jobId: patchResume.jobId })).job;
  await assert.rejects(freshlyApprovedGenerate(patchResume.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
    assert.deepEqual(fixtureInput(request).repairSections, ['answer']); throw new Error('synthetic patch network interruption');
  } }), /patch network/u);
  const patchStopped = (await command({ op: 'get', jobId: patchResume.jobId })).job;
  assert.deepEqual(patchStopped.checkpoint.sectionRepairs, { ch1: ['answer'] });
  assert.deepEqual(patchStopped.checkpoint.chapters, patchOriginal.checkpoint.chapters);
  assert.equal(patchStopped.checkpoint.cost!.repairRounds, 1);
  store = new TextbookStore(stateDir); const patchResumeCalls: LlmCallRequest[] = [];
  await freshlyApprovedGenerate(patchResume.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
    patchResumeCalls.push(request); const response = await fixtureModel(request);
    if (request.workflow === 'textbook-chapter') response.parsedJson.sections.answer += '按题干明确条件后再作判断。';
    return response;
  } });
  const patchFinished = (await command({ op: 'get', jobId: patchResume.jobId })).job;
  assert.deepEqual(patchResumeCalls.map((request) => request.workflow), ['textbook-chapter', 'textbook-quality']);
  assert.equal(patchFinished.checkpoint.cost!.repairRounds, 1);
  assert.deepEqual(patchFinished.checkpoint.chapters![1], patchOriginal.checkpoint.chapters![1]);
  assert.deepEqual(JSON.parse(patchResumeCalls[1].userInput).reviewScope.chapterIds, ['ch1']);
  pass('小节修订网络中断并重启后恢复同一局部补丁；不丢旧章、不重写其它节、不重复消耗修订轮数，仅局部复核');

  for (const cap of ['requests', 'repairs', 'reviews'] as const) {
    await reset(); const capped = await prepared();
    if (cap !== 'requests') {
      await assert.rejects(freshlyApprovedGenerate(capped.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
        const response = await fixtureModel(request);
        if (request.workflow === 'textbook-quality') {
          const input = fixtureInput(request);
          response.parsedJson = cap === 'reviews' ? { passed: false, issues: ['未定位意见'] }
            : factualRejection(input, { kind: 'chapter', chapterId: 'ch1', section: 'answer', quote: input.chapters[0].sections.answer }, '本节答案需要按实际原文核实');
        }
        return response;
      } }));
    }
    const cappedLease = await command({ op: 'claim', jobId: capped.jobId }); const cappedJob = cappedLease.job;
    cappedJob.checkpoint.cost ||= { promptTokens: 0, completionTokens: 0, reservedTokens: 0, requests: 0, repairRounds: 0, reviewRechecks: 0, legacyUsageIncomplete: false };
    if (cap === 'requests') cappedJob.checkpoint.cost.requests = 30;
    else if (cap === 'repairs') cappedJob.checkpoint.cost.repairRounds = 2;
    else cappedJob.checkpoint.cost.reviewRechecks = 2;
    await command({ op: 'checkpoint', jobId: capped.jobId, token: cappedLease.token!, stage: 'validating', checkpoint: cappedJob.checkpoint });
    await command({ op: 'stop', jobId: capped.jobId, token: cappedLease.token!, cancelled: false, error: 'synthetic cap boundary' });
    const capCalls = modelCalls; const capChapters = structuredClone(cappedJob.checkpoint.chapters);
    for (let retry = 0; retry < 2; retry++) {
      store = new TextbookStore(stateDir);
      await assert.rejects(freshlyApprovedGenerate(capped.jobId), /达到上限/u);
      const stopped = (await command({ op: 'get', jobId: capped.jobId })).job;
      assert.equal(stopped.checkpoint.cost!.stopped, cap); assert.deepEqual(stopped.checkpoint.chapters, capChapters);
    }
    assert.equal(modelCalls, capCalls); assert.equal(savedCount, 0);
  }
  pass('生产私有检查点达到请求/修订/报告重检上限时，跨重启反复批准仍零模型请求，完整旧草稿保留且不发布');

  await reset(); const oldCriteria = await prepared();
  const groundedFixture = { ...deps, model: async (request: LlmCallRequest) => {
    const response = await fixtureModel(request);
    if (request.workflow === 'textbook-quality') {
      const input = fixtureInput(request);
      response.parsedJson = factualRejection(input, { kind: 'chapter', chapterId: 'ch1', section: 'answer', quote: input.chapters[0].sections.answer }, '本节条件表述建议再进一步解释');
    }
    return response;
  } };
  await assert.rejects(freshlyApprovedGenerate(oldCriteria.jobId, undefined, groundedFixture));
  const criteriaLease = await command({ op: 'claim', jobId: oldCriteria.jobId });
  delete criteriaLease.job.checkpoint.quality!.reviewCriteriaVersion;
  const criteriaChapters = structuredClone(criteriaLease.job.checkpoint.chapters);
  await command({ op: 'checkpoint', jobId: oldCriteria.jobId, token: criteriaLease.token!, stage: 'validating', checkpoint: criteriaLease.job.checkpoint });
  await command({ op: 'stop', jobId: oldCriteria.jobId, token: criteriaLease.token!, cancelled: false, error: 'synthetic older reviewer criteria' });
  store = new TextbookStore(stateDir); const criteriaCalls: LlmCallRequest[] = [];
  await freshlyApprovedGenerate(oldCriteria.jobId, undefined, { ...deps, model: async (request: LlmCallRequest) => {
    criteriaCalls.push(request); const response = await groundedFixture.model(request);
    response.parsedJson.schemaVersion = 3; response.parsedJson.findings[0].impact = 'minor'; response.parsedJson.findings[0].certainty = 'uncertain';
    return response;
  } });
  const reassessed = (await command({ op: 'get', jobId: oldCriteria.jobId })).job;
  assert.deepEqual(criteriaCalls.map((request) => request.workflow), ['textbook-quality']);
  assert.deepEqual(reassessed.checkpoint.chapters, criteriaChapters); assert.equal(reassessed.checkpoint.quality!.passed, true);
  assert.equal(reassessed.checkpoint.quality!.warnings!.length, 1); assert.equal(reassessed.checkpoint.cost!.repairRounds, 0);
  pass('真实旧报告恢复先按新标准复核：轻微不确定质疑规范为建议，只有一次质量请求、零内容修订，旧章完整落盘');

  await reset(); const unchangedRepair = await prepared();
  await assert.rejects(freshlyApprovedGenerate(unchangedRepair.jobId, undefined, groundedFixture));
  const unchangedChapters = structuredClone((await command({ op: 'get', jobId: unchangedRepair.jobId })).job.checkpoint.chapters);
  for (let repair = 0; repair < 2; repair++) {
    const beforeUnchanged = modelCalls;
    await assert.rejects(freshlyApprovedGenerate(unchangedRepair.jobId), /质量复核未通过/u);
    assert.equal(modelCalls - beforeUnchanged, 1); // Identical patch: do not spend another full review.
    const stillBlocked = (await command({ op: 'get', jobId: unchangedRepair.jobId })).job;
    assert.deepEqual(stillBlocked.checkpoint.chapters, unchangedChapters);
    assert.ok(stillBlocked.checkpoint.quality!.report); assert.equal(stillBlocked.checkpoint.quality!.reviewCriteriaVersion, 3);
  }
  const beforeStop = modelCalls;
  await assert.rejects(freshlyApprovedGenerate(unchangedRepair.jobId), /修订轮数达到上限/u);
  assert.equal(modelCalls, beforeStop); assert.equal(savedCount, 0);
  pass('修订未改变内容时保留已核验的真实问题，不再花全书复核；两轮无效修订后自然停止，报告证据不丢');

  const parserBlueprint = htmlRepaired.checkpoint.blueprint!;
  assert.deepEqual(parseTextbookQuality({ passed: false, issues: ['ch3.practice：练习条件不明确'] }, parserBlueprint).findings.map((finding) => [finding.stage, finding.chapterId, finding.section]), [['chapters', 'ch3', 'practice']]);
  assert.deepEqual(parseTextbookQuality({ passed: false, issues: ['原因尚不明确'] }, parserBlueprint).findings.map((finding) => finding.stage), ['validating']);
  pass('旧任务的章节字符串问题可定位到章/节；不能定位的旧质量问题安全留在复核阶段，不猜测整本需要重写');

  await reset(); const hostStop = await prepared();
  const stopListeners = new Set<(request: import('../src/services/textbook/stop').TextbookStopRequest) => void>();
  const stopBridge = (globalThis as any).window.electronAPI.textbook;
  stopBridge.onStopRequested = (listener: (request: import('../src/services/textbook/stop').TextbookStopRequest) => void) => {
    stopListeners.add(listener); return () => { stopListeners.delete(listener); };
  };
  const deliveries: number[] = [];
  stopBridge.requestStop = (id: string) => store.requestStop(id, (owner, request) => {
    deliveries.push(owner); for (const listener of stopListeners) listener(request); return true;
  });
  try {
    const stopDeps: TextbookGenerationDependencies = { ...deps, model: async request => {
      if (request.workflow === 'textbook-chapter' && fixtureInput(request).chapter.id === 'ch2') {
        const stopped = await executeTool('stop_textbook_job', { jobId: hostStop.jobId }, ctx);
        assert.equal(stopped.ok, true); assert.equal((stopped.result as any).status, 'stopping');
        assert.equal(JSON.stringify(stopped.result).includes('token'), false, '执行租约不能进入工具结果');
      }
      return fixtureModel(request);
    } };
    await assert.rejects(generateTextbook(ctx, hostStop.jobId, undefined, stopDeps), /停止教材任务/);
    const stopped = (await command({ op: 'get', jobId: hostStop.jobId })).job;
    assert.equal(stopped.stage, 'cancelled'); assert.equal(stopped.checkpoint.chapters!.length, 1); assert.equal(savedCount, 0);
    assert.deepEqual(deliveries, [1]); assert.equal(stopListeners.size, 0);
    const stoppedRequests = stopped.checkpoint.cost!.requests;
    assert.equal((await stopBridge.requestStop(hostStop.jobId)).status, 'not-running');
    await assert.rejects(stopBridge.requestStop('../other'), /编号无效/);
    const resumed = await generateTextbook(ctx, hostStop.jobId, undefined, deps) as any;
    assert.equal(resumed.saved, true);
    assert.ok((await command({ op: 'get', jobId: hostStop.jobId })).job.checkpoint.cost!.requests > stoppedRequests);
    assert.equal(stopListeners.size, 0);
    pass('真实教材停止工具→主进程租约→原执行窗口中断：保留首章/累计用量，同原任务可继续，无租约泄漏');

    await reset(); const lateHostStop = await prepared();
    const lateCtx = { ...ctx, publishTextbook: async (input: TextbookPublishInput) => {
      const result = await publish(input);
      assert.equal((await stopBridge.requestStop(lateHostStop.jobId)).status, 'stopping');
      return result;
    } };
    const lateResult = await generateTextbook(lateCtx, lateHostStop.jobId, undefined, deps) as any;
    assert.equal(lateResult.saved, true); assert.equal((await command({ op: 'get', jobId: lateHostStop.jobId })).job.stage, 'published');
    assert.equal((await stopBridge.requestStop(lateHostStop.jobId)).status, 'not-running');
    assert.equal(stopListeners.size, 0);
    pass('停止送达晚于实际教材保存时仍完成发布回执，不把已落盘成果误报为撤销或未写入');
  } finally { delete stopBridge.requestStop; delete stopBridge.onStopRequested; }

  await reset(); const directResume = await prepared(); abortController = new AbortController(); mode = 'cancel';
  await assert.rejects(generateTextbook(ctx, directResume.jobId, abortController.signal, deps)); mode = 'normal';
  const directBefore = modelCalls;
  const directPending = await runAgentTurn({ role: AGENT_ROLES.default, userText: `请从检查点继续教材任务 ${directResume.jobId}`,
    requestedSkillId: 'personalized-textbook', ctx, history: [], enableMultiAgent: false, memoryPrefixLoader: async () => '',
    callLlm: async () => ({ content: '请确认恢复', toolCalls: [textbookResumeCall(directResume.jobId)] }) });
  assert.ok(directPending.pendingApproval); assert.equal(modelCalls, directBefore);
  assert.equal(directPending.pendingApproval!.items.length, 1);
  assert.deepEqual(directPending.pendingApproval!.items[0].call.arguments, { jobId: directResume.jobId });
  assert.equal(directPending.pendingApproval!.items[0].call.name, 'generate_project_textbook');
  await resolveAgentApproval({ role: AGENT_ROLES.default, ctx, history: directPending.updatedHistory, approval: directPending.pendingApproval!, approved: true,
    callLlm: async () => ({ content: '教材已保存' }) });
  assert.equal((await command({ op: 'get', jobId: directResume.jobId })).job.stage, 'published'); assert.equal(savedCount, 1);
  assert.equal(modelCalls - directBefore, 2); assert.throws(() => textbookResumeCall('../bad'));
  pass('进度卡的确定性同任务工具意图经真实 Agent 绑定/确认管道恢复：点击不生成，确认后只补剩余章及校验，不由模型重选任务');
  // Image input is optional and approval-bound; the real callLLM/IPC bridge carries
  // pixels separately, while private checkpoints and the book keep pointers only.
  for (const rejectsImages of [false, true]) {
    await reset();
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRscAAAAASUVORK5CYII=';
    await writeFile(path.join(temp, 'documents', 'doc-choice.md'), `${original}\n\n![原始公式图](${png})`);
    storage.set('loginote_llm_settings', JSON.stringify({ ...llmSettings,
      providers: [{ ...llmSettings.providers[0], visionModels: ['mock'] }] }));
    bridge.ragDocs.materialImage = (input: any) => materialResult(() => readMaterialImage(input));
    const imageJob = await prepared(); const ipcRequests: any[] = [];
    bridge.llm = { request: async (input: any) => {
      ipcRequests.push(input);
      if (input.images?.length && rejectsImages) throw new Error('LLM_IMAGE_UNSUPPORTED: synthetic provider rejects images');
      assert.ok(!input.userInput.includes('data:image/'));
      const data = JSON.parse(input.userInput);
      if (input.images?.length) {
        assert.equal(input.provider.visionModels[0], 'mock'); assert.equal(input.images[0].dataUrl, png);
        assert.equal(data.visualInput[0].status, 'attached');
      }
      return fixtureModel({ workflow: data.catalogs ? 'textbook-blueprint' : input.systemPrompt.includes('当前一章')
        ? 'textbook-chapter' : input.systemPrompt.includes('只读质量复核员') ? 'textbook-quality' : 'textbook-blueprint',
        userInput: input.userInput, systemPromptOverride: input.systemPrompt, maxTokensOverride: input.maxTokens, tokenBudgetMode: input.tokenBudgetMode, thinkingPreference: input.thinkingPreference,
        skipMemoryInjection: true, skipProfileInjection: true } as LlmCallRequest);
    } };
    await generateTextbook(ctx, imageJob.jobId, undefined, { ...deps, model: (request, signal, providerSnapshot) => callLLM(request, { signal, providerSnapshot }) });
    const imageState = (await command({ op: 'get', jobId: imageJob.jobId })).job;
    assert.equal(imageState.stage, 'published');
    assert.ok(imageState.checkpoint.body!.includes('## 资料原图'));
    assert.ok(!JSON.stringify(imageState).includes('data:image/'));
    assert.equal(ipcRequests.length, rejectsImages ? 6 : 5);
    assert.equal(ipcRequests.filter(input => input.images?.length).length, rejectsImages ? 1 : 4);
    assert.equal(imageState.checkpoint.cost!.requests, rejectsImages ? 6 : 5);
    if (rejectsImages) {
      assert.equal(imageState.checkpoint.visionFallbackModels!.length, 1);
      assert.ok(ipcRequests.slice(2).every(input => !input.images));
    }
    storage.set('loginote_llm_settings', JSON.stringify(llmSettings)); delete bridge.llm;
    await writeFile(path.join(temp, 'documents', 'doc-choice.md'), original);
    pass(rejectsImages ? '视觉接口明确拒绝后仅一次文字降级，后续阶段不再试图传图；请求预算照计，原图展示和已有章节保留'
      : '真实生成→callLLM→IPC独立附图；像素不进正文/检查点；纯文字章节自动保留原图展示且无额外识图阶段');
  }
  for (const recordMode of ['current', 'legacy'] as const) for (const rejectAt of ['initial', 'retry'] as const)
  for (const target of ['blueprint', 'chapter'] as const) for (const outcome of ['network', 'exhausted'] as const) {
    await reset();
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRscAAAAASUVORK5CYII=';
    await writeFile(path.join(temp, 'documents', 'doc-choice.md'), `${original}\n\n![原始公式图](${png})`);
    storage.set('loginote_llm_settings', JSON.stringify({ ...llmSettings,
      providers: [{ ...llmSettings.providers[0], visionModels: ['mock'] }] }));
    let imageReads = 0;
    bridge.ragDocs.materialImage = (input: any) => { if (!input.saveAttachment) imageReads++; return materialResult(() => readMaterialImage(input)); };
    try {
      const imageJob = await prepared(); const seen: LlmCallRequest[] = []; let textRequests = 0; let imageRequests = 0;
      if (recordMode === 'legacy') {
        const stored = (await command({ op: 'get', jobId: imageJob.jobId })).job;
        stored.spec.promptVersion = 2;
        await atomicWriteTextFile(path.join(stateDir, 'textbook-jobs', imageJob.jobId + '.json'), JSON.stringify(stored));
      }
      const isTarget = (request: LlmCallRequest) => modelStage(request) === target
        && (target === 'blueprint' || fixtureInput(request).chapter.id === 'ch2');
      const truncated = (request: LlmCallRequest) => ({ content: '{"DO_NOT_PERSIST_PARTIAL":', diagnostics: { finishReason: 'length' },
        usage: { promptTokens: 100, completionTokens: request.maxTokensOverride! } });
      const interrupted = { ...deps, model: async (request: LlmCallRequest) => {
        seen.push(structuredClone(request));
        if (!isTarget(request)) return fixtureModel(request);
        if (request.images?.length) {
          imageRequests++;
          if (rejectAt === 'retry' && imageRequests === 1) return truncated(request);
          throw new Error('LLM_IMAGE_UNSUPPORTED: synthetic image rejection');
        }
        textRequests++;
        if (textRequests === (rejectAt === 'initial' ? 2 : 1) && outcome === 'network') throw new Error('synthetic fallback upper-budget interruption');
        return truncated(request);
      } };
      await assert.rejects(generateTextbook(ctx, imageJob.jobId, undefined, interrupted), outcome === 'network'
        ? /synthetic fallback upper-budget interruption/u : /同一输入已达到重试上限/u);
      const before = (await command({ op: 'get', jobId: imageJob.jobId })).job;
      const budget = before.spec.modelPolicy.stages[target];
      assert.deepEqual(seen.filter(isTarget).map(request => request.maxTokensOverride), rejectAt === 'initial'
        ? [budget.maxTokens, budget.maxTokens, budget.retryMaxTokens] : [budget.maxTokens, budget.retryMaxTokens, budget.retryMaxTokens]);
      assert.equal(seen.filter(request => isTarget(request) && request.images?.length).length, rejectAt === 'initial' ? 1 : 2);
      if (target === 'chapter') assert.equal(before.checkpoint.chapters!.length, 1);
      assert.ok(!JSON.stringify(before).includes('DO_NOT_PERSIST_PARTIAL'));
      assert.ok(!JSON.stringify(before).includes('data:image/'));
      if (recordMode === 'legacy') {
        // Reproduce the exact pre-fix on-disk format: the image transport's hash
        // remained on the text-only response. All other data stays untouched.
        const request = seen.filter(isTarget)[0];
        const { visualInput, ...input } = fixtureInput(request);
        if (input.context) input.context = { ...input.context, warnings: [],
          mastery: input.context.mastery.rows?.map((row: any) => ({ noteId: row.noteId, title: row.title, mastery: row.mastery, reviewCount: row.reviewCount })) };
        const originalHash = await textbookHash({ workflow: request.workflow, prompt: request.systemPromptOverride, input,
          budget: textbookRequestBudget(before.spec.modelPolicy, target, before.checkpoint.blueprint, target === 'chapter' ? 'ch2' : undefined),
          providerHash: before.spec.providerHash, visualInput });
        const diagnostic = before.checkpoint.modelAttempts!.find(item => item.stage === target && item.chapterId === (target === 'chapter' ? 'ch2' : undefined))!;
        assert.notEqual(diagnostic.inputHash, originalHash);
        diagnostic.inputHash = originalHash;
        await atomicWriteTextFile(path.join(stateDir, 'textbook-jobs', imageJob.jobId + '.json'), JSON.stringify(before));
      }
      store = new TextbookStore(stateDir); imageReads = 0;
      const resumed: LlmCallRequest[] = [];
      const resumedDeps = { ...deps, model: async (request: LlmCallRequest) => { resumed.push(structuredClone(request)); return fixtureModel(request); } };
      if (outcome === 'network') {
        await freshlyApprovedGenerate(imageJob.jobId, undefined, resumedDeps);
        assert.ok(isTarget(resumed[0]));
        assert.equal(resumed[0].maxTokensOverride, budget.retryMaxTokens, '文字降级后重启须保留已发生的截断次数');
        assert.equal(resumed[0].userInput, seen.find(request => isTarget(request) && !request.images)?.userInput);
        assert.equal(resumed.filter(isTarget).length, 1);
        assert.equal(savedCount, 1);
      } else {
        for (let reopen = 0; reopen < 2; reopen++) {
          store = new TextbookStore(stateDir);
          await assert.rejects(freshlyApprovedGenerate(imageJob.jobId, undefined, resumedDeps), /同一输入已达到重试上限/u);
        }
        assert.equal(resumed.length, 0);
        assert.deepEqual((await command({ op: 'get', jobId: imageJob.jobId })).job.checkpoint.cost, before.checkpoint.cost);
        assert.equal(savedCount, 0);
      }
      assert.ok(resumed.every(request => !request.images));
      assert.equal(imageReads, recordMode === 'legacy' ? 1 : 0, '旧记录仅本地迁移读图一次；新记录直接续跑，均不重发图片');
      if (target === 'chapter') assert.deepEqual((await command({ op: 'get', jobId: imageJob.jobId })).job.checkpoint.chapters![0], before.checkpoint.chapters![0]);
      pass(`${recordMode}/${rejectAt}图片拒收→文字降级→${target}截断→${outcome}→重启：保留上限与次数、已有章节和完整费用，不重发图片`);
    } finally {
      storage.set('loginote_llm_settings', JSON.stringify(llmSettings));
      await writeFile(path.join(temp, 'documents', 'doc-choice.md'), original);
    }
  }
  await reset();
  const reusePair = await Promise.all([prepared(), prepared()]);
  assert.equal(reusePair[0].jobId, reusePair[1].jobId);
  assert.equal((await store.list('project-a')).length, 1); assert.equal(modelCalls, 0); assert.equal(savedCount, 0);
  const firstReuse = await command({ op: 'get', jobId: reusePair[0].jobId });
  const activeReuse = await command({ op: 'claim', jobId: firstReuse.job.id });
  const whileRunning = await prepareTextbook(ctx, { allowedDocIds: ['doc-choice'] }, deps) as { jobId: string; status: string; reused: boolean };
  assert.equal(whileRunning.jobId, firstReuse.job.id); assert.equal(whileRunning.status, 'textbook_job_running'); assert.equal(whileRunning.reused, true);
  await assert.rejects(command({ op: 'create', reuseExisting: true, spec: { ...firstReuse.job.spec, planningHash: 'd'.repeat(64) } }), /已有不同范围.*正在执行/u);
  await command({ op: 'stop', jobId: firstReuse.job.id, token: activeReuse.token!, cancelled: true, error: 'synthetic stop' });
  store = new TextbookStore(stateDir);
  assert.equal((await prepared()).jobId, firstReuse.job.id);
  pass('真实 prepare→原子 Store：并发重复准备只创建一个任务；运行中返回同任务不再启动，范围不同须先停止，重启后仍复用原 jobId');

  const oldLease = await command({ op: 'claim', jobId: firstReuse.job.id });
  oldLease.job.checkpoint = structuredClone(extraSaved.checkpoint);
  recordTextbookFailure(oldLease.job, [{ stage: 'chapters', chapterId: 'ch2', section: 'summaryTable' as never, message: decoderError }]);
  oldLease.job.checkpoint.sectionRepairs = { ch2: ['summaryTable' as never] };
  oldLease.job.checkpoint.cost!.repairRounds = 2; oldLease.job.checkpoint.cost!.stopped = 'repairs';
  await command({ op: 'checkpoint', jobId: oldLease.job.id, token: oldLease.token!, stage: 'validating', checkpoint: oldLease.job.checkpoint });
  await command({ op: 'stop', jobId: oldLease.job.id, token: oldLease.token!, cancelled: false, error: decoderError });
  const legacyDuplicate = await command({ op: 'create', spec: firstReuse.job.spec });
  // Reopen exactly as the app does, with a newer but less complete duplicate.
  store = new TextbookStore(stateDir);
  const jobsBeforeReuse = await store.list('project-a');
  assert.equal(jobsBeforeReuse.find(job => job.preferred)!.jobId, firstReuse.job.id);
  assert.equal(jobsBeforeReuse[0].progress!.completed, 2); assert.equal(jobsBeforeReuse[0].progress!.resumeAfterCodeFix, true);
  const beforeReuseRaw = JSON.stringify((await command({ op: 'get', jobId: firstReuse.job.id })).job);
  const recoveredPrepare = await prepareTextbook(ctx, { allowedDocIds: ['doc-choice'] }, deps) as { jobId: string; reused: boolean; progress: TextbookProgress };
  assert.equal(recoveredPrepare.jobId, firstReuse.job.id); assert.equal(recoveredPrepare.reused, true);
  assert.equal(recoveredPrepare.progress.completed, 2); assert.equal(recoveredPrepare.progress.currentStage, 'validating');
  assert.match(textbookConfirmation(recoveredPrepare.jobId).title, /继续/u);
  assert.ok(textbookConfirmation(recoveredPrepare.jobId).description.includes('2/2'));
  assert.equal(JSON.stringify((await command({ op: 'get', jobId: firstReuse.job.id })).job), beforeReuseRaw);
  assert.equal((await store.list('project-a')).length, 2); assert.equal(modelCalls, 0);
  const runningNew = await command({ op: 'claim', jobId: legacyDuplicate.job.id });
  assert.equal((await prepared()).jobId, legacyDuplicate.job.id);
  assert.equal((await store.list('project-a')).find(job => job.preferred)!.jobId, legacyDuplicate.job.id);
  await command({ op: 'stop', jobId: legacyDuplicate.job.id, token: runningNew.token!, cancelled: true, error: 'synthetic duplicate stopped' });
  assert.equal((await prepared()).jobId, firstReuse.job.id);
  const reusedRequests: string[] = [];
  await freshlyApprovedGenerate(firstReuse.job.id, undefined, { ...deps, model: async request => { reusedRequests.push(request.workflow); return fixtureModel(request); } });
  assert.deepEqual(reusedRequests, ['textbook-quality']);
  const restoredOriginal = (await command({ op: 'get', jobId: firstReuse.job.id })).job;
  assert.equal(restoredOriginal.stage, 'published'); assert.equal(restoredOriginal.checkpoint.cost!.repairRounds, 2);
  assert.deepEqual(restoredOriginal.checkpoint.chapters, extraSaved.checkpoint.chapters);
  pass('截图复现：旧完整草稿+新空任务→重启/重复准备均优先原稿，运行任务不被抢占；确认后只调用质量复核，旧章节和已耗修订次数不变');

  await reset(); const scopedReuse = await prepared();
  const sameScope = (await command({ op: 'get', jobId: scopedReuse.jobId })).job.spec;
  for (const change of [{ planningHash: 'c'.repeat(64) }, { providerHash: 'c'.repeat(64) }, { allowCloud: !sameScope.allowCloud },
    { documentHashes: { 'doc-choice': 'c'.repeat(64) } }, { knowledgeHashes: { 'knowledge-choice': 'c'.repeat(64) } },
    { modelPolicy: defaultTextbookModelPolicy(3) }, { readBoundUrls: true, boundUrls: [{ id: 'U1', title: '合成', url: 'https://example.com/test' }] }]) {
    const different = await command({ op: 'create', reuseExisting: true, spec: { ...sameScope, ...change } });
    assert.notEqual(different.job.id, scopedReuse.jobId); assert.notEqual(different.reused, true);
  }
  const cappedLease = await command({ op: 'claim', jobId: scopedReuse.jobId });
  cappedLease.job.checkpoint.cost = { promptTokens: 0, completionTokens: 0, reservedTokens: 0, requests: 30, repairRounds: 2, reviewRechecks: 2, legacyUsageIncomplete: false, stopped: 'requests' };
  await command({ op: 'checkpoint', jobId: scopedReuse.jobId, token: cappedLease.token!, stage: 'materials', checkpoint: cappedLease.job.checkpoint });
  await command({ op: 'stop', jobId: scopedReuse.jobId, token: cappedLease.token!, cancelled: false, error: 'synthetic genuine budget exhaustion' });
  assert.equal((await prepared()).jobId, scopedReuse.jobId);
  await assert.rejects(freshlyApprovedGenerate(scopedReuse.jobId), /达到上限/u);
  assert.equal(modelCalls, 0); assert.equal((await command({ op: 'get', jobId: scopedReuse.jobId })).job.checkpoint.cost!.requests, 30);
  pass('资料/模型/许可/策略/项目变化不会误复用；真实预算耗尽时重复准备也不另建任务或清零用量，零模型请求');
  await reset(); const targeted = await prepared();
  const fiveChapterModel = async (request: LlmCallRequest) => {
    const response = await fixtureModel(request);
    if (request.workflow === 'textbook-blueprint' && !fixtureInput(request).catalogs) {
      for (const id of ['ch3', 'ch4', 'ch5']) response.parsedJson.chapters.push({ ...structuredClone(response.parsedJson.chapters[1]), id, title: `应用章节 ${id}` });
    }
    return response;
  };
  await assert.rejects(generateTextbook(ctx, targeted.jobId, undefined, { ...deps, model: async request => {
    if (request.workflow === 'textbook-quality') throw new Error('synthetic review stopped before manual regeneration');
    return fiveChapterModel(request);
  } }), /synthetic review stopped/u);
  const fiveSaved = (await command({ op: 'get', jobId: targeted.jobId })).job;
  assert.equal(fiveSaved.checkpoint.chapters!.length, 5);
  const targetedSeed = await command({ op: 'claim', jobId: targeted.jobId });
  recordTextbookFailure(targetedSeed.job, [{ stage: 'chapters', chapterId: 'ch5', section: 'summaryTable' as never, message: decoderError }]);
  targetedSeed.job.checkpoint.cost!.repairRounds = 2; targetedSeed.job.checkpoint.cost!.stopped = 'repairs';
  await command({ op: 'checkpoint', jobId: targeted.jobId, token: targetedSeed.token!, stage: 'validating', checkpoint: targetedSeed.job.checkpoint });
  await command({ op: 'stop', jobId: targeted.jobId, token: targetedSeed.token!, cancelled: false, error: decoderError });
  const manualTool = getTool('regenerate_textbook_chapters')!;
  assert.ok(manualTool && toolRequiresApproval(manualTool, {}, ctx));
  assert.ok(AGENT_ROLES.default.skillToolCeiling!.includes(manualTool.name));
  assert.equal(selectAgentSkill('只重跑第5章')?.id, 'personalized-textbook');
  const beforeInvalidTarget = JSON.stringify((await command({ op: 'get', jobId: targeted.jobId })).job);
  await assert.rejects(generateTextbook(ctx, targeted.jobId, undefined, deps, ['missing-chapter']), /真实章节编号/u);
  assert.equal(JSON.stringify((await command({ op: 'get', jobId: targeted.jobId })).job), beforeInvalidTarget);
  const manualCalls: LlmCallRequest[] = [];
  const manualDeps = { ...deps, model: async (request: LlmCallRequest) => {
    manualCalls.push(request); const response = await fiveChapterModel(request);
    if (request.workflow === 'textbook-chapter') response.parsedJson.sections.selfCheck += '\n这是用户明确要求重跑后保留的自检提示。';
    return response;
  } };
  registerTool({ ...manualTool, execute: (args, runtime, execution) => generateTextbook(runtime, String(args.jobId), execution?.signal, manualDeps, args.chapterIds as string[]) });
  const manualPending = await runAgentTurn({ role: AGENT_ROLES.default, userText: '只重跑第5章', ctx, history: [], memoryPrefixLoader: async () => '',
    callLlm: async () => ({ content: '请确认只重跑末章', toolCalls: [{ id: 'manual-last-chapter', name: manualTool.name, arguments: { jobId: targeted.jobId, chapterIds: ['ch5'] } }] }) });
  assert.ok(manualPending.pendingApproval); assert.equal(manualCalls.length, 0);
  await resolveAgentApproval({ role: AGENT_ROLES.default, ctx, approval: manualPending.pendingApproval!, approved: false, history: manualPending.updatedHistory,
    callLlm: async () => ({ content: '未重跑章节' }) });
  assert.deepEqual((await command({ op: 'get', jobId: targeted.jobId })).job.checkpoint.chapters, fiveSaved.checkpoint.chapters);
  const manualApproved = await resolveAgentApproval({ role: AGENT_ROLES.default, ctx, approval: manualPending.pendingApproval!, approved: true, history: manualPending.updatedHistory,
    callLlm: async () => ({ content: '指定章节重跑后教材已写入' }) });
  assert.ok(manualApproved.toolTrace.some(step => step.call.name === manualTool.name && step.ok), JSON.stringify(manualApproved.toolTrace));
  assert.deepEqual(manualCalls.map(request => request.workflow), ['textbook-chapter', 'textbook-quality']);
  assert.equal(JSON.parse(manualCalls[0].userInput).chapter.id, 'ch5');
  const regenerated = (await command({ op: 'get', jobId: targeted.jobId })).job;
  assert.deepEqual(regenerated.checkpoint.chapters!.slice(0, 4), fiveSaved.checkpoint.chapters!.slice(0, 4));
  assert.deepEqual(regenerated.checkpoint.blueprint, fiveSaved.checkpoint.blueprint);
  assert.deepEqual(regenerated.checkpoint.chapterRegeneration!.previousChapters, fiveSaved.checkpoint.chapters!.slice(4));
  assert.deepEqual(regenerated.checkpoint.chapterRegeneration!.pendingIds, []);
  assert.equal(regenerated.checkpoint.cost!.requests, targetedSeed.job.checkpoint.cost!.requests + 2);
  assert.equal(regenerated.checkpoint.cost!.repairRounds, 2); assert.equal(regenerated.stage, 'published');
  await assert.rejects(command({ op: 'archive', jobId: targeted.jobId, archived: true }), /已发布教材/u);
  registerTool(manualTool);
  pass('真实 Agent 按章工具→独立确认：取消零改动；确认后仅生成第5章+复核，前四章/蓝图逐字不变，旧第5章备份，累计预算和自动修订次数不重置');

  // Published chapter revision: same durable Store/approval/save pipeline, no model/network.
  const publishedBefore = structuredClone(notes.find(note => note.id === 'project-a')!);
  const publishedRequests: LlmCallRequest[] = [];
  const publishedDeps = { ...deps, context: async () => { throw new Error('章节修订不得重新读取并替换原教学上下文'); },
    model: async (request: LlmCallRequest) => {
      publishedRequests.push(request);
      assert.equal(notes.find(note => note.id === 'project-a')!.content, publishedBefore.content, '生成和审核期间原教材仍可读');
      const response = await fiveChapterModel(request);
      if (request.workflow === 'textbook-chapter') response.parsedJson.sections.summary += '\n明确补充本章的适用边界，保持其它章节不变。';
      return response;
    } };
  registerTool({ ...manualTool, execute: (args, runtime, execution) => generateTextbook(runtime, String(args.jobId), execution?.signal,
    publishedDeps, args.chapterIds as string[], publishedBefore.textbook!.revisionId) });
  const revisionPending = await runAgentTurn({ role: AGENT_ROLES.default, userText: '把已发布教材的第2章重新生成，只改这一章', ctx, history: [], memoryPrefixLoader: async () => '',
    callLlm: async () => ({ content: '请确认只改第二章', toolCalls: [{ id: 'published-ch2', name: manualTool.name, arguments: { jobId: targeted.jobId, chapterIds: ['ch2'] } }] }) });
  assert.ok(revisionPending.pendingApproval); assert.equal(publishedRequests.length, 0);
  assert.match(revisionPending.pendingApproval!.items[0].description!, /仅重做所选章节/);
  await resolveAgentApproval({ role: AGENT_ROLES.default, ctx, approval: revisionPending.pendingApproval!, approved: false,
    history: revisionPending.updatedHistory, callLlm: async () => ({ content: '未修改' }) });
  assert.equal(publishedRequests.length, 0); assert.equal(notes.find(note => note.id === 'project-a')!.content, publishedBefore.content);
  const publishedApproved = await resolveAgentApproval({ role: AGENT_ROLES.default, ctx, approval: revisionPending.pendingApproval!, approved: true,
    history: revisionPending.updatedHistory, callLlm: async () => ({ content: '第二章已保存' }) });
  assert.ok(publishedApproved.toolTrace.some(step => step.call.name === manualTool.name && step.ok), JSON.stringify(publishedApproved.toolTrace));
  assert.deepEqual(publishedRequests.map(request => request.workflow), ['textbook-chapter', 'textbook-quality']);
  assert.equal(JSON.parse(publishedRequests[0].userInput).chapter.id, 'ch2');
  const revised = (await command({ op: 'get', jobId: targeted.jobId })).job;
  assert.equal(revised.stage, 'published'); assert.equal(revised.id, regenerated.id);
  assert.equal(revised.checkpoint.cost!.requests, regenerated.checkpoint.cost!.requests + 2);
  assert.equal(revised.checkpoint.cost!.repairRounds, regenerated.checkpoint.cost!.repairRounds);
  assert.equal(revised.checkpoint.publishedRevision!.originalPlanningHash, regenerated.spec.planningHash);
  assert.equal(revised.checkpoint.publishedRevision!.body.trim(), readTextbookBody(publishedBefore.content, publishedBefore.textbook!));
  for (const chapter of regenerated.checkpoint.chapters!.filter(chapter => chapter.id !== 'ch2'))
    assert.deepEqual(revised.checkpoint.chapters!.find(item => item.id === chapter.id), chapter);
  const publishedAfter = notes.find(note => note.id === 'project-a')!;
  assert.notEqual(publishedAfter.textbook!.revisionId, publishedBefore.textbook!.revisionId);
  assert.equal(publishedAfter.textbook!.generationJobId, publishedBefore.textbook!.generationJobId);
  assert.equal(stripTextbookRegion(publishedAfter.content, publishedAfter.textbook).outside, stripTextbookRegion(publishedBefore.content, publishedBefore.textbook).outside);
  assert.equal((await readDisk()).find(note => note.id === 'project-a')!.textbook!.revisionId, publishedAfter.textbook!.revisionId);
  pass('已发布教材真实Agent确认→只重生成中间第2章与复核→原子落盘；其它四章/目录/来源/私人记录不变，同任务累计预算保留');
  registerTool(manualTool);

  const beforeInterruptedRevision = structuredClone(publishedAfter);
  await assert.rejects(generateTextbook(ctx, targeted.jobId, undefined, { ...deps, model: async () => { throw new Error('synthetic published chapter interruption'); } }, ['ch5']), /synthetic published chapter interruption/);
  assert.equal(notes.find(note => note.id === 'project-a')!.content, beforeInterruptedRevision.content);
  const interruptedRevision = (await command({ op: 'get', jobId: targeted.jobId })).job;
  assert.equal(interruptedRevision.stage, 'failed'); assert.deepEqual(interruptedRevision.checkpoint.chapterRegeneration!.pendingIds, ['ch5']);
  store = new TextbookStore(stateDir);
  const revisionResumeCalls: string[] = [];
  await freshlyApprovedGenerate(targeted.jobId, undefined, { ...deps, model: async request => { revisionResumeCalls.push(request.workflow); return fiveChapterModel(request); } });
  assert.deepEqual(revisionResumeCalls, ['textbook-chapter', 'textbook-quality']);
  assert.equal((await command({ op: 'get', jobId: targeted.jobId })).job.stage, 'published');
  pass('已发布章节重生成中断→私有Store重启→原jobId重新确认续办；旧教材保持可读，只补指定章与复核');

  const untouchedPublished = structuredClone(notes.find(note => note.id === 'project-a')!);
  notes = notes.map(note => note.id === 'project-a' ? { ...note, content: note.content.replace('明确补充本章', '用户人工补充本章') } : note);
  await assert.rejects(generateTextbook(ctx, targeted.jobId, undefined, deps, ['ch2']), /人工修改/);
  assert.ok(notes.find(note => note.id === 'project-a')!.content.includes('用户人工补充本章'));
  notes = notes.map(note => note.id === 'project-a' ? untouchedPublished : note);
  const callsBeforeWrongRevision = modelCalls;
  await assert.rejects(generateTextbook(ctx, targeted.jobId, undefined, deps, ['ch2'], 'stale-revision'), /确认版本/);
  assert.equal(modelCalls, callsBeforeWrongRevision);
  pass('已发布教材被人工改动或确认版本过期时零模型调用，拒绝覆盖或重新读取旧焦点');
  const beforeLateEdit = structuredClone(notes.find(note => note.id === 'project-a')!);
  await assert.rejects(generateTextbook(ctx, targeted.jobId, undefined, { ...deps, model: async request => {
    const response = await fiveChapterModel(request);
    if (request.workflow === 'textbook-chapter') notes = notes.map(note => note.id === 'project-a'
      ? { ...note, content: note.content.replace('明确补充本章', '生成期间用户人工改动本章'), textbook: { ...note.textbook!, revisionId: 'user-late-edit' } } : note);
    return response;
  } }, ['ch5']), /变化/);
  assert.ok(notes.find(note => note.id === 'project-a')!.content.includes('生成期间用户人工改动本章'));
  assert.equal(notes.find(note => note.id === 'project-a')!.textbook!.revisionId, 'user-late-edit');
  notes = notes.map(note => note.id === 'project-a' ? beforeLateEdit : note);
  pass('已发布章节生成期间用户编辑教材，最终版本复核阻止覆盖，保留用户最新内容');

  await reset(); const interruptedManual = await prepared();
  const interruptedSeed = await command({ op: 'claim', jobId: interruptedManual.jobId });
  interruptedSeed.job.checkpoint = structuredClone(fiveSaved.checkpoint);
  await command({ op: 'checkpoint', jobId: interruptedManual.jobId, token: interruptedSeed.token!, stage: 'validating', checkpoint: interruptedSeed.job.checkpoint });
  await command({ op: 'stop', jobId: interruptedManual.jobId, token: interruptedSeed.token!, cancelled: true, error: 'synthetic existing draft' });
  await assert.rejects(generateTextbook(ctx, interruptedManual.jobId, undefined, { ...deps, model: async () => { throw new Error('synthetic manual chapter network interruption'); } }, ['ch5']), /synthetic manual chapter/u);
  const interruptedDraft = (await command({ op: 'get', jobId: interruptedManual.jobId })).job;
  assert.deepEqual(interruptedDraft.checkpoint.chapterRegeneration!.pendingIds, ['ch5']);
  assert.deepEqual(interruptedDraft.checkpoint.chapters, fiveSaved.checkpoint.chapters!.slice(0, 4));
  assert.deepEqual(interruptedDraft.checkpoint.chapterRegeneration!.previousChapters, fiveSaved.checkpoint.chapters!.slice(4));
  store = new TextbookStore(stateDir);
  const resumedManualCalls: LlmCallRequest[] = [];
  await freshlyApprovedGenerate(interruptedManual.jobId, undefined, { ...deps, model: async request => { resumedManualCalls.push(request); return fiveChapterModel(request); } });
  assert.deepEqual(resumedManualCalls.map(request => request.workflow), ['textbook-chapter', 'textbook-quality']);
  assert.equal(JSON.parse(resumedManualCalls[0].userInput).chapter.id, 'ch5');
  pass('指定末章网络中断→重启→同任务继续：仅补第5章和复核，前四章与旧末章备份均保留，不重跑蓝图或重新搜集');

  await reset(); const archiveFixture = await prepared(); const archiveDefinition = getTool('archive_textbook_job')!;
  assert.ok(archiveDefinition && toolRequiresApproval(archiveDefinition, {}, ctx));
  const archiveLease = await command({ op: 'claim', jobId: archiveFixture.jobId });
  await assert.rejects(command({ op: 'archive', jobId: archiveFixture.jobId, archived: true }), /仍在运行/u);
  archiveLease.job.checkpoint = structuredClone(fiveSaved.checkpoint);
  await command({ op: 'checkpoint', jobId: archiveFixture.jobId, token: archiveLease.token!, stage: 'validating', checkpoint: archiveLease.job.checkpoint });
  await command({ op: 'stop', jobId: archiveFixture.jobId, token: archiveLease.token!, cancelled: true, error: 'synthetic stopped duplicate' });
  const beforeArchive = (await command({ op: 'get', jobId: archiveFixture.jobId })).job;
  const archiveCall = { id: 'archive-fixture-call', name: archiveDefinition.name, arguments: { jobId: archiveFixture.jobId, archived: true } };
  const archiveBinding = await createAgentApprovalBinding(archiveCall, ctx);
  await validateAgentApprovalBinding({ call: archiveCall, binding: archiveBinding } as never, ctx);
  const archiveResult = await archiveDefinition.execute(archiveCall.arguments, ctx) as { status: string; chaptersRetained: number };
  assert.equal(archiveResult.status, 'archived'); assert.equal(archiveResult.chaptersRetained, 5);
  const archivedRaw = (await command({ op: 'get', jobId: archiveFixture.jobId })).job;
  assert.deepEqual(archivedRaw.checkpoint, beforeArchive.checkpoint);
  await assert.rejects(command({ op: 'claim', jobId: archiveFixture.jobId }), /已归档/u);
  const archivedPrepare = await prepareTextbook(ctx, { allowedDocIds: ['doc-choice'] }, deps) as { status: string; jobId: string };
  assert.equal(archivedPrepare.status, 'textbook_job_archived'); assert.equal(archivedPrepare.jobId, archiveFixture.jobId);
  ((globalThis as any).window.electronAPI.agent ||= {}).reviewQueue = async () => ({ items: [] });
  const archiveState = await queryTextbookState(ctx) as { resumableJobs: unknown[]; archivedJobs: unknown[] };
  assert.equal(archiveState.resumableJobs.length, 0); assert.equal(archiveState.archivedJobs.length, 1);
  store = new TextbookStore(stateDir);
  await archiveDefinition.execute({ jobId: archiveFixture.jobId, archived: false }, ctx);
  assert.equal((await prepared()).jobId, archiveFixture.jobId);
  assert.deepEqual((await command({ op: 'get', jobId: archiveFixture.jobId })).job.checkpoint, beforeArchive.checkpoint);
  assert.equal(modelCalls, 0); assert.equal(savedCount, 0);
  pass('归档/恢复工具需确认；运行中拒绝归档，已发布拒绝清理；私有五章/来源/用量原样保留，归档隐藏且可恢复，同范围重新准备不绕过预算');
  await reset(); const compatibilityFixture = await prepared(); mode = 'compatibility-preflight-failure';
  await assert.rejects(freshlyApprovedGenerate(compatibilityFixture.jobId), /富文本兼容性检查未通过/u);
  const retainedCompatibility = (await command({ op: 'get', jobId: compatibilityFixture.jobId })).job;
  assert.equal(retainedCompatibility.checkpoint.chapters!.length, 2);
  assert.equal(retainedCompatibility.checkpoint.quality!.passed, true);
  assert.equal(retainedCompatibility.checkpoint.repair, undefined);
  assert.ok(retainedCompatibility.checkpoint.chapters![0].sections.explanation.includes('k<1/9'));
  assert.ok(retainedCompatibility.checkpoint.body!.includes(String.raw`k\<1/9`));
  assert.equal(savedCount, 0); assert.equal(publicationSaveCalls, 0); assert.equal(notes.find(item => item.id === 'project-a')!.textbook, undefined);
  const compatibilityCalls = modelCalls;
  mode = 'normal';
  await freshlyApprovedGenerate(compatibilityFixture.jobId);
  const recoveredCompatibility = (await command({ op: 'get', jobId: compatibilityFixture.jobId })).job;
  assert.equal(modelCalls, compatibilityCalls, 'A local import failure must not regenerate chapters, blueprint or semantic review');
  assert.deepEqual(recoveredCompatibility.checkpoint.chapters, retainedCompatibility.checkpoint.chapters);
  assert.deepEqual(recoveredCompatibility.checkpoint.cost, retainedCompatibility.checkpoint.cost);
  assert.equal(savedCount, 1);
  assert.ok(notes.find(item => item.id === 'project-a')!.content.includes(String.raw`k\<1/9`));
  pass('裸写不等式仅在组装正文时本地转义；发布预检失败零落盘、原稿/复核/用量保留，修复后同任务继续零额外模型请求');
  await reset();
  notes = notes.map(item => item.id === 'root-a' ? { ...item, resources: [
    { title: '父项目整本教材', url: 'loginote-document://doc-choice', documentId: 'doc-choice', kind: 'local' as const },
    { title: '父项目网页不继承', url: 'https://parent-only.invalid/book', kind: 'online' as const },
  ] } : item);
  await saveVaultSnapshot(vault, stateDir, notes);
  const inheritedJob = await prepareTextbook(ctx, {}, deps) as { jobId: string };
  const inheritedRaw = (await command({ op: 'get', jobId: inheritedJob.jobId })).job;
  assert.deepEqual(inheritedRaw.spec.allowedDocIds, ['doc-choice']);
  assert.deepEqual(inheritedRaw.spec.boundUrls, []);
  assert.equal(inheritedRaw.spec.readBoundUrls, false);
  assert.ok(inheritedRaw.spec.sourceTitles!.some(title => title.includes('继承自项目')));
  notes = notes.map(item => item.id === 'root-a' ? { ...item, content: '父项目新增无关备注，不中断子项目任务' } : item);
  await saveVaultSnapshot(vault, stateDir, notes);
  await freshlyApprovedGenerate(inheritedJob.jobId);
  assert.equal((await command({ op: 'get', jobId: inheritedJob.jobId })).job.stage, 'published');
  assert.equal(notes.find(item => item.id === 'project-a')!.textbook?.generationJobId, inheritedJob.jobId);
  assert.deepEqual(notes.find(item => item.id === 'project-a')!.resources, undefined, 'inheritance never copies bindings into children');
  pass('父项目本地教材默认继承→目录选材→实际保存发布，父级无关正文变更不取消；父项目网页不继承、子项目不复制绑定');
  const inheritedPublishedBefore = structuredClone(notes.find(item => item.id === 'project-a')!);
  const inheritedCompletedJob = (await command({ op: 'get', jobId: inheritedJob.jobId })).job;
  const inheritedCallsBefore = modelCalls;
  notes = notes.map(item => item.id === 'root-a' ? { ...item, resources: [] } : item);
  await saveVaultSnapshot(vault, stateDir, notes);
  await assert.rejects(generateTextbook(ctx, inheritedJob.jobId, undefined, deps, ['ch2']), /变化|重新准备/);
  await assert.rejects(command({ op: 'claim', jobId: inheritedJob.jobId,
    publishedRevision: { expectedRevisionId: inheritedPublishedBefore.textbook!.revisionId, chapterIds: ['ch2'] } }), /继承资料绑定已变化/);
  assert.equal(modelCalls, inheritedCallsBefore);
  assert.deepEqual((await command({ op: 'get', jobId: inheritedJob.jobId })).job, inheritedCompletedJob);
  assert.equal(notes.find(item => item.id === 'project-a')!.content, inheritedPublishedBefore.content);
  pass('已发布教材按章重生成仍遵守父级资料解绑：运行时与原子Store均零请求拒绝，旧教材/预算/任务原样保留');
  await reset();
  notes = notes.map(item => item.id === 'root-a' ? { ...item, resources: [
    { title: '父项目整本教材', url: 'loginote-document://doc-choice', documentId: 'doc-choice', kind: 'local' as const },
  ] } : item);
  await saveVaultSnapshot(vault, stateDir, notes);
  const revokedInheritance = await prepareTextbook(ctx, {}, deps) as { jobId: string };
  notes = notes.map(item => item.id === 'root-a' ? { ...item, resources: [] } : item);
  await saveVaultSnapshot(vault, stateDir, notes);
  await assert.rejects(freshlyApprovedGenerate(revokedInheritance.jobId), /已变化|重新准备/u);
  assert.equal(modelCalls, 0); assert.equal(savedCount, 0);
  assert.equal(notes.find(item => item.id === 'project-a')!.textbook, undefined);
  pass('批准的继承资料被解绑后，原任务零模型请求、零发布并要求重新准备，不恢复旧授权或扫描其它项目');
  // Production composite adapter + real private child Store + real source reader
  // and real callLLM. Only IPC/model replies and the fixture note-save port are fake.
  let compositeScopeNumber = 0;
  function installCompositeBridge(holdSecondChapter = false) {
    const bridge = (globalThis as any).window.electronAPI;
    const owner = `composite-fixture-${++compositeScopeNumber}`;
    let taskState: AgentTaskState | null = null;
    const counters = { tasks: 0, concepts: 0, documents: 0, textbook: 0 };
    const entered = deferred(); let hold = holdSecondChapter;
    const pending = new Map<string, (reason: Error) => void>();
    bridge.userState = { ...bridge.userState, getAgentTaskScope: async () => owner,
      loadAgentTaskState: async () => ({ scopeId: owner, state: taskState }),
      saveAgentTaskState: async (scopeId: string, patch: any) => { assert.equal(scopeId, owner); taskState = applyAgentTaskStatePatch(taskState, patch); } };
    bridge.ragDocs.search = async (_query: string, _k: number, scope: any) => {
      counters.documents++; assert.deepEqual(scope.allowedDocIds, ['doc-choice']);
      return [{ docId: 'doc-choice', fileName: 'choice.md', snippet: original, score: 1, chunkId: 'choice#0', sectionPath: '选择过载效应' }];
    };
    bridge.llm = { cancel: async (id: string) => { pending.get(id)?.(new Error('synthetic model cancelled')); },
      request: async (request: any): Promise<LlmCallResponse> => {
        let result: unknown;
        if (request.userInput.startsWith('【笔记信息】')) {
          counters.tasks++; result = { tasks: ['解释 [[选择过载效应]] 的成立条件', '比较 [[选择过载效应]] 的边界反例', '用实例验证 [[选择过载效应]]'] };
        } else if (request.userInput.startsWith('【术语】')) {
          counters.concepts++; assert.ok(request.userInput.includes('本地资料'));
          return { content: '# 选择过载效应\n\n选择过载是受到偏好清晰度、任务复杂度与时间压力影响的决策现象，选项增加并不必然降低满意度。[1]' };
        } else {
          counters.textbook++; const input = fixtureInput(request);
          if (input.catalogs) result = { selections: [{ docId: input.catalogs[0].docId, sectionId: input.catalogs[0].sectionId }] };
          else if (input.chapter) {
            if (hold && input.chapter.id === 'ch2') { hold = false; entered.resolve(); await new Promise<void>((_resolve, reject) => { pending.set(request.requestId, reject); }); }
            const citation = `[${input.chapter.sourceIds[0]}]`;
            const sections = { explanation: `选择过载需要结合偏好、时间与任务复杂度判断，不是选项数量的必然结果。${citation}`,
              boundaries: `熟悉商品且比较简单时，更多选项不一定造成困难，判断需要保留这些条件。${citation}`,
              workedExample: `比较熟悉饮料与复杂保险的认知负担不同，不能仅按选项总数推断结果。${citation}`,
              practice: '请比较熟悉商品与复杂保险两种情境，说明偏好信息如何影响决策。',
              answer: `偏好是否清晰、比较是否复杂都会影响决策难度，结论不能绝对化。${citation}`,
              selfCheck: '可以说明成立条件与反例，并用完整理由判断新的情境，而非只背定义。', summary: '本章结合条件与反例解释选择过载，并将判断方法用于具体决策情境。' };
            if (input.chapter.writingPlan) for (const key of Object.keys(sections) as Array<keyof typeof sections>) if (!input.chapter.writingPlan.sections.includes(key)) sections[key] = '';
            result = { id: input.chapter.id, sections };
          } else if (!input.blueprint) result = { title: '选择过载的条件与迁移', objectives: [{ id: 'O1', text: '解释条件并判断反例' }], focuses: [],
            chapters: ['ch1', 'ch2'].map(id => ({ id, title: id === 'ch1' ? '概念条件' : '边界迁移', objectiveIds: ['O1'], focusIds: [], sourceIds: input.sources.map((source: any) => source.sourceId), bridge: '根据原文条件逐步理解并核对反例。' })) };
          else result = { schemaVersion: 3, passed: true, findings: [] };
        }
        return { content: JSON.stringify(result), parsedJson: result };
      } };
    const apply = async (change: Parameters<typeof applyWorkspaceNoteChange>[1]) => {
      const candidate = applyWorkspaceNoteChange(notes, change); await saveVaultSnapshot(vault, stateDir, candidate); notes = candidate;
      return { saved: true, operationId: `fixture-${Date.now()}`, changedNoteIds: change.after.map(note => note.id), changedTitles: change.after.map(note => note.title), recoveryStatus: 'saved' as const };
    };
    const context = { ...ctx, getActiveNote: () => notes.find(note => note.id === 'project-b')!, applyWorkspaceNoteChange: apply,
      applyConceptBatchChange: async (change: Parameters<typeof apply>[0], scope: string) => { assert.equal(scope, owner); return apply(change); } } as AgentRuntimeContext;
    return { counters, context, entered, state: () => taskState };
  }
  async function resetComposite(bound: boolean) {
    await reset();
    notes = notes.filter(note => note.noteType !== 'knowledge').map(note => note.id === 'project-a' ? { ...note, content: '原有手工备注，不得覆盖。' }
      : note.id === 'root-a' && bound ? { ...note, resources: [{ title: '整本教材', url: 'loginote-document://doc-choice', documentId: 'doc-choice', kind: 'local' as const }] } : note);
    await saveVaultSnapshot(vault, stateDir, notes);
  }
  await resetComposite(true);
  const composite = installCompositeBridge();
  const whole = await backgroundWorkflows.prepare({ projectNoteIds: ['project-a'], steps: ['textbook'] }, composite.context);
  assert.deepEqual(composite.counters, { tasks: 0, concepts: 0, documents: 0, textbook: 0 });
  await backgroundWorkflows.start(whole.id, composite.context); await backgroundWorkflows.waitForIdle();
  const completedWhole = backgroundWorkflows.getSnapshot().find(job => job.id === whole.id)!;
  assert.equal(completedWhole.status, 'completed', JSON.stringify(completedWhole));
  assert.equal(composite.counters.tasks, 1); assert.equal(composite.counters.concepts, 1);
  assert.ok(notes.find(note => note.id === 'project-a')!.content.includes('原有手工备注，不得覆盖。'));
  assert.ok((await readDisk()).find(note => note.id === 'project-a')!.textbook);
  assert.equal(notes.find(note => note.id === 'project-b')!.textbook, undefined);
  assert.ok(completedWhole.projects[0].steps.every(step => step.status === 'completed' && step.receipt));
  pass('真实组合适配器：任务工作流→限定本地RAG→概念保存审核→教材准备/生成/质量门控/磁盘保存；页面焦点在另一项目也不串写');
  await resetComposite(false); const noMaterials = installCompositeBridge();
  const lacking = await backgroundWorkflows.prepare({ projectNoteIds: ['project-a'], steps: ['textbook'] }, noMaterials.context);
  await backgroundWorkflows.start(lacking.id, noMaterials.context); await backgroundWorkflows.waitForIdle();
  const blocked = backgroundWorkflows.getSnapshot().find(job => job.id === lacking.id)!;
  assert.equal(blocked.status, 'blocked'); assert.equal(noMaterials.counters.tasks, 1);
  assert.equal(noMaterials.counters.documents, 0); assert.equal(noMaterials.counters.concepts, 0); assert.equal(noMaterials.counters.textbook, 0);
  assert.equal(notes.filter(note => note.noteType === 'knowledge').length, 0);
  assert.ok(blocked.projects[0].steps[1].error!.includes('未搜索全库'));
  notes.push(note('placeholder-only', '选择过载效应', KNOWLEDGE_PLACEHOLDER, 'knowledge'));
  await assert.rejects(prepareTextbook(noMaterials.context, { projectNoteId: 'project-a', allowedDocIds: [], readBoundUrls: false }, deps), /没有可用教材物料/u);
  pass('无绑定本地资料即使全库有文档也不调用检索/概念/教材，不自动资源统筹；初始化占位正文不能冒充教材来源');
  await resetComposite(true); const interruptedComposite = installCompositeBridge(true);
  const stoppable = await backgroundWorkflows.prepare({ projectNoteIds: ['project-a'], steps: ['textbook'] }, interruptedComposite.context);
  await backgroundWorkflows.start(stoppable.id, interruptedComposite.context); await interruptedComposite.entered.promise;
  await backgroundWorkflows.stop(stoppable.id); await backgroundWorkflows.waitForIdle();
  const stoppedWhole = backgroundWorkflows.getSnapshot().find(job => job.id === stoppable.id)!;
  assert.equal(stoppedWhole.status, 'paused'); assert.equal(stoppedWhole.projects[0].steps[0].status, 'completed');
  const childId = stoppedWhole.projects[0].steps[2].childJobId!;
  const beforeContinue = (await command({ op: 'get', jobId: childId })).job;
  assert.equal(beforeContinue.checkpoint.chapters!.length, 1);
  store = new TextbookStore(stateDir);
  await backgroundWorkflows.start(stoppable.id, interruptedComposite.context); await backgroundWorkflows.waitForIdle();
  assert.equal(backgroundWorkflows.getSnapshot().find(job => job.id === stoppable.id)!.status, 'completed');
  assert.equal(interruptedComposite.counters.tasks, 1); assert.equal(interruptedComposite.counters.concepts, 1);
  assert.equal(notes.find(note => note.id === 'project-a')!.textbook!.generationJobId, childId);
  assert.deepEqual((await command({ op: 'get', jobId: childId })).job.checkpoint.chapters![0], beforeContinue.checkpoint.chapters![0]);
  pass('组合流程停止传播至真实教材IPC请求；原私有Store重开后同任务确认续办，仅补剩余章，任务/概念/已存首章零重复');
  await resetComposite(true); const uncertainComposite = installCompositeBridge();
  const originalApply = uncertainComposite.context.applyWorkspaceNoteChange!; let rejectTaskReceipt = true;
  uncertainComposite.context.applyWorkspaceNoteChange = async change => {
    const result = await originalApply(change);
    if (rejectTaskReceipt && change.after.some(note => note.noteType === 'project')) { rejectTaskReceipt = false; throw new Error('synthetic task save acknowledgement lost'); }
    return result;
  };
  const uncertainWhole = await backgroundWorkflows.prepare({ projectNoteIds: ['project-a'], steps: ['textbook'] }, uncertainComposite.context);
  await backgroundWorkflows.start(uncertainWhole.id, uncertainComposite.context); await backgroundWorkflows.waitForIdle();
  assert.equal(backgroundWorkflows.getSnapshot().find(job => job.id === uncertainWhole.id)!.status, 'blocked');
  assert.equal(uncertainComposite.counters.tasks, 1); assert.equal(uncertainComposite.counters.concepts, 0);
  assert.equal((await readDisk()).find(note => note.id === 'project-a')!.generatedContentBlocks!.length, 1);
  await backgroundWorkflows.start(uncertainWhole.id, uncertainComposite.context); await backgroundWorkflows.waitForIdle();
  assert.equal(backgroundWorkflows.getSnapshot().find(job => job.id === uncertainWhole.id)!.status, 'completed');
  assert.equal(uncertainComposite.counters.tasks, 1); assert.equal(notes.find(note => note.id === 'project-a')!.generatedContentBlocks!.length, 1);
  pass('学习任务落盘但回执丢失：原组合流程重新确认后核对预存收据，零重复任务生成/追加，再继续概念与教材');
  await resetComposite(false);
  notes.push(note('ready-knowledge-only', '选择过载效应', '# 选择过载效应\n\n选择过载是具有成立条件的决策现象。需要结合偏好清晰度、任务复杂度和时间压力判断，不能认为选项增加必然造成困难。', 'knowledge'));
  await saveVaultSnapshot(vault, stateDir, notes);
  const knowledgeOnly = installCompositeBridge();
  const knowledgeOnlyJob = await backgroundWorkflows.prepare({ projectNoteIds: ['project-a'], steps: ['textbook'] }, knowledgeOnly.context);
  await backgroundWorkflows.start(knowledgeOnlyJob.id, knowledgeOnly.context); await backgroundWorkflows.waitForIdle();
  assert.equal(backgroundWorkflows.getSnapshot().find(job => job.id === knowledgeOnlyJob.id)!.status, 'completed');
  assert.equal(knowledgeOnly.counters.documents, 0); assert.equal(knowledgeOnly.counters.concepts, 0);
  assert.ok(notes.find(note => note.id === 'project-a')!.textbook);
  pass('没有绑定文档但存在已补全任务关联知识点时，跳过概念生成，直接用知识点完成教材；零全库检索与资源统筹');
  console.log(`textbook generation: ${checks} groups passed; mocked model, synthetic files, no live network/user vault`);
} finally {
  globalThis.fetch = originalFetch;
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(temp, { recursive: true, force: true });
}

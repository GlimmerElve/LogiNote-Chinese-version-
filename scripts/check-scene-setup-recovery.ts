import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { NoteItem } from '../src/types';
import { runSceneMultiAgent } from '../src/services/agent/sceneMultiAgent';
import { SceneSetupError, type SceneSetupDiagnostic } from '../src/services/scene/sceneSetupStage';
import { SceneClarificationRequired } from '../src/services/scene/sceneUnderstanding';
import { understandingFixture } from './scene-semantic-fixture';
import { bindSceneProjectMaterials, getSceneProjectMaterials } from '../src/services/scene/sceneKnowledgePoints';
import { applySceneAssemblyPlan, parseSceneSpec } from '../src/services/scene/sceneGenerator';
import { resolveSceneRuntimeContract } from '../src/services/scene/sceneRuntimeContract';
import { assembleSceneTurnContext, normalizeSceneTurnPlan } from '../src/services/scene/sceneTurnAgent';
import { searchNotes } from '../src/services/ragService';
import { hasSubstantiveReferenceText } from '../src/services/ragSourcePolicy';

globalThis.fetch = async () => assert.fail('Recovery tests must not call network');
const project = { id: 'social-project', title: '社会心理学效应', noteType: 'project', content: '', links: [] } as unknown as NoteItem;
const notes: NoteItem[] = Array.from({ length: 34 }, (_, index) => ({ id: `k${index}`, title: `社会效应${index}`, parentId: project.id,
  noteType: 'knowledge', content: index % 2 ? '<p>&nbsp;</p>' : `仅存于本地的正文 ${index}：情境会改变判断。`, tags: [], links: [], backlinks: [], dueDates: [],
  createdAt: '', updatedAt: '' }));
const allNotes = [project, ...notes, { ...notes[0], id: 'outside', parentId: 'other', title: notes[0].title }];
const materials = getSceneProjectMaterials(project.id, allNotes)!;
assert.deepEqual(materials.summary, { candidateCount: 34, usableCount: 17, emptyCount: 17 });
assert.equal(materials.scope.noteIds.includes('outside'), false);
assert.equal(materials.scope.noteIds.includes('k1'), false);
assert.equal(hasSubstantiveReferenceText('请对该知识点进行定义描述'), false);
assert.equal(hasSubstantiveReferenceText('## <p> </p>'), false);
assert.throws(() => getSceneProjectMaterials('missing', allNotes), /项目不存在/);

const request = ['搭建一个 S1 学习场景。', '主题：社会心理学效应', `关联知识点：${notes.map(note => note.title).join('、')}`,
  '用户其它要求：只要单选题，多出几道难度高的'].join('\n');
const semantic = understandingFixture('request', request, { intent: 'build-scene', userGoal: '用较难的典型单选题测试社会心理学效应',
  expectedExperience: '逐题作答，一次一题', requirements: ['只出单选题', '提高难度，增加综合应用'], exclusions: ['不要求角色'] });
const assembly = { capabilityPlan: { needs: [{ id: 'practice', goal: '逐题选择', capabilityIds: ['single-choice'] }], missing: [] }, recipeId: 'guided-practice', requestedCapabilities: ['single-choice'],
  requestedPromptModules: ['resource-grounding', 'structured-interaction', 'adaptive-progression', 'turn-agent-planning'],
  interactionPlan: '按知识点选择典型案例，每回合一道较难的单选题', rationale: '满足显式单选和逐题约束，角色不是必要组件' };
const diagnostics: SceneSetupDiagnostic[] = [];
let understandCalls = 0, assembleCalls = 0;
const result = await runSceneMultiAgent({ userRequest: request, sceneSkillConstraint: 'S1', recipeConstraint: 'guided-practice',
  requestedCapabilities: ['single-choice'], materialSummary: materials.summary, onDiagnostic: diagnostic => diagnostics.push(diagnostic),
  callLlm: async call => {
    const input = JSON.parse(call.userInput);
    assert.doesNotMatch(call.userInput, /仅存于本地的正文/);
    if (input.phase === 'understand') {
      understandCalls++;
      assert.deepEqual(input.explicitSelections, { recipeId: 'guided-practice', capabilities: ['single-choice'] });
      assert.deepEqual(input.materialSummary, materials.summary);
      if (understandCalls === 1) return { content: '{"sceneSkill":"S1","understanding":{}}' };
      assert.equal(input.outputRepair.attempt, 2);
      assert.equal(input.outputRepair.code, 'invalid-fields');
      return { content: JSON.stringify({ sceneSkill: 'S1', understanding: semantic }) };
    }
    assembleCalls++;
    if (assembleCalls === 1) return { content: JSON.stringify({ ...assembly, requestedCapabilities: ['multiple-choice'] }) };
    assert.equal(input.outputRepair.attempt, 2);
    return { content: JSON.stringify(assembly) };
  } });
assert.equal(understandCalls, 2); assert.equal(assembleCalls, 2);
assert.equal(result.coordination.totals.llmCalls, 4, 'both bounded repairs fit the explicit budget and are counted');
assert.deepEqual(result.recommendation.requestedCapabilities, ['single-choice']);
assert.equal(result.recommendation.requestedPromptModules.includes('role-context'), false);
assert.deepEqual(diagnostics.filter(item => item.retrying).map(item => [item.stage, item.retrying]), [['understand', true], ['assemble', true]]);
const responseDiagnostics = diagnostics.filter(item => item.code === 'model-response');
assert.deepEqual(responseDiagnostics.map(item => [item.stage, item.attempt]), [
  ['understand', 1], ['understand', 2], ['assemble', 1], ['assemble', 2],
]);
assert.ok(responseDiagnostics.every(item => item.retrying === false && item.requestedMaxTokens === 4096
  && item.maxTokens === 4096 && typeof item.outputChars === 'number' && item.outputChars > 0
  && item.thinkingModeRequested === 'provider-default'));
assert.doesNotMatch(JSON.stringify(diagnostics), /仅存于本地的正文|场景需求|provider-secret-key/);
let intentRepairs = 0;
await runSceneMultiAgent({ userRequest: request, callLlm: async call => {
  const input = JSON.parse(call.userInput);
  if (input.phase === 'assemble') return { content: JSON.stringify(assembly) };
  intentRepairs++;
  if (intentRepairs === 2) assert.equal(input.outputRepair.code, 'intent-conflict');
  return { content: JSON.stringify({ sceneSkill: 'S1', understanding: { ...semantic, intent: intentRepairs === 1 ? 'answer' : 'build-scene' } }) };
} });
assert.equal(intentRepairs, 2, 'incorrect model intent is repaired internally, not blamed on missing user requirements');
let unnecessaryClarification = 0;
await runSceneMultiAgent({ userRequest: request, recipeConstraint: 'guided-practice', requestedCapabilities: ['single-choice'],
  callLlm: async call => {
    const input = JSON.parse(call.userInput);
    if (input.phase === 'assemble') return { content: JSON.stringify(assembly) };
    unnecessaryClarification++;
    if (unnecessaryClarification === 1) return { content: JSON.stringify({ sceneSkill: 'S1', understanding: { ...semantic,
      needsClarification: true, clarificationQuestion: '你没填角色和精确题量，请补充。' } }) };
    assert.equal(input.outputRepair.code, 'unjustified-clarification');
    return { content: JSON.stringify({ sceneSkill: 'S1', understanding: semantic }) };
  } });
assert.equal(unnecessaryClarification, 2, 'an unjustified request for optional fields is repaired internally');
const stopped = new AbortController(); stopped.abort();
await assert.rejects(() => runSceneMultiAgent({ userRequest: request, signal: stopped.signal,
  callLlm: async () => assert.fail('aborted setup cannot invoke the model') }), { name: 'AbortError' });

for (const failure of ['HTTP 401: provider-secret-key', 'HTTP 400: provider-secret-key', 'connection failed https://private.example/?api_key=provider-secret-key']) {
  let calls = 0;
  await assert.rejects(() => runSceneMultiAgent({ userRequest: request, callLlm: async () => { calls++; throw new Error(failure); } }),
    error => error instanceof SceneSetupError && error.stage === 'understand' && error.code.startsWith('model-')
      && !error.message.includes('provider-secret-key') && !error.message.includes('private.example') && !error.message.includes('未能可靠理解'));
  assert.equal(calls, 1, 'auth/transport failure is preserved, not repeatedly sent or treated as missing user data');
}
let broken = 0;
await assert.rejects(() => runSceneMultiAgent({ userRequest: request, callLlm: async () => { broken++; return { content: 'not-json' }; } }),
  error => error instanceof SceneSetupError && error.code === 'invalid-json' && error.attempts === 2);
assert.equal(broken, 2);
await assert.rejects(() => runSceneMultiAgent({ userRequest: request, callLlm: async () => ({ content: JSON.stringify({ sceneSkill: 'S1',
  understanding: { ...semantic, needsClarification: true, clarificationQuestion: '只选一个子主题时，你希望练哪一个？',
    informationGaps: [{ id: 'topic', kind: 'user-clarification', description: '两个指定子主题相互冲突，需要用户决定保留哪一个' }] } }) }) }),
  error => error instanceof SceneClarificationRequired && error.question.includes('子主题'));

const raw = parseSceneSpec(JSON.stringify({ meta: { name: '社会效应单选', subject: project.title, goal: semantic.userGoal }, task: '逐题完成单选',
  behavior: { recipeId: 'guided-practice', kind: '单选练习', aiBehavior: '每次出一题', userAction: '选择', evaluationRule: '核对答案', progressionRule: '按表现调整难度',
    interaction: { version: '1.0', allowedTypes: ['single-choice'], defaultType: 'single-choice', allowTextFallback: false } } }));
const spec = bindSceneProjectMaterials(applySceneAssemblyPlan(raw, { recipeId: 'guided-practice', subject: project.title,
  knowledgePoints: notes.map(note => note.title), requestedCapabilities: ['single-choice'], requestedPromptModules: assembly.requestedPromptModules as any }), materials);
const contract = resolveSceneRuntimeContract(spec);
assert.deepEqual(contract.scope.noteIds, materials.scope.noteIds);
assert.deepEqual(contract.scope.documentIds, [], 'a project-note selection cannot silently authorize global imported documents');
const forgedSpec = { ...spec, runtimeContract: { ...contract, scope: { noteIds: ['outside', 'k0'] } } };
assert.deepEqual(resolveSceneRuntimeContract(forgedSpec).scope.noteIds, ['k0']);
const userRun: any = { messages: [{ id: 'u1', speakerType: 'user', content: '出一道认知失调的典型题', isStreaming: false }], turnCount: 1 };
const plan = normalizeSceneTurnPlan({ understanding: understandingFixture('u1', userRun.messages[0].content, { informationGaps: [
  { id: 'g', description: '笔记中的认知失调定义', kind: 'reference-material' } ] }), action: 'advance', toolRequests: [
  { id: 'knowledge-notes', query: '认知失调', needId: 'g', reason: '读取本项目相关笔记的具体依据' } ] }, spec, userRun);
const context = await assembleSceneTurnContext(spec, plan, { searchNotes: async (_query, k, options) => {
  assert.equal(k, 2); assert.deepEqual(options?.allowedNoteIds, materials.scope.noteIds);
  return [ { noteId: 'outside', noteType: 'knowledge', title: '越界', snippet: '外部正文', score: 1 },
    { noteId: 'k2', noteType: 'knowledge', title: '空结果', snippet: '<p>&nbsp;</p>', score: 0.9 },
    { noteId: 'k0', noteType: 'knowledge', title: '认知失调', snippet: '不一致可导致心理不适。', score: 0.8 } ];
} });
assert.deepEqual(context.citations.map(item => item.noteId), ['k0']);
const emptyMaterials = getSceneProjectMaterials(project.id, [project, ...notes.map(note => ({ ...note, content: '' }))])!;
const emptySpec = bindSceneProjectMaterials(spec, emptyMaterials);
await assembleSceneTurnContext(emptySpec, plan, { searchNotes: async () => assert.fail('empty project cannot invoke global note search') });

// Execute the actual IPC handler with synthetic dependencies; keep the environment-lease route separate.
const source = ts.createSourceFile('main.ts', readFileSync('src/electron/main.ts', 'utf8'), ts.ScriptTarget.ES2022, true);
let handlerText = '';
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'handle'
    && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'noteRag:search') handlerText = node.arguments[1].getText(source);
  ts.forEachChild(node, visit);
}
visit(source); assert.ok(handlerText);
const ipcReads: Array<string[] | undefined> = [];
const environment: any = { getVaultRoot: () => 'synthetic-root', getUserStateDir: () => 'synthetic-state', getDataVersion: () => 1,
  referenceSourceWriteEpoch: 0, referenceEnvironmentSuspended: false, readSavedVaultNotesByIds: async () => [],
  loadMergedNotes: async () => assert.fail('Ranked reference lookup must not load the full vault'),
  noteRagSearchNotes: async (_q: string, _k: number, ids?: string[]) => { ipcReads.push(ids); return []; },
  isCurrentNoteReferenceHit: () => true, referenceCallerAllowed: () => true,
  referenceEnvironments: { withEnvironment: () => assert.fail('explicit note IDs cannot acquire an argument lease') } };
const compiled = ts.transpileModule(`return (${handlerText})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const handler = new Function(...Object.keys(environment), compiled)(...Object.values(environment));
await handler({}, '认知失调', 2, { allowedNoteIds: ['k0'] });
assert.deepEqual(ipcReads, [['k0']]);
await handler({}, '认知失调', 2, { allowedNoteIds: [] });
await handler({}, '认知失调', 2, { allowedNoteIds: ['k0'], argumentEnvironmentId: 'forged' });
assert.equal(ipcReads.length, 1);
await handler({}, '认知失调', 2); assert.equal(ipcReads.length, 2, 'legacy global query remains compatible');

const priorWindow = (globalThis as any).window;
try {
  let rendererReads = 0;
  (globalThis as any).window = { electronAPI: { noteRag: { search: async (_q: string, k: number, options: any) => {
    rendererReads++; assert.equal(k, 2); assert.deepEqual(options, { allowedNoteIds: ['k0'] });
    return [{ noteId: 'outside', noteType: 'knowledge', title: '外部', snippet: '外部正文', score: 1 },
      { noteId: 'k0', noteType: 'knowledge', title: '本项目', snippet: '本项目有效正文', score: 0.8 }];
  } } } };
  assert.deepEqual((await searchNotes('q', 2, { allowedNoteIds: ['k0'] })).map(hit => hit.noteId), ['k0']);
  assert.deepEqual(await searchNotes('q', 2, { allowedNoteIds: [] }), []); assert.equal(rendererReads, 1);
} finally { (globalThis as any).window = priorWindow; }
console.log('Scene setup recovery passed: exact 34-point scenario, manual constraints before understanding, bounded format repair, typed transport diagnostics, no mandatory role, stable project scope, empty-body exclusion and scoped renderer/IPC retrieval. Synthetic IO only.');

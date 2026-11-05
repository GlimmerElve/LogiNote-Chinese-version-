import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse, SceneSpec } from '../src/types';
import { generateScene, SceneBuildInterruptedError, type SceneBuildCheckpoint } from '../src/services/scene/sceneGenerator';
import { SceneSetupError, type SceneSetupDiagnostic } from '../src/services/scene/sceneSetupStage';
import type { SceneBuildContext } from '../src/services/scene/sceneBuildAgent';
import { understandingFixture } from './scene-semantic-fixture';

globalThis.fetch = async () => assert.fail('Recovery checks must remain offline');
const request = '搭建自由学习对话，不读笔记、画像或执行实验。PRIVATE_INPUT_NOT_FOR_DIAGNOSTICS';
function context(large = false): SceneBuildContext {
  return { version: 1, userRequest: request, conversation: [], selectedSurface: 'S1', explicitSelections: {},
    understanding: understandingFixture('request', request, { intent: 'build-scene',
      requirements: large ? Array.from({ length: 12 }, (_, i) => `Requirement ${i}`) : [],
      exclusions: large ? Array.from({ length: 12 }, (_, i) => `Exclusion ${i}`) : [],
      successCriteria: large ? Array.from({ length: 12 }, (_, i) => `Success ${i}`) : [],
      buildConstraints: { version: 1, interactionPolicy: 'unrestricted', answerKinds: [], taskPackaging: 'unrestricted',
        excludedBehaviors: [], evidence: [{ sourceId: 'request', quote: request }] } }),
    assembly: { recipeId: 'agent-designed', capabilities: ['text'], promptModules: ['turn-agent-planning'], interactionPlan: 'Flexible dialogue' },
    capabilityPlan: { needs: Array.from({ length: large ? 16 : 1 }, (_, i) => ({ id: `activity-${i}`, goal: `Dialogue ${i}`, capabilityIds: ['text'] })), missing: [] },
    materialEvidence: { policy: 'retrieved-reference-not-fact-verified', callCount: 0, results: [] } };
}
const options = (buildContext = context()) => ({ subject: 'Learning', knowledgePoints: [], sceneSkill: 'S1' as const,
  recipeId: 'agent-designed' as const, requestedCapabilities: ['text' as const], requestedPromptModules: ['turn-agent-planning' as const],
  manifest: { version: '1.0', updatedAt: '', scenes: [] }, buildContext });
const json = (value: unknown): LlmCallResponse => ({ content: JSON.stringify(value) });
function coverage(input: any, failure?: 'field' | 'assembly') {
  return { coverage: input.criteria.map((criterion: any) => ({ id: criterion.id,
    satisfied: !failure || criterion.id !== 'experience', evidencePaths: ['task'],
    ...(!failure || criterion.id !== 'experience' ? {} : { detail: 'Synthetic unmet experience' }) })),
  issues: failure === 'field' ? [{ criterionId: 'experience', target: 'task', instruction: 'Clarify the activity' }] : [],
  assemblyIssues: failure === 'assembly' ? [{ criterionId: 'experience', instruction: 'Use question-answer recipe within the original public pool' }] : [] };
}
type Hook = (input: any, call: LlmCallRequest, count: number) => LlmCallResponse | undefined;
function model(hook: Hook = () => undefined) {
  const phases: string[] = [], requests: LlmCallRequest[] = [], counts = new Map<string, number>();
  const callLlm = async (call: LlmCallRequest): Promise<LlmCallResponse> => {
    const input = JSON.parse(call.userInput);
    phases.push(input.phase); requests.push(call);
    assert.equal(input.buildContext.userRequest, request);
    assert.ok(!Object.hasOwn(input, 'recovery') && !Object.hasOwn(input, 'binding'));
    assert.ok(!Object.hasOwn(input.buildContext, 'recovery'));
    const count = (counts.get(input.phase) || 0) + 1; counts.set(input.phase, count);
    if (input.phase === 'accept') assert.equal(call.thinkingMode, 'disabled');
    const overridden = hook(input, call, count);
    if (overridden) return overridden;
    if (input.phase === 'flow') return json({ answerFeedback: { correctness: 'on-request', explanation: 'at-end' },
      flowGuidance: 'Respond flexibly', evaluationRule: 'Only on request', progressionRule: 'Understand latest input',
      completionRule: 'User decides', maxTurns: 12, stages: [] });
    if (input.phase === 'instructions') return json({ aiBehavior: 'Respond', userAction: 'Discuss', understanding: 'Understand actual input', planning: 'No external reads', response: 'Respond naturally' });
    if (input.phase === 'generate') return json({ meta: { name: 'Synthetic recovery', subject: 'Learning', goal: 'Dialogue' }, task: 'Discuss',
      behavior: { recipeId: input.buildContext.assembly.recipeId, kind: 'Dialogue', aiBehavior: 'Respond', userAction: 'Discuss', evaluationRule: 'None', progressionRule: 'Flexible',
        interaction: { version: '1.0', allowedTypes: ['text'], defaultType: 'text', allowTextFallback: true } },
      runtimeContract: { mode: 'dialogue', evaluation: 'none', completion: 'user-controlled', allowedTools: [], allowedInteractionTypes: ['text'],
        scope: { noteIds: ['synthetic-note'], documentIds: [], cognitionRecordIds: [] }, maxToolCallsPerTurn: 0, maxPlanningSteps: 1 } });
    if (input.phase === 'accept') return json(coverage(input));
    if (input.phase === 'repair') return json({ patch: { task: 'Clarified activity' } });
    if (input.phase === 'assemble') return json({ recipeId: 'question-answer', requestedCapabilities: ['text'], requestedPromptModules: ['turn-agent-planning'],
      interactionPlan: 'Repaired dialogue policy', rationale: 'Keep original authority', capabilityPlan: input.buildContext.capabilityPlan });
    assert.fail('Unexpected builder phase: ' + input.phase);
  };
  return { callLlm, phases, requests, counts };
}
async function interrupted(work: Promise<SceneSpec>) {
  try { await work; assert.fail('Expected interrupted builder'); }
  catch (error) { assert.ok(error instanceof SceneBuildInterruptedError); return error; }
}

// Even complete-looking JSON is rejected when the provider says it was truncated.
const original = options(), diagnostics: SceneSetupDiagnostic[] = [];
const truncated = model(input => input.phase === 'accept' ? {
  ...json(coverage(input)), diagnostics: { finishReason: 'length', reasoningTokens: 6000, hadReasoningContent: true, responseModel: 'SECRET_PROVIDER_MODEL' },
  usage: { promptTokens: 100, completionTokens: 6144 },
} : undefined);
const first = await interrupted(generateScene({ ...original, callLlm: truncated.callLlm, onDiagnostic: d => diagnostics.push(d) }));
assert.equal(first.code, 'output-truncated'); assert.equal(first.checkpoint.lastStage, 'accept');
assert.ok(first.checkpoint.candidate && first.checkpoint.recovery.flow && first.checkpoint.recovery.instructions);
assert.equal(first.checkpoint.result, undefined);
assert.ok(first.checkpoint.binding.includes('PRIVATE_INPUT'), 'privacy assertion must cover a genuinely private checkpoint');
assert.ok(!Object.keys(first).includes('checkpoint') && !Object.keys(first).includes('cause'));
assert.ok(!JSON.stringify(first).includes('PRIVATE_INPUT'), 'typed errors cannot enumerate the original request or drafts');
assert.deepEqual(truncated.phases, ['flow', 'instructions', 'generate', 'accept', 'accept']);
const acceptRequests = truncated.requests.filter(call => JSON.parse(call.userInput).phase === 'accept');
assert.equal(acceptRequests[1].maxTokensOverride, acceptRequests[0].maxTokensOverride! * 2);
assert.ok(diagnostics.some(d => d.thinkingModeRequested === 'disabled' && d.hadReasoningContent === true && d.reasoningTokens === 6000));
assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE_INPUT') && !JSON.stringify(diagnostics).includes('SECRET_PROVIDER'));
const stillBad = model(input => input.phase === 'accept' ? { content: '{', diagnostics: { finishReason: 'length' } } : undefined);
const second = await interrupted(generateScene({ ...original, resume: first.checkpoint, callLlm: stillBad.callLlm }));
assert.deepEqual(stillBad.phases, ['accept'], 'resume does not reset the one format-repair allowance');
assert.equal(stillBad.requests[0].maxTokensOverride, acceptRequests[1].maxTokensOverride);
const resumed = model(); let complete: SceneBuildCheckpoint | undefined;
const built = await generateScene({ ...original, resume: second.checkpoint, callLlm: resumed.callLlm, onCheckpoint: value => { complete = value; } });
assert.deepEqual(resumed.phases, ['accept']); assert.equal(built.sceneId, first.checkpoint.candidate!.sceneId);
assert.ok(complete?.result);
assert.equal((await generateScene({ ...original, resume: complete, callLlm: async () => assert.fail('Completed resume must not call models') })).sceneId, built.sceneId);
await assert.rejects(generateScene({ ...original, subject: 'Changed goal', resume: first.checkpoint,
  callLlm: async () => assert.fail('Binding mismatch must not call models') }), error => error instanceof SceneSetupError && error.code === 'resume-binding-mismatch');

// A transport failure after flow preserves flow and retries only instructions onward.
const instructionFailure = model(input => { if (input.phase === 'instructions') throw new Error('HTTP 400'); return undefined; });
const failedInstructions = await interrupted(generateScene({ ...original, callLlm: instructionFailure.callLlm }));
assert.ok(failedInstructions.checkpoint.recovery.flow); assert.equal(failedInstructions.checkpoint.recovery.instructions, undefined);
const instructionRetry = model();
await generateScene({ ...original, resume: failedInstructions.checkpoint, callLlm: instructionRetry.callLlm });
assert.deepEqual(instructionRetry.phases, ['instructions', 'generate', 'accept']);

// Aborting keeps the public AbortError contract; the private callback still carries accepted work.
const abort = new AbortController(); let abortedCheckpoint: SceneBuildCheckpoint | undefined;
const abortedModel = model(input => {
  if (input.phase === 'instructions') { abort.abort(); throw new DOMException('Synthetic abort', 'AbortError'); }
  return undefined;
});
await assert.rejects(generateScene({ ...original, signal: abort.signal, callLlm: abortedModel.callLlm,
  onCheckpoint: value => { abortedCheckpoint = value; } }), { name: 'AbortError' });
assert.ok(abortedCheckpoint?.recovery.flow); assert.equal(abortedCheckpoint!.failure?.code, 'build-aborted');
const abortRetry = model();
await generateScene({ ...original, resume: abortedCheckpoint, callLlm: abortRetry.callLlm });
assert.deepEqual(abortRetry.phases, ['instructions', 'generate', 'accept']);

// A failed field repair keeps its validated review and consumes the shared repair allowance once.
const repairFailure = model(input => {
  if (input.phase === 'accept') return json(coverage(input, 'field'));
  if (input.phase === 'repair') throw new Error('HTTP 400');
});
const failedRepair = await interrupted(generateScene({ ...original, callLlm: repairFailure.callLlm }));
assert.equal(failedRepair.checkpoint.repairBudget.fieldRepairsUsed, 1);
assert.equal(failedRepair.checkpoint.recovery.acceptance?.repairStarted, true);
const repairRetry = model();
await generateScene({ ...original, resume: failedRepair.checkpoint, callLlm: repairRetry.callLlm });
assert.deepEqual(repairRetry.phases, ['repair', 'accept']);
const rejectedRetry = model(input => input.phase === 'accept' ? json(coverage(input, 'field')) : undefined);
const terminal = await interrupted(generateScene({ ...original, resume: failedRepair.checkpoint, callLlm: rejectedRetry.callLlm }));
assert.equal(terminal.code, 'semantic-rejected'); assert.equal(terminal.retryable, false);
assert.deepEqual(rejectedRetry.phases, ['repair', 'accept']);
await assert.rejects(generateScene({ ...original, resume: terminal.checkpoint,
  callLlm: async () => assert.fail('Terminal resume must not reset repair budget') }), /resume-terminal/);

// Failed reassembly keeps its already-consumed single revision and original authority.
const assemblyFailure = model(input => {
  if (input.phase === 'accept') return json(coverage(input, 'assembly'));
  if (input.phase === 'assemble') throw new Error('HTTP 400');
});
const failedAssembly = await interrupted(generateScene({ ...original, callLlm: assemblyFailure.callLlm }));
assert.equal(failedAssembly.checkpoint.assemblyRevisions, 1); assert.ok(failedAssembly.checkpoint.pendingReassembly);
const assemblyRetry = model(); let assemblyCheckpoint: SceneBuildCheckpoint | undefined;
await generateScene({ ...original, resume: failedAssembly.checkpoint, callLlm: assemblyRetry.callLlm, onCheckpoint: cp => { assemblyCheckpoint = cp; } });
assert.deepEqual(assemblyRetry.phases, ['assemble', 'flow', 'instructions', 'generate', 'accept']);
assert.equal(assemblyCheckpoint!.assemblyRevisions, 1);
assert.deepEqual(assemblyCheckpoint!.authority, failedAssembly.checkpoint.authority);
const repeatedAssembly = model(input => input.phase === 'accept' ? json(coverage(input, 'assembly')) : undefined);
const exhausted = await interrupted(generateScene({ ...original, resume: failedAssembly.checkpoint, callLlm: repeatedAssembly.callLlm }));
assert.equal(exhausted.code, 'reassembly-budget-exhausted'); assert.equal(exhausted.retryable, false);
assert.equal(repeatedAssembly.phases.filter(phase => phase === 'assemble').length, 1);

// Only large checklists are batched. Accepted batch 0 is not resent after batch 1 fails.
const largeOptions = options(context(true)); const batchIndices: number[] = [];
const batchFailure = model(input => {
  if (input.phase !== 'accept') return undefined;
  batchIndices.push(input.acceptanceBatch.index);
  if (input.acceptanceBatch.index === 1) throw new Error('HTTP 400');
});
const failedBatch = await interrupted(generateScene({ ...largeOptions, callLlm: batchFailure.callLlm }));
assert.deepEqual(batchIndices, [0, 1]); assert.equal(failedBatch.checkpoint.recovery.acceptance?.batches.length, 1);
const batchRetry = model(input => { if (input.phase === 'accept') batchIndices.push(input.acceptanceBatch.index); return undefined; });
await generateScene({ ...largeOptions, resume: failedBatch.checkpoint, callLlm: batchRetry.callLlm });
assert.deepEqual(batchRetry.phases, ['accept']); assert.deepEqual(batchIndices, [0, 1, 1]);

console.log('Scene build recovery passed: compact acceptance, honest truncation/thinking diagnostics, failed-stage/batch resume, frozen repair/reassembly budgets and strict input binding. Offline mocks only.');

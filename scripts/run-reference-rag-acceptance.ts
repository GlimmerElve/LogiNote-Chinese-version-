import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { saveVaultSnapshot } from '../src/electron/vaultSnapshot.ts';
import { createArgumentProjectionEnvironmentRegistry } from '../src/electron/rag/argumentProjectionEnvironment.ts';
import { createArgumentReferenceBuildService, type ArgumentReferenceBuildDiagnostic } from '../src/electron/rag/argumentReferenceBuildService.ts';
import { createArgumentReferenceRagBuildService } from '../src/electron/rag/argumentReferenceRagBuildService.ts';
import { createArgumentQuestionRuntime } from '../src/electron/rag/argumentQuestionRuntime.ts';
import { prepareStoredReferencePropositions } from '../src/electron/rag/referenceStoredPropositions.ts';
import { createCurrentSourcePropositionReader } from '../src/electron/rag/referenceSourcePropositionProvider.ts';
import { createPersistentSourcePropositionStore } from '../src/electron/rag/referenceSourcePropositionStore.ts';
import { freezeReviewAssessment } from '../src/services/reviewAssessment.ts';
import { buildReviewReferenceCatalog, freezeReviewReferenceRubric } from '../src/services/reviewReferenceRubric.ts';
import { createReviewArgumentQuestionClient, type ReviewArgumentQuestionApi } from '../src/services/argumentContext/questionBindingClient.ts';
import { evaluateFrozenPropositionReviewReferenceShadow } from '../src/services/reviewComparison/frozenPropositionShadow.ts';
import { createFrozenPropositionReferenceModel } from '../src/services/reviewComparison/frozenPropositionReference.ts';
import type { SourcePropositionBuildDiagnostic } from '../src/services/reviewComparison/sourcePropositionBuild.ts';
import { FROZEN_SELECTED_ENDPOINT_POLICY, type FrozenReferenceShadowResult } from '../src/services/reviewComparison/frozenReferenceShadow.ts';
import type { ReviewQuestionIntent } from '../src/services/reviewIntent.ts';
import type { ReviewComparisonAnswer } from '../src/services/reviewComparison/types.ts';
import type { NoteItem } from '../src/types.ts';
import { REFERENCE_RAG_ACCEPTANCE_DATASET_VERSION, REFERENCE_RAG_ACCEPTANCE_DATASET, REFERENCE_RAG_ACCEPTANCE_SOURCES,
  REFERENCE_RAG_ACCEPTANCE_BUDGET, assertPreAnswerRubric, judgeReferenceRagAcceptanceOutcome, summarizeReferenceRagAcceptanceReport,
  type ReferenceRagAcceptanceSourceOutcome } from './reference-rag-acceptance-dataset.ts';
import { createReferenceRagAcceptanceTransport, loadReferenceRagAcceptanceModels } from './reference-rag-acceptance-transport.ts';
import type { ReviewProgressiveOutcome, ReviewProgressiveTask } from './review-progressive-dataset.ts';

// A distinct, explicitly consented experiment. No production data-root is ever
// passed to a vault/graph/proposition writer. All model responses stay immutable.
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown) => sha(JSON.stringify(value));
const scriptFiles = ['scripts/run-reference-rag-acceptance.ts', 'scripts/reference-rag-acceptance-dataset.ts',
  'scripts/reference-rag-acceptance-transport.ts', 'scripts/review-progressive-acceptance-dataset.ts',
  'scripts/review-progressive-dataset.ts', 'scripts/reference-disclosure-fixture.ts'];
async function codeFingerprint() {
  const files: string[] = [];
  async function collect(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('acceptance_unsafe_code');
      if (entry.isDirectory()) await collect(name);
      else if (/\.tsx?$/u.test(name)) files.push(name);
    }
  }
  await collect('src'); files.push(...scriptFiles); files.sort();
  return { fingerprint: hash(await Promise.all(files.map(async name => [name, sha(await fs.readFile(name))]))), files };
}
export function selectReferenceRagAcceptanceMode(args: readonly string[]) {
  const execute = args.includes('--execute'), local = args.includes('--local'), sourcesOnly = args.includes('--sources-only');
  assert.ok(new Set(args).size === args.length && args.every(flag => ['--execute', '--allow-cloud', '--local', '--sources-only'].includes(flag))
    && execute === args.includes('--allow-cloud') && !(execute && local) && (!sourcesOnly || execute), 'acceptance_invalid_flags');
  return { execute, local, maxRequests: sourcesOnly ? REFERENCE_RAG_ACCEPTANCE_BUDGET.sourceRequests : REFERENCE_RAG_ACCEPTANCE_BUDGET.totalRequests,
    ...(sourcesOnly ? { sourcesOnly: true as const } : {}) };
}
export function describeReferenceRagAcceptanceFailure(error: unknown, position: { phase: string; id?: string }) {
  // Do not persist arbitrary provider/filesystem errors: those can contain
  // credentials or private paths. Known harness codes and our own position only.
  const code = error instanceof Error && /^acceptance_[a-z0-9_]{1,100}$/u.test(error.message)
    ? error.message : error instanceof assert.AssertionError ? 'acceptance_assertion_failed' : 'acceptance_harness_stopped';
  return { code, ...position };
}
const note = (id: string, title: string, content: string, noteType: 'project' | 'knowledge'): NoteItem => ({ id, title, content, noteType,
  createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z', tags: [], links: [], backlinks: [], dueDates: [] });
const tasks: ReviewProgressiveTask[] = ['definition', 'condition', 'reasoning'];
function heldResult(reason: string, hintLevel: number): FrozenReferenceShadowResult {
  return { version: 1, protocol: 'review-frozen-reference-shadow-v1', evaluationId: 'unavailable', status: 'held', reasons: [reason],
    observations: [], frames: [], evidence: hintLevel >= 3 ? 'assisted_not_independent' : hintLevel ? 'assisted' : 'independent',
    scope: 'frozen_question_items', semanticTruth: 'not_certified', scoreWrite: 'disabled', cognitionWrite: 'disabled',
    inferenceAtomicity: FROZEN_SELECTED_ENDPOINT_POLICY, modelRequests: { extract: 0, reference: 0, total: 0, limit: 2 } };
}
export async function runReferenceRagAcceptance(args: readonly string[]) {
  const mode = selectReferenceRagAcceptanceMode(args), frozenCode = await codeFingerprint();
  const dataset = JSON.parse(JSON.stringify(REFERENCE_RAG_ACCEPTANCE_DATASET)) as typeof REFERENCE_RAG_ACCEPTANCE_DATASET;
  const sources = JSON.parse(JSON.stringify(REFERENCE_RAG_ACCEPTANCE_SOURCES)) as typeof REFERENCE_RAG_ACCEPTANCE_SOURCES;
  const datasetFingerprint = hash({ dataset, sources, budget: REFERENCE_RAG_ACCEPTANCE_BUDGET });
  const assertFrozen = async () => {
    if ((await codeFingerprint()).fingerprint !== frozenCode.fingerprint
      || hash({ dataset: REFERENCE_RAG_ACCEPTANCE_DATASET, sources: REFERENCE_RAG_ACCEPTANCE_SOURCES,
        budget: REFERENCE_RAG_ACCEPTANCE_BUDGET }) !== datasetFingerprint) throw new Error('acceptance_frozen_code_changed');
  };
  const preflight = { datasetVersion: REFERENCE_RAG_ACCEPTANCE_DATASET_VERSION, cases: dataset.length, sources: tasks.length,
    ...REFERENCE_RAG_ACCEPTANCE_BUDGET, datasetFingerprint, sourceFingerprint: frozenCode.fingerprint,
    ...(mode.sourcesOnly ? { sourcesOnly: true, authorizationMaximum: mode.maxRequests,
      executionMaximumRequests: mode.maxRequests, answerEvaluation: 'not_performed' } : {}),
    referenceMode: 'actual_model_built_saved_sources', wireProtocol: 'review-frozen-reference-propositions-v5',
    sourceAdmissionPolicy: 'complete-required-task-closure-v3',
    sourceProtocols: { structureDraft: 'argument-projection-selection-v2', propositionDraft: 'review-source-proposition-parent-selection-v3',
      structureReview: 'argument-projection-task-review-v3', propositionReview: 'review-task-source-proposition-review-v2' },
    personalData: 'none', productionModified: false, scoreWrite: 'disabled', cognitionWrite: 'disabled',
    limitations: ['Existing fictional wording; not a new blind holdout.', 'Expectations are assistant draft, not human gold.',
      'Source reviews are separate requests, not independent models or fact certification.',
      'Fixed pre-answer paragraph selections; no tutor-question-generation or desktop UI test.',
      'No formal mastery-score adapter or personal cognition growth/writeback.', 'No automatic retries or reference repairs.',
      'Published reviewed_scoped sources retain held optional structures; only complete original question closures are usable.'] };
  console.log(JSON.stringify({ event: 'preflight', ...preflight }));
  if (!mode.execute && !mode.local) return; // No private config, directories or requests by default.
  const models = mode.execute ? await loadReferenceRagAcceptanceModels() : undefined;
  await assertFrozen();
  const parent = path.resolve('data/reference-rag-acceptance-experiments'); await fs.mkdir(parent, { recursive: true });
  const output = await fs.mkdtemp(path.join(parent, mode.execute ? 'cloud-' : 'local-'));
  const save = (name: string, value: unknown) => {
    assert.ok(/^[A-Za-z0-9_.-]+$/u.test(name) && !name.startsWith('.'));
    return fs.writeFile(path.join(output, name), JSON.stringify(value, null, 2), { flag: 'wx' });
  };
  await save('manifest.json', { ...preflight, mode: mode.execute ? 'cloud' : 'local', startedAt: new Date().toISOString(),
    dataset, sources, sourceFiles: frozenCode.files, ...(models ? { sourceModel: models.source.modelName,
      answerModel: models.answer.modelName, configFingerprint: models.fingerprint } : {}) });
  console.log(JSON.stringify({ event: 'started', outputDirectory: output }));
  const hostDirectory = await fs.mkdtemp(path.join(output, 'synthetic-host-'));
  const roots = { dataRoot: hostDirectory, vaultRoot: path.join(hostDirectory, 'vault'), userStateDir: path.join(hostDirectory, 'user-state') };
  const project = note('acceptance-synthetic-project', '纯合成验收项目', '仅用于本轮独立实验，不是用户真实资料或认知。', 'project');
  const notes = tasks.map(task => ({ ...note(`acceptance-source-${task}`, `合成参考-${task}`, sources[task].content, 'knowledge'),
    parentId: project.id, referenceSources: [{ title: '纯合成实验约定，不认证外部事实', type: 'web' as const,
      url: 'https://example.org/loginote-synthetic-acceptance' }] }));
  await save('saved-synthetic-notes.json', [project, ...notes]);
  await saveVaultSnapshot(roots.vaultRoot, roots.userStateDir, [project, ...notes]);
  const controller = new AbortController(), stop = () => controller.abort(); process.once('SIGINT', stop);
  const transport = models ? createReferenceRagAcceptanceTransport(models, { signal: controller.signal, assertFrozen, save }) : undefined;
  const sourceOutcomes: ReferenceRagAcceptanceSourceOutcome[] = [], outcomes: ReviewProgressiveOutcome[] = [];
  let runError = '', prepared = 0, readyQuestions = 0;
  let position: { phase: string; id?: string } = { phase: 'source-environment' };
  let failure: ReturnType<typeof describeReferenceRagAcceptanceFailure> | undefined;
  try {
    const builds = createArgumentProjectionEnvironmentRegistry(() => roots);
    const buildEnv = await builds.getEnvironment(401, { kind: 'library' }); assert.ok(buildEnv.status === 'available');
    if (transport) {
      const diagnostics: ArgumentReferenceBuildDiagnostic[] = [];
      const propositionDiagnostics: SourcePropositionBuildDiagnostic[] = [];
      const old = createArgumentReferenceBuildService({ environments: builds, model: transport.sourceAdapter, draftProtocol: 'selection-v2',
        reviewProtocol: 'task-grounded-v3',
        onDiagnostic: diagnostic => { diagnostics.push(structuredClone(diagnostic)); } });
      const service = createArgumentReferenceRagBuildService({ environments: builds, structure: old, model: transport.sourceAdapter,
        propositionDraftProtocol: 'owned-parent-choice-v3', onPropositionDiagnostic: diagnostic => { propositionDiagnostics.push(structuredClone(diagnostic)); } });
      for (const task of tasks) {
        position = { phase: 'source-build', id: task };
        await assertFrozen(); if (controller.signal.aborted || transport.summary().stopReason) { runError = transport.summary().stopReason || 'acceptance_cancelled'; break; }
        const source = notes.find(item => item.id === `acceptance-source-${task}`)!, ref = { kind: 'knowledge-note' as const, entityId: source.id };
        const beforeDiagnostic = diagnostics.length;
        const beforePropositionDiagnostic = propositionDiagnostics.length;
        const input = await builds.withEnvironment(401, buildEnv.environmentId, runtime => runtime.host.withSource(ref, async value => value));
        await save(`source-input-${task}.json`, input);
        const ticket = await service.prepare(401, { environmentId: buildEnv.environmentId, ref }); await save(`source-prepare-${task}.json`, ticket);
        const before = transport.summary().calls;
        const reply = ticket.status === 'prepared' ? await transport.withContext({ kind: 'source', id: task }, () =>
          service.run(401, { environmentId: buildEnv.environmentId, ticketId: ticket.ticketId, consent: 'process-reference-with-propositions' }))
          : { status: 'held' as const, reasonCode: ticket.status === 'held' ? ticket.reasonCode : 'unexpected_existing_source' };
        const detail = await builds.withEnvironment(401, buildEnv.environmentId, async (runtime, _roots, scope) => ({
          active: await createCurrentSourcePropositionReader(runtime.store)(ref),
          proof: await createPersistentSourcePropositionStore(path.join(hostDirectory, 'argument-propositions'), runtime.store, scope.rootScopeId).read(ref),
        }));
        const sent = transport.summary().stages.filter(stage => stage.kind === 'source' && stage.id === task);
        const outcome: ReferenceRagAcceptanceSourceOutcome = { sourceId: sources[task].sourceId, task,
          status: reply.status === 'published' && detail.proof ? 'published' : 'held',
          modelRequests: { structure: sent.filter(stage => ['quality', 'structure-draft', 'structure-review'].includes(stage.stage)).length,
            propositions: sent.filter(stage => stage.stage.startsWith('proposition-')).length, total: transport.summary().calls - before },
          ...(reply.status === 'held' ? { reasons: [reply.reasonCode] } : !detail.proof ? { reasons: ['persistent_proof_unavailable'] } : {}) };
        sourceOutcomes.push(outcome); await save(`source-output-${task}.json`, { outcome, reply, ...detail,
          diagnostics: diagnostics.slice(beforeDiagnostic), propositionDiagnostics: propositionDiagnostics.slice(beforePropositionDiagnostic) });
        const reloaded = createArgumentReferenceRagBuildService({ environments: builds, structure: old, model: transport.sourceAdapter,
          propositionDraftProtocol: 'owned-parent-choice-v3' });
        const prior = transport.summary().calls, status = await reloaded.status(401, { environmentId: buildEnv.environmentId, ref });
        assert.equal(transport.summary().calls, prior); reloaded.revoke();
        if (outcome.status === 'published') assert.equal(status.status, 'available', 'acceptance_saved_source_reload_failed');
        await save(`source-restart-${task}.json`, { status, addedRequests: 0 });
        console.log(JSON.stringify({ event: 'source', task, status: outcome.status, requests: outcome.modelRequests, calls: transport.summary().calls,
          reasons: outcome.reasons ?? [] }));
      }
      service.revoke(); old.revoke(); builds.revoke();
    }
    // New registry/runtime after source processing: no retained provider cache.
    position = { phase: 'question-environment' };
    const reviews = createArgumentProjectionEnvironmentRegistry(() => roots);
    const questions = createArgumentQuestionRuntime(reviews, { preparePropositions: prepareStoredReferencePropositions });
    const api: ReviewArgumentQuestionApi = { getEnvironment: selection => reviews.getEnvironment(402, selection),
      freezeQuestion: (id, selectors) => questions.prepare(402, id, selectors), verifyQuestion: (id, receipt) => questions.verify(402, id, receipt),
      readQuestion: (id, receipt) => questions.read(402, id, receipt), readQuestionPropositions: (id, receipt) => questions.readPropositions(402, id, receipt) };
    const client = createReviewArgumentQuestionClient(project.id, path.basename(output), () => api);
    for (const testCase of dataset) {
      position = { phase: 'question-preparation', id: testCase.id };
      if (runError || controller.signal.aborted || transport?.summary().stopReason) { runError ||= transport?.summary().stopReason || 'acceptance_cancelled'; break; }
      await assertFrozen();
      const source = notes.find(item => item.id === `acceptance-source-${testCase.task}`)!;
      const reference = sources[testCase.task], assessment = freezeReviewAssessment(testCase.task, [source.title]);
      const catalog = await buildReviewReferenceCatalog([source], [source.title], [source.id]);
      const selection = reference.selectors.map(selector => {
        const candidate = catalog.candidates.find(item => item.start === selector.start && item.end === selector.end && item.quote === selector.text);
        assert.ok(candidate, 'acceptance_pre_answer_selector_missing'); return `${selector.criterionId}=${candidate.candidateId}`;
      }).join(';');
      const rubric = freezeReviewReferenceRubric(selection, assessment, catalog); assert.equal(rubric.status, 'fixed', 'acceptance_rubric_not_fixed');
      const intent: ReviewQuestionIntent = { version: 1, questionMessageId: `acceptance-${testCase.id}`, knowledgeTargets: [source.title], assessment, referenceRubric: rubric };
      const beforeRead = transport?.summary().calls ?? 0;
      const receipt = await client.freeze(intent); intent.referenceStructure = receipt;
      const disclosed = await client.readReferencePropositions(intent);
      assert.equal(transport?.summary().calls ?? 0, beforeRead);
      const registration = disclosed.status === 'ready' ? assertPreAnswerRubric(testCase, { rubric, context: disclosed.context }) : null;
      if (registration) readyQuestions++;
      const answer: ReviewComparisonAnswer = { activityId: `acceptance-${testCase.id}`, questionText: testCase.question,
        evidence: { messageId: `answer-${testCase.id}`, answer: testCase.answer, hintLevel: testCase.hintLevel,
          targetKnowledgeNames: [source.title], questionIntent: intent, consultedMaterialIds: [...testCase.consultedMaterialIds] } };
      prepared++;
      await save(`pre-answer-${testCase.id}.json`, { assessment, catalog, selection, rubric, receipt, disclosed, registration, sourceRequestsAdded: 0 });
      await save(`answer-${testCase.id}.json`, answer);
      if (!transport || mode.sourcesOnly) { console.log(JSON.stringify({ event: 'prepared', caseId: testCase.id,
        preAnswerReady: !!registration, calls: transport?.summary().calls ?? 0 })); continue; }
      position = { phase: 'answer-evaluation', id: testCase.id };
      const beforeEvaluation = transport.summary().calls, answerBefore = JSON.stringify(answer);
      const sourceOkay = sourceOutcomes.find(outcome => outcome.task === testCase.task)?.status === 'published';
      const evaluated = sourceOkay && registration ? await transport.withContext({ kind: 'answer', id: testCase.id }, () =>
        evaluateFrozenPropositionReviewReferenceShadow(answer, { readReferencePropositions: client.readReferencePropositions },
          createFrozenPropositionReferenceModel(transport.answerCaller), { signal: controller.signal, timeoutMs: 60000 }))
        : { result: heldResult(sourceOkay ? 'pre_answer_structure_or_propositions_unavailable' : 'skipped_due_to_source_failure', testCase.hintLevel) };
      assert.equal(JSON.stringify(answer), answerBefore); assert.equal(evaluated.result.scoreWrite, 'disabled'); assert.equal(evaluated.result.cognitionWrite, 'disabled');
      const actualRequests = transport.summary().calls - beforeEvaluation;
      assert.equal(evaluated.result.modelRequests.total, actualRequests, 'acceptance_dispatch_count_mismatch');
      const outcome = judgeReferenceRagAcceptanceOutcome(testCase, evaluated.result, registration); outcomes.push(outcome);
      await save(`case-${testCase.id}.json`, { outcome, ...evaluated, actualRequests,
        sourceStatus: sourceOkay ? 'published' : 'not_ready', preAnswerReady: !!registration });
      console.log(JSON.stringify({ event: 'case', caseId: testCase.id, status: evaluated.result.status, preAnswerReady: !!registration,
        passed: outcome.passed, frames: evaluated.result.frames.map(frame => frame.status), reasons: evaluated.result.reasons, calls: transport.summary().calls }));
    }
  } catch (error) {
    failure = describeReferenceRagAcceptanceFailure(error, position);
    runError ||= transport?.summary().stopReason || (controller.signal.aborted ? 'acceptance_cancelled' : 'acceptance_harness_stopped');
  } finally { controller.abort(); transport?.restore(); process.removeListener('SIGINT', stop); }
  const summary = transport?.summary() ?? { calls: 0, stages: [] };
  const metrics = summarizeReferenceRagAcceptanceReport(outcomes, sourceOutcomes);
  const sourcePilotPassed = mode.sourcesOnly ? sourceOutcomes.length === tasks.length
    && sourceOutcomes.every(source => source.status === 'published') && readyQuestions === dataset.length && !runError : undefined;
  const report = { ...preflight, mode: mode.execute ? 'cloud' : 'local', finishedAt: new Date().toISOString(), preparationOnly: mode.local,
    calls: summary.calls, prepared, readyQuestions, sourceOutcomes, metrics, stages: summary.stages,
    processedAllCases: (mode.local ? prepared : outcomes.length) === dataset.length && !runError,
    ...(mode.sourcesOnly ? { sourcePilotPassed, preparedAllQuestions: prepared === dataset.length,
      sourceModelCalls: summary.stages.filter(stage => stage.kind === 'source').length,
      answerModelCalls: summary.stages.filter(stage => stage.kind === 'answer').length } : {}),
    ...(runError ? { runError, ...(failure ? { failure } : {}) } : {}) };
  await save('report.json', report);
  console.log(JSON.stringify({ event: 'complete', outputDirectory: output, calls: summary.calls, prepared, readyQuestions,
    sourceOutcomes, metrics, ...(mode.sourcesOnly ? { sourcePilotPassed } : {}),
    ...(runError ? { runError, ...(failure ? { failure } : {}) } : {}) }));
  if (runError) process.exitCode = 1;
  else if (mode.sourcesOnly) {
    assert.ok(summary.calls <= mode.maxRequests && summary.stages.every(stage => stage.kind === 'source'), 'acceptance_sources_only_budget');
    if (!sourcePilotPassed) process.exitCode = 2;
  }
  else if (!report.processedAllCases || mode.execute && !metrics.allCasesPass) process.exitCode = 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runReferenceRagAcceptance(process.argv.slice(2)).catch(() => {
    console.error('Reference RAG acceptance stopped before any automatic retry or production write.'); process.exitCode = 1;
  });
}

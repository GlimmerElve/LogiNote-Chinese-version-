import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';
import { deserializeLlmState } from '../src/services/userStateService';
import { evaluateFrozenReviewReferenceShadow } from '../src/services/reviewComparison/frozenReferenceShadow';
import { createFrozenReferenceShadowModel, FROZEN_REFERENCE_SHADOW_PROMPT } from '../src/services/reviewComparison/frozenReferenceModel';
import { FROZEN_REFERENCE_EXTRACTION_PROMPT } from '../src/services/reviewComparison/frozenExtractionPrompt';
import { REVIEW_PROGRESSIVE_DATASET, REVIEW_PROGRESSIVE_DATASET_VERSION, judgeReviewProgressiveOutcome, summarizeReviewProgressiveReport,
  type ReviewProgressiveOutcome } from './review-progressive-dataset';
import { REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET, REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET_VERSION,
  summarizeReviewProgressiveAcceptanceReport } from './review-progressive-acceptance-dataset';
import { prepareReviewProgressiveFixture } from './review-progressive-fixture';
import { validateReviewProgressiveRequest } from './review-progressive-transport';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown) => sha(JSON.stringify(value));
const parameters = { temperature: 0.1, extractionMaxTokens: 4096, reviewMaxTokens: 8192,
  response_format: { type: 'json_object' }, thinking: { type: 'disabled' } };
const sourceFiles = ['src/services/reviewComparison/frozenReferenceShadow.ts',
  'src/services/reviewComparison/frozenInferenceAtomicity.ts',
  'src/services/reviewComparison/frozenReferenceModel.ts', 'src/services/reviewComparison/frozenReferenceReadable.ts',
  'src/services/reviewComparison/frozenReferenceTyped.ts', 'src/services/reviewComparison/frozenReferenceEvidence.ts',
  'src/services/reviewComparison/frozenExtractionPrompt.ts', 'src/services/reviewComparison/performanceGraph.ts',
  'src/services/reviewComparison/semanticClient.ts', 'src/services/reviewComparison/semanticPrompts.ts',
  'src/services/reviewAssessment.ts', 'src/services/reviewIntentValidation.ts', 'src/services/reviewReferenceRubric.ts',
  'src/services/argumentContext/referenceDisclosure.ts', 'src/services/argumentContext/hash.ts',
  'src/services/argumentContext/frames.ts', 'src/services/argumentContext/taskScopedReader.ts',
  'src/services/argumentContext/construction.ts', 'src/services/argumentContext/publication.ts',
  'src/services/argumentContext/validator.ts', 'src/services/argumentContext/reader.ts',
  'src/services/argumentContext/buildPrompts.ts', 'src/electron/rag/argumentSourceAdapter.ts',
  'src/electron/rag/argumentProjectionAuthority.ts', 'src/electron/rag/argumentProjectionStore.ts',
  'src/electron/rag/argumentProjectionReader.ts', 'src/electron/rag/chunking.ts',
  'src/electron/rag/sentenceBoundaries.ts', 'src/services/noteReferenceSource.ts',
  'src/workflows/structuredOutput.ts', 'scripts/argument-projection-build-fixture.ts',
  'src/electron/rag/argumentQuestionFrames.ts', 'src/services/userStateService.ts',
  'scripts/reference-disclosure-fixture.ts', 'scripts/review-progressive-dataset.ts',
  'scripts/review-progressive-acceptance-dataset.ts',
  'scripts/review-progressive-fixture.ts', 'scripts/review-progressive-transport.ts',
  'scripts/run-review-progressive-experiment.ts'];
const fingerprintFiles = async () => hash(await Promise.all(sourceFiles.map(async name => [name, sha(await fs.readFile(name))])));
const promptTexts = { extract: FROZEN_REFERENCE_EXTRACTION_PROMPT, reference: FROZEN_REFERENCE_SHADOW_PROMPT };
const label = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
  && value.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value);
async function readRegular(filename: string) {
  assert.ok(path.isAbsolute(filename));
  const directory = path.dirname(filename), root = path.parse(directory).root;
  let current = root;
  for (const part of [null, ...path.relative(root, directory).split(path.sep).filter(Boolean)]) {
    if (part !== null) current = path.join(current, part);
    const parent = await fs.lstat(current);
    assert.ok(parent.isDirectory() && !parent.isSymbolicLink());
  }
  const stat = await fs.lstat(filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024);
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    assert.ok(actual.isFile() && actual.ino === stat.ino && actual.dev === stat.dev && actual.size <= 1024 * 1024);
    const bytes = await handle.readFile();
    assert.ok(bytes.length <= 1024 * 1024 && Buffer.from(bytes.toString('utf8')).equals(bytes));
    return bytes;
  } finally { await handle.close(); }
}
async function loadAuthorizedProvider() {
  const anchorPath = path.join(os.homedir(), '.logi-note', 'storage-config.json');
  const anchorBytes = await readRegular(anchorPath), anchor = JSON.parse(anchorBytes.toString('utf8'));
  assert.ok(typeof anchor.dataRoot === 'string' && path.isAbsolute(anchor.dataRoot));
  const settingsPath = path.join(anchor.dataRoot, 'user-state', 'llm.json');
  const settingsBytes = await readRegular(settingsPath), raw = JSON.parse(settingsBytes.toString('utf8'));
  assert.equal(raw.version, 1);
  const settings = deserializeLlmState(settingsBytes.toString('utf8'));
  assert.ok(settings && Array.isArray(settings.providers) && settings.providers.length <= 100);
  const bound = settings.workflowBinding?.['review-scoring'];
  assert.ok(bound === undefined || label(bound));
  const id = bound ?? settings.defaultProviderId;
  assert.ok(label(id) && new Set(settings.providers.map(p => p.id)).size === settings.providers.length);
  const provider = settings.providers.find(p => p.id === id && p.enabled === true);
  assert.ok(provider && label(provider.name) && provider.apiType === 'openai-compatible'
    && provider.selectedModel === 'deepseek-flash' && typeof provider.apiKey === 'string'
    && !!provider.apiKey.trim() && provider.apiKey.length <= 2000 && !/[\r\n\u0000]/u.test(provider.apiKey));
  const url = new URL(provider.baseUrl);
  assert.ok(url.origin === 'https://api.deepseek.com' && !url.username && !url.password && !url.search && !url.hash
    && ['/', '/v1', '/v1/'].includes(url.pathname));
  const fingerprint = hash([sha(anchorBytes), sha(settingsBytes)]);
  const unchanged = async () => hash([sha(await readRegular(anchorPath)), sha(await readRegular(settingsPath))]) === fingerprint;
  assert.ok(await unchanged());
  // Only the private digest is persisted, never settings, paths, provider IDs or credentials.
  return { provider, fingerprint, unchanged };
}
function safeUsage(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
}
async function boundedResponseJson(response: Response): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('provider_response_missing');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 1024 * 1024) { await reader.cancel(); throw new Error('provider_response_budget_exceeded'); }
      chunks.push(part.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { reader.releaseLock(); }
}

/** The historical acceptance-v3 flag selects the fixed eight-question dataset,
 * not the model wire protocol version. This selector is not cloud authorization.
 * Even the acceptance flag alone is
 * read-only preflight: private settings are reachable only in execute mode. */
export function selectReviewProgressiveExperiment(args: readonly string[]) {
  const execute = args.includes('--execute'), local = args.includes('--local'), acceptance = args.includes('--acceptance-v3');
  assert.ok(new Set(args).size === args.length && args.every(a => ['--execute', '--allow-cloud', '--local', '--acceptance-v3'].includes(a))
    && execute === args.includes('--allow-cloud') && !(execute && local), 'invalid_flags');
  const dataset = acceptance ? REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET : REVIEW_PROGRESSIVE_DATASET;
  assert.equal(dataset.length, acceptance ? 8 : 12);
  assert.equal(new Set(dataset.map(c => c.id)).size, dataset.length);
  assert.ok(dataset.every(c => c.origin === 'synthetic' && c.annotationStatus === 'assistant_draft'));
  return { execute, local, dataset, maxRequests: dataset.length * 2,
    datasetSelection: acceptance ? 'acceptance-v3' as const : 'original-v1' as const,
    datasetVersion: acceptance ? REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET_VERSION : REVIEW_PROGRESSIVE_DATASET_VERSION,
    summarize: acceptance ? summarizeReviewProgressiveAcceptanceReport : summarizeReviewProgressiveReport };
}

export async function runReviewProgressiveExperiment(args: readonly string[]) {
  const { execute, local, dataset, maxRequests, datasetVersion, datasetSelection, summarize } = selectReviewProgressiveExperiment(args);
  const datasetFingerprint = hash(dataset), sourceFingerprint = await fingerprintFiles();
  const filesMatch = async () => await fingerprintFiles() === sourceFingerprint && hash(dataset) === datasetFingerprint;
  const preflight = { datasetVersion, datasetSelection, cases: dataset.length, maxRequests, requestLimitPerCase: 2, automaticRetries: 0,
    wireProtocol: 'review-frozen-reference-typed-v4', comparisonResultProtocol: 'review-frozen-reference-shadow-v1',
    datasetFingerprint, sourceFingerprint, parameters,
    prompts: Object.fromEntries(Object.entries(promptTexts).map(([key, value]) => [key, hash(value)])),
    scoreWrite: 'disabled', cognitionWrite: 'disabled', productionModified: false,
    scope: 'synthetic question -> pre-answer frozen reference -> literal answer extraction -> read-only item comparison',
    limitations: ['Assistant draft annotations, not human-reviewed gold.',
      'Pure memory reference fixtures with a fixed synthetic projection reviewer; not a real-vault recall or reference-construction benchmark.',
      'No UI, formal score adapter, cognition proposals or production writes.',
      'No model weights frozen; model responses and exact request/prompt fingerprints retained.',
      'One pilot cannot approve production automatically.'] };
  console.log(JSON.stringify({ event: 'preflight', ...preflight }));
  if (!execute && !local) return; // No credential reads, artifacts or network by default.
  const config = execute ? await loadAuthorizedProvider() : undefined;
  const parent = path.resolve('data/review-progressive-experiments');
  await fs.mkdir(parent, { recursive: true });
  const mode = execute ? 'cloud' : 'local', output = await fs.mkdtemp(path.join(parent, `${mode}-`));
  const save = (name: string, value: unknown) => fs.writeFile(path.join(output, name), JSON.stringify(value, null, 2), { flag: 'wx' });
  await save('manifest.json', { ...preflight, mode, startedAt: new Date().toISOString(), cases: dataset,
    promptTexts, ...(config ? { model: 'deepseek-flash', provider: 'DeepSeek', configFingerprint: config.fingerprint } : {}) });
  console.log(JSON.stringify({ event: 'started', outputDirectory: output, mode }));
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('implicit_network_forbidden'); };
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop);
  let calls = 0, runError = '';
  const outcomes: ReviewProgressiveOutcome[] = [];
  const stages: { caseId: string; stage: string; milliseconds: number; systemChars: number; userChars: number;
    promptTokens: number | null; completionTokens: number | null; totalTokens: number | null }[] = [];
  let prepared = 0;
  try {
    for (const c of dataset) {
      if (controller.signal.aborted) { runError = 'run_cancelled'; break; }
      if (!(await filesMatch())) { runError = 'frozen_code_changed'; break; }
      const fixture = await prepareReviewProgressiveFixture(c), before = JSON.stringify(fixture.answer);
      await save(`fixture-${c.id}.json`, { answer: fixture.answer, reference: fixture.context,
        sourceFingerprint: fixture.sourceFingerprint, contextHash: fixture.contextHash });
      prepared++;
      if (local) { console.log(JSON.stringify({ event: 'prepared', caseId: c.id, prepared, calls })); continue; }
      let stage = 0, caseRequests = 0, extractionResponse: LlmCallResponse | undefined;
      const caller = async (request: LlmCallRequest, options?: { signal?: AbortSignal }): Promise<LlmCallResponse> => {
        stage++;
        const kind = stage === 1 ? 'extract' : 'reference', name = `${c.id}-${kind}`;
        let inputStats: Awaited<ReturnType<typeof validateReviewProgressiveRequest>>['stats'];
        try {
          assert.ok(stage === 1 || stage === 2);
          inputStats = (await validateReviewProgressiveRequest(request, stage, fixture, extractionResponse)).stats;
        }
        catch { runError = 'harness_input_contract_failed'; throw new Error(runError); }
        assert.ok(config && execute && calls < maxRequests && caseRequests < 2, 'approved_budget_exceeded');
        if (!(await filesMatch())) { runError = 'frozen_code_changed'; throw new Error(runError); }
        if (!(await config.unchanged())) { runError = 'authorized_configuration_changed'; throw new Error(runError); }
        if (options?.signal?.aborted || controller.signal.aborted) { runError = 'run_cancelled'; throw new Error(runError); }
        await save(`request-${name}.json`, request);
        await save(`input-stats-${name}.json`, inputStats);
        const start = performance.now();
        calls++; caseRequests++;
        try {
          const response = await nativeFetch(`${config.provider.baseUrl.replace(/\/+$/u, '')}/chat/completions`, {
            method: 'POST', redirect: 'error', signal: options?.signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.provider.apiKey}` },
            body: JSON.stringify({ model: config.provider.selectedModel, temperature: parameters.temperature,
              max_tokens: request.maxTokensOverride, response_format: parameters.response_format, thinking: parameters.thinking,
              messages: [{ role: 'system', content: request.systemPromptOverride }, { role: 'user', content: request.userInput }] }),
          });
          if (!response.ok) { runError = `provider_http_${response.status}`; throw new Error(runError); }
          const raw = await boundedResponseJson(response);
          const content = raw?.choices?.[0]?.message?.content;
          if (typeof content === 'string' && content.length > 100000) throw new Error('provider_response_budget_exceeded');
          const finishReason = raw?.choices?.[0]?.finish_reason;
          const stats = { caseId: c.id, stage: kind, milliseconds: Math.round(performance.now() - start),
            systemChars: request.systemPromptOverride?.length ?? 0, userChars: request.userInput.length,
            promptTokens: safeUsage(raw?.usage?.prompt_tokens), completionTokens: safeUsage(raw?.usage?.completion_tokens),
            totalTokens: safeUsage(raw?.usage?.total_tokens) };
          stages.push(stats);
          // Persist only the fields used by the evaluator and metrics, no response headers or provider metadata.
          await save(`response-${name}.json`, { content: typeof content === 'string' ? content : '',
            finishReason: typeof finishReason === 'string' ? finishReason : null,
            responseModel: label(raw?.model) ? raw.model : null, usage: stats });
          if (!(await filesMatch()) || !(await config.unchanged())) { runError = 'frozen_environment_changed'; throw new Error(runError); }
          const result: LlmCallResponse = { content: typeof content === 'string' ? content : '',
            diagnostics: { ...(typeof finishReason === 'string' ? { finishReason } : {}) } };
          if (stage === 1) extractionResponse = result;
          return result;
        } catch {
          runError ||= controller.signal.aborted ? 'run_cancelled' : options?.signal?.aborted ? 'request_aborted_or_timed_out' : 'transport_or_provider_failure';
          await save(`error-${name}.json`, { code: runError, milliseconds: Math.round(performance.now() - start) });
          throw new Error(runError);
        }
      };
      const evaluated = await evaluateFrozenReviewReferenceShadow(fixture.answer, fixture.dependencies,
        createFrozenReferenceShadowModel(caller), { signal: controller.signal, timeoutMs: 60000 });
      assert.equal(JSON.stringify(fixture.answer), before);
      assert.equal(evaluated.result.scoreWrite, 'disabled'); assert.equal(evaluated.result.cognitionWrite, 'disabled');
      assert.equal(evaluated.result.modelRequests.total, caseRequests);
      const outcome = judgeReviewProgressiveOutcome(c, evaluated.result);
      outcomes.push(outcome);
      await save(`case-${c.id}.json`, { outcome, ...evaluated, actualRequests: caseRequests });
      console.log(JSON.stringify({ event: 'case', caseId: c.id, completed: outcomes.length, calls,
        status: evaluated.result.status, frames: evaluated.result.frames.map(f => f.status),
        passed: outcome.passed, reasons: evaluated.result.reasons }));
      if (runError || evaluated.result.reasons.some(r => ['shadow_timeout', 'shadow_aborted'].includes(r))) {
        runError ||= 'evaluation_aborted_or_timed_out'; break;
      }
    }
  } catch { runError ||= 'experiment_stopped'; }
  finally { globalThis.fetch = nativeFetch; process.removeListener('SIGINT', stop); }
  const metrics = summarize(outcomes);
  const measuredTokens = stages.reduce((sum, s) => sum + (s.totalTokens ?? 0), 0);
  const report = { ...preflight, finishedAt: new Date().toISOString(), mode, preparationOnly: local, calls,
    prepared, processedAllCases: (local ? prepared : outcomes.length) === dataset.length && !runError,
    observedTotalTokens: measuredTokens, unknownUsageStages: stages.filter(s => s.totalTokens === null).length,
    stages, metrics, ...(runError ? { runError } : {}) };
  await save('report.json', report);
  console.log(JSON.stringify({ event: 'complete', outputDirectory: output, calls, prepared,
    observedTotalTokens: measuredTokens, processedAllCases: report.processedAllCases, metrics, ...(runError ? { runError } : {}) }));
  if (runError) process.exitCode = 1;
  else if (!report.processedAllCases || (!local && !metrics.allCasesPass)) process.exitCode = 2;
}
// Importing the selector/runner for offline guards must not run an experiment.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runReviewProgressiveExperiment(process.argv.slice(2)).catch(() => {
    console.error('Progressive review experiment stopped; no automatic retry or production writes.'); process.exitCode = 1;
  });
}

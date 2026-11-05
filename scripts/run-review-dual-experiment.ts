import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { LlmSettings, LlmCallRequest, LlmCallResponse } from '../src/types';
import { createReviewSemanticModel, readReviewModelJson } from '../src/services/reviewComparison/semanticClient';
import { buildReviewBoundInput, type ReviewComparisonProtocol } from '../src/services/reviewComparison/boundProtocol';
import { REVIEW_BOUND_ALIGNMENT_PROMPT } from '../src/services/reviewComparison/boundPrompts';
import { readReviewPerformanceGraph } from '../src/services/reviewComparison/performanceGraph';
import { buildReviewAnchoredChannel, reviewAnchoredChannels } from '../src/services/reviewComparison/anchoredProtocol';
import { REVIEW_REFERENCE_ANCHORS_PROMPT, REVIEW_PERSONAL_ANCHORS_PROMPT } from '../src/services/reviewComparison/anchoredPrompts';
import { evaluateReviewComparisonPacket } from '../src/services/reviewComparison/semanticEvaluator';
import { REVIEW_DUAL_ALIGNMENT_PROMPT, REVIEW_PERFORMANCE_GRAPH_PROMPT } from '../src/services/reviewComparison/semanticPrompts';
import { REVIEW_DUAL_DATASET } from './review-dual-dataset';
import { prepareReviewDualFixture } from './review-dual-fixture';
import { evaluateReviewDual, REVIEW_DUAL_PILOT_CRITERIA, type ReviewDualOutcome } from './review-dual-evaluation';
import { auditReviewGrowthDirections, REVIEW_GROWTH_DIRECTION_EXPECTATIONS } from './review-growth-direction-audit';
import { validateReviewDualRequest, validateReviewDualBoundRequest, validateReviewDualAnchoredRequest, validateReviewDualReplayInput } from './review-dual-transport';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parameters = { temperature: 0.1, extractionMaxTokens: 4096, comparisonMaxTokens: 8192,
  response_format: { type: 'json_object' }, thinking: { type: 'disabled' } };
const engineFiles = ['semanticTypes.ts', 'performanceGraph.ts', 'semanticValidation.ts', 'semanticOutputs.ts',
  'semanticEvaluator.ts', 'semanticPrompts.ts', 'semanticClient.ts', 'boundProtocol.ts', 'boundPrompts.ts',
  'quoteAnchors.ts', 'anchoredProtocol.ts', 'anchoredPrompts.ts', 'packet.ts', 'session.ts', 'rubricCoverage.ts']
  .map((file) => `src/services/reviewComparison/${file}`)
  .concat(['src/services/cognition/alignment.ts', 'src/services/argumentRelation/direction.ts',
    'src/services/reviewAssessment.ts', 'src/services/reviewIntent.ts', 'src/services/reviewIntentValidation.ts',
    'src/services/reviewReferenceRubric.ts', 'src/services/noteReferenceSource.ts', 'src/electron/rag/chunking.ts',
    'src/electron/rag/sentenceBoundaries.ts']);
const fingerprintEngine = async () => hash(await Promise.all(engineFiles.map(async (file) => [file, await fs.readFile(file, 'utf8')])));
const harnessFiles = ['run-review-dual-experiment.ts', 'review-dual-dataset.ts', 'review-dual-fixture.ts',
  'review-dual-evaluation.ts', 'review-dual-transport.ts', 'review-growth-direction-audit.ts'].map((file) => `scripts/${file}`);
const fingerprintHarness = async () => hash(await Promise.all(harnessFiles.map(async (file) => [file, await fs.readFile(file, 'utf8')])));

async function loadAuthorizedProvider() {
  const anchor = JSON.parse(await fs.readFile(path.join(os.homedir(), '.logi-note/storage-config.json'), 'utf8'));
  if (typeof anchor.dataRoot !== 'string' || !anchor.dataRoot) throw new Error('configured_root_missing');
  const settings: LlmSettings = JSON.parse(await fs.readFile(path.join(anchor.dataRoot, 'user-state/llm.json'), 'utf8')).settings;
  const id = settings.workflowBinding?.['review-scoring'] || settings.defaultProviderId;
  const provider = settings.providers.find((p) => p.id === id && p.enabled);
  if (!provider || provider.apiType !== 'openai-compatible' || !provider.apiKey || provider.selectedModel !== 'deepseek-flash') throw new Error('authorized_model_changed');
  const url = new URL(provider.baseUrl);
  if (url.origin !== 'https://api.deepseek.com' || url.username || url.password || url.search || url.hash
    || !['', '/', '/v1', '/v1/'].includes(url.pathname)) throw new Error('authorized_endpoint_changed');
  return provider;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (new Set(rawArgs).size !== rawArgs.length) throw new Error('invalid_flags');
  if (rawArgs.includes('--bound-pairs') && rawArgs.includes('--anchored-channels')) throw new Error('invalid_flags');
  const comparisonProtocol: ReviewComparisonProtocol = rawArgs.includes('--anchored-channels') ? 'isolated-anchors-v3'
    : rawArgs.includes('--bound-pairs') ? 'bound-v2' : 'legacy-v1';
  const isolated = comparisonProtocol === 'isolated-anchors-v3';
  const comparePrompt = comparisonProtocol === 'bound-v2' ? REVIEW_BOUND_ALIGNMENT_PROMPT : REVIEW_DUAL_ALIGNMENT_PROMPT;
  const args = rawArgs.filter((arg) => !['--bound-pairs', '--anchored-channels'].includes(arg)), candidateReplay = args.includes('--replay-candidate');
  const replayIndex = args.indexOf(candidateReplay ? '--replay-candidate' : '--replay');
  const execute = args.includes('--execute'), local = args.includes('--local');
  const replay = replayIndex >= 0 ? args[replayIndex + 1] : undefined;
  if (new Set(args).size !== args.length || (replayIndex >= 0 && (args.length !== 2 || replayIndex !== 0 || !replay))
    || (replayIndex < 0 && args.some((flag) => !['--execute', '--allow-cloud', '--local'].includes(flag)))
    || execute !== args.includes('--allow-cloud') || (execute && local)) throw new Error('invalid_flags');
  assert.equal(REVIEW_DUAL_DATASET.length, 28);
  assert.ok(REVIEW_DUAL_DATASET.every((c) => c.origin === 'synthetic' && c.annotationStatus === 'assistant_draft'));
  const requestLimitPerCase = isolated ? 3 : 2;
  // Each synthetic fixture has one extraction, an optional reference review and an optional personal review.
  const maxRequests = isolated ? REVIEW_DUAL_DATASET.reduce((sum, c) => sum + 1 + (c.references.length ? 1 : 0) + (c.personal ? 1 : 0), 0) : 56;
  const promptTexts = isolated ? { extract: REVIEW_PERFORMANCE_GRAPH_PROMPT, reference: REVIEW_REFERENCE_ANCHORS_PROMPT, personal: REVIEW_PERSONAL_ANCHORS_PROMPT }
    : { extract: REVIEW_PERFORMANCE_GRAPH_PROMPT, compare: comparePrompt };
  const datasetFingerprint = hash(REVIEW_DUAL_DATASET), engineFingerprint = await fingerprintEngine(), harnessFingerprint = await fingerprintHarness();
  const frozenFilesMatch = async () => (await fingerprintEngine() === engineFingerprint) && (await fingerprintHarness() === harnessFingerprint);
  const preflight = { cases: 28, maxRequests, requestLimitPerCase, automaticRetries: 0, comparisonProtocol, datasetFingerprint, engineFingerprint, harnessFingerprint,
    prompts: Object.fromEntries(Object.entries(promptTexts).map(([key, value]) => [key, hash(value)])),
    parameters, criteria: REVIEW_DUAL_PILOT_CRITERIA, productionModified: false,
    ...(isolated ? { additionalDirectionAudit: { version: 1, annotationStatus: 'assistant_draft', expectations: REVIEW_GROWTH_DIRECTION_EXPECTATIONS } } : {}),
    scope: 'synthetic question intent -> fixture retrieval -> extraction -> dual alignment -> read-only outputs',
    limitations: ['Assistant draft annotations, not human-reviewed gold.', 'Fixture retrieval, not a real-library recall benchmark.',
      'No UI, candidate confirmation, score adapter or production writes.', 'Pilot cannot approve production automatically.'] };
  console.log(JSON.stringify({ event: 'preflight', ...preflight }));
  if (!execute && !local && !replay) return; // Default does not read configuration, credentials or call a model.
  const parent = path.resolve('data/review-dual-experiments');
  let replayRoot: string | undefined;
  let replayEngineFingerprint: string | undefined;
  if (replay) {
    replayRoot = path.resolve(replay);
    const relative = path.relative(parent, replayRoot);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('invalid_replay_path');
    const manifest = JSON.parse(await fs.readFile(path.join(replayRoot, 'manifest.json'), 'utf8'));
    if ((manifest.comparisonProtocol || 'legacy-v1') !== comparisonProtocol) throw new Error('replay_protocol_mismatch');
    if (manifest.mode !== 'cloud' || manifest.datasetFingerprint !== datasetFingerprint || (!candidateReplay && manifest.engineFingerprint !== engineFingerprint)
      || hash(manifest.cases) !== datasetFingerprint || JSON.stringify(manifest.criteria) !== JSON.stringify(REVIEW_DUAL_PILOT_CRITERIA)) {
      throw new Error('replay_fingerprint_mismatch');
    }
    replayEngineFingerprint = manifest.engineFingerprint;
  }
  const provider = execute ? await loadAuthorizedProvider() : undefined;
  await fs.mkdir(parent, { recursive: true });
  const mode = execute ? 'cloud' : replay ? candidateReplay ? 'replay-candidate' : 'replay' : 'local';
  const output = await fs.mkdtemp(path.join(parent, `${mode}-`));
  const save = (name: string, value: unknown) => fs.writeFile(path.join(output, name), JSON.stringify(value, null, 2), { flag: 'wx' });
  await save('manifest.json', { ...preflight, mode, startedAt: new Date().toISOString(), cases: REVIEW_DUAL_DATASET,
    model: provider?.selectedModel, replaySource: replayRoot, replayEngineFingerprint,
    frozenModelOutputs: !!replayRoot, promptEffectsMeasured: !replayRoot && execute,
    candidateReplayLimitations: candidateReplay ? ['New prompts are NOT tested; only stored model outputs are revalidated.',
      'Missing stage responses remain incomplete, never synthesized or fetched.', 'Changed comparison input cannot reuse its old response.',
      'Candidate replay can never pass pilot or approve production.'] : undefined,
    promptTexts });
  console.log(JSON.stringify({ event: 'started', outputDirectory: output, mode }));
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('implicit_network_forbidden'); };
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop);
  const outcomes: ReviewDualOutcome[] = [];
  let calls = 0, tokens = 0, transportError = '', runError = '';
  try {
    for (const c of REVIEW_DUAL_DATASET) {
      if (controller.signal.aborted) { runError = 'run_cancelled'; break; }
      if (!(await frozenFilesMatch()) || hash(REVIEW_DUAL_DATASET) !== datasetFingerprint) {
        runError = 'frozen_code_changed'; break;
      }
      const fixture = await prepareReviewDualFixture(c), before = JSON.stringify(fixture.packet);
      await save(`packet-${c.id}.json`, fixture.packet);
      if (local) {
        if (comparisonProtocol !== 'legacy-v1') {
          const graph = readReviewPerformanceGraph({ version: 1, packetId: fixture.packet.packetId,
            claims: [{ id: 'A1', role: 'fact', quote: fixture.packet.answer.text }], edges: [], requirements: [] }, fixture.packet);
          if (isolated) for (const channel of reviewAnchoredChannels(fixture.packet)) {
            await save(`anchor-contract-probe-${c.id}-${channel}.json`, await buildReviewAnchoredChannel(fixture.packet, graph, channel));
          } else await save(`bound-contract-probe-${c.id}.json`, await buildReviewBoundInput(fixture.packet, graph));
        }
        outcomes.push({ id: c.id, requests: 0 });
        console.log(JSON.stringify({ event: 'prepared', id: c.id, completed: outcomes.length }));
        continue;
      }
      let stage = 0, caseRequests = 0, caseError = '';
      let extractionResponse: LlmCallResponse | undefined;
      const caller = async (request: LlmCallRequest, options?: { signal?: AbortSignal }): Promise<LlmCallResponse> => {
        stage++;
        const suppliedChannel = isolated && stage > 1 ? JSON.parse(request.userInput).channel : undefined;
        const label = stage === 1 ? 'extract' : isolated ? ['reference', 'personal'].includes(suppliedChannel) ? suppliedChannel : 'invalid-channel' : 'compare';
        const name = `${c.id}-${label}`;
        try {
          if (isolated) await validateReviewDualAnchoredRequest(request, stage, fixture.packet,
            stage > 1 && extractionResponse ? readReviewPerformanceGraph(readReviewModelJson(extractionResponse), fixture.packet) : undefined);
          else if (comparisonProtocol === 'bound-v2') await validateReviewDualBoundRequest(request, stage, fixture.packet,
            stage === 2 && extractionResponse ? readReviewPerformanceGraph(readReviewModelJson(extractionResponse), fixture.packet) : undefined);
          else validateReviewDualRequest(request, stage, fixture.packet);
        }
        catch {
          caseError = 'harness_input_contract_failed'; runError = caseError;
          await save(`error-${name}.json`, { code: caseError });
          throw new Error(caseError);
        }
        await save(`request-${name}.json`, request); // No provider secrets are stored in the request object.
        let raw: any;
        if (replayRoot) {
          try {
            const saved = JSON.parse(await fs.readFile(path.join(replayRoot, `request-${name}.json`), 'utf8'));
            try { validateReviewDualReplayInput(request, saved); }
            catch { caseError = 'replay_input_changed'; throw new Error(caseError); }
            raw = JSON.parse(await fs.readFile(path.join(replayRoot, `response-${name}.json`), 'utf8')); caseRequests++;
          } catch {
            caseError ||= 'replay_response_missing';
            await save(`error-${name}.json`, { code: caseError });
            throw new Error(caseError);
          }
        } else {
          assert.ok(execute && provider && calls < maxRequests && caseRequests < requestLimitPerCase, 'Approved cloud budget exceeded');
          if (!(await frozenFilesMatch())) { runError = 'frozen_code_changed'; throw new Error(runError); }
          calls++; caseRequests++;
          try {
            const response = await nativeFetch(`${provider.baseUrl.replace(/\/+$/u, '')}/chat/completions`, {
              method: 'POST', redirect: 'error', signal: options?.signal,
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
              body: JSON.stringify({ model: provider.selectedModel, temperature: parameters.temperature,
                max_tokens: request.maxTokensOverride, response_format: parameters.response_format, thinking: parameters.thinking,
                messages: [{ role: 'system', content: request.systemPromptOverride }, { role: 'user', content: request.userInput }] }),
            });
            if (!response.ok) { transportError = `provider_http_${response.status}`; throw new Error(transportError); }
            raw = await response.json();
          } catch {
            transportError ||= controller.signal.aborted ? 'run_cancelled' : 'transport_or_provider_failure';
            await save(`error-${name}.json`, { code: transportError });
            throw new Error(transportError);
          }
        }
        await save(`response-${name}.json`, raw);
        if (typeof raw.usage?.total_tokens === 'number' && Number.isFinite(raw.usage.total_tokens)) tokens += raw.usage.total_tokens;
        const response = { content: typeof raw.choices?.[0]?.message?.content === 'string' ? raw.choices[0].message.content : '',
          diagnostics: { finishReason: raw.choices?.[0]?.finish_reason } };
        if (stage === 1) extractionResponse = response;
        return response;
      };
      const result = await evaluateReviewComparisonPacket(fixture.packet, fixture.dependencies, createReviewSemanticModel(caller, { comparisonProtocol }),
        { signal: controller.signal, timeoutMs: 60000 });
      assert.equal(JSON.stringify(fixture.packet), before, 'Evaluation modified the packet');
      assert.equal(result.writes, 'disabled');
      const outcome: ReviewDualOutcome = { id: c.id, result, requests: caseRequests,
        ...((caseError || transportError) ? { error: caseError || transportError } : {}) };
      outcomes.push(outcome);
      await save(`case-${c.id}.json`, outcome);
      console.log(JSON.stringify({ event: 'case', id: c.id, completed: outcomes.length, calls,
        status: result.status, growth: result.growth.status, reasons: result.reasons, ...(caseError ? { error: caseError } : {}) }));
      if (transportError || runError || result.reasons.includes('semantic_timeout') || result.reasons.includes('semantic_aborted')) break;
    }
  } catch { runError ||= 'experiment_stopped'; }
  finally { globalThis.fetch = nativeFetch; process.removeListener('SIGINT', stop); }
  const metrics = evaluateReviewDual(REVIEW_DUAL_DATASET, outcomes, mode, { requestLimitPerCase });
  const growthDirectionAudit = isolated ? auditReviewGrowthDirections(outcomes) : undefined;
  const report = { finishedAt: new Date().toISOString(), comparisonProtocol, datasetFingerprint, engineFingerprint, harnessFingerprint, mode, calls,
    tokens: execute ? tokens : 0, ...(replayRoot ? { replayedResponseTokens: tokens, replayEngineFingerprint,
      frozenModelOutputs: true, promptEffectsMeasured: false } : {}),
    processedAllCases: outcomes.length === 28 && !transportError && !runError,
    evaluationCompletedAllCases: metrics.completed === 28,
    completedAllCases: outcomes.length === 28 && !transportError && !runError,
    preparationOnly: local, ...(runError ? { runError } : {}), metrics,
    ...(growthDirectionAudit ? { growthDirectionAudit } : {}) };
  await save('report.json', report);
  console.log(JSON.stringify({ event: 'complete', outputDirectory: output, calls, tokens: report.tokens,
    processedAllCases: report.processedAllCases, evaluationCompletedAllCases: report.evaluationCompletedAllCases,
    metrics: { ...report.metrics, rows: undefined }, ...(growthDirectionAudit ? { growthDirectionAudit } : {}) }));
  if (!report.completedAllCases || (!local && (!report.metrics.pilotPassed || growthDirectionAudit?.ready === false))) process.exitCode = 2;
}
main().catch(() => { console.error('Review dual experiment stopped; no automatic retry or production writes.'); process.exitCode = 1; });

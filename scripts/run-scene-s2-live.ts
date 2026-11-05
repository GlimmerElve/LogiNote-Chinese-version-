/** Explicitly approved, synthetic-only S2 validation. Never writes production scenes/settings. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callLLM } from '../src/services/llmService';
import { proxyLlmRequest } from '../src/electron/apiHandlers';
import type { LlmProvider } from '../src/types';
import { runS2AgentValidation, S2ValidationStop } from './scene-s2-agent-validation';
import { createS2ExactReplay } from './scene-s2-exact-replay';
import { readS2Definition, reviewS2CanvasCandidate } from '../src/services/scene/sceneS2Canvas';
import { readS2DesignBrief } from '../src/services/scene/sceneS2Design';
import { runS2TargetedValidation } from './scene-s2-targeted-validation';
import { runS2UiAgentValidation } from './scene-s2-ui-agent-validation';
import { runS2BusinessValidation } from './scene-s2-business-validation';
import { runS2BusinessInteractionValidation } from './scene-s2-business-interaction-validation';
import { s2TaskCase } from './scene-s2-task-cases';
import { prepareS2TaskReplay } from './scene-s2-task-replay';

const args = process.argv.slice(2);
const taskAt = args.indexOf('--task-case');
const acceptanceTask = taskAt >= 0 ? s2TaskCase(args[taskAt + 1] ?? '') : undefined;
if (taskAt >= 0) args.splice(taskAt, 2);
const taskBuildOnly = args.includes('--task-build-only');
if (taskBuildOnly) { assert(acceptanceTask, '--task-build-only requires --task-case'); args.splice(args.indexOf('--task-build-only'), 1); }
const blindScopeReview = args.at(-1) === '--scope-review-blind';
const scopeReview = blindScopeReview || args.at(-1) === '--scope-review'; if (scopeReview) args.pop();
const scopeSourceAt = args.indexOf('--scope-source');
const scopeSourceId = scopeSourceAt >= 0 ? args[scopeSourceAt + 1] : undefined;
if (scopeSourceAt >= 0) {
  assert(scopeReview && !blindScopeReview && scopeSourceAt === 5 && args.length === 7 && scopeSourceId,
    'Explicit scope source is only a prior UI-chain ancestor of this exact continuing approval');
  args.splice(scopeSourceAt, 2);
}
const businessInteractionOnly = args.at(-1) === '--business-interaction-only'; if (businessInteractionOnly) args.pop();
const businessBuildOnly = args.at(-1) === '--business-build-only'; if (businessBuildOnly) args.pop();
const businessChainFlag = args.at(-1) === '--business-chain'; if (businessChainFlag) args.pop();
assert(!(businessBuildOnly && businessChainFlag), 'Choose build-preview-only or whole business chain');
assert(!(businessInteractionOnly && (businessBuildOnly || businessChainFlag)), 'Choose one business validation scope');
const businessChain = businessBuildOnly || businessChainFlag || businessInteractionOnly;
const legacyUiChain = args.at(-1) === '--ui-chain'; if (legacyUiChain) args.pop();
assert(!(businessChain && legacyUiChain), 'Choose one whole-chain validation profile');
assert(!acceptanceTask || !businessChain && !legacyUiChain, 'Choose a task case or a legacy validation profile');
const uiChain = businessChain || legacyUiChain || !!acceptanceTask;
const reviewOnlyAt = args.indexOf('--review-only');
const reviewOnlyId = reviewOnlyAt >= 0 ? args[reviewOnlyAt + 1] : undefined;
if (reviewOnlyAt >= 0) { assert(reviewOnlyId && reviewOnlyAt === args.length - 2); args.splice(reviewOnlyAt, 2); }
const targeted = args.at(-1) === '--targeted'; if (targeted) args.pop();
const maxCalls = targeted ? 14 : 24, maxOutputTokens = targeted ? 28000 : 48000;
const smallActions = args.at(-1) === '--small-actions'; if (smallActions) args.pop();
const compact = args.at(-1) === '--compact'; if (compact) args.pop();
const buildHint = args.at(-1) === '--build-hint'; if (buildHint) args.pop();
const focus = args.at(-1) === '--focus'; if (focus) args.pop();
const draftAt = args.indexOf('--interaction-draft');
const draftId = draftAt >= 0 ? args[draftAt + 1] : undefined;
if (draftAt >= 0) { assert(draftAt === 3 || draftAt === 5); assert(draftId); args.splice(draftAt, 2); }
const replayAt = args.indexOf('--replay-prefix');
const replayId = replayAt >= 0 ? args[replayAt + 1] : undefined;
if (replayAt >= 0) { assert(replayAt === 3 || replayAt === 5); assert(replayId); args.splice(replayAt, 2); }
const acceptedSourceAt = args.indexOf('--accepted-source');
const acceptedSourceId = acceptedSourceAt >= 0 ? args[acceptedSourceAt + 1] : undefined;
if (acceptedSourceAt >= 0) { assert(businessInteractionOnly && acceptedSourceId); args.splice(acceptedSourceAt, 2); }
const newApprovalAt = args.indexOf('--new-approval-after');
const newApprovalId = newApprovalAt >= 0 ? args[newApprovalAt + 1] : undefined;
if (newApprovalAt >= 0) { assert(businessInteractionOnly && acceptedSourceId && newApprovalId); args.splice(newApprovalAt, 2); }
assert(!businessInteractionOnly || !replayId && !draftId && (newApprovalId ? args.length === 3
  : args.length === 5 && args[3] === '--continue-after'),
  'Business interaction subset requires an explicit new approval transition or the continuing approval ledger');
const businessPaidContinuation = businessChain && !!replayId;
const taskPaidContinuation = !!acceptanceTask && taskBuildOnly && !!replayId;
assert(!acceptanceTask || !replayId || taskPaidContinuation && args.length === 5 && args[4] === replayId,
  'Task replay only continues the immediate paid build-only endpoint for the exact same task');
assert(!smallActions || compact && focus && (!!replayId || !!draftId)); assert(!replayId || !draftId);
assert(!focus || !buildHint); const profile: 'build-hint' | 'focus' | 'full' = buildHint ? 'build-hint' : focus ? 'focus' : 'full';
assert(!targeted || !!draftId && !replayId && !focus && !buildHint && !smallActions, 'Targeted mode requires only a genuine prior draft');
assert(!reviewOnlyId || targeted);
assert(!uiChain || !targeted && !draftId && (!replayId || (businessPaidContinuation || taskPaidContinuation) && args.length === 5 && args[3] === '--continue-after')
  && !focus && !buildHint && !compact && !smallActions,
  'Whole-chain replay is restricted to the exact prior paid business prefix within the same continuing approval');
assert(!scopeReview || !uiChain && !targeted && !draftId && !replayId && !focus && !buildHint && !compact && !smallActions && !reviewOnlyId
  && args.length === 5 && args[3] === '--continue-after', 'Scope review must reuse the exact previous approval and actual failed UI-chain candidate');
if (!args.length) {
if (acceptanceTask) console.log(`Task case: ${acceptanceTask.id}. Fresh two-Agent design and actual production handlers; no supplied finished graph. Three task cases share ONE explicit 24-request/48000-reserved-token approval via --continue-after, not three new budgets. Human choices are synthetic user actions, never model answers. Prompt assembly tests LOCAL assembly only, not an LLM experiment. NOT browser rendering.`);
if (taskBuildOnly) console.log('Scope: fresh builder and preview ONLY. No interaction, execution, independent interaction review or whole-chain pass.');
if (acceptanceTask) console.log('For a failed build-only task, --replay-prefix PRIOR_ID with --continue-after that SAME PRIOR_ID verifies two exact paid stages, all source reservations and current repair reachability before a one-use claim. Only build/preview repair is tested, never fresh understanding/assembly or the interaction chain; no approval reset.');
console.log('Dry run: --execute --run-id UNIQUE_ID [--continue-after PRIOR_ID] [--interaction-draft ID] [--focus|--build-hint] [--compact]. --ui-chain starts a fresh design through production preview/start/confirmation handlers (deterministic hooks, NOT browser rendering); --business-interaction-only requires --continue-after the directly preceding accepted synthetic business-build-only result, or --accepted-source BUILD_ID with --new-approval-after PREVIOUS_INTERACTION_ID for an explicitly newly authorized 24/48000 ledger; continue that new ledger with --accepted-source BUILD_ID --continue-after NEW_LEDGER_RUN_ID. New approval never resets or overwrites the old ledger, records prior+current aggregate usage, and single-use claims the old endpoint. Reuses the immutable accepted definition, tests only three read-only conversations with 1 request / 2048 tokens held for one judge, never full-chain acceptance. --business-build-only stops after fresh staged design and preview, explicitly NOT interaction or whole-chain acceptance. --business-chain adds a reachable local parse/table goal, on-demand business skills and evidence-based assessment through the same production handlers. Both enforce 24 requests / 48000 reserved output tokens, hold 1 request / 2048 tokens for one evidence-ID review with no judge format retry, turn output cap1536, long requirement understanding3072, assembly6144; production protocol field repairs1536 remain separate. --targeted requires a genuine --interaction-draft and enforces 14 / 28000 with 1 / 2048 held for review; never builder acceptance. --scope-review continues the ledger for a single read-only candidate review (2048 cap); --scope-source ANCESTOR can select a failed UI-chain candidate earlier in this same approval chain, never reset its budget. --scope-review-blind continues that review ledger without prior conclusions (1536 cap). Neither starts a host nor counts as full build acceptance. Explicit current-run approval required. Synthetic only; no automatic transport retry.');
} else {
  assert(args.length === 3 || args.length === 5);
  assert.equal(args[0], '--execute'); assert.equal(args[1], '--run-id');
  const runId = args[2], safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
  assert(safeId.test(runId)); if (args.length === 5) { assert.equal(args[3], '--continue-after'); assert(safeId.test(args[4]) && args[4] !== runId); }
  assert(!acceptedSourceId || safeId.test(acceptedSourceId) && acceptedSourceId !== runId);
  assert(!newApprovalId || safeId.test(newApprovalId) && newApprovalId !== runId && newApprovalId !== acceptedSourceId);
  const acceptedModelSource = businessInteractionOnly ? acceptedSourceId ?? args[4] : undefined;
  const ledgerPredecessorId = newApprovalId ?? (args.length === 5 ? args[4] : undefined);
  const root = path.resolve('.ui-preview', 's2-agent-live'), output = path.join(root, runId);
  assert(!replayId || safeId.test(replayId) && replayId !== runId);
  assert(!draftId || safeId.test(draftId) && draftId !== runId);
  assert(!reviewOnlyId || safeId.test(reviewOnlyId) && reviewOnlyId !== runId && args[4] === reviewOnlyId,
    'Review-only must continue the exact prior approval ledger');
  assert(!scopeSourceId || safeId.test(scopeSourceId) && scopeSourceId !== runId);
  const anchor = JSON.parse(await fs.readFile(path.join(os.homedir(), '.logi-note', 'storage-config.json'), 'utf8'));
  const settings = JSON.parse(await fs.readFile(path.join(anchor.dataRoot, 'user-state', 'llm.json'), 'utf8')).settings;
  const selectedId = settings.workflowBinding['scene-general-turn'] || settings.defaultProviderId;
  const selected = settings.providers.find((p: LlmProvider) => p.id === selectedId && p.enabled);
  assert(selected?.apiType === 'openai-compatible' && selected.apiKey?.trim(), 'Current scene provider unavailable');
  const provider: LlmProvider = structuredClone(selected), base = new URL(provider.baseUrl);
  assert.equal(base.protocol, 'https:'); assert(!base.username && !base.password && !base.search && !base.hash);
  const endpoint = provider.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const replayManifest = replayId ? JSON.parse(await fs.readFile(path.join(root, replayId, 'manifest.json'), 'utf8')) : undefined;
  if (replayManifest) {
    assert.equal(replayManifest.provider.id, provider.id); assert.equal(replayManifest.provider.model, provider.selectedModel);
    assert.equal(replayManifest.provider.origin, base.origin); assert.equal(replayManifest.syntheticOnly, true);
    if (businessPaidContinuation) {
      assert.equal(replayManifest.profile, businessBuildOnly ? 'business-build-only' : 'business-chain');
      assert.deepEqual(replayManifest.approval, { maxCalls, reservedOutputTokens: maxOutputTokens });
    }
  }
  let replay = createS2ExactReplay(replayId && !taskPaidContinuation ? await Promise.all((businessPaidContinuation && businessBuildOnly ? [1, 2] : [1, 2, 3]).map(async index => ({
    request: JSON.parse(await fs.readFile(path.join(root, replayId, `request-${index}.json`), 'utf8')),
    response: JSON.parse(await fs.readFile(path.join(root, replayId, `response-${index}.json`), 'utf8')),
  }))) : []);
  let unacceptedModelDraft: ReturnType<typeof readS2Definition> | undefined;
  if (draftId) {
    const sourceRoot = path.join(root, draftId), manifest = JSON.parse(await fs.readFile(path.join(sourceRoot, 'manifest.json'), 'utf8'));
    assert.equal(manifest.syntheticOnly, true); assert.deepEqual(manifest.provider, { id: provider.id, model: provider.selectedModel, origin: base.origin });
    const paidBrief = JSON.parse(await fs.readFile(path.join(sourceRoot, 'replay-1.json'), 'utf8'));
    const brief = readS2DesignBrief(JSON.parse(paidBrief.paidResponse.content), JSON.parse(paidBrief.exactRequest.userInput).sources);
    // This diagnostic mode uses a real model's full draft only, never a handwritten graph or acceptance stub.
    const files = (await fs.readdir(sourceRoot)).filter(name => /^response-\d+\.json$/.test(name)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    for (const name of files) {
      const response = JSON.parse(await fs.readFile(path.join(sourceRoot, name), 'utf8'));
      if (response.diagnostics?.finishReason !== 'stop') continue;
      const raw = JSON.parse(response.content);
      if (raw.version === 1 && raw.initial) { unacceptedModelDraft = readS2Definition({ ...raw, designBrief: brief }); break; }
    }
    assert(unacceptedModelDraft, 'No complete, schema-valid real model draft available');
  }
  const metadata = { id: provider.id, model: provider.selectedModel, origin: base.origin };
  const approvalLimits = { maxCalls, reservedOutputTokens: maxOutputTokens };
  type Usage = { calls: number; outputTokensReserved: number };
  type ApprovalSnapshot = { runId: string; provider: typeof metadata; limits: typeof approvalLimits; usage: Usage; aggregateUsage: Usage };
  type ApprovalTransition = { kind: 'new-approval'; previous: ApprovalSnapshot };
  const readUsage = (value: Usage): Usage => {
    assert(value && Number.isSafeInteger(value.calls) && value.calls >= 0
      && Number.isSafeInteger(value.outputTokensReserved) && value.outputTokensReserved >= 0, 'Invalid approval usage');
    return { calls: value.calls, outputTokensReserved: value.outputTokensReserved };
  };
  const addUsage = (left: Usage, right: Usage) => readUsage({ calls: left.calls + right.calls,
    outputTokensReserved: left.outputTokensReserved + right.outputTokensReserved });
  const boundedUsage = (value: Usage) => {
    const checked = readUsage(value); assert(checked.calls <= maxCalls && checked.outputTokensReserved <= maxOutputTokens, 'Approval usage exceeds its immutable ceilings'); return checked;
  };
  let prior: Usage = { calls: 0, outputTokensReserved: 0 };
  let approvalLedgerRoot: string | undefined, approvalTransition: ApprovalTransition | undefined;
  let aggregateBase: Usage = { calls: 0, outputTokensReserved: 0 };
  if (args.length === 5) {
    const priorRoot = path.join(root, args[4]);
    const previous = JSON.parse(await fs.readFile(path.join(priorRoot, 'report.json'), 'utf8'));
    assert.equal(previous.provider.id, provider.id); assert.equal(previous.provider.model, provider.selectedModel); assert.equal(previous.provider.origin, base.origin);
    prior = previous.approvalUsage;
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(priorRoot, 'manifest.json'), 'utf8')).approval,
      { maxCalls, reservedOutputTokens: maxOutputTokens }, 'Cannot switch approval ceilings during continuation');
    assert(Number.isSafeInteger(prior.calls) && prior.calls >= 0 && prior.calls < maxCalls);
    assert(Number.isSafeInteger(prior.outputTokensReserved) && prior.outputTokensReserved >= 0 && prior.outputTokensReserved < maxOutputTokens);
    if (acceptanceTask) {
      const previousManifest = JSON.parse(await fs.readFile(path.join(priorRoot, 'manifest.json'), 'utf8'));
      assert.equal(previousManifest.profile, 'ui-chain'); assert.equal(previous.profile, 'ui-chain');
      s2TaskCase(previousManifest.taskCaseId); assert.equal(previous.taskCaseId, previousManifest.taskCaseId);
      assert.equal(previousManifest.syntheticOnly, true); assert.equal(previousManifest.productionWrites, 0);
      assert.equal(previous.execution, 'real-provider'); assert.equal(previous.productionWrites, 0);
      assert.deepEqual(previousManifest.provider, metadata);
    }
  }
  let acceptedDefinition: ReturnType<typeof readS2Definition> | undefined;
  let acceptedSourceUsage: Usage | undefined;
  if (businessInteractionOnly) {
    const sourceRoot = path.join(root, acceptedModelSource!);
    const sourceManifest = JSON.parse(await fs.readFile(path.join(sourceRoot, 'manifest.json'), 'utf8'));
    const sourceReport = JSON.parse(await fs.readFile(path.join(sourceRoot, 'report.json'), 'utf8'));
    assert.equal(sourceManifest.profile, 'business-build-only'); assert.equal(sourceManifest.syntheticOnly, true);
    assert.deepEqual(sourceManifest.provider, { id: provider.id, model: provider.selectedModel, origin: base.origin });
    assert.deepEqual(sourceManifest.approval, { maxCalls, reservedOutputTokens: maxOutputTokens });
    assert.equal(sourceReport.profile, 'business-build-only'); assert.equal(sourceReport.caseId, 'business-chain');
    assert.deepEqual(sourceReport.provider, metadata);
    assert.equal(sourceReport.execution, 'real-provider'); assert.equal(sourceReport.productionWrites, 0);
    assert.equal(sourceManifest.productionWrites, 0);
    acceptedSourceUsage = boundedUsage(sourceReport.approvalUsage);
    assert.equal(sourceReport.buildAccepted, true); assert.equal(sourceReport.buildPreviewPassed, true);
    const savedDefinition = JSON.parse(await fs.readFile(path.join(sourceRoot, 'definition.json'), 'utf8'));
    assert.deepEqual(sourceReport.definition, savedDefinition, 'Accepted scene must exactly match the immutable saved model artifact');
    acceptedDefinition = readS2Definition(savedDefinition, { requireBusiness: true });
  }
  if (businessInteractionOnly && acceptedSourceId) {
    const ledgerCache = new Map<string, { manifest: any; report: any; snapshot: ApprovalSnapshot }>();
    const readInteractionLedger = async (id: string) => {
      assert(safeId.test(id) && id !== runId, 'Invalid interaction ledger source');
      if (ledgerCache.has(id)) return ledgerCache.get(id)!;
      const ledgerRoot = path.join(root, id);
      const manifest = JSON.parse(await fs.readFile(path.join(ledgerRoot, 'manifest.json'), 'utf8'));
      const report = JSON.parse(await fs.readFile(path.join(ledgerRoot, 'report.json'), 'utf8'));
      assert.equal(manifest.profile, 'business-interaction-only'); assert.equal(report.profile, 'business-interaction-only');
      assert.equal(manifest.syntheticOnly, true); assert.deepEqual(manifest.provider, metadata); assert.deepEqual(report.provider, metadata);
      assert.deepEqual(manifest.approval, approvalLimits); assert.equal(manifest.productionWrites, 0); assert.equal(report.productionWrites, 0);
      assert.equal(report.execution, 'real-provider'); assert.equal(manifest.acceptedModelSource, acceptedSourceId); assert.equal(report.acceptedModelSource, acceptedSourceId);
      assert.equal(manifest.businessInteractionSubsetTested, true); assert.equal(report.businessInteractionSubsetTested, true);
      assert.equal(report.passed, false); assert.equal(report.buildAccepted, false); assert.equal(report.interactionPassed, false);
      const usage = boundedUsage(report.approvalUsage), ledgerPrior = boundedUsage(manifest.prior);
      assert(usage.calls >= ledgerPrior.calls && usage.outputTokensReserved >= ledgerPrior.outputTokensReserved, 'A ledger cannot discard its inherited usage');
      let aggregateUsage = usage;
      if (manifest.approvalTransition !== undefined) {
        const transition = manifest.approvalTransition as ApprovalTransition;
        assert.equal(transition.kind, 'new-approval'); assert(safeId.test(transition.previous?.runId) && transition.previous.runId !== id);
        assert.deepEqual(transition.previous.provider, metadata); assert.deepEqual(transition.previous.limits, approvalLimits);
        const previousUsage = boundedUsage(transition.previous.usage), previousAggregate = readUsage(transition.previous.aggregateUsage);
        assert(previousAggregate.calls >= previousUsage.calls && previousAggregate.outputTokensReserved >= previousUsage.outputTokensReserved);
        assert(safeId.test(manifest.approvalLedgerRoot)); assert.equal(report.approvalLedgerRoot, manifest.approvalLedgerRoot);
        assert.deepEqual(report.approvalTransition, transition); assert.deepEqual(report.prior, ledgerPrior);
        assert.deepEqual(manifest.aggregateApprovalUsage, addUsage(previousAggregate, ledgerPrior));
        aggregateUsage = addUsage(previousAggregate, usage); assert.deepEqual(report.aggregateApprovalUsage, aggregateUsage);
      } else {
        assert.equal(manifest.approvalLedgerRoot, undefined); assert.equal(report.approvalLedgerRoot, undefined);
        assert.equal(report.approvalTransition, undefined);
        if (report.aggregateApprovalUsage !== undefined) assert.deepEqual(report.aggregateApprovalUsage, usage);
      }
      const result = { manifest, report, snapshot: { runId: id, provider: metadata, limits: approvalLimits, usage, aggregateUsage } };
      ledgerCache.set(id, result); return result;
    };
    const readLegacyInteractionOrigin = async (id: string) => {
      const previous = await readInteractionLedger(id);
      assert.equal(previous.manifest.approvalTransition, undefined, 'The original direct interaction ledger must not contain a new approval transition');
      assert.equal(previous.manifest.approvalLedgerRoot, undefined);
      assert.deepEqual(previous.manifest.prior, acceptedSourceUsage, 'The original interaction must inherit the accepted build ledger exactly');
      const sourceEdge = JSON.parse(await fs.readFile(path.join(root, acceptedSourceId, 'continued-by.json'), 'utf8'));
      assert.deepEqual(sourceEdge, { runId: id }, 'The accepted build must have directly continued into this original interaction ledger');
      return previous;
    };
    const verifiedEndpoints = new Map<string, Awaited<ReturnType<typeof readInteractionLedger>>>();
    const verifying = new Set<string>();
    const verifyInteractionAncestry = async (endpointId: string): Promise<Awaited<ReturnType<typeof readInteractionLedger>>> => {
      if (verifiedEndpoints.has(endpointId)) return verifiedEndpoints.get(endpointId)!;
      assert(!verifying.has(endpointId) && verifying.size < maxCalls, 'New approval ancestry must be bounded and free of cycles');
      verifying.add(endpointId);
      const endpoint = await readInteractionLedger(endpointId);
      const ledgerRoot = endpoint.manifest.approvalLedgerRoot as string | undefined;
      const transition = endpoint.manifest.approvalTransition as ApprovalTransition | undefined;
      if (!transition) {
        await readLegacyInteractionOrigin(endpointId); verifying.delete(endpointId); verifiedEndpoints.set(endpointId, endpoint); return endpoint;
      }
      assert(ledgerRoot, 'A new approval requires its immutable ledger root');
      const previous = await verifyInteractionAncestry(transition.previous.runId);
      assert.deepEqual(transition.previous, previous.snapshot, 'New approval must preserve the actual fully verified previous ledger snapshot');
      const transitionEdge = JSON.parse(await fs.readFile(path.join(root, previous.snapshot.runId, 'continued-by.json'), 'utf8'));
      assert.deepEqual(transitionEdge, { runId: ledgerRoot, transition: 'new-approval', approvalLedgerRoot: ledgerRoot, acceptedModelSource: acceptedSourceId });
      let cursor = ledgerRoot; const visited = new Set<string>(); let precedingUsage: Usage = { calls: 0, outputTokensReserved: 0 };
      while (true) {
        assert(safeId.test(cursor) && !visited.has(cursor) && visited.size < maxCalls, 'Interaction continuation is not part of this new approval ancestry'); visited.add(cursor);
        const ancestor = await readInteractionLedger(cursor);
        assert.equal(ancestor.manifest.approvalLedgerRoot, ledgerRoot); assert.deepEqual(ancestor.manifest.approvalTransition, transition);
        assert.deepEqual(ancestor.manifest.prior, precedingUsage, 'Every continuation must inherit the exact previous usage');
        if (cursor === endpointId) break;
        const edge = JSON.parse(await fs.readFile(path.join(root, cursor, 'continued-by.json'), 'utf8'));
        assert.equal(edge.transition, 'same-approval'); assert.equal(edge.approvalLedgerRoot, ledgerRoot); assert.equal(edge.acceptedModelSource, acceptedSourceId);
        assert(typeof edge.runId === 'string' && safeId.test(edge.runId)); precedingUsage = ancestor.snapshot.usage; cursor = edge.runId;
      }
      verifying.delete(endpointId); verifiedEndpoints.set(endpointId, endpoint); return endpoint;
    };
    if (newApprovalId) {
      const previous = await verifyInteractionAncestry(newApprovalId);
      approvalLedgerRoot = runId; approvalTransition = { kind: 'new-approval', previous: previous.snapshot };
      aggregateBase = previous.snapshot.aggregateUsage;
      // Only this explicit flag opens a new 24/48000 authorization; old usage stays immutable.
      assert.deepEqual(prior, { calls: 0, outputTokensReserved: 0 });
    } else {
      const endpoint = await verifyInteractionAncestry(args[4]);
      approvalLedgerRoot = endpoint.manifest.approvalLedgerRoot; approvalTransition = endpoint.manifest.approvalTransition;
      assert(approvalLedgerRoot && approvalTransition, 'Explicit accepted-source continuation must belong to a newly authorized interaction ledger');
      assert.deepEqual(prior, endpoint.snapshot.usage); aggregateBase = approvalTransition.previous.aggregateUsage;
    }
  }
  if (businessPaidContinuation) {
    let ancestor = replayId!; const visited = new Set<string>();
    while (true) {
      assert(safeId.test(ancestor) && !visited.has(ancestor) && visited.size < maxCalls, 'Paid prefix must belong to this continuing approval ancestry');
      visited.add(ancestor);
      const manifest = JSON.parse(await fs.readFile(path.join(root, ancestor, 'manifest.json'), 'utf8'));
      assert.equal(manifest.syntheticOnly, true); assert.deepEqual(manifest.provider, { id: provider.id, model: provider.selectedModel, origin: base.origin });
      assert.equal(manifest.profile, businessBuildOnly ? 'business-build-only' : 'business-chain');
      assert.deepEqual(manifest.approval, { maxCalls, reservedOutputTokens: maxOutputTokens });
      if (ancestor === args[4]) break;
      const successor = JSON.parse(await fs.readFile(path.join(root, ancestor, 'continued-by.json'), 'utf8'));
      assert(typeof successor.runId === 'string' && safeId.test(successor.runId), 'Invalid paid-prefix continuation edge');
      ancestor = successor.runId;
    }
  }
  const reviewOnlyReport = reviewOnlyId ? JSON.parse(await fs.readFile(path.join(root, reviewOnlyId, 'report.json'), 'utf8')) : undefined;
  let scopeSource: { runId: string; index: number; input: any; response: any } | undefined;
  if (scopeReview) {
    if (scopeSourceId) {
      let cursor = scopeSourceId; const visited = new Set<string>();
      while (cursor !== args[4]) {
        assert(safeId.test(cursor) && !visited.has(cursor) && visited.size < maxCalls, 'Scope source is not an ancestor in this approval chain'); visited.add(cursor);
        const ancestor = JSON.parse(await fs.readFile(path.join(root, cursor, 'manifest.json'), 'utf8'));
        assert.equal(ancestor.syntheticOnly, true); assert.deepEqual(ancestor.provider, metadata);
        assert.deepEqual(ancestor.approval, { maxCalls, reservedOutputTokens: maxOutputTokens });
        const next = JSON.parse(await fs.readFile(path.join(root, cursor, 'continued-by.json'), 'utf8'));
        assert(typeof next.runId === 'string' && safeId.test(next.runId)); cursor = next.runId;
      }
    }
    let sourceRun = scopeSourceId ?? args[4], sourceRoot = path.join(root, sourceRun);
    const continuationManifest = JSON.parse(await fs.readFile(path.join(sourceRoot, 'manifest.json'), 'utf8'));
    if (blindScopeReview) {
      assert.equal(continuationManifest.profile, 'design-scope-review');
      const continuationReport = JSON.parse(await fs.readFile(path.join(sourceRoot, 'report.json'), 'utf8'));
      sourceRun = continuationReport.scopeReviewSource.runId; assert(safeId.test(sourceRun)); sourceRoot = path.join(root, sourceRun);
    }
    const sourceManifest = JSON.parse(await fs.readFile(path.join(sourceRoot, 'manifest.json'), 'utf8'));
    assert(['ui-chain', 'business-chain'].includes(sourceManifest.profile), 'Scope review requires a genuine whole-chain candidate');
    assert.equal(sourceManifest.syntheticOnly, true);
    assert.deepEqual(sourceManifest.provider, { id: provider.id, model: provider.selectedModel, origin: base.origin });
    const previous = JSON.parse(await fs.readFile(path.join(sourceRoot, 'report.json'), 'utf8'));
    assert.equal(previous.buildAccepted, false); assert.equal(previous.productionWrites, 0);
    const files = (await fs.readdir(sourceRoot)).filter(name => /^request-\d+\.json$/.test(name)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    for (const name of files) {
      const request = JSON.parse(await fs.readFile(path.join(sourceRoot, name), 'utf8')), input = JSON.parse(request.userInput);
      if (input.stage !== 'review' || !input.candidate || !input.sources) continue;
      const index = Number(name.match(/\d+/)![0]), response = JSON.parse(await fs.readFile(path.join(sourceRoot, `response-${index}.json`), 'utf8'));
      assert.equal(response.diagnostics?.finishReason, 'stop');
      scopeSource = { runId: sourceRun, index, input, response: JSON.parse(response.content) }; break;
    }
    assert(scopeSource, 'No actual reviewed candidate found; no handwritten or earlier substitute is allowed');
    readS2Definition(scopeSource.input.candidate);
  }
  if (reviewOnlyId) {
    const sourceManifest = JSON.parse(await fs.readFile(path.join(root, reviewOnlyId, 'manifest.json'), 'utf8'));
    assert.equal(sourceManifest.syntheticOnly, true); assert.equal(sourceManifest.profile, 'targeted');
    assert.equal(sourceManifest.unacceptedModelDraftSource, draftId, 'Cannot reinterpret prior cases against a different draft');
  }
  let taskReplayPreflight: Awaited<ReturnType<typeof prepareS2TaskReplay>>['preflight'] | undefined;
  const taskSourceArtifacts: Record<string, { sha256: string; chars: number }> = {};
  if (taskPaidContinuation) {
    const readSource = async (name: string) => {
      const contents = await fs.readFile(path.join(root, replayId!, name), 'utf8');
      assert(contents.length <= 262144, 'Task replay source exceeds bounded synthetic input');
      taskSourceArtifacts[name] = { sha256: createHash('sha256').update(contents).digest('hex'), chars: contents.length };
      return contents;
    };
    const manifest = JSON.parse(await readSource('manifest.json')), report = JSON.parse(await readSource('report.json'));
    assert.deepEqual(manifest, replayManifest);
    const requests = await Promise.all([1, 2, 3].map(async i => JSON.parse(await readSource(`request-${i}.json`))));
    const responses = await Promise.all([1, 2, 3].map(async i => JSON.parse(await readSource(`response-${i}.json`))));
    const dispatch = (await readSource('dispatch.jsonl')).trim().split(/\r?\n/).map(line => JSON.parse(line));
    const prepared = await prepareS2TaskReplay({ manifest, report, requests, responses, dispatch,
      task: acceptanceTask!, provider: metadata, inheritedUsage: prior });
    taskReplayPreflight = prepared.preflight; replay = createS2ExactReplay(prepared.entries);
    for (const [name, fingerprint] of Object.entries(taskSourceArtifacts)) {
      const contents = await fs.readFile(path.join(root, replayId!, name), 'utf8');
      assert.equal(createHash('sha256').update(contents).digest('hex'), fingerprint.sha256, 'Task replay source changed during preflight');
    }
  }
  if (businessInteractionOnly && acceptedSourceId || acceptanceTask && ledgerPredecessorId) {
    try {
      await fs.readFile(path.join(root, ledgerPredecessorId!, 'continued-by.json'), 'utf8');
      assert.fail('This interaction ledger endpoint was already claimed');
    } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
  }
  // Validate all sources before claiming a continuation. An invalid source or
  // duplicate run ID must not consume the previous ledger's single-use marker.
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(output);
  if (ledgerPredecessorId) await fs.writeFile(path.join(root, ledgerPredecessorId, 'continued-by.json'), JSON.stringify({ runId,
    ...(acceptedSourceId ? { transition: newApprovalId ? 'new-approval' : 'same-approval', approvalLedgerRoot, acceptedModelSource: acceptedSourceId } : {}) }), { flag: 'wx' });
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({ kind: 's2-real-agent-validation', provider: metadata,
    profile: scopeReview ? 'design-scope-review' : businessInteractionOnly ? 'business-interaction-only' : businessBuildOnly ? 'business-build-only' : businessChain ? 'business-chain' : uiChain ? 'ui-chain' : targeted ? 'targeted' : profile,
    taskCaseId: acceptanceTask?.id,
    taskBuildPreviewOnly: taskBuildOnly,
    taskReplayPreflight, taskSourceArtifacts: taskPaidContinuation ? taskSourceArtifacts : undefined,
    freshBuildTested: !replayId && !draftId && !businessInteractionOnly && !scopeReview,
    taskTurnOutputCap: acceptanceTask ? 1024 : undefined,
    businessGoalClosureTested: businessChain && !businessBuildOnly && !businessInteractionOnly,
    businessBuildPreviewTested: businessBuildOnly,
    businessInteractionSubsetTested: businessInteractionOnly, acceptedModelSource,
    resumedSameApprovalPaidPrefix: businessPaidContinuation || taskPaidContinuation,
    scopeReviewSource: scopeReview ? { runId: scopeSource!.runId, requestIndex: scopeSource!.index } : undefined,
    blindScopeReview, scopeReviewOutputCap: scopeReview ? blindScopeReview ? 1536 : 2048 : undefined,
    protectedMemory: !scopeReview && !targeted && !businessBuildOnly && profile === 'full', freshTurnMemory: targeted || businessInteractionOnly,
    targetedOutputCap: targeted ? 2048 : undefined, compactOutputCaps: compact, replayPrefix: replayId, reviewOnlySource: reviewOnlyId,
    uiChainTurnOutputCap: uiChain ? 1536 : undefined,
    unacceptedModelDraftSource: draftId, buildAcceptanceTested: !scopeReview && !draftId && !businessInteractionOnly, smallActionOutputCap: smallActions ? 1024 : undefined,
    approval: { maxCalls, reservedOutputTokens: maxOutputTokens }, independentReviewReservation: taskBuildOnly ? undefined : businessInteractionOnly ? { calls: 1, tokens: 2048 } : uiChain ? { calls: 1, tokens: 2048 } : targeted ? { calls: 1, tokens: 2048 } : undefined,
    prior, approvalLedgerRoot, approvalTransition,
    aggregateApprovalUsage: businessInteractionOnly ? addUsage(aggregateBase, prior) : undefined,
    syntheticOnly: true, productionWrites: 0 }, null, 2), { flag: 'wx' });
  const actualFetch = globalThis.fetch;
  const counters = { ipc: { calls: 0, tokens: 0 }, http: { calls: 0, tokens: 0 } };
  const usage = () => ({ calls: prior.calls + Math.max(counters.ipc.calls, counters.http.calls),
    outputTokensReserved: prior.outputTokensReserved + Math.max(counters.ipc.tokens, counters.http.tokens) });
  const save = async (name: string, data: unknown) => {
    const json = JSON.stringify(data, null, 2); assert(!json.includes(provider.apiKey!), 'SECRET_ECHO_REJECTED');
    await fs.writeFile(path.join(output, `${name}.json`), json, { flag: 'wx' });
  };
  let inIndependentReview = false;
  const reserve = async (kind: 'ipc' | 'http', tokens: number) => {
    const count = counters[kind];
    assert(Number.isSafeInteger(tokens) && tokens >= 256 && tokens <= 6144, 'INVALID_OUTPUT_LIMIT');
    const heldCalls = !inIndependentReview ? taskBuildOnly ? 0 : businessInteractionOnly ? 1 : uiChain ? 1 : targeted ? 1 : 0 : 0, heldTokens = heldCalls * 2048;
    if (prior.calls + count.calls + 1 > maxCalls - heldCalls || prior.outputTokensReserved + count.tokens + tokens > maxOutputTokens - heldTokens) throw new S2ValidationStop('approval-budget-exhausted');
    count.calls++; count.tokens += tokens;
    await fs.appendFile(path.join(output, 'dispatch.jsonl'), JSON.stringify({ kind, tokens, usage: usage(), at: new Date().toISOString() }) + '\n');
  };
  const cache = new Map([['loginote_llm_settings', JSON.stringify({ ...settings, providers: [provider] })]]);
  Object.assign(globalThis, { localStorage: { getItem: (key: string) => cache.get(key) ?? null, setItem: (key: string, value: string) => cache.set(key, value) } });
  let activeSignal: AbortSignal | undefined, stoppedTransport = false, index = 0;
  const controller = new AbortController(), overallTimer = setTimeout(() => controller.abort(), 600000);
  globalThis.fetch = async (input, init) => {
    assert(!stoppedTransport, 'NO_TRANSPORT_RETRY');
    assert.equal(input instanceof Request ? input.url : String(input), endpoint); assert.equal(init?.method, 'POST');
    assert.equal(typeof init?.body, 'string');
    await reserve('http', JSON.parse(init!.body as string).max_tokens);
    try {
      const response = await actualFetch(input, { ...init, redirect: 'error' });
      if (!response.ok) stoppedTransport = true;
      return response;
    } catch { stoppedTransport = true; throw new Error('S2_PROVIDER_TRANSPORT_FAILED'); }
  };
  Object.assign(globalThis, { window: { electronAPI: { llm: { request: async (request: Parameters<typeof proxyLlmRequest>[0]) => {
    assert.equal(request.provider.baseUrl, provider.baseUrl); assert.equal(request.provider.selectedModel, provider.selectedModel);
    assert.equal(request.provider.apiKey, provider.apiKey);
    assert(!request.tools?.length && !request.images?.length && !request.agentMessages?.length);
    await reserve('ipc', request.maxTokens); return proxyLlmRequest(request, activeSignal);
  }, cancel() {} } } } });
  console.log(JSON.stringify({ runId, provider: metadata, prior, syntheticOnly: true }));
  try {
    const validationOptions = { signal: controller.signal, onArtifact: save, profile, unacceptedModelDraft,
      onProgress: (progress: unknown) => console.log(JSON.stringify({ progress, usage: usage() })), invoke: async (request: Parameters<typeof callLLM>[0]) => {
        assert(!stoppedTransport && !controller.signal.aborted, 'S2_STOPPED_BEFORE_DISPATCH');
        assert(request.skipMemoryInjection && request.skipProfileInjection);
        assert(JSON.stringify(request).length < 120000, 'SYNTHETIC_CONTEXT_TOO_LARGE');
        const requestInput = JSON.parse(request.userInput);
        inIndependentReview = ['s2-targeted-independent-review', 's2-ui-independent-review', 's2-design-scope-review', 's2-business-interaction-independent-review'].includes(requestInput.phase);
        let effectiveRequest = blindScopeReview ? { ...request, maxTokensOverride: Math.min(request.maxTokensOverride ?? 4096, 1536) }
          : uiChain ? { ...request, maxTokensOverride: Math.min(request.maxTokensOverride ?? 4096, requestInput.stage === 'assemble' ? 6144 : requestInput.stage === 'understand' ? 3072 : String(requestInput.stage).startsWith('turn-') ? acceptanceTask ? 1024 : 1536 : 2048) }
          : targeted ? { ...request, maxTokensOverride: Math.min(request.maxTokensOverride ?? 4096, 2048) } : compact ? { ...request, maxTokensOverride: Math.min(request.maxTokensOverride ?? 4096,
          JSON.parse(request.userInput).phase === 's2-independent-review' ? 1536 : 2048) } : request;
        if (replay.remaining) {
          const result = replay.take(effectiveRequest);
          await save(`replay-${replay.consumed}`, { source: replayId, exactRequest: effectiveRequest, paidResponse: result });
          console.log(JSON.stringify({ replayedExactPaidRequest: replay.consumed, usage: usage() }));
          return result;
        }
        if (smallActions && String(JSON.parse(request.userInput).stage).startsWith('turn-')) effectiveRequest = { ...effectiveRequest, maxTokensOverride: 1024 };
        const currentUsage = usage(), heldCalls = !inIndependentReview ? taskBuildOnly ? 0 : businessInteractionOnly ? 1 : uiChain ? 1 : targeted ? 1 : 0 : 0;
        if (currentUsage.calls + 1 > maxCalls - heldCalls || currentUsage.outputTokensReserved + (effectiveRequest.maxTokensOverride ?? 4096) > maxOutputTokens - heldCalls * 2048)
          throw new S2ValidationStop('approval-budget-exhausted');
        const callIndex = ++index, requestController = new AbortController();
        const stop = () => requestController.abort(); controller.signal.addEventListener('abort', stop, { once: true });
        const timer = setTimeout(stop, 60000); activeSignal = requestController.signal;
        await save(`request-${callIndex}`, effectiveRequest);
        try {
          const result = await callLLM({ ...effectiveRequest, providerId: provider.id, model: provider.selectedModel,
            context: undefined, thinkingMode: 'disabled' }, { providerSnapshot: provider, signal: activeSignal });
          await save(`response-${callIndex}`, result); return result;
        } catch (error) {
          if (error instanceof S2ValidationStop) throw error;
          stoppedTransport = true;
          throw new S2ValidationStop(controller.signal.aborted ? 'cancelled' : requestController.signal.aborted ? 'request-timeout' : 'transport-failed');
        }
        finally { clearTimeout(timer); controller.signal.removeEventListener('abort', stop); }
      } };
    const runScopeReview = async () => {
      const candidate = readS2Definition(scopeSource!.input.candidate), before = JSON.stringify(candidate);
      await save('source-candidate', { origin: 'prior-real-model-unaccepted-candidate', sourceRun: scopeSource!.runId, sourceRequestIndex: scopeSource!.index,
        candidate, previousSemanticReview: scopeSource!.response });
      const baseReport = { kind: 'isolated-design-scope-review', buildAccepted: false, passed: false, scopeReviewPassed: false,
        localChecks: { candidateUnchanged: true, noHostOrExecution: true }, judge: undefined as unknown, stopped: undefined as string | undefined,
        notTested: ['fresh-understanding', 'fresh-assembly', 'preview', 'start', 'interaction', 'execution'],
        blindScopeReview, scopeReviewSource: { runId: scopeSource!.runId, requestIndex: scopeSource!.index } };
      try {
        const review = await reviewS2CanvasCandidate(scopeSource!.input.sources, candidate, blindScopeReview ? undefined : scopeSource!.response, { invoke: validationOptions.invoke, signal: controller.signal });
        return { ...baseReport, judge: review, scopeReviewPassed: review.verdict === 'accept', localChecks: { ...baseReport.localChecks, candidateUnchanged: before === JSON.stringify(candidate) } };
      } catch (error) { return { ...baseReport, stopped: error instanceof S2ValidationStop ? error.code : 'scope-review-failed' }; }
    };
    const report = scopeReview ? await runScopeReview() : businessInteractionOnly ? await runS2BusinessInteractionValidation({ ...validationOptions, acceptedDefinition: acceptedDefinition! }) : businessChain ? await runS2BusinessValidation({ ...validationOptions, stopAfterPreview: businessBuildOnly }) : uiChain ? await runS2UiAgentValidation({ ...validationOptions, validationCase: acceptanceTask, stopAfterPreview: taskBuildOnly })
      : targeted ? await runS2TargetedValidation({ ...validationOptions, reviewOnlyReport, unacceptedModelDraft: unacceptedModelDraft! })
      : await runS2AgentValidation(validationOptions);
    if (businessInteractionOnly) Object.assign(report, { passed: false, buildAccepted: false, interactionPassed: false });
    await save('report', { ...report, profile: scopeReview ? 'design-scope-review' : businessInteractionOnly ? 'business-interaction-only' : businessBuildOnly ? 'business-build-only' : businessChain ? 'business-chain' : uiChain ? 'ui-chain' : targeted ? 'targeted' : profile, protectedMemory: !scopeReview && !targeted && !businessBuildOnly && profile === 'full',
      taskCaseId: acceptanceTask?.id,
      taskBuildPreviewOnly: taskBuildOnly,
      taskReplayPreflight, taskSourceArtifacts: taskPaidContinuation ? taskSourceArtifacts : undefined,
      freshBuildTested: !replayId && !draftId && !businessInteractionOnly && !scopeReview,
      taskTurnOutputCap: acceptanceTask ? 1024 : undefined,
      businessGoalClosureTested: businessChain && !businessBuildOnly && !businessInteractionOnly,
      businessBuildPreviewTested: businessBuildOnly,
      businessInteractionSubsetTested: businessInteractionOnly, acceptedModelSource,
      resumedSameApprovalPaidPrefix: businessPaidContinuation || taskPaidContinuation,
      freshTurnMemory: targeted || businessInteractionOnly, targetedOutputCap: targeted ? 2048 : undefined, compactOutputCaps: compact,
      uiChainTurnOutputCap: uiChain ? 1536 : undefined,
      reviewOnlySource: reviewOnlyId,
      replayPrefix: replayId, replayedExactPaidRequests: replay.consumed, smallActionOutputCap: smallActions ? 1024 : undefined,
      unacceptedModelDraftSource: draftId,
      execution: 'real-provider', provider: metadata, approvalUsage: usage(),
      prior: businessInteractionOnly ? prior : undefined, approvalLedgerRoot, approvalTransition,
      aggregateApprovalUsage: businessInteractionOnly ? addUsage(aggregateBase, usage()) : undefined,
      dispatchAudit: counters, automaticTransportRetries: 0, productionWrites: 0 });
    console.log(JSON.stringify({ reportPath: path.join(output, 'report.json'), passed: report.passed,
      buildPreviewPassed: 'buildPreviewPassed' in report ? report.buildPreviewPassed : undefined,
      interactionSubsetPassed: 'interactionSubsetPassed' in report ? report.interactionSubsetPassed : undefined,
      targetedPassed: 'targetedPassed' in report ? report.targetedPassed : undefined, stopped: report.stopped,
      scopeReviewPassed: 'scopeReviewPassed' in report ? report.scopeReviewPassed : undefined,
      localChecks: report.localChecks, judge: report.judge, approvalUsage: usage(),
      aggregateApprovalUsage: businessInteractionOnly ? addUsage(aggregateBase, usage()) : undefined }));
    if (!(businessInteractionOnly && 'interactionSubsetPassed' in report ? report.interactionSubsetPassed : (businessBuildOnly || taskBuildOnly) && 'buildPreviewPassed' in report ? report.buildPreviewPassed : 'scopeReviewPassed' in report ? report.scopeReviewPassed : 'targetedPassed' in report ? report.targetedPassed : report.passed)) process.exitCode = 2;
  } finally { clearTimeout(overallTimer); globalThis.fetch = actualFetch; }
}

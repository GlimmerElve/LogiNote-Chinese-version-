/** Isolated CLI regression. No actual settings, credentials, provider or artifact IO. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createS2ExactReplay } from './scene-s2-exact-replay';
import { s2TaskCase } from './scene-s2-task-cases';

const source = readFileSync('scripts/run-scene-s2-live.ts', 'utf8');
const ast = ts.createSourceFile('run-scene-s2-live.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const declarations = new Map<string, ts.Expression>();
function collect(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.set(node.name.text, node.initializer);
  ts.forEachChild(node, collect);
}
collect(ast);
const expression = (name: string) => {
  const value = declarations.get(name); assert(value, `Missing CLI declaration: ${name}`);
  return value.getText(ast).replace(/\s+/g, '');
};
assert.equal(expression('maxCalls'), 'targeted?14:24', 'Whole-chain approval must not exceed 24 calls');
assert.equal(expression('maxOutputTokens'), 'targeted?28000:48000', 'Whole-chain approval must not exceed 48000 reserved output tokens');
assert.equal(expression('uiChain'), 'businessChain||legacyUiChain||!!acceptanceTask', 'Business and task chains must share UI-chain permission and reservation branches');
assert.match(expression('heldCalls'), /businessInteractionOnly\?1:uiChain\?1:targeted\?1:0/, 'Interaction subset and whole UI/business chains each hold one evidence-ID judge request, with no judge format retry budget');
assert.match(expression('heldCalls'), /taskBuildOnly\?0:/, 'Build-only has no interaction judge to reserve; the shared hard ceilings still apply');
assert.match(expression('usage'), /prior\.calls\+Math\.max\(counters\.ipc\.calls,counters\.http\.calls\)/);
assert.match(expression('usage'), /prior\.outputTokensReserved\+Math\.max\(counters\.ipc\.tokens,counters\.http\.tokens\)/);

const output = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText;
const metadata = { id: 'synthetic-provider', model: 'synthetic-model', origin: 'https://synthetic.invalid' };
const paidRequests = [
  { providerId: '', model: '', workflow: 'agent-scene-setup', skipMemoryInjection: true, skipProfileInjection: true,
    userInput: JSON.stringify({ stage: 'understand', syntheticOnly: true }), maxTokensOverride: 3072 },
  { providerId: '', model: '', workflow: 'agent-scene-setup', skipMemoryInjection: true, skipProfileInjection: true,
    userInput: JSON.stringify({ stage: 'assemble', syntheticOnly: true }), maxTokensOverride: 6144 },
  { providerId: '', model: '', workflow: 'agent-scene-setup', skipMemoryInjection: true, skipProfileInjection: true,
    userInput: JSON.stringify({ stage: 'assemble', syntheticOnly: true, jsonFormatRepair: { error: 'synthetic', previousOutput: '{}' } }), maxTokensOverride: 6144 },
] as const;
type Scenario = { dry?: boolean; profile?: string; missingCandidate?: boolean; duplicateRunId?: boolean; badApproval?: boolean;
  replay?: boolean; mismatch?: boolean; replayProfile?: string; replayProviderMismatch?: boolean; replayId?: string; continueId?: string;
  legacyUiReplay?: boolean; noContinue?: boolean; buildOnly?: boolean; ancestry?: 'valid' | 'cycle' | 'orphan';
  ancestorProfileMismatch?: boolean; ancestorProviderMismatch?: boolean; ancestorApprovalMismatch?: boolean;
  endpointProfileMismatch?: boolean; endpointProviderMismatch?: boolean;
  interaction?: boolean; rawArgs?: string[]; sourceManifestPatch?: Record<string, unknown>; sourceReportPatch?: Record<string, unknown>;
  sourceDefinitionMismatch?: boolean; invalidBusinessDefinition?: boolean; extraInteractionAction?: boolean; extraInteractionJudge?: boolean;
  interactionWrongFullFlags?: boolean; newApproval?: boolean; continueNewApproval?: boolean; continueNewAncestor?: boolean;
  ledgerManifestPatch?: Record<string, unknown>; ledgerReportPatch?: Record<string, unknown>;
  oldManifestPatch?: Record<string, unknown>; oldReportPatch?: Record<string, unknown>;
  claimedEndpoint?: boolean; transitionMismatch?: boolean; ledgerAncestry?: 'cycle' | 'orphan';
  ledgerRootMismatch?: boolean; predecessorSnapshotMismatch?: boolean; acceptedEdgeMismatch?: boolean;
  secondNewApproval?: boolean; continueSecondApproval?: boolean; secondSnapshotMismatch?: boolean;
  ancestryPatches?: Array<{ runId: string; manifest?: Record<string, unknown>; report?: Record<string, unknown>; edge?: unknown }> };
async function isolated(scenario: Scenario = {}) {
  const reads: string[] = [], writes: string[] = [], events: Array<{ op: string; target: string }> = [], logs: string[] = [];
  const writtenValues = new Map<string, unknown>();
  let modelCalls = 0, networkCalls = 0, replayReplies = 0, strictBusinessReads = 0, interactionRuns = 0;
  const syntheticDispatches: Array<{ kind: string; tokens: number; usage: { calls: number; outputTokensReserved: number } }> = [];
  const syntheticRequests: Array<{ userInput: string; maxTokensOverride: number }> = [];
  const sourceDefinition = { version: 1, business: { syntheticOnly: true, valid: !scenario.invalidBusinessDefinition } };
  const approvedLimits = { maxCalls: 24, reservedOutputTokens: 48000 };
  const oldUsage = { calls: 17, outputTokensReserved: 45056 };
  const oldSnapshot = { runId: 'old', provider: metadata, limits: approvedLimits, usage: oldUsage, aggregateUsage: oldUsage };
  const transition = { kind: 'new-approval', previous: { ...oldSnapshot,
    ...(scenario.predecessorSnapshotMismatch ? { usage: { calls: 16, outputTokensReserved: 45056 } } : {}) } };
  const previousNewUsage = { calls: 7, outputTokensReserved: 11264 };
  const sumUsage = (usage: { calls: number; outputTokensReserved: number }) => ({ calls: oldUsage.calls + usage.calls, outputTokensReserved: oldUsage.outputTokensReserved + usage.outputTokensReserved });
  const ledgerSource = !!(scenario.newApproval || scenario.continueNewApproval || scenario.secondNewApproval || scenario.continueSecondApproval);
  const ledgerManifest = (folder: string) => ({ profile: 'business-interaction-only', provider: metadata, approval: approvedLimits,
    syntheticOnly: true, productionWrites: 0, acceptedModelSource: 'accepted', businessInteractionSubsetTested: true,
    prior: folder === 'current' && scenario.continueNewAncestor ? previousNewUsage : { calls: 0, outputTokensReserved: 0 },
    approvalLedgerRoot: scenario.ledgerRootMismatch ? 'foreign' : 'ledger', approvalTransition: transition,
    aggregateApprovalUsage: folder === 'current' && scenario.continueNewAncestor ? sumUsage(previousNewUsage) : oldUsage,
    ...scenario.ledgerManifestPatch });
  const ledgerReport = (folder: string) => ({ ...ledgerManifest(folder), passed: false, buildAccepted: false, interactionPassed: false,
    execution: 'real-provider', approvalUsage: folder === 'current' && scenario.continueNewAncestor ? { calls: 14, outputTokensReserved: 22528 } : previousNewUsage,
    aggregateApprovalUsage: sumUsage(folder === 'current' && scenario.continueNewAncestor ? { calls: 14, outputTokensReserved: 22528 } : previousNewUsage),
    ...scenario.ledgerReportPatch });
  type SyntheticLedger = { manifest?: Record<string, unknown>; report?: Record<string, unknown>; edge?: unknown };
  const ancestryArtifacts = new Map<string, SyntheticLedger>();
  if (scenario.secondNewApproval || scenario.continueSecondApproval) {
    const addRecord = (id: string, ledgerRoot: string, prior: { calls: number; outputTokensReserved: number }, usage: typeof prior,
      approvalTransition: typeof transition, aggregateBase: typeof prior) => {
      const manifest = { profile: 'business-interaction-only', provider: metadata, approval: approvedLimits, syntheticOnly: true,
        productionWrites: 0, acceptedModelSource: 'accepted', businessInteractionSubsetTested: true, prior,
        approvalLedgerRoot: ledgerRoot, approvalTransition,
        aggregateApprovalUsage: { calls: aggregateBase.calls + prior.calls, outputTokensReserved: aggregateBase.outputTokensReserved + prior.outputTokensReserved } };
      ancestryArtifacts.set(id, { manifest, report: { ...manifest, passed: false, buildAccepted: false, interactionPassed: false,
        execution: 'real-provider', approvalUsage: usage,
        aggregateApprovalUsage: { calls: aggregateBase.calls + usage.calls, outputTokensReserved: aggregateBase.outputTokensReserved + usage.outputTokensReserved } }, edge: undefined });
    };
    addRecord('ledger', 'ledger', { calls: 0, outputTokensReserved: 0 }, previousNewUsage, transition, oldUsage);
    addRecord('middle-new', 'ledger', previousNewUsage, { calls: 15, outputTokensReserved: 24576 }, transition, oldUsage);
    addRecord('endpoint-new', 'ledger', { calls: 15, outputTokensReserved: 24576 }, { calls: 23, outputTokensReserved: 36864 }, transition, oldUsage);
    ancestryArtifacts.set('accepted', { edge: { runId: scenario.acceptedEdgeMismatch ? 'foreign' : 'old' } });
    ancestryArtifacts.set('old', { edge: { runId: 'ledger', transition: 'new-approval', approvalLedgerRoot: 'ledger', acceptedModelSource: 'accepted' } });
    ancestryArtifacts.get('ledger')!.edge = { runId: 'middle-new', transition: 'same-approval', approvalLedgerRoot: 'ledger', acceptedModelSource: 'accepted' };
    ancestryArtifacts.get('middle-new')!.edge = { runId: 'endpoint-new', transition: 'same-approval', approvalLedgerRoot: 'ledger', acceptedModelSource: 'accepted' };
    if (scenario.continueSecondApproval) {
      const previous = { runId: 'endpoint-new', provider: metadata, limits: approvedLimits,
        usage: { calls: scenario.secondSnapshotMismatch ? 22 : 23, outputTokensReserved: 36864 }, aggregateUsage: { calls: 40, outputTokensReserved: 81920 } };
      addRecord('second-ledger', 'second-ledger', { calls: 0, outputTokensReserved: 0 }, previousNewUsage,
        { kind: 'new-approval', previous }, previous.aggregateUsage);
      ancestryArtifacts.get('endpoint-new')!.edge = { runId: 'second-ledger', transition: 'new-approval', approvalLedgerRoot: 'second-ledger', acceptedModelSource: 'accepted' };
    }
    for (const patch of scenario.ancestryPatches ?? []) {
      const node = ancestryArtifacts.get(patch.runId) ?? {};
      if (patch.manifest) node.manifest = { ...node.manifest, ...patch.manifest };
      if (patch.report) node.report = { ...node.report, ...patch.report };
      if (Object.hasOwn(patch, 'edge')) node.edge = patch.edge;
      ancestryArtifacts.set(patch.runId, node);
    }
  }
  const json = (value: unknown) => JSON.stringify(value);
  const fakeFs = {
    async readFile(file: unknown) {
      const target = String(file); reads.push(target); events.push({ op: 'read', target });
      const folder = path.basename(path.dirname(target));
      if (target.endsWith('storage-config.json')) return json({ dataRoot: 'synthetic-data-root' });
      if (target.endsWith('llm.json')) return json({ settings: {
        workflowBinding: { 'scene-general-turn': metadata.id }, defaultProviderId: metadata.id,
        providers: [{ id: metadata.id, enabled: true, apiType: 'openai-compatible', apiKey: 'synthetic-not-a-real-credential',
          selectedModel: metadata.model, baseUrl: metadata.origin }],
      } });
      const ancestryNode = ancestryArtifacts.get(folder);
      if (target.endsWith('manifest.json') && ancestryNode?.manifest) return json(ancestryNode.manifest);
      if (target.endsWith('report.json') && ancestryNode?.report) return json(ancestryNode.report);
      if (target.endsWith('continued-by.json') && ancestryNode && Object.hasOwn(ancestryNode, 'edge')) {
        if (scenario.claimedEndpoint && folder === (scenario.secondNewApproval ? 'endpoint-new' : 'second-ledger')) return json({ runId: 'already-claimed' });
        if (ancestryNode.edge !== undefined) return json(ancestryNode.edge);
        throw Object.assign(new Error('SYNTHETIC_ENOENT'), { code: 'ENOENT' });
      }
      if (target.endsWith('manifest.json') && ledgerSource && folder !== 'accepted') return json(folder === 'old'
        ? { profile: 'business-interaction-only', provider: metadata, approval: approvedLimits, syntheticOnly: true, productionWrites: 0,
          acceptedModelSource: 'accepted', businessInteractionSubsetTested: true, prior: { calls: 11, outputTokensReserved: 35840 }, ...scenario.oldManifestPatch }
        : ledgerManifest(folder));
      if (target.endsWith('manifest.json') && scenario.interaction) return json({ provider: metadata,
        profile: 'business-build-only', syntheticOnly: true, productionWrites: 0, approval: { maxCalls: 24, reservedOutputTokens: 48000 }, ...scenario.sourceManifestPatch });
      if (target.endsWith('manifest.json')) return json({ provider: scenario.replayProviderMismatch
        || folder === 'middle' && scenario.ancestorProviderMismatch || folder === 'prior' && scenario.endpointProviderMismatch
        ? { ...metadata, model: 'other-model' } : metadata,
        profile: folder === 'middle' && scenario.ancestorProfileMismatch || folder === 'prior' && scenario.endpointProfileMismatch
          ? 'ui-chain' : scenario.replayProfile ?? scenario.profile ?? (scenario.buildOnly ? 'business-build-only' : 'business-chain'),
        syntheticOnly: true, approval: { maxCalls: scenario.badApproval || folder === 'middle' && scenario.ancestorApprovalMismatch ? 25 : 24, reservedOutputTokens: 48000 } });
      if (target.endsWith('report.json') && ledgerSource && folder !== 'accepted') return json(folder === 'old'
        ? { profile: 'business-interaction-only', provider: metadata, execution: 'real-provider', productionWrites: 0,
          acceptedModelSource: 'accepted', businessInteractionSubsetTested: true, passed: false, buildAccepted: false, interactionPassed: false,
          approvalUsage: oldUsage, ...scenario.oldReportPatch } : ledgerReport(folder));
      if (target.endsWith('report.json') && scenario.interaction) return json({ provider: metadata,
        profile: 'business-build-only', caseId: 'business-chain', execution: 'real-provider', productionWrites: 0,
        buildAccepted: true, buildPreviewPassed: true, definition: sourceDefinition,
        approvalUsage: { calls: 11, outputTokensReserved: 35840 }, ...scenario.sourceReportPatch });
      if (target.endsWith('definition.json') && scenario.interaction) return json(scenario.sourceDefinitionMismatch
        ? { ...sourceDefinition, changed: true } : sourceDefinition);
      if (target.endsWith('report.json')) return json({ provider: metadata,
        approvalUsage: scenario.replay ? scenario.buildOnly ? { calls: 9, outputTokensReserved: 31744 }
          : { calls: 4, outputTokensReserved: 16896 } : { calls: 1, outputTokensReserved: 2048 },
        buildAccepted: false, productionWrites: 0 });
      if (target.endsWith('continued-by.json')) {
        if (ledgerSource) {
          if (folder === 'accepted') return json({ runId: scenario.acceptedEdgeMismatch ? 'foreign' : 'old' });
          const endpoint = scenario.newApproval ? 'old' : scenario.continueNewAncestor ? 'current' : 'ledger';
          if (folder === endpoint) {
            if (scenario.claimedEndpoint) return json({ runId: 'already-claimed' });
            throw Object.assign(new Error('SYNTHETIC_ENOENT'), { code: 'ENOENT' });
          }
          if (folder === 'old') return json({ runId: 'ledger', transition: scenario.transitionMismatch ? 'same-approval' : 'new-approval',
            approvalLedgerRoot: 'ledger', acceptedModelSource: 'accepted' });
          if (folder === 'ledger') return json({ runId: scenario.ledgerAncestry === 'cycle' ? 'ledger' : scenario.ledgerAncestry === 'orphan' ? 'foreign' : 'current',
            transition: 'same-approval', approvalLedgerRoot: 'ledger', acceptedModelSource: 'accepted' });
          throw Object.assign(new Error('SYNTHETIC_ENOENT'), { code: 'ENOENT' });
        }
        const chain = scenario.ancestry === 'valid' ? { ancestor: 'middle', middle: 'prior' }
          : scenario.ancestry === 'cycle' ? { ancestor: 'middle', middle: 'ancestor' }
          : scenario.ancestry === 'orphan' ? { ancestor: 'detached' } : {};
        assert(Object.hasOwn(chain, folder), `No synthetic ancestry evidence for ${folder}`);
        return json({ runId: (chain as Record<string, string>)[folder] });
      }
      if (scenario.replay && /request-[123]\.json$/.test(target)) return json(paidRequests[Number(target.match(/request-(\d+)\.json$/)![1]) - 1]);
      if (scenario.replay && /response-[123]\.json$/.test(target)) return json({ content: `SYNTHETIC_PAID_RESPONSE_${target.match(/response-(\d+)\.json$/)![1]}`,
        diagnostics: { finishReason: 'stop' } });
      if (target.endsWith('request-1.json')) return json({ userInput: json({ stage: 'review', candidate: { synthetic: true }, sources: {} }) });
      if (target.endsWith('response-1.json')) return json({ diagnostics: { finishReason: 'stop' }, content: json({ verdict: 'revise' }) });
      assert.fail(`Unexpected isolated read: ${target}`);
    },
    async readdir(file: unknown) { events.push({ op: 'readdir', target: String(file) }); return scenario.missingCandidate ? [] : ['request-1.json']; },
    async mkdir(file: unknown, options?: unknown) {
      const target = String(file); events.push({ op: 'mkdir', target });
      if (!options && scenario.duplicateRunId) throw new Error('SYNTHETIC_EEXIST');
    },
    async writeFile(file: unknown, value: unknown, options?: { flag?: string }) {
      const target = String(file); writes.push(target); events.push({ op: 'write', target });
      writtenValues.set(path.basename(target), JSON.parse(String(value)));
      assert.equal(options?.flag, 'wx', 'All artifact writes must refuse overwrite');
    },
    async appendFile(file: unknown, value: unknown) {
      assert(scenario.interaction, 'Isolated source review must not dispatch any provider request');
      assert(String(file).endsWith('dispatch.jsonl')); syntheticDispatches.push(JSON.parse(String(value)));
    },
  };
  const appModules: Record<string, unknown> = {
    '../src/services/llmService': { callLLM: async (request: { userInput: string; maxTokensOverride: number }) => {
      if (!scenario.interaction) { modelCalls++; assert.fail('No actual model calls allowed'); }
      syntheticRequests.push(request);
      return (sandbox as any).window.electronAPI.llm.request({ provider: { ...metadata,
        baseUrl: metadata.origin, selectedModel: metadata.model, apiKey: 'synthetic-not-a-real-credential' }, maxTokens: request.maxTokensOverride });
    } },
    '../src/electron/apiHandlers': { proxyLlmRequest: async () => {
      if (!scenario.interaction) { modelCalls++; assert.fail('No provider proxy calls allowed'); }
      return { content: '{"synthetic":true}', diagnostics: { finishReason: 'stop' } };
    } },
    './scene-s2-agent-validation': { S2ValidationStop: class extends Error { constructor(public code: string) { super(code); } } },
    './scene-s2-exact-replay': { createS2ExactReplay },
    '../src/services/scene/sceneS2Canvas': { readS2Definition: (value: unknown, options?: { requireBusiness?: boolean }) => {
      if (scenario.interaction) {
        strictBusinessReads++; assert.equal(options?.requireBusiness, true, 'Accepted legacy artifacts must not bypass the fresh business contract');
        assert.equal(json(value), json(sourceDefinition)); assert(!scenario.invalidBusinessDefinition, 'SYNTHETIC_INVALID_BUSINESS_PACKAGE');
      }
      return value;
    },
      reviewS2CanvasCandidate: async () => ({ verdict: 'accept' }) },
    '../src/services/scene/sceneS2Design': {}, './scene-s2-targeted-validation': {},
    './scene-s2-task-cases': { s2TaskCase },
    './scene-s2-task-replay': { prepareS2TaskReplay: async () => assert.fail('Legacy safety scenarios must not prepare a task replay') },
    './scene-s2-ui-agent-validation': {}, './scene-s2-business-interaction-validation': {
      runS2BusinessInteractionValidation: async (options: { acceptedDefinition: unknown; invoke: (request: unknown) => Promise<unknown> }) => {
        interactionRuns++; assert.equal(json(options.acceptedDefinition), json(sourceDefinition));
        let stopped: string | undefined;
        const invoke = (input: unknown, cap: number) => options.invoke({ providerId: '', model: '', workflow: 'agent-scene-setup',
          skipMemoryInjection: true, skipProfileInjection: true, userInput: json(input), maxTokensOverride: cap });
        try {
          for (let index = 0; index < (scenario.extraInteractionAction ? 7 : 6); index++) {
            await invoke({ stage: `turn-${index % 2 ? 'action' : 'intent'}`, syntheticOnly: true }, 4096);
          }
        } catch (error) { stopped = (error as { code?: string }).code; }
        try {
          await invoke({ phase: 's2-business-interaction-independent-review', syntheticOnly: true }, 2048);
          if (scenario.extraInteractionJudge) await invoke({ phase: 's2-business-interaction-independent-review', syntheticOnly: true, formatRepair: true }, 2048);
        } catch (error) { stopped = (error as { code?: string }).code; }
        return { passed: !!scenario.interactionWrongFullFlags, buildAccepted: !!scenario.interactionWrongFullFlags,
          interactionSubsetPassed: !stopped, stopped, localChecks: { syntheticOnly: true } };
      },
    }, './scene-s2-business-validation': {
      runS2BusinessValidation: async (options: { invoke: (request: unknown) => Promise<{ content: string }>; stopAfterPreview: boolean }) => {
        assert.equal(options.stopAfterPreview, !!scenario.buildOnly);
        for (let index = 0; index < (scenario.buildOnly ? 2 : paidRequests.length); index++) {
          const request = { ...structuredClone(paidRequests[index]) };
          if (scenario.mismatch && index === 1) request.userInput = JSON.stringify({ stage: 'assemble', syntheticOnly: true, changed: true });
          const reply = await options.invoke(request); assert.equal(reply.content, `SYNTHETIC_PAID_RESPONSE_${index + 1}`); replayReplies++;
        }
        // This harness only checks replay safety, never grants semantic/build acceptance.
        return { passed: false, buildAccepted: false, localChecks: {} };
      },
    },
  };
  const argv = scenario.rawArgs ?? (scenario.dry ? [] : scenario.interaction
    ? ['--execute', '--run-id', 'next', ...(scenario.noContinue ? [] : ledgerSource
      ? ['--accepted-source', 'accepted', scenario.newApproval || scenario.secondNewApproval ? '--new-approval-after' : '--continue-after',
        scenario.newApproval ? 'old' : scenario.secondNewApproval ? 'endpoint-new' : scenario.continueSecondApproval ? 'second-ledger' : scenario.continueNewAncestor ? 'current' : 'ledger']
      : ['--continue-after', 'prior']), '--business-interaction-only'] : scenario.replay
    ? ['--execute', '--run-id', 'next', ...(scenario.noContinue ? [] : ['--continue-after', scenario.continueId ?? 'prior']),
      '--replay-prefix', scenario.replayId ?? 'prior', scenario.legacyUiReplay ? '--ui-chain' : scenario.buildOnly ? '--business-build-only' : '--business-chain']
    : ['--execute', '--run-id', 'next', '--continue-after', 'prior', '--scope-review']);
  const sandbox = {
    exports: {}, process: { argv: ['node', 'isolated-cli', ...argv], exitCode: undefined },
    console: { log: (...values: unknown[]) => logs.push(values.join(' ')) },
    require(name: string): unknown {
      if (name === 'node:assert/strict') return assert;
      if (name === 'node:crypto') return { createHash };
      if (name === 'node:fs') return { promises: fakeFs };
      if (name === 'node:os') return { homedir: () => 'synthetic-user-root' };
      if (name === 'node:path') return path;
      assert(Object.hasOwn(appModules, name), `Unstubbed module import: ${name}`); return appModules[name];
    },
    URL, Request, AbortController, structuredClone, setTimeout, clearTimeout,
    fetch: async () => { networkCalls++; assert.fail('No external network allowed'); },
  };
  let error: unknown;
  try { await new vm.Script(`(async () => { ${output}\n })()`, { filename: 'run-scene-s2-live.isolated.cjs' })
    .runInNewContext(sandbox, { timeout: 5000 }); }
  catch (caught) { error = caught; }
  assert.equal(modelCalls, 0); assert.equal(networkCalls, 0);
  return { reads, writes, events, logs, error, exitCode: sandbox.process.exitCode, writtenValues, replayReplies,
    strictBusinessReads, interactionRuns, syntheticDispatches, syntheticRequests };
}

const dry = await isolated({ dry: true });
assert.equal(dry.error, undefined); assert.equal(dry.reads.length, 0); assert.equal(dry.writes.length, 0);
for (const id of ['prompt-assembly', 'structured-display', 'human-branch']) {
  const taskDry = await isolated({ rawArgs: ['--task-case', id] });
  assert.equal(taskDry.error, undefined); assert.equal(taskDry.reads.length, 0); assert.equal(taskDry.writes.length, 0);
  assert.match(taskDry.logs.join('\n'), /share ONE explicit/);
}
for (const rawArgs of [
  ['--task-case', 'unknown'], ['--task-case'],
  ['--task-case', 'prompt-assembly', '--ui-chain'],
  ['--task-case', 'human-branch', '--business-chain'],
  ['--task-build-only'],
  ['--execute', '--run-id', 'next', '--replay-prefix', 'prior', '--task-case', 'human-branch', '--task-build-only'],
  ['--execute', '--run-id', 'next', '--continue-after', 'prior', '--replay-prefix', 'foreign', '--task-case', 'human-branch', '--task-build-only'],
  ['--execute', '--run-id', 'next', '--continue-after', 'prior', '--replay-prefix', 'prior', '--task-case', 'human-branch'],
  ['--execute', '--run-id', 'next', '--continue-after', 'prior', '--task-case', 'structured-display'],
]) {
  const rejected = await isolated({ rawArgs });
  assert(rejected.error, 'Unknown/mixed task profiles or a non-task predecessor must fail before writes');
  assert.equal(rejected.writes.length, 0);
}
const taskBuildDry = await isolated({ rawArgs: ['--task-case', 'human-branch', '--task-build-only'] });
assert.equal(taskBuildDry.error, undefined); assert.equal(taskBuildDry.reads.length, 0); assert.equal(taskBuildDry.writes.length, 0);
assert.match(taskBuildDry.logs.join('\n'), /preview ONLY/);
assert.match(dry.logs.join('\n'), /--business-chain/);
assert.match(dry.logs.join('\n'), /--business-interaction-only/, 'Dry-run must describe the separate, non-whole-chain interaction profile');
assert.match(dry.logs.join('\n'), /hold 1 request \/ 2048 tokens for one evidence-ID review with no judge format retry/);
for (const profile of ['ui-chain', 'business-chain']) {
  const result = await isolated({ profile }); assert.equal(result.error, undefined);
  const claim = result.events.findIndex(event => event.op === 'write' && event.target.endsWith('continued-by.json'));
  const outputDirectory = result.events.findIndex(event => event.op === 'mkdir' && event.target.endsWith(`${path.sep}next`));
  const lastSourceRead = result.events.reduce((last, event, index) => ['read', 'readdir'].includes(event.op) ? index : last, -1);
  assert(claim > outputDirectory && outputDirectory > lastSourceRead, 'Validate the actual candidate first; then reject duplicate run ID; only then claim the prior ledger');
  assert.equal(result.writes.filter(target => target.endsWith('continued-by.json')).length, 1);
}
for (const scenario of [{ profile: 'targeted' }, { missingCandidate: true }, { badApproval: true }, { duplicateRunId: true }]) {
  const result = await isolated(scenario); assert(result.error, 'Invalid source or duplicate ID must fail closed');
  assert.equal(result.writes.length, 0, 'Invalid source, changed approval or duplicate run ID must not consume the prior continuation marker');
}
const replayed = await isolated({ replay: true });
assert.equal(replayed.error, undefined); assert.equal(replayed.replayReplies, 3);
const replayReport = replayed.writtenValues.get('report.json') as { approvalUsage: unknown; replayedExactPaidRequests: number; buildAccepted: boolean };
assert.deepEqual((replayed.writtenValues.get('manifest.json') as Record<string, unknown>).independentReviewReservation, { calls: 1, tokens: 2048 },
  'Whole business-chain replay keeps the same original approval ceiling but reserves only its single evidence-ID judge');
assert.deepEqual(replayReport.approvalUsage, { calls: 4, outputTokensReserved: 16896 }, 'Paid prefix replays inherit the approval without resetting or double-charging it');
assert.equal(replayReport.replayedExactPaidRequests, 3); assert.equal(replayReport.buildAccepted, false);
for (const scenario of [{ replayProfile: 'ui-chain' }, { replayProviderMismatch: true }, { replayId: 'other' }, { noContinue: true }, { legacyUiReplay: true }]) {
  const rejected = await isolated({ replay: true, ...scenario });
  assert(rejected.error, 'Only a same-provider, same-profile paid business prefix from the exact continuing approval is allowed');
  assert.equal(rejected.writes.length, 0, 'Foreign/cross-profile replay must fail before claiming the prior approval');
}
const mismatched = await isolated({ replay: true, mismatch: true });
assert(mismatched.error); assert.match(String(mismatched.error), /S2_REPLAY_REQUEST_MISMATCH_2/);
assert.equal(mismatched.replayReplies, 1, 'A mismatched request must not skip an immutable paid entry or silently replace it with a new request');
assert.equal(mismatched.writtenValues.has('request-1.json'), false, 'Mismatch must not dispatch a paid replacement request');
for (const buildOnly of [false, true]) {
  const ancestor = await isolated({ replay: true, replayId: 'ancestor', ancestry: 'valid', buildOnly });
  assert.equal(ancestor.error, undefined); assert.equal(ancestor.replayReplies, buildOnly ? 2 : 3);
  assert(ancestor.reads.some(target => target.includes(`${path.sep}ancestor${path.sep}continued-by.json`)));
  assert(ancestor.reads.some(target => target.includes(`${path.sep}middle${path.sep}continued-by.json`)));
  const report = ancestor.writtenValues.get('report.json') as { approvalUsage: unknown; businessGoalClosureTested: boolean; businessBuildPreviewTested: boolean; replayedExactPaidRequests: number; passed: boolean };
  assert.deepEqual(report.approvalUsage, buildOnly ? { calls: 9, outputTokensReserved: 31744 } : { calls: 4, outputTokensReserved: 16896 });
  assert.equal(report.replayedExactPaidRequests, buildOnly ? 2 : 3);
  assert.equal(report.businessGoalClosureTested, !buildOnly); assert.equal(report.businessBuildPreviewTested, buildOnly);
  assert.equal(report.passed, false, 'Build/preview replay safety must never fabricate whole-chain success');
  if (buildOnly) assert(!ancestor.reads.some(target => /(?:request|response)-3\.json$/.test(target)), 'Build-only must load exactly the two paid design requests, not an unrelated third entry');
  for (const rejection of [{ ancestry: 'cycle' as const }, { ancestry: 'orphan' as const }, { ancestorProfileMismatch: true },
    { ancestorProviderMismatch: true }, { ancestorApprovalMismatch: true }, { endpointProfileMismatch: true }, { endpointProviderMismatch: true }]) {
    const rejected = await isolated({ replay: true, replayId: 'ancestor', ancestry: 'valid', buildOnly, ...rejection });
    assert(rejected.error, `Every paid-prefix ancestor and its continuing endpoint must share profile/provider/approval: ${JSON.stringify(rejection)}`);
    assert.equal(rejected.writes.length, 0, 'Unrelated, cyclic or mismatched ancestry must be refused before claiming any prior continuation');
  }
}

const interaction = await isolated({ interaction: true });
assert.equal(interaction.error, undefined); assert.equal(interaction.strictBusinessReads, 1); assert.equal(interaction.interactionRuns, 1);
assert.equal(interaction.syntheticDispatches.length, 7, 'Three intent/action turns plus exactly one independent judge fit the remaining approval');
assert.deepEqual(interaction.syntheticDispatches.map(entry => entry.tokens), [1536, 1536, 1536, 1536, 1536, 1536, 2048]);
assert.equal(JSON.parse(interaction.syntheticRequests.at(-1)!.userInput).phase, 's2-business-interaction-independent-review');
const interactionManifest = interaction.writtenValues.get('manifest.json') as Record<string, any>;
const interactionReport = interaction.writtenValues.get('report.json') as Record<string, any>;
assert.equal(interactionManifest.profile, 'business-interaction-only');
assert.deepEqual(interactionManifest.prior, { calls: 11, outputTokensReserved: 35840 });
assert.deepEqual(interactionManifest.approval, { maxCalls: 24, reservedOutputTokens: 48000 });
assert.deepEqual(interactionManifest.independentReviewReservation, { calls: 1, tokens: 2048 });
assert.equal(interactionManifest.acceptedModelSource, 'prior'); assert.equal(interactionManifest.buildAcceptanceTested, false);
assert.equal(interactionManifest.businessGoalClosureTested, false); assert.equal(interactionManifest.businessInteractionSubsetTested, true);
assert.equal(interactionReport.passed, false); assert.equal(interactionReport.buildAccepted, false);
assert.equal(interactionReport.interactionPassed, false); assert.equal(interactionReport.interactionSubsetPassed, true);
assert.equal(interactionReport.businessGoalClosureTested, false); assert.equal(interactionReport.businessBuildPreviewTested, false);
assert.equal(interactionReport.businessInteractionSubsetTested, true); assert.equal(interactionReport.acceptedModelSource, 'prior');
assert.deepEqual(interactionReport.approvalUsage, { calls: 18, outputTokensReserved: 47104 }, 'Do not reset or double charge the prior 11/35840 ledger');
assert.equal(interactionReport.productionWrites, 0); assert.equal(interaction.exitCode, undefined);
const interactionClaim = interaction.events.findIndex(event => event.op === 'write' && event.target.endsWith('continued-by.json'));
const interactionOutput = interaction.events.findIndex(event => event.op === 'mkdir' && event.target.endsWith(`${path.sep}next`));
const interactionSourceRead = interaction.events.reduce((last, event, index) => event.op === 'read' ? index : last, -1);
assert(interactionClaim > interactionOutput && interactionOutput > interactionSourceRead,
  'The accepted report, manifest and immutable definition must all validate before claiming the continuing approval');
assert.equal(interaction.writes.filter(target => target.endsWith('continued-by.json')).length, 1);

const rejectedInteractionSources: Scenario[] = [
  { sourceManifestPatch: { profile: 'business-chain' } }, { sourceManifestPatch: { syntheticOnly: false } },
  { sourceManifestPatch: { provider: { ...metadata, model: 'other-model' } } },
  { sourceManifestPatch: { approval: { maxCalls: 24, reservedOutputTokens: 48001 } } },
  ...Object.entries({ profile: 'business-chain', caseId: 'ui-chain', execution: 'offline', productionWrites: 1,
    buildAccepted: false, buildPreviewPassed: false }).map(([key, value]) => ({ sourceReportPatch: { [key]: value } })),
  ...['profile', 'caseId', 'execution', 'productionWrites', 'buildAccepted', 'buildPreviewPassed', 'definition']
    .map(key => ({ sourceReportPatch: { [key]: undefined } })),
  { sourceReportPatch: { provider: { ...metadata, origin: 'https://foreign.invalid' } } },
  { sourceReportPatch: { approvalUsage: { calls: 24, outputTokensReserved: 35840 } } },
  { sourceReportPatch: { approvalUsage: { calls: 11, outputTokensReserved: 48000 } } },
  { sourceDefinitionMismatch: true }, { invalidBusinessDefinition: true }, { duplicateRunId: true }, { noContinue: true },
];
for (const rejection of rejectedInteractionSources) {
  const result = await isolated({ interaction: true, ...rejection });
  assert(result.error, `Unaccepted/foreign/missing/mismatched or schema-invalid interaction source must fail closed: ${JSON.stringify(rejection)}`);
  assert.equal(result.writes.length, 0, 'Invalid source or duplicate output cannot consume the approval continuation');
  assert.equal(result.interactionRuns, 0); assert.equal(result.syntheticDispatches.length, 0);
}
const interactionBaseArgs = ['--execute', '--run-id', 'next', '--continue-after', 'prior'];
for (const otherFlag of ['--business-build-only', '--business-chain', '--ui-chain', '--scope-review', '--targeted']) {
  for (const flags of [[otherFlag, '--business-interaction-only'], ['--business-interaction-only', otherFlag]]) {
    const result = await isolated({ interaction: true, rawArgs: [...interactionBaseArgs, ...flags] });
    assert(result.error, `Interaction subset must not mix profiles in either order: ${flags.join(' ')}`);
    assert.equal(result.writes.length, 0); assert.equal(result.interactionRuns, 0);
  }
}
for (const option of ['--replay-prefix', '--interaction-draft', '--scope-source', '--review-only']) {
  const result = await isolated({ interaction: true, rawArgs: [...interactionBaseArgs, option, 'prior', '--business-interaction-only'] });
  assert(result.error, `Interaction subset must not admit ${option} substitution`);
  assert.equal(result.writes.length, 0); assert.equal(result.interactionRuns, 0);
}
for (const scenario of [{ extraInteractionAction: true }, { extraInteractionJudge: true }]) {
  const result = await isolated({ interaction: true, ...scenario }); assert.equal(result.error, undefined);
  const report = result.writtenValues.get('report.json') as Record<string, any>;
  assert.equal(report.stopped, 'approval-budget-exhausted'); assert.equal(report.interactionSubsetPassed, false);
  assert.equal(report.passed, false); assert.equal(report.buildAccepted, false); assert.equal(report.interactionPassed, false);
  assert.deepEqual(report.approvalUsage, { calls: 18, outputTokensReserved: 47104 });
  assert.equal(result.syntheticDispatches.length, 7, 'An extra action cannot consume the held judge budget; an extra judge cannot exceed total approval');
  assert.equal(JSON.parse(result.syntheticRequests.at(-1)!.userInput).phase, 's2-business-interaction-independent-review');
  assert.equal(result.exitCode, 2, 'Partial/stopped interaction evidence cannot report a successful validation exit');
}
const guardedPartial = await isolated({ interaction: true, interactionWrongFullFlags: true });
assert.equal(guardedPartial.error, undefined);
const guardedPartialReport = guardedPartial.writtenValues.get('report.json') as Record<string, any>;
assert.equal(guardedPartialReport.passed, false); assert.equal(guardedPartialReport.buildAccepted, false);
assert.equal(guardedPartialReport.interactionPassed, false); assert.equal(guardedPartialReport.interactionSubsetPassed, true,
  'Even a future runner flag regression must not promote a selected interaction subset to full business/build/interaction acceptance');

const newApproval = await isolated({ interaction: true, newApproval: true });
assert.equal(newApproval.error, undefined); assert.equal(newApproval.strictBusinessReads, 1); assert.equal(newApproval.syntheticDispatches.length, 7);
const newManifest = newApproval.writtenValues.get('manifest.json') as Record<string, any>;
const newReport = newApproval.writtenValues.get('report.json') as Record<string, any>;
assert.deepEqual(newManifest.prior, { calls: 0, outputTokensReserved: 0 }, 'Only the explicitly new authorization starts its own usage at zero');
assert.equal(newManifest.acceptedModelSource, 'accepted'); assert.equal(newManifest.approvalLedgerRoot, 'next');
assert.deepEqual(newManifest.approval, { maxCalls: 24, reservedOutputTokens: 48000 });
assert.deepEqual(newManifest.approvalTransition, { kind: 'new-approval', previous: { runId: 'old', provider: metadata,
  limits: { maxCalls: 24, reservedOutputTokens: 48000 }, usage: { calls: 17, outputTokensReserved: 45056 }, aggregateUsage: { calls: 17, outputTokensReserved: 45056 } } });
assert.deepEqual(newManifest.aggregateApprovalUsage, { calls: 17, outputTokensReserved: 45056 });
assert.deepEqual(newReport.approvalUsage, { calls: 7, outputTokensReserved: 11264 });
assert.deepEqual(newReport.aggregateApprovalUsage, { calls: 24, outputTokensReserved: 56320 }, 'Cross-approval aggregate is visible but never mistaken for this approval ceiling');
assert.deepEqual(newReport.approvalTransition, newManifest.approvalTransition);
assert.deepEqual(newApproval.writtenValues.get('continued-by.json'), { runId: 'next', transition: 'new-approval', approvalLedgerRoot: 'next', acceptedModelSource: 'accepted' });
assert.equal(newReport.passed, false); assert.equal(newReport.buildAccepted, false); assert.equal(newReport.interactionPassed, false);
assert.equal(newReport.interactionSubsetPassed, true); assert.equal(newReport.replayedExactPaidRequests, 0);
assert(newApproval.writes.every(target => target.includes(`${path.sep}next${path.sep}`)
  || target.endsWith(`${path.sep}old${path.sep}continued-by.json`)), 'New approval can only create its own artifacts and single-use claim G; it must not rewrite F or old reports/limits');
const newClaim = newApproval.events.findIndex(event => event.op === 'write' && event.target.endsWith('continued-by.json'));
const newDirectory = newApproval.events.findIndex(event => event.op === 'mkdir' && event.target.endsWith(`${path.sep}next`));
const newLastSourceRead = newApproval.events.reduce((last, event, index) => event.op === 'read' ? index : last, -1);
assert(newClaim > newDirectory && newDirectory > newLastSourceRead, 'Validate accepted source, old endpoint, actual edge and unclaimed marker before creating or claiming anything');

for (const continueNewAncestor of [false, true]) {
  const continued = await isolated({ interaction: true, continueNewApproval: true, continueNewAncestor });
  assert.equal(continued.error, undefined); assert.equal(continued.strictBusinessReads, 1);
  const manifest = continued.writtenValues.get('manifest.json') as Record<string, any>;
  const report = continued.writtenValues.get('report.json') as Record<string, any>;
  assert.equal(manifest.approvalLedgerRoot, 'ledger'); assert.equal(manifest.acceptedModelSource, 'accepted');
  assert.deepEqual(manifest.prior, continueNewAncestor ? { calls: 14, outputTokensReserved: 22528 } : { calls: 7, outputTokensReserved: 11264 });
  assert.deepEqual(report.approvalUsage, continueNewAncestor ? { calls: 21, outputTokensReserved: 33792 } : { calls: 14, outputTokensReserved: 22528 });
  assert.deepEqual(report.aggregateApprovalUsage, continueNewAncestor ? { calls: 38, outputTokensReserved: 78848 } : { calls: 31, outputTokensReserved: 67584 });
  assert.deepEqual(continued.writtenValues.get('continued-by.json'), { runId: 'next', transition: 'same-approval', approvalLedgerRoot: 'ledger', acceptedModelSource: 'accepted' });
  assert.equal(report.passed, false); assert.equal(report.buildAccepted, false); assert.equal(report.interactionSubsetPassed, true);
}
for (const rejection of [
  { acceptedEdgeMismatch: true }, { claimedEndpoint: true }, { oldManifestPatch: { prior: { calls: 10, outputTokensReserved: 35840 } } },
  { oldManifestPatch: { profile: 'business-chain' } }, { oldManifestPatch: { syntheticOnly: false } },
  { oldManifestPatch: { provider: { ...metadata, model: 'foreign' } } }, { oldManifestPatch: { productionWrites: 1 } },
  { oldManifestPatch: { approval: { maxCalls: 25, reservedOutputTokens: 48000 } } },
  { oldManifestPatch: { acceptedModelSource: 'foreign' } }, { oldManifestPatch: { businessInteractionSubsetTested: false } },
  { oldManifestPatch: { approvalLedgerRoot: 'foreign' } },
  { oldReportPatch: { profile: 'business-build-only' } }, { oldReportPatch: { execution: 'offline' } },
  { oldReportPatch: { provider: { ...metadata, origin: 'https://foreign.invalid' } } }, { oldReportPatch: { productionWrites: 1 } },
  { oldReportPatch: { acceptedModelSource: 'foreign' } }, { oldReportPatch: { passed: true } },
  { oldReportPatch: { approvalUsage: { calls: 25, outputTokensReserved: 45056 } } },
  { oldReportPatch: { approvalUsage: { calls: 17, outputTokensReserved: 48001 } } },
  { oldReportPatch: { approvalUsage: { calls: 17.5, outputTokensReserved: 45056 } } },
  { oldReportPatch: { approvalUsage: { calls: 10, outputTokensReserved: 35840 } } },
  { oldReportPatch: { aggregateApprovalUsage: { calls: Number.MAX_SAFE_INTEGER, outputTokensReserved: Number.MAX_SAFE_INTEGER } } },
  { sourceDefinitionMismatch: true }, { invalidBusinessDefinition: true }, { duplicateRunId: true },
] satisfies Scenario[]) {
  const result = await isolated({ interaction: true, newApproval: true, ...rejection });
  assert(result.error, `New approval must reject changed provenance, source edge, inherited usage, already-claimed or invalid source before write: ${JSON.stringify(rejection)}`);
  assert.equal(result.writes.length, 0); assert.equal(result.interactionRuns, 0); assert.equal(result.syntheticDispatches.length, 0);
}
const carriedTransition = { kind: 'new-approval', previous: { runId: 'foreign', provider: metadata,
  limits: { maxCalls: 24, reservedOutputTokens: 48000 }, usage: { calls: 0, outputTokensReserved: 0 }, aggregateUsage: { calls: 0, outputTokensReserved: 0 } } };
const unsupportedNewAfter = await isolated({ interaction: true, newApproval: true,
  oldManifestPatch: { approvalLedgerRoot: 'old', approvalTransition: carriedTransition, aggregateApprovalUsage: { calls: 11, outputTokensReserved: 35840 } },
  oldReportPatch: { approvalLedgerRoot: 'old', approvalTransition: carriedTransition, prior: { calls: 11, outputTokensReserved: 35840 }, aggregateApprovalUsage: { calls: 17, outputTokensReserved: 45056 } } });
assert(unsupportedNewAfter.error, 'An internally self-consistent but invented earlier approval cannot substitute for real source ancestry');
assert.equal(unsupportedNewAfter.writes.length, 0); assert.equal(unsupportedNewAfter.interactionRuns, 0);
for (const rejection of [
  { claimedEndpoint: true }, { acceptedEdgeMismatch: true }, { transitionMismatch: true }, { predecessorSnapshotMismatch: true },
  { ledgerRootMismatch: true }, { ledgerManifestPatch: { acceptedModelSource: 'foreign' } },
  { ledgerReportPatch: { aggregateApprovalUsage: { calls: 24, outputTokensReserved: 1 } } },
  { ledgerManifestPatch: { prior: { calls: 1, outputTokensReserved: 0 } }, ledgerReportPatch: { prior: { calls: 1, outputTokensReserved: 0 } } },
  { ledgerAncestry: 'cycle' as const }, { ledgerAncestry: 'orphan' as const },
] satisfies Scenario[]) {
  const result = await isolated({ interaction: true, continueNewApproval: true, continueNewAncestor: true, ...rejection });
  assert(result.error, `Continuing the new authorization must reject mismatched source/root/snapshot/aggregate or ancestry: ${JSON.stringify(rejection)}`);
  assert.equal(result.writes.length, 0); assert.equal(result.interactionRuns, 0);
}
for (const rawArgs of [
  ['--execute', '--run-id', 'next', '--new-approval-after', 'old', '--business-interaction-only'],
  ['--execute', '--run-id', 'next', '--accepted-source', 'accepted', '--business-interaction-only'],
  ['--execute', '--run-id', 'next', '--accepted-source', 'accepted', '--new-approval-after', 'old', '--continue-after', 'ledger', '--business-interaction-only'],
  ['--execute', '--run-id', 'next', '--accepted-source', 'accepted', '--new-approval-after', 'old', '--business-chain'],
  ['--execute', '--run-id', 'next', '--accepted-source', 'next', '--new-approval-after', 'old', '--business-interaction-only'],
  ['--execute', '--run-id', 'next', '--accepted-source', 'accepted', '--new-approval-after', 'accepted', '--business-interaction-only'],
  ...['--replay-prefix', '--interaction-draft'].map(option => ['--execute', '--run-id', 'next', '--accepted-source', 'accepted', '--new-approval-after', 'old', option, 'old', '--business-interaction-only']),
]) {
  const result = await isolated({ interaction: true, newApproval: true, rawArgs });
  assert(result.error, `New authorization requires an explicit, exclusive interaction-only transition: ${rawArgs.join(' ')}`);
  assert.equal(result.writes.length, 0); assert.equal(result.interactionRuns, 0);
}
const secondApproval = await isolated({ interaction: true, secondNewApproval: true });
assert.equal(secondApproval.error, undefined); assert.equal(secondApproval.strictBusinessReads, 1); assert.equal(secondApproval.syntheticDispatches.length, 7);
const secondManifest = secondApproval.writtenValues.get('manifest.json') as Record<string, any>;
const secondReport = secondApproval.writtenValues.get('report.json') as Record<string, any>;
assert.deepEqual(secondManifest.prior, { calls: 0, outputTokensReserved: 0 }); assert.equal(secondManifest.approvalLedgerRoot, 'next');
assert.deepEqual(secondManifest.approval, { maxCalls: 24, reservedOutputTokens: 48000 });
assert.deepEqual(secondManifest.independentReviewReservation, { calls: 1, tokens: 2048 });
assert.deepEqual(secondManifest.approvalTransition, { kind: 'new-approval', previous: { runId: 'endpoint-new', provider: metadata,
  limits: { maxCalls: 24, reservedOutputTokens: 48000 }, usage: { calls: 23, outputTokensReserved: 36864 }, aggregateUsage: { calls: 40, outputTokensReserved: 81920 } } });
assert.deepEqual(secondManifest.aggregateApprovalUsage, { calls: 40, outputTokensReserved: 81920 });
assert.deepEqual(secondReport.approvalUsage, { calls: 7, outputTokensReserved: 11264 });
assert.deepEqual(secondReport.aggregateApprovalUsage, { calls: 47, outputTokensReserved: 93184 });
assert.deepEqual(secondApproval.writtenValues.get('continued-by.json'), { runId: 'next', transition: 'new-approval', approvalLedgerRoot: 'next', acceptedModelSource: 'accepted' });
assert.equal(secondReport.passed, false); assert.equal(secondReport.buildAccepted, false); assert.equal(secondReport.interactionSubsetPassed, true);
assert(secondApproval.reads.some(target => target.endsWith(`${path.sep}accepted${path.sep}continued-by.json`)));
for (const ancestor of ['old', 'ledger', 'middle-new', 'endpoint-new']) assert(secondApproval.reads.some(target => target.endsWith(`${path.sep}${ancestor}${path.sep}report.json`)), `Verify actual ${ancestor} report, not just the endpoint's embedded metadata`);
assert(secondApproval.writes.every(target => target.includes(`${path.sep}next${path.sep}`)
  || target.endsWith(`${path.sep}endpoint-new${path.sep}continued-by.json`)), 'Second approval cannot rewrite any older source, report, limit or marker');
const secondContinue = await isolated({ interaction: true, continueSecondApproval: true });
assert.equal(secondContinue.error, undefined);
const secondContinueManifest = secondContinue.writtenValues.get('manifest.json') as Record<string, any>;
const secondContinueReport = secondContinue.writtenValues.get('report.json') as Record<string, any>;
assert.equal(secondContinueManifest.approvalLedgerRoot, 'second-ledger');
assert.deepEqual(secondContinueManifest.prior, { calls: 7, outputTokensReserved: 11264 });
assert.deepEqual(secondContinueReport.approvalUsage, { calls: 14, outputTokensReserved: 22528 }, 'Continuing K must inherit its own usage, not open a third authorization');
assert.deepEqual(secondContinueReport.aggregateApprovalUsage, { calls: 54, outputTokensReserved: 104448 });
assert.deepEqual(secondContinue.writtenValues.get('continued-by.json'), { runId: 'next', transition: 'same-approval', approvalLedgerRoot: 'second-ledger', acceptedModelSource: 'accepted' });
assert.equal(secondContinueReport.passed, false); assert.equal(secondContinueReport.buildAccepted, false); assert.equal(secondContinueReport.interactionSubsetPassed, true);
const secondRejections: Scenario[] = [
  { acceptedEdgeMismatch: true }, { claimedEndpoint: true }, { predecessorSnapshotMismatch: true },
  { oldManifestPatch: { prior: { calls: 10, outputTokensReserved: 35840 } } },
  { ancestryPatches: [{ runId: 'ledger', edge: { runId: 'ledger', transition: 'same-approval', approvalLedgerRoot: 'ledger', acceptedModelSource: 'accepted' } }] },
  { ancestryPatches: [{ runId: 'middle-new', edge: { runId: 'orphan', transition: 'same-approval', approvalLedgerRoot: 'ledger', acceptedModelSource: 'accepted' } }] },
  { ancestryPatches: [{ runId: 'old', edge: { runId: 'foreign', transition: 'new-approval', approvalLedgerRoot: 'ledger', acceptedModelSource: 'accepted' } }] },
  { ancestryPatches: [{ runId: 'middle-new', manifest: { provider: { ...metadata, model: 'foreign' } } }] },
  { ancestryPatches: [{ runId: 'ledger', report: { provider: { ...metadata, origin: 'https://foreign.invalid' } } }] },
  { ancestryPatches: [{ runId: 'endpoint-new', report: { acceptedModelSource: 'foreign' } }] },
  { ancestryPatches: [{ runId: 'middle-new', manifest: { approval: { maxCalls: 25, reservedOutputTokens: 48000 } } }] },
  { ancestryPatches: [{ runId: 'ledger', report: { aggregateApprovalUsage: { calls: 24, outputTokensReserved: 1 } } }] },
  { ancestryPatches: [{ runId: 'endpoint-new', report: { approvalUsage: { calls: 24, outputTokensReserved: 48001 } } }] },
  { ancestryPatches: [{ runId: 'endpoint-new', manifest: { approvalLedgerRoot: 'foreign' }, report: { approvalLedgerRoot: 'foreign' } }] },
  { ancestryPatches: [{ runId: 'middle-new', manifest: { prior: { calls: 6, outputTokensReserved: 11264 }, aggregateApprovalUsage: { calls: 23, outputTokensReserved: 56320 } },
    report: { prior: { calls: 6, outputTokensReserved: 11264 } } }] },
];
for (const rejection of secondRejections) {
  const result = await isolated({ interaction: true, secondNewApproval: true, ...rejection });
  assert(result.error, `Second new approval must verify real ancestors, not internally consistent endpoint metadata: ${JSON.stringify(rejection)}`);
  assert.equal(result.writes.length, 0); assert.equal(result.interactionRuns, 0); assert.equal(result.syntheticDispatches.length, 0);
}
for (const rejection of [
  { claimedEndpoint: true }, { secondSnapshotMismatch: true }, { predecessorSnapshotMismatch: true }, { acceptedEdgeMismatch: true },
  { ancestryPatches: [{ runId: 'endpoint-new', edge: { runId: 'second-ledger', transition: 'same-approval', approvalLedgerRoot: 'second-ledger', acceptedModelSource: 'accepted' } }] },
  { ancestryPatches: [{ runId: 'second-ledger', report: { aggregateApprovalUsage: { calls: 47, outputTokensReserved: Number.MAX_SAFE_INTEGER } } }] },
] satisfies Scenario[]) {
  const result = await isolated({ interaction: true, continueSecondApproval: true, ...rejection });
  assert(result.error, `Second-pool continuation must retain verified old+new ancestry, snapshot and aggregate: ${JSON.stringify(rejection)}`);
  assert.equal(result.writes.length, 0); assert.equal(result.interactionRuns, 0);
}
const cycleTransition = { kind: 'new-approval', previous: { runId: 'second-ledger', provider: metadata,
  limits: { maxCalls: 24, reservedOutputTokens: 48000 }, usage: { calls: 7, outputTokensReserved: 11264 }, aggregateUsage: { calls: 47, outputTokensReserved: 93184 } } };
const approvalCycle = await isolated({ interaction: true, continueSecondApproval: true, ancestryPatches:
  [
    { runId: 'ledger', prior: { calls: 0, outputTokensReserved: 0 }, usage: { calls: 7, outputTokensReserved: 11264 } },
    { runId: 'middle-new', prior: { calls: 7, outputTokensReserved: 11264 }, usage: { calls: 15, outputTokensReserved: 24576 } },
    { runId: 'endpoint-new', prior: { calls: 15, outputTokensReserved: 24576 }, usage: { calls: 23, outputTokensReserved: 36864 } },
  ].map(node => ({ runId: node.runId, manifest: { approvalTransition: cycleTransition, aggregateApprovalUsage: {
    calls: 47 + node.prior.calls, outputTokensReserved: 93184 + node.prior.outputTokensReserved } }, report: { approvalTransition: cycleTransition,
    aggregateApprovalUsage: { calls: 47 + node.usage.calls, outputTokensReserved: 93184 + node.usage.outputTokensReserved } } })) });
assert(approvalCycle.error); assert.match(String(approvalCycle.error), /cycles/, 'Individually self-consistent pool records cannot create a circular prior-approval authority chain');
assert.equal(approvalCycle.writes.length, 0); assert.equal(approvalCycle.interactionRuns, 0);
console.log('S2 live CLI safety passed: existing provenance/replay/partial-only safeguards; explicit new 24/48000 pools preserve immutable usage and single-use markers; full accepted F→G→H→I→J ancestry is verified before second approval K starts at zero with real J23/36864 and aggregate40/81920; K→L keeps same-pool usage; forged internal snapshots, cross-pool cycles, orphan links, changed provider/source/limits/prior/root/aggregate/markers fail before writes. All filesystem, provider and dispatch activity was synthetic VM data; no actual credentials, artifacts, model or network were accessed.');

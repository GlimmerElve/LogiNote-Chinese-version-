/** Isolated CLI-only safety regression. No real credentials, saved runs, models or network. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const cli = readFileSync('scripts/run-scene-s2-host-result-live.ts', 'utf8');
const output = ts.transpileModule(cli, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const provider = { id: 'synthetic-provider', model: 'synthetic-model', origin: 'https://synthetic.invalid' };
const secret = 'synthetic-not-real-credential';
type Scenario = { dry?: boolean; rawArgs?: string[]; manifest?: Record<string, unknown>; report?: Record<string, unknown>;
  invalidDefinition?: boolean; invalidPreparation?: boolean; claimed?: boolean; duplicate?: boolean; markerRace?: boolean;
  productions?: number; extraJudge?: boolean; wrongStage?: boolean; missingPrivacy?: boolean; wrongProvider?: boolean;
  wrongHttp?: boolean; transportError?: boolean; proxyRetry?: boolean; proxyDuplicate?: boolean; secretEcho?: boolean;
  requestPatch?: { index: number; value: Record<string, unknown> }; invalidStoredJson?: boolean };
async function isolated(scenario: Scenario = {}) {
  const events: Array<{ op: string; target: string }> = [], writes = new Map<string, unknown>(), logs: string[] = [];
  const dispatches: Array<{ kind: string; tokens: number; usage: { calls: number; outputTokensReserved: number } }> = [];
  const requests: Array<{ maxTokensOverride: number; userInput: string }> = [];
  let prepared = 0, coreRuns = 0, syntheticHttp = 0, syntheticProxy = 0;
  const definition = { version: 1, synthetic: true }, editConfirmed = { document: { syntheticConfirmed: true }, commands: [] };
  const paidRequests = Array.from({ length: 19 }, (_, index) => ({ workflow: 'agent-scene-setup', providerId: '', model: '',
    skipMemoryInjection: true, skipProfileInjection: true, maxTokensOverride: [3072, 6144, 2048, 2048][index] ?? 1536,
    userInput: JSON.stringify(index >= 17 ? { stage: 'turn-understand', origin: 'host-event', hostEvent: { kind: 'workflow-completed', workflowRunId: 'old-real-local-run' },
      triggeredExecution: { available: true, workflowRunId: 'old-real-local-run' }, ...(index === 18 ? { memoryRepair: { error: 'synthetic host memory rejection' } } : {}) }
      : { stage: index < 4 ? 'synthetic-paid-build' : 'turn-act', origin: 'user', syntheticOnly: true }) }));
  if (scenario.requestPatch) Object.assign(paidRequests[scenario.requestPatch.index - 1], scenario.requestPatch.value);
  const sourceManifest = { kind: 's2-real-agent-validation', profile: 'business-chain', syntheticOnly: true, productionWrites: 0, provider,
    approval: { maxCalls: 24, reservedOutputTokens: 48000 }, prior: { calls: 0, outputTokensReserved: 0 }, resumedSameApprovalPaidPrefix: false,
    businessGoalClosureTested: true, ...scenario.manifest };
  const sourceReport = { profile: 'business-chain', caseId: 'business-chain', productionWrites: 0, provider, execution: 'real-provider',
    businessGoalClosureTested: true, buildAccepted: true, passed: false, stopped: 'ui-chain-stage-failed', definition,
    steps: Array.from({ length: 6 }, () => ({ origin: 'user', syntheticAccepted: true })),
    approvalUsage: { calls: 19, outputTokensReserved: 36352 }, dispatchAudit: { ipc: { calls: 19, tokens: 36352 }, http: { calls: 19, tokens: 36352 } }, ...scenario.report };
  const json = (value: unknown) => JSON.stringify(value);
  const fakeFs = {
    async readFile(file: unknown) {
      const target = String(file); events.push({ op: 'read', target });
      if (target.endsWith('storage-config.json')) return json({ dataRoot: 'synthetic-root' });
      if (target.endsWith('llm.json')) return json({ settings: { workflowBinding: { 'scene-general-turn': provider.id }, defaultProviderId: provider.id,
        providers: [{ id: provider.id, enabled: true, apiType: 'openai-compatible', apiKey: secret, selectedModel: provider.model, baseUrl: provider.origin }] } });
      if (target.endsWith('continued-by.json')) {
        if (scenario.claimed) return json({ runId: 'already-claimed' });
        throw Object.assign(new Error('synthetic missing marker'), { code: 'ENOENT' });
      }
      assert(target.includes(`${path.sep}prior${path.sep}`), 'Only the explicitly named synthetic source can be read');
      if (target.endsWith('manifest.json')) return json(sourceManifest);
      if (target.endsWith('report.json')) return json(sourceReport);
      if (target.endsWith('definition.json')) return json(scenario.invalidDefinition ? { changed: true } : definition);
      if (target.endsWith('ui-edit-confirmed.json')) return json(editConfirmed);
      const match = path.basename(target).match(/^request-(\d+)\.json$/); assert(match);
      if (scenario.invalidStoredJson && match[1] === '19') return '{not json';
      return json(paidRequests[Number(match[1]) - 1]);
    },
    async mkdir(file: unknown, options?: unknown) {
      events.push({ op: 'mkdir', target: String(file) }); if (!options && scenario.duplicate) throw new Error('synthetic duplicate run');
    },
    async writeFile(file: unknown, value: unknown, options?: { flag?: string }) {
      const target = String(file); assert.equal(options?.flag, 'wx', 'Never replace source, marker or output artifacts');
      if (scenario.markerRace && target.endsWith('continued-by.json')) throw Object.assign(new Error('synthetic competing claim'), { code: 'EEXIST' });
      events.push({ op: 'write', target }); writes.set(path.basename(target), JSON.parse(String(value)));
    },
    async appendFile(file: unknown, value: unknown) { assert(String(file).endsWith('dispatch.jsonl')); dispatches.push(JSON.parse(String(value))); },
  };
  const modules: Record<string, unknown> = {
    '../src/services/llmService': { callLLM: async (request: { maxTokensOverride: number; userInput: string }, options: { providerSnapshot: unknown }) => {
      requests.push(request); assert(options.providerSnapshot);
      return (sandbox as any).window.electronAPI.llm.request({ provider: { baseUrl: provider.origin, selectedModel: provider.model,
        apiKey: scenario.wrongProvider ? 'foreign-synthetic-credential' : secret }, maxTokens: request.maxTokensOverride });
    } },
    '../src/electron/apiHandlers': { proxyLlmRequest: async (request: { maxTokens: number }) => {
      syntheticProxy++;
      const dispatch = () => (sandbox as any).fetch(scenario.wrongHttp ? 'https://foreign.invalid/chat/completions' : `${provider.origin}/chat/completions`,
        { method: 'POST', body: json({ max_tokens: request.maxTokens }) });
      try { await dispatch(); if (scenario.proxyDuplicate) await dispatch(); } catch (error) { if (scenario.proxyRetry) await dispatch(); throw error; }
      return { content: scenario.secretEcho ? secret : '{"synthetic":true}', diagnostics: { finishReason: 'stop' } };
    } },
    './scene-s2-agent-validation': { S2ValidationStop: class extends Error { constructor(public code: string) { super(code); } } },
    './scene-s2-host-result-validation': {
      prepareS2HostResultSource: (value: { report: unknown; definition: unknown; editConfirmed: unknown; requests: unknown[] }) => {
        prepared++; events.push({ op: 'prepare', target: 'synthetic-source' });
        assert.equal(json(value.report), json(sourceReport)); assert.equal(json(value.definition), json(definition));
        assert.equal(json(value.editConfirmed), json(editConfirmed)); assert.equal(json(value.requests), json(paidRequests));
        assert(!scenario.invalidPreparation, 'synthetic memory/target/source restoration rejected'); return { validatedSyntheticOnly: true };
      },
      runS2HostResultValidation: async (options: { source: unknown; invoke: (request: unknown) => Promise<unknown>; onArtifact: (name: string, value: unknown) => Promise<void> }) => {
        coreRuns++; assert.equal(json(options.source), json({ validatedSyntheticOnly: true })); let stopped: string | undefined;
        const invoke = (input: unknown, cap: number) => options.invoke({ workflow: 'agent-scene-setup', providerId: '', model: '',
          skipMemoryInjection: !scenario.missingPrivacy, skipProfileInjection: true, userInput: json(input), maxTokensOverride: cap });
        try {
          for (let index = 0; index < (scenario.productions ?? 2); index++) await invoke({ stage: scenario.wrongStage ? 'assemble' : index % 2 ? 'turn-act' : 'turn-understand', origin: 'host-event', syntheticOnly: true }, 6144);
        } catch (error) { stopped = (error as { code?: string }).code ?? 'synthetic-production-failed'; }
        if (!scenario.transportError && !scenario.proxyDuplicate && !scenario.wrongProvider && !scenario.wrongHttp && !scenario.secretEcho && !scenario.wrongStage && !scenario.missingPrivacy) {
          try {
            await invoke({ phase: 's2-host-result-independent-review', syntheticOnly: true }, 6144);
            if (scenario.extraJudge) await invoke({ phase: 's2-host-result-independent-review', syntheticOnly: true, formatRepair: true }, 6144);
          } catch (error) { stopped = (error as { code?: string }).code ?? 'synthetic-judge-failed'; }
        }
        await options.onArtifact('synthetic-host-evidence', { noActualHostInThisCliIsolationTest: true });
        return { hostResultSubsetPassed: !stopped, stopped, passed: true, buildAccepted: true, wholeChainTested: true, browserTested: true };
      },
    },
  };
  const argv = scenario.rawArgs ?? (scenario.dry ? [] : ['--execute', '--run-id', 'next', '--continue-after', 'prior', '--host-result-only']);
  const sandbox = { exports: {}, process: { argv: ['node', 'isolated-cli', ...argv], exitCode: undefined },
    console: { log: (...values: unknown[]) => logs.push(values.join(' ')) },
    require(name: string) {
      if (name === 'node:assert/strict') return assert; if (name === 'node:crypto') return { createHash };
      if (name === 'node:fs') return { promises: fakeFs }; if (name === 'node:os') return { homedir: () => 'synthetic-user' };
      if (name === 'node:path') return path; assert(Object.hasOwn(modules, name), `Unstubbed CLI dependency: ${name}`); return modules[name];
    }, URL, Request, AbortController, structuredClone, setTimeout, clearTimeout,
    fetch: async () => { syntheticHttp++; if (scenario.transportError) throw new Error(`synthetic network failure ${secret}`); return { ok: true }; },
  };
  let error: unknown;
  try { await new vm.Script(`(async () => { ${output}\n})()`, { filename: 's2-host-result-live.isolated.cjs' }).runInNewContext(sandbox, { timeout: 5000 }); }
  catch (caught) { error = caught; }
  assert(!logs.join('\n').includes(secret)); for (const value of writes.values()) assert(!json(value).includes(secret));
  return { events, writes, logs, error, exitCode: sandbox.process.exitCode, prepared, coreRuns, syntheticHttp, syntheticProxy, dispatches, requests };
}

const dry = await isolated({ dry: true }); assert.equal(dry.error, undefined); assert.deepEqual(dry.events, []); assert.equal(dry.coreRuns, 0);
assert.match(dry.logs.join('\n'), /--host-result-only/); assert.match(dry.logs.join('\n'), /never resets/);
const good = await isolated(); assert.equal(good.error, undefined); assert.equal(good.prepared, 1); assert.equal(good.coreRuns, 1);
assert.equal(good.requests.length, 3); assert.equal(good.syntheticProxy, 3); assert.equal(good.syntheticHttp, 3);
assert.deepEqual(good.requests.map(request => request.maxTokensOverride), [1536, 1536, 2048]);
assert.equal(good.dispatches.length, 6, 'Both IPC and HTTP reserve gates execute, without double charging one provider dispatch');
const manifest = good.writes.get('manifest.json') as Record<string, any>, report = good.writes.get('report.json') as Record<string, any>;
assert.deepEqual(manifest.prior, { calls: 19, outputTokensReserved: 36352 });
assert.deepEqual(manifest.approval, { maxCalls: 24, reservedOutputTokens: 48000 });
assert.deepEqual(manifest.independentReviewReservation, { calls: 1, tokens: 2048 }); assert.equal(manifest.maxNewCalls, 5);
assert.equal(Object.keys(manifest.sourceArtifacts).length, 23); assert(Object.values(manifest.sourceArtifacts).every((value: any) => /^[a-f0-9]{64}$/.test(value.sha256)));
assert.deepEqual(report.approvalUsage, { calls: 22, outputTokensReserved: 41472 }); assert.equal(report.hostResultSubsetPassed, true);
for (const field of ['passed', 'buildAccepted', 'wholeChainTested', 'browserTested']) assert.equal(report[field], false, `Core cannot promote host-only evidence through ${field}`);
assert.equal(report.productionWrites, 0); assert.equal(report.automaticTransportRetries, 0); assert.equal(good.exitCode, undefined);
assert.deepEqual(good.writes.get('continued-by.json'), { runId: 'next', transition: 'same-approval', scope: 'host-result-only' });
const sourceEnd = good.events.reduce((last, item, index) => ['read', 'prepare'].includes(item.op) ? index : last, -1);
const mkdir = good.events.findIndex(item => item.op === 'mkdir'), claim = good.events.findIndex(item => item.op === 'write' && item.target.endsWith('continued-by.json'));
assert(sourceEnd < mkdir && mkdir < claim, 'All source/schema/memory/target checks must complete before output creation or ledger claim');
assert(good.events.filter(item => item.op === 'write').every(item => item.target.includes(`${path.sep}next${path.sep}`) || item.target.endsWith(`${path.sep}prior${path.sep}continued-by.json`)));
for (const rejection of [
  { manifest: { profile: 'host-result-only' } }, { manifest: { syntheticOnly: false } }, { manifest: { prior: { calls: 1, outputTokensReserved: 0 } } },
  { manifest: { approval: { maxCalls: 25, reservedOutputTokens: 48000 } } }, { manifest: { replayPrefix: 'foreign' } },
  { manifest: { provider: { ...provider, model: 'foreign' } } }, { manifest: { productionWrites: 1 } },
  { report: { provider: { ...provider, origin: 'https://foreign.invalid' } } }, { report: { execution: 'offline' } },
  { report: { buildAccepted: false } }, { report: { passed: true } }, { report: { stopped: 'another-stage' } },
  { report: { steps: [{ origin: 'user' }] } }, { report: { steps: Array.from({ length: 6 }, () => ({ origin: 'host-event' })) } },
  { report: { approvalUsage: { calls: 0, outputTokensReserved: 0 } } }, { report: { approvalUsage: { calls: 19, outputTokensReserved: 36351 } } },
  { report: { dispatchAudit: { ipc: { calls: 18, tokens: 36352 }, http: { calls: 18, tokens: 36352 } } } },
  { invalidDefinition: true }, { invalidPreparation: true }, { claimed: true }, { duplicate: true }, { markerRace: true }, { invalidStoredJson: true },
  { requestPatch: { index: 19, value: { userInput: JSON.stringify({ stage: 'turn-act', origin: 'user' }) } } },
  { requestPatch: { index: 2, value: { skipMemoryInjection: false } } },
] satisfies Scenario[]) {
  const result = await isolated(rejection); assert(result.error, `Invalid source or already claimed/duplicate endpoint must fail closed: ${JSON.stringify(rejection)}`);
  assert.equal(result.writes.size, 0); assert.equal(result.coreRuns, 0); assert.equal(result.syntheticHttp, 0); assert.equal(result.requests.length, 0);
}
for (const rawArgs of [
  ['--execute', '--run-id', 'next', '--host-result-only'],
  ['--execute', '--run-id', 'next', '--continue-after', 'prior', '--business-chain'],
  ['--execute', '--run-id', 'next', '--continue-after', 'prior', '--new-approval-after', 'prior', '--host-result-only'],
  ['--execute', '--run-id', 'next', '--continue-after', '../foreign', '--host-result-only'],
  ['--execute', '--run-id', 'prior', '--continue-after', 'prior', '--host-result-only'],
]) { const result = await isolated({ rawArgs }); assert(result.error); assert.deepEqual(result.events, []); }
const repaired = await isolated({ productions: 4 }); assert.equal(repaired.error, undefined);
assert.deepEqual((repaired.writes.get('report.json') as Record<string, any>).approvalUsage, { calls: 24, outputTokensReserved: 44544 });
assert.equal(repaired.requests.length, 5);
const overBudget = await isolated({ productions: 5 }); assert.equal(overBudget.error, undefined);
const overReport = overBudget.writes.get('report.json') as Record<string, any>;
assert.equal(overReport.hostResultSubsetPassed, false); assert.equal(overReport.stopped, 'approval-budget-exhausted'); assert.equal(overBudget.exitCode, 2);
assert.equal(overBudget.requests.length, 5); assert.equal(JSON.parse(overBudget.requests.at(-1)!.userInput).phase, 's2-host-result-independent-review', 'Production cannot consume the held judge request');
assert.deepEqual(overReport.approvalUsage, { calls: 24, outputTokensReserved: 44544 });
for (const scenario of [{ extraJudge: true }, { wrongStage: true }, { missingPrivacy: true }, { wrongProvider: true }, { wrongHttp: true },
  { transportError: true, proxyRetry: true }, { proxyDuplicate: true }, { secretEcho: true }] satisfies Scenario[]) {
  const result = await isolated(scenario); assert.equal(result.error, undefined);
  assert.equal((result.writes.get('report.json') as Record<string, any>).hostResultSubsetPassed, false); assert.equal(result.exitCode, 2);
  if (scenario.extraJudge) assert.equal(result.requests.length, 3, 'A judge format repair cannot dispatch a second paid review');
  if (scenario.wrongStage || scenario.missingPrivacy) assert.equal(result.requests.length, 0, 'Builder/privacy scope drift must stop before provider dispatch');
  if (scenario.wrongProvider || scenario.wrongHttp) assert.equal(result.syntheticHttp, 0, 'Wrong provider or endpoint cannot reach even the synthetic transport');
  if (scenario.transportError) { assert.equal(result.syntheticHttp, 1); assert.equal(result.syntheticProxy, 1, 'Transport failure cannot trigger another proxy/provider attempt'); }
  if (scenario.proxyDuplicate) { assert.equal(result.syntheticHttp, 1); assert.equal(result.syntheticProxy, 1, 'Even an HTTP-200 parse/fallback path cannot dispatch twice within one invocation'); }
}
console.log('S2 host-result live CLI safety passed: isolated zero-IO dry-run; exact fresh synthetic 19/36352 source/paid-request/dispatch validation and core preparation before single-use claim; 23 immutable source hashes; shared 24/48000 cumulative budget, normal 3 and max5 calls with one held 2048 judge; both provider/HTTP gates, no retry/secret echo; exclusive host-only scope and fixed non-whole-chain flags. Only synthetic VM files/provider/network stubs used.');

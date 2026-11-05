import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReferenceRagAcceptanceTransport, loadReferenceRagAcceptanceModels,
  type ReferenceRagAcceptanceModels } from './reference-rag-acceptance-transport.ts';
import { ARGUMENT_REFERENCE_QUALIFICATION_PROMPT } from '../src/electron/rag/argumentReferencePolicy.ts';
import { ARGUMENT_PROJECTION_EXTRACTION_PROMPT, ARGUMENT_PROJECTION_SELECTION_PROMPT, ARGUMENT_PROJECTION_REVIEW_PROMPT,
  ARGUMENT_PROJECTION_SOURCE_REVIEW_PROMPT, ARGUMENT_PROJECTION_TASK_REVIEW_PROMPT,
  type ArgumentProjectionModelRequest } from '../src/services/argumentContext/buildPrompts.ts';
import { SOURCE_PROPOSITION_DRAFT_PROMPT, SOURCE_PROPOSITION_SELECTION_PROMPT, SOURCE_PROPOSITION_PARENT_SELECTION_PROMPT,
  SOURCE_PROPOSITION_REVIEW_PROMPT, TASK_SOURCE_PROPOSITION_REVIEW_PROMPT } from '../src/services/reviewComparison/sourcePropositionBuild.ts';
import { FROZEN_ATOMIC_REFERENCE_EXTRACTION_PROMPT } from '../src/services/reviewComparison/frozenExtractionPrompt.ts';
import { FROZEN_PROPOSITION_REFERENCE_PROMPT } from '../src/services/reviewComparison/frozenPropositionReference.ts';
import { JSON_OBJECT_OUTPUT } from '../src/workflows/structuredOutput.ts';
import type { LlmCallRequest } from '../src/types.ts';

// Production invoke/proxy implementations, synthetic configs and fetch only.
// The private loader is never executed with cloud authorization in these tests.
const fetchBefore = globalThis.fetch, timerBefore = globalThis.setTimeout;
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const stages = [ARGUMENT_REFERENCE_QUALIFICATION_PROMPT, ARGUMENT_PROJECTION_EXTRACTION_PROMPT, ARGUMENT_PROJECTION_REVIEW_PROMPT,
  SOURCE_PROPOSITION_DRAFT_PROMPT, SOURCE_PROPOSITION_REVIEW_PROMPT];
const sourceRequest = (index: number): ArgumentProjectionModelRequest => ({ stage: [0, 2, 4].includes(index) ? 'review' : 'extract',
  bindingId: `synthetic-${index}`, systemPrompt: stages[index], userInput: JSON.stringify({ syntheticOnly: true, stage: index }),
  skipMemoryInjection: true, skipProfileInjection: true, thinkingMode: 'disabled' });
const answerRequest = (review = false): LlmCallRequest => ({ providerId: '', model: '', workflow: 'review-scoring',
  userInput: JSON.stringify({ syntheticOnly: true }), systemPromptOverride: review ? FROZEN_PROPOSITION_REFERENCE_PROMPT : FROZEN_ATOMIC_REFERENCE_EXTRACTION_PROMPT,
  outputSchema: JSON_OBJECT_OUTPUT, maxTokensOverride: 4096, thinkingMode: 'disabled', skipMemoryInjection: true, skipProfileInjection: true });
function reply(content = '{"synthetic":true}', finish = 'stop') {
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }, model: 'provider-meta-not-persisted', privateMetadata: 'not-persisted' }),
  { status: 200, headers: { 'content-type': 'application/json', 'x-provider-private-header': 'not-persisted' } });
}
function models(): ReferenceRagAcceptanceModels {
  const config = { fingerprint: 'a'.repeat(64), providerLabel: 'Synthetic DeepSeek', modelName: 'deepseek-flash', isRemote: true,
    provider: { apiType: 'openai-compatible' as const, baseUrl: 'https://api.deepseek.com/v1', apiKey: 'synthetic-secret-not-for-artifacts',
      selectedModel: 'deepseek-flash', models: ['deepseek-flash'] } };
  return { source: structuredClone(config), answer: structuredClone(config), fingerprint: 'b'.repeat(64), assertCurrent: async () => {} };
}
function rig(native: typeof fetch = async () => reply()) {
  let network = 0, configChecks = 0, codeChecks = 0;
  const controller = new AbortController(), artifacts = new Map<string, unknown>(), configured = models();
  const config = configured.assertCurrent;
  configured.assertCurrent = async () => { configChecks++; await config(); };
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => { network++; return native(...args); }) as typeof fetch;
  let configChanged = false, codeChanged = false;
  configured.assertCurrent = async () => { configChecks++; if (configChanged) throw new Error('private settings changed'); };
  const transport = createReferenceRagAcceptanceTransport(configured, { signal: controller.signal,
    assertFrozen: async () => { codeChecks++; if (codeChanged) throw new Error('frozen code changed'); },
    save: async (name, value) => { assert.ok(!artifacts.has(name), 'Once-only artifact name'); artifacts.set(name, structuredClone(value)); } });
  const source = (index: number, signal = new AbortController().signal) => transport.sourceAdapter.invoke(configured.source, sourceRequest(index), signal);
  const answer = (review = false) => transport.answerCaller(answerRequest(review));
  return { transport, configured, controller, artifacts, source, answer, network: () => network,
    checks: () => ({ config: configChecks, code: codeChecks }), configChanged: () => { configChanged = true; }, codeChanged: () => { codeChanged = true; } };
}
async function using<T>(r: ReturnType<typeof rig>, work: () => Promise<T>): Promise<T> {
  try { return await work(); } finally { r.transport.restore(); }
}
async function hardStopped(r: ReturnType<typeof rig>, expectedCalls: number) {
  const summary = r.transport.summary(); assert.equal(summary.calls, expectedCalls); assert.equal(r.network(), expectedCalls);
  assert.match(summary.stopReason ?? '', /^reference_rag_acceptance_[a-z0-9_]+$/u);
  await assert.rejects(r.transport.withContext({ kind: 'answer', id: 'later' }, () => r.answer()));
  assert.equal(r.network(), expectedCalls);
}
try {
  const taskReview = rig(); await using(taskReview, async () => {
    await taskReview.transport.withContext({ kind: 'source', id: 'task-grounded-v3' }, async () => {
      await taskReview.source(0); await taskReview.source(1);
      await taskReview.transport.sourceAdapter.invoke(taskReview.configured.source,
        { ...sourceRequest(2), systemPrompt: ARGUMENT_PROJECTION_TASK_REVIEW_PROMPT }, new AbortController().signal);
    });
    assert.equal(taskReview.network(), 3);
    assert.equal(taskReview.transport.summary().stages[2].stage, 'structure-review');
  });
  pass('task-v3 audit exact prompt maps to existing single review stage, no generic whitelist or extra calls');
  const taskP = rig(); await using(taskP, async () => {
    await taskP.transport.withContext({ kind: 'source', id: 'task-P-review-v2' }, async () => {
      for (let index = 0; index < 4; index++) await taskP.source(index);
      await taskP.transport.sourceAdapter.invoke(taskP.configured.source,
        { ...sourceRequest(4), systemPrompt: TASK_SOURCE_PROPOSITION_REVIEW_PROMPT }, new AbortController().signal);
    });
    assert.equal(taskP.network(), 5); assert.equal(taskP.transport.summary().stages[4].stage, 'proposition-review');
  });
  pass('task P-v2 audit exact prompt preserves fifth-stage whitelist and five-request budget');
  const oldStat = fs.lstat, argv = process.argv;
  let reads = 0;
  try {
    process.argv = argv.filter(arg => !['--execute', '--allow-cloud'].includes(arg));
    fs.lstat = (async () => { reads++; assert.fail('Unauthorized loader cannot inspect filesystem'); }) as typeof fs.lstat;
    await assert.rejects(loadReferenceRagAcceptanceModels(), /configuration_read_not_authorized/u); assert.equal(reads, 0);
  } finally { fs.lstat = oldStat; process.argv = argv; }
  pass('private loader missing execute/cloud flags fails before any filesystem read; import has no configuration I/O');

  const happy = rig(async (_url, init) => { assert.equal(init?.redirect, 'error'); assert.ok(init?.signal); return reply(); });
  await using(happy, async () => {
    assert.equal(happy.network(), 0);
    await happy.transport.withContext({ kind: 'source', id: 'definition' }, async () => { for (let index = 0; index < 5; index++) await happy.source(index); });
    await happy.transport.withContext({ kind: 'answer', id: 'VD01' }, async () => { await happy.answer(); await happy.answer(true); });
    assert.equal(happy.network(), 7); assert.equal(happy.transport.summary().calls, 7); assert.equal(happy.artifacts.size, 14);
    assert.deepEqual(happy.transport.summary().stages.map(row => row.stage),
      ['quality', 'structure-draft', 'structure-review', 'proposition-draft', 'proposition-review', 'answer-extract', 'answer-review']);
    assert.ok(happy.transport.summary().stages.every(row => row.status === 'completed' && row.totalTokens === 18));
    assert.ok(happy.checks().config >= 28 && happy.checks().code >= 28);
    const serialized = JSON.stringify([...happy.artifacts]);
    for (const privateValue of ['Authorization', 'authorization', happy.configured.source.provider.apiKey, 'privateMetadata', 'provider-meta-not-persisted', 'x-provider-private-header'])
      assert.ok(!serialized.includes(privateValue), privateValue);
    const request = happy.artifacts.get('request-source-definition-quality.json') as any;
    assert.equal(request.body.temperature, 0); assert.equal(request.body.max_tokens, 12000); assert.equal(request.body.messages.length, 2);
    const answer = happy.artifacts.get('request-answer-VD01-answer-review.json') as any;
    assert.equal(answer.body.temperature, 0.1); assert.equal(answer.body.max_tokens, 4096);
  });
  pass('real production source invoke and answer proxy dispatch 5+2 exactly; captured actual parameters/prompts, no secrets or metadata');

  const selected = rig(); await using(selected, async () => {
    await selected.transport.withContext({ kind: 'source', id: 'new-protocol' }, async () => {
      for (let index = 0; index < 5; index++) {
        const request = sourceRequest(index);
        if (index === 1) request.systemPrompt = ARGUMENT_PROJECTION_SELECTION_PROMPT;
        if (index === 3) request.systemPrompt = SOURCE_PROPOSITION_SELECTION_PROMPT;
        await selected.transport.sourceAdapter.invoke(selected.configured.source, request, new AbortController().signal);
      }
    });
    assert.equal(selected.network(), 5);
    assert.deepEqual(selected.transport.summary().stages.map(row => row.stage), ['quality', 'structure-draft', 'structure-review', 'proposition-draft', 'proposition-review']);
    assert.ok(!selected.transport.summary().stopReason);
  });
  pass('explicit new graph/P selection prompts whitelist exact same five stages; no generic extraction prompt relaxation');

  const grounded = rig(); await using(grounded, async () => {
    await grounded.transport.withContext({ kind: 'source', id: 'source-grounded-parent-v3' }, async () => {
      for (let index = 0; index < 5; index++) {
        const request = sourceRequest(index);
        if (index === 1) request.systemPrompt = ARGUMENT_PROJECTION_SELECTION_PROMPT;
        if (index === 2) request.systemPrompt = ARGUMENT_PROJECTION_SOURCE_REVIEW_PROMPT;
        if (index === 3) request.systemPrompt = SOURCE_PROPOSITION_PARENT_SELECTION_PROMPT;
        await grounded.transport.sourceAdapter.invoke(grounded.configured.source, request, new AbortController().signal);
      }
    });
    assert.equal(grounded.network(), 5);
    assert.deepEqual(grounded.transport.summary().stages.map(row => row.stage), ['quality', 'structure-draft', 'structure-review', 'proposition-draft', 'proposition-review']);
    assert.ok(!grounded.transport.summary().stopReason);
  });
  pass('new independent source-grounded review and whole-parent selection are exact whitelisted prompts, still five once-only stages');

  const onlyProps = rig(); await using(onlyProps, async () => {
    await onlyProps.transport.withContext({ kind: 'source', id: 'already-structured' }, async () => { await onlyProps.source(3); await onlyProps.source(4); });
    assert.equal(onlyProps.network(), 2); assert.ok(!onlyProps.transport.summary().stopReason);
  });
  pass('already-reviewed structure can start only at proposition-draft and complete exactly 2 calls');

  const repeated = rig(); await using(repeated, async () => {
    await assert.rejects(repeated.transport.withContext({ kind: 'source', id: 'duplicate' }, async () => { await repeated.source(0); await repeated.source(0); }), /budget_or_stage/u);
    await hardStopped(repeated, 1);
  }); pass('duplicate stage is not a retry: refused before native dispatch and locks the complete transport');

  const reversed = rig(); await using(reversed, async () => {
    await assert.rejects(reversed.transport.withContext({ kind: 'answer', id: 'review-first' }, () => reversed.answer(true)), /budget_or_stage/u);
    await hardStopped(reversed, 0);
  }); pass('answer-review cannot precede literal extraction, zero actual network');

  for (const extra of [{ messages: [] }, { tools: [] }, { memory: {} }, { thinkingMode: 'enabled' }, { maxTokensOverride: 8192 }]) {
    const invalid = rig(); await using(invalid, async () => {
      await assert.rejects(invalid.transport.withContext({ kind: 'answer', id: 'invalid' }, () =>
        invalid.transport.answerCaller({ ...answerRequest(), ...extra } as LlmCallRequest)), /request_contract/u);
      await hardStopped(invalid, 0);
    });
  } pass('extra history/tools/memory, thinking and changed answer token budgets are rejected before dispatch');

  const wrongConfig = rig(); await using(wrongConfig, async () => {
    await assert.rejects(wrongConfig.transport.withContext({ kind: 'source', id: 'wrong-config' }, () =>
      wrongConfig.transport.sourceAdapter.invoke({ ...wrongConfig.configured.source, fingerprint: 'f'.repeat(64) }, sourceRequest(0), new AbortController().signal)), /request_contract/u);
    await hardStopped(wrongConfig, 0);
  }); pass('source invocation cannot substitute configuration after consent capture');

  const implicit = rig(); await using(implicit, async () => {
    await assert.rejects(fetch('https://api.deepseek.com/v1/chat/completions'), /implicit_network_forbidden/u);
    await hardStopped(implicit, 0);
  }); pass('ambient fetch outside an active unique production dispatch is forbidden');

  const nesting = rig(); await using(nesting, async () => {
    await nesting.transport.withContext({ kind: 'source', id: 'owner' }, async () => {
      await assert.rejects(nesting.transport.withContext({ kind: 'answer', id: 'other' }, () => nesting.answer()), /context_unavailable/u);
    }); assert.equal(nesting.network(), 0);
  }); pass('nested/concurrent contexts cannot acquire another active dispatch');

  const configChange = rig(); await using(configChange, async () => {
    configChange.configChanged(); await assert.rejects(configChange.transport.withContext({ kind: 'source', id: 'changed' }, () => configChange.source(0)), /configuration_changed/u);
    await hardStopped(configChange, 0);
  }); pass('private configuration change before request prevents dispatch and stops subsequent samples');

  const frozenChange = rig(); await using(frozenChange, async () => {
    frozenChange.codeChanged(); await assert.rejects(frozenChange.transport.withContext({ kind: 'answer', id: 'changed' }, () => frozenChange.answer()), /frozen_code_changed/u);
    await hardStopped(frozenChange, 0);
  }); pass('frozen code or dataset change prevents any new cloud attempt');

  let afterChange!: ReturnType<typeof rig>;
  afterChange = rig(async () => { afterChange.configChanged(); return reply(); }); await using(afterChange, async () => {
    await assert.rejects(afterChange.transport.withContext({ kind: 'answer', id: 'late-change' }, () => afterChange.answer()), /configuration_changed/u);
    await hardStopped(afterChange, 1); assert.equal(afterChange.transport.summary().stages[0].status, 'failed');
  }); pass('configuration recheck after HTTP response rejects late data without a second request');

  const http = rig(async () => new Response('private provider error body', { status: 503 })); await using(http, async () => {
    await assert.rejects(http.transport.withContext({ kind: 'source', id: 'http-error' }, () => http.source(0)), /provider_http_503/u);
    await hardStopped(http, 1); assert.ok(!JSON.stringify(http.transport.summary()).includes('private provider error body'));
  }); pass('HTTP failure is one actual attempt, emits only safe code and never retries another sample');

  const huge = rig(async () => new Response('x'.repeat(1024 * 1024 + 1))); await using(huge, async () => {
    await assert.rejects(huge.transport.withContext({ kind: 'answer', id: 'huge' }, () => huge.answer()), /response_budget/u);
    await hardStopped(huge, 1); assert.equal(huge.artifacts.size, 1);
  }); pass('provider body exceeding 1 MiB is bounded and no oversized response artifact is written');

  const invalidBody = rig(async () => new Response('not-provider-json')); await using(invalidBody, async () => {
    await assert.rejects(invalidBody.transport.withContext({ kind: 'answer', id: 'json' }, () => invalidBody.answer()), /transport_failure/u);
    await hardStopped(invalidBody, 1);
  }); pass('malformed HTTP envelope locks transport without attempting JSON content repair');

  let response = 0;
  const empty = rig(async () => ++response === 1 ? reply('') : reply()); await using(empty, async () => {
    await assert.rejects(empty.transport.withContext({ kind: 'source', id: 'empty-content' }, () => empty.source(0)), /model_response_invalid/u);
    assert.ok(!empty.transport.summary().stopReason);
    await empty.transport.withContext({ kind: 'answer', id: 'independent-next' }, () => empty.answer()); assert.equal(empty.network(), 2);
  }); pass('valid HTTP but invalid model content holds that sample; a different sample can continue without retry');

  response = 0;
  const truncated = rig(async () => ++response === 1 ? reply('{"synthetic":true}', 'length') : reply()); await using(truncated, async () => {
    await assert.rejects(truncated.transport.withContext({ kind: 'answer', id: 'truncated' }, () => truncated.answer()), /model_response_invalid/u);
    assert.ok(!truncated.transport.summary().stopReason);
    await truncated.transport.withContext({ kind: 'answer', id: 'independent' }, () => truncated.answer()); assert.equal(truncated.network(), 2);
    assert.equal((truncated.artifacts.get('response-answer-truncated-answer-extract.json') as any).finishReason, 'length');
  }); pass('truncated raw content is retained as observed, not repaired or a global network failure');

  const secretError = rig(async () => { throw new Error('synthetic-secret-not-for-artifacts real path private error'); }); await using(secretError, async () => {
    await assert.rejects(secretError.transport.withContext({ kind: 'answer', id: 'fetch-error' }, () => secretError.answer()), /^Error: reference_rag_acceptance_transport_failure$/u);
    await hardStopped(secretError, 1); assert.ok(!JSON.stringify(secretError.transport.summary()).includes('synthetic-secret'));
  }); pass('native fetch exception details and private paths/credentials are not returned or recorded');

  const cancelled = rig(); await using(cancelled, async () => {
    cancelled.controller.abort(); await assert.rejects(cancelled.transport.withContext({ kind: 'source', id: 'cancelled' }, () => cancelled.source(0)), /run_aborted/u);
    await hardStopped(cancelled, 0);
  }); pass('global cancellation before context produces zero network attempts');

  const upstream = new AbortController();
  const during = rig(async () => { upstream.abort(); return new Promise<Response>(() => {}); }); await using(during, async () => {
    await assert.rejects(during.transport.withContext({ kind: 'source', id: 'during' }, () => during.source(0, upstream.signal)), /request_aborted/u);
    await hardStopped(during, 1);
  }); pass('abort during a native promise that ignores its signal still terminates the transport wait');

  const timed = rig(async () => new Promise<Response>(() => {}));
  try {
    globalThis.setTimeout = ((handler: (...args: any[]) => void, milliseconds?: number, ...args: any[]) =>
      timerBefore(handler, milliseconds === 60000 ? 2 : milliseconds, ...args)) as typeof setTimeout;
    await using(timed, async () => {
      await assert.rejects(timed.transport.withContext({ kind: 'answer', id: 'timeout' }, () => timed.answer()), /request_timeout/u);
      await hardStopped(timed, 1);
    });
  } finally { globalThis.setTimeout = timerBefore; }
  pass('60-second per-request timer is signal-combined and terminates even an uncooperative native promise (accelerated clock)');

  const budget = rig(); await using(budget, async () => {
    for (let source = 0; source < 3; source++) await budget.transport.withContext({ kind: 'source', id: `source-${source}` }, async () => {
      for (let index = 0; index < 5; index++) await budget.source(index);
    });
    for (let answer = 0; answer < 8; answer++) await budget.transport.withContext({ kind: 'answer', id: `answer-${answer}` }, async () => {
      await budget.answer(); await budget.answer(true);
    });
    assert.equal(budget.network(), 31); await assert.rejects(budget.transport.withContext({ kind: 'source', id: 'extra' }, () => budget.source(0)), /budget_or_stage/u);
    await hardStopped(budget, 31);
  }); pass('3 sources ×5 plus 8 answers ×2 exhaust 31; attempt32 fails before native fetch despite broader user approval');

  const singleton = rig(); await using(singleton, async () => {
    assert.throws(() => createReferenceRagAcceptanceTransport(models(), { signal: new AbortController().signal,
      assertFrozen: async () => {}, save: async () => {} }), /already_installed/u);
  }); singleton.transport.restore();
  const renewed = rig(); await using(renewed, async () => assert.equal(renewed.network(), 0));
  pass('only one installed global transport; restore is idempotent and allows an independent subsequent run');

  const leaked = rig(); await using(leaked, async () => {
    await assert.rejects(leaked.transport.withContext({ kind: 'answer', id: 'secret-input' }, () =>
      leaked.transport.answerCaller({ ...answerRequest(), userInput: JSON.stringify({ forbidden: leaked.configured.answer.provider.apiKey }) })), /private_content_forbidden/u);
    await hardStopped(leaked, 0); assert.equal(leaked.artifacts.size, 0);
  }); pass('credential string cannot enter prompts/body or saved request artifacts, even before native dispatch');

  const replaced = rig(); await using(replaced, async () => {
    globalThis.fetch = async () => assert.fail('Replaced ambient fetch must not be used by production proxy');
    await assert.rejects(replaced.transport.withContext({ kind: 'answer', id: 'tampered-fetch' }, () => replaced.answer()), /transport_replaced/u);
    await hardStopped(replaced, 0);
  }); pass('replacement of the global fetch capture is detected before proxy invocation, not after an uncounted request');

  let entered!: () => void; const hasEntered = new Promise<void>(resolve => { entered = resolve; });
  const restoring = rig(async () => { entered(); return new Promise<Response>(() => {}); });
  const waiting = restoring.transport.withContext({ kind: 'answer', id: 'restoring' }, () => restoring.answer());
  await hasEntered; restoring.transport.restore(); await assert.rejects(waiting, /run_aborted|run_stopped/u);
  assert.equal(restoring.network(), 1); assert.equal(restoring.transport.summary().stages[0].status, 'failed');
  pass('restore also aborts an in-flight wait, so teardown cannot leave a production request lease usable');

  console.log(`\n${checks} reference RAG acceptance transport groups passed; real settings reads 0; cloud calls 0; production writes 0.`);
} finally { globalThis.fetch = fetchBefore; globalThis.setTimeout = timerBefore; }

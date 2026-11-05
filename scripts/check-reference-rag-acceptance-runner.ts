import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runReferenceRagAcceptance, selectReferenceRagAcceptanceMode, describeReferenceRagAcceptanceFailure } from './run-reference-rag-acceptance.ts';

let groups = 0;
assert.deepEqual(selectReferenceRagAcceptanceMode([]), { execute: false, local: false, maxRequests: 31 });
assert.equal(selectReferenceRagAcceptanceMode(['--local']).local, true);
assert.equal(selectReferenceRagAcceptanceMode(['--execute', '--allow-cloud']).execute, true); groups++;
assert.deepEqual(selectReferenceRagAcceptanceMode(['--execute', '--allow-cloud', '--sources-only']),
  { execute: true, local: false, maxRequests: 15, sourcesOnly: true });
for (const flags of [['--execute'], ['--allow-cloud'], ['--execute', '--allow-cloud', '--local'], ['--local', '--local'], ['--retry'],
  ['--sources-only'], ['--local', '--sources-only']]) {
  assert.throws(() => selectReferenceRagAcceptanceMode(flags), /acceptance_invalid_flags/u);
} groups++;
assert.deepEqual(describeReferenceRagAcceptanceFailure(new Error('acceptance_rubric_not_fixed'), { phase: 'question', id: 'VD01' }),
  { code: 'acceptance_rubric_not_fixed', phase: 'question', id: 'VD01' });
const privateFailure = describeReferenceRagAcceptanceFailure(new Error('secret-key /private/path'), { phase: 'source' });
assert.deepEqual(privateFailure, { code: 'acceptance_harness_stopped', phase: 'source' }); groups++;
const source = await fs.readFile('scripts/run-reference-rag-acceptance.ts', 'utf8');
assert.ok(!source.includes('buildAcceptanceReferenceProjection') && !source.includes('buildAcceptanceSourcePropositionReview'));
assert.ok(source.includes("{ flag: 'wx' }") && source.includes('prepareStoredReferencePropositions'));
assert.ok(source.includes('createFrozenPropositionReferenceModel(transport.answerCaller)')); groups++;
assert.ok(source.includes('if (!transport || mode.sourcesOnly)'));
assert.ok(source.includes("summary.stages.every(stage => stage.kind === 'source')"));
assert.ok(source.includes('diagnostics: diagnostics.slice(beforeDiagnostic)')); groups++;
const directory = 'data/reference-rag-acceptance-experiments';
const entries = async () => fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return []; throw error;
});
const before = await entries(), logged: string[] = [], originalLog = console.log, originalFetch = globalThis.fetch;
let network = 0;
console.log = value => logged.push(String(value));
globalThis.fetch = async () => { network++; throw new Error('no_network_in_offline_check'); };
try { await runReferenceRagAcceptance([]); }
finally { console.log = originalLog; globalThis.fetch = originalFetch; }
assert.equal(network, 0); assert.deepEqual(await entries(), before);
assert.equal(logged.length, 1); const preflight = JSON.parse(logged[0]);
assert.equal(preflight.event, 'preflight'); assert.equal(preflight.cases, 8); assert.equal(preflight.sources, 3);
assert.equal(preflight.totalRequests, 31); assert.equal(preflight.automaticRetries, 0);
assert.equal(preflight.productionModified, false); assert.equal(preflight.scoreWrite, 'disabled'); assert.equal(preflight.cognitionWrite, 'disabled');
groups++;
assert.deepEqual(preflight.sourceProtocols, { structureDraft: 'argument-projection-selection-v2',
  propositionDraft: 'review-source-proposition-parent-selection-v3', structureReview: 'argument-projection-task-review-v3',
  propositionReview: 'review-task-source-proposition-review-v2' });
assert.ok(source.includes("reviewProtocol: 'task-grounded-v3'"));
assert.ok(source.includes("propositionDraftProtocol: 'owned-parent-choice-v3'"));
groups++;
console.log(`reference-rag-acceptance-runner: ${groups} offline groups passed (0 model requests).`);

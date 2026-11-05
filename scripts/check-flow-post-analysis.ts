/** Post-analysis integration: synthetic files only, no LLM, no real profile/note mutations. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getDefaultUserProfile } from '../src/services/profile/profileStore';
import { applyProfileEvidenceGate, partitionFlowProfileEvidence } from '../src/services/profile/evidenceGateCore';
import { latestFlowProfileObservation, buildProfileEvidenceDetails } from '../src/services/profile/evidenceModel';
import { readCurrentProfile } from '../src/services/profile/currentRead';
import { selectProfileStyle } from '../src/services/profile/overviewModel';
import { savedFlowReviewGraphs, retrieveFlowReviewGraphs, readSavedFlowGraphs } from '../src/services/cognition/flowReviewMaterials';
import { createFlowReviewArgumentIndex } from '../src/electron/rag/flowReviewArgumentIndex';
import { readFlowReviewIndexStatus } from '../src/services/cognition/flowReviewStatus';
import { readCognitionMaterials } from '../src/services/cognition/materials';
import { createFlowResultPreview } from './fixtures/flow-result-v2-preview';
import type { NoteItem, StyleSnapshotFile } from '../src/types';
import type { ProfileSignal } from '../src/services/memory/types';

const priorFetch = globalThis.fetch, priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
globalThis.fetch = async () => assert.fail('No network in post-analysis checks');
try {
  const version = 'flow-evidence-rubric-v4-temporal-profile';
  const profile = getDefaultUserProfile();
  const old = { episodeId: 'old', value: 7, weight: .7, observedAt: '2026-10-01T08:00:00Z', rubricVersion: 'review-analysis-v1' };
  const recent = { episodeId: 'new', value: 66.7, weight: .7, observedAt: '2026-10-16T08:00:00Z', rubricVersion: version };
  profile.evidenceGate = { version: 1, processedEpisodeIds: ['old', 'new'], aggregates: {
    'ability:judgmentReasonableness': { dimension: 'ability', indicator: 'judgmentReasonableness', status: 'holding',
      mean: 35, confidence: .7, samples: [old, recent], updatedAt: recent.observedAt },
  } };
  const original = structuredClone(profile), partitioned = partitionFlowProfileEvidence(profile);
  const key = `ability:judgmentReasonableness:${version}`;
  assert.deepEqual(partitioned.evidenceGate!.aggregates[key].samples, [recent]);
  assert.deepEqual(partitioned.evidenceGate!.aggregates['ability:judgmentReasonableness'].samples, [old]);
  assert.equal(partitioned.evidenceGate!.aggregates[key].mean, 66.7);
  assert.deepEqual(partitionFlowProfileEvidence(partitioned), partitioned, 'Partition is idempotent and keeps each source sample once');
  assert.deepEqual(profile, original, 'Reading does not rewrite source profile or scores');
  const signal = (episodeId: string, value: number, dimension: ProfileSignal['dimension'] = 'ability', indicator = 'judgmentReasonableness'): ProfileSignal => ({
    sourceEpisodeId: episodeId, dimension, indicator, value, confidence: .82, evidenceType: 'scored',
    observedAt: '2026-10-17T08:00:00Z', evidenceSnippetIds: ['proof'], matchedCriteria: ['criterion'], rubricVersion: version,
  });
  const next = applyProfileEvidenceGate(partitioned, { episodeId: 'next', signals: [signal('next', 5)], sampleChars: 265 });
  assert.equal(next.profile.evidenceGate!.aggregates[key].status, 'trusted', 'Real ability change is smoothed, not frozen for a large range');
  assert.ok(Math.abs(next.profile.ability.judgmentReasonableness - partitioned.ability.judgmentReasonableness) <= 6);
  assert.equal(applyProfileEvidenceGate(next.profile, { episodeId: 'next', signals: [signal('next', 5)], sampleChars: 265 }).duplicate, true);
  assert.equal(next.profile.evidenceGate!.aggregates['ability:judgmentReasonableness'].samples.length, 1);

  const styles = ['academic', 'critical', 'practical', 'divergent', 'objective'];
  const styleProfile = applyProfileEvidenceGate(partitioned, { episodeId: 'style-1', sampleChars: 265,
    signals: styles.map(style => signal('style-1', 20, 'expression_style', style)) }).profile;
  const legacySnapshot = { calculatedAt: '2026-10-05T08:00:00Z', display: Object.fromEntries(styles.map(k => [k, 99])), conclusion: '旧九类' } as StyleSnapshotFile;
  assert.equal(selectProfileStyle(legacySnapshot, null, 'current', '2026-10-17', styleProfile), null, 'Old snapshot must not masquerade as new current style');
  assert.equal(latestFlowProfileObservation(styleProfile)!.holding, 5);
  const all = Object.values(styleProfile.evidenceGate!.aggregates).filter(a => a.dimension === 'expression_style');
  all.forEach(a => { a.status = 'trusted'; }); // Explicit fixture; model/real gates are not bypassed in production.
  assert.equal(selectProfileStyle(legacySnapshot, null, 'current', '2026-10-17', styleProfile)!.display.academic, 20);
  const episode: any = { id: 'style-1', type: 'flow', title: '最新复盘', evidenceSnippets: [{ id: 'proof', text: '原话' }] };
  assert.ok(buildProfileEvidenceDetails(styleProfile, [episode]).some(a => a.samples.some(s => s.episodeTitle === '最新复盘')));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { isElectron: true, userState: {
    async loadProfile(strict: boolean) { assert.equal(strict, true); return { profile: styleProfile }; },
  } } } });
  assert.equal((await readCurrentProfile()).evidenceGate!.aggregates[key].mean, 66.7, 'Fresh read bypasses old renderer cache');
  (window as any).electronAPI.userState.loadProfile = async () => { throw new Error('denied'); };
  await assert.rejects(readCurrentProfile(), /denied/u, 'No stale fallback after desktop error');
  assert.equal(await readFlowReviewIndexStatus('saved-note'), null, 'Older bridge cannot claim the graph is indexed');
  (window as any).electronAPI.noteRag = { flowReviewStatus: async () => ({
    graphCount: 1, nodeCount: 2, graphIds: ['graph'], vectorStatus: 'ready', processing: false,
  }) };
  assert.equal((await readFlowReviewIndexStatus('saved-note'))!.graphIds[0], 'graph');
  (window as any).electronAPI.noteRag.flowReviewStatus = async () => ({
    graphCount: -1, nodeCount: 2, graphIds: [], vectorStatus: 'ready', processing: false,
  });
  await assert.rejects(readFlowReviewIndexStatus('saved-note'), /状态无效/u);

  const preview = createFlowResultPreview(), doc = structuredClone(preview.bundle.argumentDoc);
  doc.nodes = doc.nodes.slice(0, 2).map((n, i) => ({ ...n, id: `T${i}`, role: i ? 'premise' : 'claim',
    text: i ? '对照实验观察支持可靠性。' : '提示词框架需要可靠性。' }));
  doc.edges = [{ id: 'TE', source: 'T1', target: 'T0', relation: 'support' }];
  doc.rag = undefined; // No publication/quality certificate, still eligible as PRIVATE material.
  const note = { id: 'saved-note', title: '合成项目', noteType: 'project', content: '', argumentDocs: [doc],
    learningReviewRecords: [{ schemaVersion: 1, projectNoteId: 'saved-note', sessionId: 'saved-session', argumentDocIds: [doc.doc_id] }],
  } as unknown as NoteItem;
  const inputBefore = JSON.stringify(note);
  const graphs = savedFlowReviewGraphs(note);
  assert.equal(graphs.length, 1);
  assert.equal(savedFlowReviewGraphs({ ...note, learningReviewRecords: [] }).length, 0, 'Unsaved/unbound graphs cannot enter the private derivative');
  assert.equal(savedFlowReviewGraphs({ ...note, id: 'other-note' }).length, 0);
  const hits = retrieveFlowReviewGraphs(graphs, '可靠性');
  assert.ok(hits.length && hits[0].relationSummary!.includes('T1 -support-> T0'));
  assert.equal(hits[0].sourceKind, 'flow-review-argument');
  assert.equal(hits[0].usableAsFactEvidence, false);
  assert.equal(readCognitionMaterials(hits)[0].sourceKind, 'flow-review-argument');
  assert.throws(() => readSavedFlowGraphs([{ ...graphs[0], usableAsFactEvidence: true }]));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-flow-post-'));
  let embedded = 0;
  const index = createFlowReviewArgumentIndex(temporary, async texts => { embedded += texts.length; return texts.map(() => Array(384).fill(.05)); });
  await index.syncNotes([note]);
  assert.deepEqual(await index.status(), { graphCount: 1, nodeCount: 2, graphIds: [doc.doc_id], vectorStatus: 'ready', processing: false });
  assert.ok((await index.search('可靠性')).length);
  await index.syncNotes([note]);
  assert.equal(embedded, 2, 'Ordinary saves/startup do not re-vectorize unchanged graph');
  const reopened = createFlowReviewArgumentIndex(temporary, async () => assert.fail('Restart must use current persisted derivative'));
  await reopened.syncNotes([note]); assert.ok((await reopened.search('可靠性')).length);
  const edited = structuredClone(note); edited.argumentDocs![0].nodes[0].text = '提示词框架需要稳定性。';
  await index.syncNotes([edited]); assert.equal(embedded, 3, 'Only changed node text is re-vectorized');
  await index.syncNotes([{ ...edited, argumentDocs: [], learningReviewRecords: [] }]);
  assert.equal((await index.search('可靠性')).length, 0, 'Deletion removes old searchable graph without changing the original note');
  const fallback = createFlowReviewArgumentIndex(await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-flow-fallback-')), async () => { throw new Error('model_unavailable'); });
  await fallback.syncNotes([note]); assert.equal((await fallback.status()).vectorStatus, 'unavailable');
  assert.ok((await fallback.search('可靠性')).length, 'Embedding failure preserves lexical graph retrieval, no cloud fallback');
  let finishEmbedding!: (value: number[][]) => void;
  const running = createFlowReviewArgumentIndex(await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-flow-running-')),
    () => new Promise(resolve => { finishEmbedding = resolve; }));
  const saving = running.syncNotes([note]);
  assert.equal((await running.status()).processing, true, 'Background work is visible without waiting for embedding');
  while (!finishEmbedding) await new Promise(resolve => setTimeout(resolve, 1));
  finishEmbedding([Array(384).fill(.05), Array(384).fill(.05)]);
  await saving;
  assert.equal((await running.status()).processing, false);
  assert.equal((await running.status('unrelated-note')).graphCount, 0);
  assert.equal(JSON.stringify(note), inputBefore);

  if (process.argv.includes('--read-current')) {
    const anchor = JSON.parse(await fs.readFile(path.join(os.homedir(), '.logi-note', 'storage-config.json'), 'utf8'));
    const root = anchor.dataRoot;
    const profileText = await fs.readFile(path.join(root, 'user-state/profile.json'), 'utf8');
    const current = JSON.parse(profileText).profile;
    const observed = latestFlowProfileObservation(current)!;
    assert.ok(observed.rows.length > 0);
    const meta = JSON.parse(await fs.readFile(path.join(root, 'vault/metadata.json'), 'utf8')).notesMeta;
    const state = JSON.parse(await fs.readFile(path.join(root, 'user-state/user-state.json'), 'utf8')).noteStates;
    const notes = Object.entries(meta).map(([id, n]) => ({ ...n as NoteItem, ...state[id], id }));
    const actualGraphs = notes.flatMap(savedFlowReviewGraphs);
    assert.ok(actualGraphs.length > 0);
    assert.equal(await fs.readFile(path.join(root, 'user-state/profile.json'), 'utf8'), profileText);
    console.log(JSON.stringify({ currentDataReadOnly: true, latestObservationRows: observed.rows.length,
      observedNotAutoTrusted: observed.holding, savedReviewGraphCount: actualGraphs.length,
      nodeCounts: actualGraphs.map(g => g.nodes.length), productionIndexWritten: false }));
  }
  console.log('PASS: rubric partition/idempotence, genuine ability change, fresh strict profile reads, current style source, visible pending evidence; saved graph only, role/direction preservation, private/nonfactual channel, persisted/restart search, incremental vectors, deletion and offline fallback. Zero LLM calls or production writes.');
} finally {
  globalThis.fetch = priorFetch;
  if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else Reflect.deleteProperty(globalThis, 'window');
}

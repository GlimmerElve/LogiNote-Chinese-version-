import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFlowShadowFixture } from '../src/services/flowShadow/demo';
import { buildShadowReferencePacket, buildShadowReferenceTargets } from '../src/services/flowShadow/references';
import { projectShadowReferencePacket, groupReferenceRetrievalTargets, SHARED_REFERENCE_TRANSPORT, restoreShadowReferenceIds } from '../src/services/flowShadow/referenceTransport';
import { prepareShadowAssessment, replayShadowResponses, runFlowShadow } from '../src/services/flowShadow/runner';
import { parseShadowAssessment, shadowFingerprint } from '../src/services/flowShadow/protocol';
import { scoreShadowReferenceAssessment } from '../src/services/flowShadow/referenceScoring';
import { scoreShadowAssessment } from '../src/services/flowShadow/scoring';
import { adaptShadowRecordToFlowV2 } from '../src/services/flowAnalysis/productionV2';
import { extractFlowEvidence } from '../src/services/memory/evidenceExtractor';
import type { ShadowReferenceCandidate, ShadowRecord } from '../src/services/flowShadow/types';

const priorFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Reference transport tests/replays must not send network requests');
try {
  const fixture = createFlowShadowFixture(), targets = buildShadowReferenceTargets(fixture.graph);
  const candidates: ShadowReferenceCandidate[] = targets.map((target, index) => ({ ...fixture.referenceCandidates[0],
    id: `ORIGINAL-${index}`, targetId: target.id, relation: target.layer === 'concept' ? 'definition' : target.layer === 'judgment' ? 'claim' : 'premise',
    text: '合成完整规则：只有同时有蓝印且系统联网，才进入二号通道；离线时不能这样推断。',
  }));
  const packet = buildShadowReferencePacket(fixture.input, fixture.graph, candidates);
  const frozen = JSON.stringify({ packet, graph: fixture.graph, input: fixture.input });
  const projection = projectShadowReferencePacket(packet);
  assert.equal(projection.packet.items.length, 1, 'Only one copy of identical source text');
  assert.equal(projection.packet.targets.length, packet.targets.length, 'Evaluation denominator/coverage unchanged');
  assert.deepEqual(projection.packet.targets.map(t => [t.id, t.layer, t.nodeIds]), packet.targets.map(t => [t.id, t.layer, t.nodeIds]));
  assert.equal(projection.packet.items[0].text, packet.items[0].text, 'No truncation/normalization');
  assert.deepEqual(projection.packet.selection.map(s => s.primaryTier), packet.selection.map(s => s.primaryTier));
  assert.equal(projection.packet.selection.length, packet.selection.length);
  assert.ok(projection.packet.selection.every(s => s.itemIds[0] === projection.packet.items[0].id));
  assert.equal(new Set(projection.packet.selection.map(s => s.uses[0].relation)).size, 3, 'Keep target-specific source-use labels');
  assert.ok(groupReferenceRetrievalTargets(targets).length < targets.length, 'Identical claim/empty-argument queries share retrieval input');
  assert.equal(groupReferenceRetrievalTargets([...targets, { ...targets[0], id: 'different', query: targets[0].query + '不同条件' }]).length,
    groupReferenceRetrievalTargets(targets).length + 1, 'No approximate merging of different conditions');

  const assessment = structuredClone(fixture.assessment);
  assessment.referenceComparisons.forEach(c => { c.referenceIds = packet.selection.find(s => s.targetId === c.targetId)!.itemIds; });
  const root = { ...fixture.assessResponse, referenceKey: shadowFingerprint(packet), assessment };
  const pooled = structuredClone(root);
  pooled.assessment.referenceComparisons.forEach(c => { c.referenceIds = [...new Set(c.referenceIds.map(id => projection.itemToAlias.get(id)!))]; });
  const parsed = parseShadowAssessment(pooled, fixture.input, fixture.graph, packet, { referenceTransport: SHARED_REFERENCE_TRANSPORT });
  assert.deepEqual(parsed.assessment, parseShadowAssessment(root, fixture.input, fixture.graph, packet).assessment);
  assert.deepEqual(scoreShadowReferenceAssessment(fixture.input, fixture.graph, packet, parsed.assessment),
    scoreShadowReferenceAssessment(fixture.input, fixture.graph, packet, assessment));
  assert.deepEqual(scoreShadowAssessment(fixture.input, fixture.graph, parsed.assessment), scoreShadowAssessment(fixture.input, fixture.graph, assessment));
  const historical = parseShadowAssessment(pooled, fixture.input, fixture.graph, packet);
  assert.ok(scoreShadowReferenceAssessment(fixture.input, fixture.graph, packet, historical.assessment).warnings.length > 0,
    'Historical unknown alias must not silently become accepted without opt-in');
  assert.deepEqual(restoreShadowReferenceIds(targets[0].id, ['not-known'], packet), ['not-known']);

  const distinctCandidates = [
    ...candidates,
    ...['sourceId', 'sourceType', 'locator', 'tier', 'text'].map((field, i) => ({ ...candidates[0], id: `DISTINCT-${i}`,
      ...(field === 'sourceId' ? { sourceId: 'another-document' } : field === 'sourceType' ? { sourceType: 'project_resource' as const }
        : field === 'locator' ? { locator: 'another-location' } : field === 'tier' ? { tier: 3 as const }
          : { text: candidates[0].text + ' ' }) })),
  ];
  const distinct = { ...packet, items: distinctCandidates };
  assert.equal(projectShadowReferencePacket(distinct).packet.items.length, 6, 'Different provenance/tier/exact characters are not pooled');
  const collision = { ...packet, items: packet.items.map((item, i) => i ? item : { ...item, id: 'D1' }) };
  assert.ok(projectShadowReferencePacket(collision).packet.items.every(item => item.id !== 'D1'), 'Shared IDs cannot collide with legacy IDs');

  const scopedCandidates = candidates.map((candidate, index) => index ? { ...candidate, sourceId: 'second-source' } : candidate);
  const scoped = buildShadowReferencePacket(fixture.input, fixture.graph, scopedCandidates);
  const firstAlias = projectShadowReferencePacket(scoped).itemToAlias.get(scoped.items[0].id)!;
  const crossTarget = structuredClone(root); crossTarget.referenceKey = shadowFingerprint(scoped);
  crossTarget.assessment.referenceComparisons[1].referenceIds = [firstAlias];
  const rejected = parseShadowAssessment(crossTarget, fixture.input, fixture.graph, scoped, { referenceTransport: SHARED_REFERENCE_TRANSPORT });
  assert.ok(scoreShadowReferenceAssessment(fixture.input, fixture.graph, scoped, rejected.assessment).warnings.some(w => w.target === crossTarget.assessment.referenceComparisons[1].id));
  const withLow = { ...packet, items: [...packet.items, { ...packet.items[0], id: 'LOW', tier: 3 as const, sourceType: 'linked_knowledge' as const }] };
  const lowAlias = projectShadowReferencePacket(withLow).itemToAlias.get('LOW')!;
  assert.deepEqual(restoreShadowReferenceIds(targets[0].id, [lowAlias], withLow), [lowAlias], 'Unselected/lower-tier aliases cannot gain authority');

  const legacyRequest = prepareShadowAssessment(fixture.input, fixture.graph, packet);
  const sharedRequest = prepareShadowAssessment(fixture.input, fixture.graph, packet, { referenceTransport: SHARED_REFERENCE_TRANSPORT });
  assert.equal(sharedRequest.systemPrompt, legacyRequest.systemPrompt);
  assert.equal(sharedRequest.promptId, legacyRequest.promptId);
  const legacyInput = JSON.parse(legacyRequest.userInput), sharedInput = JSON.parse(sharedRequest.userInput);
  for (const key of Object.keys(legacyInput).filter(k => k !== 'referencePacket')) assert.deepEqual(sharedInput[key], legacyInput[key]);
  assert.ok(sharedRequest.userInput.length < legacyRequest.userInput.length);
  assert.equal(JSON.stringify({ packet, graph: fixture.graph, input: fixture.input }), frozen);

  let calls = 0;
  const outcome = await runFlowShadow(fixture.input, { call: async request => {
    calls++;
    if (request.stage === 'extract') return { content: JSON.stringify(fixture.extractResponse) };
    assert.equal(request.referenceTransport, SHARED_REFERENCE_TRANSPORT);
    const payload = JSON.parse(request.userInput);
    assert.equal(payload.referencePacket.items.length, 1);
    return { content: JSON.stringify(pooled) };
  } }, { referenceProvider: { retrieve: async () => candidates } });
  assert.equal(outcome.status, 'reviewed', outcome.error);
  assert.equal(calls, 2);
  assert.deepEqual(outcome.record!.references, packet, 'Saved record still stores full original reference packet');
  assert.deepEqual(outcome.record!.assessment.referenceComparisons, assessment.referenceComparisons, 'Restore original per-target IDs before saving/scoring');
  console.log('PASS: shared source pool; exact provenance/conditions; legacy opt-in; target/layer/priority/score invariance; cross-target and low-priority rejection; two-stage mock workflow. No cloud calls or production writes.');

  // Read-only replay of real saved high/low results, never rewriting historical artifacts.
  if (process.argv.includes('--replay-saved')) {
    for (const directory of ['cloud-PW1ZnA', 'cloud-KrxsEX']) {
      const record = JSON.parse(await readFile(`.ui-preview/flow-acceptance/${directory}/bundle.json`, 'utf8')).analysisV2.record as ShadowRecord;
      const original = JSON.stringify(record), transport = projectShadowReferencePacket(record.references);
      const response = { protocol: record.protocol, inputKey: shadowFingerprint(record.input), graphKey: shadowFingerprint(record.graph),
        referenceKey: shadowFingerprint(record.references), assessment: structuredClone(record.assessment) };
      response.assessment.referenceComparisons.forEach(c => {
        c.referenceIds = [...new Set(c.referenceIds.map(id => transport.itemToAlias.get(id) || id))];
      });
      const parsed = parseShadowAssessment(response, record.input, record.graph, record.references, { referenceTransport: SHARED_REFERENCE_TRANSPORT });
      const replayed = { ...record, assessment: parsed.assessment };
      assert.deepEqual(scoreShadowAssessment(record.input, record.graph, parsed.assessment), scoreShadowAssessment(record.input, record.graph, record.assessment));
      assert.deepEqual(scoreShadowReferenceAssessment(record.input, record.graph, record.references, parsed.assessment), scoreShadowReferenceAssessment(record.input, record.graph, record.references, record.assessment));
      const before = adaptShadowRecordToFlowV2(record, 'fixed'), after = adaptShadowRecordToFlowV2(replayed, 'fixed');
      assert.deepEqual(after.argumentDoc, before.argumentDoc);
      assert.deepEqual(after.report, before.report);
      const signals = (b: typeof before) => extractFlowEvidence({ episodeId: b.analysisV2.analysisRunId, observedAt: b.analysisV2.observedAt,
        report: b.report, profileInsight: b.profileInsight, analysisV2: b.analysisV2 }).profileSignals;
      assert.deepEqual(signals(after), signals(before));
      assert.equal(JSON.stringify(record), original);
      const oldRequest = prepareShadowAssessment(record.input, record.graph, record.references);
      const newRequest = prepareShadowAssessment(record.input, record.graph, record.references, { referenceTransport: SHARED_REFERENCE_TRANSPORT });
      const bytes = (value: unknown) => JSON.stringify(value).length;
      console.log(JSON.stringify({ directory, originalSources: record.references.items.length, sharedSources: transport.packet.items.length,
        originalTargets: record.references.targets.length, retainedTargets: transport.packet.targets.length,
        uniqueRetrievalQueries: groupReferenceRetrievalTargets(record.references.targets).length,
        packetCharacters: [bytes(record.references), bytes(transport.packet)], requestCharacters: [oldRequest.userInput.length, newRequest.userInput.length],
        referenceTextCharacters: [record.references.items.reduce((n, i) => n + i.text.length, 0), transport.packet.items.reduce((n, i) => n + i.text.length, 0)],
        graphAndScoresUnchanged: true, cloudCalls: 0, tokenSavings: 'not_measured', semanticAccuracy: 'not_retested' }));
    }
  }
} finally { globalThis.fetch = priorFetch; }

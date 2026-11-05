import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createFlowShadowFixture } from '../src/services/flowShadow/demo';
import { parseShadowGraph, shadowFingerprint } from '../src/services/flowShadow/protocol';
import { runFlowShadow } from '../src/services/flowShadow/runner';
import { FLOW_SHADOW_EXTRACTION_PROMPT, FLOW_SHADOW_ASSESSMENT_PROMPT, SHADOW_EXTRACTION_PROMPT_ID, SHADOW_ASSESSMENT_PROMPT_ID } from '../src/services/flowShadow/prompts';
import { FLOW_SHADOW_EXTRACTION_PROMPT_V41 } from '../src/services/flowShadow/promptsV41';
import { FLOW_SHADOW_ASSESSMENT_PROMPT_V41 } from '../src/services/flowShadow/promptsAssessmentV41';

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Regression must not use the network');
try {
  const fixture = createFlowShadowFixture();
  const edge = (kind = 'oppose', from: unknown = 'N6', to: unknown = 'N2') => ({ id: 'R-misplaced', kind, from, to, reason: '合成字段错位样例，不测试语义正确性。' });
  const graphWith = (...edges: unknown[]) => ({ ...structuredClone(fixture.graph), relations: [...structuredClone(fixture.graph.relations), ...edges] });
  const original = graphWith(edge());
  const snapshot = structuredClone(original);
  const repaired = parseShadowGraph(original, fixture.input);
  assert.deepEqual(original, snapshot, 'Do not mutate model reply');
  assert.deepEqual(repaired.graph.arguments.find(a => a.claim === 'N2')?.oppose, ['N6']);
  assert.equal(repaired.graph.arguments.find(a => a.claim === 'N2')?.status, 'stated_only');
  assert.deepEqual(repaired.graph.nodes, fixture.graph.nodes);
  assert.deepEqual(repaired.graph.relations, fixture.graph.relations);
  assert.ok(repaired.warnings.some(w => w.code === 'graph_relation_placement_repaired' && w.message.includes(JSON.stringify(edge()))));
  assert.deepEqual(parseShadowGraph(repaired.graph, fixture.input).graph, repaired.graph, 'Normalized graph reparses idempotently');

  const duplicate = graphWith(edge(), { ...edge(), id: 'R-duplicate' });
  assert.deepEqual(parseShadowGraph(duplicate, fixture.input).graph.arguments[0].oppose, ['N6']);
  const existing = graphWith(edge('support', 'N4', 'N6'));
  assert.deepEqual(parseShadowGraph(existing, fixture.input).graph.arguments[1].support, fixture.graph.arguments[1].support);
  const movedSupport = parseShadowGraph(graphWith(edge('support', 'N4', 'N2')), fixture.input);
  assert.deepEqual(movedSupport.graph.arguments[0].support, ['N4']);
  assert.equal(movedSupport.graph.arguments[0].status, 'stated_only', 'Local repair cannot judge sufficiency or silently rewrite status');
  assert.ok(movedSupport.warnings.some(w => w.code === 'graph_status_mismatch'));

  const blocked = [
    graphWith(edge('oppose', 'N3', 'N2')), // method cannot be argument evidence
    graphWith(edge('support', 'N1', 'N2')), // background cannot be argument evidence
    graphWith(edge('oppose', 'N6', 'N4')), // target is premise
    graphWith(edge('oppose', 'N2', 'N2')),
    graphWith(edge('oppose', 'missing', 'N2')),
    graphWith(edge('oppose', 'N6', 'missing')),
    graphWith(edge('oppose', null, 'N2')),
    graphWith(edge('oppose', 'N6', '')),
    graphWith(edge('oppose', 'N4', 'N6')), // native support conflicts
    { ...graphWith(edge()), arguments: fixture.graph.arguments.filter(a => a.claim !== 'N2') },
    { ...graphWith(edge()), arguments: [...fixture.graph.arguments, { ...fixture.graph.arguments[0], id: 'A-duplicate-claim' }] },
  ];
  for (const candidate of blocked) {
    const before = structuredClone(candidate);
    const result = parseShadowGraph(candidate, fixture.input);
    assert.deepEqual(candidate, before);
    assert.deepEqual(result.graph.nodes, fixture.graph.nodes);
    assert.deepEqual(result.graph.arguments, candidate.arguments, 'Do not guess, create argument or overwrite native direction');
    assert.deepEqual(result.graph.relations, fixture.graph.relations);
    assert.ok(result.warnings.some(w => w.code === 'graph_relation_placement_unresolved'));
    assert.ok(result.graph.unresolved.length > 0);
    assert.deepEqual(parseShadowGraph(result.graph, fixture.input).graph, result.graph);
  }
  for (const edges of [[edge('support'), edge('oppose')], [edge('oppose'), edge('support')]]) {
    const result = parseShadowGraph(graphWith(...edges), fixture.input);
    assert.deepEqual(result.graph.arguments, fixture.graph.arguments, 'Conflicting misplaced edges: do not select whichever appeared first');
    assert.equal(result.warnings.filter(w => w.code === 'graph_relation_placement_unresolved').length, 2);
  }
  const fullPending = graphWith(edge('oppose', 'missing', 'N2'));
  fullPending.unresolved = Array.from({ length: 100 }, () => ({ nodeId: 'N2', reason: '已有待核对' }));
  const capped = parseShadowGraph(fullPending, fixture.input);
  assert.equal(capped.graph.unresolved.length, 100);
  assert.ok(capped.warnings.some(w => w.code === 'graph_relation_placement_unresolved'));
  assert.deepEqual(parseShadowGraph(capped.graph, fixture.input).graph, capped.graph);
  assert.throws(() => parseShadowGraph(graphWith(edge('attack')), fixture.input), /关系种类/);
  assert.throws(() => parseShadowGraph(graphWith(edge('unknown')), fixture.input), /关系种类/);

  // Optional local artifact replay; ordinary regression does not depend on a developer's ignored files.
  const artifactFlag = process.argv.indexOf('--saved-extract-dir');
  if (artifactFlag >= 0) {
    const dir = process.argv[artifactFlag + 1];
    assert.ok(dir, 'Specify a saved extraction directory');
    const saved = JSON.parse(readFileSync(join(dir, 'response-extract.json'), 'utf8'));
    const savedBody = JSON.parse(saved.content);
    const savedFixture = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'));
    const savedGraph = parseShadowGraph(savedBody.graph, { ...fixture.input, rawText: savedFixture.rawText });
    assert.ok(savedGraph.graph.arguments.some(a => a.claim === 'N2' && a.oppose.includes('N6')));
    assert.ok(savedGraph.warnings.some(w => w.code === 'graph_relation_placement_repaired'));
    assert.ok(!savedGraph.warnings.some(w => w.code === 'graph_quote_unlocated'));
    console.log('PASS: saved cloud extraction graph replay with its original raw text (no new request, not a full assessment acceptance).');
  }

  const calls: string[] = [];
  const rawReply = { ...fixture.extractResponse, graph: original };
  const outcome = await runFlowShadow(fixture.input, { call: async request => {
    calls.push(request.stage);
    if (request.stage === 'extract') return { content: JSON.stringify(rawReply) };
    const input = JSON.parse(request.userInput);
    assert.ok(input.graph.arguments.some((a: { claim: string; oppose: string[] }) => a.claim === 'N2' && a.oppose.includes('N6')));
    return { content: JSON.stringify({ ...fixture.assessResponse, graphKey: input.graphKey, referenceKey: input.referenceKey }) };
  } }, { referenceProvider: { retrieve: async () => fixture.referenceCandidates } });
  assert.equal(outcome.status, 'reviewed', outcome.error);
  assert.deepEqual(calls, ['extract', 'assess'], 'No retries or extra repair call');
  assert.ok(outcome.record?.warnings.some(w => w.code === 'graph_relation_placement_repaired'));
  assert.equal(outcome.rawResponses.extract, JSON.stringify(rawReply), 'Original model response retained');
  assert.equal(shadowFingerprint(outcome.graph), shadowFingerprint(repaired.graph));
  assert.equal(SHADOW_EXTRACTION_PROMPT_ID, 'flow-shadow-extract-v4.3-light');
  assert.equal(SHADOW_ASSESSMENT_PROMPT_ID, 'flow-shadow-assess-v4.6-light');
  assert.equal(createHash('sha256').update(FLOW_SHADOW_ASSESSMENT_PROMPT_V41).digest('hex'),
    '7cf63c7219ff12b79fd3548582ca1482d5df0da8a4d24c43f479bda608723b6a', 'Original assessment baseline remains frozen');
  assert.ok(FLOW_SHADOW_ASSESSMENT_PROMPT.includes('criteria恰好9项'));
  assert.ok(FLOW_SHADOW_EXTRACTION_PROMPT_V41.includes('v4.1'));
  assert.ok(FLOW_SHADOW_EXTRACTION_PROMPT.indexOf('support/oppose只属于argument') < FLOW_SHADOW_EXTRACTION_PROMPT.indexOf('仅JSON'));
  console.log('PASS: directed field migration; deduplication; immutable replies; conflict/role/endpoint/argument ambiguity quarantine; no inferred attack; idempotent normalized graph; frozen V4.1 assessment baseline; two-stage mock workflow. Zero cloud requests/production writes; semantic accuracy not certified.');
} finally { globalThis.fetch = previousFetch; }

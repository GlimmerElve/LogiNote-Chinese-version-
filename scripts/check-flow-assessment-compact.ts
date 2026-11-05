/** Local contract regression only: frozen replies do not prove new-prompt semantic accuracy. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { FLOW_SHADOW_ASSESSMENT_PROMPT, SHADOW_ASSESSMENT_PROMPT_ID } from '../src/services/flowShadow/prompts';
import { FLOW_SHADOW_ASSESSMENT_PROMPT_V41 } from '../src/services/flowShadow/promptsAssessmentV41';
import { FLOW_SHADOW_ASSESSMENT_PROMPT_V42, FLOW_SHADOW_EXTRACTION_PROMPT_V42 } from '../src/services/flowShadow/promptsV42';
import { FLOW_SHADOW_ASSESSMENT_PROMPT_V43 } from '../src/services/flowShadow/promptsV43';
import { FLOW_SHADOW_ASSESSMENT_PROMPT_V45 } from '../src/services/flowShadow/promptsAssessmentV45';
import { SHADOW_CRITERIA, SHADOW_BEHAVIORS } from '../src/services/flowShadow/rubric';
import { SHADOW_COGNITIVE_AXES } from '../src/services/flowShadow/profileAlignment';
import { requiresCognitiveEvidenceAudit } from '../src/services/flowShadow/cognitiveEvidence';
import { parseShadowAssessment, shadowFingerprint } from '../src/services/flowShadow/protocol';
import { prepareShadowAssessment, replayShadowResponses } from '../src/services/flowShadow/runner';
import { createFlowResultPreview } from './fixtures/flow-result-v2-preview';
import { adaptShadowRecordToFlowV2 } from '../src/services/flowAnalysis/productionV2';
import { extractFlowEvidence } from '../src/services/memory/evidenceExtractor';
import { SHARED_REFERENCE_TRANSPORT, projectShadowReferencePacket } from '../src/services/flowShadow/referenceTransport';
import type { ShadowRecord } from '../src/services/flowShadow/types';

const priorFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network in prompt contract regression');
try {
  const prompt = FLOW_SHADOW_ASSESSMENT_PROMPT;
  assert.equal(SHADOW_ASSESSMENT_PROMPT_ID, 'flow-shadow-assess-v4.6-light');
  assert.equal(createHash('sha256').update(FLOW_SHADOW_ASSESSMENT_PROMPT_V41).digest('hex'),
    '7cf63c7219ff12b79fd3548582ca1482d5df0da8a4d24c43f479bda608723b6a');
  assert.ok(FLOW_SHADOW_ASSESSMENT_PROMPT_V42.length < FLOW_SHADOW_ASSESSMENT_PROMPT_V41.length * .95, 'Preserve the compact V4.2 experiment');
  assert.ok(FLOW_SHADOW_ASSESSMENT_PROMPT_V43.length <= 5000, 'Preserve the V4.3 size baseline');
  assert.ok(prompt.length <= FLOW_SHADOW_ASSESSMENT_PROMPT_V45.length + 300, 'Bounded V4.6 evidence/grade clarification; no token-saving claim');
  for (const criterion of SHADOW_CRITERIA) assert.ok(prompt.includes(`${criterion.id}[${criterion.layer}]：${criterion.question}`));
  for (const behavior of SHADOW_BEHAVIORS) assert.ok(prompt.includes(`${behavior.code}=${behavior.label}`));
  for (const axis of SHADOW_COGNITIVE_AXES) assert.ok(prompt.includes(`-${axis.negative}/+${axis.positive}`));
  for (const marker of ['criteria恰好9项', '逐个评价referencePacket.targets', '按各目标selection取用',
    'mixed/insufficient的direction=null', '撤回/更正也要引用为证据', 'null不算0', '图漏连不扣用户分',
    '不合并不同指标', '仅紧凑JSON、不缩进', '最多120字', 'summary≤120字', 'recommendation≤100字']) assert.ok(prompt.includes(marker), marker);
  assert.ok(requiresCognitiveEvidenceAudit(SHADOW_ASSESSMENT_PROMPT_ID), 'New prompt cannot bypass bipolar audit');
  assert.ok(requiresCognitiveEvidenceAudit('flow-shadow-assess-v4.1-light'), 'Old opt-in remains valid');
  assert.equal(requiresCognitiveEvidenceAudit('flow-shadow-assess-v4-light'), false);

  const compare = (record: ShadowRecord, label: string) => {
    const before = JSON.stringify(record), transport = projectShadowReferencePacket(record.references);
    const raw = { protocol: record.protocol, inputKey: shadowFingerprint(record.input), graphKey: shadowFingerprint(record.graph),
      referenceKey: shadowFingerprint(record.references), assessment: structuredClone(record.assessment) };
    // V4.1 already required this audit. Apply the same opt-in to both test sides;
    // the old display fixture lacks it, and is not a valid new-model audit declaration.
    const baselineAssessment = parseShadowAssessment(raw, record.input, record.graph, record.references,
      { requireCognitiveAudit: true }).assessment;
    raw.assessment.referenceComparisons.forEach(c => {
      c.referenceIds = [...new Set(c.referenceIds.map(id => transport.itemToAlias.get(id) || id))];
    });
    const parse = (content: string) => parseShadowAssessment(content, record.input, record.graph, record.references,
      { requireCognitiveAudit: true, referenceTransport: SHARED_REFERENCE_TRANSPORT });
    const parsed = parse(JSON.stringify(raw));
    assert.deepEqual(parsed, parse(JSON.stringify(raw, null, 2)), 'JSON whitespace never changes interpretation');
    assert.deepEqual(parsed.assessment, baselineAssessment, 'All evidence/target IDs, grades and states retained under the same V4.1/V4.2 audit');
    const replay = replayShadowResponses(record.input,
      { protocol: record.protocol, inputKey: raw.inputKey, graph: record.graph }, JSON.stringify(raw), record.references,
      { requireCognitiveAudit: true, referenceTransport: SHARED_REFERENCE_TRANSPORT });
    assert.deepEqual(replay.graph, record.graph);
    assert.deepEqual(replay.scoring, record.scoring);
    assert.deepEqual(replay.referenceScoring, record.referenceScoring);
    const baseline = adaptShadowRecordToFlowV2({ ...record, assessment: baselineAssessment }, 'fixed'), current = adaptShadowRecordToFlowV2(replay, 'fixed');
    assert.deepEqual(current.report, baseline.report);
    assert.deepEqual(current.argumentDoc, baseline.argumentDoc);
    assert.deepEqual(current.profileInsight, baseline.profileInsight);
    const signals = (b: typeof current) => extractFlowEvidence({ episodeId: record.input.attemptId, observedAt: record.input.observedAt,
      report: b.report, profileInsight: b.profileInsight, analysisV2: b.analysisV2 }).profileSignals;
    assert.deepEqual(signals(current), signals(baseline));
    assert.equal(JSON.stringify(record), before, 'Never rewrite saved evidence or explanations');
    const request = prepareShadowAssessment(record.input, record.graph, record.references, { referenceTransport: SHARED_REFERENCE_TRANSPORT });
    assert.equal(request.systemPrompt, prompt);
    console.log(JSON.stringify({ label, targets: record.references.targets.length,
      criteria: replay.assessment.criteria.length, evidence: replay.assessment.evidence.length,
      graphScoresAndProfileUnchanged: true, cloudCalls: 0, semanticAccuracy: 'not_retested' }));
  };
  compare(createFlowResultPreview().record, 'synthetic');
  if (process.argv.includes('--replay-saved')) for (const [directory, extractionDirectory] of [
    ['cloud-PW1ZnA', 'cloud-PW1ZnA'], ['cloud-KrxsEX', 'cloud-ewsDBE'],
  ]) {
    const bundle = JSON.parse(await readFile(`.ui-preview/flow-acceptance/${directory}/bundle.json`, 'utf8'));
    const savedExtract = JSON.parse(await readFile(`.ui-preview/flow-acceptance/${extractionDirectory}/request-extract.json`, 'utf8'));
    assert.equal(savedExtract.systemPrompt, FLOW_SHADOW_EXTRACTION_PROMPT_V42, 'Historical V4.2 extraction snapshot remains exactly unchanged');
    compare(bundle.analysisV2.record as ShadowRecord, directory);
  }
  console.log(JSON.stringify({ status: 'PASS', assessmentPromptCharacters: [FLOW_SHADOW_ASSESSMENT_PROMPT_V41.length, prompt.length],
    canonicalFieldsRemoved: 0, extraModelCalls: 0, productionWrites: 0, tokenSavings: 'not_measured' }));
} finally { globalThis.fetch = priorFetch; }

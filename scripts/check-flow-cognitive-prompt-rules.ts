/** Prompt/contract checks only. These do not establish that a model follows semantic criteria. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SHADOW_COGNITIVE_RULES } from '../src/services/flowShadow/cognitivePromptRules';
import { SHADOW_COGNITIVE_AXES } from '../src/services/flowShadow/profileAlignment';
import { FLOW_SHADOW_ASSESSMENT_PROMPT, FLOW_SHADOW_EXTRACTION_PROMPT, SHADOW_ASSESSMENT_PROMPT_ID } from '../src/services/flowShadow/prompts';
import { FLOW_SHADOW_ASSESSMENT_PROMPT_V43, FLOW_SHADOW_EXTRACTION_PROMPT_V43 } from '../src/services/flowShadow/promptsV43';
import { FLOW_SHADOW_ASSESSMENT_PROMPT_V45 } from '../src/services/flowShadow/promptsAssessmentV45';
import { auditShadowCognitiveEvidence, requiresCognitiveEvidenceAudit } from '../src/services/flowShadow/cognitiveEvidence';
import { requiresAssessmentCoverageReview } from '../src/services/flowShadow/assessmentCoverage';
import { createFlowShadowFixture } from '../src/services/flowShadow/demo';
import { replayShadowResponses } from '../src/services/flowShadow/runner';
import { SHARED_REFERENCE_TRANSPORT } from '../src/services/flowShadow/referenceTransport';
import type { ShadowBehavior, ShadowGraph, ShadowRecord } from '../src/services/flowShadow/types';

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network in semantic boundary contract regression');
try {
  const prompt = FLOW_SHADOW_ASSESSMENT_PROMPT;
  assert.equal(SHADOW_ASSESSMENT_PROMPT_ID, 'flow-shadow-assess-v4.6-light');
  assert.equal(FLOW_SHADOW_EXTRACTION_PROMPT, FLOW_SHADOW_EXTRACTION_PROMPT_V43, 'This phase does not change extraction');
  assert.ok(prompt.length <= FLOW_SHADOW_ASSESSMENT_PROMPT_V45.length + 300, 'Two focused contract clarifications, not a new evaluation framework');
  assert.ok(!prompt.includes('各极ID须在evidenceIds'), 'Flat cognitive rows must not be told to output a redundant evidenceIds list');
  for (const marker of ['不同片段分别编号，即使来自同一节点', '不能用包含三者的整段同时作两极证据',
    '三个数组的ID均须已定义于evidence', 'negativeEvidenceIds与positiveEvidenceIds不能交叉',
    '撤回前后仍可绑定同一节点，不重抽图', 'level按实质影响评0～2', '代表无硬错的3/4',
    '用途或影响不明则uncertain/null', 'current硬错与reasoning_consistency等级一致']) assert.ok(prompt.includes(marker), marker);
  assert.deepEqual(SHADOW_COGNITIVE_RULES.map(r => r.code).sort(), SHADOW_COGNITIVE_AXES.map(a => a.behavior).sort());
  for (const rule of SHADOW_COGNITIVE_RULES) for (const field of ['opportunity', 'negative', 'positive', 'exclude'] as const) {
    assert.ok(rule[field].trim().length && prompt.includes(rule[field]), `${rule.code}.${field} rendered into actual prompt`);
  }
  assert.ok(!prompt.includes('推理可假定前提成立'), 'Remove the unscoped premise-assumption rule, not merely add another exception');
  assert.ok(!prompt.includes('mixed并存未解决'), 'Coexistence alone cannot mean cognitive conflict');
  assert.ok(!prompt.includes('重复强证据才±2'), 'Repeated paraphrase cannot inflate direction strength');
  for (const marker of ['先核对内容，再评推导形式', 'localArithmeticChecks是本地', '仅在原话和资料均不能验证该外部事实时',
    '不能覆盖已确认的计算、矛盾或资料冲突', '表述清楚、结构完整或风格谨慎都不能证明内容正确',
    '单纯同时出现', '缺少机会或证据不能判负极', '不生成嵌套polarity', '不同语义机会']) assert.ok(prompt.includes(marker), marker);
  assert.ok(!prompt.includes('76%') && !prompt.includes('33个百分点') && !prompt.includes('43个百分点'), 'No fixture arithmetic answer leaked into the prompt');
  const schema = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"protocol"'))!);
  const strategySchema = schema.assessment.cognitiveObservations.find((b: ShadowBehavior) => b.code === 'uncertainty_calibration');
  assert.ok(Array.isArray(strategySchema.negativeEvidenceIds) && Array.isArray(strategySchema.positiveEvidenceIds)
    && strategySchema.resolution === 'insufficient', 'Flat cognitive evidence is inline in a distinct main-schema array');
  assert.ok(requiresCognitiveEvidenceAudit(SHADOW_ASSESSMENT_PROMPT_ID) && requiresAssessmentCoverageReview(SHADOW_ASSESSMENT_PROMPT_ID));

  const fixture = createFlowShadowFixture();
  const phrases = ['我先用共同规则解释这一类情况。', '再用这个具体例子说明同一个意思。'];
  const input = { ...fixture.input, rawText: phrases.join('\n') };
  const graph: ShadowGraph = { nodes: phrases.map((rawQuote, i) => ({ id: `P${i}`, role: 'background', text: rawQuote, rawQuote })),
    arguments: [], relations: [], unresolved: [] };
  const assessment = { ...fixture.assessment, evidence: phrases.map((quote, i) => ({ id: `V${i}`, quote, nodeIds: [`P${i}`], attribution: 'user' as const })),
    behaviors: [{ code: 'abstract_concrete' as const, state: 'observed' as const, direction: 0 as const, evidenceIds: ['V0', 'V1'],
      polarity: { negative: ['V1'], positive: ['V0'], resolution: 'balanced' as const }, reason: '共同规则和实例互相说明，没有有据的主导方向。' }] };
  const balanced = auditShadowCognitiveEvidence(input, graph, assessment, true);
  assert.equal(balanced.assessment.behaviors[0].direction, 0, 'Existing contract already permits complementary balance; no scoring/axis migration needed');
  const mixed = structuredClone(assessment) as typeof fixture.assessment;
  mixed.behaviors[0].polarity!.resolution = 'mixed'; mixed.behaviors[0].direction = 1;
  assert.equal(auditShadowCognitiveEvidence(input, graph, mixed, true).assessment.behaviors[0].direction, null);
  const missing = structuredClone(assessment) as typeof fixture.assessment;
  delete missing.behaviors[0].polarity;
  assert.ok(auditShadowCognitiveEvidence(input, graph, missing, true).warnings.some(w => w.code === 'cognitive_audit_missing'));
  assert.equal(auditShadowCognitiveEvidence(input, graph, missing, false).assessment.behaviors[0].direction, 0, 'Old uncontracted observations retain historical interpretation');

  if (process.argv.includes('--replay-v43')) {
    const directory = '.ui-preview/flow-acceptance/cloud-hdhYo5';
    const savedText = await readFile(`${directory}/bundle.json`, 'utf8');
    const record = JSON.parse(savedText).analysisV2.record as ShadowRecord;
    const extractRequest = JSON.parse(await readFile(`${directory}/request-extract.json`, 'utf8'));
    const assessRequest = JSON.parse(await readFile(`${directory}/request-assess.json`, 'utf8'));
    assert.equal(extractRequest.systemPrompt, FLOW_SHADOW_EXTRACTION_PROMPT_V43);
    assert.equal(assessRequest.systemPrompt, FLOW_SHADOW_ASSESSMENT_PROMPT_V43);
    const extract = JSON.parse(await readFile(`${directory}/response-extract.json`, 'utf8'));
    const assess = JSON.parse(await readFile(`${directory}/response-assess.json`, 'utf8'));
    const replay = replayShadowResponses(record.input, extract.content, assess.content, record.references,
      { requireCognitiveAudit: true, reviewBehaviorCoverage: true, referenceTransport: SHARED_REFERENCE_TRANSPORT });
    assert.deepEqual(replay.graph, record.graph);
    assert.deepEqual(replay.assessment, record.assessment);
    assert.deepEqual(replay.scoring, record.scoring);
    assert.deepEqual(replay.referenceScoring, record.referenceScoring);
    assert.equal(replay.warnings.filter(w => w.code === 'cognitive_audit_missing').length, 5);
    assert.equal(replay.assessment.issues.length, 0, 'Old arithmetic miss remains a miss, not silently repaired locally');
    assert.equal(await readFile(`${directory}/bundle.json`, 'utf8'), savedText);
  }
  console.log(JSON.stringify({ status: 'PASS', cognitiveAxes: SHADOW_COGNITIVE_RULES.length,
    assessmentPromptCharacters: [FLOW_SHADOW_ASSESSMENT_PROMPT_V43.length, prompt.length],
    extractionUnchanged: true, scoringFormulaChanged: false, profileCoordinatesAndAggregationChanged: false,
    localVerificationGateAdded: true, cloudCalls: 0, semanticExecutionVerified: false }));
} finally { globalThis.fetch = previousFetch; }

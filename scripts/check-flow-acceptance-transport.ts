import assert from 'node:assert/strict';
import { buildFlowAcceptanceWireBody } from './flow-acceptance-transport';
import type { ShadowRequest } from '../src/services/flowShadow/runner';
import { readFileSync } from 'node:fs';
import { FLOW_REVIEW_MODEL_BUDGETS, flowReviewMaxTokens } from '../src/services/flowAnalysis/modelBudgets';
import { FLOW_LIGHT_PARAMETERS } from './flow-light-comparison';
assert.deepEqual(FLOW_REVIEW_MODEL_BUDGETS, { extractionMaxTokens: 12000, assessmentMaxTokens: 32000 });
assert.equal(FLOW_LIGHT_PARAMETERS.assessmentMaxTokens, FLOW_REVIEW_MODEL_BUDGETS.assessmentMaxTokens);
assert.ok(FLOW_REVIEW_MODEL_BUDGETS.assessmentMaxTokens <= 32768, 'Keep below the current shared IPC clamp');
const production = readFileSync('src/services/flowAnalysis/productionV2.ts', 'utf8');
assert.ok(production.includes('maxTokensOverride: flowReviewMaxTokens(request.stage)'));
assert.ok(production.includes("thinkingMode: 'disabled'"), 'Budget change cannot silently change production thinking policy');
for (const stage of ['extract', 'assess'] as const) {
  const request: ShadowRequest = { stage, promptId: 'test', systemPrompt: 'fixed prompt', userInput: 'fixed input' };
  const before = structuredClone(request);
  const disabled = buildFlowAcceptanceWireBody(request, 'deepseek-flash');
  const omitted = buildFlowAcceptanceWireBody(request, 'deepseek-flash', true);
  assert.equal(disabled.max_tokens, flowReviewMaxTokens(stage));
  assert.equal(omitted.max_tokens, flowReviewMaxTokens(stage));
  assert.equal(Object.hasOwn(omitted, 'thinking'), false);
  assert.equal(Object.hasOwn(omitted, 'thinkingMode'), false);
  assert.deepEqual(disabled.thinking, { type: 'disabled' });
  const { thinking, ...remaining } = disabled;
  assert.deepEqual(remaining, omitted, 'Only thinking field changes');
  assert.deepEqual(JSON.parse(JSON.stringify(omitted)), remaining);
  assert.deepEqual(request, before);
}
console.log('PASS: shared output ceilings 12000/32000 verified; omitted-thinking changes no other wire fields/messages; production thinking policy untouched. No model calls.');

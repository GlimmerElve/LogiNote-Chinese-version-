import assert from 'node:assert/strict';
import { argumentProjectionBuildFixture, fixedProjectionSelection, fixedAcceptProjectionReview } from './argument-projection-build-fixture.ts';
import { readArgumentProjectionSelection } from '../src/services/argumentContext/modelDraftSelection.ts';
import { readArgumentProjectionDraft, buildArgumentProjectionReviewInput, finalizeArgumentProjectionBuild,
  verifyArgumentProjectionBuildResult } from '../src/services/argumentContext/construction.ts';
import { buildArgumentProjectionSelectionRequest, ARGUMENT_PROJECTION_REVIEW_PROMPT } from '../src/services/argumentContext/buildPrompts.ts';
const prior = globalThis.fetch; globalThis.fetch = async () => assert.fail('No network in selection checks');
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const copy = <T>(value: T): T => structuredClone(value);
try {
  const f = await argumentProjectionBuildFixture(), selection = fixedProjectionSelection(f.draft);
  const actual = await readArgumentProjectionSelection(selection, f.input);
  assert.deepEqual(actual, f.draft); assert.deepEqual(await readArgumentProjectionSelection(JSON.stringify(selection), f.input), actual);
  pass('explicit v2 array-position IDs produce canonical v1, object/string equivalent');
  const closure = copy(selection); closure.scopes[0].selectedNodeIds = []; closure.scopes[0].selectedRelationIds = [];
  const closed = await readArgumentProjectionSelection(closure, f.input);
  assert.deepEqual(new Set(closed.scopes[0].requiredNodeIds), new Set([closure.scopes[0].seedNodeId,
    ...f.draft.groups.flatMap(group => [group.conclusionNodeId, ...group.premiseNodeIds, ...group.conditionNodeIds])]));
  assert.deepEqual(new Set(closed.scopes[0].requiredRelationIds), new Set(f.draft.groups.flatMap(group => group.relationIds)));
  pass('selected groups mechanically close declared members, relations and endpoints');
  const one = copy(selection); one.scopes[0].selectedNodeIds = []; one.scopes[0].selectedGroupIds = [];
  one.scopes[0].selectedRelationIds = ['E1'];
  const endpoints = (await readArgumentProjectionSelection(one, f.input)).scopes[0];
  assert.deepEqual(new Set(endpoints.requiredNodeIds), new Set([one.scopes[0].seedNodeId, f.draft.relations[0].sourceNodeId, f.draft.relations[0].targetNodeId]));
  assert.deepEqual(endpoints.requiredRelationIds, ['E1']); assert.deepEqual(endpoints.requiredGroupIds, []);
  pass('single selected edge closes only its two endpoints; no invented edges/groups');
  const seedOnly = copy(one); seedOnly.scopes[0].selectedRelationIds = [];
  const omitted = (await readArgumentProjectionSelection(seedOnly, f.input)).scopes[0];
  assert.deepEqual(omitted.requiredNodeIds, [seedOnly.scopes[0].seedNodeId]);
  assert.deepEqual(omitted.requiredRelationIds, []);
  pass('KNOWN-RISK: omitted semantic conditions are not discovered by mechanical closure');
  await assert.rejects(readArgumentProjectionSelection(f.draft, f.input));
  await assert.rejects(readArgumentProjectionDraft(selection, f.input));
  pass('legacy and v2 closed wires reject each other, never fallback');
  for (const key of ['id', 'start', 'roleSupported', 'admission']) {
    const bad = copy(selection); Object.assign(bad.nodes[0], { [key]: true });
    await assert.rejects(readArgumentProjectionSelection(bad, f.input));
  }
  const extra = copy(selection); Object.assign(extra.scopes[0], { requiredNodeIds: ['N1'] });
  await assert.rejects(readArgumentProjectionSelection(extra, f.input));
  pass('model IDs/coordinates/votes/required closure cannot enter selection rows');
  for (const field of ['selectedNodeIds', 'selectedRelationIds', 'selectedGroupIds'] as const) {
    const bad = copy(selection); bad.scopes[0][field] = ['unknown']; await assert.rejects(readArgumentProjectionSelection(bad, f.input));
  }
  const orphan = copy(selection); orphan.relations[0].targetNodeId = 'N999';
  await assert.rejects(readArgumentProjectionSelection(orphan, f.input));
  pass('unknown slots and orphan edges fail before dereference/closure');
  const duplicate = copy(selection); duplicate.scopes[0].selectedGroupIds = ['G1', 'G1'];
  await assert.rejects(readArgumentProjectionSelection(duplicate, f.input));
  const malformed = copy(selection); Object.assign(malformed.groups[0], { premiseNodeIds: null });
  await assert.rejects(readArgumentProjectionSelection(malformed, f.input));
  pass('duplicate selections and malformed member lists held, not normalized');
  const self = copy(selection); self.relations[0].targetNodeId = self.relations[0].sourceNodeId;
  await assert.rejects(readArgumentProjectionSelection(self, f.input), /self_relation/);
  const quotes = copy(selection); quotes.nodes[0].quoteIds = ['Q999'];
  await assert.rejects(readArgumentProjectionSelection(quotes, f.input), /unknown_quote/);
  pass('unchanged canonical validator retains self-support and real-Q gates');
  let getters = 0; const getter = copy(selection);
  Object.defineProperty(getter.nodes[0], 'role', { enumerable: true, get: () => { getters++; return 'fact'; } });
  await assert.rejects(readArgumentProjectionSelection(getter, f.input)); assert.equal(getters, 0);
  for (const mutate of [
    (value: typeof selection) => Object.defineProperty(value, 'secret', { value: 1, enumerable: false }),
    (value: typeof selection) => Object.defineProperty(value, 'length', { value: 1, enumerable: false }),
    (value: typeof selection) => Object.assign(value, { [Symbol('secret')]: 1 }),
    (value: typeof selection) => { delete value.nodes[0]; },
  ]) { const bad = copy(selection); mutate(bad); await assert.rejects(readArgumentProjectionSelection(bad, f.input)); }
  pass('getters never execute; hidden/symbol fields and sparse arrays rejected');
  await assert.rejects(readArgumentProjectionSelection(JSON.stringify(selection).replace('"version":2', '"version":1,"version":2'), f.input));
  await assert.rejects(readArgumentProjectionSelection(JSON.stringify(selection).replace('"version":2', '"ver\\u0073ion":1,"version":2'), f.input));
  await assert.rejects(readArgumentProjectionSelection('```json\n' + JSON.stringify(selection) + '\n```', f.input));
  pass('duplicate JSON keys/escaped aliases/Markdown rejected in actual v2 raw response path');
  const pending = copy(selection), input = copy(f.input), result = readArgumentProjectionSelection(pending, input);
  pending.nodes[0].role = 'hypothesis'; input.canonicalText = 'late mutation';
  assert.deepEqual(await result, actual);
  pass('source and selection captured before first await, late changes excluded');
  const changed = copy(f.input); changed.canonicalText += 'unexpected';
  await assert.rejects(readArgumentProjectionSelection(selection, changed));
  await assert.rejects(readArgumentProjectionSelection({ ...selection, buildId: 'x'.repeat(64) }, f.input));
  pass('complete host-source replay and build binding remain mandatory');
  await assert.rejects(readArgumentProjectionSelection(' '.repeat(24001), f.input), /response_budget/);
  const tooMany = copy(selection); tooMany.nodes = Array.from({ length: 65 }, () => copy(selection.nodes[0]));
  await assert.rejects(readArgumentProjectionSelection(tooMany, f.input));
  pass('source/wire budgets remain closed without truncation');
  const request = await buildArgumentProjectionSelectionRequest(f.input), payload = JSON.parse(request.userInput);
  assert.equal(payload.version, 2); assert.equal(payload.canonicalText, f.input.canonicalText);
  assert.deepEqual(payload.quotes, f.input.quotes); assert.ok(request.systemPrompt.length + request.userInput.length <= 24000);
  assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true);
  assert.match(ARGUMENT_PROJECTION_REVIEW_PROMPT, /单个成员独自推不出/);
  assert.match(ARGUMENT_PROJECTION_REVIEW_PROMPT, /整个组合/);
  pass('full-source v2 request assembled with bounded budget; joint-group semantic directive explicit');
  const reviewInput = await buildArgumentProjectionReviewInput(f.input, closed), review = fixedAcceptProjectionReview(reviewInput);
  const projection = await finalizeArgumentProjectionBuild(f.input, closed, review);
  await verifyArgumentProjectionBuildResult(projection, { input: f.input, draft: closed, review });
  assert.equal(projection.status, 'reviewed_complete'); assert.equal(projection.limitations.scoreWrite, 'disabled');
  review.scopes[0].decision = 'unknown'; review.scopes[0].requiredSetComplete = false;
  assert.equal((await finalizeArgumentProjectionBuild(f.input, closed, review)).status, 'reviewed_partial');
  pass('independent closed v1 review/proof unchanged; unknown vote cannot publish complete');
  console.log(`Argument projection selection checks passed: ${checks}`);
} finally { globalThis.fetch = prior; }

import assert from 'node:assert/strict';
import { createReferenceDisclosureFixture } from './reference-disclosure-fixture.ts';
import { fixedAcceptProjectionReview } from './argument-projection-build-fixture.ts';
import { adaptSavedKnowledgeNote } from '../src/electron/rag/argumentSourceAdapter.ts';
import { prepareArgumentProjectionBuild, buildArgumentProjectionReviewInput, finalizeArgumentProjectionBuild } from '../src/services/argumentContext/construction.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import { prepareSourcePropositionContext, type SourcePropositionReviewInput, type SourcePropositionReview } from '../src/services/reviewComparison/sourcePropositionAnchors.ts';
import { prepareSourcePropositionParentSelection, readSourcePropositionParentSelection,
  readSourcePropositionSelection, prepareSourcePropositionSelection, SOURCE_PROPOSITION_PARENT_SELECTION_PROTOCOL,
  type SourcePropositionParentSelection, type SourcePropositionParentSelectionInput } from '../src/services/reviewComparison/sourcePropositionSelection.ts';
import { buildSourcePropositions, createSourcePropositionBuildModel, SOURCE_PROPOSITION_PARENT_SELECTION_PROMPT,
  SOURCE_PROPOSITION_REVIEW_PROMPT } from '../src/services/reviewComparison/sourcePropositionBuild.ts';
import type { ArgumentProjectionDraft } from '../src/services/argumentContext/buildTypes.ts';
import type { NoteItem } from '../src/types.ts';

// Fixed synthetic responses only: no semantic success, model, vault/config read or production write.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('whole-parent checks prohibit network');
const clone = <T>(value: T): T => structuredClone(value);
let groups = 0;
const pass = (label: string) => { groups++; console.log(`PASS ${label}`); };
function selected(menu: SourcePropositionParentSelectionInput): SourcePropositionParentSelection {
  const seen = new Set<string>();
  return { version: 3, protocol: SOURCE_PROPOSITION_PARENT_SELECTION_PROTOCOL, contextHash: menu.contextHash,
    anchors: menu.parentChoices.filter(row => { if (seen.has(row.nodeId)) return false; seen.add(row.nodeId); return true; })
      .map(row => ({ parentChoiceId: row.parentChoiceId })) };
}
function review(input: SourcePropositionReviewInput): SourcePropositionReview {
  return { version: 1, protocol: 'review-source-proposition-review-v1', reviewId: input.reviewId,
    contextHash: input.contextHash, draftHash: input.draftHash, anchors: input.draft.anchors.map(row => ({
      id: row.id, decision: 'accept', roleSupported: true, completeMeaning: true, scopePreserved: true,
      reason: 'Fixed synthetic vote, not a semantic acceptance claim.' })) };
}
async function partialFixture() {
  const note: NoteItem = { id: 'whole-parent-synthetic', title: '合成父引文', noteType: 'knowledge',
    content: '合成系统甲已联网，可以接收任务。', createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z',
    tags: [], links: [], backlinks: [], dueDates: [] };
  const rootScopeId = 'whole-parent-synthetic-root', scope = { scopeId: 'whole-parent-synthetic-scope', rootScopeId,
    corpus: 'reference' as const, allowedSourceKinds: ['knowledge-note' as const], allowedNoteIds: [note.id], allowedDocIds: [], allowedRecordIds: [] };
  const physical = await adaptSavedKnowledgeNote({ note, rootScopeId, scope });
  const input = await prepareArgumentProjectionBuild({ source: physical.source, canonicalText: physical.canonicalText,
    hierarchy: physical.hierarchy, scope, chunks: physical.chunks,
    sourceQualification: { status: 'eligible', policyVersion: 'synthetic-parent-only', evidence: [physical.quotes[0].evidence] } });
  const partial = input.quotes.find(row => row.evidence.quote === '可以接收任务。')!;
  assert.ok(partial && !partial.completeSentence);
  const draft: ArgumentProjectionDraft = { version: 1, buildId: input.buildId,
    nodes: [{ id: 'N1', role: 'claim', quoteIds: [partial.quoteId] }], relations: [], groups: [],
    scopes: [{ id: 'S1', seedNodeId: 'N1', task: 'fact', requiredNodeIds: ['N1'], requiredRelationIds: [], requiredGroupIds: [], quoteIds: [partial.quoteId] }] };
  const result = await finalizeArgumentProjectionBuild(input, draft, fixedAcceptProjectionReview(await buildArgumentProjectionReviewInput(input, draft)));
  return { input, result, context: await prepareSourcePropositionContext(input, result) };
}
try {
  const source = await createReferenceDisclosureFixture({ task: 'definition' });
  const key = [...source.inputs.keys()][0], input = source.inputs.get(key)!, result = source.results.get(key)!;
  const context = await prepareSourcePropositionContext(input, result), menu = await prepareSourcePropositionParentSelection(context), raw = selected(menu);
  assert.equal(menu.version, 3); assert.equal(menu.protocol, 'review-source-proposition-parent-selection-input-v3');
  assert.equal(menu.contextHash, await argumentContextHash(context));
  const draft = await readSourcePropositionParentSelection(JSON.stringify(raw), context);
  for (const anchor of draft.anchors) {
    const parent = context.quotes.find(row => row.quoteId === anchor.quoteId)!;
    assert.equal(anchor.start, parent.evidence.start); assert.equal(anchor.end, parent.evidence.end);
    assert.equal(anchor.text, parent.evidence.quote); assert.equal(anchor.text, context.canonicalText.slice(anchor.start, anchor.end));
    assert.ok(context.projection.nodes.find(node => node.id === anchor.nodeId)!.evidence.some(span => JSON.stringify(span) === JSON.stringify(parent.evidence)));
  }
  pass('v3 explicit binding, every P is the exact whole owned Q with unchanged absolute UTF16 coordinates');
  assert.ok(draft.anchors.some(anchor => anchor.text.includes('🧠')));
  pass('host copies original Unicode/conditions/quantifiers without model substring location or clipping');

  for (const field of ['text', 'nodeId', 'quoteId', 'start', 'decision']) {
    const value = clone(raw); Object.assign(value.anchors[0], { [field]: field });
    await assert.rejects(() => readSourcePropositionParentSelection(value, context), /invalid_source_proposition_selection/u);
  }
  pass('v3 rejects text and identity/coordinate/vote injection; no implicit v2 fallback');
  const legacyMenu = await prepareSourcePropositionSelection(context);
  const old = { version: 2, protocol: 'review-source-proposition-selection-v2', contextHash: legacyMenu.contextHash,
    anchors: raw.anchors.map(row => ({ ...row, text: legacyMenu.parentChoices.find(choice => choice.parentChoiceId === row.parentChoiceId)!.text })) };
  old.anchors[0].text = '🧠';
  assert.equal((await readSourcePropositionSelection(old, context)).anchors[0].text, '🧠');
  await assert.rejects(() => readSourcePropositionParentSelection(old, context), /invalid_source_proposition_selection/u);
  pass('explicit legacy v2 retains its substring contract, but is never silently accepted by v3');
  const omitted = clone(raw); omitted.anchors.pop();
  await assert.rejects(() => readSourcePropositionParentSelection(omitted, context), /required_nodes_missing/u);
  const duplicate = clone(raw); duplicate.anchors.push(clone(duplicate.anchors[0]));
  await assert.rejects(() => readSourcePropositionParentSelection(duplicate, context), /anchor_duplicate/u);
  const unknown = clone(raw); unknown.anchors[0].parentChoiceId = 'PC1024';
  await assert.rejects(() => readSourcePropositionParentSelection(unknown, context), /parent_unknown/u);
  pass('missing nodes, duplicate parents and unknown choices remain held, not repaired');
  const changed = clone(raw); changed.contextHash = 'f'.repeat(64);
  await assert.rejects(() => readSourcePropositionParentSelection(changed, context), /context_changed/u);
  const changedContext = clone(context); changedContext.resultHash = 'f'.repeat(64);
  await assert.rejects(() => readSourcePropositionParentSelection(raw, changedContext), /context_changed/u);
  pass('full context hash prevents stale proof/result substitution');
  for (const json of ['```json\n' + JSON.stringify(raw) + '\n```', JSON.stringify(raw).replace('"version":3', '"version":3,"ver\\u0073ion":3')])
    await assert.rejects(() => readSourcePropositionParentSelection(json, context));
  pass('strict JSON rejects Markdown and escaped duplicate keys');
  let getters = 0;
  const getter = clone(raw); Object.defineProperty(getter.anchors[0], 'parentChoiceId', { enumerable: true, get() { getters++; return 'PC1'; } });
  await assert.rejects(() => readSourcePropositionParentSelection(getter, context));
  const hidden = clone(raw); Object.defineProperty(hidden, 'hidden', { value: true });
  await assert.rejects(() => readSourcePropositionParentSelection(hidden, context));
  const hiddenLength = clone(raw); Object.defineProperty(hiddenLength, 'length', { value: 0, enumerable: false });
  await assert.rejects(() => readSourcePropositionParentSelection(hiddenLength, context));
  const sparse = clone(raw); delete sparse.anchors[0]; await assert.rejects(() => readSourcePropositionParentSelection(sparse, context));
  assert.equal(getters, 0);
  pass('getters/hidden fields/sparse arrays rejected before reading or cloning untrusted values');
  const mutableRaw = clone(raw), mutableContext = clone(context), pending = readSourcePropositionParentSelection(mutableRaw, mutableContext);
  mutableRaw.anchors[0].parentChoiceId = 'PC999'; mutableContext.canonicalText = 'late mutation';
  assert.deepEqual(await pending, draft);
  pass('input and selected parents snapshotted before first await');

  const partial = await partialFixture(), partialMenu = await prepareSourcePropositionParentSelection(partial.context);
  assert.equal(partialMenu.parentChoices.length, 1); assert.equal(partialMenu.parentChoices[0].text, '可以接收任务。');
  assert.equal((await readSourcePropositionParentSelection(selected(partialMenu), partial.context)).anchors[0].text, '可以接收任务。');
  assert.ok(!partialMenu.parentChoices.some(row => row.text === partial.input.canonicalText));
  pass('partial upstream parent stays partial: no ownership expansion, cross-Q joining or synthetic subject');

  let calls = 0;
  const model = createSourcePropositionBuildModel(async request => {
    calls++; const wire = JSON.parse(request.userInput);
    if (request.stage === 'extract') {
      assert.equal(request.systemPrompt, SOURCE_PROPOSITION_PARENT_SELECTION_PROMPT);
      assert.equal(wire.version, 3); assert.equal(wire.protocol, 'review-source-proposition-parent-selection-input-v3');
      return selected(wire);
    }
    assert.equal(request.systemPrompt, SOURCE_PROPOSITION_REVIEW_PROMPT);
    assert.deepEqual(wire.draft, draft); return review(wire);
  }, { draftProtocol: 'owned-parent-choice-v3' });
  assert.equal(calls, 0);
  const built = await buildSourcePropositions(input, result, model);
  assert.equal(built.status, 'ready'); assert.equal(calls, 2);
  assert.deepEqual(built.modelRequests, { draft: 1, review: 1, total: 2, limit: 2 });
  pass('actual opt-in factory sends one v3 selection then existing independent review; fixed synthetic votes only');
  let heldCalls = 0;
  const heldModel = createSourcePropositionBuildModel(async request => {
    heldCalls++; const wire = JSON.parse(request.userInput);
    if (request.stage === 'extract') return selected(wire);
    const vote = review(wire); vote.anchors[0].decision = 'unknown'; vote.anchors[0].completeMeaning = false; return vote;
  }, { draftProtocol: 'owned-parent-choice-v3' });
  const held = await buildSourcePropositions(partial.input, partial.result, heldModel);
  assert.equal(held.status, 'held'); if (held.status === 'held') assert.deepEqual(held.reasons, ['source_proposition_review_held']);
  assert.equal(heldCalls, 2);
  pass('independent unknown for incomplete upstream node holds whole source, never changed into accept');
  let wrongCalls = 0;
  const wrong = createSourcePropositionBuildModel(async () => { wrongCalls++; return old; }, { draftProtocol: 'owned-parent-choice-v3' });
  const invalid = await buildSourcePropositions(input, result, wrong);
  assert.equal(invalid.status, 'held'); assert.equal(wrongCalls, 1); assert.equal(invalid.modelRequests.review, 0);
  pass('wrong protocol stops after one draft dispatch; no retry or review');
  const unqualified = clone(result); unqualified.status = 'reviewed_partial';
  const denied = await buildSourcePropositions(input, unqualified, model);
  assert.equal(denied.status, 'held'); assert.equal(denied.modelRequests.total, 0); assert.equal(calls, 2);
  pass('unqualified structure fails before draft dispatch, not made eligible by a menu');
  console.log(`Whole-owned-parent selection checks passed: ${groups}; synthetic fixed responses, 0 network, no semantic pass claim.`);
} finally { globalThis.fetch = originalFetch; }

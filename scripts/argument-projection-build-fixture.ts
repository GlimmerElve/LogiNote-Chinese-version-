import { argumentContextFixture } from './argument-context-fixture';
import { prepareArgumentProjectionBuild, buildArgumentProjectionReviewInput } from '../src/services/argumentContext/construction';
import type { ArgumentProjectionDraft, ArgumentProjectionReview, ArgumentProjectionReviewInput, ArgumentProjectionSourceInput } from '../src/services/argumentContext/buildTypes';
import { ARGUMENT_PROJECTION_SELECTION_PROTOCOL, type ArgumentProjectionSelection } from '../src/services/argumentContext/modelDraftSelection';

/** Test fixtures only, not a repair of old model output or a semantic choice algorithm. */
export function fixedProjectionSelection(draft: ArgumentProjectionDraft): ArgumentProjectionSelection {
  return { version: 2, protocol: ARGUMENT_PROJECTION_SELECTION_PROTOCOL, buildId: draft.buildId,
    nodes: draft.nodes.map(({ role, quoteIds }) => ({ role, quoteIds })),
    relations: draft.relations.map(({ sourceNodeId, targetNodeId, kind, quoteIds }) => ({ sourceNodeId, targetNodeId, kind, quoteIds })),
    groups: draft.groups.map(({ conclusionNodeId, premiseNodeIds, conditionNodeIds, relationIds, operator, quoteIds }) =>
      ({ conclusionNodeId, premiseNodeIds, conditionNodeIds, relationIds, operator, quoteIds })),
    scopes: draft.scopes.map(({ seedNodeId, task, requiredNodeIds, requiredRelationIds, requiredGroupIds, quoteIds }) =>
      ({ seedNodeId, task, selectedNodeIds: requiredNodeIds, selectedRelationIds: requiredRelationIds, selectedGroupIds: requiredGroupIds, quoteIds })) };
}

/** An explicit synthetic review vote, never used as a model input or semantic ground-truth measurement. */
export function fixedAcceptProjectionReview(reviewInput: ArgumentProjectionReviewInput): ArgumentProjectionReview {
  const draft = reviewInput.draft;
  const decision = (id: string, quoteIds: string[]) => ({ id, decision: 'accept' as const, quoteIds: [...quoteIds], reason: '合成固定审核票：原文支持本项，供程序合同验证。' });
  return { version: 1, reviewId: reviewInput.reviewId,
    nodes: draft.nodes.map((n) => ({ ...decision(n.id, n.quoteIds), roleSupported: true })),
    relations: draft.relations.map((r) => ({ ...decision(r.id, r.quoteIds), sourceNodeId: r.sourceNodeId, targetNodeId: r.targetNodeId,
      kind: r.kind, relationSupported: true, directionSupported: true, crossChunkSupported: true })),
    groups: draft.groups.map((g) => ({ ...decision(g.id, g.quoteIds), operator: g.operator, membersSupported: true,
      operatorSupported: true, necessarySetComplete: true })),
    scopes: draft.scopes.map((s) => ({ ...decision(s.id, s.quoteIds), requiredSetComplete: true, attributionSupported: true })) };
}

/** Gold protocol fixture, NOT a model's semantic judgement or a real-source quality certification. */
export async function argumentProjectionBuildFixture() {
  const f = await argumentContextFixture('uploaded-document');
  const sentences = f.projection.hierarchy.sentences;
  const sourceInput: ArgumentProjectionSourceInput = { source: f.projection.source, canonicalText: f.authority.canonicalText,
    hierarchy: f.projection.hierarchy, scope: f.scope,
    chunks: [{ id: 'chunk-A', start: 0, end: sentences[4].end, content: f.authority.canonicalText.slice(0, sentences[4].end),
      sentenceIds: sentences.slice(0, 5).map((s) => s.id), forcedSplit: false },
    { id: 'chunk-B', start: sentences[5].start, end: f.authority.canonicalText.length,
      content: f.authority.canonicalText.slice(sentences[5].start), sentenceIds: sentences.slice(5).map((s) => s.id), forcedSplit: false }],
    sourceQualification: { status: 'eligible', policyVersion: 'synthetic-source-policy-v1', evidence: [f.evidence(4)] } };
  const input = await prepareArgumentProjectionBuild(sourceInput);
  const nodeIds = new Map(f.projection.nodes.slice(0, 8).map((n, i) => [n.id, `N${i + 1}`]));
  const qFor = (sentenceId: string, start: number, end: number) => input.quotes.find((q) => q.evidence.sentenceId === sentenceId
    && q.evidence.start === start && q.evidence.end === end)!.quoteId;
  const quoteIds = (evidence: typeof f.projection.nodes[number]['evidence']) => evidence.map((e) => qFor(e.sentenceId, e.start, e.end));
  const draft: ArgumentProjectionDraft = { version: 1, buildId: input.buildId,
    nodes: f.projection.nodes.slice(0, 8).map((n) => ({ id: nodeIds.get(n.id)!, role: n.role, quoteIds: quoteIds(n.evidence) })),
    relations: f.projection.relations.map((r, i) => ({ id: `E${i + 1}`, sourceNodeId: nodeIds.get(r.sourceNodeId)!,
      targetNodeId: nodeIds.get(r.targetNodeId)!, kind: r.kind, quoteIds: quoteIds(r.evidence) })),
    groups: f.projection.prerequisiteGroups.map((g, i) => ({ id: `G${i + 1}`, conclusionNodeId: nodeIds.get(g.conclusionNodeId)!,
      premiseNodeIds: g.premiseNodeIds.map((id) => nodeIds.get(id)!), conditionNodeIds: g.conditionNodeIds.map((id) => nodeIds.get(id)!),
      relationIds: g.relationIds.map((id) => `E${f.projection.relations.findIndex((r) => r.id === id) + 1}`), operator: g.operator,
      quoteIds: g.relationIds.flatMap((id) => quoteIds(f.projection.relations.find((r) => r.id === id)!.evidence)).filter((id, j, all) => all.indexOf(id) === j) })),
    scopes: [{ id: 'S1', seedNodeId: 'N5', task: 'reasoning', requiredNodeIds: [...nodeIds.values()],
      requiredRelationIds: f.projection.relations.map((_, i) => `E${i + 1}`), requiredGroupIds: ['G1', 'G2'],
      quoteIds: f.projection.nodes.slice(0, 8).flatMap((n) => quoteIds(n.evidence)) }] };
  const reviewInput = await buildArgumentProjectionReviewInput(input, draft);
  const review = fixedAcceptProjectionReview(reviewInput);
  return { f, sourceInput, input, draft, reviewInput, review };
}

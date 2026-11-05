import { ARGUMENT_PROJECTION_BUILD_LIMITS as LIMITS, ARGUMENT_PROJECTION_DECISIONS,
  ARGUMENT_PROJECTION_SOURCE_REVIEW_PROTOCOL, ARGUMENT_PROJECTION_TASK_REVIEW_PROTOCOL, type ArgumentProjectionGroundedReview,
  type ArgumentProjectionGroundedReviewInput, type ArgumentProjectionSourceReviewInput, type ArgumentProjectionBuildInput,
  type ArgumentProjectionSourceInference } from './buildTypes';
import type { ArgumentContextProjection, ArgumentContextGap } from './types';

const fail = (code: string): never => { throw new Error(`argument_projection_${code}`); };
/** The new wire accepts plain data only; never evaluates getters/toJSON or hides fields in clone. */
export function assertArgumentProjectionSourceReviewData(value: unknown, depth = 0): void {
  if (depth > 64) fail('invalid_shape');
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object') fail('invalid_shape');
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 2048
      || Reflect.ownKeys(value).length !== value.length + 1
      || Object.keys(value).some((key, index) => key !== String(index))) fail('invalid_shape');
  } else if (![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value as object).some(key => typeof key !== 'string')) fail('invalid_shape');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value') || (!Array.isArray(value) || key !== 'length') && !descriptor.enumerable) fail('invalid_shape');
    if (key !== 'length' || !Array.isArray(value)) assertArgumentProjectionSourceReviewData(descriptor.value, depth + 1);
  }
}
function uniqueJsonKeys(raw: string): void {
  const stack: (Set<string> | null)[] = [];
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (character === '{') stack.push(new Set());
    else if (character === '[') stack.push(null);
    else if (character === '}' || character === ']') stack.pop();
    else if (character === '"') {
      const start = index++;
      while (index < raw.length) {
        if (raw[index] === '\\') index += 2;
        else if (raw[index] === '"') break;
        else index++;
      }
      let next = index + 1; while (next < raw.length && /\s/u.test(raw[next])) next++;
      if (raw[next] === ':') {
        const keys = stack.at(-1), key = JSON.parse(raw.slice(start, index + 1)) as string;
        if (!keys || keys.has(key)) fail('invalid_json'); keys!.add(key);
      }
    }
  }
}
export function snapshotArgumentProjectionSourceReviewRaw(raw: unknown): unknown {
  if (typeof raw === 'string') {
    if (raw.length > LIMITS.requestCharacters) fail('response_budget');
    const serialized = raw;
    try { raw = JSON.parse(serialized) as unknown; } catch { fail('invalid_json'); }
    uniqueJsonKeys(serialized);
  }
  assertArgumentProjectionSourceReviewData(raw);
  if (JSON.stringify(raw).length > LIMITS.requestCharacters) fail('response_budget');
  return structuredClone(raw);
}
export function argumentProjectionSourceCoverageTargets(input: Pick<ArgumentProjectionBuildInput, 'hierarchy' | 'quotes'>): ArgumentProjectionSourceReviewInput['sourceCoverageTargets'] {
  return input.hierarchy.sentences.map(sentence => {
    const quotes = input.quotes.filter(quote => quote.completeSentence && quote.evidence.sentenceId === sentence.id
      && quote.evidence.start === sentence.start && quote.evidence.end === sentence.end);
    if (quotes.length !== 1) fail('source_coverage_mismatch');
    return { sentenceId: sentence.id, quoteId: quotes[0].quoteId };
  });
}
function closed(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_shape');
  const keys = Object.keys(value as object);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) fail('invalid_shape');
}
function array(value: unknown, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('invalid_array');
}
function anchors(value: unknown, quotes: ReadonlyMap<string, unknown>, nonempty = true): asserts value is string[] {
  array(value, LIMITS.quoteReferences);
  if (nonempty && !value.length || new Set(value).size !== value.length
    || value.some(id => typeof id !== 'string' || !quotes.has(id))) fail('source_coverage_mismatch');
}
/** Vote arrays are separately checked against the unchanged candidate and v2 node schema. */
export function validateArgumentProjectionSourceCoverage(review: ArgumentProjectionGroundedReview,
  input: ArgumentProjectionGroundedReviewInput): void {
  closed(review, ['version', 'protocol', 'reviewId', 'nodes', 'relations', 'groups', 'scopes', 'sourceCoverage']);
  if ((review.version === 2 ? review.protocol !== ARGUMENT_PROJECTION_SOURCE_REVIEW_PROTOCOL
    : review.version !== 3 || review.protocol !== ARGUMENT_PROJECTION_TASK_REVIEW_PROTOCOL)
    || review.protocol !== input.protocol
    || review.reviewId !== input.reviewId) fail('review_binding_mismatch');
  array(review.sourceCoverage, input.sourceCoverageTargets.length);
  const quotes = new Map(input.quotes.map(quote => [quote.quoteId, quote]));
  const targets = new Map(input.sourceCoverageTargets.map(row => [row.sentenceId, row.quoteId]));
  const seen = new Set<string>(); let obligations = 0;
  for (const row of review.sourceCoverage) {
    closed(row, ['sentenceId', 'quoteId', 'decision', 'reason', 'restrictions', 'inferences']);
    if (typeof row.sentenceId !== 'string' || targets.get(row.sentenceId) !== row.quoteId || seen.has(row.sentenceId)) fail('source_coverage_mismatch');
    seen.add(row.sentenceId);
    if (!ARGUMENT_PROJECTION_DECISIONS.includes(row.decision)
      || typeof row.reason !== 'string' || !row.reason.trim() || row.reason !== row.reason.trim()
      || row.reason.length > 1000 || /[\u0000-\u001f\u007f]/u.test(row.reason)) fail('invalid_shape');
    array(row.restrictions, LIMITS.relations); array(row.inferences, LIMITS.groups);
    const boundToSentence = (ids: string[]) => ids.some(id => quotes.get(id)!.evidence.sentenceId === row.sentenceId);
    for (const restriction of row.restrictions) {
      closed(restriction, review.version === 3 ? ['kind', 'sourceQuoteIds', 'targetQuoteIds', 'representation']
        : ['kind', 'sourceQuoteIds', 'targetQuoteIds']);
      if (review.version === 3 && (!('representation' in restriction)
        || typeof restriction.representation !== 'string' || !['edge', 'embedded'].includes(restriction.representation))) fail('invalid_enum');
      if (restriction.kind !== 'requires_condition' && restriction.kind !== 'exception_of') fail('invalid_enum');
      anchors(restriction.sourceQuoteIds, quotes); anchors(restriction.targetQuoteIds, quotes);
      if (!boundToSentence([...restriction.sourceQuoteIds, ...restriction.targetQuoteIds])) fail('source_coverage_mismatch');
    }
    for (const inference of row.inferences) {
      closed(inference, ['conclusionQuoteIds', 'premiseQuoteIds', 'conditionQuoteIds', 'operator']);
      anchors(inference.conclusionQuoteIds, quotes); anchors(inference.premiseQuoteIds, quotes, false);
      anchors(inference.conditionQuoteIds, quotes, false);
      if (!inference.premiseQuoteIds.length && !inference.conditionQuoteIds.length) fail('source_coverage_mismatch');
      if (!['all', 'any', 'unknown'].includes(inference.operator)) fail('invalid_enum');
      if (!boundToSentence([...inference.conclusionQuoteIds, ...inference.premiseQuoteIds, ...inference.conditionQuoteIds])) fail('source_coverage_mismatch');
    }
    obligations += row.restrictions.length + row.inferences.length;
    if (obligations > LIMITS.relations + LIMITS.groups) fail('invalid_array');
  }
}
function covered(start: number, end: number, spans: { start: number; end: number }[]): boolean {
  let until = start;
  for (const span of [...spans].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (span.end <= until) continue;
    if (span.start > until) return false;
    until = Math.max(until, span.end); if (until >= end) return true;
  }
  return until >= end;
}
/** Mechanical coverage of independently named original Q obligations. No semantic guessing,
 * graph repair, keyword rules, new edges/groups or review-vote promotion. */
export function argumentProjectionSourceCoverageGaps(review: ArgumentProjectionGroundedReview,
  input: ArgumentProjectionGroundedReviewInput, projection: Pick<ArgumentContextProjection, 'nodes' | 'relations' | 'prerequisiteGroups'>):
  { gaps: ArgumentContextGap[]; incompleteScopeIds: Set<string> } {
  const gaps: ArgumentContextGap[] = [], incompleteScopeIds = new Set<string>();
  const gap = (code: ArgumentContextGap['code'], targetId?: string) => gaps.push(targetId === undefined ? { code } : { code, targetId });
  const uncertain = review.sourceCoverage.length !== input.sourceCoverageTargets.length
    || review.sourceCoverage.some(row => row.decision !== 'accept');
  if (uncertain) {
    gap('structure_unreviewed'); input.draft.scopes.forEach(scope => incompleteScopeIds.add(scope.id));
  }
  const quotes = new Map(input.quotes.map(quote => [quote.quoteId, quote.evidence]));
  const nodes = projection.nodes.filter(node => node.admission === 'admitted');
  const owns = (id: string, quoteIds: string[]) => {
    const node = nodes.find(node => node.id === id);
    return !!node && quoteIds.every(id => {
      const quote = quotes.get(id)!;
      return covered(quote.start, quote.end, node.evidence.filter(span => span.sentenceId === quote.sentenceId));
    });
  };
  const owners = (quoteIds: string[]) => nodes.filter(node => owns(node.id, quoteIds)).map(node => node.id);
  const affected = (nodeIds: string[], inference = false) => input.draft.scopes.filter(scope =>
    (!inference || ['reasoning', 'application', 'general'].includes(scope.task))
    && scope.requiredNodeIds.some(id => nodeIds.includes(id)));
  const disclosedConditions = review.sourceCoverage.filter(row => row.decision === 'accept')
    .flatMap(row => row.restrictions.filter(restriction => restriction.kind === 'requires_condition'
      && !('representation' in restriction && restriction.representation === 'embedded')));
  const sameMembers = (members: string[], quoteIds: string[]) =>
    (quoteIds.length === 0 ? members.length === 0 : members.length > 0
      && quoteIds.every(id => members.some(member => owns(member, [id])))
      && members.every(member => quoteIds.some(id => owns(member, [id]))));
  const matchesInference = (group: ArgumentContextProjection['prerequisiteGroups'][number], inference: ArgumentProjectionSourceInference) =>
    owns(group.conclusionNodeId, inference.conclusionQuoteIds) && group.operator === inference.operator && inference.operator !== 'unknown'
    && sameMembers(group.premiseNodeIds, inference.premiseQuoteIds)
    && sameMembers(group.conditionNodeIds, inference.conditionQuoteIds)
    // An independent inference inventory cannot omit a condition that the same source
    // scan disclosed for this actual conclusion. Exceptions are applicability limits.
    && disclosedConditions.filter(restriction => owns(group.conclusionNodeId, restriction.targetQuoteIds))
      .every(restriction => group.conditionNodeIds.some(member => owns(member, restriction.sourceQuoteIds)
        && group.relationIds.some(id => projection.relations.some(edge => edge.id === id
          && edge.admission === 'admitted' && edge.kind === 'requires_condition'
          && edge.sourceNodeId === member && edge.targetNodeId === group.conclusionNodeId))));
  for (const row of review.sourceCoverage.filter(row => row.decision === 'accept')) {
    for (const restriction of row.restrictions) {
      const targetIds = owners(restriction.targetQuoteIds), sourceIds = owners(restriction.sourceQuoteIds);
      if ('representation' in restriction && restriction.representation === 'embedded') {
        // Explicit v3 only: a complete original sentence contains its own restriction.
        // Cross-sentence conditions cannot use this branch to hide a missing actual edge.
        const embedded = targetIds.filter(id => sourceIds.includes(id)
          && restriction.targetQuoteIds.every(target => {
            const span = quotes.get(target)!;
            return input.quotes.find(q => q.quoteId === target)!.completeSentence
              && restriction.sourceQuoteIds.every(source => {
                const part = quotes.get(source)!;
                return part.sentenceId === span.sentenceId && part.start >= span.start && part.end <= span.end;
              });
          }));
        if (!embedded.length) {
          gap('missing_prerequisite', targetIds[0]);
          if (!targetIds.length) input.draft.scopes.forEach(scope => incompleteScopeIds.add(scope.id));
          affected(targetIds).forEach(scope => incompleteScopeIds.add(scope.id));
        }
        continue;
      }
      const edges = projection.relations.filter(edge => edge.admission === 'admitted' && edge.kind === restriction.kind
        && targetIds.includes(edge.targetNodeId) && sourceIds.includes(edge.sourceNodeId));
      if (!targetIds.length || !sourceIds.length || !edges.length) {
        gap('missing_prerequisite', targetIds[0]);
        // A missing target cannot be quarantined to a guessed existing seed.
        if (!targetIds.length) input.draft.scopes.forEach(scope => incompleteScopeIds.add(scope.id));
      }
      for (const scope of affected(targetIds)) {
        const matches = edges.some(edge => scope.requiredRelationIds.includes(edge.id)
          && scope.requiredNodeIds.includes(edge.sourceNodeId) && scope.requiredNodeIds.includes(edge.targetNodeId));
        if (!matches) { gap('scope_not_reviewed', scope.seedNodeId); incompleteScopeIds.add(scope.id); }
      }
      if (restriction.kind === 'requires_condition') {
        // Even if the semantic scan fails to enumerate an inference, it cannot both disclose
        // a required condition and approve an already-declared necessary group omitting it.
        // Do not require/create any group for a bare definition or fact. Exceptions stay out.
        for (const group of projection.prerequisiteGroups.filter(group => group.admission === 'admitted'
          && targetIds.includes(group.conclusionNodeId))) {
          if (!edges.some(edge => edge.targetNodeId === group.conclusionNodeId
            && group.conditionNodeIds.includes(edge.sourceNodeId) && group.relationIds.includes(edge.id))) {
            gap('missing_prerequisite', group.id);
            for (const scope of input.draft.scopes.filter(scope => scope.requiredGroupIds.includes(group.id))) {
              gap('scope_not_reviewed', scope.seedNodeId); incompleteScopeIds.add(scope.id);
            }
          }
        }
      }
    }
    for (const inference of row.inferences) {
      const targetIds = owners(inference.conclusionQuoteIds);
      const groups = projection.prerequisiteGroups.filter(group => group.admission === 'admitted'
        && matchesInference(group, inference));
      if (!groups.length) {
        gap('missing_prerequisite', targetIds[0]);
        if (!targetIds.length) input.draft.scopes.forEach(scope => incompleteScopeIds.add(scope.id));
      }
      for (const scope of affected(targetIds, true)) {
        if (!groups.some(group => scope.requiredGroupIds.includes(group.id))) {
          gap('scope_not_reviewed', scope.seedNodeId); incompleteScopeIds.add(scope.id);
        }
      }
    }
  }
  const disclosedInferences = review.sourceCoverage.filter(row => row.decision === 'accept').flatMap(row => row.inferences);
  for (const group of projection.prerequisiteGroups.filter(group => group.admission === 'admitted')) {
    const relevant = disclosedInferences.filter(inference => owns(group.conclusionNodeId, inference.conclusionQuoteIds));
    // Every existing group claiming a source-scanned actual conclusion must stand on its own.
    // One correct group cannot launder a second incomplete one. Multiple independently
    // disclosed legitimate routes are permitted; no group is invented for a definition/fact.
    if (relevant.length && !relevant.some(inference => matchesInference(group, inference))) {
      gap('missing_prerequisite', group.id);
      for (const scope of input.draft.scopes.filter(scope => scope.requiredGroupIds.includes(group.id))) {
        gap('scope_not_reviewed', scope.seedNodeId); incompleteScopeIds.add(scope.id);
      }
    }
  }
  return { gaps, incompleteScopeIds };
}

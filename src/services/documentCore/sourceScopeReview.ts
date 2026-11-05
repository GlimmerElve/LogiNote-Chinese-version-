import type { CoreDerivationResult } from './derivation';
import type { CoreArgumentInput } from './types';

/** A source envelope is not an assertion identity or a logical relation. This
 * sidecar exposes existing subarguments for review without changing the graph. */
export function reviewCoreSourceScopes(input: CoreArgumentInput, result: CoreDerivationResult) {
  const nodes = new Map(result.graph.nodes.map(node => [node.id, node]));
  const passages = new Map(input.passages.map(p => [p.id, p.text]));
  if (nodes.size !== result.graph.nodes.length) throw new Error('重复节点身份');
  for (const node of nodes.values()) {
    if (!node.source.length) throw new Error('缺少原文范围');
    for (const span of node.source) {
      const text = passages.get(span.chunkId);
      if (text === undefined || !Number.isInteger(span.start) || !Number.isInteger(span.end)
        || span.start < 0 || span.end <= span.start || span.end > text.length) throw new Error('原文范围失效');
    }
  }
  const steps = result.derivation.steps;
  for (const step of steps) if (![step.conclusion, ...step.premises].every(id => nodes.has(id))) throw new Error('步骤引用失效');
  // A multi-source material may combine independent assertions. Do not infer a
  // decomposition from just one matching source or from overlapping quotes.
  const contains = (outer: string, inner: string) => {
    const a = nodes.get(outer)!, b = nodes.get(inner)!;
    if (a.source.length !== 1 || b.source.length !== 1) return false;
    const x = a.source[0], y = b.source[0];
    return x.chunkId === y.chunkId && x.start <= y.start && x.end >= y.end
      && (x.start < y.start || x.end > y.end);
  };
  const targets = [...new Set(steps.map(s => s.conclusion))];
  const coreIds = new Set(result.chains.map(c => c.claimId));
  const premiseSteps = (id: string) => steps.filter(s => s.premises.includes(id)).map(s => s.id);
  const containers = result.graph.nodes.filter(n => coreIds.has(n.id) || premiseSteps(n.id).length);
  const closure = (seed: string) => {
    const visited = new Set<string>(), usedSteps = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return; visited.add(id);
      for (const step of steps.filter(s => s.conclusion === id)) {
        usedSteps.add(step.id); for (const premise of step.premises) visit(premise);
      }
      // Preserve an explicitly refuted prediction; never follow outgoing
      // support into unrelated downstream conclusions sharing this premise.
      for (const step of steps.filter(s => s.kind === 'oppose' && s.premises.includes(id))) visit(step.conclusion);
    };
    visit(seed);
    return { nodeIds: result.graph.nodes.filter(n => visited.has(n.id)).map(n => n.id),
      steps: structuredClone(steps.filter(s => usedSteps.has(s.id))) };
  };
  const mismatches = containers.flatMap(container => {
    const children = targets.filter(id => contains(container.id, id));
    if (!children.length) return [];
    return [{ containerId: container.id, uses: { selectedRoot: coreIds.has(container.id), premiseOfSteps: premiseSteps(container.id) },
      status: 'source-containment-only-needs-semantic-review' as const,
      subarguments: children.map(targetId => ({ targetId, ...closure(targetId),
        source: structuredClone(nodes.get(targetId)!.source) })) }];
  });
  const proven = new Set(result.chains.flatMap(c => c.nodeIds));
  const reviewNodes = new Set(mismatches.flatMap(m => m.subarguments.flatMap(s => s.nodeIds)));
  return { version: 'core-source-scope-review-v1' as const, mismatches,
    originalOutsideSelectedChains: result.graph.nodes.filter(n => !proven.has(n.id)).map(n => n.id),
    newlyVisibleInReviewOnly: result.graph.nodes.filter(n => !proven.has(n.id) && reviewNodes.has(n.id)).map(n => n.id),
    boundary: { organisationalOnly: true, graphChanged: false, rootSupportInherited: false,
      automaticallyAddedEdges: 0, semanticCertified: false, productionWrites: false } as const };
}

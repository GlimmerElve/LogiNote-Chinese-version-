/** Local supplement guard. It protects selected material, not semantic correctness. */
export interface GuardRelation {
  id: string;
  kind: string;
  from: string[];
  to: string;
  reason: string;
}
export interface GuardGraph {
  nodes: {id: string; text?: string}[];
  relations: GuardRelation[];
}
export interface GuardPacket {
  nodeIds: string[];
  relations: GuardRelation[];
  seedIds?: string[];
}

function requireCondition(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const edgeValue = (edge: GuardRelation) => JSON.stringify({
  id: edge.id, kind: edge.kind, from: edge.from, to: edge.to, reason: edge.reason,
});

/** Admit the entity proposal atomically, or retain the body packet unchanged. */
export function protectBodyPacket(input: {
  graph: GuardGraph;
  body: GuardPacket;
  entity: GuardPacket;
  hardNodes?: number;
  hardRelations?: number;
}) {
  const {graph, body, entity} = input;
  const hardNodes = input.hardNodes ?? 24, hardRelations = input.hardRelations ?? 36;
  requireCondition(Number.isInteger(hardNodes) && hardNodes > 0, 'invalid_node_budget');
  requireCondition(Number.isInteger(hardRelations) && hardRelations >= 0, 'invalid_relation_budget');
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const edges = new Map(graph.relations.map(r => [r.id, r]));
  requireCondition(nodes.size === graph.nodes.length && edges.size === graph.relations.length, 'duplicate_graph_id');
  const validate = (packet: GuardPacket) => {
    const ids = new Set(packet.nodeIds), edgeIds = new Set(packet.relations.map(r => r.id));
    requireCondition(ids.size === packet.nodeIds.length && edgeIds.size === packet.relations.length, 'duplicate_packet_id');
    for (const id of ids) requireCondition(nodes.has(id), 'unknown_packet_node:' + id);
    for (const seed of packet.seedIds ?? []) requireCondition(ids.has(seed), 'seed_outside_packet:' + seed);
    for (const r of packet.relations) {
      const original = edges.get(r.id);
      requireCondition(original && edgeValue(original) === edgeValue(r), 'modified_or_unknown_relation:' + r.id);
      requireCondition(r.from.length > 0 && new Set(r.from).size === r.from.length && !r.from.includes(r.to), 'invalid_relation:' + r.id);
      requireCondition([r.to, ...r.from].every(id => ids.has(id)), 'split_relation_package:' + r.id);
    }
  };
  validate(body); validate(entity);
  requireCondition(body.nodeIds.length <= hardNodes && body.relations.length <= hardRelations, 'body_exceeds_budget');
  const requestedNodes = new Set([...body.nodeIds, ...entity.nodeIds]);
  const requestedEdges = new Set([...body.relations, ...entity.relations].map(r => r.id));
  const admitted = requestedNodes.size <= hardNodes && requestedEdges.size <= hardRelations;
  const chosenNodes = admitted ? requestedNodes : new Set(body.nodeIds);
  const chosenEdges = admitted ? requestedEdges : new Set(body.relations.map(r => r.id));
  // Original source order, original edge values. No induced or transitive edges are created.
  const nodeIds = graph.nodes.filter(n => chosenNodes.has(n.id)).map(n => n.id);
  const relations = graph.relations.filter(r => chosenEdges.has(r.id)).map(r => ({...r, from: [...r.from]}));
  const seedIds = [...new Set([...(body.seedIds ?? []), ...(admitted ? entity.seedIds ?? [] : [])])];
  return {
    revision: 'entity-packet-guard-v1', nodeIds, relations, seedIds,
    supplement: {
      admitted, decision: admitted ? 'whole_proposal_admitted' : 'whole_proposal_deferred',
      requestedNodes: requestedNodes.size, requestedRelations: requestedEdges.size,
      addedNodeIds: nodeIds.filter(id => !body.nodeIds.includes(id)),
      addedRelationIds: relations.filter(r => !body.relations.some(b => b.id === r.id)).map(r => r.id),
      deferredNodeIds: admitted ? [] : entity.nodeIds.filter(id => !body.nodeIds.includes(id)),
      deferredRelationIds: admitted ? [] : entity.relations.filter(r => !body.relations.some(b => b.id === r.id)).map(r => r.id),
    },
    budgets: {hardNodes, hardRelations}, bodyMaterialEvicted: false,
    protectsSelectedBodyPacketOnly: true, wholeProposalOrNone: true,
    sameBudgetComparison: false, semanticCertified: false, coreferenceCertified: false,
    edgesCreated: 0, cloudRequests: 0, productionWrites: 0,
  };
}

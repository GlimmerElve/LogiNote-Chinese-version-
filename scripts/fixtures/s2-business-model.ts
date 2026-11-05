import type { S2CanvasDefinition, S2DesignBrief } from '../../src/types/sceneS2';
import type { S2BusinessPackage } from '../../src/types/sceneS2Business';

/** Synthetic protocol fixture only. This does NOT assess real business sufficiency,
 * choose tools for a goal, or certify that a learner exercise can achieve that goal. */
export function syntheticS2Business(definition: S2CanvasDefinition, brief?: S2DesignBrief): S2BusinessPackage {
  const type = definition.blockTypes[0];
  if (!type) throw new Error('Synthetic business fixture needs one real installed content block type');
  const referenceId = 'PrivateSyntheticAnswer', stepId = 'SyntheticDiscussion';
  const requirements = brief?.requirements ?? definition.designBrief?.requirements ?? [{ id: 'SyntheticRequirement' }];
  return {
    version: 1,
    purpose: 'Synthetic protocol fixture; not semantic acceptance or business capability evidence',
    knowledge: [],
    workflow: [{ id: stepId, goal: 'Discuss a synthetic editable content block', actor: 'agent', capabilities: [],
      input: 'Synthetic user text', output: 'User-authored synthetic content, not an automatic business result' }],
    completion: { mode: 'canvas', reference: { nodes: [{ id: referenceId, type: type.id, position: { x: 0, y: 0 },
      values: Object.fromEntries(type.fields.map(field => [field.id, 'Synthetic solution; private protocol fixture only'])) }], edges: [] },
      targetNodeIds: [referenceId], coverage: requirements.map(requirement => ({ requirementId: requirement.id,
        stepIds: [stepId], nodeIds: [referenceId] })) },
    criteria: [],
  };
}

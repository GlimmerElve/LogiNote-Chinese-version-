import type { MasteryShadowState, MasteryShadowLayer, MasteryShadowLayerState } from '../../src/services/masteryShadow/types';

/** Synthetic complete-layer states for presentation tests only, never a production migration. */
export function setMasteryLayerFixture(state: MasteryShadowState, layer: MasteryShadowLayer, value: MasteryShadowLayerState) {
  const record = state.layers[layer];
  record.state = value;
  record.independentPasses = value === 'confirmed' ? 2 : value === 'provisional' ? 1 : 0;
  for (const criterion of Object.values(record.criteria || {})) {
    criterion.state = value; criterion.independentPasses = record.independentPasses;
    criterion.unresolvedFailures = value === 'needs_review' ? 1 : 0;
    criterion.recentEvidenceIds = value === 'unassessed' ? [] : ['synthetic-criterion-evidence'];
  }
}

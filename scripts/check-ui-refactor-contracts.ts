import assert from 'node:assert/strict';
import {
  APP_VIEW_SHELL_POLICY,
  FLOW_EXIT_POLICY,
  FLOW_TRANSCRIPT_POLICY,
  REVIEW_EVIDENCE_POLICY,
  SURFACE_SHELL_POLICY,
  UI_REFACTOR_CONTRACT_VERSION,
  type RefactorSurfaceId,
} from '../src/services/ui/refactorContracts';
import type { ViewMode } from '../src/types';

assert.equal(UI_REFACTOR_CONTRACT_VERSION, 1);

const focusSurfaces: RefactorSurfaceId[] = [
  'flow-session',
  'review-session',
  'scene-s1',
  'scene-s4',
];
for (const surface of focusSurfaces) {
  const policy = SURFACE_SHELL_POLICY[surface];
  assert.equal(policy.shell, 'focus');
  assert.equal(policy.showGlobalHeader, false, `${surface} 不得显示全局 Header`);
  assert.equal(policy.showGlobalSidebar, false, `${surface} 不得显示全局 Sidebar`);
  assert.equal(policy.ownsNavigation, true, `${surface} 必须自己提供退出/返回`);
}

assert.equal(SURFACE_SHELL_POLICY.editor.showGlobalSidebar, true);
assert.equal(SURFACE_SHELL_POLICY.graph.showGlobalSidebar, false);
assert.equal(SURFACE_SHELL_POLICY.home.showGlobalSidebar, false);
assert.equal(SURFACE_SHELL_POLICY.profile.showGlobalSidebar, false);
assert.equal(SURFACE_SHELL_POLICY['flow-result'].shell, 'result');
assert.equal(SURFACE_SHELL_POLICY['flow-result'].showGlobalHeader, true);
assert.equal(SURFACE_SHELL_POLICY['argument-editor'].shell, 'standalone');

const allViewModes: ViewMode[] = [
  'editor', 'graph', 'timeline', 'plan', 'settings', 'learn', 'flow', 'review',
  'bubble', 'documents', 'home', 'profile', 'profile-evidence', 'argument', 'scene',
];
assert.deepEqual(Object.keys(APP_VIEW_SHELL_POLICY).sort(), [...allViewModes].sort());
for (const view of ['flow', 'review', 'scene'] as const) {
  assert.equal(APP_VIEW_SHELL_POLICY[view].shell, 'focus');
  assert.equal(APP_VIEW_SHELL_POLICY[view].showGlobalHeader, false);
  assert.equal(APP_VIEW_SHELL_POLICY[view].showGlobalSidebar, false);
}
assert.equal(APP_VIEW_SHELL_POLICY.bubble.shell, 'workspace');
assert.equal(APP_VIEW_SHELL_POLICY.bubble.showGlobalHeader, true);
assert.equal(APP_VIEW_SHELL_POLICY.editor.showGlobalSidebar, true);
assert.equal(APP_VIEW_SHELL_POLICY.argument.shell, 'standalone');

assert.equal(FLOW_EXIT_POLICY.analysisOff, 'save_only');
assert.equal(FLOW_EXIT_POLICY.analysisOn, 'save_then_analyze');
assert.equal(FLOW_EXIT_POLICY.alwaysSaveBeforeExit, true);
assert.equal(FLOW_EXIT_POLICY.analysisFailureMustNotRollbackSave, true);

assert.equal(FLOW_TRANSCRIPT_POLICY.preserveRawTranscript, true);
assert.equal(FLOW_TRANSCRIPT_POLICY.optionalLlmOutputRole, 'analysis_copy_only');
assert.equal(FLOW_TRANSCRIPT_POLICY.embeddingModelRole, 'similarity_and_segmentation_only');
assert.equal(FLOW_TRANSCRIPT_POLICY.scoreAgainst, 'raw_transcript');

assert.equal(REVIEW_EVIDENCE_POLICY.minimumMasterySamples, 2);
assert.equal(REVIEW_EVIDENCE_POLICY.hiddenReasoningMustNotBeDisplayed, true);

console.log('UI refactor contracts check passed');

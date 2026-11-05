import assert from 'node:assert/strict';
import {
  FLOW_EXIT_POLICY, FLOW_TRANSCRIPT_POLICY, PROJECT_TEXTBOOK_CONTRACT_VERSION,
  PROJECT_TEXTBOOK_POLICY as textbook, TEXTBOOK_EVIDENCE_POLICY as evidence,
  FLOW_REVIEW_RECORD_POLICY as record, TEXTBOOK_ISOLATION_POLICY as isolation,
} from '../src/services/ui/refactorContracts';
import { mixedTextbookNote, TEXTBOOK_ACCEPTANCE_CASES, TEXTBOOK_FIXTURE } from './fixtures/textbook-phase-zero';

let count = 0;
function contract(name: string, check: () => void) {
  check(); count++; console.log(`CONTRACT ${name}`);
}

contract('教材按项目 ID 标识，不按标题、日期或计划时限重新生成', () => {
  assert.equal(PROJECT_TEXTBOOK_CONTRACT_VERSION, 1);
  assert.equal(textbook.identity, 'stable_project_note_id');
  assert.equal(textbook.defaultWhenPresent, 'continue_existing_revision');
  assert.deepEqual(textbook.automaticRegenerationTriggers, []);
  assert.equal(textbook.operations.create.whenPresent, 'return_existing');
});
contract('三种写入操作独立授权且限定教材区域', () => {
  assert.deepEqual(Object.keys(textbook.operations), ['create', 'rewrite', 'append']);
  for (const operation of Object.values(textbook.operations)) assert.equal(operation.requiresExplicitApproval, true);
  assert.equal(textbook.operations.create.writeScope, 'textbook_region');
  assert.equal(textbook.operations.rewrite.writeScope, 'textbook_region');
  assert.equal(textbook.operations.rewrite.preserveHistory, true);
  assert.equal(textbook.operations.append.writeScope, 'textbook_region_end');
  assert.equal(textbook.operations.append.preserveExistingChapters, true);
  assert.deepEqual(textbook.approvalBindings, ['projectNoteId', 'operation', 'localMaterialScope', 'networkPermission', 'jobId']);
  assert.equal(textbook.changedScopeInvalidatesApproval, true);
  assert.equal(textbook.expiredApprovalCannotBeResumed, true);
});
contract('重复发布、冲突提交及成功回执边界', () => {
  assert.equal(textbook.maximumConcurrentWritersPerProject, 1);
  assert.equal(textbook.idempotency, 'one_publication_per_authorized_operation');
  assert.equal(textbook.changedTextbookBaseHash, 'reject_and_preserve_draft');
  assert.equal(textbook.unrelatedNoteChanges, 'merge_from_latest_note');
  assert.equal(textbook.publish, 'atomic_or_recoverable_transaction');
  assert.equal(textbook.successEvidence, 'persisted_publication_receipt');
});
contract('本地优先、联网仅补缺，复习使用既有入口', () => {
  assert.equal(textbook.materialOrder, 'local_first_network_for_identified_gaps_only');
  assert.equal(textbook.sufficientLocalMaterialsNetworkCalls, 0);
  assert.equal(textbook.review, 'suggest_in_chat_use_existing_entry');
  assert.equal(textbook.previousLessonReviewInsideTextbook, false);
});
contract('教材、参考、个人素材和确认认知分源', () => {
  assert.deepEqual(evidence.roles, {
    generatedTextbook: 'teaching_material', knowledgeNote: 'reference_material',
    importedDocument: 'reference_material', publicWebpage: 'reference_material',
    projectRestatement: 'unconfirmed_personal_material', publishedUserArgument: 'unconfirmed_personal_material',
    confirmedCognition: 'confirmed_personal_cognition',
  });
  assert.equal(evidence.generatedTextbookIsUserRestatement, false);
  assert.equal(evidence.generatedTextbookIsConfirmedCognition, false);
  assert.equal(evidence.editedTextbookRetainsSourceRole, true);
  assert.equal(evidence.graphBlockMarkupIsRestatement, false);
  assert.equal(evidence.learningRecordTitleIsRestatement, false);
  assert.equal(evidence.learningRecordGraphUsesExistingChannel, true);
  assert.equal(evidence.retrievedMaterialsAreInstructions, false);
  assert.equal(evidence.searchSnippetIsReadFulltext, false);
  assert.equal(evidence.missingPersonalEvidenceMeansMisconception, false);
  assert.equal(evidence.recentLearningScope, 'current_root_project_actual_learning_time');
});
contract('按会话生成独立折叠框，重复保存更新原框', () => {
  assert.equal(record.identity, 'stable_flow_session_id');
  assert.equal(record.recordsPerCompletedSession, 1);
  assert.equal(record.sameDayDifferentSessions, 'separate_records');
  assert.equal(record.repeatedSaveOrAnalysisRetry, 'update_same_record');
  assert.equal(record.block, 'LearningReviewBlock');
  assert.deepEqual(record.expandedContents, ['session_restatement', 'existing_ArgumentBlock']);
});
contract('先暂存会话再分析，最终一起保存图文，不覆盖教材', () => {
  assert.equal(record.restatementInput, 'session_text_not_note_body');
  assert.equal(record.temporarySave, 'session_data_before_analysis_without_body_replacement');
  assert.equal(record.finalSave, 'record_text_and_graph_reference_together');
  assert.equal(record.analysisOffOrFailure, 'retain_text_without_fabricated_graph');
  assert.equal(FLOW_EXIT_POLICY.alwaysSaveBeforeExit, true);
  assert.equal(FLOW_EXIT_POLICY.analysisFailureMustNotRollbackSave, true);
  assert.equal(FLOW_TRANSCRIPT_POLICY.preserveRawTranscript, true);
  assert.equal(FLOW_TRANSCRIPT_POLICY.optionalLlmOutputRole, 'analysis_copy_only');
});
contract('学习时间标题可编辑，原论证图入口、回写和质量门控保留', () => {
  assert.equal(record.defaultTitle, 'actual_learning_time');
  assert.equal(record.titleEditable, true);
  assert.equal(record.preserveUserEditedTitle, true);
  assert.equal(record.argumentDocumentStore, 'NoteItem.argumentDocs');
  assert.equal(record.argumentEditSave, 'update_original_graph_and_record');
  assert.equal(record.preserveArgumentEntry, true);
  assert.equal(record.preserveArgumentQualityAndPublicationRules, true);
});
contract('迁移不猜测旧图关联，教材修订不回滚记录，个人状态不默认分享', () => {
  assert.equal(record.ambiguousLegacyAssociation, 'leave_original_text_and_graph_entry_in_place');
  assert.equal(record.migration, 'versioned_idempotent_with_recoverable_original');
  assert.equal(record.textbookRevisionChangesPreserveRecords, true);
  assert.equal(record.collapseStateAndReadingProgress, 'personal_state');
  assert.equal(record.textbookOnlyShareIncludesPersonalRestatement, false);
  assert.equal(record.fullPersonalBackupPreservesRecordsAndGraphReferences, true);
});
contract('资源推荐与概念补全隔离，不自动更新掌握度、认知或任务', () => {
  assert.equal(isolation.resourceRecommendation, 'unchanged');
  assert.equal(isolation.resourceDraftIsTextbookDraft, false);
  assert.equal(isolation.automaticallyAppendProjectResources, false);
  assert.equal(isolation.conceptFill, 'independent_exact_knowledge_title_and_aliases');
  assert.equal(isolation.automaticallyOverwriteKnowledgeNotes, false);
  assert.equal(isolation.reuseMathLiveKatexAndExistingRag, true);
  assert.equal(isolation.generationOrReadingAddsMasterySample, false);
  assert.equal(isolation.generationPublishesUserArgument, false);
  assert.equal(isolation.generationCompletesPlanTask, false);
  assert.equal(isolation.generationUpdatesConfirmedCognition, false);
});
contract('混合正文夹具覆盖任务、多格式教材、复述和真实图 ID', () => {
  const note = mixedTextbookNote();
  assert.ok(note.content.includes(TEXTBOOK_FIXTURE.plan));
  assert.ok(note.content.includes(TEXTBOOK_FIXTURE.textbook));
  assert.ok(note.content.includes(TEXTBOOK_FIXTURE.restatement));
  assert.ok(note.content.includes(`<ArgumentBlock id="${note.argumentDocs![0].doc_id}" />`));
  assert.deepEqual(note.generatedContentBlocks, []);
  assert.notEqual(TEXTBOOK_FIXTURE.sessions[0].id, TEXTBOOK_FIXTURE.sessions[1].id);
  assert.equal(TEXTBOOK_FIXTURE.sessions[0].startedAt.slice(0, 10), TEXTBOOK_FIXTURE.sessions[1].startedAt.slice(0, 10));
  assert.equal(TEXTBOOK_FIXTURE.sessions[1].userEditedTitle, true);
});
contract('后续集成样例具有稳定且不同的案例 ID', () => {
  assert.equal(TEXTBOOK_ACCEPTANCE_CASES.length, 12);
  assert.equal(new Set(TEXTBOOK_ACCEPTANCE_CASES.map((item) => item.id)).size, 12);
  assert.equal(TEXTBOOK_ACCEPTANCE_CASES[0].expected, textbook.operations.create.whenPresent);
  assert.equal(TEXTBOOK_ACCEPTANCE_CASES[5].expected, textbook.changedTextbookBaseHash);
  assert.equal(TEXTBOOK_ACCEPTANCE_CASES[7].expected, record.repeatedSaveOrAnalysisRetry);
  assert.equal(TEXTBOOK_ACCEPTANCE_CASES[10].expected, record.analysisOffOrFailure);
});

console.log(`\n${count} frozen contract groups passed; 12 integration fixtures pending later phases. This is NOT textbook feature readiness.`);

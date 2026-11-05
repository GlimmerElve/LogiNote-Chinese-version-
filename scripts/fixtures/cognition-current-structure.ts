import type { FlowSession, NoteItem } from '../../src/types';
import { createFlowShadowDemo } from '../../src/services/flowShadow/demo';
import { adaptShadowRecordToFlowV2 } from '../../src/services/flowAnalysis/productionV2';
import { saveFlowReviewRecord, saveReviewArgument } from '../../src/services/textbook/reviewRecordStore';
import { savedRestatementObservations } from '../../src/services/cognition/restatements';
import { applyCognitionMutation, emptyCognitionFile } from '../../src/services/cognition/core';

/** Human-authored current production protocol fixture; never a semantic accuracy sample. */
export function currentCognitionFixture() {
  const record = createFlowShadowDemo();
  record.graph.unresolved = [{ nodeId: 'N6', reason: '合成抽取待核对项，不是用户认知错误。' }];
  const bundle = adaptShadowRecordToFlowV2(record, '合成通道判断');
  const at = record.input.observedAt;
  const base: NoteItem = { id: 'synthetic-project', title: '合成通道判断', noteType: 'project', content: '',
    createdAt: at, updatedAt: at, tags: [], links: [], backlinks: [], dueDates: [] };
  const session = { id: 'synthetic-flow', noteId: base.id, noteTitle: base.title, rootProjectId: base.id,
    startedAt: at, endedAt: at, restateText: record.input.rawText, incrementalText: record.input.rawText } as FlowSession;
  const note = saveReviewArgument(saveFlowReviewRecord(base, session, 'pending_analysis'), bundle.argumentDoc, session.id, record.input.rawText);
  const file = applyCognitionMutation(emptyCognitionFile(), { kind: 'record_restatements', observations: savedRestatementObservations([note]) }, { id: 'synthetic-ingest', at });
  return { record, bundle, note, file };
}

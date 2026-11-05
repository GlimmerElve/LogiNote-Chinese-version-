import assert from 'node:assert/strict';
import type { ArgDoc } from '../src/services/argumentDoc/types.ts';
import {
  appendArgumentIssueDecision,
  assessArgumentDoc,
  assessArgumentEvidence,
  computeArgumentRevisionHash,
  createPublishedSnapshot,
  ensureArgumentSemanticTargetSnapshots,
  getEffectiveArgumentQuality,
  isArgumentSemanticIssueTargetUnchanged,
} from '../src/services/argumentDoc/quality.ts';
import {
  normalizeArgumentSemanticReview,
  reviewArgumentQuality,
} from '../src/services/argumentDoc/semanticQuality.ts';
import {
  candidateToArgumentSourceRef,
  openArgumentSourceOriginal,
  previewArgumentSource,
  searchArgumentEvidenceCandidates,
} from '../src/services/argumentDoc/evidenceSources.ts';

function makeDoc(): ArgDoc {
  return {
    doc_id: 'doc-quality',
    title: '测试论证',
    created_at: '2026-10-02T00:00:00.000Z',
    updated_at: '2026-10-02T00:00:00.000Z',
    iteration: 1,
    status: 'draft',
    nodes: [
      { id: 's1', mainType: '定义', text: '学习负荷是处理任务时占用的认知资源。', position: { x: 0, y: 0 }, status: 'ok', issue: null, severity: null, suggestion: null, user_edited: true, collapsed: false },
      { id: 's2', mainType: '事实陈述', text: '样本中分段学习组的正确率更高。', position: { x: 0, y: 120 }, status: 'ok', issue: null, severity: null, suggestion: null, user_edited: true, collapsed: false },
      { id: 's3', mainType: '推理', text: '因此在当前条件下应优先采用分段学习。', position: { x: 0, y: 240 }, status: 'ok', issue: null, severity: null, suggestion: null, user_edited: true, collapsed: false },
    ],
    edges: [
      { id: 'e1', source: 's1', target: 's3', relation: 'support' },
      { id: 'e2', source: 's2', target: 's3', relation: 'support' },
    ],
  };
}

const rawReview = {
  dimensions: { structure: 19, clarity: 18, relationCorrectness: 27, coverage: 13, consistency: 14 },
  issues: [
    {
      target: { kind: 'node', id: 's2' },
      category: 'ungrounded-factual-claim',
      severity: 'blocker',
      explanation: '该数据型主张没有绑定来源。',
      suggestedAction: '绑定可打开的资料片段。',
    },
    {
      target: { kind: 'node', id: 's3' },
      category: 'missing-qualifier',
      severity: 'minor',
      explanation: '结论需要进一步限定适用范围。',
      suggestedAction: '补充仅适用于当前样本的限定语。',
      suggestedText: '因此，仅在当前样本与任务条件下，应优先采用分段学习。',
    },
    {
      target: { kind: 'node', id: 'fabricated' },
      category: 'ambiguous-node',
      severity: 'major',
      explanation: '伪造定位。',
      suggestedAction: '不应出现。',
    },
  ],
};

async function main(): Promise<void> {
  const doc = makeDoc();
  const semantic = normalizeArgumentSemanticReview(doc, rawReview, {
    reviewedAt: '2026-10-02T01:00:00.000Z',
    model: 'test-model',
  });
  assert.equal(semantic.score, 91);
  assert.equal(semantic.admission, 'full');
  assert.equal(semantic.issues.length, 2, '伪造节点定位应被丢弃');
  assert.equal(semantic.issues[0].severity, 'major', '缺少来源不得成为 blocker');
  assert.equal(semantic.targetSnapshots?.length, 2, '每个不同的问题目标都应保留复核时指纹');

  const deterministic = assessArgumentDoc(doc, '2026-10-02T01:00:00.000Z');
  const effective = getEffectiveArgumentQuality(deterministic, semantic);
  assert.notEqual(effective.admission, 'review_required');
  assert.equal(assessArgumentEvidence(doc).grade, 'C');

  const withNoteSource = makeDoc();
  withNoteSource.nodes[1].sources = [{
    type: 'note',
    entityId: 'note-1',
    title: '实验笔记',
    quote: '分段组正确率更高',
    verifiedAt: '2026-10-02T01:00:00.000Z',
  }];
  assert.equal(assessArgumentEvidence(withNoteSource).grade, 'B');

  const withDocumentSource = makeDoc();
  withDocumentSource.nodes[1].sources = [{
    type: 'document',
    entityId: 'document-1',
    chunkId: 'chunk-3',
    title: '实验报告',
    quote: '分段组正确率更高',
    sectionPath: ['结果'],
    verifiedAt: '2026-10-02T01:00:00.000Z',
  }];
  assert.equal(assessArgumentEvidence(withDocumentSource).grade, 'A');
  assert.notEqual(computeArgumentRevisionHash(doc), computeArgumentRevisionHash(withDocumentSource));

  let receivedWorkflow = '';
  const reviewed = await reviewArgumentQuality(doc, async (request) => {
    receivedWorkflow = request.workflow;
    return { content: '', parsedJson: rawReview, diagnostics: { responseModel: 'mock-model' } };
  });
  assert.equal(receivedWorkflow, 'argument-quality-review');
  assert.equal(reviewed.auditEntry.event, 'semantic_review');
  assert.equal(reviewed.evidence.grade, 'C');

  const snapshot = createPublishedSnapshot(doc, reviewed.deterministic, reviewed.semantic.reviewedAt, {
    semanticAssessment: reviewed.semantic,
    evidenceAssessment: reviewed.evidence,
    effectiveAdmission: reviewed.effective.admission,
  });
  assert.equal(snapshot.semanticAssessment?.revisionHash, snapshot.revisionHash);
  assert.equal(snapshot.evidenceAssessment?.grade, 'C');

  const decision = appendArgumentIssueDecision(undefined, {
    version: 1,
    issueId: reviewed.semantic.issues[0].id,
    revisionHash: snapshot.revisionHash,
    action: 'ignored',
    reason: '该数据仅用于说明样本内趋势，不外推为普遍事实。',
    decidedAt: reviewed.semantic.reviewedAt,
  });
  const docWithDecision: ArgDoc = {
    ...doc,
    rag: {
      sourceKind: 'user_graph',
      draftAssessment: reviewed.deterministic,
      semanticAssessment: reviewed.semantic,
      evidenceAssessment: reviewed.evidence,
      issueDecisions: decision,
    },
  };
  const decisionSnapshot = createPublishedSnapshot(
    docWithDecision,
    reviewed.deterministic,
    reviewed.semantic.reviewedAt,
    {
      semanticAssessment: reviewed.semantic,
      evidenceAssessment: reviewed.evidence,
      effectiveAdmission: reviewed.effective.admission,
    },
  );
  assert.equal(decisionSnapshot.issueDecisions?.[0].reason, decision[0].reason);
  assert.equal(computeArgumentRevisionHash(docWithDecision), computeArgumentRevisionHash(doc), '质量决策不得改变内容 revision');

  const edited = { ...doc, nodes: doc.nodes.map((node) => node.id === 's3' ? { ...node, text: `${node.text}但需重复实验。` } : node) };
  assert.notEqual(computeArgumentRevisionHash(edited), semantic.revisionHash, '修改主张后报告必须过期');
  assert.equal(
    isArgumentSemanticIssueTargetUnchanged(edited, semantic, semantic.issues[0]),
    true,
    '报告整体过期后，未改动节点的建议仍应可继续处理',
  );
  assert.equal(
    isArgumentSemanticIssueTargetUnchanged(edited, semantic, semantic.issues[1]),
    false,
    '目标节点已变化的建议必须失效',
  );
  const legacySemantic = { ...semantic, targetSnapshots: undefined };
  assert.equal(
    isArgumentSemanticIssueTargetUnchanged(edited, legacySemantic, legacySemantic.issues[0]),
    false,
    '旧报告缺少目标快照时应采用安全默认值',
  );
  const migratedLegacySemantic = ensureArgumentSemanticTargetSnapshots(doc, legacySemantic);
  assert.equal(
    isArgumentSemanticIssueTargetUnchanged(edited, migratedLegacySemantic, migratedLegacySemantic.issues[0]),
    true,
    '仍新鲜的旧报告应在首次修改前自动补齐目标快照',
  );

  let openedDocument = '';
  let openedNote = '';
  (globalThis as unknown as { window: unknown }).window = {
    electronAPI: {
      noteRag: {
        search: async () => [
          { noteId: 'current-note', noteType: 'knowledge', title: '当前笔记', score: 0.99, snippet: '不应自引用', matchKinds: ['note'], evidenceOrigin: 'note-passage' },
          { noteId: 'argument-only', title: '个人论证', score: 0.95, snippet: '不应当证据', matchKinds: ['argument'], evidenceOrigin: 'user-argument-doc' },
          { noteId: 'source-note', noteType: 'knowledge', title: '实验记录', score: 0.7, snippet: '实验记录显示分段组正确率更高。', matchKinds: ['note'], evidenceOrigin: 'note-passage' },
        ],
      },
      ragDocs: {
        search: async () => [{
          docId: 'document-1', fileName: '实验报告.pdf', chunkId: 'chunk-3', sectionPath: '结果 > 正确率',
          score: 0.9, snippet: '截断候选摘要',
        }],
        preview: async () => ({
          ok: true,
          preview: {
            document: { id: 'document-1', fileName: '实验报告.pdf' },
            chunks: [{ id: 'chunk-3', index: 3, sectionPath: '结果 > 正确率', content: '这是从本地 chunk 重新读取的完整证据正文。' }],
            totalChunkCount: 1,
            truncated: false,
            focusedChunkId: 'chunk-3',
          },
        }),
        open: async (docId: string) => { openedDocument = docId; return { ok: true }; },
      },
      argument: {
        openNote: async (noteId: string) => { openedNote = noteId; },
      },
    },
  };
  const candidates = await searchArgumentEvidenceCandidates('分段学习正确率', 'current-note', 8);
  assert.deepEqual(candidates.map((item) => item.id), ['document:document-1:chunk-3', 'note:source-note']);
  const documentSource = await candidateToArgumentSourceRef(candidates[0]);
  assert.match(documentSource.quote, /本地 chunk/u, '绑定资料时必须重读 chunk，不直接使用截断 snippet');
  assert.equal((await previewArgumentSource(documentSource)).subtitle, '结果 > 正确率');
  await openArgumentSourceOriginal(documentSource);
  await openArgumentSourceOriginal(await candidateToArgumentSourceRef(candidates[1]));
  assert.equal(openedDocument, 'document-1');
  assert.equal(openedNote, 'source-note');

  console.log('argument quality checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

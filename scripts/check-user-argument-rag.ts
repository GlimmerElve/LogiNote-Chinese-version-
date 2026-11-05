import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NoteRagIndexInput } from '../src/types.ts';
import type { ArgDoc, ArgNode, ArgumentSemanticAssessment } from '../src/services/argumentDoc/types.ts';
import {
  assessArgumentDoc,
  assessArgumentEvidence,
  computeArgumentIssueTargetFingerprint,
  computeArgumentRevisionHash,
  createPublishedSnapshot,
  getEffectiveArgumentQuality,
} from '../src/services/argumentDoc/quality.ts';
import {
  deleteUserArgumentNote,
  readAllUserArgumentShards,
  searchUserArguments,
  setUserArgumentDataRoot,
  syncUserArgumentNote,
  syncUserArgumentNotes,
} from '../src/electron/rag/userArgumentIndex.ts';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'loginote-user-argument-'));
const node = (id: string, mainType: ArgNode['mainType'], text: string, x: number): ArgNode => ({
  id, mainType, text, position: { x, y: 0 }, status: 'ok', issue: null, severity: null,
  suggestion: null, user_edited: true, collapsed: false,
});
const doc: ArgDoc = {
  doc_id: 'arg-doc-1',
  title: '学习动机论证',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  iteration: 1,
  status: 'draft',
  nodes: [
    node('reason', '定义', '主动回忆会迫使学习者提取信息，这是保持记忆的原因。', 0),
    node('fact', '事实陈述', '间隔后的主动回忆通常比重复阅读保留得更久。', 200),
    node('conclusion', '推理', '因此学习计划应安排间隔检索练习。', 400),
  ],
  edges: [
    { id: 'e1', source: 'fact', target: 'reason', relation: 'support' },
    { id: 'e2', source: 'reason', target: 'conclusion', relation: 'support' },
  ],
  summary: '主动回忆和间隔练习共同支撑长期保持。',
};
const assessment = assessArgumentDoc(doc, '2026-10-01T00:00:00.000Z');
assert.equal(assessment.admission, 'full');
const snapshot = createPublishedSnapshot(doc, assessment, '2026-10-01T00:00:00.000Z');
const input: NoteRagIndexInput = {
  id: 'note-1',
  title: '如何安排复习',
  content: '正文内容',
  publishedArguments: [{ argumentDocId: doc.doc_id, snapshot }],
};
const embedCalls: string[] = [];
const embed = async (text: string): Promise<number[]> => {
  embedCalls.push(text);
  return [text.includes('原因') ? 1 : 0, text.includes('结论') || text.includes('因此') ? 1 : 0];
};

try {
  setUserArgumentDataRoot(tempRoot);
  const shard = await syncUserArgumentNote(input, embed);
  assert.ok(shard);
  assert.equal(shard!.nodes.length, 3);
  assert.equal(shard!.edges.length, 2);
  assert.equal(shard!.nodes[0].origin, 'user-argument-doc');
  assert.equal(shard!.nodes[0].evidenceGrade, 'ungraded');
  assert.equal(shard!.nodes[0].qualityState, 'admitted');
  assert.equal(embedCalls.length, 3);

  // 同 revision 重建必须复用节点向量，不重复编码。
  await syncUserArgumentNote(input, embed);
  assert.equal(embedCalls.length, 3);

  // 只更改来源等元数据会产生新 revision，但节点正文未变时应复用 embedding。
  const sourceOnlyDoc = structuredClone(doc);
  sourceOnlyDoc.nodes.find((item) => item.id === 'fact')!.sources = [{
    type: 'document', entityId: 'meta-doc', chunkId: 'meta-chunk', quote: '可核验片段',
    verifiedAt: '2026-10-01T00:00:00.000Z',
  }];
  await syncUserArgumentNote({
    ...input,
    publishedArguments: [{
      argumentDocId: sourceOnlyDoc.doc_id,
      snapshot: createPublishedSnapshot(sourceOnlyDoc, assessArgumentDoc(sourceOnlyDoc, '2026-10-01T00:00:00.000Z'), '2026-10-01T00:00:00.000Z'),
    }],
  }, embed);
  assert.equal(embedCalls.length, 3, '来源变更不应重复编码未变节点');
  await syncUserArgumentNote(input, embed);
  assert.equal(embedCalls.length, 3);

  const privateIndex = path.join(tempRoot, 'user-state', 'cognition-materials');
  const files = (await readdir(privateIndex)).filter((name) => name.startsWith('user-argument-'));
  assert.equal(files.length, 1);
  const stored = JSON.parse(await readFile(path.join(privateIndex, files[0]), 'utf-8')) as { nodes: Array<{ id: string }> };
  assert.match(stored.nodes[0].id, /^note-1:arg-doc-1:arg-v1-/u);

  const results = await searchUserArguments('为什么要主动回忆', [1, 0], 5);
  assert.equal(results[0].noteId, 'note-1');
  assert.equal(results[0].evidenceOrigin, 'user-argument-doc');
  assert.equal(results[0].evidenceGrade, 'ungraded');
  assert.ok(results[0].argumentHits?.some((hit) => hit.nodeId === 'reason' && hit.match === 'direct'));
  assert.ok(results[0].argumentHits?.some((hit) => hit.nodeId === 'conclusion' && hit.match === 'expanded'));
  assert.match(results[0].relationSummary || '', /支持/u);
  assert.match(results[0].snippet, /个人知识模型/u);

  // 新版快照带语义复核与确定性证据等级；主进程必须重新核对。
  const semantic: ArgumentSemanticAssessment = {
    version: 1,
    promptVersion: 1,
    revisionHash: computeArgumentRevisionHash(doc),
    score: 98,
    admission: 'full',
    dimensions: { structure: 20, clarity: 20, relationCorrectness: 28, coverage: 15, consistency: 15 },
    issues: [{
      id: 'minor-fact-scope',
      target: { kind: 'node', id: 'fact' },
      category: 'missing-qualifier',
      severity: 'minor',
      explanation: '事实主张需要明确适用范围。',
      suggestedAction: '补充样本与条件限定。',
      suggestedText: '在当前样本和条件下，间隔后的主动回忆通常比重复阅读保留得更久。',
    }],
    targetSnapshots: [{
      target: { kind: 'node', id: 'fact' },
      fingerprint: computeArgumentIssueTargetFingerprint(doc, { kind: 'node', id: 'fact' }),
    }],
    reviewedAt: '2026-10-01T00:00:00.000Z',
    model: 'test-model',
  };
  const evidence = assessArgumentEvidence(doc, '2026-10-01T00:00:00.000Z');
  const effective = getEffectiveArgumentQuality(assessment, semantic);
  const semanticDoc: ArgDoc = {
    ...doc,
    rag: {
      sourceKind: 'user_graph',
      draftAssessment: assessment,
      semanticAssessment: semantic,
      evidenceAssessment: evidence,
      issueDecisions: [{
        version: 1,
        issueId: 'minor-fact-scope',
        revisionHash: semantic.revisionHash,
        action: 'ignored',
        reason: '当前图只讨论该样本，不作范围外推。',
        decidedAt: '2026-10-01T00:00:00.000Z',
      }],
    },
  };
  const semanticInput: NoteRagIndexInput = {
    id: 'note-semantic', title: '语义复核快照', content: '',
    publishedArguments: [{
      argumentDocId: doc.doc_id,
      snapshot: createPublishedSnapshot(semanticDoc, assessment, '2026-10-01T00:00:00.000Z', {
        semanticAssessment: semantic,
        evidenceAssessment: evidence,
        effectiveAdmission: effective.admission,
      }),
    }],
  };
  const semanticShard = await syncUserArgumentNote(semanticInput, embed);
  assert.ok(semanticShard?.nodes.every((item) => item.evidenceGrade === 'C'));
  assert.equal(semanticInput.publishedArguments?.[0].snapshot.issueDecisions?.[0].issueId, 'minor-fact-scope');
  const forgedSemantic = structuredClone(semanticInput);
  forgedSemantic.publishedArguments![0].snapshot.semanticAssessment!.score -= 1;
  assert.equal(await syncUserArgumentNote(forgedSemantic, embed), null, '篡改语义分数必须拒绝');
  const forgedDecision = structuredClone(semanticInput);
  forgedDecision.publishedArguments![0].snapshot.issueDecisions![0].issueId = 'unknown-issue';
  assert.equal(await syncUserArgumentNote(forgedDecision, embed), null, '未知问题的忽略记录必须拒绝');
  const forgedTargetSnapshot = structuredClone(semanticInput);
  forgedTargetSnapshot.publishedArguments![0].snapshot.semanticAssessment!.targetSnapshots![0].fingerprint = 'forged';
  assert.equal(await syncUserArgumentNote(forgedTargetSnapshot, embed), null, '篡改问题目标快照必须拒绝');
  await deleteUserArgumentNote('note-semantic');

  const sourcedDoc = structuredClone(doc);
  sourcedDoc.nodes.find((item) => item.id === 'fact')!.sources = [{
    type: 'document', entityId: 'source-document', chunkId: 'source-chunk', title: '学习实验.pdf',
    quote: '间隔后的主动回忆通常比重复阅读保留得更久。', verifiedAt: '2026-10-01T00:00:00.000Z',
  }];
  const sourcedAssessment = assessArgumentDoc(sourcedDoc, '2026-10-01T00:00:00.000Z');
  const sourcedSemantic: ArgumentSemanticAssessment = {
    ...semantic,
    revisionHash: computeArgumentRevisionHash(sourcedDoc),
    targetSnapshots: [{
      target: { kind: 'node', id: 'fact' },
      fingerprint: computeArgumentIssueTargetFingerprint(sourcedDoc, { kind: 'node', id: 'fact' }),
    }],
  };
  const sourcedEvidence = assessArgumentEvidence(sourcedDoc, '2026-10-01T00:00:00.000Z');
  const sourcedEffective = getEffectiveArgumentQuality(sourcedAssessment, sourcedSemantic);
  const sourcedInput: NoteRagIndexInput = {
    id: 'note-sourced', title: '带来源的论证', content: '',
    publishedArguments: [{
      argumentDocId: sourcedDoc.doc_id,
      snapshot: createPublishedSnapshot(sourcedDoc, sourcedAssessment, '2026-10-01T00:00:00.000Z', {
        semanticAssessment: sourcedSemantic,
        evidenceAssessment: sourcedEvidence,
        effectiveAdmission: sourcedEffective.admission,
      }),
    }],
  };
  const sourcedShard = await syncUserArgumentNote(sourcedInput, embed);
  assert.equal(sourcedShard?.nodes.find((item) => item.nodeId === 'fact')?.evidenceGrade, 'A');
  assert.equal(sourcedShard?.nodes.find((item) => item.nodeId === 'fact')?.sources?.[0].chunkId, 'source-chunk');
  const sourcedResults = await searchUserArguments('间隔后主动回忆', [1, 0], 10);
  assert.equal(sourcedResults.find((item) => item.noteId === 'note-sourced')?.argumentHits
    ?.find((hit) => hit.nodeId === 'fact')?.sources?.[0].entityId, 'source-document');
  await deleteUserArgumentNote('note-sourced');

  const updatedDoc = structuredClone(doc);
  updatedDoc.nodes[0].text = '主动回忆要求再次提取信息，这是长期保持的关键原因。';
  const updatedAssessment = assessArgumentDoc(updatedDoc, '2026-10-02T00:00:00.000Z');
  const updatedInput: NoteRagIndexInput = {
    ...input,
    publishedArguments: [{
      argumentDocId: updatedDoc.doc_id,
      snapshot: createPublishedSnapshot(updatedDoc, updatedAssessment, '2026-10-02T00:00:00.000Z'),
    }],
  };
  await assert.rejects(() => syncUserArgumentNote(updatedInput, async () => []), /向量生成失败/u);
  assert.equal((await readAllUserArgumentShards())[0].nodes[0].revisionHash, snapshot.revisionHash,
    '新 revision 编码失败时必须保留旧 active shard');

  // renderer 伪造质量结论或 revision 时必须 fail closed，并撤下旧 shard。
  const forged = structuredClone(input);
  forged.publishedArguments![0].snapshot.assessment.score -= 1;
  assert.equal(await syncUserArgumentNote(forged, embed), null);
  assert.equal((await readAllUserArgumentShards()).length, 0);

  await syncUserArgumentNote(input, embed);
  const limitedDoc: ArgDoc = {
    ...doc,
    doc_id: 'arg-doc-limited',
    title: '受限准入示例',
    nodes: [1, 2, 3].map((index) => ({
      ...node(`limited-${index}`, '定义', `第 ${index} 个尚未原子化的主张：${'包含多个需要继续拆分的判断。'.repeat(30)}`, index * 100),
      status: index === 1 ? 'error' as const : 'ok' as const,
    })),
    edges: [
      { id: 'le1', source: 'limited-1', target: 'limited-2', relation: 'support' },
      { id: 'le2', source: 'limited-2', target: 'limited-3', relation: 'support' },
    ],
  };
  const limitedAssessment = assessArgumentDoc(limitedDoc, '2026-10-02T00:00:00.000Z');
  assert.equal(limitedAssessment.admission, 'limited');
  const limitedShard = await syncUserArgumentNote({
    id: 'note-2', title: '待继续修正的结构', content: '',
    publishedArguments: [{
      argumentDocId: limitedDoc.doc_id,
      snapshot: createPublishedSnapshot(limitedDoc, limitedAssessment, '2026-10-02T00:00:00.000Z'),
    }],
  }, embed);
  assert.ok(limitedShard?.nodes.every((item) => item.qualityState === 'limited'));
  assert.equal((await readAllUserArgumentShards()).length, 2);
  await syncUserArgumentNotes([], embed);
  assert.equal((await readAllUserArgumentShards()).length, 0, '全量同步必须清理已删除笔记的遗留 shard');

  await syncUserArgumentNote(input, embed);
  await deleteUserArgumentNote('note-1');
  assert.equal((await readAllUserArgumentShards()).length, 0);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log('user argument rag checks passed');

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import type {
  NoteRagIndexInput,
  NoteSearchResult,
  UserArgumentNodeHit,
} from '../../types.ts';
import type {
  ArgDoc,
  ArgEdge,
  ArgNode,
  ArgumentAdmissionLevel,
  ArgumentPublishedSnapshot,
  ArgumentQualityAssessment,
  ArgumentSemanticAssessment,
  ArgumentSemanticIssue,
  ArgumentSemanticTargetSnapshot,
  ArgumentSourceRef,
} from '../../services/argumentDoc/types.ts';
import {
  ALL_ARGUMENT_TYPES,
  getNodeLayer,
} from '../../services/argumentDoc/types.ts';
import {
  assessArgumentDoc,
  assessArgumentEvidence,
  computeArgumentIssueTargetFingerprint,
  computeArgumentRevisionHash,
  getEffectiveArgumentQuality,
  rejectedEvidenceNodeIds,
} from '../../services/argumentDoc/quality.ts';
import { atomicWriteTextFile } from '../atomicWrite.ts';
import { buildDf, bm25Score, tokenize, weightedFusion } from '../hybridSearch.ts';
import { cosineSimilarity } from './embedding.ts';

export const USER_ARGUMENT_INDEX_SCHEMA_VERSION = 1;

export interface UserArgumentNodeRecord {
  id: string;
  noteId: string;
  noteTitle: string;
  argumentDocId: string;
  revisionHash: string;
  nodeId: string;
  graphTitle: string;
  mainType: ArgNode['mainType'];
  layer: ReturnType<typeof getNodeLayer>;
  text: string;
  status: ArgNode['status'];
  qualityState: 'admitted' | 'limited';
  qualityScore: number;
  evidenceGrade: ArgumentQualityAssessment['evidenceGrade'];
  origin: 'user-argument-doc';
  sources?: ArgumentSourceRef[];
  embedding: number[];
}

export interface UserArgumentEdgeRecord {
  id: string;
  noteId: string;
  argumentDocId: string;
  revisionHash: string;
  sourceArgumentId: string;
  targetArgumentId: string;
  relation: ArgEdge['relation'];
  qualityState: 'admitted' | 'limited';
}

export interface UserArgumentShard {
  schemaVersion: 1;
  noteId: string;
  noteTitle: string;
  nodes: UserArgumentNodeRecord[];
  edges: UserArgumentEdgeRecord[];
  updatedAt: string;
}

type Embedder = (text: string) => Promise<number[]>;

interface ValidatedPublication {
  argumentDocId: string;
  snapshot: ArgumentPublishedSnapshot;
  assessment: ArgumentQualityAssessment;
  effectiveAdmission: Exclude<ArgumentAdmissionLevel, 'review_required'>;
  qualityScore: number;
  evidenceGrade: ArgumentQualityAssessment['evidenceGrade'];
}

let dataRoot = '';

export function setUserArgumentDataRoot(root: string): void {
  dataRoot = root;
}

function indexDir(): string {
  if (!dataRoot) throw new Error('用户论证索引数据目录尚未初始化');
  return path.join(dataRoot, 'user-state', 'cognition-materials');
}

function noteKey(noteId: string): string {
  const value = String(noteId || '').trim();
  if (!value || value.length > 300) throw new Error('noteId 非法');
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function shardFile(noteId: string): string {
  return path.join(indexDir(), `user-argument-${noteKey(noteId)}.json`);
}

function parseShard(value: unknown, expectedNoteId?: string): UserArgumentShard | null {
  if (!value || typeof value !== 'object') return null;
  const shard = value as Partial<UserArgumentShard>;
  if (shard.schemaVersion !== USER_ARGUMENT_INDEX_SCHEMA_VERSION
    || typeof shard.noteId !== 'string' || !shard.noteId
    || (expectedNoteId !== undefined && shard.noteId !== expectedNoteId)
    || typeof shard.noteTitle !== 'string'
    || !Array.isArray(shard.nodes) || !Array.isArray(shard.edges)
    || shard.nodes.length > 10_000 || shard.edges.length > 30_000) return null;
  const nodesValid = shard.nodes.every((node) => Boolean(
    node && typeof node === 'object'
    && typeof node.id === 'string' && typeof node.text === 'string'
    && typeof node.noteId === 'string' && typeof node.argumentDocId === 'string'
    && typeof node.revisionHash === 'string' && typeof node.nodeId === 'string'
    && Array.isArray(node.embedding) && node.embedding.length > 0 && node.embedding.length <= 8192
    && node.embedding.every(isFiniteNumber)
    && (node.qualityState === 'admitted' || node.qualityState === 'limited')
    && node.origin === 'user-argument-doc'
    && (node.sources === undefined || (Array.isArray(node.sources)
      && node.sources.length <= 50
      && node.sources.every(hasValidSourceShape))),
  ));
  const edgesValid = shard.edges.every((edge) => Boolean(
    edge && typeof edge === 'object'
    && typeof edge.id === 'string' && typeof edge.sourceArgumentId === 'string'
    && typeof edge.targetArgumentId === 'string'
    && (edge.relation === 'support' || edge.relation === 'oppose')
    && (edge.qualityState === 'admitted' || edge.qualityState === 'limited'),
  ));
  return nodesValid && edgesValid ? shard as UserArgumentShard : null;
}

function compact(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : '';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasValidSourceShape(source: unknown): source is ArgumentSourceRef {
  if (!source || typeof source !== 'object') return false;
  const value = source as Partial<ArgumentSourceRef>;
  return Boolean(
    (value.type === 'note' || value.type === 'document')
    && typeof value.entityId === 'string' && value.entityId.length <= 500 && compact(value.entityId, 500)
    && typeof value.quote === 'string' && value.quote.length <= 5000 && compact(value.quote, 5000)
    && (value.chunkId === undefined || (typeof value.chunkId === 'string' && value.chunkId.length <= 500))
    && (value.type !== 'document' || (typeof value.chunkId === 'string' && compact(value.chunkId, 500)))
    && (value.title === undefined || (typeof value.title === 'string' && value.title.length <= 500))
    && (value.sectionPath === undefined || (Array.isArray(value.sectionPath)
      && value.sectionPath.length <= 30
      && value.sectionPath.every((part) => typeof part === 'string' && part.length <= 500)))
    && typeof value.verifiedAt === 'string' && !Number.isNaN(Date.parse(value.verifiedAt)),
  );
}

function hasValidNodeShape(node: unknown): node is ArgNode {
  if (!node || typeof node !== 'object') return false;
  const value = node as Partial<ArgNode>;
  const statuses = new Set(['ok', 'error', 'warning', 'suggested', 'to_delete', 'edited', 'isolated']);
  return Boolean(
    typeof value.id === 'string' && value.id.length <= 200 && compact(value.id, 200)
    && typeof value.text === 'string' && value.text.length <= 5000 && compact(value.text, 5000)
    && ALL_ARGUMENT_TYPES.includes(value.mainType as ArgNode['mainType'])
    && value.position && isFiniteNumber(value.position.x) && isFiniteNumber(value.position.y)
    && statuses.has(value.status || '')
    && (value.issue === null || (typeof value.issue === 'string' && value.issue.length <= 2000))
    && (value.suggestion === null || (typeof value.suggestion === 'string' && value.suggestion.length <= 2000))
    && (value.severity === null || (isFiniteNumber(value.severity) && value.severity >= 1 && value.severity <= 5))
    && typeof value.user_edited === 'boolean'
    && typeof value.collapsed === 'boolean'
    && (value.sources === undefined || (Array.isArray(value.sources)
      && value.sources.length <= 50
      && value.sources.every(hasValidSourceShape))),
  );
}

function hasValidEdgeShape(edge: unknown): edge is ArgEdge {
  if (!edge || typeof edge !== 'object') return false;
  const value = edge as Partial<ArgEdge>;
  return Boolean(
    typeof value.id === 'string' && value.id.length <= 200 && compact(value.id, 200)
    && typeof value.source === 'string' && value.source.length <= 200 && compact(value.source, 200)
    && typeof value.target === 'string' && value.target.length <= 200 && compact(value.target, 200)
    && (value.relation === 'support' || value.relation === 'oppose'),
  );
}

function hasValidSemanticAssessment(
  value: unknown,
  revisionHash: string,
  doc: ArgDoc,
  nodeIds: Set<string>,
  edgeIds: Set<string>,
): value is ArgumentSemanticAssessment {
  if (!value || typeof value !== 'object') return false;
  const assessment = value as Partial<ArgumentSemanticAssessment>;
  const dimensions = assessment.dimensions;
  if (assessment.version !== 1 || assessment.promptVersion !== 1
    || assessment.revisionHash !== revisionHash
    || !compact(assessment.reviewedAt, 80) || Number.isNaN(Date.parse(assessment.reviewedAt || ''))
    || !dimensions
    || !isFiniteNumber(dimensions.structure) || dimensions.structure < 0 || dimensions.structure > 20
    || !isFiniteNumber(dimensions.clarity) || dimensions.clarity < 0 || dimensions.clarity > 20
    || !isFiniteNumber(dimensions.relationCorrectness) || dimensions.relationCorrectness < 0 || dimensions.relationCorrectness > 30
    || !isFiniteNumber(dimensions.coverage) || dimensions.coverage < 0 || dimensions.coverage > 15
    || !isFiniteNumber(dimensions.consistency) || dimensions.consistency < 0 || dimensions.consistency > 15
    || !Array.isArray(assessment.issues) || assessment.issues.length > 20) return false;
  const score = Object.values(dimensions).reduce((sum, dimension) => sum + dimension, 0);
  if (assessment.score !== score) return false;
  const categories = new Set([
    'structural-invalid', 'compound-claim', 'ambiguous-node', 'type-mismatch', 'edge-direction',
    'unsupported-inference', 'missing-premise', 'missing-qualifier', 'circular-reasoning',
    'internal-conflict', 'ungrounded-factual-claim',
  ]);
  const issuesValid = assessment.issues.every((issue) => Boolean(
    issue && typeof issue.id === 'string' && compact(issue.id, 200)
    && categories.has(issue.category)
    && (issue.severity === 'blocker' || issue.severity === 'major' || issue.severity === 'minor')
    && !(issue.category === 'ungrounded-factual-claim' && issue.severity === 'blocker')
    && typeof issue.explanation === 'string' && issue.explanation.length <= 240 && compact(issue.explanation, 240)
    && typeof issue.suggestedAction === 'string' && issue.suggestedAction.length <= 200 && compact(issue.suggestedAction, 200)
    && (issue.suggestedText === undefined || (typeof issue.suggestedText === 'string' && issue.suggestedText.length <= 500))
    && issue.target && (issue.target.kind === 'graph'
      || (issue.target.kind === 'node' && typeof issue.target.id === 'string' && nodeIds.has(issue.target.id))
      || (issue.target.kind === 'edge' && typeof issue.target.id === 'string' && edgeIds.has(issue.target.id))),
  ));
  if (!issuesValid) return false;
  if (assessment.targetSnapshots !== undefined) {
    if (!Array.isArray(assessment.targetSnapshots) || assessment.targetSnapshots.length > 20) return false;
    const issueTargetKeys = new Set(assessment.issues.map((issue) => (
      `${issue.target.kind}:${issue.target.id || ''}`
    )));
    const snapshotTargetKeys = new Set<string>();
    const snapshotsValid = assessment.targetSnapshots.every((candidate) => {
      if (!candidate || typeof candidate !== 'object') return false;
      const snapshot = candidate as Partial<ArgumentSemanticTargetSnapshot>;
      const target = snapshot.target as ArgumentSemanticIssue['target'] | undefined;
      if (!target || (target.kind !== 'graph' && target.kind !== 'node' && target.kind !== 'edge')) return false;
      if (target.kind === 'node' && (!target.id || !nodeIds.has(target.id))) return false;
      if (target.kind === 'edge' && (!target.id || !edgeIds.has(target.id))) return false;
      if (target.kind === 'graph' && target.id !== undefined) return false;
      const key = `${target.kind}:${target.id || ''}`;
      if (!issueTargetKeys.has(key) || snapshotTargetKeys.has(key)) return false;
      snapshotTargetKeys.add(key);
      return typeof snapshot.fingerprint === 'string'
        && snapshot.fingerprint.length <= 200
        && Boolean(compact(snapshot.fingerprint, 200))
        && snapshot.fingerprint === computeArgumentIssueTargetFingerprint(doc, target);
    });
    if (!snapshotsValid) return false;
  }
  const expectedAdmission = assessment.issues.some((issue) => issue.severity === 'blocker') || score < 65
    ? 'review_required'
    : score >= 80 ? 'full' : 'limited';
  return assessment.admission === expectedAdmission;
}

/**
 * Electron 主进程重新执行确定性质量门，并核对语义报告的定位、分数与证据等级。
 * 旧版已发布快照仍可读；新版由 renderer 强制先生成语义复核。
 */
function validatePublication(value: unknown): ValidatedPublication | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as { argumentDocId?: unknown; snapshot?: Partial<ArgumentPublishedSnapshot> };
  const argumentDocId = compact(item.argumentDocId, 200);
  const snapshot = item.snapshot;
  if (typeof item.argumentDocId !== 'string' || item.argumentDocId.length > 200
    || !argumentDocId || !snapshot || typeof snapshot !== 'object') return null;
  if (typeof snapshot.revisionHash !== 'string' || snapshot.revisionHash.length > 200 || !compact(snapshot.revisionHash, 200)) return null;
  if (typeof snapshot.title !== 'string' || snapshot.title.length > 300 || !compact(snapshot.title, 300)) return null;
  if (snapshot.summary !== undefined && (typeof snapshot.summary !== 'string' || snapshot.summary.length > 10_000)) return null;
  if (!Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) return null;
  if (snapshot.nodes.length > 300 || snapshot.edges.length > 800) return null;
  if (!snapshot.nodes.every(hasValidNodeShape) || !snapshot.edges.every(hasValidEdgeShape)) return null;
  if (new Set(snapshot.edges.map((edge) => edge.id)).size !== snapshot.edges.length) return null;
  if (!snapshot.assessment || snapshot.assessment.evidenceGrade !== 'ungraded') return null;
  if (!compact(snapshot.publishedAt, 80) || Number.isNaN(Date.parse(snapshot.publishedAt))) return null;

  const doc: ArgDoc = {
    doc_id: argumentDocId,
    title: snapshot.title,
    created_at: snapshot.publishedAt,
    updated_at: snapshot.publishedAt,
    iteration: 0,
    status: 'draft',
    nodes: snapshot.nodes,
    edges: snapshot.edges,
    summary: snapshot.summary,
    scores: snapshot.scores,
  };
  if (computeArgumentRevisionHash(doc) !== snapshot.revisionHash) return null;
  const assessment = assessArgumentDoc(doc, snapshot.publishedAt);
  if (assessment.admission === 'review_required') return null;
  if (snapshot.assessment.admission !== assessment.admission || snapshot.assessment.score !== assessment.score) return null;
  if (!snapshot.semanticAssessment) {
    if (snapshot.evidenceAssessment || snapshot.effectiveAdmission || snapshot.issueDecisions?.length) return null;
    return {
      argumentDocId,
      snapshot: snapshot as ArgumentPublishedSnapshot,
      assessment,
      effectiveAdmission: assessment.admission,
      qualityScore: assessment.score,
      evidenceGrade: 'ungraded',
    };
  }

  const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
  const edgeIds = new Set(snapshot.edges.map((edge) => edge.id));
  if (!hasValidSemanticAssessment(snapshot.semanticAssessment, snapshot.revisionHash, doc, nodeIds, edgeIds)) return null;
  if (snapshot.issueDecisions !== undefined) {
    if (!Array.isArray(snapshot.issueDecisions) || snapshot.issueDecisions.length > 50) return null;
    const semanticIssues = new Map(snapshot.semanticAssessment.issues.map((issue) => [issue.id, issue]));
    const decisionIds = new Set<string>();
    for (const decision of snapshot.issueDecisions) {
      const issue = semanticIssues.get(decision?.issueId);
      if (!decision || decision.version !== 1 || decision.action !== 'ignored'
        || decision.revisionHash !== snapshot.revisionHash
        || typeof decision.issueId !== 'string' || !compact(decision.issueId, 200)
        || decisionIds.has(decision.issueId)
        || !issue || issue.severity === 'blocker'
        || typeof decision.reason !== 'string' || decision.reason.length > 300 || compact(decision.reason, 300).length < 4
        || typeof decision.decidedAt !== 'string' || !compact(decision.decidedAt, 80)
        || Number.isNaN(Date.parse(decision.decidedAt))) return null;
      decisionIds.add(decision.issueId);
    }
  }
  if (!snapshot.evidenceAssessment || snapshot.evidenceAssessment.revisionHash !== snapshot.revisionHash) return null;
  const evidence = assessArgumentEvidence(
    doc,
    snapshot.publishedAt,
    rejectedEvidenceNodeIds(snapshot.semanticAssessment),
  );
  if (snapshot.evidenceAssessment.grade !== evidence.grade
    || snapshot.evidenceAssessment.factualNodeCount !== evidence.factualNodeCount
    || snapshot.evidenceAssessment.coveredFactualNodeCount !== evidence.coveredFactualNodeCount
    || snapshot.evidenceAssessment.documentCoveredNodeCount !== evidence.documentCoveredNodeCount
    || snapshot.evidenceAssessment.coverageRatio !== evidence.coverageRatio) return null;
  const effective = getEffectiveArgumentQuality(assessment, snapshot.semanticAssessment);
  if (effective.admission === 'review_required' || snapshot.effectiveAdmission !== effective.admission) return null;
  return {
    argumentDocId,
    snapshot: snapshot as ArgumentPublishedSnapshot,
    assessment,
    effectiveAdmission: effective.admission,
    qualityScore: effective.score,
    evidenceGrade: evidence.grade,
  };
}

async function readShard(noteId: string): Promise<UserArgumentShard | null> {
  try {
    return parseShard(JSON.parse(await fs.readFile(shardFile(noteId), 'utf-8')), noteId);
  } catch {
    // Migration-only reuse: legacy public-cache rows are never read by search.
    try {
      return parseShard(JSON.parse(await fs.readFile(path.join(dataRoot, 'rag-index',
        `user-argument-${noteKey(noteId)}.json`), 'utf-8')), noteId);
    } catch { return null; }
  }
}

/** Preserve old derived files privately after the typed rebuild; never query them. */
export async function archiveLegacyUserArgumentShards(): Promise<void> {
  const legacy = path.join(dataRoot, 'rag-index');
  const names = await fs.readdir(legacy).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
  for (const name of names.filter((n) => /^user-argument-[a-f0-9]{32}\.json$/u.test(n))) {
    const archive = path.join(indexDir(), 'legacy');
    await fs.mkdir(archive, { recursive: true });
    // An existing archive must not be overwritten. Source is a derived shard,
    // original note and published snapshots remain untouched.
    const target = path.join(archive, `${Date.now()}-${name}`);
    await fs.rename(path.join(legacy, name), target);
  }
}

export async function readAllUserArgumentShards(): Promise<UserArgumentShard[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(indexDir());
  } catch {
    return [];
  }
  const shards = await Promise.all(names
    .filter((name) => /^user-argument-[a-f0-9]{32}\.json$/u.test(name))
    .map(async (name): Promise<UserArgumentShard | null> => {
      try {
        return parseShard(JSON.parse(await fs.readFile(path.join(indexDir(), name), 'utf-8')));
      } catch {
        return null;
      }
    }));
  return shards.filter((item): item is UserArgumentShard => Boolean(item));
}

function nodeRecordId(noteId: string, argumentDocId: string, revisionHash: string, nodeId: string): string {
  return `${noteId}:${argumentDocId}:${revisionHash}:${nodeId}`;
}

/** 原子替换一篇笔记的用户论证 shard；没有准入快照时立即撤下旧 shard。 */
export async function syncUserArgumentNote(input: NoteRagIndexInput, embed: Embedder): Promise<UserArgumentShard | null> {
  const noteId = String(input.id || '').trim();
  noteKey(noteId);
  const noteTitle = compact(input.title, 300) || '未命名笔记';
  const publications = (Array.isArray(input.publishedArguments) ? input.publishedArguments : [])
    .map(validatePublication)
    .filter((item): item is ValidatedPublication => Boolean(item));
  const target = shardFile(noteId);
  if (publications.length === 0) {
    await fs.rm(target, { force: true });
    return null;
  }

  const existing = await readShard(noteId);
  const existingNodes = new Map((existing?.nodes || []).map((node) => [node.id, node]));
  const existingNodesByContent = new Map((existing?.nodes || []).map((node) => [
    `${node.argumentDocId}\u0000${node.nodeId}\u0000${node.mainType}\u0000${node.text}`,
    node,
  ]));
  const nodes: UserArgumentNodeRecord[] = [];
  const edges: UserArgumentEdgeRecord[] = [];

  for (const publication of publications) {
    const { argumentDocId, snapshot, effectiveAdmission, qualityScore, evidenceGrade } = publication;
    const qualityState = effectiveAdmission === 'full' ? 'admitted' : 'limited';
    const idByNode = new Map<string, string>();
    for (const node of snapshot.nodes) {
      const id = nodeRecordId(noteId, argumentDocId, snapshot.revisionHash, node.id);
      idByNode.set(node.id, id);
      const prior = existingNodes.get(id) || existingNodesByContent.get(
        `${argumentDocId}\u0000${node.id}\u0000${node.mainType}\u0000${compact(node.text, 5000)}`,
      );
      const embedding = prior?.text === node.text && prior.embedding?.length
        ? prior.embedding
        : await embed(`用户论证 ${snapshot.title} ${node.mainType} ${getNodeLayer(node.mainType)} ${node.text}`);
      // 新 revision 必须完整生成后再原子切换；模型故障时保留旧 active shard。
      if (!embedding?.length) throw new Error(`节点 ${node.id} 向量生成失败`);
      nodes.push({
        id,
        noteId,
        noteTitle,
        argumentDocId,
        revisionHash: snapshot.revisionHash,
        nodeId: node.id,
        graphTitle: compact(snapshot.title, 300),
        mainType: node.mainType,
        layer: getNodeLayer(node.mainType),
        text: compact(node.text, 5000),
        status: node.status,
        qualityState,
        qualityScore,
        evidenceGrade,
        origin: 'user-argument-doc',
        sources: node.sources?.length ? structuredClone(node.sources) : undefined,
        embedding,
      });
    }
    const storedNodeIds = new Set(nodes.map((node) => node.id));
    for (const edge of snapshot.edges) {
      const sourceArgumentId = idByNode.get(edge.source);
      const targetArgumentId = idByNode.get(edge.target);
      if (!sourceArgumentId || !targetArgumentId || !storedNodeIds.has(sourceArgumentId) || !storedNodeIds.has(targetArgumentId)) continue;
      edges.push({
        id: `${noteId}:${argumentDocId}:${snapshot.revisionHash}:edge:${edge.id}`,
        noteId,
        argumentDocId,
        revisionHash: snapshot.revisionHash,
        sourceArgumentId,
        targetArgumentId,
        relation: edge.relation,
        qualityState,
      });
    }
  }

  if (nodes.length === 0) {
    await fs.rm(target, { force: true });
    return null;
  }
  const shard: UserArgumentShard = {
    schemaVersion: USER_ARGUMENT_INDEX_SCHEMA_VERSION,
    noteId,
    noteTitle,
    nodes,
    edges,
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(indexDir(), { recursive: true });
  await atomicWriteTextFile(target, JSON.stringify(shard));
  return shard;
}

/** 全量重建时同步清理已删除笔记遗留的用户论证 shard。 */
export async function syncUserArgumentNotes(inputs: NoteRagIndexInput[], embed: Embedder): Promise<void> {
  const failures: unknown[] = [];
  const liveFiles = new Set(inputs.map((input) => path.basename(shardFile(input.id))));
  for (const input of inputs) {
    try {
      await syncUserArgumentNote(input, embed);
    } catch (error) {
      failures.push(error);
      console.warn('[user-argument-rag] 索引失败:', input.title, error);
    }
  }
  let names: string[] = [];
  try {
    names = await fs.readdir(indexDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failures.push(error);
  }
  const cleanup = await Promise.allSettled(names
    .filter((name) => /^user-argument-[a-f0-9]{32}\.json$/u.test(name) && !liveFiles.has(name))
    .map((name) => fs.rm(path.join(indexDir(), name), { force: true })));
  for (const result of cleanup) if (result.status === 'rejected') failures.push(result.reason);
  // Finish all notes/pruning, but do not let a partial batch become a successful
  // saved-source receipt. The caller retains this lane for a later explicit wake.
  if (failures.length) throw new AggregateError(failures, 'user_argument_index_partial_failure');
}

export async function deleteUserArgumentNote(noteId: string): Promise<void> {
  await fs.rm(shardFile(noteId), { force: true });
}

function toHit(node: UserArgumentNodeRecord, match: UserArgumentNodeHit['match']): UserArgumentNodeHit {
  return {
    argumentId: node.id,
    argumentDocId: node.argumentDocId,
    revisionHash: node.revisionHash,
    nodeId: node.nodeId,
    mainType: node.mainType,
    layer: node.layer,
    text: node.text,
    match,
    sources: node.sources?.length ? structuredClone(node.sources) : undefined,
  };
}

function directionFor(edge: UserArgumentEdgeRecord, seedIsSource: boolean): UserArgumentNodeHit['relationDirection'] {
  if (edge.relation === 'support') return seedIsSource ? 'supports' : 'supported_by';
  return seedIsSource ? 'opposes' : 'opposed_by';
}

function relationText(seed: UserArgumentNodeRecord, neighbor: UserArgumentNodeRecord, direction: UserArgumentNodeHit['relationDirection']): string {
  if (direction === 'supports') return `“${seed.text}”支持“${neighbor.text}”`;
  if (direction === 'supported_by') return `“${seed.text}”受到“${neighbor.text}”支持`;
  if (direction === 'opposes') return `“${seed.text}”反对或削弱“${neighbor.text}”`;
  return `“${seed.text}”受到“${neighbor.text}”反对或削弱`;
}

/** 只读检索已发布用户图：节点混合检索 + 同 revision 一跳关系扩展。 */
export async function searchUserArguments(
  query: string,
  queryEmbedding: number[],
  limit = 5,
): Promise<NoteSearchResult[]> {
  const q = compact(query, 2000);
  if (!q || limit <= 0) return [];
  const shards = await readAllUserArgumentShards();
  const nodes = shards.flatMap((shard) => shard.nodes).filter((node) => node.embedding?.length);
  if (nodes.length === 0) return [];

  const texts = nodes.map((node) => `${node.graphTitle} ${node.mainType} ${node.text}`);
  const queryTokens = tokenize(q);
  const df = buildDf(texts);
  const lengths = texts.map((text) => Math.max(1, tokenize(text).length));
  const avgLength = lengths.reduce((sum, value) => sum + value, 0) / Math.max(1, lengths.length);
  const candidates = nodes.map((node, index) => ({
    node,
    text: texts[index],
    dense: queryEmbedding.length ? Math.max(0, cosineSimilarity(queryEmbedding, node.embedding)) : 0,
    sparse: bm25Score(queryTokens, texts[index], df, nodes.length, avgLength),
  })).filter((item) => item.dense >= 0.25 || item.sparse > 0);
  if (candidates.length === 0) return [];
  const fused = weightedFusion(candidates.map((item) => ({ id: item.node.id, dense: item.dense, sparse: item.sparse })), 0.40);
  const qCompact = q.replace(/\s+/gu, '').toLocaleLowerCase();
  const ranked = candidates.map((item) => {
    const exactBonus = qCompact.length >= 2 && item.text.replace(/\s+/gu, '').toLocaleLowerCase().includes(qCompact) ? 0.2 : 0;
    const qualityWeight = item.node.qualityState === 'admitted' ? 1 : 0.78;
    return { ...item, score: Math.min(1, ((fused.get(item.node.id) || 0) + exactBonus) * qualityWeight) };
  }).sort((left, right) => right.score - left.score).slice(0, Math.max(12, limit * 4));

  const shardByNote = new Map(shards.map((shard) => [shard.noteId, shard]));
  const grouped = new Map<string, {
    title: string;
    score: number;
    hits: UserArgumentNodeHit[];
    summaries: string[];
    admission: 'admitted' | 'limited';
    evidenceGrade: ArgumentQualityAssessment['evidenceGrade'];
  }>();
  for (const item of ranked) {
    const seed = item.node;
    const group = grouped.get(seed.noteId) || {
      title: seed.noteTitle,
      score: 0,
      hits: [],
      summaries: [],
      admission: seed.qualityState,
      evidenceGrade: seed.evidenceGrade,
    };
    group.score = Math.max(group.score, item.score);
    if (!group.hits.some((hit) => hit.argumentId === seed.id)) group.hits.push(toHit(seed, 'direct'));
    if (seed.qualityState === 'admitted') group.admission = 'admitted';

    const shard = shardByNote.get(seed.noteId);
    const nodeById = new Map((shard?.nodes || []).map((node) => [node.id, node]));
    const neighbors = (shard?.edges || [])
      .filter((edge) => edge.revisionHash === seed.revisionHash
        && (edge.sourceArgumentId === seed.id || edge.targetArgumentId === seed.id))
      .slice(0, 4);
    for (const edge of neighbors) {
      const seedIsSource = edge.sourceArgumentId === seed.id;
      const neighbor = nodeById.get(seedIsSource ? edge.targetArgumentId : edge.sourceArgumentId);
      if (!neighbor) continue;
      const direction = directionFor(edge, seedIsSource);
      if (!group.hits.some((hit) => hit.argumentId === neighbor.id)) {
        group.hits.push({ ...toHit(neighbor, 'expanded'), relationDirection: direction });
      }
      const summary = relationText(seed, neighbor, direction);
      if (!group.summaries.includes(summary)) group.summaries.push(summary);
    }
    grouped.set(seed.noteId, group);
  }

  return [...grouped.entries()]
    .sort((left, right) => right[1].score - left[1].score)
    .slice(0, limit)
    .map(([noteId, group]) => {
      const label = group.admission === 'admitted' ? '完整准入' : '受限准入';
      const grade = group.evidenceGrade === 'ungraded' ? '证据未评级' : `证据等级 ${group.evidenceGrade}`;
      const nodeText = group.hits.slice(0, 4).map((hit) => {
        const sourceTitles = (hit.sources || []).map((source) => source.title || source.entityId).slice(0, 2);
        return `[${hit.mainType}] ${hit.text}${sourceTitles.length ? `（来源：${sourceTitles.join('、')}）` : ''}`;
      }).join('；');
      return {
        noteId,
        title: group.title,
        score: group.score,
        snippet: `[用户论证图/个人知识模型；${label}；${grade}] ${nodeText}`.slice(0, 900),
        matchKinds: ['argument'],
        argumentHits: group.hits.slice(0, 8),
        relationSummary: group.summaries.slice(0, 4).join('；') || undefined,
        evidenceOrigin: 'user-argument-doc',
        admission: group.admission,
        evidenceGrade: group.evidenceGrade,
      } satisfies NoteSearchResult;
    });
}

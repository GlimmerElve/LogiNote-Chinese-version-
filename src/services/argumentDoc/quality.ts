import type {
  ArgDoc,
  ArgumentAdmissionLevel,
  ArgumentEvidenceAssessment,
  ArgumentIssueDecision,
  ArgumentPublishedSnapshot,
  ArgumentQualityAssessment,
  ArgumentQualityAuditEntry,
  ArgumentQualityIssue,
  ArgumentSemanticAssessment,
  ArgumentSemanticIssue,
  ArgumentSourceRef,
} from './types.ts';
import { getNodeLayer } from './types.ts';

const clamp = (value: number, max: number): number => Math.max(0, Math.min(max, Math.round(value)));

function normalizedNodeText(text: string): string {
  return String(text || '').replace(/\s+/gu, '').replace(/[，。！？；、,.!?;:'"“”‘’()[\]{}]/gu, '');
}

function hashArgumentPayload(payload: string, prefix: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const char of payload) {
    hash ^= BigInt(char.codePointAt(0) || 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${prefix}-${hash.toString(16).padStart(16, '0')}`;
}

/** 语义内容版本号：忽略画布坐标，拖拽节点不会制造新 revision。 */
export function computeArgumentRevisionHash(doc: ArgDoc): string {
  const payload = JSON.stringify({
    title: doc.title.trim(),
    nodes: doc.nodes.map((node) => ({
      id: node.id, mainType: node.mainType, role: node.role, text: node.text.trim(), status: node.status,
      issue: node.issue, severity: node.severity, suggestion: node.suggestion,
      // 缺少 source refs 时不增加字段，保持已发布 arg-v1 旧快照的 hash 兼容性。
      ...(node.sources?.length ? {
        sources: node.sources.map((source) => ({
          type: source.type,
          entityId: source.entityId,
          chunkId: source.chunkId || '',
          title: source.title || '',
          quote: source.quote.trim(),
          sectionPath: source.sectionPath || [],
          verifiedAt: source.verifiedAt,
        })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      } : {}),
    })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: doc.edges.map((edge) => ({
      source: edge.source, target: edge.target, relation: edge.relation,
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    summary: doc.summary?.trim() || '',
    scores: doc.scores || null,
  });
  return hashArgumentPayload(payload, 'arg-v1');
}

/** 只跟踪一个问题目标的语义内容，不受其他节点修改或画布拖拽影响。 */
export function computeArgumentIssueTargetFingerprint(
  doc: ArgDoc,
  target: ArgumentSemanticIssue['target'],
): string {
  if (target.kind === 'graph') return computeArgumentRevisionHash(doc);
  if (target.kind === 'edge') {
    const edge = doc.edges.find((item) => item.id === target.id);
    return hashArgumentPayload(JSON.stringify(edge
      ? { id: edge.id, source: edge.source, target: edge.target, relation: edge.relation }
      : { missing: 'edge', id: target.id || '' }), 'arg-target-v1');
  }
  const node = doc.nodes.find((item) => item.id === target.id);
  const payload = node
    ? {
        id: node.id,
        mainType: node.mainType,
        role: node.role,
        text: node.text.trim(),
        status: node.status,
        issue: node.issue,
        severity: node.severity,
        suggestion: node.suggestion,
        sources: (node.sources || []).map((source) => ({
          type: source.type,
          entityId: source.entityId,
          chunkId: source.chunkId || '',
          title: source.title || '',
          quote: source.quote.trim(),
          sectionPath: source.sectionPath || [],
          verifiedAt: source.verifiedAt,
        })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      }
    : { missing: 'node', id: target.id || '' };
  return hashArgumentPayload(JSON.stringify(payload), 'arg-target-v1');
}

/**
 * 报告整体过期不等于每个建议都失效：只有目标本身被改动时才禁止继续处理。
 * 没有目标快照的旧报告采用安全默认值，过期后要求重新复核。
 */
export function isArgumentSemanticIssueTargetUnchanged(
  doc: ArgDoc,
  semantic: ArgumentSemanticAssessment,
  issue: ArgumentSemanticIssue,
): boolean {
  if (semantic.revisionHash === computeArgumentRevisionHash(doc)) return true;
  const snapshot = semantic.targetSnapshots?.find((item) => (
    item.target.kind === issue.target.kind
    && (item.target.id || '') === (issue.target.id || '')
  ));
  return Boolean(
    snapshot
    && snapshot.fingerprint === computeArgumentIssueTargetFingerprint(doc, issue.target),
  );
}

/** 为仍然新鲜的旧版报告补齐目标快照，保证升级后首轮建议处理可以连续进行。 */
export function ensureArgumentSemanticTargetSnapshots(
  doc: ArgDoc,
  semantic: ArgumentSemanticAssessment,
): ArgumentSemanticAssessment {
  if (semantic.revisionHash !== computeArgumentRevisionHash(doc)) return semantic;
  const targetSnapshots = Array.from(new Map(semantic.issues.map((issue) => {
    const key = `${issue.target.kind}:${issue.target.id || ''}`;
    return [key, {
      target: { ...issue.target },
      fingerprint: computeArgumentIssueTargetFingerprint(doc, issue.target),
    }];
  })).values());
  return { ...semantic, targetSnapshots };
}

function isUsableSource(source: ArgumentSourceRef): boolean {
  return Boolean(
    (source.type === 'note' || source.type === 'document')
    && source.entityId?.trim()
    && source.quote?.trim()
    && (source.type !== 'document' || source.chunkId?.trim())
    && source.verifiedAt
    && !Number.isNaN(Date.parse(source.verifiedAt)),
  );
}

/**
 * 证据等级只根据用户显式绑定的可打开来源计算，不让 LLM 自行声称“已核验”。
 * A 要求 80% 事实节点有资料 chunk；B 允许可打开的笔记或资料覆盖 40%。
 */
export function assessArgumentEvidence(
  doc: ArgDoc,
  now = new Date().toISOString(),
  rejectedNodeIds: ReadonlySet<string> = new Set(),
): ArgumentEvidenceAssessment {
  const factualNodes = doc.nodes.filter((node) => node.role === 'premise' || (!node.role && node.mainType === '事实陈述'));
  const covered = factualNodes.filter((node) => !rejectedNodeIds.has(node.id) && (node.sources || []).some(isUsableSource));
  const documentCovered = factualNodes.filter((node) => !rejectedNodeIds.has(node.id) && (node.sources || [])
    .some((source) => source.type === 'document' && isUsableSource(source)));
  const coverageRatio = factualNodes.length ? covered.length / factualNodes.length : 0;
  const documentCoverageRatio = factualNodes.length ? documentCovered.length / factualNodes.length : 0;
  const grade = documentCoverageRatio >= 0.8
    ? 'A'
    : coverageRatio >= 0.4 ? 'B' : 'C';
  return {
    version: 1,
    revisionHash: computeArgumentRevisionHash(doc),
    grade,
    factualNodeCount: factualNodes.length,
    coveredFactualNodeCount: covered.length,
    documentCoveredNodeCount: documentCovered.length,
    coverageRatio: Math.round(coverageRatio * 1000) / 1000,
    evaluatedAt: now,
  };
}

/** quote 与主张不构成直接支持时，不把“有链接”误算成“有证据”。 */
export function rejectedEvidenceNodeIds(semantic?: ArgumentSemanticAssessment): Set<string> {
  return new Set((semantic?.issues || []).flatMap((issue) => (
    issue.category === 'ungrounded-factual-claim' && issue.target.kind === 'node' && issue.target.id
      ? [issue.target.id]
      : []
  )));
}

export function getEffectiveArgumentQuality(
  deterministic: ArgumentQualityAssessment,
  semantic?: ArgumentSemanticAssessment,
): { score: number; admission: ArgumentAdmissionLevel } {
  if (!semantic) return { score: deterministic.score, admission: deterministic.admission };
  const score = Math.min(deterministic.score, semantic.score);
  const hasBlocker = deterministic.admission === 'review_required'
    || semantic.admission === 'review_required'
    || semantic.issues.some((issue) => issue.severity === 'blocker');
  const admission = hasBlocker || score < 65
    ? 'review_required'
    : score >= 80 && deterministic.admission === 'full' && semantic.admission === 'full'
      ? 'full'
      : 'limited';
  return { score, admission };
}

export function appendArgumentQualityAudit(
  entries: ArgumentQualityAuditEntry[] | undefined,
  entry: ArgumentQualityAuditEntry,
): ArgumentQualityAuditEntry[] {
  return [...(entries || []), entry].slice(-20);
}

export function appendArgumentIssueDecision(
  entries: ArgumentIssueDecision[] | undefined,
  entry: ArgumentIssueDecision,
): ArgumentIssueDecision[] {
  return [
    ...(entries || []).filter((item) => !(
      item.revisionHash === entry.revisionHash && item.issueId === entry.issueId
    )),
    entry,
  ].slice(-50);
}

/**
 * 本地、确定性的第一道质量门。它只检查可证明的结构问题，不用 LLM 猜测论证真假。
 * 语义复核可在下一阶段叠加，但不得绕过 blocker。
 */
export function assessArgumentDoc(doc: ArgDoc, now = new Date().toISOString()): ArgumentQualityAssessment {
  const issues: ArgumentQualityIssue[] = [];
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const edges = Array.isArray(doc.edges) ? doc.edges : [];
  const ids = new Set<string>();
  const duplicateIds = new Set<string>();
  const textCounts = new Map<string, number>();

  for (const node of nodes) {
    if (!node.id || ids.has(node.id)) duplicateIds.add(node.id || '(空 ID)');
    ids.add(node.id);
    const normalized = normalizedNodeText(node.text);
    if (!normalized) {
      issues.push({
        code: 'empty_node', severity: 'blocker', nodeId: node.id,
        message: `节点 ${node.id || '(无 ID)'} 没有有效正文。`, suggestion: '补全该节点，或从结构图中删除它。',
      });
    } else {
      textCounts.set(normalized, (textCounts.get(normalized) || 0) + 1);
    }
    if (node.text.trim().length > 280 || (node.text.match(/[。！？!?]/gu) || []).length > 4) {
      issues.push({
        code: 'non_atomic_node', severity: 'warning', nodeId: node.id,
        message: `节点 ${node.id} 可能包含多个独立主张。`, suggestion: '拆成单一主张节点，再逐条连接证据和结论。',
      });
    }
  }

  for (const id of duplicateIds) {
    issues.push({
      code: 'duplicate_node_id', severity: 'blocker', nodeId: id,
      message: `节点 ID ${id} 重复。`, suggestion: '为重复节点分配唯一 ID，并修正相关连线。',
    });
  }

  const edgeKeys = new Set<string>();
  const relationPairs = new Map<string, Set<string>>();
  const connected = new Set<string>();
  let validEdges = 0;
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      issues.push({
        code: 'dangling_edge', severity: 'blocker', edgeId: edge.id,
        message: `连线 ${edge.id} 指向不存在的节点。`, suggestion: '删除悬空连线，或恢复它引用的节点。',
      });
      continue;
    }
    if (edge.source === edge.target) {
      issues.push({
        code: 'self_loop', severity: 'blocker', edgeId: edge.id,
        message: `连线 ${edge.id} 形成自环。`, suggestion: '连接到实际的上下文、前提、方法或结论节点。',
      });
      continue;
    }
    validEdges += 1;
    connected.add(edge.source);
    connected.add(edge.target);
    const key = `${edge.source}\u0000${edge.target}\u0000${edge.relation}`;
    if (edgeKeys.has(key)) {
      issues.push({
        code: 'duplicate_edge', severity: 'warning', edgeId: edge.id,
        message: `连线 ${edge.id} 与已有关系重复。`, suggestion: '删除重复连线，避免同一关系被重复计权。',
      });
    }
    edgeKeys.add(key);
    const pair = [edge.source, edge.target].sort().join('\u0000');
    if (edge.relation === 'support' || edge.relation === 'oppose') {
      const relations = relationPairs.get(pair) || new Set<string>();
      relations.add(edge.relation);
      relationPairs.set(pair, relations);
    }
  }

  for (const [pair, relations] of relationPairs) {
    if (relations.size > 1) {
      const [left, right] = pair.split('\u0000');
      issues.push({
        code: 'relation_conflict', severity: 'warning',
        message: `${left} 与 ${right} 同时存在支持和反对关系。`, suggestion: '核对关系方向；若确有条件差异，请拆分或补充限定节点。',
      });
    }
  }

  const duplicateTexts = Array.from(textCounts.values()).filter((count) => count > 1).length;
  if (duplicateTexts > 0) {
    issues.push({
      code: 'duplicate_claim', severity: 'warning',
      message: `存在 ${duplicateTexts} 组重复主张。`, suggestion: '合并重复节点，保留一条稳定主张及其全部关系。',
    });
  }
  if (nodes.length < 2) {
    issues.push({
      code: 'insufficient_nodes', severity: 'blocker',
      message: '论证至少需要两个有效节点。', suggestion: '补充前提/证据与结论，形成可检索的论证关系。',
    });
  } else if (validEdges === 0) {
    issues.push({
      code: 'missing_relations', severity: 'blocker',
      message: '多个节点之间没有有效关系。', suggestion: '至少标明一条支持或反对关系。',
    });
  }

  const nonEmptyRatio = nodes.length
    ? nodes.filter((node) => normalizedNodeText(node.text)).length / nodes.length
    : 0;
  const connectedRatio = nodes.length ? connected.size / nodes.length : 0;
  const edgeValidityRatio = edges.length ? validEdges / edges.length : (nodes.length <= 1 ? 0 : 0.4);
  const layers = new Set(nodes.map((node) => getNodeLayer(node.mainType, node.role)));
  const atomicRatio = nodes.length
    ? nodes.filter((node) => node.text.trim().length <= 280 && (node.text.match(/[。！？!?]/gu) || []).length <= 4).length / nodes.length
    : 0;

  const dimensions = {
    structure: clamp((nodes.length >= 2 ? 6 : 0) + connectedRatio * 10 + (duplicateIds.size === 0 ? 4 : 0), 20),
    clarity: clamp(nonEmptyRatio * 12 + atomicRatio * 8, 20),
    relationCorrectness: clamp(edgeValidityRatio * 20 + (duplicateTexts === 0 ? 5 : 2) + (issues.some((i) => i.code === 'relation_conflict') ? 0 : 5), 30),
    coverage: clamp((layers.has('concept') ? 4 : 0) + (layers.has('judgment') ? 5 : 0) + (layers.has('logic') ? 6 : 0), 15),
    consistency: clamp((duplicateTexts === 0 ? 5 : 2) + (issues.some((i) => i.code === 'relation_conflict') ? 2 : 5) + (nodes.some((n) => n.status === 'error' || (n.severity || 0) >= 4) ? 0 : 5), 15),
  };
  const score = Object.values(dimensions).reduce((sum, value) => sum + value, 0);
  const hasBlocker = issues.some((issue) => issue.severity === 'blocker');
  const admission = hasBlocker || score < 65
    ? 'review_required'
    : score >= 80 ? 'full' : 'limited';
  return {
    version: 1,
    score,
    admission,
    evidenceGrade: 'ungraded',
    dimensions,
    issues,
    evaluatedAt: now,
  };
}

export function createPublishedSnapshot(
  doc: ArgDoc,
  assessment: ArgumentQualityAssessment,
  publishedAt = new Date().toISOString(),
  options?: {
    semanticAssessment?: ArgumentSemanticAssessment;
    evidenceAssessment?: ArgumentEvidenceAssessment;
    effectiveAdmission?: ArgumentAdmissionLevel;
  },
): ArgumentPublishedSnapshot {
  const revisionHash = computeArgumentRevisionHash(doc);
  const decisionIssueIds = new Set((options?.semanticAssessment?.issues || [])
    .filter((issue) => issue.severity !== 'blocker')
    .map((issue) => issue.id));
  return {
    revisionHash,
    title: doc.title,
    nodes: structuredClone(doc.nodes),
    edges: structuredClone(doc.edges),
    summary: doc.summary,
    scores: doc.scores ? { ...doc.scores } : undefined,
    assessment,
    semanticAssessment: options?.semanticAssessment
      ? structuredClone(options.semanticAssessment)
      : undefined,
    evidenceAssessment: options?.evidenceAssessment
      ? structuredClone(options.evidenceAssessment)
      : undefined,
    issueDecisions: structuredClone((doc.rag?.issueDecisions || []).filter(
      (decision) => decision.revisionHash === revisionHash && decisionIssueIds.has(decision.issueId),
    )),
    effectiveAdmission: options?.effectiveAdmission,
    publishedAt,
  };
}

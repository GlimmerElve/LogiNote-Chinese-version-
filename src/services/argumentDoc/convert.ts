import type {
  ArgumentFunctionType,
  PreprocessResult,
  SentenceAnnotation,
  Vulnerability,
} from '../../types';
import type { ArgDoc, ArgNode, ArgEdge } from './types';
import { layoutDoc } from './layout';

/**
 * 心流复盘 → ArgDoc 转换层（拆分版）。
 *
 * - buildArgumentSkeleton：步骤① 骨架 + 生成 doc_id + 三层布局（仅进入编辑会话时调用一次）。
 * - applyVulnerabilities：步骤② 漏洞按 nodeId 增量更新节点状态（「再次提交」每次调用，复用同 doc_id）。
 * - convertFlowPreprocessToArgDoc：一次性便捷封装（= skeleton + applyVulnerabilities）。
 */

const ARGUMENT_TYPES: ArgumentFunctionType[] = [
  '定义', '命名', '对比', '假设', '举例', '事实陈述', '推理', '反例削弱', '建议对策',
];

function clampSeverity(severity: number): number {
  if (!Number.isFinite(severity)) return 1;
  return Math.min(5, Math.max(1, Math.round(severity)));
}

function severityToStatus(severity: number): ArgNode['status'] {
  const s = clampSeverity(severity);
  if (s >= 4) return 'error';
  if (s >= 2) return 'warning';
  return 'ok';
}

function synthesizeIssue(type: string, evidence: string): string {
  const t = type.trim();
  const ev = evidence.trim();
  if (!t) return ev || '存在论证问题';
  return ev ? `${t}：${ev}` : t;
}

export interface ConvertOptions {
  title?: string;
  /** 指定 doc_id（编辑旧图回填时复用）；缺省生成 doc_${Date.now()} */
  docId?: string;
}

/** 步骤① 骨架：SentenceAnnotation → ArgNode、ArgumentEdge → ArgEdge，立即三层布局，status 全 ok */
export function buildArgumentSkeleton(preprocess: PreprocessResult, options: ConvertOptions = {}): ArgDoc {
  const now = new Date().toISOString();

  const nodes: ArgNode[] = (preprocess.sentences || []).map((s: SentenceAnnotation) => ({
    id: s.id,
    mainType: ARGUMENT_TYPES.includes(s.mainType) ? s.mainType : '事实陈述',
    text: s.text ?? '',
    position: { x: 0, y: 0 },
    status: 'ok',
    issue: null,
    severity: null,
    suggestion: null,
    subTypes: s.subTypes,
    asrNote: s.asrNote,
    user_edited: false,
    collapsed: false,
  }));

  const validIds = new Set(nodes.map((n) => n.id));
  const edges: ArgEdge[] = [];
  for (const e of preprocess.edges || []) {
    if (!e.source || !e.target || e.source === e.target) continue;
    if (!validIds.has(e.source) || !validIds.has(e.target)) continue;
    const relation = e.relation === 'oppose' ? 'oppose' : 'support';
    edges.push({ id: `e${edges.length + 1}`, source: e.source, target: e.target, relation });
  }

  const positions = layoutDoc(nodes, edges);
  for (const n of nodes) {
    if (positions[n.id]) n.position = positions[n.id];
  }

  return {
    doc_id: options.docId ?? `doc_${Date.now()}`,
    title: options.title ?? '未命名论证',
    created_at: now,
    updated_at: now,
    iteration: 1,
    status: 'draft',
    nodes,
    edges,
  };
}

/** 步骤② 漏洞回填：按 nodeId 增量更新节点状态，返回同 doc_id 的新 doc（不重建骨架、不新增 id） */
export function applyVulnerabilities(doc: ArgDoc, vulnerabilities: Vulnerability[] = []): ArgDoc {
  const validIds = new Set(doc.nodes.map((n) => n.id));
  const bySeverity = new Map<string, Vulnerability>();
  for (const v of vulnerabilities || []) {
    if (!v.nodeId || !validIds.has(v.nodeId)) continue;
    const prev = bySeverity.get(v.nodeId);
    if (!prev || v.severity > prev.severity) bySeverity.set(v.nodeId, v);
  }

  const nodes = doc.nodes.map((n) => {
    const v = bySeverity.get(n.id);
    if (!v) return n;
    const severity = clampSeverity(v.severity);
    return {
      ...n,
      status: severityToStatus(severity),
      issue: synthesizeIssue(v.type, v.evidence),
      severity,
      suggestion: v.suggestion,
    };
  });

  return { ...doc, nodes };
}

/** 一次性便捷封装：骨架 + 漏洞回填 */
export function convertFlowPreprocessToArgDoc(
  preprocess: PreprocessResult,
  vulnerabilities: Vulnerability[] = [],
  options: ConvertOptions = {},
): ArgDoc {
  const skeleton = buildArgumentSkeleton(preprocess, options);
  return applyVulnerabilities(skeleton, vulnerabilities);
}

/**
 * 从当前 ArgDoc 反推 PreprocessResult（供「再次提交」重跑步骤②诊断用）。
 * 用户已修正画布后，以「节点正文 + 连线」作为重新诊断的输入，不重建骨架、不新增 doc_id。
 */
export function argDocToPreprocess(doc: ArgDoc): PreprocessResult {
  const sentences: SentenceAnnotation[] = doc.nodes.map((n, i) => ({
    id: n.id,
    index: i + 1,
    text: n.text,
    mainType: n.mainType,
    subTypes: n.subTypes,
    asrNote: n.asrNote,
  }));
  const edges = doc.edges.map((e) => ({
    source: e.source,
    target: e.target,
    relation: e.relation,
  }));
  return { sentences, edges };
}

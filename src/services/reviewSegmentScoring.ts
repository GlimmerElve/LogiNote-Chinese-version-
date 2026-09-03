import { KnowledgePointMasteryResult, MasteryLevel } from '../types';
import { scoreKnowledgePointMastery } from './knowledgeScoringService';
import { computeLayeredMastery } from './profile/scoring/threeLayer';

/**
 * 项目复习片段：某段对话针对的知识点集合 + 学生回答文本（评分证据原文）。
 */
export interface ReviewSegment {
  knowledgePointNames: string[];
  text: string;
}

/**
 * 容错解析 JSON：先剥离 markdown 代码围栏，再截取「首个 { 到最后一个 }」，最后 JSON.parse。
 * 失败时抛出异常，由调用方兜底。
 */
export function parseJsonLenient(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/g, '').replace(/```/g, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    return JSON.parse(stripped.trim());
  }
  return JSON.parse(stripped.slice(start, end + 1));
}

/**
 * 解析并剥离 tutor 回复末尾的 [意图:A|B] 标记。
 * 返回目标知识点列表与剥离标记后的干净文本。
 */
export function parseIntentMarker(text: string): { targets: string[]; cleanText: string } {
  const m = text.match(/\[意图[:：]([\s\S]*?)\]\s*$/);
  if (!m) return { targets: [], cleanText: text };
  const raw = m[1].trim();
  if (!raw || raw === '无') return { targets: [], cleanText: text.slice(0, m.index).trim() };
  const targets = raw.split('|').map((s) => s.trim()).filter(Boolean);
  return { targets, cleanText: text.slice(0, m.index).trim() };
}

/**
 * 对项目复习中的片段并行评分：每个片段 × 每个知识点 → 一次独立分层评分。
 * 用片段内的学生回答文本作为证据原文；单个任务失败不拖垮整体。
 */
export async function scoreReviewSegmentsInParallel(
  segments: ReviewSegment[],
  concurrency: number = 3,
): Promise<KnowledgePointMasteryResult[]> {
  // 展开为「知识点 × 片段」的评分任务
  interface Pending {
    name: string;
    text: string;
  }
  const pendings: Pending[] = [];
  for (const seg of segments) {
    for (const name of seg.knowledgePointNames) {
      pendings.push({ name, text: seg.text });
    }
  }

  const results: KnowledgePointMasteryResult[] = [];
  const limit = Math.max(1, concurrency);
  let seq = 0;

  for (let i = 0; i < pendings.length; i += limit) {
    const batch = pendings.slice(i, i + limit);
    const settled = await Promise.allSettled(
      batch.map((p) =>
        scoreKnowledgePointMastery(
          {
            id: `review-kp-${Date.now()}-${seq++}`,
            name: p.name,
            category: 'known',
            existingNoteTitle: p.name,
          },
          p.text,
        ),
      ),
    );
    for (const s of settled) {
      if (s.status === 'fulfilled') results.push(s.value);
      // rejected 的任务静默跳过
    }
  }

  return results;
}

const LEVEL_RANK: Record<MasteryLevel, number> = { concept: 1, judgment: 2, reasoning: 3 };

/** 取更高的触及层级（reasoning > judgment > concept） */
function higherLevel(a: MasteryLevel, b: MasteryLevel): MasteryLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

/** 根据合并后的三层净得分，规则生成一句话评语（方案B，不额外调 LLM） */
function buildMasteryComment(c: number, j: number, r: number): string {
  const parts: string[] = [];
  if (r > 0) parts.push('推理深入');
  else if (r < 0) parts.push('推理需加强');
  if (j > 0) parts.push('判断合理');
  else if (j < 0) parts.push('判断有偏差');
  if (c > 0) parts.push('概念清晰');
  else if (c < 0) parts.push('概念需巩固');
  if (parts.length === 0) return '表现平稳，可继续巩固';
  return parts.join('、');
}

/**
 * 合并同一知识点的多片段评分结果（同名知识点因意图切换被切到多个片段）。
 * 三层净得分对应相加；level 取最高；评语由合并后的三层得分规则生成。
 */
export function mergeSegmentResults(results: KnowledgePointMasteryResult[]): KnowledgePointMasteryResult[] {
  const map = new Map<string, KnowledgePointMasteryResult>();
  for (const r of results) {
    const existing = map.get(r.name);
    if (!existing) {
      map.set(r.name, { ...r });
      continue;
    }
    existing.conceptDelta += r.conceptDelta;
    existing.judgmentDelta += r.judgmentDelta;
    existing.reasoningDelta += r.reasoningDelta;
    existing.level = higherLevel(existing.level, r.level);
    // existingNoteTitle 保持一致（同名知识点标题相同）
  }
  const merged = Array.from(map.values());
  for (const r of merged) {
    // 合并后按累计 delta 重算联动最终分 + 评语
    const layered = computeLayeredMastery(r.conceptDelta, r.judgmentDelta, r.reasoningDelta, 50);
    r.conceptFinal = layered.conceptFinal;
    r.judgmentFinal = layered.judgmentFinal;
    r.reasoningFinal = layered.reasoningFinal;
    r.comment = buildMasteryComment(layered.conceptFinal, layered.judgmentFinal, layered.reasoningFinal);
  }
  return merged;
}

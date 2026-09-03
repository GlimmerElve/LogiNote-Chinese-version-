import { ReasoningStyleStats } from './types';
import {
  CAUSAL_CONNECTORS,
  EXAMPLE_MARKERS,
  ANALOGY_MARKERS,
  DEFINITION_MARKERS,
  CONCLUSION_MARKERS,
  VAGUE_TERMS,
  ABSOLUTIST_TERMS,
} from './lexicons';

/**
 * 正则推理用语统计（纯前端确定性分析，零 AI 成本）。
 * density 统一按「每千字次数」输出；单字词条不参与匹配（避免过度误伤）。
 */

/** 统计一组词条在文本中的总出现次数（仅统计长度 ≥ 2 的词条，避免单字误匹配） */
function countMatches(text: string, words: readonly string[]): number {
  let count = 0;
  for (const w of words) {
    if (w.length < 2) continue;
    let idx = 0;
    while ((idx = text.indexOf(w, idx)) !== -1) {
      count += 1;
      idx += w.length;
    }
  }
  return count;
}

/** 每千字密度 = 出现次数 / (有效字符数 / 1000) */
function perThousand(count: number, text: string): number {
  const len = text.replace(/\s/g, '').length;
  if (len === 0) return 0;
  return (count / len) * 1000;
}

/** 结论前置比例（0-1）：按句/段切分，统计段首含结论标记的比例 */
function conclusionFirstRatio(text: string): number {
  const segments = text
    .split(/[。！？\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 4); // 过滤过短片段
  if (segments.length === 0) return 0;
  let leading = 0;
  for (const seg of segments) {
    const head = seg.slice(0, 6);
    if (CONCLUSION_MARKERS.some((m) => head.includes(m))) leading += 1;
  }
  return leading / segments.length;
}

export function analyzeReasoningStyle(text: string): ReasoningStyleStats {
  if (!text || !text.trim()) {
    return {
      causalConnectorDensity: 0,
      exampleMarkerDensity: 0,
      analogyMarkerDensity: 0,
      definitionMarkerDensity: 0,
      conclusionFirstRatio: 0,
      vagueTermDensity: 0,
      absolutistDensity: 0,
    };
  }

  return {
    causalConnectorDensity: perThousand(countMatches(text, CAUSAL_CONNECTORS), text),
    exampleMarkerDensity: perThousand(countMatches(text, EXAMPLE_MARKERS), text),
    analogyMarkerDensity: perThousand(countMatches(text, ANALOGY_MARKERS), text),
    definitionMarkerDensity: perThousand(countMatches(text, DEFINITION_MARKERS), text),
    conclusionFirstRatio: conclusionFirstRatio(text),
    vagueTermDensity: perThousand(countMatches(text, VAGUE_TERMS), text),
    absolutistDensity: perThousand(countMatches(text, ABSOLUTIST_TERMS), text),
  };
}

/** 把密度归一化到 0-1（min(每千字次数/5, 1)，便于后期调整阈值） */
export function toPreferenceRatio(densityPerThousand: number): number {
  return Math.min(densityPerThousand / 5, 1);
}
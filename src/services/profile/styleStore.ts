import {
  RawAnalysisFile,
  RawAnalysisRecord,
  StyleSnapshotFile,
  StyleTrendFile,
  WordCloudFile,
  ArgumentFunctionType,
  ExpressionStyleKind,
} from '../../types';
import {
  loadStyleRawState,
  saveStyleRawState,
  loadStyleSnapshotState,
  saveStyleSnapshotState,
  loadStyleTrendState,
  saveStyleTrendState,
  loadWordCloudState,
  saveWordCloudState,
} from '../electronUserState';
import {
  computeWeightedTypeScores,
  computeStyleDistribution,
  smoothDisplay,
  judgeStyle,
  EXPRESSION_KINDS,
  EXPRESSION_STYLE_LABELS,
} from './styleScoring';

/**
 * 表达风格 / 词云 —— 持久化层（IPC 薄封装之上的业务读写）。
 * 三个风格文件 + 一个词云文件：
 * - style-raw-analysis.json：只追加原始计数记录（不修改历史）
 * - style-snapshot.json：每次重算后整体覆盖聚合结果
 * - style-trend.json：当天快照覆盖 / 跨天追加
 * - style-wordcloud.json：按周覆盖高频惯用词
 */

/** 当前日期 YYYY-MM-DD（本地时区） */
function todayString(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本周周一 YYYY-MM-DD */
function currentWeekStart(): string {
  const now = new Date();
  const offset = now.getDay() === 0 ? 6 : now.getDay() - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - offset);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${monday.getFullYear()}-${p(monday.getMonth() + 1)}-${p(monday.getDate())}`;
}

/* ===== 原始记录层：只追加 ===== */

/** 读取 raw 文件（不存在/异常时返回空结构） */
export async function readRawAnalysis(): Promise<RawAnalysisFile> {
  const file = await loadStyleRawState();
  if (file && Array.isArray(file.records)) return file;
  return { records: [] };
}

/** 追加一条原始计数记录（原子写回由 IPC 层保证） */
export async function appendRawRecord(counts: Record<ArgumentFunctionType, number>): Promise<RawAnalysisFile> {
  const file = await readRawAnalysis();
  const record: RawAnalysisRecord = {
    analysisDate: todayString(),
    counts: { ...counts },
    createdAt: new Date().toISOString(),
  };
  file.records.push(record);
  await saveStyleRawState(file);
  return file;
}

/* ===== 聚合快照层：整体重算覆盖 ===== */

/** 读取上一次快照（用于拿 display 做平滑） */
export async function readSnapshot(): Promise<StyleSnapshotFile | null> {
  return loadStyleSnapshotState();
}

/**
 * 全量重算并覆盖 style-snapshot.json。
 * 从完整 raw 记录推导 stylePercent（未平滑），再与上次 display 做指数平滑。
 */
export async function recalcAndSaveSnapshot(): Promise<StyleSnapshotFile> {
  const raw = await readRawAnalysis();
  const weighted = computeWeightedTypeScores(raw.records);
  const { typeRatios, styleScores, stylePercent } = computeStyleDistribution(weighted);

  const prev = await readSnapshot();
  const display = smoothDisplay(prev?.display, stylePercent);

  const snapshot: StyleSnapshotFile = {
    calculatedAt: new Date().toISOString(),
    typeRatios,
    styleScores,
    stylePercent,
    display,
    conclusion: judgeStyle(stylePercent),
  };
  await saveStyleSnapshotState(snapshot);
  return snapshot;
}

/* ===== 趋势快照层：当天覆盖、跨天追加 ===== */

/** 读取 trend（不存在/异常时返回空） */
export async function readTrend(): Promise<StyleTrendFile> {
  const file = await loadStyleTrendState();
  if (file && Array.isArray(file.snapshots)) return file;
  return { snapshots: [] };
}

/** 更新当天快照（有则覆盖当天的 display，无则追加） */
export async function updateTrend(display: Record<ExpressionStyleKind, number>): Promise<void> {
  const file = await readTrend();
  const date = todayString();
  const top = EXPRESSION_KINDS.reduce((a, b) => (display[a] >= display[b] ? a : b));
  const idx = file.snapshots.findIndex((s) => s.date === date);
  const entry = { date, display: { ...display }, topStyle: EXPRESSION_STYLE_LABELS[top] };
  if (idx >= 0) {
    file.snapshots[idx] = entry;
  } else {
    file.snapshots.push(entry);
  }
  await saveStyleTrendState(file);
}

/* ===== 词云：按周覆盖 ===== */

/** 读取词云文件 */
export async function readWordCloud(): Promise<WordCloudFile> {
  const file = await loadWordCloudState();
  if (file && Array.isArray(file.weeks)) return file;
  return { weeks: [] };
}

/** 按周写入词云（覆盖当周） */
export async function upsertWeekWordCloud(
  words: Array<{ word: string; count: number }>,
): Promise<void> {
  const file = await readWordCloud();
  const weekStart = currentWeekStart();
  const idx = file.weeks.findIndex((w) => w.weekStart === weekStart);
  const entry = { weekStart, words };
  if (idx >= 0) {
    file.weeks[idx] = entry;
  } else {
    file.weeks.push(entry);
  }
  await saveWordCloudState(file);
}
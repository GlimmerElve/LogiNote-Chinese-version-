/**
 * 学习能力结构化类型（P7 v3）：
 * - 《周报落盘结构》LearningWeek 存在 mastery-timeline.json 的 weeks[]（10周滚动）
 * - 《跨周派生结构》LearningAbility 由 weeks[] + notes + flow-sessions 现算，写入 profile.learningAbility
 */

/** 每周一条的自然周快照（周一~周日），持久化在 mastery-timeline.json */
export interface LearningWeek {
  /** 周一日期 YYYY-MM-DD */
  weekStart: string;
  /** 周日日期 YYYY-MM-DD */
  weekEnd: string;

  /** ④ 趋势：本周新增掌握数（conceptMastery 从 <55 跨到 ≥55 的知识点数） */
  newMastered: number;
  /** 周末存量：已掌握知识点总数（knowledge 类型，conceptMastery ≥55） */
  masteredCount: number;

  /** ② 三层分数周报：步骤②整体论证质量 → 三层 final 分数（EMA 0.4 累积）+ 漏洞统计 */
  reasoning: {
    /** 概念层 final 分数（0-100，round(x,1)） */
    conceptScore: number;
    /** 判断层 final 分数（0-100，round(x,1)） */
    judgmentScore: number;
    /** 逻辑层 final 分数（0-100，round(x,1)） */
    logicScore: number;
    /** 本周非语音识别漏洞数 */
    vulnerabilityCount: number;
    /** 漏洞类型 → 本周次数 */
    vulnerabilityBreakdown: Record<string, number>;
  };

  /** 本周心流分析次数（errorRate 分母） */
  analysisCount: number;

  /** ③ 自律性周循环 */
  study: {
    /** 本周达标学习日天数（心流≥20分钟 或 复习≥5轮/≥150字） */
    activeDays: number;
    /** 每日心流分钟，固定 7 元素（索引 0=周一 ... 6=周日）；仅供心流模式累加 */
    dailyMinutes: number[];
    /** 每日复习是否达标（0/1），固定 7 元素；仅供复习模式标记（≥5轮 或 ≥150字） */
    dailyReviewActive: number[];
  };

  /** ⑤ 纠错：平均每条结论的推理谬误数 = 推理谬误数 / 结论总数（0~1，因单条结论最多一个 fallacyType） */
  errorRate: number;
}

/** mastery-timeline.json 顶层结构 */
export interface MasteryTimelineFile {
  version: 1;
  weeks: LearningWeek[];
}

/* ===== 跨周派生结构（现算，写入 profile.learningAbility） ===== */

/** ⑤ 纠错：单周平均每次分析的错误数趋势点（可 >1，非 0~1 比率） */
export interface ErrorWeekPoint {
  weekStart: string;
  errorRate: number;
}

/** ② 三层分数：单周趋势点 */
export interface ReasoningWeekPoint {
  weekStart: string;
  conceptScore: number;
  judgmentScore: number;
  logicScore: number;
  vulnerabilityCount: number;
}

/** ③ 自律性：单周趋势点 */
export interface StudyWeekPoint {
  weekStart: string;
  activeDays: number;
  totalMinutes: number;
}

/** ⑥ 领域：单个根项目的掌握情况 */
export interface DomainMastery {
  projectTitle: string;   // 根项目名称
  masteryRate: number;    // 0-1 掌握率
  masteredCount: number;  // 掌握知识点数（≥55）
  totalCount: number;     // 该领域知识点总数
}

/** 跨周派生的学习能力六维（写入 UserProfile.learningAbility） */
export interface LearningAbility {
  /** ① 知识规模：当前已掌握知识点总数（knowledge 类型，≥55） */
  masteredCount: number;
  /** ③ 自律性：当前连续学习天数（每天≥20分钟算学习，断则归零） */
  currentStreak: number;
  /** ④ 趋势：本周新增掌握数 */
  newMasteredThisWeek: number;
  /** ④ 趋势：上周新增掌握数 */
  newMasteredLastWeek: number;
  /** ⑤ 纠错：10 周错误率趋势 */
  errorWeekly: ErrorWeekPoint[];
  /** ② 推理分项：10 周命中率趋势 */
  reasoningWeekly: ReasoningWeekPoint[];
  /** ③ 自律性：10 周趋势 */
  studyWeekly: StudyWeekPoint[];
  /** ⑥ 领域：根项目掌握情况列表 */
  domains: DomainMastery[];
}

/** 默认学习能力（全空，供画像默认骨架使用） */
export function getDefaultLearningAbility(): LearningAbility {
  return {
    masteredCount: 0,
    currentStreak: 0,
    newMasteredThisWeek: 0,
    newMasteredLastWeek: 0,
    errorWeekly: [],
    reasoningWeekly: [],
    studyWeekly: [],
    domains: [],
  };
}

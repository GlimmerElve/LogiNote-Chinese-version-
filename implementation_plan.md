# Implementation Plan

[Overview]

把心流复盘「步骤②」从「按结论块逐条做三层布尔证据分析」重构为「对整段论证结构做整体质量评估」：LLM 接收步骤①产出的完整论证结构（原文 + 逐句类型标注 + 类型计数），一次性输出「4 个质量指标（0-4）+ 漏洞表 + 总结」的纯 JSON；前端据此计算三层分数、漏洞扣分与等级，替代旧的布尔评分链路。

本次重构的动机：步骤①已经产出清晰的「原文 + 结构标注 + 类型计数 + 结构图」，其中天然隐含概念/判断/推理三层的质量信号，无需再按 `conclusions` 拆块回炉。旧链路（`ArgumentAnalysis[]` 逐结论布尔）把"概念阐释型"复述误套"推理链"尺子、并把三层割裂打分，已多次造成"关键结论全 ✗ vs 掌握度 +70"的矛盾。新链路改为整体论证质量评估，三层分数直接来自「结构密度 + 质量指标 + 漏洞扣分」，语义自洽。

三个已确认的决策：
1. 步骤② LLM 输出**纯 JSON**（`parsedJson` 直接解析）。
2. **彻底放弃「推理子项 5 维度」**（前提/逻辑链/识别假设/演绎归纳/反事实），周报/主页改为「三层分数趋势 + 错误率（漏洞统计）」。
3. **删除 `terminologyAccuracy` / `selfCorrection`** 两个表达风格能力字段。

六个设计点（全部按默认执行）：
1. 周报 reasoning 新结构 = `{ conceptScore, judgmentScore, logicScore, vulnerabilityCount, vulnerabilityBreakdown }`。
2. 三层分数 round(x,1)，周报累积用 EMA 0.4。
3. `errorRate` 语义改为 `vulnerabilityCount / 分析次数`。
4. 主页「能力画像」雷达的「三层能力」视图保留（数值来源改为步骤② final 分数），删除「推理子项」视图及其 reasoningRates。
5. 报告面板新增 section kind `argumentQuality`（三层分数+漏洞表），删除 `reasoningArguments` / `keyIssues`。
6. 新画像三层能力直接由步骤② final 分数填充 `ability.conceptClarity/judgmentReasonableness/reasoningValidity`。

评分算法严格参照参考文档 `deepseek_python_20260910_ba2bfd.md`：结构密度指标（前端用 counts 算）+ 质量指标（LLM 输出 0-4，前端映射 0-100）+ 漏洞扣分（PENALTY_TABLE）+ 等级判定。

[Types]

`src/types.ts` 删除旧布尔链路类型、新增质量评估类型。

删除：
- `ArgumentAnalysis`（整段分析不再产逐结论布尔）
- `LayerIssue`（被 `Vulnerability` 取代）
- `ProfileInsight.arguments?`
- `ExpressionStyle` 的 `terminologyAccuracy`、`selfCorrection`（决策 3；`ExpressionStyle` 清空后作为空接口保留，避免 `UserProfile.expressionStyle` 结构破坏，后续可整删）

新增：
- `QualityIndicator { score: number; evidence: string }`（单指标：0-4 分 + 原文依据）
- `QualityIndicators { conceptClarity: QualityIndicator; exampleQuality: QualityIndicator; factSpeculation: QualityIndicator; reasoningChain: QualityIndicator }`
- `Vulnerability { type: string; severity: number; layer: '概念层'|'判断层'|'逻辑层'|'多层'|'无法判断'; evidence: string; suggestion: string }`
- `ArgumentQualityResult { quality: QualityIndicators; vulnerabilities: Vulnerability[]; summary: string }`（步骤② LLM 输出）
- `LayeredScoreResult { raw: {concept,judgment,logic}; penalty: {concept,judgment,logic}; final: {concept,judgment,logic}; grade: {concept,judgment,logic} }`（前端算）
- `ProfileInsight.layeredScores?: LayeredScoreResult`（替代 `arguments`）

[Files]

新文件 1 个；修改 10 组既存文件。

新文件：
1. `src/services/flowAnalysis/evidenceQuality.ts` —— 前端评分纯函数。

修改文件：
1. `src/types.ts` —— 类型增删。
2. `src/workflows/comprehensiveMasteryPrompt.ts` —— 重写 `COMPREHENSIVE_MASTERY_PROMPT`。
3. `src/services/flowAnalysis/types.ts` —— `LayeredEvidenceBundle` 改成携带 `qualityResult`（删 `argumentAnalyses`）。
4. `src/services/flowAnalysis/evidenceTasks.ts` —— `fetchLayeredEvidence` 接收 PreprocessResult，返回 qualityResult。
5. `src/services/flowAnalysis/orchestrator.ts` —— 接线。
6. `src/services/profile/scoring/ability.ts` —— 删 `scoreLayeredFromArguments`。
7. `src/services/profile/profileFusion.ts` —— 三层能力直接用 layeredScores.final。
8. `src/services/learningAbility/types.ts` + `timelineStore.ts` + `aggregator.ts` —— 周报 reasoning 结构。
9. `src/services/flowAnalysis/reportAssembler.ts` + `src/components/FlowAnalysisPanel.tsx` —— 展示。
10. `src/services/homepage/homepageViewModel.ts` + `src/components/HomeView.tsx` —— 主页。

[Functions]

新增（`evidenceQuality.ts`）：
- `computeLayeredScore(counts, quality, vulnerabilities): LayeredScoreResult`
  - 结构密度指标（counts 为 9 类论证类型计数）：
    - conceptDensity = (定义+命名+对比)/total
    - conceptDistinction = 对比/(定义+命名+对比)
    - judgmentDensity = (假设+举例+事实陈述)/total
    - reasoningDensity = (推理+反例削弱+建议对策)/total
    - counterRatio = 反例削弱/(推理+反例削弱)
  - 质量指标映射 0-4 → 0-100（score/4*100）
  - 三层原始分：
    - concept_raw = conceptDensity*0.3 + conceptDistinction*0.3 + conceptClarity*0.4
    - judgment_raw = judgmentDensity*0.3 + exampleQuality*0.4 + factSpeculation*0.3
    - logic_raw = reasoningDensity*0.3 + counterRatio*0.2 + reasoningChain*0.5
  - 漏洞扣分 PENALTY_TABLE = {1:2, 2:5, 3:10, 4:15, 5:20}；「语音转文字识别误差」不扣分；「多层」每层扣 1/3；「无法判断」跳过。
  - final = max(0, raw - penalty)
  - grade: ≥85 优秀 / ≥70 良好 / ≥60 及格 / ≥40 偏弱 / 否则 严重不足

修改：
- `fetchLayeredEvidence(preprocess)`（evidenceTasks.ts）：输入改 PreprocessResult，返回 `{ qualityResult }`。
- `runFlowAnalysis`（orchestrator.ts）：传 preprocess、算三层分数、写 profileInsight.layeredScores、recordReasoning 新签名。
- `fuseProfileInsight`（profileFusion.ts）：三层能力按 layeredScores.final 融合。
- `recordReasoning(scores, vulnerabilities)`（timelineStore.ts）：周报累积三层分数（EMA 0.4）+ vulnerabilityCount + vulnerabilityBreakdown（语音识别误差不计数）；errorRate = vulnerabilityCount / 分析次数。
- `computeReasoningWeekly`（aggregator.ts）：改为三层分数趋势 + 漏洞数。

删除：
- `scoreLayeredFromArguments`（ability.ts）。

[Classes]

无类改动。

[Dependencies]

无新增依赖。

[Testing]

- `npm run lint`（`tsc --noEmit`）—— 类型自洽。
- 手工验证：一次心流复盘后，`mastery-timeline.json` 当周记录三层 final 分数 + 漏洞数；结果面板展示「三层分数 + 漏洞表」；主页能力雷达改为三层分数、移除推理子项；错误率按漏洞统计。

[Implementation Order]

1. `src/types.ts` —— 新增质量评估类型，删旧类型与字段。
2. `src/services/flowAnalysis/evidenceQuality.ts` —— 前端评分纯函数。
3. `src/workflows/comprehensiveMasteryPrompt.ts` —— 重写 prompt。
4. `src/services/flowAnalysis/types.ts` —— LayeredEvidenceBundle 改造。
5. `src/services/flowAnalysis/evidenceTasks.ts` —— fetchLayeredEvidence 改造。
6. `src/services/flowAnalysis/orchestrator.ts` —— 接线。
7. `src/services/profile/scoring/ability.ts` + `profileFusion.ts` —— 删旧评分、改融合。
8. `src/services/learningAbility/types.ts` + `timelineStore.ts` + `aggregator.ts` —— 周报结构。
9. `src/services/flowAnalysis/reportAssembler.ts` + `FlowAnalysisPanel.tsx` —— 展示。
10. `src/services/homepage/homepageViewModel.ts` + `HomeView.tsx` —— 主页。
11. `npm run lint` 验证。
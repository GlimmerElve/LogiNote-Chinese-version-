/**
 * 【已删除】S4 等价性判定链路（轮次 N）。
 *
 * ## 原职责
 * 走「SymPy 五级策略兜底 + LLM 终裁」判定用户表达式与参考解某一步是否等价：
 *   1. `verifyEquivalencePure` 走五级策略
 *      （simplify_diff → expand_diff → ratio_minus_one → sympy_equals → numeric_sampling）
 *   2. 若返回 `unknown` 且允许 LLM 回退 → 调 `scene-equiv-adjudicate` 终裁
 *
 * ## 为什么整体删除（用户明确要求「取消参考链判定」）
 *
 * ### 1. 判据本身在纯常数场景下失效（实测确认）
 * 链条表达式 `1=2=3` 被切成 `1=2` 与 `2=3` 后，与参考解 `1=2` 逐个比差式 ——
 * **两边差式都恰好等于 -1**，于是被判「等价」。
 * 在纯常数场景下，「差式数值相等」根本不等于「等式成立」，判据退化。
 *
 * ### 2. 与「前提链是唯一判据」的架构目标背离
 * 新判据是：**能否由已连线的前置步骤推出**（`premise_engine.session_step`）。
 * 它不依赖参考答案，因此不会出现上述退化 ——
 * 判定语义从「像不像标准答案」变为「推不推得出来」，
 * 后者才是数学推导能力本身。
 *
 * ### 3. 参考答案的定位已改变
 * `expected_steps` / `expected_formula` 降级为**答案对照物**：
 * 只用于（a）用户主动结束推导后的复盘展示，（b）LLM 反馈的措辞参照。
 * 既然不参与裁定，围绕它构建的整条判定链路即为多余。
 *
 * ## 相关删除项（如需追溯，见各文件内「轮次 N」注释）
 * - `types/sceneS4.ts`：`EquivAdjudicateResult` 类型、`matchedStepIndex` 字段
 * - `services/scene/computeClient.ts`：`verifyEquivalencePure`
 * - `workflows/workflowRegistry.ts` + `types.ts` + `LlmSettingsPanel.tsx`：
 *   `scene-equiv-adjudicate` 工作流
 * - `services/scene/computeAnalyze.ts`：`matchReferenceStep` 与 `hintStepIndex`
 *
 * ## 保留项
 * - `computeClient.symbolDeclsToTable`：`computeLimit` 仍在使用
 * - 底层 `verify_equiv` 命令（Python）：属计算引擎通用能力，移交教学工具场景
 * - `expected_steps` / `expected_formula`：作为答案对照物保留（见上）
 */

export {};
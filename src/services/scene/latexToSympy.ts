/**
 * 【已删除】LaTeX → ASCIIMath → SymPy 确定性转译链路（轮次 N）。
 *
 * ## 原职责
 * 把 MathLive 的 LaTeX 输入转成 SymPy 可解析表达式，作为
 * `resolveNodeExpression` 的**第二级通道**（零 LLM 调用）：
 *
 * ```
 * LaTeX ──convertLatexToAsciiMath──▶ ASCIIMath ──normalizeAsciiToSympy──▶ SymPy
 *          （MathLive，纯函数）              （本模块，字符级确定性转换）
 * ```
 *
 * 目的是让绝大多数教学写法（下标 `x_1`、根式 `root(3)`、绝对值 `|x|`）
 * 不必烧 LLM 调用，把 LLM 留给真正需要语义判断的少数情形。
 *
 * ## 为什么整体删除（用户明确要求「彻底删 ASCIIMath」）
 *
 * ### 1. 职责已由 Python 侧原生覆盖
 * `latex_engine` + `_to_diff` 已有 **LaTeX 优先通道** ——
 * 输入含 `\`、`|`、`^{`、`_{` 时自动走 `parse_latex`。
 * 原 ② 级处理的写法（`x^{2}`、`m_{0}`、`\frac{a}{b}`）现在一次到位，
 * 不再需要「LaTeX → ASCIIMath → normalize」两跳。
 *
 * ### 2. 两层中间态形成「两套真相来源」
 * 同一写法在不同通道下可能得到不同结果（ASCIIMath 归一 vs LaTeX 直解），
 * 一旦判定出现分歧，排查需同时怀疑前端归一与 Python 解析两处，
 * 成本远高于收益。
 *
 * ### 3. 实测覆盖率不劣于原路线
 * 移除后 `resolveNodeExpression` 变为两级：
 * ```
 * ① 引擎直通：交 parse 校验（引擎内含 LaTeX 优先通道）→ 命中即返回，零 LLM
 * ② LLM 兜底：scene-formula-parse → 再用 parse 二次校验
 * ```
 * ① 级判据由 `!/[\\{}$]/`（挡住 LaTeX）放宽为 `/[a-zA-Z0-9]/`
 * （含字母或数字即先试一次），使 LaTeX 写法也能命中 ①。
 *
 * ## 相关删除项
 * - `types/sceneS4.ts`：`DerivationNodeData.asciiMath` 字段
 * - `services/scene/computeAnalyze.ts`：`resolveNodeExpression` 的 ② 级通道
 *
 * ## 保留项
 * `mathlive` 依赖本身**保留** —— `MathField` 仍用它做公式编辑与 LaTeX 输出，
 * 只是不再消费其 `convertLatexToAsciiMath` 能力。
 */

export {};
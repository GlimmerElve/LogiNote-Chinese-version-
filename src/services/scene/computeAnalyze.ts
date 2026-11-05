/**
 * S4 节点分析链路编排。
 *
 * ## 一次「节点提交」的完整流程（轮次 N 定稿）
 *   1. resolveNodeExpression —— LaTeX/Python 语法 → SymPy 表达式（引擎优先，LLM 兜底）
 *   2. 前提链判定          —— **唯一判据**：能否由已连线的前置步骤推出
 *   3. 定性反馈            —— 调 `scene-compute-analyze` 拿解释与建议（不参与裁定）
 *
 * ## 设计边界（对应《场景设计原则》）
 * - 原则 10「LLM 生成、系统执行」：**判定权只归 `premise_engine`（SymPy）**，
 *   第 3 步的 LLM 只做解释与建议，不得推翻引擎结论。
 * - 原则 3「认知冲突」：`pass`/`warn`/`fail` 三态由系统判定。
 *
 * ## 轮次 N 架构变更（用户明确要求「取消参考链判定」）
 * **删除**了原来的「参考解等价比对」整条链路：
 *   - `judgeEquivalence`（5 级 SymPy 兜底 + LLM 终裁）—— 整个 `equivalence.ts` 删除
 *   - `matchReferenceStep`（把用户式匹配到 `expected_steps` 某一步）
 *   - `hintStepIndex` / `matchedStepIndex`（达成度标记，UI 不再展示）
 * 原因：该链路在纯常数场景下会误判（`1=2=3` 两边差式都恰好是 -1），
 * 且与「前提链是唯一判据」的目标背离。
 *
 * **保留**：`expected_steps` / `expected_formula` 仅作为**答案对照物**，
 * 在用户主动结束推导后由 `StandardSolutionView` 展示；运行中完全不可见。
 *
 * 本模块不写运行态（返回数据由调用方写入），不做 UI 渲染。
 */

import { callLLM } from '../llmService';
import { parseJsonLenient } from '../reviewSegmentScoring';
import type { SceneRunState, SceneSpec } from '../../types';
import type {
  ComputeAnalyzeResult,
  DerivationNode,
  DerivationNodeStatus,
  FormulaParseResult,
  NodeVerification,
} from '../../types/sceneS4';
import {
  collectBranchPremises,
  judgeStepLegitimacy,
  judgeAssumption,
  legitFeedback,
  buildSessionSymbols,
} from './premiseChain';
import { parseExpression, simplifyExpression } from './computeClient';
import { getUserProfile } from '../profile/profileStore';
import { buildProfileContext, isProfileTrusted } from '../profile/profileContext';
import { buildS4AssistantContext } from './sceneS4AssistantContext';
import { s4AllowedNodeTypes, s4NodeAuthorizationError } from './sceneS4Policy';
import { isSceneOutputTruncated } from './sceneOutputSafety';
import { s4GoalAssessment, s4GoalInputKey } from './sceneS4Goal';

function nodePermissionFailure(spec: SceneSpec, run: SceneRunState, node: DerivationNode): AnalyzeStepResult | undefined {
  const error = !s4AllowedNodeTypes(spec).includes(node.type)
    ? '本场景未启用该节点组件，无法验证。'
    : s4NodeAuthorizationError(spec, run.canvas, node.id);
  return error ? { status: 'warn', verification: {
    formula_correct: false, dimension_check: false, verdictSource: 'none', feedback: error,
  }, metricUpdates: [] } : undefined;
}

/** 公式转译的最低可信置信度（低于则拒绝该表达式） */
export const PARSE_MIN_CONFIDENCE = 0.6;

/**
 * 把计算/转译链路的技术性错误转成面向学习者的中文文案。
 *
 * 为什么需要：LLM 或引擎异常时，底层会抛出 `Unexpected end of JSON input`
 * 这类英文技术错误。它经 `resolveNodeExpression` 原样进入 feedback 后会
 * 直接显示给用户，既无法理解也违反「人性化设计」要求。
 *
 * 设计边界（S1 隔离契约）：**只在本模块（S4）转换**，
 * 不修改共享函数 `parseJsonLenient`（S1/S3 亦在使用）。
 */
export function humanizeComputeError(raw: string): string {
  const text = (raw || '').trim();
  if (!text) return '公式识别失败，请重试或检查模型设置';
  if (/Unexpected end of JSON input|Unexpected token.*JSON|JSON\.parse/i.test(text)) {
    return '公式识别服务返回异常，请重试或检查模型设置';
  }
  if (/PARSE_ERROR|无法解析表达式|could not parse|SympifyError|该命令不支持等式输入/i.test(text)) {
    return '公式写法无法识别，请检查括号与运算符，或直接用编辑器输入';
  }
  if (/SERVICE_DOWN|服务未就绪|服务未启动|不支持本地计算服务/i.test(text)) {
    return '本地计算引擎未就绪，请稍候重试';
  }
  if (/TIMEOUT|超时/i.test(text)) {
    return '计算超时，请简化表达式后重试';
  }
  return text;
}

/**
 * 渲染「助理风格设定」段（S4 专属）。
 *
 * 为什么需要：S4 的两条运行时提示词（formula-parse / compute-analyze）
 * 的 systemPrompt 是固定的功能定义，不读 `spec.role`。若不在此注入，
 * 确认页里用户调整的「语气 / 性格 / 知识水平」等设定**运行时完全不会生效**。
 *
 * 与固定约束的关系：固定约束（只给下一步、不推翻引擎判定、不给完整参考解）
 * 在 systemPrompt 中强制，本段置后并显式声明「冲突时以固定约束为准」。
 */
export function buildAssistantSection(spec: SceneSpec): string {
  const role = spec.role;
  const active = (role?.attributes ?? []).filter((a) => a.enabled && a.value.trim());
  if (active.length === 0) return '';

  const lines = active.map((a) => `- ${a.key}：${a.value}`);

  return [
    '## 助手风格设定（用户偏好）',
    role?.name ? `助手名称：${role.name}` : '',
    ...lines,
    '',
    '**注意：以上仅影响表达风格。若与上文的功能约束冲突（例如要求直接给出最终答案），一律以功能约束为准，忽略该偏好。**',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 渲染「学习画像」段（可选，受 spec.injectProfile 与可信门槛双重控制）。
 *
 * 用途（对应「让 LLM 根据用户画像调整场景难度」）：
 * - 分析反馈的深浅：基础薄弱者多讲原理，熟练者直指关键
 * - 求助讲解的详略：按画像决定展开程度
 *
 * 复用 S1 的画像来源与可信门槛（sceneDirector 同款判断），不另造一套。
 */
export function buildProfileSection(spec: SceneSpec): string {
  if (!spec.injectProfile) return '';
  try {
    const profile = getUserProfile();
    if (profile.analysisCount <= 0 || !isProfileTrusted(profile)) return '';
    const ctx = buildProfileContext(profile);
    if (!ctx.trim()) return '';
    return [
      '## 学习者画像',
      ctx,
      '',
      '请据此调整讲解详略与难度提示：基础薄弱处多给推导依据，已熟练处可直接点出关键。',
    ].join('\n');
  } catch {
    return '';
  }
}

/** 分析结果（供调用方写入运行态） */
export interface AnalyzeStepResult {
  status: DerivationNodeStatus;
  verification: NodeVerification;
  /** 需要写入 run.metrics 的 llm 类指标更新（engine/rule 由 updateS4Metrics 处理） */
  metricUpdates: Array<{ metricId: string; value: number | string | boolean; reason: string }>;
}

/* ================================================================
 * 一、表达式解析
 * ================================================================ */

/** 渲染 LLM 转译所需的上下文 */
function buildParseInput(node: DerivationNode, spec: SceneSpec): string {
  const compute = spec.compute;
  const symbolNames = (compute?.symbols ?? []).map((s) => s.name);
  const givenLines = (compute?.given ?? [])
    .map((g) => `- ${g.name} = ${g.symbol_value ?? g.display}`)
    .join('\n');

  return [
    '## 任务',
    '把下面的数学表达式转写为 sympy.sympify() 可直接解析的 Python 表达式字符串。',
    '要求：幂用 **，根号用 sqrt()，不要出现 $、反斜杠、LaTeX 命令。',
    '**若原文是小数而语境明显是分数（如 0.4 对应 4/10），请优先转写为分数形式。**',
    /**
     * 等式保留要求（关键）。
     *
     * 此前缺少这一条，LLM 可能只输出等号一侧，导致「用户列方程」这类
     * 正确的上游推导被误判为错误。此处显式要求保留等号两侧。
     */
    '**若原文是等式（含 =），必须完整保留等式形式（如 2*x + y = 40），严禁只取一侧。**',
    /**
     * 函数记法保留要求（轮次 A 新增，关键）。
     *
     * 函数名不是变量：`A(x)` 若被转写成 `A*x`，会凭空引入一个不存在的自由符号 A，
     * 使「面积函数 A(x) = x(40-2x)」这类完全正确的推导被判为不等价。
     */
    '**函数记法必须原样保留：A(x)、f(2+x)、A(x,y)、s(t) 保持为 A(x)、f(x + 2)、A(x, y)、s(t)，'
      + '严禁展开为 A*x 这类乘法。**',
    '**链式等式（如 a = b = c）必须完整保留所有等号与各段，严禁只保留其中一段。**',
    '**变量名只用单个字母或单字母+数字下标（如 x、x1、v0），不要用多字母单词或下划线。**',
    '**若原文省略了乘号（如 2x、2xy、x1y1），请补全为显式乘法（2*x、2*x*y、x1*y1）。**',
    /**
     * 撇号导数（轮次 B 新增）。
     *
     * 引擎已能本地处理 A'(x) 这类写法，但仅限「括号内是单一标识符」；
     * 若括号内是复合表达式（如 A'(2*t)），本地归一会因语义歧义而放弃，
     * 此时需要 LLM 明确转写。此处告知目标形式，避免 LLM 自创写法。
     */
    '**撇号表示导数：A\'(x) 转写为 diff(A(x), x)；A\'\'(x) 转写为 diff(A(x), x, 2)。'
      + '若括号内是复合表达式（如 A\'(2*t)），按「对自变量求导」理解。**',
    /**
     * 不等式与定义域（轮次 B 新增）。
     *
     * 引擎能解析链式不等式（0<x<20）并做等价判定，但 LLM 常习惯写成
     * 区间或文字描述，导致引擎拿到的是「0到20」这类无法解析的文本。
     */
    '**不等式保持原样：0 < x < 20、x <= 20、x > 0 直接用运算符表达，'
      + '不要转写成区间、不要加 and/or、不要写成文字。**',
    '**中文单位请剥离：200 平方米 转写为 200，单位不要出现在表达式里。**',
    '',
    '## 待转写内容（LaTeX 或自然语言混写）',
    /**
     * 公式与注释**同时**传入（轮次 B 修正）。
     *
     * 原实现用 `latex || note`（「或」），只要公式非空则注释被完全丢弃；
     * 而注释往往承载「这一步在做什么」的关键意图（如「两边同除 2」），
     * 丢掉后转译器只能猜，容易把「对等式变形」误读为「对表达式求值」。
     */
    node.data.latex ? `公式：${node.data.latex}` : '',
    node.data.note ? `用户对该步的说明（仅供理解，不得用它补充或替换公式）：${node.data.note}` : '',
    '',
    symbolNames.length ? `## 可用符号\n${symbolNames.join(', ')}` : '',
    givenLines ? `## 已知条件\n${givenLines}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 把节点内容转为 SymPy 表达式。
 *
 * ## 两级通道（**引擎优先，LLM 兜底**）
 *
 * ```
 * ① 引擎直通：交 `parse` 校验 → 命中即返回，零 LLM
 * ② LLM 兜底：scene-formula-parse → 再用 parse 二次校验
 * ```
 *
 * ## 轮次 N 移除原 ②「ASCIIMath 确定性转译」级（用户要求「彻底删 ASCIIMath」）
 * 原三级通道中的 ② 级（LaTeX → ASCIIMath → normalize）整条删除：
 *   - 那层的规则（下标 `x_1`→`x1`、`root(3)`→根式、绝对值 `|x|`）现已由
 *     Python 侧 `_to_diff` 的 LaTeX 优先通道原生覆盖；
 *   - 保留两层中间态会形成**两套真相来源**，同一写法在不同通道下可能
 *     得到不同结果，反而增加排查成本。
 *
 * ## ① 级判据为什么放宽（轮次 N）
 * 原判据 `!/[\\{}$]/` 是为了「挡住 LaTeX，交给 ② 级 ASCIIMath」。
 * ② 级删除后该理由不再成立，且引擎已能直接解析 LaTeX ——
 * 故放宽为「含字母或数字」，让所有写法都先试一次引擎直通。
 *
 * ## 两级都必须经 `parse` 校验（原则 10：不轻信任何单一环节）
 * 无论哪条通道产出，都要喂给引擎确认可解析才采纳。
 */
export async function resolveNodeExpression(
  node: DerivationNode,
  spec: SceneSpec,
): Promise<{ ok: true; expr: string } | { ok: false; error: string }> {
  // Only old system givens may store their mathematical display in note.
  const raw = (node.data.latex || (node.type === 'given' ? node.data.note : '') || '').trim();
  if (!raw) return { ok: false, error: '公式为空，请在公式输入区填写；备注仅用于说明，不参与验证' };

  const symbolNames = (spec.compute?.symbols ?? []).map((s) => s.name);

  /**
   * 符号**声明表**（轮次 V 修复，用户实测缺陷）。
   *
   * ## 为什么不能只传 `symbolNames`
   * `symbolNames` 是 `string[]`，只有名字 —— **`kind:'function'` 被丢掉**。
   * 引擎 `_symbol_table_to_dict` 对「全是字符串」的数组一律判为
   * `{"kind":"variable"}`，于是 `F(x)` 被当作「已声明变量 F 后跟括号」，
   * 走 `_strip_implicit_mul` 的 4b 分支插入乘号 → **`F*x`**。
   *
   * 实测证据（场景声明 F 为 function）：
   *   parse('F(x)=x', ['F','x'])                        → 'F*x = x'   ❌
   *   parse('F(x)=x', [{name:'F',kind:'function',…}])   → 'F(x) = x'  ✅
   * 而 session 里 F 是 `sp.Function`，收到 `F*x` 会抛
   *   `unsupported operand type(s) for *: 'UndefinedFunction' and 'Symbol'`
   * —— 用户看到的正是这句报错（他写的是 `F(x)=x`，本该 pass）。
   *
   * ## 为什么复用 `buildSessionSymbols`
   * 它已是 `session_init` 的符号表规范化出口（同一引擎契约 `_compile_symbols`），
   * 此处复用可避免出现**第二套符号表构造**，防止两处口径分叉。
   *
   * ## 与 `symbolNames` 的分工
   *   symbolNames  —— 仅供 `buildParseInput` 的 prompt 文本展示（只需名字）
   *   symbolDecls  —— 供 `parseExpression` 调用（需完整声明）
   */
  const symbolDecls = buildSessionSymbols(spec);

  /**
   * --- ⓪ 多等式直通（轮次 P 修复，GUI 实测缺陷）---
   *
   * **等号 ≥ 2 时跳过 `parse`，直接把原文交给判定引擎。**
   *
   * ## 为什么必须跳过 `parse`（实测确认的完整链路）
   * `cmd_parse` 里有一个「值集合通道」（`_detect_value_set`），它会把
   * `x=4；y=5` 这类输入**取每个等式的右侧**、压成 `"4, 5"`：
   *
   *   `x=4；y=5` → `sympy_expr="4, 5"`（`is_value_set=true`）
   *
   * 变量名 `x`、`y` 在这一步**被丢掉了**。下游 `session_step` 拿到 `"4, 5"`
   * 后看不到任何变量，于是判定退化为「孤立常量」——
   * 用户看到的是「识别到 (4,5) 但没有写变量」，而他明明写了。
   *
   * ## 为什么引擎侧不能自己判
   * `x1=1, x2=5`（文档推荐的多值答案）与 `x=4, y=5`（多组赋值）
   * **形式完全一样**，语法上无法区分 —— 区别只在语义意图。
   * 而「值集合」是为**已删除的参考链**（与参考答案比值的集合）设计的；
   * 轮次 N 起判据已改为**前提链**，而前提链**必须保留变量名**。
   * 故此处由调用方按「等号数」这个**语法特征**直接绕开该通道。
   *
   * ## 为什么判据用「等号 ≥ 2」
   * | 输入 | 等号数 | 走向 | 是否受影响 |
   * |---|---|---|---|
   * | `x=4；y=5` | 2 | **直通原文** | ✅ 修复目标 |
   * | `2x+3y=23` | 1 | 走 `parse` | ❌ 不变 |
   * | `x=4` | 1 | 走 `parse` | ❌ 不变 |
   * | `(1,5)` | 0 | 走 `parse`（值集合仍生效） | ❌ 不变 |
   * | `[1,5]` | 0 | 走 `parse` | ❌ 不变 |
   *
   * 即：只拦「多个等式」，纯集合记法与单式完全不受影响。
   *
   * ## 为什么直通原文是安全的
   * 引擎的 `_split_local_constraints` 已实测能正确处理这种写法
   * （`x=4；y=5` → `mains=[]`、`cons=['x=4','y=5']`，逐条与前提校验 → pass），
   * 且它内部自带完整的记法归一（`2x`→`2*x`、`x^{2}`→`x**2`、LaTeX 括号…）。
   *
   * 注：`_split_local_constraints` 的顶层分隔符含 `; ； , ，`（见 `_LOCAL_SEP`），
   * 故分号与逗号两种写法都支持；换行不在其中（公式块不支持换行输入）。
   */
  // cases / matrix 由后端的结构化通道直接解析。原文直送可保留
  // 行列分隔、分段条件和矩阵维度，避免 LLM 转译时改变数学结构。
  if (
    /\\begin\s*\{(?:cases|(?:p|b|B|v|V)?matrix)\}/.test(raw) ||
    /\\(?:det|lVert|rVert|Vert|lvert|rvert|vec|mathbf|boldsymbol|cdot|times|lim|sum|prod|nabla|Delta|chi|overline|bar|imaginaryI|operatorname)\b|\\\||_\s*\{|(?:^|[^A-Za-z0-9_])[DHJ]_\{?/.test(raw)
  ) {
    return { ok: true, expr: raw };
  }

  const eqCount = (raw.match(/(?<![<>=!:])=(?!=)/g) || []).length;
  if (eqCount >= 2) {
    return { ok: true, expr: raw };
  }

  // --- ① 引擎直通：含字母或数字即先试一次（引擎内含 LaTeX 优先通道）---
  const looksParseable = /[a-zA-Z0-9]/.test(raw);
  if (looksParseable) {
    const probe = await parseExpression(raw, symbolDecls);
    if (probe.ok && probe.result.sympyExpr) {
      return { ok: true, expr: probe.result.sympyExpr };
    }
  }

  // --- ② LLM 转译通道（兜底）---
  /**
   * 单次转译尝试。
   *
   * `retryHint` 非空时表示这是**重试**：把上一轮引擎拒绝的原始错误
   * 一并喂给 LLM，让它在已知失败原因的前提下改写，而不是重复同样的输出。
   * 实测中「同一 prompt 重试」几乎必然得到同一结果，必须带上错误才有效。
   */
  const attemptTranslate = async (
    retryHint: string,
  ): Promise<{ ok: true; expr: string } | { ok: false; error: string; rawError: string }> => {
    try {
      const input = buildParseInput(node, spec) + (retryHint ? `\n\n${retryHint}` : '');
      const resp = await callLLM({
        providerId: '',
        model: '',
        workflow: 'scene-formula-parse',
        userInput: input,
      });
      if (isSceneOutputTruncated(resp)) {
        return { ok: false, error: '公式转译输出被截断，本次未用于验证，请重试。', rawError: 'OUTPUT_TRUNCATED' };
      }
      /**
       * 空响应预检。
       *
       * LLM 链路异常时 `resp.content` 可能为空串，直接交给 `parseJsonLenient`
       * 会抛「Unexpected end of JSON input」这类英文技术错误，并原样显示给学习者。
       * 这里提前拦截，给出可理解的中文原因。
       */
      if (!resp?.content || !resp.content.trim()) {
        return { ok: false, error: '公式识别服务未返回内容，请重试或检查模型设置', rawError: 'EMPTY_RESPONSE' };
      }

      const parsed = parseJsonLenient(resp.content) as Partial<FormulaParseResult> | null;
      const expr = typeof parsed?.sympy_expr === 'string' ? parsed.sympy_expr.trim() : '';
      const confidence = typeof parsed?.confidence === 'number' ? parsed.confidence : 0;

      if (!expr) {
        return { ok: false, error: '公式转译失败，请检查写法', rawError: 'EMPTY_EXPR' };
      }
      if (confidence < PARSE_MIN_CONFIDENCE) {
        return {
          ok: false,
          error: `公式转译置信度不足（${confidence.toFixed(2)}），请改写得更明确`,
          rawError: 'LOW_CONFIDENCE',
        };
      }

      // 用 parse 命令验证转译结果确实可被 SymPy 接受（原则 10：系统校验）
      const verified = await parseExpression(expr, symbolDecls);
      if (!verified.ok) {
        // 引擎的原始错误可能是英文技术信息（如 PARSE_ERROR），统一转成中文文案
        const rawErr = (verified as { ok: false; error: string }).error;
        return { ok: false, error: humanizeComputeError(rawErr), rawError: rawErr };
      }

      return { ok: true, expr: verified.result.sympyExpr || expr };
    } catch (e) {
      // 容错解析抛出的英文技术错误（如 Unexpected end of JSON input）在此转中文
      const msg = (e as Error)?.message || '公式转译失败';
      return { ok: false, error: humanizeComputeError(msg), rawError: msg };
    }
  };

  const first = await attemptTranslate('');
  if (first.ok) return { ok: true, expr: first.expr };
  // 非 strict 模式下 TS 不按 ok 收窄判别联合，显式取失败分支
  const firstFail = first as { ok: false; error: string; rawError: string };

  /**
   * 带错误信息重试一次（轮次 B 新增）。
   *
   * 为什么值得重试：LLM 首次转译时常犯**同一类**机械错误（漏写乘号、
   * 把不等式写成区间、丢掉等号一侧）。把引擎的原始拒绝原因回喂后，
   * 第二次通常能直接改对，比要求用户重写一遍更省事。
   *
   * 为什么只重试一次：连续两次失败通常意味着输入本身有歧义（如
   * A'(2*t) 的语义），再试只是浪费调用；此时应把问题交回用户。
   */
  if (firstFail.rawError && !['EMPTY_RESPONSE', 'OUTPUT_TRUNCATED'].includes(firstFail.rawError)) {
    const retryHint = [
      '## 上一次转译被计算引擎拒绝（请据此改写）',
      `引擎错误：${firstFail.rawError}`,
      '请检查：等号两侧是否都保留、不等式是否写成运算符形式（不要用区间或文字）、',
      '撇号导数是否写成 diff(f(x), x)、中文单位是否已剥离、乘号是否补全。',
    ].join('\n');
    const second = await attemptTranslate(retryHint);
    if (second.ok) return { ok: true, expr: second.expr };
    return { ok: false, error: (second as { ok: false; error: string }).error };
  }

  return { ok: false, error: firstFail.error };
}

/* ================================================================
 * 二、定性分析（LLM，只做解释不做判定）
 * ================================================================ */

/** 渲染定性分析的输入 */
export function buildAnalyzeInput(ctx: {
  spec: SceneSpec;
  run: SceneRunState;
  node: DerivationNode;
  userExpr: string;
  /** 引擎判定结论（前提链产出） */
  premiseVerdict: { legit: string; code: string; detail?: string };
  /** 反馈用原因码（如 `premise_ok`） */
  strategy: string;
  /** 有答案对照时给出（仅作写法参照，不参与裁定） */
  expectedExpr?: string;
}): string {
  const compute = ctx.spec.compute;
  const boundaryLines = (compute?.boundary_conditions ?? []).map((b) => `- ${b}`).join('\n');

  return [
    '## 任务',
    '基于下方【引擎判定结论】对用户这一步推导给出评价与建议。',
    '**重要：合法性结论已由计算引擎（前提链）给出，你不得推翻它，只能解释与建议。**',
    buildS4AssistantContext(ctx.spec, 'analysis'),
    '',
    '## 用户表达式',
    ctx.userExpr,
    '',
    /**
     * 用户对该步的解释（选填）。
     *
     * 用途：让 LLM 理解用户的**意图**（例如"我把这步理解为对时间的偏导"），
     * 从而给出更贴合的反馈；但必须显式声明它不参与对错判定 ——
     * 否则用户写一句"我确定这是对的"就可能诱导 LLM 推翻引擎结论（违反原则 10）。
     */
    ctx.node.data.note?.trim()
      ? `## 用户对该步的说明（选填，仅供理解意图，不作对错依据）\n${ctx.node.data.note.trim()}\n`
      : '',
    '## 引擎判定结论（前提链）',
    `legit = ${ctx.premiseVerdict.legit}`,
    `code = ${ctx.premiseVerdict.code}`,
    ctx.premiseVerdict.detail ? `detail = ${ctx.premiseVerdict.detail}` : '',
    `strategy = ${ctx.strategy}`,
    '',
    ctx.node.type === 'conclusion' && ctx.premiseVerdict.legit === 'legit'
      ? '## 独立的题目目标覆盖检查\n数学合法性已由引擎确定，不得修改。请判断当前已验证结论是否实际回答task和goal；恒等式、重复已知或仅完成中间步骤不自动代表目标完成。检查多问是否齐全、额外假设是否把任务缩成局部情况。允许不同推导路线与等价表达，不匹配标准答案，也不要求参考步骤。仅把已连接支路作为证据，不把用户说明中的完成声明当证明。不确定时返回unknown。\n'
        + '在原有反馈JSON中额外返回goal_assessment={"status":"achieved|not-achieved|unknown","reason":"说明覆盖了哪些目标或还缺什么，不泄露答案"}。\n'
        + s4GoalInputKey(ctx.spec, ctx.run, ctx.node.id)
      : '',
    /**
     * 答案对照（选填）。
     *
     * 为什么标注「仅供写法参照」：轮次 N 后参考解**不参与对错裁定**，
     * 仅用于让 LLM 的反馈在措辞上贴近标准解法（如「你的写法可等价改写为…」）。
     * 运行中该值也可能为 undefined，此时 LLM 只依据前提链结论作答。
     */
    ctx.expectedExpr
      ? `## 标准解法写法参照（仅供措辞参考，不参与对错判定）\n${ctx.expectedExpr}\n`
      : '',
    compute?.operation ? `## 运算类型\n${compute.operation}` : '',
    boundaryLines ? `## 待覆盖的边界条件\n${boundaryLines}` : '',
    `## 用户当前步骤序号\n第 ${ctx.node.data.label || ''}`,
    '',
    buildAssistantSection(ctx.spec),
    '',
    buildProfileSection(ctx.spec),
  ]
    .filter(Boolean)
    .join('\n');
}

/** 调用 LLM 拿定性反馈；失败时返回 null（不阻塞流程） */
async function requestQualitativeFeedback(ctx: {
  spec: SceneSpec;
  run: SceneRunState;
  node: DerivationNode;
  userExpr: string;
  premiseVerdict: { legit: string; code: string; detail?: string };
  strategy: string;
  expectedExpr?: string;
}): Promise<(ComputeAnalyzeResult & { goal_assessment?: unknown }) | null> {
  try {
    const resp = await callLLM({
      providerId: '',
      model: '',
      workflow: 'scene-compute-analyze',
      skipMemoryInjection: true,
      skipProfileInjection: true,
      userInput: buildAnalyzeInput(ctx),
    });
    // Incomplete explanations must not replace the complete local engine feedback.
    if (isSceneOutputTruncated(resp)) return null;
    const parsed = parseJsonLenient(resp.content) as (Partial<ComputeAnalyzeResult> & { goal_assessment?: unknown }) | null;
    if (!parsed) return null;

    return {
      goal_assessment: parsed.goal_assessment,
      formula_correct: parsed.formula_correct === true,
      numerical_error:
        typeof parsed.numerical_error === 'number' ? parsed.numerical_error : undefined,
      boundary_coverage: Array.isArray(parsed.boundary_coverage)
        ? parsed.boundary_coverage.filter((b): b is string => typeof b === 'string')
        : [],
      dimension_check: parsed.dimension_check !== false,
      physical_meaning: typeof parsed.physical_meaning === 'string' ? parsed.physical_meaning : '',
      feedback: typeof parsed.feedback === 'string' ? parsed.feedback : '',
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

/* ================================================================
 * 三、主入口
 * ================================================================ */

/**
 * 分析一个已提交的节点。
 *
 * ## 判定权（原则 10）
 * 合法性**只由前提链（`premise_engine` / SymPy）产出**，
 * 定性反馈的 LLM 仅解释与建议，不得推翻结论。
 *
 * ## 状态判定
 * - 表达式无法解析 → `warn`（不是 `fail`：那是「没读懂写法」，不是「推导错了」）
 * - 前提链 `legit`  → `pass`
 * - 前提链 `warn`   → `warn`（结论正确但有保留，如可去奇点）
 * - 前提链 `illegal`/`conflict` → `fail`
 * - 其余            → `warn`
 *
 * 本函数**不抛异常**，任何内部失败都归约为可读的失败/警告状态。
 */
export async function analyzeStep(ctx: {
  spec: SceneSpec;
  run: SceneRunState;
  node: DerivationNode;
  /**
   * 前提链会话 id（**必填**）。
   *
   * 为什么必填：轮次 N 起前提链是**唯一判据**，而其依赖服务端的符号环境缓存。
   * 会话未就绪时**由调用方负责不调用本函数**并给出提示
   * （见 `SceneDerivationView.handleSubmitNode` 的守卫）。
   */
  sessionId: string;
}): Promise<AnalyzeStepResult> {
  const { spec, run, node, sessionId } = ctx;
  const denied = nodePermissionFailure(spec, run, node);
  if (denied) return denied;
  const compute = spec.compute;

  // --- 无 compute 配置（理论上不该发生在 S4）---
  if (!compute) {
    return {
      status: 'warn',
      verification: {
        formula_correct: false,
        dimension_check: false,
        feedback: '场景缺少数理配置，无法验证',
        verdictSource: 'none',
      },
      metricUpdates: [],
    };
  }

  // --- 第 1 步：解析表达式 ---
  const resolved = await resolveNodeExpression(node, spec);
  if (!resolved.ok) {
    // 非 strict 模式下 TS 不按 ok 收窄判别联合，显式取失败分支
    const errMsg = (resolved as { ok: false; error: string }).error;
    /**
     * 解析失败 → 降级为 `warn`，**不再判 `fail`**（轮次 B）。
     *
     * 为什么必须改：`fail` 语义是「你的推导错了」，而解析失败的真实含义是
     * 「系统没能读懂你的写法」——两者性质完全不同。此前因 `A'(x)`、
     * `0<x<20` 这类引擎未支持的记法被判 `fail`，用户收到的是「你错了」，
     * 但实际上他的数学是正确的，只是工具不够（实测确认）。
     */
    return {
      status: 'warn',
      verification: {
        formula_correct: false,
        dimension_check: false,
        feedback: `未能识别本步骤的写法：${errMsg}。这不代表推导有误 —— 请检查括号与运算符是否完整，或改用编辑器输入。`,
        verdictSource: 'none',
      },
      metricUpdates: [],
    };
  }
  const userExpr = resolved.expr;

  /**
   * --- 第 2 步：前提链判定（**唯一判据**）---
   *
   * 语义（用户确认）：本步能否由**已连线的前置步骤**推出。
   * 连通性即推导关系 —— 没连线的节点不提供前提。
   */
  if (!run.canvas) {
    return {
      status: 'warn',
      verification: {
        formula_correct: false,
        dimension_check: false,
        feedback: '画布未就绪，无法收集本步的前提条件。请稍后重新提交。',
        verdictSource: 'none',
      },
      metricUpdates: [],
    };
  }

  const premises = collectBranchPremises(node, run.canvas, spec);
  if (premises.ignoredAncestorIds.length > 0) {
    const pv = {
      legit: 'unknown' as const,
      code: 'upstream_not_verified',
      proofBasis: 'unknown' as const,
      detail: `已连接的上游节点尚未通过验证：${premises.ignoredAncestorIds.join(', ')}`,
    };
    return {
      status: 'warn',
      verification: {
        formula_correct: false,
        dimension_check: false,
        feedback: '已连接的上游步骤尚未通过验证，不能作为本步前提。请先修正并提交上游步骤。',
        suggestions: [],
        verdictSource: 'premise',
        premiseVerdict: pv,
      },
      metricUpdates: [],
    };
  }
  const intent = node.type === 'conclusion' ? 'conclusion' : 'derivation';
  const pv = await judgeStepLegitimacy({ sessionId, userExpr, premises, intent });
  const fb = legitFeedback(pv);

  /**
   * --- 第 3 步：定性反馈（LLM 只解释、不判定）---
   *
   * 轮次 N 变更：不再做「参考步骤匹配」（`matchReferenceStep` 已删除）。
   * 标准解法仅作为**写法参照**传入 —— 且只在 `expected_formula` 存在时给，
   * 运行中不给具体步骤，避免泄露答案要点。
   */
  const technicalUnknown = new Set([
    'derivative_dependency_missing',
    'not_applicable',
    'unsupported_expression',
    'premise_unparsable',
  ]).has(pv.code);
  const qualitative = technicalUnknown
    ? null
    : await requestQualitativeFeedback({
        spec,
        run,
        node,
        userExpr,
        premiseVerdict: pv,
        strategy: `premise_${pv.code}`,
      });

  return {
    status: fb.status,
    verification: {
      formula_correct: pv.legit === 'legit',
      dimension_check: true,
      feedback: qualitative?.feedback || fb.text,
      suggestions: qualitative?.suggestions ?? [],
      verdictSource: 'premise',
      premiseVerdict: pv,
      goalAssessment: node.type === 'conclusion' && pv.legit === 'legit'
        ? s4GoalAssessment(spec, run, node.id, qualitative?.goal_assessment) : undefined,
    },
    metricUpdates: [],
  };
}

/* ================================================================
 * 四、假设前提节点的分析（前提链架构）
 * ================================================================ */

/**
 * 分析一个已提交的**假设前提**节点。
 *
 * ## 与 `analyzeStep` 的三点不同
 * 1. **不走参考解比对**：假设是用户主动引入的额外条件，标准解里没有它 ——
 *    拿它去和 `expected_steps` 比等价毫无意义。
 * 2. **只做两件事**：语法检查（符号/函数是否已声明）+ 与祖先前提的冲突检查。
 * 3. **判定来源恒为 `premise`**：不存在 LLM 终裁路径（纯引擎行为）。
 *
 * ## 冲突语义（用户确认的「场景前提优先」）
 * 场景给定的条件（given / boundary_conditions）**不能被用户假设推翻**。
 * 例如场景前提含 `m > 0`，用户假设 `m = 0` → 判 `conflict` 并报红。
 *
 * ## 为什么不调 LLM 生成反馈
 * `legitFeedback` 已针对假设的三种结局（legit / conflict / unknown）
 * 给出准确的中文文案。此处再调一次 LLM 只是把同样的话换个说法，
 * 却增加延迟与调用成本，且可能引入与引擎结论不符的表述。
 */
export async function analyzeAssumptionStep(ctx: {
  spec: SceneSpec;
  run: SceneRunState;
  node: DerivationNode;
  /** 前提链会话 id（必填，与 `analyzeStep` 对齐） */
  sessionId: string;
}): Promise<AnalyzeStepResult> {
  const { spec, run, node, sessionId } = ctx;
  const denied = nodePermissionFailure(spec, run, node);
  if (denied) return denied;

  // --- 解析表达式（复用两级通道：引擎直通 / LLM 兜底）---
  const resolved = await resolveNodeExpression(node, spec);
  if (!resolved.ok) {
    const errMsg = (resolved as { ok: false; error: string }).error;
    return {
      status: 'warn',
      verification: {
        formula_correct: false,
        dimension_check: false,
        feedback: `未能识别该假设的写法：${errMsg}。请检查括号与运算符，或改用编辑器输入。`,
        verdictSource: 'none',
      },
      metricUpdates: [],
    };
  }
  const assumptionExpr = resolved.expr;

  /**
   * --- 引擎未就绪 / 未接线：降级为 warn ---
   *
   * 为什么不给 pass：假设的作用是「为下游提供前提」，若它本身未经校验，
   * 会让下游基于一个错误的依据继续推导。宁可让用户看到「待确认」。
   */
  if (!run.canvas) {
    return {
      status: 'warn',
      verification: {
        formula_correct: false,
        dimension_check: false,
        feedback: '计算引擎未就绪，无法校验该假设是否与已有前提冲突。请稍后重新提交。',
        verdictSource: 'none',
      },
      metricUpdates: [],
    };
  }

  // --- 收集该节点支路的前提，交给引擎做冲突检查 ---
  const premises = collectBranchPremises(node, run.canvas, spec);
  if (premises.ignoredAncestorIds.length > 0) {
    const verdict = {
      legit: 'unknown' as const,
      code: 'upstream_not_verified',
      proofBasis: 'unknown' as const,
      detail: `已连接的上游节点尚未通过验证：${premises.ignoredAncestorIds.join(', ')}`,
    };
    return {
      status: 'warn',
      verification: {
        formula_correct: false,
        dimension_check: false,
        feedback: '已连接的上游步骤尚未通过验证，不能作为该假设的依据。请先修正并提交上游步骤。',
        suggestions: [],
        verdictSource: 'premise',
        premiseVerdict: verdict,
      },
      metricUpdates: [],
    };
  }
  const verdict = await judgeAssumption({ sessionId, assumptionExpr, premises });
  const fb = legitFeedback(verdict);

  return {
    status: fb.status,
    verification: {
      formula_correct: verdict.legit === 'legit',
      dimension_check: true,
      feedback:
        fb.text +
        // 通过时补一句用途说明：让用户知道这个假设对下游意味着什么
        (verdict.legit === 'legit' ? '（该假设将作为下游连线步骤的前提参与判定）' : ''),
      suggestions: [],
      verdictSource: 'premise',
      premiseVerdict: verdict,
    },
    metricUpdates: [],
  };
}

/**
 * 简化用户表达式（供 UI 展示「你的公式可化简为…」）。
 * 失败时返回 null，不阻塞。
 */
export async function trySimplify(expr: string): Promise<string | null> {
  try {
    const res = await simplifyExpression(expr);
    return res.ok ? res.result.result || null : null;
  } catch {
    return null;
  }
}

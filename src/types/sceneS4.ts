/**
 * S4 数理场景专属类型定义。
 *
 * 设计要点：
 * 1. 全部字段设计为「不影响 S1」——S1 的 SceneSpec 不写这些字段即为 undefined，
 *    运行时按 `spec.compute` 存在与否分流，不触碰 S1 任何代码路径。
 * 2. given 采用两分层：display（给人/LLM 看，含单位）+ symbol_value（剥离单位，供 SymPy 用）。
 * 3. 边界条件统一格式 `var->value`，符号必须在 symbols 中显式声明。
 * 4. 数学合法性由已连接前提的引擎判断；目标覆盖是独立语义检查，不匹配参考答案、不接管数学裁决。
 */

/* ==========================================================================
 * 一、计算配置
 * ========================================================================== */

/** 计算类型 */
export type ComputeType = 'formula' | 'data_modeling' | 'simulation';

/**
 * 已知条件项（两分层设计）。
 * - display：展示给用户与 LLM 的完整形式（含单位），如 "m0 = 1 kg"
 * - symbol_value：剥离单位后的纯数值/表达式，供 sympify 直用，如 "1"
 * - unit：仅用于量纲检查，不参与符号运算
 */
export interface GivenItem {
  /** 变量名，如 "m0"、"v" */
  name: string;
  /** 展示形式（必填），如 "m0 = 1 kg" */
  display: string;
  /** 供 SymPy 使用的纯值或表达式，如 "1"、"0.99*c"；缺省表示该量未定值 */
  symbol_value?: string;
  /** 单位，如 "kg"、"m/s"；仅用于量纲检查 */
  unit?: string;
  /**
   * 框外文字解释（前提链架构新增，可选）。
   *
   * 承载物理含义、取值理由、适用条件等**自然语言**内容。
   * 为什么不放进 display：LLM 天然爱写「其中 g 表示重力加速度」这类句子，
   * 一旦混入 display 就会污染符号计算（符号引擎无法解析自然语言）。
   * 故强制分层：数学式子进 display，解释进 note。
   */
  note?: string;
  /**
   * 解构结果（前提链架构新增，可选）。
   *
   * 缺省 → 按旧逻辑处理（单条常量，向后兼容旧场景文件）。
   * 存在且非空 → 该 given 节点是一个「**前提包**」：
   *   display 按分号切分并逐条分类后的结构化结果，
   *   连线即**全量引用**（函数定义 + 常量 + 定义域缺一不可）。
   * 存在但为空数组 → 解构失败降级，该节点**不可被引用**，UI 需标注。
   */
  entries?: PremiseEntry[];
}

/**
 * 前提条目类型（前提链架构新增）。
 *
 * - `definition`：函数定义，左边为 `名(参)` 形式，如 G(m) = m*g
 * - `constant`：常量赋值，右侧纯数值无自由符号，如 g = 9.81
 * - `domain`：定义域约束，含不等号，如 m >= 0、0 < x < 20
 * - `relation`：关系式，其它等式，如 x + 3 = y + 1
 */
export type PremiseEntryKind = 'definition' | 'constant' | 'domain' | 'relation';

/**
 * 前提条目（前提链架构新增）。
 *
 * `display` 供 MathLive 渲染（保留原排版与单位），`symbolic` 供 SymPy 计算。
 * 两者必须语义一致 —— 这是「信息不丢失」的落点：
 * 用户看到的 `g = 9.81 (m/s^2)` 与引擎算的 `g = 9.81` 是同一件事的两种呈现。
 */
export interface PremiseEntry {
  /** 条目类型 */
  kind: PremiseEntryKind;
  /** 给人看的形式，如 "g = 9.81 (m/s^2)" */
  display: string;
  /** 给引擎算的形式，如 "g = 9.81" */
  symbolic: string;
  /** 附加信息（可选） */
  meta?: {
    /** 单位，如 "m/s^2" */
    unit?: string;
    /** definition 的形参名，如 ["m"] */
    params?: string[];
    /** 涉及的自由符号名，如 ["g", "m"] */
    vars?: string[];
  };
}

/**
 * 步骤合法性判定结论（前提链架构新增）。
 *
 * - `legit`：能由已连线的前提推出
 * - `illegal`：推不出（含语法错误、除零风险、算错）
 * - `conflict`：前提集自相矛盾（如 m>0 与 m=0 同时出现）
 * - `unknown`：引擎未能判定（含孤立节点），显示待确认，不回落参考解或LLM数学终裁
 */
export type StepLegit = 'legit' | 'warn' | 'illegal' | 'conflict' | 'unknown';

/** 节点在判定时表达的意图：普通推导允许定义新符号，结论必须由前提推出。 */
export type StepIntent = 'derivation' | 'conclusion';

/** 引擎判定“成立”的依据，用于区分推出、恒等、定义和仅相容。 */
export type StepProofBasis =
  | 'entailed'
  | 'identity'
  | 'definition'
  | 'compatible'
  | 'declared'
  | 'unknown';

/** 步骤合法性判定的完整结果 */
export interface StepLegitResult {
  /** 判定结论 */
  legit: StepLegit;
  /**
   * 机器可读原因码：
   * - `ok`：通过
   * - `no_premise`：孤立节点，没有可追溯的前提依据
   * - `division_by_zero`：分母可能为 0
   * - `undeclared_symbol`：未定义的函数或符号
   * - `not_derivable`：无法由前提推出
   * - `premise_conflict`：前提集自相矛盾
   * - `unparsable`：表达式无法解析
   * - `partial_equation_declared`：已登记无函数体的偏微分约束
   * - `partial_identity_ok` / `partial_identity_mismatch`：函数体代入后的偏导恒等验证结果
   * - `partial_function_signature_missing`：偏导函数缺少 params 形参签名
   * - `timeout`：引擎未能判定
   */
  code: string;
  /** 本步为何成立；旧版引擎响应可能不包含该字段。 */
  proofBasis?: StepProofBasis;
  /** 技术细节（给 LLM 做解释用，不直接展示给用户） */
  detail?: string;
  /** 冲突涉及的两条前提（仅在 conflict 时存在） */
  conflictPair?: { scene: string; user: string };
}

/**
 * 支路前提集（前提链架构新增）。
 *
 * 由画布图（沿入边反向追溯祖先）收集而来 —— **没连线就没有前提关系**，
 * 不能用别处的结论来给本步背书。
 */
export interface BranchPremises {
  /** 该支路所有祖先的前提条目（含 given 的 entries 展开） */
  facts: string[];
  /** 该支路所有祖先的假设（assumption 节点） */
  assumptions: string[];
  /** 该支路所有祖先的定义域约束 */
  domains: string[];
  /** 场景级全局定义域（boundary_conditions） */
  globalDomains: string[];
  /** 祖先节点 id 列表（诊断用） */
  ancestorIds: string[];
  /** 已连线但尚未通过验证、因而不能作为前提的祖先节点。 */
  ignoredAncestorIds: string[];
}

/**
 * 符号种类。
 *
 * - `constant`：常量（有确定值，如光速 c = 299792458）
 * - `variable`：变量（可为范围，如速度 v ∈ [0, 0.99c]）
 * - `function`：函数（轮次 A 新增）。用于声明场景中使用的函数，如 `A(x)`（面积函数）。
 *   声明后 `A(x)` 会被识别为函数调用而非 `A*x` 乘法。
 *
 * 注意：**不声明也可用** —— 引擎会按「未声明标识符 + 左括号」自动识别为函数。
 * 声明的作用是「消除歧义 + 让下游（LLM、UI）明确知道哪些是函数」。
 */
export type SymbolKind = 'constant' | 'variable' | 'function';

/**
 * 显式符号表声明。
 * 边界条件与公式中出现的每个非字面量符号都必须在此声明，否则引擎报错。
 */
export interface SymbolDecl {
  /** 符号名，如 "c"、"v"、"m0" */
  name: string;
  /** constant=常量（有确定值）；variable=变量（可为范围） */
  kind: SymbolKind;
  /** kind='constant' 时的值（SymPy 可解析的表达式），如 "299792458" */
  value?: string;
  /** kind='variable' 时的取值范围（SymPy 可解析），如 ["0", "0.99*c"] */
  range?: [string, string];
  /** 中文展示名，如 "光速" */
  display?: string;
  /**
   * kind='function' 时的形参名列表（轮次 A 新增），如 ["x"]、["x", "y"]。
   * 用于让下游知道该函数接受几个参数、参数名分别是什么。
   */
  params?: string[];
  /**
   * kind='function' 时的函数体表达式（轮次 A 新增，可选），如 "x*(40-2*x)"。
   * 本轮仅登记，供后续（轮次 B）的代入求值使用。
   */
  body?: string;
  /**
   * 正值假设（前提链架构新增）。
   *
   * 开启后符号被声明为 `positive=True`，引擎可完成 `sqrt(c**2) = c` 一类化简
   * （否则因 `sqrt(c**2) = |c|` 而停在原地，导致正确推导被判 unknown）。
   *
   * 适用对象：物理/数学语境中必然为正的量（光速 c、质量 m、边长 x）。
   * 不确定或可能为负时**不要**设置（缺省 false）。
   */
  positive?: boolean;
  /**
   * 按复数域计算（前提链架构新增）。
   *
   * 缺省 false（实数域，符号带 `real=True`）。
   * 为 true 时不做 real / positive 假设，且跳过除零安全检查。
   */
  complex?: boolean;
}

/**
 * 边界条件。
 * 统一格式：`<符号>-><目标值>`，示例：["v->0", "v->c", "v->0.99*c"]
 * 解析规则见 derivationRuntime.parseBoundaryCondition。
 */
export type BoundaryCondition = string;

/**
 * 参考解单步（两分层，轮次 B 新增）。
 *
 * 设计取舍：`symbolic` 有意设计为**可选**。省略表示「该步仅作展示、
 * 不参与自动判定」—— 适用于人类论证步骤（定义域声明 0<x<20、
 * 不等式论证 A''(10)=-4<0），这些步骤强行符号化只会引入误判风险。
 */
export interface ExpectedStep {
  /**
   * 给人看的完整形式（必填）。
   * 可含 LaTeX、中文单位、\boxed{}、链式不等式等教学表达。
   */
  display: string;
  /**
   * 给引擎用的纯 SymPy 形式（可选）。
   * 省略 → 该步不参与自动判定，仅展示。
   * 例：diff(A(x), x) = 40 - 4*x、A(x) = x*(40-2*x)。
   */
  symbolic?: string;
  /** 该步做了什么（可选），如「移项」「代入 x=10」「二阶导判号」 */
  note?: string;
}

/** 参考解步骤输入：兼容旧字符串格式与新两分层对象 */
export type ExpectedStepInput = string | ExpectedStep;

/** 计算配置（S4 的核心） */
export interface ComputeSpec {
  /** 计算类型 */
  type: ComputeType;
  /** 已知条件（两分层） */
  given: GivenItem[];
  /** 显式符号表（必填，可为空数组表示无需额外符号） */
  symbols: SymbolDecl[];
  /** 操作类型描述，如 "simplify"、"differentiate"、"integrate"、"solve" */
  operation: string;
  /** 期望的最终公式（SymPy 可解析的表达式字符串或等式），等价性判定锚点 */
  expected_formula: string;
  /**
   * 参考解步骤表（可选）。
   * - 存在 → 多式模式：每个用户节点按等价性匹配到某一步，精确反馈
   * - 缺失 → 单式模式：只校验最终节点，中间步骤仅 LLM 定性评估
   *
   * **两分层（轮次 B）**：每步可写成纯字符串（旧格式，等价于只给 display），
   * 或 `ExpectedStep` 对象（推荐），分离「给人看」与「给引擎算」。
   *
   * 为什么必须分层（实测确认）：
   * - 给人看需要教学可读性：中文单位（200 平方米）、LaTeX（\boxed{}）、
   *   不等式（0<x<20）—— 这些引擎都无法直接解析；
   * - 给引擎算必须纯 SymPy：200、2*x + y = 40、x < 20。
   *
   * 若不分层，用户示例中的「0<x<20」「A''(10)=-4<0」「\boxed{...}」
   * 三步会因 PARSE_ERROR 而无法参与判定（实测：链式不等式报
   * "cannot determine truth value of Relational"，LaTeX 命令一律报错）。
   *
   * 旧数据兼容：字符串项由 `parseComputeSpec` 自动包装为 `{ display }`。
   */
  expected_steps?: ExpectedStepInput[];
  /** 预期步骤数（用于计算求助次数上限），必填 */
  expected_steps_count: number;
  /** 边界条件清单 */
  boundary_conditions: BoundaryCondition[];
}

/* ==========================================================================
 * 二、求助配置
 * ========================================================================== */

/** 求助配置 */
export interface HelpSpec {
  /** 基础求助次数（生成阶段由 LLM 依 expected_steps_count 建议，系统会重算覆盖） */
  base_help_count: number;
  /** 难度系数（默认 1.0） */
  difficulty_factor: number;
  /** 用户系数（默认 1.0，可依画像调整） */
  user_factor: number;
  /** 显式求助上限；0 禁用。系统不得超过该值或公式预算。 */
  max_help_count: number;
  /** 每次求助统一扣分系数，0–1；同时用于独立性和最终评分，默认 0.1。 */
  penalty_per_help: number;
}

/* ==========================================================================
 * 三、画布节点
 * ========================================================================== */

/**
 * 节点类型。
 *
 * 注：原 `note`（独立注释节点）已移除 —— 注释语义改为挂在公式/结论节点内的
 * `note` 字段（见 `DerivationNodeData.note`），因为它解释的是「某一步为什么这样做」，
 * 与具体步骤强绑定，独立成节点会让 LLM 无法判断它在解释哪一步。
 */
export type DerivationNodeType = 'given' | 'formula' | 'conclusion' | 'assumption';

/** 节点状态（六态） */
export type DerivationNodeStatus = 'draft' | 'pending' | 'pass' | 'warn' | 'fail' | 'frozen';

/**
 * 判定来源（用于 UI 区分「引擎验证」与「AI 裁决」）。
 *
 * - `engine`：计算引擎判定（保留给既有数据兼容）
 * - `llm`：LLM 裁决
 * - `none`：尚未判定
 * - `premise`：**前提链判定** —— 由画布连线决定的前提集推导得出，
 *   不依赖参考答案。**轮次 N 起为本场景唯一判据**（参考链已删除）
 */
export type VerdictSource = 'engine' | 'llm' | 'none' | 'premise';

/** 单节点的验证结果 */
export interface NodeVerification {
  /** Semantic task coverage is separate from mathematical validity; bound locally to the exact branch. */
  goalAssessment?: { status: 'achieved' | 'not-achieved' | 'unknown'; reason: string; inputKey: string };
  /** 当前表达式是否通过验证；S4 运行以已连接前提的引擎判定为准。 */
  formula_correct: boolean;
  /** 数值误差（连续型指标用），0~1 */
  numerical_error?: number;
  /** 量纲是否一致 */
  dimension_check: boolean;
  /** 已覆盖的边界条件列表 */
  boundary_coverage?: string[];
  /** 给出的反馈文字（LLM 生成） */
  feedback: string;
  /** 建议列表 */
  suggestions?: string[];
  /** 判定来源 */
  verdictSource: VerdictSource;
  /**
   * 未声明符号的重命名映射（选填）。
   *
   * 非空表示该步骤是靠「把用户自造的符号名映射到参考解符号」才判等价的
   * （例如用户把 x 写成 a）。此时节点会降级为 `warn`，UI 应据此提示
   * 「你使用了未声明的符号，本场景的自变量是 …」，既有教学价值又不误判为错。
   */
  renamedSymbols?: Record<string, string>;
  /**
   * 引擎识别到的函数名列表（轮次 A 新增，选填）。
   *
   * 非空时 UI 应显示「已识别为函数：A」类标记，使识别结果对用户可见 ——
   * 用户写 `a(x+1)` 本意是乘法时，这行提示能让他知道应改写为 `a*(x+1)`。
   */
  detectedFunctions?: string[];
  /**
   * 前提链判定结果（前提链架构新增，选填）。
   *
   * 由 `premiseChain.judgeStepLegitimacy` 产出。存在且 `legit === 'legit'`
   * 时，`formula_correct` 为 true；`unknown` 保持待确认。
   * 不以参考解比对或LLM意见替代引擎结论。
   */
  premiseVerdict?: StepLegitResult;
}

/** 节点数据 */
export interface DerivationNodeData {
  /** 节点标签，如 "Step 1"、"已知条件" */
  label: string;
  /** MathLive 输出的 LaTeX */
  latex?: string;
  /** MathLive Compute Engine 输出的 MathJSON */
  mathJson?: unknown;
  /**
   * 该步骤的解释（选填）。
   *
   * 语义：说明「为什么这样做」，如「因为洛伦兹因子在低速下近似为 1」。
   * 用途：随公式一起进入 LLM 上下文（验证与求助），但**不参与对错判定**。
   */
  note?: string;
  /** 节点状态 */
  status: DerivationNodeStatus;
  /** 验证结果（提交后填充） */
  verification?: NodeVerification;
  /** 是否已冻结（不可编辑） */
  frozen: boolean;
  /** 量纲/单位提示（由 LLM 生成，展示用） */
  unitHint?: string;
  /**
   * given 节点的前提条目（前提链架构）。
   *
   * 仅 `given` 节点填充：由场景生成阶段解构 `ComputeSpec.given[].entries` 得到。
   * `premiseChain.collectBranchPremises` 据此把「前提包」逐条展开为
   * facts / domains —— 连线即**全量引用**（函数定义 + 常量 + 定义域缺一不可）。
   *
   * 三态语义（与 `GivenItem.entries` 一致）：
   * - 非空数组   → 前提包，逐条参与判定
   * - 空数组     → 解构失败降级，该节点**不可被引用**（UI 应标注）
   * - undefined  → 旧场景，走 `display` / `symbol_value` 兜底
   *
   * 为什么必须作为显式字段（而非强转读取）：
   * `premiseChain.givenEntriesOf` 此前用 `as unknown as { entries?: ... }` 强转，
   * 而 `buildGivenNodes` 从不写入 —— 即使生成阶段解析出 entries 也传不到引擎，
   * 形成一条隐式且断裂的契约。显式声明后该链路可被类型检查覆盖。
   */
  entries?: PremiseEntry[];
}

/** 画布节点 */
export interface DerivationNode {
  id: string;
  type: DerivationNodeType;
  position: { x: number; y: number };
  data: DerivationNodeData;
}

/* ==========================================================================
 * 四、画布连线
 * ========================================================================== */

/**
 * 连线类型。
 *
 * 已收敛为单一类型：公式推导是单链分支结构，以已知条件为起点逐级求解；
 * 不同解法直接从同一节点引出另一条路径即可，无需再用连线类型区分
 * 「分支 / 对比 / 依赖」。多类型不仅增加认知负担，还会把无定义的英文枚举
 * 塞进 LLM 上下文（求助链路会渲染连线），反而干扰语义理解。
 */
export type DerivationEdgeType = 'derivation';

/** 画布连线 */
export interface DerivationEdge {
  id: string;
  /** 源节点 id */
  source: string;
  /** 目标节点 id */
  target: string;
  type: DerivationEdgeType;
  /** 连线说明，如 "代入洛伦兹因子" */
  label?: string;
}

/* ==========================================================================
 * 五、画布状态
 * ========================================================================== */

/** 画布运行态（挂到 SceneRunState.canvas） */
export interface DerivationCanvasState {
  nodes: DerivationNode[];
  edges: DerivationEdge[];
  viewport: { x: number; y: number; zoom: number };
  /** 已使用求助次数 */
  helpUsed: number;
  /** 求助上限（从 HelpSpec.max_help_count 复制，便于运行态读取） */
  maxHelp: number;
  /** 独立性得分（初始 1.0，每次求助 −0.1，下限 0） */
  independenceScore: number;
}

/* ==========================================================================
 * 六、事件流
 * ========================================================================== */

/** 事件流条目基类 */
interface DerivationEventBase {
  /** ISO 时间戳 */
  at: string;
}

/** Origin receipt for a helper card; legacy cards may have no usable origin key. */
export interface S4HelpSource {
  nodeId: string | null;
  inputKey?: string;
}

/** S4 事件流联合类型 */
export type DerivationEvent =
  | (DerivationEventBase & { type: 'node_create'; nodeId: string; nodeType: DerivationNodeType })
  | (DerivationEventBase & { type: 'node_edit'; nodeId: string; oldLatex: string; newLatex: string })
  | (DerivationEventBase & { type: 'node_submit'; nodeId: string; latex: string })
  | (DerivationEventBase & { type: 'node_verify'; nodeId: string; result: DerivationNodeStatus; details: NodeVerification })
  | (DerivationEventBase & { type: 'node_freeze'; nodeId: string })
  | (DerivationEventBase & { type: 'edge_create'; from: string; to: string; edgeType: DerivationEdgeType })
  | (DerivationEventBase & { type: 'edge_delete'; edgeId: string })
  | (DerivationEventBase & { type: 'help_request'; step: string; query: string; helpLevel: number })
  | (DerivationEventBase & { type: 'help_response'; step: string; content: HelpResponse; remaining: number; nodeId?: string | null; inputKey?: string })
  | (DerivationEventBase & { type: 'goal_check_request'; nodeId: string; inputKey: string })
  | (DerivationEventBase & { type: 'assistant_query'; content: string });

/* ==========================================================================
 * 七、LLM 结构化输出契约
 * ========================================================================== */

/** scene-formula-parse 的返回 */
export interface FormulaParseResult {
  /** SymPy 可解析的表达式字符串 */
  sympy_expr: string;
  /** 涉及的变量名列表 */
  variables: string[];
  /** 置信度 0~1 */
  confidence: number;
  /** 解析说明 */
  explanation: string;
  /**
   * 是否为等式形式（选填）。
   *
   * 引擎 `parse` 命令在识别到单等号时会返回 true，并由 `sympy_expr` 保留
   * 「lhs = rhs」形式（而非压成差式）。保留该标记是为了让下游仍能区分
   * 「方程（约束）」与「表达式（解）」——这是「上游推导 vs 最终结果」判定口径的前提。
   */
  is_equation?: boolean;
}

/** SymPy 等价性判定的结果 */
export interface EquivalenceResult {
  /** 是否等价（true/false/unknown） */
  equivalent: boolean | 'unknown';
  /** 命中的策略级别 0~5；0 = 全部失败 */
  strategyLevel: number;
  /** 使用的策略名，如 'numeric_exact' / 'simplify_diff' */
  strategy: string;
  /** 未确定时的差异表达式 */
  difference?: string;
  /**
   * 相对误差（0~1），仅当两侧均为纯数值时由引擎给出。
   *
   * 用途：填入 `numerical_error` 指标。此前该值只能由 LLM 猜测，
   * 指标实际退化为「对=0 / 错=1」二值；现由 SymPy 精确计算（原则 10）。
   */
  relative_error?: number;
  /**
   * 等式关系（选填），用于区分「写法/阶段差异」与「内容错误」。
   *
   * - 'none'：两侧皆非等式
   * - 'both_equation'：两侧皆为方程（按「同解方程」口径比对）
   * - 'user_equation_only'：仅用户侧是方程
   *   （如用户列方程 2x+y=40，参考解是移项后的表达式 40-2*x —— 属正确的上游推导）
   * - 'expected_equation_only'：仅参考解侧是方程
   */
  equationRelation?: 'none' | 'both_equation' | 'user_equation_only' | 'expected_equation_only';
  /**
   * 靠「未声明符号重命名」才判等价时的映射表（选填），形如 `{ "a": "x" }`。
   * 非空即表示该结论应降级为 `warn`，并用于生成提示话术。
   */
  renamedSymbols?: Record<string, string>;
  /**
   * 是否应降级为 `warn`（选填）。
   * 目前仅当命中「未声明符号重命名」，或链式等式自洽校验未通过时为 true
   * —— 数学上等价（或主判定通过），但写法/推导过程存在问题。
   */
  warnOnly?: boolean;
  /**
   * 值集合明细（选填，轮次 D）。
   *
   * 仅当命中「多值答案」口径（`equationKind === 'value_set'`）时出现。
   * 列出两侧解析出的值，供 UI 直观展示「你写了 {1,7}，答案是 {1,5}」。
   */
  valueSet?: { user: string[]; expected: string[] };
  /**
   * 用户侧的定义域约束（选填，轮次 D），如 `["x>0", "y>0"]`。
   *
   * 仅当输入含末段约束组（`xy=4 (x>0,y>0)`）时出现。
   */
  userConstraints?: string[];
  /**
   * 参考解侧的定义域约束（选填，轮次 D）。
   *
   * 与 `userConstraints` 配合用于生成「缺少定义域限定」提示（决策 1①）。
   */
  expectedConstraints?: string[];
  /**
   * 否定结论是否「证据不足」（选填，轮次 C 修复 C）。
   *
   * 仅在 `equivalent === false` 时可能出现。为 true 表示引擎判不等价，
   * 但**数值采样未能给出明确否定**（返回 None 而非 False）—— 典型成因是
   * 符号缺少正值假设，导致 `sqrt(c**2 - v**2)` 这类式子无法从根号里提出
   * c²（`sqrt(c**2)=|c|`），级别 1~4 的化简全部推不动。
   *
   * 此时前端应把判定权交给 LLM 复核（见 `equivalence.ts`），
   * 避免「用户写对了却被判红叉」。
   *
   * 反例（硬否定，不会置该标记）：数值采样即可确认对不上，
   * 如 `x+1` vs `x+2` —— 此时 LLM 复核纯属浪费，直接采信引擎结论。
   */
  weakNegative?: boolean;
  /**
   * 引擎识别到的函数名列表（轮次 A 新增）。
   * 把「哪些标识符被当成了函数」透明地告知用户与 LLM。
   */
  detectedFunctions?: string[];
  /**
   * 用户输入的结构类别（轮次 A 新增）。
   *
   * - `expression`：普通表达式或普通方程，如 `40 - 2*x`、`2*x+y=40`
   * - `definition`：函数定义等式，如 `A(x) = x*(40-2*x)`（判定取右侧）
   * - `assignment`：常量赋值，如 `x0 = 1`（右侧无自由符号）
   * - `chain`：链式等式，如 `a = b = c`（主判定取末段 + 相邻段自洽校验）
   */
  equationKind?: 'expression' | 'definition' | 'assignment' | 'chain';
  /**
   * 链式等式的自洽校验结果（轮次 A 新增，仅 equationKind='chain' 时出现）。
   *
   * `ok=false` 时 `failAtIndex` 给出第一处不自洽的相邻段序号（从 1 起），
   * 前端据此提示「第 N 段与第 N+1 段不相等」，避免笼统说「写错了」。
   */
  chainCheck?: { ok: boolean; failAtIndex?: number; detail?: string };
}

/** scene-compute-analyze 的返回 */
export interface ComputeAnalyzeResult {
  formula_correct: boolean;
  numerical_error?: number;
  boundary_coverage: string[];
  dimension_check: boolean;
  physical_meaning: string;
  feedback: string;
  suggestions: string[];
}

/** scene-help 的返回 */
export interface HelpResponse {
  /** 针对的步骤序号（1 起） */
  step_number: number;
  /** 该步骤的内容描述 */
  step_content: string;
  /** 该步骤的 LaTeX（可直接插入画布） */
  latex: string;
  /** 为何这样做的原因说明 */
  reason: string;
  /** 关联知识点 */
  related_knowledge: string[];
  /** 若用户当前步骤有误，先纠正（null 表示无误） */
  correction: string | null;
}

/* ==========================================================================
 * 八、IPC 契约
 * ========================================================================== */

/** SymPy 服务的命令名 */
export type ComputeCommand =
  | 'ping'
  | 'parse'
  | 'verify_equiv'
  | 'limit'
  | 'check_units'
  | 'plot_data'
  | 'substitute'
  | 'simplify'
  | 'solve_intersections'
  // ---- 前提链会话（前提链架构新增）----
  /** 初始化会话：编译符号环境（场景启动时调用一次） */
  | 'session_init'
  /** 判定单步合法性（前提链前置关卡） */
  | 'session_step'
  /** 校验用户假设前提是否与祖先前提冲突 */
  | 'session_assume'
  /** 按分号切分前提包内容并分类（解构校验用） */
  | 'session_split'
  /** 关闭会话，释放缓存 */
  | 'session_close';

/** IPC 请求 */
export interface ComputeIpcRequest {
  cmd: ComputeCommand;
  /** 命令参数，结构依 cmd 而定 */
  args: Record<string, unknown>;
}

/** IPC 响应 */
export interface ComputeIpcResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
  /** 结构化错误码 */
  errorCode?: string;
}

/** SymPy 服务状态 */
export interface ComputeServiceStatus {
  ready: boolean;
  warming: boolean;
  error?: string;
}

/* ==========================================================================
 * 九、常量
 * ========================================================================== */

/** 求助次数计算基数系数（预期步骤 × 0.2） */
export const HELP_RATIO = 0.2;
/** 独立性指标每次求助的扣分 */
export const INDEPENDENCE_PENALTY_PER_HELP = 0.1;
/** 独立性加分系数（最终得分中 independence_score × 该值） */
export const INDEPENDENCE_BONUS_FACTOR = 0.1;
/** SymPy 等价性数值采样点数 */
export const EQUIV_SAMPLE_POINTS = 200;
/** SymPy 调用超时（毫秒） */
export const COMPUTE_TIMEOUT_MS = 15000;
/** SymPy 服务协议版本 */
export const SYMPY_SERVER_PROTOCOL_VERSION = 1;
/** 节点状态颜色语义（供画布与助手复用） */
export const DERIVATION_STATUS_LABEL: Record<string, string> = {
  draft: '待提交',
  pending: '验证中',
  pass: '正确',
  warn: '需注意',
  fail: '有误',
  frozen: '已锁定',
};

/** S1 场景类型标识（供分流判断使用，避免散落魔法字符串） */
export const SCENE_SKILL_S1 = 'S1' as const;
/** S4 场景类型标识 */
export const SCENE_SKILL_S4 = 'S4' as const;

/* ==========================================================================
 * 十、参考解步骤工具（两分层适配）
 * ========================================================================== */

/**
 * 取某步的**展示文本**（给人看）。
 * 字符串项直接返回；对象项返回 `display`。
 * 定义在类型模块内，避免各调用方各自重复判断。
 */
export function stepDisplay(step: ExpectedStepInput): string {
  return typeof step === 'string' ? step : step?.display ?? '';
}

/**
 * 取某步的**可判定表达式**（给引擎算）。
 *
 * 返回 `undefined` 表示该步「仅展示、不参与自动判定」——
 * 调用方遇到 undefined 必须跳过该步，**不可**回退到 display
 * （display 可能含中文单位 / LaTeX / 链式不等式，喂给引擎必然 PARSE_ERROR）。
 */
export function stepSymbolic(step: ExpectedStepInput): string | undefined {
  if (typeof step === 'string') return step;
  const s = step?.symbolic;
  return typeof s === 'string' && s.trim() ? s.trim() : undefined;
}

/** 取某步的意图说明（可选），如「移项」「代入 x=10」 */
export function stepNote(step: ExpectedStepInput): string | undefined {
  return typeof step === 'string' ? undefined : step?.note;
}

/**
 * 把 LLM 返回的 `expected_steps` 归一为 `ExpectedStepInput[]`。
 *
 * 为什么必须归一（轮次 B 关键修复）：
 * LLM 可能返回三种形态 —— 纯字符串数组（旧格式）、两分层对象数组（新格式）、
 * 或两者混用。若不归一直按「字符串」过滤，**对象项会被静默丢弃**，
 * 参考解步骤凭空少几条，且没有任何报错提示，属最难排查的一类缺陷。
 *
 * 容错口径：
 * - 字符串 → 保留（等价于只给 display）
 * - 有 display 的对象 → 保留（symbolic / note 可选）
 * - 只有 symbolic 无 display 的对象 → 用 symbolic 兜 display（避免空展示）
 * - 两者皆无 → 丢弃（无信息量）
 */
export function normalizeExpectedSteps(raw: unknown): ExpectedStepInput[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ExpectedStepInput[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const s = item.trim();
      if (s) out.push(s);
      continue;
    }
    if (item && typeof item === 'object') {
      const o = item as Partial<ExpectedStep>;
      const display = typeof o.display === 'string' ? o.display.trim() : '';
      const symbolic = typeof o.symbolic === 'string' ? o.symbolic.trim() : '';
      const note = typeof o.note === 'string' ? o.note.trim() : '';
      if (!display && !symbolic) continue;
      out.push({
        // 只有 symbolic 时用 symbolic 兜底展示，保证 UI 不出现空条目
        display: display || symbolic,
        ...(symbolic ? { symbolic } : {}),
        ...(note ? { note } : {}),
      });
    }
  }
  return out.length ? out : undefined;
}

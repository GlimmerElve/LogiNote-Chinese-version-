# 前提链判定架构实施计划（S4 数理场景）

> 已归档：该实施计划已被后续方案取代，仅保留作历史参考。

## [Overview]

把 S4 数理场景的判定依据，从「与 LLM 生成的参考答案做等价比对」改为「**由画布连线关系决定的前提链推导**」，参考答案降级为兜底与路径参考。

**问题背景**：现有链路 `analyzeStep → matchReferenceStep → judgeEquivalence` 全程只做一件事——拿用户表达式去和 `compute.expected_formula` / `expected_steps[].symbolic` 做等价判定。`compute.given` / `symbols.value` / `symbols.range` / `boundary_conditions` 这些「题目给定的前提」**从未参与判定**。后果是：LLM 给出的参考答案一旦有误（或只是走了另一条正确解法），正确用户被判错、错误用户被判对。

**新架构的三条核心原则**：

1. **前提由连线决定**。节点 N 的前提集 = 沿入边反向追溯得到的所有祖先节点内容 + 全局符号声明。没连线就没有前提关系，不能用别处的结论来给本步背书。
2. **前提是块，不是条**。一个 `given` 节点承载完整的使用条件（函数定义 + 常量 + 定义域），连线即全量引用，缺一不可。
3. **叠加不替换**。新增「前提链判定器」作为前置关卡；通过则直接定论，无法判定才落回现有参考解比对链路（`matchReferenceStep` / `judgeEquivalence` / `cmd_verify_equiv` 全部保留、不改签名）。

**用户已拍板的决策**（D1~D6 + 细节 A/B + 补充规则）：

| 议题 | 结论 |
|---|---|
| D1 参考答案定位 | 仅作路径参考与兜底，判定权归前提链 |
| D2 变形类型 | 等式变形、代入、微积分、代数恒等变换全接受 |
| D3 用户假设 | 新建 `assumption` 节点类型；仅在该支路生效；冲突即报错 |
| D4 判定优先级 | SymPy 形式逻辑结论优先于一切 |
| D5 改造方式 | 先叠加，保留参考解比对作为兜底 |
| D6 `expected_steps.symbolic` | 暂只用于展示与兜底 |
| 细节 A 定义写在哪 | 写在普通公式节点里，引擎自动识别并登记（用户无感） |
| 细节 B 修改已定义内容 | 允许修改，下游节点自动作废回 `draft` |
| 符号默认域 | 实数全域；未声明定义域时 `v/x` 报「x 可能为 0」 |
| 复数 | 必须显式声明才按复数算 |
| 孤立节点 | 不算错，判 `warn`（"缺少前提依据"） |
| `given` 复用 | 不新增 `premise` 类型，直接扩展 `GivenItem` |
| `given` 生成约束 | 数学式子进 `display`，文字解释进 `note`，严格分离 |
| 分隔符 | 英文分号 `;`，单行内多条 |

**改动总览**：修改 **11** 个文件 · 新建 **5** 个文件 · 新增 **0** 个依赖。

---

## [Types]

### `src/types/sceneS4.ts` 的类型扩展

**1. 节点类型扩展（新增 `assumption`）**

```ts
/** 节点类型（新增 assumption：用户假设前提） */
export type DerivationNodeType = 'given' | 'formula' | 'conclusion' | 'assumption';
```

**2. 前提条目（新增）**

```ts
/**
 * 前提条目类型。
 * - definition：函数定义，左边为 名(参) 形式，如 G(m) = m*g
 * - constant：常量赋值，右侧纯数值无自由符号，如 g = 9.81
 * - domain：定义域约束，含不等号，如 m >= 0、0 < x < 20
 * - relation：关系式，其它等式，如 x + 3 = y + 1
 */
export type PremiseEntryKind = 'definition' | 'constant' | 'domain' | 'relation';

/**
 * 前提条目（解构结果）。
 * display 供 MathLive 渲染（保留原排版与单位），symbolic 供 SymPy 计算。
 * 两者必须语义一致，缺一不可。
 */
export interface PremiseEntry {
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
```

**3. `GivenItem` 扩展（新增 `note` / `entries`）**

```ts
export interface GivenItem {
  /** 块标题，如 "重力模型"。禁止包含公式或符号。 */
  name: string;
  /**
   * 框内数学内容（MathLive 渲染）。
   * 多条用英文分号 `;` 分隔。禁止自然语言。
   * 例："G(m) = m*g ; m >= 0 ; g = 9.81 (m/s^2)"
   */
  display: string;
  /**
   * 框外文字解释（新增，可选）。
   * 承载物理含义、取值理由、适用条件。不参与符号计算。
   */
  note?: string;
  /**
   * 解构结果（新增，可选）。
   * 缺省 → 按旧逻辑处理（单条常量）。
   * 存在 → 该 given 节点是「前提包」，连线即全量引用。
   * 解构失败降级时置空数组，此时该节点不可被引用。
   */
  entries?: PremiseEntry[];
  /** 旧字段：供 SymPy 使用的纯值或表达式（兼容保留） */
  symbol_value?: string;
  /** 旧字段：单位（兼容保留） */
  unit?: string;
}
```

**4. `SymbolDecl` 扩展（新增 `positive` / `complex`）**

```ts
export interface SymbolDecl {
  name: string;
  kind: SymbolKind;
  value?: string;
  range?: [string, string];
  display?: string;
  params?: string[];
  body?: string;
  /**
   * 正值假设（新增）。
   * 开启后引擎可推导 sqrt(c^2) = c 一类化简（否则 sqrt(c^2) = |c|）。
   * 缺省 false。
   */
  positive?: boolean;
  /**
   * 按复数域计算（新增）。
   * 缺省 false（实数域）。为 true 时不做零值安全性检查。
   */
  complex?: boolean;
}
```

**5. 判定结果类型（新增）**

```ts
/** 步骤合法性判定结果 */
export type StepLegit = 'legit' | 'illegal' | 'conflict' | 'unknown';

export interface StepLegitResult {
  /** 判定结论 */
  legit: StepLegit;
  /**
   * 机器可读原因码：
   * - ok：通过
   * - division_by_zero：分母可能为 0
   * - undeclared_symbol：未定义的函数或符号
   * - not_derivable：无法由前提推出
   * - premise_conflict：前提集自相矛盾
   * - timeout：判定超时
   * - engine_error：引擎异常
   */
  code: string;
  /** 技术细节（给 LLM 看，不直接展示给用户） */
  detail?: string;
  /** 冲突涉及的两条前提（conflict 时存在） */
  conflictPair?: { scene: string; user: string };
}

/** 支路前提集（由画布图收集） */
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
}
```

**6. `NodeVerification` 扩展**

```ts
export interface NodeVerification {
  // ... 现有字段 ...
  /** 前提链判定结果（新增，可选） */
  premiseVerdict?: StepLegitResult;
  /** 判定来源扩展：新增 'premise'（前提链判定） */
  verdictSource: 'engine' | 'llm' | 'none' | 'premise';
}
```

**7. IPC 命令扩展**

```ts
export type ComputeCommand =
  | 'ping' | 'parse' | 'verify_equiv' | 'limit' | 'check_units'
  | 'plot_data' | 'substitute' | 'simplify' | 'solve_intersections'
  // 新增
  | 'session_init' | 'session_step' | 'session_assume' | 'session_close';
```

---

## [Files]

### 新建文件

| 路径 | 用途 |
|---|---|
| `src/modules/derivationCanvas/utils/branchGraph.ts` | 图遍历纯函数：反向追溯祖先、正向收集后代、直接父节点 |
| `src/modules/derivationCanvas/components/AssumptionNode.tsx` | 用户假设前提节点组件（基于 NodeShell，配色区别于公式节点） |
| `src/services/scene/premiseChain.ts` | 前提链判定编排：收集支路前提 → 调用 engine → 组装结论 |
| `python/_probe_premise.py` | 验收探针（临时文件，验收后删除） |
| `implementation_plan_premise_chain.md` | 本文档 |

### 修改文件

| 路径 | 改动 |
|---|---|
| `src/types/sceneS4.ts` | 新增 `PremiseEntry` / `StepLegit` / `BranchPremises` 等；扩展 `GivenItem` / `SymbolDecl` / `DerivationNodeType` / `NodeVerification` / `ComputeCommand` |
| `src/services/scene/computeClient.ts` | 新增 4 个命令包装函数 |
| `src/services/scene/computeAnalyze.ts` | `analyzeStep` 插入前提链前置关卡；新增 `analyzeAssumptionStep` |
| `src/services/scene/derivationRuntime.ts` | `buildGivenNodes` 支持 `entries` 渲染多条目 / `note` 展示；新增 `invalidateDescendants` |
| `src/modules/derivationCanvas/derivationStore.ts` | `DEFAULT_LABEL` 加 `assumption`；`updateNode` / `removeNode` 触发下游作废 |
| `src/modules/derivationCanvas/DerivationCanvas.tsx` | `nodeTypes` 注册 `assumption`；工具栏加「假设前提」按钮 |
| `src/modules/derivationCanvas/nodeVisuals.ts` | `NODE_TYPE_LABEL` 加 `assumption`；假设节点配色常量 |
| `src/components/scene/SceneMode.tsx` | 会话生命周期（init/close）；提交分流（assumption 独立分支）；下游作废提示 |
| `src/workflows/sceneComputePrompt.ts` | 新增 `given` 生成规范条款（含正反例）；符号正值属性要求 |
| `python/sympy_server.py` | 新增 4 个会话命令 + 判定函数；`COMMANDS` 字典更新 |
| `src/components/scene/StandardSolutionView.tsx` | 参考解展示（`symbolic` 字段降级为纯展示，如需调整） |

### 不修改（红线）

| 路径 | 原因 |
|---|---|
| `src/components/scene/SceneChatView.tsx` | R1 S1 隔离契约 |
| `src/services/scene/sceneDirector.ts` | R1 |
| `src/services/scene/sceneSignal.ts` | R1 |
| `src/workflows/scenePrompt.ts` | R2 |
| `src/modules/argumentCanvas/**` | R8 独立性 |
| `src/services/scene/equivalence.ts` | D5 叠加式，作为兜底原样保留 |
| `cmd_verify_equiv` / `matchReferenceStep` | D5 兜底链路，不改签名 |

---

## [Functions]

### Python 侧新增函数（`python/sympy_server.py`）

全部新增函数必须定义在 `COMMANDS` 字典**之前**（否则启动时 NameError）。

**1. `_compile_symbols(symbols)`**

```
签名：_compile_symbols(symbols) -> dict
用途：把 SymbolDecl 列表编译成 sympify 的 locals 字典。
要点：
  - kind='function' → sp.Function(name)，params 记录形参
  - kind='constant' + value → 直接 sympify 成数值
  - kind='variable' + range → sp.Symbol(name, real=True)
  - positive=True → sp.Symbol(name, positive=True)
  - complex=True → sp.Symbol(name)（不做 real 假设）
返回：{name: sympy_object}
```

**2. `_split_premise_entries(raw)`**

```
签名：_split_premise_entries(raw) -> list[str]
用途：把 display 按英文分号 `;`（及中文分号 `；`）切分为条目字符串列表。
要点：过滤空白项；保留括号内分号（用括号深度计数，不简单 split）。
返回：["G(m) = m*g", "m >= 0", "g = 9.81"]
```

**3. `_check_division_safety(expr_str, symbol_table, domains)`**

```
签名：_check_division_safety(expr_str, symbol_table, domains) -> str | None
用途：检查表达式中的分母是否可能为 0。
实现：
  1. sympify 表达式，取所有分母（fraction / denom 递归收集）
  2. 对每个分母 d，构造方程 d = 0
  3. 检查 domains（不等式列表）与新符号假设能否排除该方程
  4. 若无法排除（存在满足 d=0 的取值）→ 返回 'division_by_zero'
返回：错误码字符串，或 None（安全）
注意：分母为纯数值非零常数时直接跳过；complex=True 的符号跳过检查。
```

**4. `_check_undeclared(expr_str, declared_names, function_names)`**

```
签名：_check_undeclared(expr_str, declared_names, function_names) -> str | None
用途：检查表达式中是否有未声明的自由符号或未定义的函数。
实现：
  1. sympify，取 free_symbols
  2. 与 declared_names 求差集
  3. 检查 AppliedUndef（未定义函数对象）是否在 function_names 中
返回：'undeclared_symbol' 或 None
注意：数值常量（pi、E）不算未声明。
```

**5. `_check_premise_conflict(premises)`**

```
签名：_check_premise_conflict(premises) -> tuple[bool, str | None]
用途：检查前提集是否自相矛盾。
实现：
  1. 把 premises（facts + assumptions + domains）全部 sympify
  2. 用 sp.satisfiable(And(*relations), timeout=5) 判定
  3. 返回 False（不可满足）→ (True, 矛盾说明)
返回：(是否冲突, 说明文本)
注意：
  - 必须用 timeout 参数（satisfiable 可能很慢）
  - 超时视为「不冲突」（交给后续步骤兜底）
  - 拼多个约束用 And(*list)，**绝不可用逗号 join**（会成 tuple）
```

**6. `_check_derivable(premises, current)`**

```
签名：_check_derivable(premises, current) -> str
用途：判定当前表达式能否由前提集推出。
实现：
  1. sympify 全部 premises 与 current
  2. 目标判定：satisfiable(And(*premises) & Not(current)) 
     - 无解（False）→ 'legit'（前提蕴含本步）
     - 有解 → 'illegal'
     - 超时/异常 → 'unknown'
  3. 若 current 是方程（a=b），比较的是 (a-b=0) 而非整体命题
返回：'legit' | 'illegal' | 'unknown'
注意：
  - satisfiable 在含实数符号的不等式上可能很慢，必须加 timeout
  - 纯符号等式优先走已有的 _strategy_simplify_diff / _strategy_expand_diff
```

**7. `_classify_entry_kind(seg, symbol_table)`**

```
签名：_classify_entry_kind(seg, symbol_table) -> str
用途：判定单条目属于哪一类（引擎侧兜底分类，主分类由 LLM 完成）。
规则：
  1. 含 < > <= >= 等关系符 → 'domain'
  2. 左边匹配 `名(参数)` 形式 → 'definition'
  3. 右边 sympify 后无 free_symbols → 'constant'
  4. 其它含等号 → 'relation'
返回：PremiseEntryKind 字符串
```

**8. `cmd_session_init(args)`**

```
签名：cmd_session_init(args) -> dict
入参：{sessionId: str, symbols: SymbolDecl[]}
作用：编译符号环境，写入 _SESSIONS 缓存。
返回：{ok: True, sessionId, symbolCount}
注意：symbols 是场景级不变信息，缓存安全；facts 每次随调用传入，不缓存。
```

**9. `cmd_session_step(args)`**

```
签名：cmd_session_step(args) -> dict
入参：{
  sessionId: str,
  expr: str,              # 本步 symbolic 形式
  facts: str[],           # 祖先事实（等式/表达式）
  assumptions: str[],     # 祖先假设
  domains: str[],         # 祖先定义域
  globalDomains: str[],   # 场景级边界条件
}
处理顺序（任一步失败立即返回）：
  ① 语法检查：_check_undeclared
  ② 除零检查：_check_division_safety
  ③ 前提冲突检查：_check_premise_conflict
  ④ 推导检查：_check_derivable
  ⑤ 孤立节点（facts+assumptions 全空）：只做 ① ②，通过返回 unknown（由上层判 warn）
返回：{ok: True, legit, code, detail, conflictPair?}
超时保护：整体包裹 try/except + 各 satisfiable 调用自带 timeout。
```

**10. `cmd_session_assume(args)`**

```
签名：cmd_session_assume(args) -> dict
入参：{
  sessionId: str,
  assumption: str,        # 用户新假设
  facts: str[],           # 该假设节点的祖先事实
  assumptions: str[],     # 该假设节点的祖先假设
  domains: str[],         # 该假设节点的祖先定义域
  globalDomains: str[],
}
处理：
  ① 语法检查
  ② 与祖先前提做冲突检查（把新假设加入前提集后判 satisfiable）
  ③ 若冲突且矛盾来自「场景级前提」（facts/globalDomains）→ 返回 conflict，标注 scene 优先
     若矛盾来自「同为用户假设」→ 同样返回 conflict（用户自己的假设互相矛盾）
返回：{ok: True, legit, code, detail, conflictPair?}
```

**11. `cmd_session_close(args)`**

```
签名：cmd_session_close(args) -> dict
入参：{sessionId: str}
作用：从 _SESSIONS 删除该会话。
返回：{ok: True}
```

**12. `COMMANDS` 字典更新**

```python
COMMANDS = {
    # ... 现有 9 条 ...
    "session_init": cmd_session_init,
    "session_step": cmd_session_step,
    "session_assume": cmd_session_assume,
    "session_close": cmd_session_close,
}
```

**模块级状态**

```python
# 会话缓存：只存不变的符号环境（facts 每次随调用传入，抗进程重启）
_SESSIONS: dict[str, dict] = {}
```

### TypeScript 侧新增函数

**1. `src/modules/derivationCanvas/utils/branchGraph.ts`（新建）**

```ts
/**
 * 反向追溯：沿入边一路向上，返回所有祖先节点 id（不含自身）。
 * 图为 DAG（addEdge 已拦截成环），递归必然终止。
 */
export function collectAncestors(nodeId: string, edges: DerivationEdge[]): string[]

/**
 * 正向传播：沿出边一路向下，返回所有后代节点 id（不含自身）。
 * 用于「改上游 → 下游作废」。
 */
export function collectDescendants(nodeId: string, edges: DerivationEdge[]): string[]

/**
 * 直接父节点（只走一层，不递归）。
 */
export function directParents(nodeId: string, edges: DerivationEdge[]): string[]
```

**2. `src/services/scene/premiseChain.ts`（新建）**

```ts
/**
 * 由画布图收集节点 N 的支路前提集。
 *
 * 规则：
 * - 沿入边反向追溯所有祖先
 * - 祖先中的 given 节点 → 展开 entries 的 symbolic 到 facts / domains
 * - 祖先中的 assumption 节点 → assumptions
 * - 祖先中 status='pass' 的 formula/conclusion → facts
 * - 节点自身或祖先的 domainConstraint → domains
 * - 场景 boundary_conditions → globalDomains
 */
export function collectBranchPremises(
  node: DerivationNode,
  canvas: DerivationCanvasState,
  spec: SceneSpec,
): BranchPremises

/**
 * 判定单个推导步骤的合法性（前提链前置关卡）。
 * 返回 StepLegitResult。引擎异常归约为 unknown，不抛错。
 */
export async function judgeStepLegitimacy(ctx: {
  sessionId: string;
  node: DerivationNode;
  userExpr: string;
  premises: BranchPremises;
}): Promise<StepLegitResult>

/**
 * 校验用户新建的假设前提是否与祖先前提冲突。
 * 冲突时同时返回「场景前提优先」的处置标记。
 */
export async function judgeAssumption(ctx: {
  sessionId: string;
  node: DerivationNode;
  assumptionExpr: string;
  premises: BranchPremises;
}): Promise<StepLegitResult>
```

**3. `src/services/scene/computeClient.ts`（修改，新增 4 个包装）**

```ts
/** 初始化会话（场景启动时调用一次） */
export async function sessionInit(
  sessionId: string,
  symbols: SymbolDecl[],
): Promise<ComputeResult<{ sessionId: string; symbolCount: number }>>

/** 判定单步合法性 */
export async function sessionStep(args: {
  sessionId: string;
  expr: string;
  facts: string[];
  assumptions: string[];
  domains: string[];
  globalDomains: string[];
}): Promise<ComputeResult<StepLegitResult>>

/** 校验并登记假设 */
export async function sessionAssume(args: {
  sessionId: string;
  assumption: string;
  facts: string[];
  assumptions: string[];
  domains: string[];
  globalDomains: string[];
}): Promise<ComputeResult<StepLegitResult>>

/** 关闭会话 */
export async function sessionClose(sessionId: string): Promise<ComputeResult<{ ok: boolean }>>
```

**4. `src/services/scene/computeAnalyze.ts`（修改）**

```ts
/**
 * 假设前提节点的分析入口（新增）。
 * 不走参考解比对，只做「语法 + 冲突」检查。
 */
export async function analyzeAssumptionStep(ctx: {
  spec: SceneSpec;
  run: SceneRunState;
  node: DerivationNode;
  sessionId: string;
}): Promise<AnalyzeStepResult>
```

`analyzeStep` 的修改点：在「第 2 步：确定对标参考式」**之前**插入前提链前置关卡：

```
① 解析表达式（现有，不变）
② 【新】收集支路前提 collectBranchPremises
③ 【新】judgeStepLegitimacy
     legit='legit'   → status='pass'，跳过 ④⑤，直接组装 verification
     legit='conflict'→ status='fail'，feedback 说明前提冲突
     legit='illegal' → status='fail'，feedback 只说「推理步骤存在问题」（原因交 AI）
     legit='unknown' → 继续走 ④⑤（参考解兜底）
④ 【保留】matchReferenceStep + judgeEquivalence（现有，原样）
⑤ LLM 定性反馈（现有，不变）
```

**5. `src/services/scene/derivationRuntime.ts`（修改）**

```ts
/**
 * 把节点 id 的所有后代重置为 draft（新增）。
 * 沿出边正向传播。用于「修改上游节点 → 下游需重新验证」。
 */
export function invalidateDescendants(
  canvas: DerivationCanvasState,
  nodeId: string,
): DerivationCanvasState
```

`buildGivenNodes` 修改：
- 若 `given.entries` 存在且非空 → 逐条目渲染 `data.latex`（多行拼接），`data.note` 从 `given.note` 取
- 若 `given.entries` 为空数组 → 标记 `data.unitHint = '此前提无法被引擎识别'`
- 若 `given.entries` 缺省 → 保持现有行为（单条，从 `display` 取）

**6. `src/modules/derivationCanvas/derivationStore.ts`（修改）**

`DEFAULT_LABEL` 加：

```ts
assumption: '假设前提',
```

`updateNode` 修改：内容变化后，调用 `invalidateDescendants` 把下游节点状态重置为 `draft` 并清空 `verification`。

`removeNode` 修改：删除节点后同样触发一次下游作废（沿被删节点的出边）。

**7. `src/modules/derivationCanvas/nodeVisuals.ts`（修改）**

```ts
export const NODE_TYPE_LABEL: Record<DerivationNodeType, string> = {
  given: '已知',
  formula: '推导',
  conclusion: '结论',
  assumption: '假设前提',   // 新增
};

/** 假设前提节点专用配色（与公式节点区分：偏紫色系） */
export const ASSUMPTION_COLOR = '#7A5FA8';
export const ASSUMPTION_BG = '#f7f4fb';
```

**8. `src/modules/derivationCanvas/DerivationCanvas.tsx`（修改）**

```ts
const nodeTypes = {
  formula: FormulaNode,
  given: GivenNode,
  conclusion: ConclusionNode,
  assumption: AssumptionNode,   // 新增
};
```

工具栏新增「假设前提」按钮（图标用 `lucide-react` 的 `Lightbulb` 或 `Asterisk`，与现有 `Plus` / `Flag` 并列）。

**9. `src/components/scene/SceneMode.tsx`（修改）**

- 场景启动时生成 `sessionId`（格式 `s4-${sceneId}-${timestamp}`），调用 `sessionInit`
- 场景结束 / 组件卸载时调用 `sessionClose`
- 节点提交分流：`node.type === 'assumption'` → `analyzeAssumptionStep`；否则 → `analyzeStep`
- 下游作废后给出 UI 提示：「上游已修改，本步骤需重新验证」

**10. `src/workflows/sceneComputePrompt.ts`（修改）**

在 `SCENE_COMPUTE_GENERATE_PROMPT` 的 `given` 相关章节插入以下强制条款（新增章节 "### 3.1' given 前提包生成规范"）：

```
每个 given 项是一个「前提包」，三个字段职责严格分离：

- name：块标题，2~8 字，如「重力模型」「围栏约束」。
  **禁止**包含公式或符号。
- note：自然语言解释。可写物理含义、取值理由、适用条件。
  **不参与符号计算**。
- display：**只允许数学表达式**，多条用英文分号 `;` 分隔。
  - 禁止自然语言：「其中」「表示」「为」「即」「且」「所以」等一律不得出现
  - 允许括号内单位（如 `g = 9.81 (m/s^2)`）
  - 允许 LaTeX 记法（MathLive 会渲染）

正确示例：
{
  "name": "重力模型",
  "note": "物体在重力场中的重量。g 取标准重力加速度，质量非负。",
  "display": "G(m) = m*g ; m >= 0 ; g = 9.81 (m/s^2)"
}

禁止示例（解释混入框内，将导致引擎无法解析）：
{
  "name": "G(m) = m*g 表示重力",
  "note": "",
  "display": "重力 G(m) = m*g，其中 g = 9.81，m 表示质量且 m >= 0"
}

display 内允许的条目类型（引擎自动识别，无需标注）：
- 函数定义：左边是 `名(参数)` 形式，如 G(m) = m*g
- 常量赋值：右边纯数值无自由符号，如 g = 9.81
- 定义域：含不等号，如 m >= 0、0 < x < 20
- 关系式：其它等式，如 x + 3 = y + 1
```

同时在 `symbols` 章节补充正值属性要求：

```
若某符号在物理/数学语境中必然为正（如光速 c、质量 m、边长 x），
请在 symbols 中为该符号设置 "positive": true。
这能让引擎完成 sqrt(c^2) = c 一类的化简。
若符号可能为负或不确定，不要设置该字段（默认 false）。
```

---

## [Classes]

**无新增类。** 本项目采用函数式 + React Hooks 范式，所有改动落在模块级函数、React 函数组件与类型定义上。

React 组件新增 1 个：

| 组件 | 文件 | 说明 |
|---|---|---|
| `AssumptionNode` | `src/modules/derivationCanvas/components/AssumptionNode.tsx` | 用户假设前提节点。结构复用 `NodeShell`，编辑区复用 `MathField`，与 `FormulaNode` 的差异在于：配色（紫色系）、标签文案（"假设前提"）、提交动作走 assumption 分支。 |

---

## [Dependencies]

**无新增依赖。**

Python 侧使用的 `sympy.satisfiable` / `And` / `Not` / `AppliedUndef` / `fraction` 均属 SymPy 核心 API，现有 `sympy` 依赖已包含。

TypeScript 侧无新增 npm 包。

---

## [Testing]

### 1. Python 探针（`python/_probe_premise.py`，临时文件）

**执行方式**（Windows + Cursor 终端）：

```
cmd /c "cd /d <项目根> && python python\_probe_premise.py"
```

探针自行写结果文件（不依赖 shell 重定向），输出纯 ASCII。

**用例清单（预期全通过）**

| 组 | 用例 | 预期 |
|---|---|---|
| A 语法层 | `v/x`（无 x 约束） | `division_by_zero` |
| A | `v/x` + 前提 `x > 0` | `legit`（除零安全） |
| A | `E(x)` 孤立 | `undeclared_symbol` |
| A | `2*x + y` 未声明 y | `undeclared_symbol` |
| B 推导 | 前提 `2*x+y=40` → 本步 `y=40-2*x` | `legit` |
| B | 前提 `2*x+y=40` → 本步 `y=40+2*x` | `illegal` |
| B | 前提 `a=b` → 本步 `b=a` | `legit` |
| B | 前提 `x=1` → 本步 `x=2` | `illegal` |
| C 冲突 | 前提 `m>0` + 假设 `m=0` | `conflict` |
| C | 前提 `m>=0` + 假设 `m=0` | `legit`（可同时成立） |
| C | 两支路 `v=m+1` / `v=m-1` 汇合 | `conflict` |
| C | 两支路不汇合 | 各自 `legit` |
| D 孤立 | 孤立节点 `y = x + 99`（自洽） | `unknown`（上层判 warn） |
| D | 孤立节点 `1 = 2` | `illegal`（自相矛盾） |
| E 分号 | `"G(m)=m*g ; m>=0 ; g=9.81"` | 切分为 3 条 |
| E | `"f(x, (a;b)) = x"` 括号内分号 | 不切分（1 条） |
| F 分类 | `G(m) = m*g` | `definition` |
| F | `g = 9.81` | `constant` |
| F | `m >= 0` | `domain` |
| F | `x + 3 = y + 1` | `relation` |
| G 正值 | `sqrt(c^2 - v^2)` vs `c*sqrt(1-v^2/c^2)`（c positive） | `legit`（不再 unknown） |
| G | 同上但不设 positive | `unknown` |

### 2. TypeScript 编译检查

每阶段结束执行：

```
cmd /c "cd /d <项目根> && npx tsc --noEmit"
```

必须 `EXIT=0` 且输出为空（红线 R5）。

### 3. 图遍历单测（`branchGraph.ts`）

| 用例 | 预期 |
|---|---|
| 链式 A→B→C，取 C 的祖先 | `[A, B]` |
| 分叉 A→B, A→C，取 B 的祖先 | `[A]` |
| 汇合 A→C, B→C，取 C 的祖先 | `[A, B]` |
| 孤立节点取祖先 | `[]` |
| 链式 A→B→C，取 A 的后代 | `[B, C]` |
| 钻石 A→B→D, A→C→D，取 A 的后代 | `[B, C, D]` |

### 4. GUI 人工验证（需用户在 app 中操作）

| 场景 | 预期表现 |
|---|---|
| 工具栏 | 出现「假设前提」按钮 |
| 前提包节点 | 框内多条目 MathLive 渲染，框外小字显示 note |
| 孤立节点提交 | 状态为黄色「需注意」，提示「缺少前提依据」 |
| 假设冲突 | 新假设与场景前提矛盾时，报红并提示 |
| 修改上游 | 下游节点自动回「待提交」状态 |
| 参考解兜底 | 前提链判 unknown 时，回落到原有参考解比对，行为不变 |

---

## [Implementation Order]

按以下 9 步顺序实施。**每步结束必须验证后再进入下一步**（红线 R5）。

**步骤 1：Python 引擎层（会话机制 + 判定函数）**
- 新增 `_SESSIONS` 模块级缓存
- 新增 `_compile_symbols` / `_split_premise_entries` / `_check_division_safety` / `_check_undeclared` / `_check_premise_conflict` / `_check_derivable` / `_classify_entry_kind`
- 新增 `cmd_session_init` / `cmd_session_step` / `cmd_session_assume` / `cmd_session_close`
- 更新 `COMMANDS` 字典（必须在所有函数定义之后）
- 验证：跑 `_probe_premise.py`，A~G 全组通过

**步骤 2：类型层（`src/types/sceneS4.ts`）**
- 扩展 `DerivationNodeType` / `GivenItem` / `SymbolDecl` / `NodeVerification` / `ComputeCommand`
- 新增 `PremiseEntry` / `PremiseEntryKind` / `StepLegit` / `StepLegitResult` / `BranchPremises`
- 验证：`npx tsc --noEmit` 通过（此时可能有未使用类型告警，可接受）

**步骤 3：客户端命令包装（`src/services/scene/computeClient.ts`）**
- 新增 `sessionInit` / `sessionStep` / `sessionAssume` / `sessionClose`
- 验证：`npx tsc --noEmit` 通过

**步骤 4：图遍历工具（`src/modules/derivationCanvas/utils/branchGraph.ts`）**
- 新增 `collectAncestors` / `collectDescendants` / `directParents`
- 验证：`npx tsc --noEmit` 通过 + 单测（可临时脚本，验收后删）

**步骤 5：前提链编排层（`src/services/scene/premiseChain.ts`）**
- 新增 `collectBranchPremises` / `judgeStepLegitimacy` / `judgeAssumption`
- 验证：`npx tsc --noEmit` 通过

**步骤 6：判定主链路接线（`src/services/scene/computeAnalyze.ts`）**
- `analyzeStep` 插入前提链前置关卡（在 `matchReferenceStep` 之前）
- 新增 `analyzeAssumptionStep`
- 保留 `matchReferenceStep` / `judgeEquivalence` 作为兜底（不改签名）
- 验证：`npx tsc --noEmit` 通过

**步骤 7：运行态与画布（3 个文件）**
- `derivationRuntime.ts`：`buildGivenNodes` 支持 entries + note；新增 `invalidateDescendants`
- `derivationStore.ts`：`DEFAULT_LABEL` 加 `assumption`；`updateNode` / `removeNode` 触发下游作废
- `nodeVisuals.ts`：`NODE_TYPE_LABEL` 加 `assumption`；新增配色常量
- `DerivationCanvas.tsx`：注册 `assumption` 节点类型；工具栏加按钮
- 新建 `AssumptionNode.tsx`
- 验证：`npx tsc --noEmit` 通过

**步骤 8：场景编排与 Prompt（2 个文件）**
- `SceneMode.tsx`：会话生命周期 + 提交分流 + 下游作废提示
- `sceneComputePrompt.ts`：`given` 生成规范条款 + 符号正值属性要求
- 验证：`npx tsc --noEmit` 通过

**步骤 9：端到端验收**
- 跑完整 `_probe_premise.py`（A~G 全组）
- 跑 `npx tsc --noEmit`（清理前后各一次）
- 清理临时文件（`python/_probe_premise.py` 及其输出、任何 `_tmp_*`）
- 输出 GUI 验证清单交给用户

---

## 附：实施必须遵守的技术约束（踩过的坑）

1. **`COMMANDS` 字典必须定义在所有函数之后** —— 否则启动时 NameError。
2. **`sp.Relational` 类不存在** —— 用 `expr.is_Relational` 属性判断。
3. **拼多个约束不可用逗号 join** —— 会成 tuple，必须 `sp.And(*list)`。
4. **TS 模板字符串内不可出现反引号** —— 会提前终止字符串。
5. **`satisfiable` 必须传 `timeout`** —— 复杂不等式可能极慢；超时归 `unknown`，不阻塞。
6. **本机终端链路**：Cursor 的 `execute_command` 经 `/bin/sh` 执行，反斜杠与括号会被 shell 解析 → 路径用**正斜杠**；PowerShell 不支持 `&&`，需用 `cmd /c "..."` 包裹；长输出的 git 命令会触发 `less` 分页器阻塞终端。
7. **探针脚本自写结果文件** —— 不依赖 shell 重定向（终端输出会串扰）；输出纯 ASCII。
8. **红线 R1/R2**：`SceneChatView` / `sceneDirector` / `sceneSignal` / `scenePrompt.ts` 零改动。
9. **D5 叠加式**：`cmd_verify_equiv` / `matchReferenceStep` / `judgeEquivalence` 完整保留，不改签名。
10. **会话缓存只存符号环境** —— `facts` / `assumptions` / `domains` 每次随调用传入，保证 Python 进程重启后行为一致。

---

## 附二：实施记录（步骤 1 完成后回填）

### 与计划的偏差

| 项 | 计划 | 实际 | 原因 |
|---|---|---|---|
| 判定核心落点 | 全写在 `sympy_server.py` | 独立为 `python/premise_engine.py` | 该文件已 2900 行，大段替换反复失败；独立模块后只需薄委托 |
| 判定算法 | `sp.satisfiable` | 等式代入 + 数值采样 | 见下方根因 |
| 命令数 | 4 个 | 5 个（多 `session_split`） | 前端需要「按 `;` 切分并分类」的独立入口做解构校验 |

### 弃用 `sp.satisfiable` 的实测根因

它把关系式当作**不可解释的原子命题**，不做代数化简，导致：

| 用例 | satisfiable 结果 | 应有结果 |
|---|---|---|
| `sqrt(c**2) = c`（c 为正值） | 判不出 → illegal | legit |
| 前提 `x=1` → 本步 `x=2` | 判不出 → unknown | illegal |
| 前提 `2*x+y=40` → 本步 `y=40-2*x` | 判不出 → unknown | legit |

改用三层判据（等式代入 / 微积分求值 / 数值采样）后全部正确。

### 实施中踩的 4 个坑

| # | 现象 | 根因与修复 |
|---|---|---|
| 1 | 探针 13/26 失败，且改代码后结果**完全不变** | `premise_engine.py` 被写到**嵌套路径**（项目根下多出一层同名目录），`python/` 下根本没有该文件。修复：`move` 归位并删掉嵌套目录 |
| 2 | 修好路径后仍 7 例失败（B3/C1/C2/C4/C5/G1/H1） | `cmd_session_init` 走 `_session_get` 的**缓存短路** —— 命中旧会话即返回，符号表**从未更新**，后续新符号全被判「未声明」。修复：强制按当前 `symbols` 重建。对照组 H2（先 `clear()`）恰好通过，正好反证 |
| 3 | G1 `sqrt(c**2)=c` 仍判 unknown | c 为正值时 SymPy 把 `Eq(c, c)` **自动求值为 `True`**（布尔常量），不再是关系式对象，`check_derivable` 因「非关系式」直接返回 unknown。修复：加 `current is sp.true/false` 分支 |
| 4 | 终端输出串扰 / 中文乱码，读不到探针结果 | 终端会回显历史命令。处置：探针**自写结果文件**，读取时再做 `ascii/replace` 转义 |

### 步骤 1 验收证据

**Python 探针 26/26 → `### ALL PASS ###`**

| 分组 | 用例数 | 覆盖 |
|---|---|---|
| A 语法层 | 4 | 除零（有/无定义域）、未定义函数、未声明符号 |
| B 推导 | 4 | 移项正确/符号错、等式反向、与前提矛盾 |
| C 冲突 | 5 | `m>0` vs `m=0` 冲突、`m>=0` vs `m=0` 不冲突、两支路汇合冲突、单支路各自通过 |
| D 孤立 | 3 | 自洽 → unknown + `no_premise`、`1=2` → illegal |
| E 分号 | 2 | 三条目切分、括号内分号不切 |
| F 分类 | 4 | definition / constant / domain / relation |
| G 正值 | 2 | `sqrt(c^2)=c` 在 positive 下 legit、无 positive 时 illegal |
| H 缓存 | 2 | 缓存命中、无缓存可重建（抗进程重启） |

**既有链路回归（红线 D5 验证，全部行为不变）**

| 命令 | 用例 | 结果 |
|---|---|---|
| `ping` | — | ok |
| `verify_equiv` | `y=40-2*x` vs `2*x+y=40` | `True` / `equation_proportional` |
| `verify_equiv` | `4/10` vs `0.4` | `True`（数值容差不变） |
| `parse` | `2*x+y=40` | `2*x + y = 40`（保留等号） |
| `check_units` | `v: m/s` | valid |

**新增文件**：`python/premise_engine.py`（判定核心）

**新增命令**：`session_init` / `session_step` / `session_assume` / `session_split` / `session_close`


---

## 附三：轮次 G  结构分析层（判定可靠性加固）

### 起点：用户的两处质疑

1. 采样区间可能选不对 -> 反例没被识别（等式在 x=0 不成立，但样本都取 >0）-> 误判为正确
2. Sympy 卡住是因为不知道符号定义域？那直接报错就行

### 核心结论

| 议题 | 结论 |
|---|---|
| 采样能否作为「正确」的证据 | **不能**。采样测「点」，差异可能只在单点（sin(x)/x 与 1 仅在 x=0 不同），命中概率 0  **原理上的盲区**，非采样点不够多 |
| 缺信息怎么办 | **明说，不猜测**。给可执行指引（请说明 c 的符号） |

### 新增 python/premise_structure.py

| 工具 | 性质 | 确定结论 |
|---|---|---|
| sp.singularities | 奇点集 | 集合不同 -> 定位单点差异 |
| sp.solveset | 零点集 | 全集->恒等；有限点->不等；区间->结合前提 |
| sp.limit | 边界行为 | 区分可去奇点与真奇点 |

改动：premise_engine.py 新增 check_derivable_ex 与 C2 结构层，采样层降级（全过不判 legit），缺符号检测前置；sympy_server.py 的 cmd_session_step 支持 warn / missing_symbol_info；TS StepLegit 加 warn。

### 用户确认的三处口径

1. solveset 解出**区间** -> 与前提定义域比对（sqrt(x**2)=x 在 x>=0 前提下正确）
2. **可去奇点** -> warn（结论正确，但约分隐含「该点除外」）
3. 缺符号信息 -> unknown + 可执行指引

### 实施中踩的 5 个坑

1. 1/x=0 误判可去奇点 -> 只查有定义侧极限。**修复**：比较**两侧**极限
2. x+1=x+2 判 unknown -> SymPy 把 Eq 求值为布尔常量。**修复**：加布尔常量分支
3. **sqrt(c**2)=c 判 illegal** -> 采样撒到负值拿反例判错，真因是缺信息。**修复**：缺信息检测**前置**
4. 前提已给 x>=0 仍报缺信息 -> 漏判前提能否定符号。**修复**：新增 _domain_fixes_sign
5. 探针 Eq(x**2/x, x) 永远 legit -> **探针笔误**（SymPy 构造时即约分）。**修复**：改用 sin(x)/x

### 验收证据

**探针 22/22 ALL PASS**：A 单点差异 / B 零点集 / C 区间+前提 / D 缺信息 / E 多变量 / F 集成 / G 结构化出口

**回归（红线 D5，行为不变）**：ping ok ｜ verify_equiv(y=40-2*x vs 2*x+y=40) -> True/equation_proportional ｜ 4/10 vs 0.4 -> True ｜ parse(2*x+y=40) 保留等号

**npx tsc --noEmit 无错误**；**临时文件已清理**

### 判定阶梯（轮次 G 后）

1 语法：符号声明 / 除零 / 前提冲突
2 引入定义识别（待做）：y = 表达式 -> 直接登记通过
3 等式比例 / 代入 / 微积分求值
4 结构分析：singularities / solveset / limit   <- 本轮新增
5 缺符号信息检测 -> unknown + 可执行指引          <- 本轮新增
6 数值采样：仅用于证伪；全过不判 legit
7 unknown -> 回落参考解 / 提示缺信息


### 附三补：复杂用例测试（轮次 G 后续）

**测试设计**：21 个真实物理/数学用例（6 组），全部含必要前提。

| 组 | 用例 | 结果 |
|---|---|---|
| A 物理公式 | `sqrt(c^2-v^2)=c*sqrt(1-v^2/c^2)`（c 为正）| legit |
| A | 同式但 `c>0` 由**前提**给出 | legit（修复前 unknown）|
| B 数学恒等 | `sin(2x)=2sin(x)cos(x)` / `cosh^2-sinh^2=1` / `(x+1)^3` 展开 / `log(ab)=log a+log b` | 全 legit |
| C 分式与奇点 | 分式通分 / `(x^2-1)/(x-1)=x+1` 可去奇点 / 部分分式 / `1/x=1/(x+1)` 奇点不同 | legit / warn / legit / illegal |
| D 多步前提 | `x=2`→`x^2=4`、`x=2`→`x^3=8`、`x=2`→`x^2=5`（错）、`2x+y=40`→`y=40-2x`、`a=b`→`a^2=b^2`、`{x+y=5,x-y=1}`→`x=3` | 全部正确 |
| E 求导 | `A(x)=x(40-2x)`→`A'(x)=40-4x`、`d/dx(x^3)=3x^2` | 全 legit |
| F 缺前提陷阱 | `sqrt(x^2)=x` 无前提 / 有 `x>=0` / 无前提普通恒等式 | 缺符号 / legit / legit |

### 本轮新发现并修复的 3 个真实缺陷

#### 缺陷 1：不等式前提不改变符号属性（A3）

**现象**：前提 `c > 0` 时，`sqrt(c^2-v^2) = c·sqrt(1-v^2/c^2)` 判 `unknown`；
但把 `c` **声明为正值符号**则判 `legit`。

**根因**：**不等式前提不会改变 Symbol 的假设** —— SymPy 仍视 `c` 为「符号未知」，
`sqrt(c^2)` 无法化简为 `c`，化简卡住。

**修复**：在结构分析开始前，把前提中的不等号**转换为符号属性**（`_prepare_sides` 步骤②）：

```python
# 前提 c > 0 时 sqrt(c**2) 应能化简为 c；但不等式前提本身不改变 Symbol 的假设
_attr = {}
for _r in relations or []:
    if getattr(_r, "rhs", None) != 0: continue
    _s0 = getattr(_r, "lhs", None)
    if not getattr(_s0, "is_Symbol", False): continue
    if isinstance(_r, sp.Gt):   _attr[_s0.name] = "positive"
    elif isinstance(_r, sp.Ge): _attr[_s0.name] = "nonnegative"
    elif isinstance(_r, sp.Lt): _attr[_s0.name] = "negative"
# -> 用带属性的新符号替换后再化简
```

**意义**：让「把物理量的正值性质写进前提」这种**自然的教学写法**能够生效，
而不必要求用户去改符号声明。

#### 缺陷 2：结构层未代入前提等式（端到端测试发现）

**现象**：前提 `x=1` 时，本步 `2*x=2` 判 `illegal`；但这显然是正确推导。

**根因**：结构层判断的是「等式**是否为恒等式**」，而前提链的语义是
「本步**能否由前提推出**」—— 后者必须让已确定的事实参与判定。
单独看 `2x=2` 的解集是 `{1}`（有限点集），并非恒等，故被误判。

**修复**：`_prepare_sides` 步骤① 先用 `sp.solve` 解出前提等式并代入两侧。

**方法论意义**：这个缺陷**只在完整链路（`session_step`）才暴露** ——
单元探针用的都是「无前提」场景，恰好绕过了它。**只跑单元测试不够，必须跑端到端。**

#### 缺陷 3：奇点比对被「残差为 0」抢先返回（C1b）

**现象**：`(x^2-1)/(x-1) = x+1` 判 `legit`；但左侧在 x=1 处**无定义**，
按用户确认口径应判 `warn`（可去奇点）。

**根因**：残差 simplify 后为 0，代码在「残差恒为 0」处直接返回 legit，
**永远走不到奇点检查**。

**修复**：把**奇点集比对前置**到「残差为 0」判定之前 —— 奇点比对查的是
「两侧定义域」，与化简能力无关，故必须优先。

### 判定顺序（顺序本身即正确性的一部分）

```
0 布尔常量   -> Eq 被 SymPy 当场求值为 True/False
1 前提施加   -> ① 等式代入  ② 不等号转符号属性
2 奇点集比对 -> 必须早于「残差为 0」（缺陷 3）
3 残差为 0
4 常量残差
5 缺符号信息 -> 优先于区间判定，给可执行指引
6 零点集
```

### 验收证据

| 项 | 结果 |
|---|---|
| 全量探针（基础 20 + 复杂 22 = **42 例**）| **42/42 ALL PASS** |
| 端到端链路（`session_step`）| **7/7 ALL PASS** |
| 既有链路回归 | 方程成比例 True / 链式算错判 False / 全角求导识别 / ping ok |
| `npx tsc --noEmit` | 无错误 |
| 临时文件 | 已清理 |

### 踩坑记录（探针自身的构造陷阱）

| # | 陷阱 | 说明 |
|---|---|---|
| 1 | `Eq((x**2-1)/(x-1), x+1)` | SymPy 在**构造**时就自动约分，引擎收到 `Eq(x+1,x+1)`。要用 `sin(x)/x` 这类不自动化简的形式 |
| 2 | symbols 写成 `{"x": {"kind":"variable"}}` | 该形态会被当作**常量**，value 为字符串，sympify 成 Dict -> SymPy 警告 + 判定污染。正确形态：变量 `{"x": ["0","1"]}`、函数 `{"A": {"kind":"function","params":["x"]}}` |
| 3 | `V` 声明为变量 | 按「尊重场景定义」原则，已声明标识符仍走乘法 —— `V(x)` 被读作 `V*x`。测求导必须声明 `kind: "function"` |
| 4 | `c` 声明为 constant 且给值 | 引擎会正确代入该值，`sqrt(c**2)=c` 成立是**对的**，测不到「缺符号信息」。要用不赋值的 variable |

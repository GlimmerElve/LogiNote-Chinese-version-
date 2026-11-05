# Implementation Plan — S4 函数记法与链式等式支持（轮次 A）

> 已归档：该轮次计划已由 `implementation_plan_s4.md` 接替，仅保留作历史参考。

> **本文档是「轮次 A」的实施计划。** 完成后，实施记录将并入 `implementation_plan_s4.md` 的 §10.3.7。
> 轮次 B（函数定义登记 + 跨节点代入求值）另立文档，本轮不做。

---

## [Overview]

### 问题陈述

用户在「40 m 篱笆围矩形求面积函数」场景中提交 `A(x)=xy=x(40-2x)`，被判定为**有误**。实测确认三个独立缺陷：

| # | 缺陷 | 实测证据 |
|---|---|---|
| ① | **`A(x)` 被误读为 `A*x`** | `parse("A(x)=xy")` 返回 `sympy_expr: "A*x = x*y"`，凭空引入自由符号 `A` |
| ② | **链式等式直接报错** | `A(x)=xy=x(40-2x)` → `PARSE_ERROR`「表达式含多个等号，无法判定」 |
| ③ | **函数定义等式未取右侧比对** | `A(x)=x*(40-2*x)` vs `x*(40-2*x)` → `equivalent=false`，差式含 `A*x` 项 |

缺陷 ① 是根因：它引入虚假自由符号，导致「隐含等号」策略（要求残差恰含 1 个自由符号）不适用，最终落到 `simplify_diff` 判不等价。

### 用户确认的决策（D39~D43）

| 编号 | 决策 | 结论 |
|---|---|---|
| D39 | 链式等式判定口径 | **混合**：主判定用**末段右侧**；相邻段做**自洽校验**，不自洽则降级 `warn` 并指出段号 |
| D40 | 函数名识别方式 | **自动识别**（未声明标识符 + `(` → 函数），**允许不声明**；同时通过生成提示词**鼓励声明** |
| D41 | 函数定义登记（跨节点代入） | **做，但排到轮次 B**（本轮只做识别与判定，不做登记与代入求值） |
| D42 | 识别透明化 | 返回值带 `detectedFunctions`，在 **feedback 文字**与**节点标记**两处展示（响应「识别出错」风险） |
| D43 | 范围划分 | **先 A 后 B**：轮次 A = 第 1~3 层（声明/解析/判定），低风险；轮次 B = 第 4 层（运行态代入），中高风险 |

### 核心设计：歧义消解规则（零歧义）

**遇到「标识符 + `(`」时，查场景 `symbols`：**

| 情况 | 判定 | 示例 |
|---|---|---|
| 标识符**已声明**（`constant` / `variable`） | **隐式乘法** | `x(40-2x)` → `x*(40-2*x)`（`x` 已声明） |
| 标识符**未声明** | **函数调用** | `A(x)` → `A(x)`、`f(2+x)` → `f(x+2)`、`A(x,y)` → `A(x,y)` |

**为什么零歧义**：场景契约本要求「公式中每个符号必须在 `symbols` 中显式声明」（否则报 `SYMBOL_NOT_DECLARED`）。因此「未声明」= 不是变量 = 只能是函数名。

### 关键技术前提（已实测验证）

| 验证项 | 结果 |
|---|---|
| SymPy 原生支持函数记法 | ✅ `sympify('A(x)')` → `A(x)`（`AppliedUndef`），`free_symbols = {x}`，**不含函数名** |
| 扫描器新规则 | ✅ 6/6 通过（`A(x)`/`x(40-2x)`/`f(2+x)`/`A(x,y)`/`f(a)`/`total(s)`） |
| 函数 + 用户自造符号 | ✅ `a*(40-2a)` 经 `a→x` 重命名后与 `x*(40-2x)` 差为 0（复用现有规则 C） |
| 常量赋值识别 | ✅ `x0=1` → 右侧无自由符号 → 赋值；`y=40-2x` → 右侧含 `x` → 方程 |
| 函数登记代入（轮次 B 预演） | ✅ `A(x)=x*(40-2x)` → `A(2)=72`、`A(5)=150`、最大值 `200` |

### 改动总览

- 修改 **5** 个代码文件（`sympy_server.py` / `sceneS4.ts` / `computeClient.ts` / `computeAnalyze.ts` / `sceneComputePrompt.ts`）
- 修改 **1** 个 UI 文件（`HelperPanel.tsx`，展示 `detectedFunctions`）
- 新增 **0** 个依赖、**0** 个文件
- 所有 TS 新增字段均为**可选**（`?`），S1 路径读不到即 `undefined`（红线 R1/R2 隔离契约）

### 「识别出错」风险与缓解（D42 落地）

规则本身确定性、零歧义，风险在于**结果与用户意图不符**：

| # | 风险场景 | 后果 | 缓解 |
|---|---|---|---|
| R1 | 场景 `symbols` 漏声明，用户写 `y(x+1)` 想表乘积 | 误判为函数 | 生成提示词强制符号完备 + `detectedFunctions` 透明展示 |
| R2 | 用户用未声明符号写 `a(x+1)` 表乘积 | 误判为函数 | feedback 提示「a 未声明，已按函数处理；若要乘法请写 `a*(x+1)`」 |
| R3 | 场景把 `A` 声明为变量，用户想用函数 `A` | 走乘法 | 场景侧应声明 `kind: 'function'`（本轮新增该类别） |
| R4 | 函数名与已声明变量同名 | 已声明优先 → 乘法 | 规则可预测，**总是尊重场景声明** |

**核心缓解思路：透明化**。不猜测意图，而是**明确告知识别结果**，让用户在反馈里看到「A 被识别为函数」。

---

## [Types]

### 修改 `src/types/sceneS4.ts`

**改动 1：`SymbolKind` 扩展（新增 `'function'`）**

```ts
/**
 * 符号种类。
 *
 * - `constant`：常量（有确定值，如光速 c = 299792458）
 * - `variable`：变量（可为范围，如速度 v ∈ [0, 0.99c]）
 * - `function`：函数（本轮新增）。用于声明场景中使用的函数，
 *   如 `A(x)`（面积函数）。声明后，`A(x)` 会被识别为函数调用而非 `A*x` 乘法。
 *
 * 注意：**不声明也可用**——引擎会按「未声明标识符 + `(`」自动识别为函数（D40）。
 * 声明的作用是「消除歧义 + 让下游（LLM、UI）明确知道哪些是函数」。
 */
export type SymbolKind = 'constant' | 'variable' | 'function';
```

**改动 2：`SymbolDecl` 新增两个可选字段**

```ts
export interface SymbolDecl {
  /** 符号名，如 "c"、"v"、"m0"、"A" */
  name: string;
  /** constant=常量；variable=变量；function=函数 */
  kind: SymbolKind;
  /** kind='constant' 时的值（SymPy 可解析的表达式），如 "299792458" */
  value?: string;
  /** kind='variable' 时的取值范围（SymPy 可解析），如 ["0", "0.99*c"] */
  range?: [string, string];
  /** 中文展示名，如 "光速"、"面积函数" */
  display?: string;
  /**
   * kind='function' 时的形参名列表（本轮新增），如 ["x"]、["x", "y"]。
   * 用于让下游知道该函数接受几个参数、参数名是什么。
   */
  params?: string[];
  /**
   * kind='function' 时的函数体表达式（本轮新增，可选），如 "x*(40-2*x)"。
   * 轮次 A 不使用（仅登记，供轮次 B 的代入求值使用）。
   */
  body?: string;
}
```

**改动 3：`EquivalenceResult` 新增三个可选字段**

```ts
  /**
   * 引擎识别到的函数名列表（本轮新增）。
   *
   * 用途：把「哪些标识符被当成了函数」透明地告知用户与 LLM，
   * 避免用户写 `y(x+1)` 想表乘积却得到「函数」判定时产生困惑。
   */
  detectedFunctions?: string[];
  /**
   * 用户输入的结构类别（本轮新增）。
   *
   * - `expression`：普通表达式，如 `40 - 2*x`
   * - `definition`：函数定义等式，如 `A(x) = x*(40-2*x)`（取右侧比对）
   * - `assignment`：常量赋值，如 `x0 = 1`（右侧无自由符号，不参与等价比对）
   * - `chain`：链式等式，如 `a = b = c`（主判定取末段右侧 + 相邻段自洽校验）
   */
  equationKind?: 'expression' | 'definition' | 'assignment' | 'chain';
  /**
   * 链式等式的自洽校验结果（本轮新增，仅 equationKind='chain' 时出现）。
   *
   * `ok=false` 时 `failAtIndex` 给出第一处不自洽的相邻段序号（从 1 起），
   * 前端据此提示「第 N 段与第 N+1 段不相等」。
   */
  chainCheck?: { ok: boolean; failAtIndex?: number; detail?: string };
```

**改动 4：`NodeVerification` 新增 `detectedFunctions`**

```ts
  /**
   * 引擎识别到的函数名列表（本轮新增，选填）。
   * 非空时 UI 应显示「已识别为函数：A」类标记，使识别结果对用户可见。
   */
  detectedFunctions?: string[];
```

---

## [Files]

修改 6 个文件；无新建代码文件，无删除文件。

### 一、`python/sympy_server.py`（核心）

**改动 1：扫描器新增「已声明优先」判定**

当前 `_strip_implicit_mul(s, symbol_names=None)` 只在白名单命中时整体保留；未命中的标识符被逐字母拆。`A` 不在 `symbol_names` 也不在白名单 → 走「单符号」分支 → 遇 `(` 时按 `prev='sym'` 插 `*`，产生 `A*(x)`。

**新规则**：新增「标识符扫描」分支，匹配完整标识符 `[A-Za-z_]\w*`，然后三分支：

```python
m = _IDENT_RE.match(s, i)
if m:
    ident = m.group(0)
    after = s[m.end()] if m.end() < n else ""
    if ident in known_set:
        # 已声明符号 → 整体保留（隐式乘法由 prev 状态决定）
        ...（同现有命中分支）
    elif after == "(":
        # 未声明 + 紧邻左括号 → 函数调用（不插 *，标记 func）
        if prev in ("num", "sym", "close"):
            out.append("*")
        out.append(ident)
        prev = "func"
        holder["functions"].add(ident)      # 记录识别到的函数名
        i = m.end()
        continue
    else:
        # 未声明且不接括号 → 逐字母拆（保持 Chapter → C*h*a*p*t*e*r 的既有行为）
        ...（回退到单符号分支）
```

**关键约束**：新增分支**必须排在「单符号 `_SYM_TOKEN_RE`」分支之前**，否则标识符会被单字母正则先吃掉。

**改动 2：`_strip_implicit_mul` 签名扩展**

```python
def _strip_implicit_mul(s, symbol_names=None, holder=None):
    """...（原 docstring 保留，补充函数识别说明）

    holder（可选）：传入 dict，识别到的函数名写入 holder['functions']（set）。
    """
```

用可选 holder 而非改返回值，**零破坏**现有调用方（`_to_diff` / `cmd_parse` / `cmd_plot_data` / `cmd_simplify`）。

**改动 3：新增 `_split_chain(s)`**

```python
def _split_chain(s):
    """把输入按等号拆成段列表。

    返回 None 表示非等式；否则返回长度 ≥2 的段列表（已 strip）。
    与 _split_equation 的区别：不再对「多个等号」抛错，而是支持链式等式。
    """
```

**改动 4：`_split_equation` 改为基于 `_split_chain`**

保持对外行为不变（多等号仍抛错），供 `cmd_plot_data` / `cmd_simplify` 等「不支持链式」的命令继续使用。

**改动 5：`_to_diff` 扩展**

```python
def _to_diff(expr_str, symbols=None, allow_equation=False, holder=None):
    """...（原 docstring 保留）

    holder（可选）会写入：
      holder['functions']  : set  识别到的函数名
      holder['kind']       : str  'expression' | 'definition' | 'assignment' | 'chain'
      holder['chain']      : list 链式等式的各段（仅 kind='chain' 时）
    """
```

判定 `kind` 的逻辑：
- 无等号 → `'expression'`
- 1 个等号：
  - 左侧是函数记法（含 `(` 且名未声明）→ `'definition'`
  - 右侧无自由符号 且 左侧是单个符号 → `'assignment'`
  - 否则 → `'expression'`（普通方程，沿用现有语义）
- ≥2 个等号 → `'chain'`

**改动 6：`cmd_verify_equiv` 支持函数定义与链式等式**

流程调整：

```
1. 用 _split_chain 解析用户式，拿到段列表与 kind
2. 若 kind='definition'（函数定义）：
     - 取右侧作为 user_expr 参与判定
     - 左侧函数名记入 detectedFunctions
3. 若 kind='chain'（链式）：
     - 主判定：取「末段」作为 user_expr（若末段左侧是函数记法，取其右侧）
     - 自洽校验：对相邻段 (seg_i, seg_{i+1}) 逐对校验
4. 其余情况：沿用现有逻辑
5. 返回值追加 detectedFunctions / equationKind / chainCheck
```

**自洽校验算法**（关键设计）：

```python
def _check_chain_consistency(segments, declared_names):
    """相邻段自洽校验。

    判据（重要）：
      计算 d = seg_i - seg_{i+1}：
      - 若 d 化简为 0 → 该段自洽 ✓
      - 若 d 含「seg_i 有而 seg_{i+1} 没有」的符号 → 视为「合法引入新物理量」
        （如 xy 与 x(40-2x)：差值含 y，而 y 不在 x(40-2x) 中 → 跳过校验）
      - 否则 → 不自洽 ✗

    为什么这样设计：`面积 = xy = x(40-2x)` 是正确推导，但 xy - x(40-2x) = x(y-40+2x) ≠ 0。
    严格代数校验会误判。而「引入了新量 y」正是这种情形的特征。
    """
```

**链式等式中含函数记法的段**：若 seg_i 是函数记法（如 `A(x)`），跳过 `seg_i = seg_{i+1}` 的校验（视为函数定义链）。

**改动 7：`_symbol_table_to_dict` 支持 function 类型**

```python
# dict 形式的新增识别：
#   {"A": {"kind": "function", "params": ["x"], "body": "x*(40-2*x)"}}
# list 形式（SymbolDecl[]）：kind == 'function' 时读 params / body
```

`_symbol_table_to_dict` 返回的 `table[name]` 保持 `{'kind': ..., ...}` 结构，新增 `'kind': 'function'` 分支。

**改动 8：确保 `COMMANDS` 字典仍在文件最末**（规避历史 `NameError` 坑）

### 二、`src/types/sceneS4.ts`

见 [Types] 节的 4 处改动。全部为**新增可选字段**与**联合类型成员追加**，不改动既有字段语义。

### 三、`src/services/scene/computeClient.ts`

**改动：`symbolDeclsToTable` 支持 function 声明**

```ts
/** SymPy 符号表的函数声明形态 */
export interface SymbolFunctionDecl {
  kind: 'function';
  params: string[];
  body?: string;
}

export function symbolDeclsToTable(
  symbols: SymbolDecl[],
): Record<string, string | [string, string] | SymbolFunctionDecl> {
  const table: Record<string, string | [string, string] | SymbolFunctionDecl> = {};
  for (const s of symbols || []) {
    if (!s?.name) continue;
    if (s.kind === 'function') {
      // 函数声明：告知引擎这是函数而非变量，且其名不参与自由符号
      table[s.name] = {
        kind: 'function',
        params: Array.isArray(s.params) ? s.params.filter((p) => typeof p === 'string') : [],
        body: typeof s.body === 'string' ? s.body : undefined,
      };
    } else if (s.kind === 'constant') {
      table[s.name] = s.value ?? '1';
    } else if (s.range && s.range.length === 2) {
      table[s.name] = [s.range[0], s.range[1]];
    } else {
      table[s.name] = ['0', '1'];
    }
  }
  return table;
}
```

**`ParseResult` 与 `parseExpression` 扩展**：

```ts
interface ParseResult {
  sympy_expr: string;
  variables: string[];
  free_symbols: string[];
  is_equation?: boolean;
  /** 引擎识别到的函数名（本轮新增） */
  detected_functions?: string[];
}
```

`parseExpression` 返回值新增 `detectedFunctions?: string[]`。

### 四、`src/services/scene/computeAnalyze.ts`

**改动 1：`AnalyzeStepResult` 与 `NodeVerification` 装配**

```ts
const verification: NodeVerification = {
  // ...现有字段...
  renamedSymbols,
  // 本轮新增：把引擎识别到的函数透传给 UI，使识别结果可见（D42）
  detectedFunctions: verdict.detectedFunctions,
};
```

**改动 2：`fallbackFeedback` 补充函数识别说明**

```ts
// 在 verdict.equivalent === true 分支中：
detectedFunctions?.length
  ? `本步骤与参考解等价。已把 ${detectedFunctions.join('、')} 识别为函数（非变量）。`
  : ...
```

**改动 3：`buildAnalyzeInput` 注入函数识别与链式信息**

新增两段：

```ts
const funcNote = (ctx.detectedFunctions ?? []).length
  ? `引擎把 ${ctx.detectedFunctions.join('、')} 识别为函数名（不是变量）。
     若用户本意是乘法，请在 feedback 中提示他用显式乘号书写（如 a*(x+1)）。`
  : '';
const chainNote = ctx.chainCheck && !ctx.chainCheck.ok
  ? `用户使用了链式等式，但第 ${ctx.chainCheck.failAtIndex} 段与下一段不相等，
     请在 feedback 中明确指出是哪一段的问题。`
  : '';
```

**改动 4：`requestQualitativeFeedback` 入参扩展**

新增 `detectedFunctions?: string[]` 与 `chainCheck?: EquivalenceResult['chainCheck']`。

### 五、`src/services/scene/sceneComputePrompt.ts`

**改动 1：`SCENE_COMPUTE_GENERATE_PROMPT` §3.2 补充函数声明说明**

在现有 symbols 说明后追加：

```
### 3.2.1 函数声明（推荐）
若场景涉及函数（如面积函数 A(x)、位移函数 s(t)），**推荐在 symbols 中声明**：
  { "name": "A", "kind": "function", "params": ["x"], "body": "x*(40-2*x)", "display": "面积函数" }
- `params` 是形参名列表（如 ["x"]、["x","y"]），不是变量声明
- `body` 可选，写函数体表达式（供后续代入求值）
- 声明后，用户写 `A(x)` 会被识别为函数调用，而非 `A*x` 乘法
- **不声明也可用**：系统会按「未声明标识符 + 括号」自动识别为函数
```

**改动 2：`SCENE_FORMULA_PARSE_PROMPT` 补充函数记法保留要求**

在「转译规则」第 9 条后追加：

```
10. **函数记法必须保留**：如 `A(x)`、`f(2+x)`、`A(x,y)`、`s(t)` 应原样保留为
    `A(x)`、`f(x + 2)`、`A(x, y)`、`s(t)`，**不得展开为 `A*x` 这类乘法**。
    函数名保持原样，参数原样放入括号内。
11. 等式左侧若是函数定义（如 `A(x) = ...`），**必须保留整个等式**，
    系统会自动取右侧参与判定
```

**改动 3：`SCENE_COMPUTE_ANALYZE_PROMPT` 新增第 6 条**

```
6. 函数识别说明：
   若引擎给出了 detectedFunctions（被识别为函数的名称），
   请在 feedback 中顺带说明「已把 A 识别为函数」。
   若用户本意是乘法（写 `a(x+1)` 却未声明 a），请提示他改用显式乘号 `a*(x+1)`。
   若用户使用了链式等式且引擎报出 chainCheck 不自洽，请指出具体是哪一段。
```

### 六、`src/components/scene/HelperPanel.tsx`

**改动：`AnalysisView` 新增函数识别展示**

在现有「判定结果」区块之后插入：

```tsx
{/* 引擎识别到的函数（D42：让识别结果对用户可见） */}
{(node?.verification?.detectedFunctions ?? []).length > 0 && (
  <div className="scene-s4-analysis-block">
    <span className="scene-s4-analysis-label">已识别为函数</span>
    <p className="scene-s4-analysis-text">
      {(node?.verification?.detectedFunctions ?? []).join('、')}
      <span className="scene-s4-func-hint">（非变量；若本意是乘法请写显式乘号）</span>
    </p>
  </div>
)}
```

**新增样式**（`src/index.css`，纯追加）：

```css
.scene-s4-func-hint { margin-left: 6px; font-size: 0.68rem; color: #9aa8a0; }
.dark .scene-s4-func-hint { color: #7d8a82; }
```

### 七、不修改的文件（明确边界）

| 文件 | 理由 |
|---|---|
| `src/services/reviewSegmentScoring.ts` | `parseJsonLenient` 为 S1/S3 共用（红线隔离） |
| `src/services/scene/equivalence.ts` | `judgeEquivalence` 逻辑不变，新字段自动透传 |
| `src/components/SceneChatView.tsx` / `sceneDirector` / `sceneSignal` / `scenePrompt.ts` | 红线 R1/R2 |
| `src/modules/derivationCanvas/**` | 本轮不改画布交互 |
| `src/services/scene/derivationRuntime.ts` | **轮次 A 不动运行态**（函数登记属轮次 B） |

---

## [Functions]

### Python（`python/sympy_server.py`）

| # | 函数 | 类型 | 签名 / 改动 |
|---|---|---|---|
| 1 | `_strip_implicit_mul` | **改造** | 新增 `holder=None` 形参；新增「标识符扫描」分支（已声明→整体保留／未声明+`(`→函数／未声明无`(`→逐字母拆） |
| 2 | `_split_chain` | **新增** | `(s) -> list[str] \| None` 按等号拆段，支持链式 |
| 3 | `_split_equation` | **改造** | 改为基于 `_split_chain`，多等号仍抛错（保持对外行为） |
| 4 | `_to_diff` | **改造** | 新增 `holder=None`；写入 `functions` / `kind` / `chain` |
| 5 | `_check_chain_consistency` | **新增** | `(segments, declared_names) -> dict` 相邻段自洽校验 |
| 6 | `_classify_equation` | **新增** | `(segments, declared_names, holder) -> str` 判定 `expression`/`definition`/`assignment`/`chain` |
| 7 | `cmd_verify_equiv` | **改造** | 支持函数定义取右侧 + 链式混合判定；返回值追加 3 字段 |
| 8 | `_symbol_table_to_dict` | **改造** | 支持 `kind='function'`（读 `params` / `body`） |
| 9 | `cmd_parse` | **改造** | 返回值追加 `detected_functions` |
| 10 | `_IDENT_RE` | **新增常量** | `re.compile(r"[A-Za-z_]\w*")` 完整标识符 |

**未删除任何函数**。原有五级策略与三个等式策略（0.4/0.5/0.6）**全部原样保留**。

### TypeScript

| # | 文件 | 函数 | 改动 |
|---|---|---|---|
| 1 | `computeClient.ts` | `symbolDeclsToTable` | 支持 `kind='function'`；返回类型加 `SymbolFunctionDecl` |
| 2 | `computeClient.ts` | `parseExpression` | 透传 `detectedFunctions` |
| 3 | `computeAnalyze.ts` | `analyzeStep` | 装配 `detectedFunctions`；`fallbackFeedback` 补函数说明 |
| 4 | `computeAnalyze.ts` | `buildAnalyzeInput` | 注入 `funcNote` + `chainNote` |
| 5 | `computeAnalyze.ts` | `requestQualitativeFeedback` | 入参加 `detectedFunctions` / `chainCheck` |
| 6 | `HelperPanel.tsx` | `AnalysisView` | 新增「已识别为函数」区块 |

---

## [Dependencies]

**无新增、无升级、无移除依赖。**

- Python 侧仅用标准库 `re`（已导入）与 `itertools`（已导入）
- Node/TS 侧不引入新包
- 打包侧：dev 态直接跑 `.py`；**改动 `.py` 后必须重启 Electron 应用**（Python 为常驻子进程）

---

## [Testing]

项目**无自动化测试框架**，采用「Python 管道复验 + TS 类型校验 + 端到端手测」三层验证。

### 第一层：Python 引擎管道复验（**必做**，25 组用例）

**A 组：函数识别（7 组）**

| # | 输入 | 期望 |
|---|---|---|
| A1 | `A(x)`（未声明 A） | 解析为函数 `A(x)`，`free_symbols={x}`，`detectedFunctions=['A']` |
| A2 | `x(40-2*x)`（已声明 x） | 解析为 `x*(40 - 2*x)`（乘法） |
| A3 | `f(2+x)`（未声明 f） | 解析为 `f(x + 2)`，`free_symbols={x}` |
| A4 | `A(x,y)`（未声明 A） | 解析为 `A(x, y)`，`free_symbols={x,y}` |
| A5 | `total(s)`（未声明 total） | 解析为 `total(s)`（函数名整体保留） |
| A6 | `m0/sqrt(1-v**2/c**2)` | **回归**：与既有行为一致，不破坏 |
| A7 | `Chapter` | **回归**：仍逐字母拆为 `C*h*a*p*t*e*r`（未声明且无括号） |

**B 组：函数定义等式（3 组）**

| # | user_expr | expected_expr | 期望 |
|---|---|---|---|
| B1 | `A(x)=x*(40-2*x)` | `x*(40-2*x)` | ✅ `equivalent=true`，`equationKind='definition'`，`detectedFunctions=['A']` |
| B2 | `A(x)=x*(40-2*x)` | `40-2*x` | ❌ `equivalent=false`（面积 ≠ 边长，数学正确） |
| B3 | `f(x,y)=x+y` | `x+y` | ✅ `equivalent=true` |

**C 组：链式等式（4 组）**

| # | user_expr | expected_expr | 期望 |
|---|---|---|---|
| C1 | `A(x)=xy=x(40-2x)` | `x*(40-2*x)` | ✅ `equivalent=true`，`equationKind='chain'`，末段取右侧 |
| C2 | `y=40-2x`, 用户 `xy=x(40-2x)` | `x*(40-2*x)` | ✅ 等价 |
| C3 | `2x+1=2x+2=x*2` | `2*x+1` | ⚠️ `equivalent` 判 true，但 `chainCheck.ok=false` → 降级 `warn` |
| C4 | `x*(40-2*x)=x*(40-2*x)` | `x*(40-2*x)` | ✅ 等价（两段自洽） |

**D 组：赋值与混合（3 组）**

| # | 输入 | 期望 |
|---|---|---|
| D1 | `x0=1` | `equationKind='assignment'`（右侧无自由符号） |
| D2 | `40-2*a`（a 未声明） vs `40-2*x` | ✅ 等价 + `renamedSymbols={'a':'x'}`（**回归**：规则 C 未被破坏） |
| D3 | `x=1` vs `x**2=1` | ❌ 不等价（**回归**：规则 A 防误判） |

**E 组：既有 16 组回归（必做）**

`§10.3.6` 记录的 16 组用例**全部重跑**，必须仍为 16/16 通过（确保扫描器改造未破坏等式判定）。

**F 组：命令级（2 组）**

| # | 输入 | 期望 |
|---|---|---|
| F1 | `parse({"expr":"A(x)=xy"})` | `is_equation=true`，`sympy_expr` 保留 `A(x) = x*y`（**不得**变成 `A*x = x*y`） |
| F2 | `limit` 传等式 | **回归**：仍报 `PARSE_ERROR`（`allow_equation` 默认 False） |

### 第二层：TypeScript 类型校验（红线 R5）

```powershell
npx tsc --noEmit > build-check.txt 2>&1; Write-Output "EXIT=$LASTEXITCODE"
```

`read_file build-check.txt` 须为空（0 错误）。注意 PowerShell 用 `;` 而非 `&&`。

### 第三层：端到端手测（**必须重启应用**）

**前置**：`.py` 改动后必须完全退出并重启 Electron（Python 为常驻子进程）。

**手测清单**：
1. 在「篱笆围矩形」场景提交 `A(x)=xy=x(40-2x)` → 期望 **pass**，反馈含「已识别 A 为函数」
2. 提交 `A(x)=x(40-2x)`（单段函数定义）→ **pass**
3. 提交 `x(40-2x)`（乘法）→ 正常判定（与既有行为一致）
4. 提交 `a(x+1)`（a 未声明、本意乘法）→ 反馈提示「a 已按函数处理，若要乘法请写 `a*(x+1)`」
5. 提交 `2x+1=2x+2`（链式不自洽）→ **warn**，反馈指出「第 1 段与第 2 段不相等」
6. 助手面板可见「已识别为函数：A」标记
7. 既有场景（相对论质量）回归 → 行为不变

### 第四层：回归确认（S1 不被破坏）

1. S1 对话场景正常
2. S4 绘图面板正常
3. `git diff --stat` 确认 `reviewSegmentScoring.ts` 未改动

---

## [Implementation Order]

按「引擎 → 类型 → 客户端 → 编排 → 提示词 → UI → 校验 → 手测 → 文档」推进，每阶段结束立即验证。

1. **阶段一：Python 引擎改造**（`python/sympy_server.py`）
   - 1.1 新增 `_IDENT_RE` 常量
   - 1.2 `_strip_implicit_mul` 新增标识符分支 + `holder` 形参（**核心修复**）
   - 1.3 新增 `_split_chain`；`_split_equation` 改为基于它
   - 1.4 新增 `_classify_equation` 与 `_check_chain_consistency`
   - 1.5 `_to_diff` 扩展 `holder`
   - 1.6 `cmd_verify_equiv` 支持定义/链式判定 + 返回值追加 3 字段
   - 1.7 `_symbol_table_to_dict` 支持 `function`
   - 1.8 `cmd_parse` 返回值加 `detected_functions`
   - 1.9 **确认 `COMMANDS` 仍在文件最末**
   → **验证**：`python -c "import ast; ast.parse(...)"` 语法通过

2. **阶段二：Python 管道复验**（25 组用例 + F 组）
   - 2.1 编写临时 NDJSON 打桩脚本（输出重定向到文件，用 `read_file` 读取——**终端回显不可信**）
   - 2.2 A/B/C/D/E/F 六组全部通过才进入下一阶段
   - 2.3 **E 组（既有 16 组）必须全绿**（回归红线）
   → **验证**：输出文件无 FAIL

3. **阶段三：TS 类型增量**（`sceneS4.ts`）
   - 3.1 `SymbolKind` 加 `'function'`；`SymbolDecl` 加 `params` / `body`
   - 3.2 `EquivalenceResult` 加 3 字段；`NodeVerification` 加 `detectedFunctions`
   → **验证**：`npx tsc --noEmit` 0 错误

4. **阶段四：客户端**（`computeClient.ts`）
   - 4.1 新增 `SymbolFunctionDecl`；`symbolDeclsToTable` 支持 function
   - 4.2 `ParseResult` / `parseExpression` 透传 `detectedFunctions`
   → **验证**：`tsc` 0 错误

5. **阶段五：编排**（`computeAnalyze.ts`）
   - 5.1 装配 `detectedFunctions`；`fallbackFeedback` 补函数说明
   - 5.2 `buildAnalyzeInput` 注入 `funcNote` / `chainNote`
   - 5.3 `requestQualitativeFeedback` 入参扩展
   → **验证**：`tsc` 0 错误

6. **阶段六：提示词**（`sceneComputePrompt.ts`）
   - 6.1 生成提示词加 §3.2.1 函数声明说明
   - 6.2 转译提示词加第 10/11 条（保留函数记法 + 保留函数定义等式）
   - 6.3 分析提示词加第 6 条（函数识别说明）
   → **验证**：`tsc` 0 错误（**注意：模板字符串内严禁使用反引号**，上次踩过该坑）

7. **阶段七：UI**（`HelperPanel.tsx` + `index.css`）
   - 7.1 `AnalysisView` 新增「已识别为函数」区块
   - 7.2 追加 `.scene-s4-func-hint` 样式（纯追加）
   → **验证**：`tsc` 0 错误

8. **阶段八：全量校验与红线**
   - 8.1 `npx tsc --noEmit > build-check.txt 2>&1; Write-Output "EXIT=$LASTEXITCODE"` → `EXIT=0` 且文件为空
   - 8.2 `git diff --stat` 确认改动清单 = 6 个文件，且不含 S1 红线文件
   → **验证**：`EXIT=0`

9. **阶段九：端到端手测**（必须重启应用）
   - 按 [Testing] 第三层 7 条 + 第四层 3 条逐项验证
   → **验证**：`A(x)=xy=x(40-2x)` 显示为 pass

10. **阶段十：文档与清理**
    - 10.1 在 `implementation_plan_s4.md` 追加 §10.3.7 记录（D39~D43、改动清单、复验结果、红线自检）
    - 10.2 删除全部临时文件（`_q.txt` / `_p.py` / `_po.txt` / `_p2.py` / `_p2o.txt` / `build-check.txt`）
    → **验证**：`list_files` 确认已清理

**阶段依赖**：一 → 二（强依赖）；二 → 三~七（可并行但按序更稳）；七 → 八；八 → 九；九 → 十。

**风险提示**：
- 阶段一 1.2 若破坏 A6/A7 回归（`m0` 被拆、`Chapter` 不再拆）→ **必须回退修正标识符分支的优先级**
- 阶段二 E 组若失败 → 说明扫描器改造破坏了既有等式判定 → **不可放行**
- 阶段六提示词修改若引入反引号 → TS 语法错误（上次踩过）

---

## [轮次 B 预告]（本文档不实施，仅记录设计）

**目标**：支持 `A(2)` 代入求值、跨节点符号登记。

**已知技术可行性**（已实测）：`A(x)=x*(40-2x)` 登记后 `A(2)=72`、`A(5)=150`、`A(20)=0`、最大值 `200`。

**改动范围**：
1. `derivationRuntime.ts`：`DerivationCanvasState` 新增 `symbolRegistry`（函数定义 + 常量赋值）
2. `sympy_server.py`：新增 `evaluate_with_registry` 命令（代入登记的定义后求值）
3. `computeAnalyze.ts`：登记逻辑 + 把 registry 注入后续节点的判定
4. `SceneDerivationView.tsx`：UI 展示已登记符号

**风险**：涉及运行态持久化与跨节点状态传递，需单独一轮验证。

---

## 10.4 轮次 H：用户自定义函数的识别与使用（已实施）

**起因**（用户原话）：

> 「1、f(x,y)也算，所以扩展一下，内部用`,`去分隔多个变量的也算声明函数；
> 2、在等式的左侧还是右侧其实区别不大，假设未声明函数，用户写 x^2+1=f(x)=x+1，
> 先分割为 x^2+1=f(x) 和 f(x)=x+1，之前设定好的多链验证策略，按从左到右，
> 先声明了 f(x)=x^2+1，再判断 f(x)=x+1 是否正确；
> 3、如果未声明，f(2) 就不算，()内非数字；如果声明了 f(x)=x^2+1，f(2) 就是代入运算」

**实测发现的缺陷**（用户提问引发，非推测）：

> 「假如 a 未提前声明，用户输入 x+5=a(x+1)，会不会把 a() 识别为函数」

实测确认**会误判** —— 旧判据只要求「未声明标识符 + 左括号」，
不看括号里的内容。修复前 `x+5=a(x+1)` → `x + 5 = a(x + 1)`（当成函数）。

### 用户确认的规则表（R1~R10）

| # | 规则 | 内容 |
|---|---|---|
| R1 | 函数声明判据 | 未声明的「名字 + `()`」，且括号内是**单个字符**（或逗号分隔的多个单字符） |
| R2 | 名字可为多字符 | `f1(x)`、`f2(x)`、`Result(x)` ✅ |
| R3 | 括号内是表达式则不算 | `a(x+1)` → `a*(x+1)`；`f3(x+1)` 未声明 → `f3*(x+1)` |
| R4 | 声明后可用于运算 | 已声明 `f` → `f(2)` 是代入；`f1(x+1)` 是函数调用，实参 = `x+1` |
| R5 | 链式从左到右累积声明 | `x²+1=f(x)=x+1` → 先登记 `f`，再判 `f(x)=x+1` |
| R6 | 同链重复声明 | **报错**（错误码 `FUNCTION_REDEFINED`） |
| R7 | 参数名不同 | **允许**（换变量）：`f(t)+1 = t²+2` |
| R8 | `f(2)` 未声明 | **报错**（错误码 `FUNCTION_NOT_DECLARED`），要求先声明 |
| R9 | 支链同名冲突 | 做**等价判定**（参数名不同视为相同）；不等价 → 判 **fail** |
| R10 | 记法 | `x1`/`y2` 是变量；数字在前才是乘积：`3y2` = `3*y2` |

### 分五阶段实施（每阶段带探针验证）

| 阶段 | 内容 | 改动 | 探针结果 |
|---|---|---|---|
| 1 | 函数声明判据修正 | `_FUNC_DECL_RE` 新增；`_strip_implicit_mul` 4a 分支；`_is_function_notation` | **17/17** |
| 2 | 声明登记 + 链式累积 | `_iter_user_function_decls`、`_inject_user_decls`、`_merge_decls_into_symbols_arg`；`_classify_equation` 对称化 | **10/11**（1 例为探针搭配问题） |
| 3+4 | R8 报错 + 错误码 | `_FunctionNotDeclared` / `_FunctionRedefined`、`_check_undeclared_func_call`、`handle` 错误码分流 | **8/8** |
| 5 | 支链同名冲突 | `_func_defs_from_facts`、`_func_def_eq`、`_check_function_conflicts`；`cmd_session_step` 接入；前端 `legitFeedback` 加分支 | **6/6** |

### 实施中踩的坑（全部实测确认）

| # | 现象 | 根因与修复 |
|---|---|---|
| 1 | `A'(x)` 撇号求导失效（输出 `A`） | 新正则带 `^` 锚定，而 `_strip_implicit_mul` 用 `.match(s, i)` 带位置扫描，`^` 只匹配字符串开头 → 中间位置的 `A` 不被识别为函数 → `diff(A*(x), x)` → 求值得 `A`。**修复：去掉 `^`** |
| 2 | `f(x)=x^2+1` vs 自身判 False | 「两侧不对称」：只有用户侧走「取函数体」逻辑，参考解侧仍走差式。**修复：`_classify_equation` 改为左右任一为函数记法即判 definition；参考解侧同样取函数体** |
| 3 | `a(x+1)` 被误判为函数 | 旧判据只看「未声明 + 左括号」。**修复：新增 `_FUNC_DECL_RE`，要求括号内是单个符号** |

### 关键实现说明

**为什么注入 `symbol_table` 就能自动代入**（阶段 2 前置探针实测）：

用户声明 `f(x)=x^2+1` 后，把 `f` 注入符号表（`kind=function` + `params` + `body`），
现有 `_apply_function_bodies` 即自动完成：

```
f(2)   → 5              （代入求值，R4）
f(x+1) → (x+1)**2+1     （实参展开，R4）
f(t)   → t**2+1         （换变量，R7）
f'(x)  → 2*x            （求导）
```

**因此本轮的「函数声明」能力，主要成本在识别与登记，代入本身是既有能力。**

**为什么错误码要独立**（阶段 3+4）：

`_FunctionNotDeclared` / `_FunctionRedefined` 都是 `ValueError` 子类，
**必须排在 `except ValueError` 之前** —— 顺序颠倒会被误转成 `PARSE_ERROR`，
前端便无法区分「语法错」与「函数忘了声明 / 重复声明」，
而这两类提示话术完全不同（前者要引导「先写 f(x)=...」）。

**为什么从 facts 提取函数定义**（阶段 5）：

声明本身就以 fact 形式沿推导链传递（如 `"f(x) = x^2+1"`）。
两条支链汇合时，两份定义**自然同时出现在前提集里** ——
无需另建存储结构即可发现冲突。

**冲突判定的对称性**（R7）：

`f(x)=x^2+1` 与 `f(t)=t^2+1` 是同一个定义（只是形参名不同），
故判定时把两组形参分别映射到同一批占位符号（`_p0`/`_p1`…）再比较函数体。
解析失败时返回 `True`（**宁可放过，不可误判冲突**）——
冲突会让整步判 fail，代价过高，证据不足时不应下这个结论。

### 验收证据

**阶段 1（17/17）**：

| 用例 | 结果 |
|---|---|
| `x+5=a(x+1)` | ✅ `x + 5 = a*(x + 1)` |
| `a(x+1)` / `f3(x+1)` | ✅ `a*(x + 1)` / `f3*(x + 1)` |
| `f(x)` / `f(x,y)` / `f1(x)` / `Result(x)` / `D(a)` / `q(c)` | ✅ 均识别为函数 |
| `x(x+1)` / `2(x+1)` / `a(x)` | ✅ 走乘法 |
| `A'(x)` | ✅ `Derivative(A(x), x)` |

**阶段 3+4（8/8）**：

| 用例 | 结果 |
|---|---|
| `f(2)=5` 未声明 | ✅ `FUNCTION_NOT_DECLARED` |
| `A(3)+1` 未声明 | ✅ `FUNCTION_NOT_DECLARED` |
| `f(x)=x^2+1=f(x)=x^3` | ✅ `FUNCTION_REDEFINED` |
| `sqrt(2)` 内置函数 | ✅ 不误报 |

**阶段 5（6/6）**：

| 用例 | 结果 |
|---|---|
| 支链 `f(x)=x^2+1` 与 `f(x)=x^3+2` | ✅ `function_conflict` |
| 支链 `f(x)=x^2+1` 与 `f(t)=t^2+1` | ✅ 不算冲突（形参等价） |
| 不同函数名 / 单条定义 / 无关等式 | ✅ 均不误报 |

**全量回归（23/24）**：

| 分组 | 结果 |
|---|---|
| A 多值答案（5） | ✅ 全通过 |
| B 链式（6，轮次 F 核心） | ✅ 全通过 |
| C 约束组（3） | ✅ 全通过 |
| D 普通式（3） | ✅ 全通过 |
| G 数值不自洽（1） | ⚠️ 见下方说明 |
| H 轮次 H 新增（6） | ✅ 全通过 |

**G1 的说明（初判有误，已在轮次 I 更正）**：

`1=2=3` vs `1=2` 判 `True`（strategy=`chain_all_pairs_match`）。

我当时的初判是「这是既有 `numeric_exact` 对纯常数方程的边界行为，非本轮引入」，
依据是「单对 `2=3` vs `1=2` 也判 True」。**这个结论不完整，是错的。**

用户连续追问后逐行核查，发现**两个独立根因**：

| # | 根因 | 性质 |
|---|---|---|
| 1 | `_check_chain_consistency` **已经算出** `{ok: False, failAtIndex: 1}`（这正是用户要求的「逐段真值校验」），**但链式分支返回处写死了 `equivalent: True`**，`chainCheck` 只是被塞进输出字段当装饰品，从未参与判定 | **我的实现缺陷** |
| 2 | `_strategy_numeric_exact` 是「两侧均无自由符号 → 比差式数值」。`1=2` 差式 −1、`2=3` 差式 −1 → 判「数值相等」→ 判「等价」。**这说明用「差式数值」比「等式 vs 等式」本身就是错的** | 既有策略边界 |

我的疏漏：只验到「单对也判 True」就下结论「老毛病、非回归」，
**没有继续往下查到「chainCheck 算出 ok=false 却没生效」**。

详见 §10.5（轮次 I）——该缺陷已修复。

**红线**：`npx tsc --noEmit` → `EXIT=0`（清理前后各复核一次）

**临时文件**：全部清理（`scripts/` 仅剩 `build-sympy.cmd`）

---

## 10.5 轮次 I：判定权迁移 —— 前提链成为主判据，参考答案退为提示（已实施）

### 起因（用户三次追问，逐步逼近根因）

**第一次追问**：
> 「`1=2=3` 暴露出了一个问题，把他拆分成 `1=2` 和 `2=3` 系统为什么会认为是对的，
> 他是这么比较的？`1=2` 单独判断也是该判错误啊」

**第二次追问（指出我思考太久 + 明确定规则）**：
> 「这是一个很简单的比对问题，`1=2=3` 被系统分成 `1=2` 和 `2=3`，
> 比对程序是 `1=2` 和 `2=3` 两个等式之间比对，但是我要求的比对是
> **1 和 2 进行比对，2 和 3 进行比对**，也就是说 `a=b=c=d`，
> 要验证 a 和 b 相等，b 和 c 相等，c 和 d 相等，3 次判断都是正确的，
> 用户输入的 `a=b=c=d` 才是正确的」

**第三次追问（给出 `2x+y=40=x` 的完整判据模型）**：
> 「判断的依据来源于他的前提，例如前提规定 `x<0`，`y>0` 那么这个等式其实没有问题，
> 是用户搭建的一个 x 和 y 的关系，但是下一步判断 `40=x` 就出现了问题，
> 因为前提 `x<0` 和 `40=x` 出现了冲突，就应该判错」

### 代码调查暴露的架构问题（关键发现）

| # | 用户预想的流程 | 实际状态 | 证据 |
|---|---|---|---|
| 1 | 回溯推导链，收集关联的**前提** | ❌ **代码写了但没接线** | `collectBranchPremises` / `judgeStepLegitimacy` / `session_step` 全在，但调用方 `SceneDerivationView` **没传 sessionId**，且 `sessionInit` **全项目零调用点** → 前提链是死代码 |
| 2 | 识别用户自定义的**函数、算子、求导** | ✅ 已实现（轮次 H） | — |
| 3 | 多链等式切分 `a=b=c` → `a=b`、`b=c` | ⚠️ **切了，但判据用错** | `_split_chain` 确实切段；`_check_chain_consistency` 确实算了 `seg[i]-seg[i+1]`（**这才是用户要的比法**）；**但链式分支返回写死 `equivalent: True`，实际生效的是 `_verify_equiv_core("2=3","1=2")`——又回去比参考答案了** |
| 4 | 判定分层（奇点、simplify、定义域值域、极限） | ⚠️ 部分是 | 已有 13 级策略；**没有**奇点/值域/极限对比 |

**结论**：`1=2=3` 不是孤立 bug，而是**架构没走完**的症状 ——
判定主干本应是「这一步自身是否成立」（段间自洽 + 与前提不冲突），
实际跑的却是「这一步是否等于参考答案」，而那条「正路」根本没接上电。

### 用户确认的口径（本次改造的判据）

> 「相当于引入了个变量叫 A，这里是做了个定义，声明创建变量 A，规定 A=x*y，
> 没问题，这种情况**不做比对，而是进行声明，没问题可以 pass**」

| 输入形态 | 判定依据 |
|---|---|
| `A = x*y`（左侧是**全新符号**，右侧不含它） | **定义式** → 登记声明，直接 pass |
| `A = x(20-x)`（A 已登记过） | 普通等式 → 与前提比 |
| `2(x+y)=40`（普通等式） | 与前提比 |
| `1=2=3` | 切分为 `1=2`、`2=3`，逐段判定 |
| 孤立节点（没连线） | 黄灯：提示补连线 |

### 改造后的判定主干

```
1. resolveNodeExpression        LaTeX → SymPy（保留）
2. 前提链判定（session_step）    主判据：legit/warn → pass/warn；illegal/conflict → fail
3. 参考答案 → 仅作 LLM 上下文提示  不进任何判定
4. LLM 定性反馈
```

### 改动清单（4 个文件）

**`python/sympy_server.py`**：

| 新增/修改 | 内容 |
|---|---|
| `_seen_symbol_names(relations)` | 收集祖先前提中出现过的全部符号名（定义式通道的判据 5 依赖它） |
| `_is_new_definition(...)` | 定义式识别：左侧是裸符号 + 未声明 + 未出现在祖先前提 + 右侧符号全部已知 |
| `_chain_segments(raw, locals_map)` | 链式切分（带记法归一，使切出的段可直接交回单段判定） |
| `_judge_atomic(args, ctx)` | **从 `cmd_session_step` 抽出的原子判定规程**（未声明符号 / 除零 / 前提矛盾 / 函数冲突 / 定义式 / 孤立节点 / 可推导性） |
| `cmd_session_step` 重构 | 链式 → 相邻段逐对判；单段 → 委托 `_judge_atomic` |

**`src/services/scene/computeAnalyze.ts`**：
- `analyzeStep` 的 `sessionId` 分支提升为**主判据**，不再回落参考解
- `matchedStepIndex` 改为**纯提示**（供指标 + LLM 上下文），不参与对错裁定
- `verdictSource: 'premise'`

**`src/services/scene/premiseChain.ts`**：
- 新增 `buildSessionSymbols(spec)`：把 `spec.compute.symbols` 规范化为引擎侧契约
  （`kind` 非法值回退 `variable` 而**非** `constant` —— 常量会被当定值代入并参与采样）

**`src/components/scene/SceneDerivationView.tsx`**：
- 新增会话生命周期：`sessionInit`（挂载 / 换场景时重建）+ `sessionClose`（卸载时释放）
- `handleSubmitNode` 传入 `sessionId`

### 为什么必须抽出 `_judge_atomic`

链式等式必须**逐段**判定，而每一段与单段输入要走**完全相同**的前置关卡。
不抽出来就得复制整段逻辑，后续任何修正都要改两处，**必然漏一处**。

### 为什么定义式通道必须早于 `_check_undeclared`

新变量 A 尚未声明，走那里必然报「未定义的符号：A」而判 illegal ——
而这**恰是用户明确要求放行的情形**。
`_check_undeclared` 的职责因此缩小为「拦截右侧引用了未知量」的情况，
由 `_is_new_definition` 的判据 5 把好这一关（右侧须全部已知）。

### 为什么链式要「全部段跑完才返回软结论」

用户明确要求「**3 次判断都做**」。若遇到第一个 `warn`/`unknown` 就提前返回，
后面的段从未验过 —— 违背口径。故：
- 遇 `illegal`/`conflict` → 立即判否（错误已确凿，无需再验）
- 遇 `warn`/`unknown` → 记下首个，**继续跑完**，最后取它

### 探针验证（10/10 全通过）

| 用例 | 输入 | 期望 | 实测 |
|---|---|---|---|
| A1 | `1=2=3` | illegal | ✅ `not_derivable` |
| A2 | `2*x+y=40=y+2*x` | legit | ✅ `chain_all_pairs_ok` |
| A3 | `2*x+y=40=y+99` | illegal | ✅ `not_derivable` |
| B1 | `A=x*y`（新变量） | legit | ✅ `new_definition` |
| B2 | `A=x*z`（z 未出现） | illegal | ✅ `undeclared_symbol` |
| B3 | `A=x*y`（A 已定义过） | illegal | ✅ `undeclared_symbol` |
| C1 | `y=20-x`（由前提推出） | legit | ✅ `ok` |
| C2 | `y=20+x`（算错） | illegal | ✅ `not_derivable` |
| D1 | `x=1`（孤立节点） | unknown | ✅ `no_premise` |
| E1 | `1=1=1`（恒真链） | legit | ✅ `chain_all_pairs_ok` |

**关键**：A1 在旧判定下是 `True`（误判通过），现为 `illegal` —— **用户指出的缺陷已消除**。

### 红线

- `npx tsc --noEmit` → **`EXIT=0`**
- S1 红线文件（`SceneChatView` / `sceneDirector` / `sceneSignal` / `scenePrompt.ts`）**零改动**
- 临时文件全部清理（`scripts/` 仅剩 `build-sympy.cmd`）

### 需人工验证（**必须重启 app**，`.py` 是常驻进程）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 提交 `1=2=3` | ❌ 判错，提示第 1 段与第 2 段不成立 |
| 2 | 提交 `A=x*y`（A 未声明） | ✅ 直接通过，提示「已登记变量 A 的定义」 |
| 3 | 连上前提后提交正确变形 | ✅ 通过（走前提链，不再依赖参考答案） |
| 4 | 不连线直接提交 | ⚠️ 黄灯「缺少前提依据，请连上来源节点」 |
| 5 | 提交 `2x+y=40=y+2x` | ✅ 通过（逐段自洽） |
| 6 | 提交与前提矛盾的式子 | ❌ 判错（前提链判定） |

---

## 10.6 轮次 I 修订：约束/赋值式通道 + 链式前提累积（已实施）

### 起因（用户指出我上一轮判错）

上一轮我实现后向用户汇报「`2*x+y=40=x` 判错」，用户指出这是**错的**：

> 「我认为如果你的前提只有 `2*x+y=40`，那 `2*x+y=40=x` 分成两块来看，
> `2*x+y=40` 是对的，`40=x` 不是一个推导，而是**限定条件**，相当于给 x 赋值，
> `x=40`，不应判错而是 **pass**，也就是说用户自己在这里设置了一个假设前提：`x=40`，没问题」

用户进一步给出统一判据：

> 「你去看 `40=y+99` 这个等式**是不是在前提的允许范围之内**。
> 如果前提允许 `y<0` 那么这个等式没问题，如果前提要求 `y>0`，那这个等式就不成立」

以及关键的实现比喻：

> 「**`a=b=c` 的拆分就相当于用户先提交了 `a=b`，然后再提交 `b=c`**」

### 我上一轮的三处错误

| # | 错误 | 后果 |
|---|---|---|
| 1 | 判据限死「左侧是**全新**裸符号」 | `40=x`（x 早已出现）掉进「推导式」通道 → 误判 illegal |
| 2 | 只认「一侧是裸符号」 | `40=y+99` 两侧都不是裸符号 → 误判 illegal |
| 3 | 链式每一对都用**同一份**原始前提 | 第 2 段拿不到第 1 段「已成立」的身份，与用户比喻不符 |

### 修正后的判据（两条通道）

| 形态 | 通道 | 判据 |
|---|---|---|
| 一侧是**裸符号 v**、另一侧不含 v；**或**能解出某变量唯一值 | **约束式** | 并入前提集查**可满足性**：不冲突 → pass |
| 其余（`2x+y=40`、`x*y=4`、`A(x)=...`） | **推导式** | 现有：能否由前提推出 |

**为什么用可满足性而非「能否推出」**：约束式是**加条件**，推导式是**求结论**。
加条件只需「不冲突」—— 用户原话「在前提的允许范围之内」。

**为什么加了「可解出唯一解」慢路径**：`40=y+99` 两侧都不是裸符号（40 是数字、
`y+99` 是表达式），快路径返回 None。用户口径是「相当于设置为 y=-59」，
故以「`sp.solve` 能解出唯一解」为判据。
**取舍**：用「能否解出唯一解」而非「解是否为数值」——
用户明确接受 `y=40+2x`（含符号的解）也放行：「只有在 x=0 时成立，没问题」。
两者共性都是**给变量定值/定式**。

### 链式前提累积

用户比喻直接决定了实现方式。第 i 对判定时，前提里**已包含**前面所有
判为 `legit` 的段：

```
a=b=c 的判定：
  第1对 (a,b)：在原始前提下判 → legit → 追加 Eq(a,b) 进前提
  第2对 (b,c)：在「原始前提 + a=b」下判   ← 前提已累积
```

**只有 legit 才累积**：`warn` / `unknown` 尚未确认成立，
加进去会让错误沿链扩散。

### 「抄错但自洽 → pass」的取舍（用户已接受）

我向用户指出边界：`y=40-2x`（对）与 `y=40+2x`（抄错符号）在前提 `2x+y=40` 下
**都自洽**（后者解出 `x=0, y=40`），故系统都会判 pass。

用户回复：

> 「学生第一步写 `y = 40-2x`，第二步写 `y = 40+2x`，只有在 `x=0` 时成立，
> 没问题呢，但是只要学生继续写下去就会出现问题，无论他怎么继续推导
> 都只能限制在 `x=0 y=40` 的特例，**至于如果就在第二步结束，最终 LLM 也会裁决**」

**结论**：系统只负责「是否与前提冲突」，「算错但碰巧自洽」交 LLM 裁决。
这是用户明确接受的取舍。

### 改动清单

**`python/sympy_server.py`**

| 新增/修改 | 内容 |
|---|---|
| `_is_new_definition` → `_is_constraint_equation` | 判据由「左侧全新裸符号」改为「任一侧裸符号且另一侧不含它」**或**「可解出某变量唯一解」（慢路径，`sp.solve` 唯一解） |
| `_seen_symbol_names` | **删除** —— 不再需要「该变量是否出现过」的判断 |
| `_judge_atomic` 约束式通道 | 由「登记为定义」改为「并入前提集查可满足性」；新码 `constraint_ok` / `constraint_conflict` |
| `cmd_session_step` 链式分支 | **前提累积**：`local_ctx` 承载，只有 `legit` 的段追加进 `relations` |

**`src/services/scene/premiseChain.ts`**
- `legitFeedback` 加 `constraint_ok` / `constraint_conflict` 两个码的话术
  （说「已由前置步骤推得」会让用户以为系统验证了他的赋值，实际只确认了「不冲突」）

### 探针验证（8/8 全通过）

| # | 输入 | 前提 | 期望 | 实测 | 码 |
|---|---|---|---|---|---|
| 1 | `2*x+y=40=x` | `2*x+y=40` | legit | ✅ | `chain_all_pairs_ok` |
| 2 | `2*x+y=40=y+99` | `2*x+y=40` | legit | ✅ | `chain_all_pairs_ok` |
| 3 | `40=x` | `+ x<0` | illegal | ✅ | `constraint_conflict` |
| 4 | `40=y+99` | `+ y>0` | illegal | ✅ | `constraint_conflict` |
| 5 | `A=x*y` | `2*(x+y)=40` | legit | ✅ | `constraint_ok` |
| 6 | `1=2=3` | `2*x+y=40` | illegal | ✅ | `not_derivable` |
| 7 | `2*x+y=40=y+2*x` | `2*x+y=40` | legit | ✅ | `chain_all_pairs_ok` |
| 8 | `y=40+2*x` | `2*x+y=40`, `y=40-2*x` | legit | ✅ | `constraint_ok` |

**关键对照**：
- 用例 1、2：上一轮判 illegal，现为 **legit** —— 用户指出的缺陷已消除
- 用例 3、4：只有**前提禁止**时才判错（`x<0` / `y>0`）—— 与用户判据一致
- 用例 6：`1=2=3` 仍判错（`1=2` 并入前提后 `is_satisfiable` 立即 False）

### 红线

- `npx tsc --noEmit` → **`TSC=0`**
- 临时文件清理（`scripts/` 仅剩 `build-sympy.cmd`）

### 同一条规则对链式与独立节点一致

```
链式：y=40-2x=40+2x
独立节点1：y=40-2x  → pass → 成为前提
独立节点2：y=40+2x  → 前提含上一节点 → 可满足 → pass
```

**两者结论相同** —— 所以不需要区分「链式后续段」与「独立节点」，
判据统一为「并入前提查可满足性」。这正是用户比喻带来的简化。

---

## 10.7 轮次 I 终版：五类规则 + 定义域判据（已实施）

### 起因（用户指出我上一轮判错两处）

**第一处**：我汇报「`2*x+y=40=x` 判错」，用户指出这是错的：

> 「如果你的前提只有 `2*x+y=40`，那 `2*x+y=40=x` 分成两块来看，
> `2*x+y=40` 是对的，`40=x` 不是一个推导，而是**限定条件**，相当于给 x 赋值，
> `x=40`，不应判错而是 **pass**」

**第二处**：我问「`y=1` 这类不冲突但推不出的该怎样」，用户答：

> 「系统只查冲突，将学生提交的 `y=1` 判定为学生要对 `y=1` 的特解进行讨论，
> 所以 pass」

### ★ 用户补充的关键判据：定义域

> 「有一个重要的判定依据，就是定义域。学生如果只写 `y=40+2x`，抄错符号
> 但是没有声明定义域，就表明他潜在认定 y 和 x 这个关系**在负无穷到正无穷
> 都成立**，这样就和前提冲突了」

**这条判据把等式从「方程（求特解）」提升为「全域恒等式」**，
并让「抄错符号」重新可被抓出（见下方规则 3）。

### 最终规则集（五类 + 二例外）

| # | 类型 | 判定方式 | 结果 |
|---|---|---|---|
| 1 | **新变量定义**（解出的变量前提里没出现过） | — | ✅ `new_definition` |
| 2 | **值指派**（解出已有变量为不含其他变量的值） | 并入前提查冲突 | ✅ `value_assign_ok` / ❌ `constraint_conflict` |
| 3 | **函数关系**（解出已有变量为**含**其他变量的式子） | 前提代入后残差须**域上恒等** | ✅ `relation_ok` / ❌ `constraint_conflict` |
| 4 | 变量已在前提出现过又被重新定义 | 判冲突 | ❌ `constraint_conflict` |
| 5 | 其余（`2x+y=40`、`xy=4`） | 现有推导式判据 | 现有行为 |
| — | 除零 / 未声明符号 / 解析失败 | — | ❌ illegal |
| — | 孤立节点（无祖先前提） | — | ⚠️ unknown → warn |

### 规则 3 为什么必须查「域上恒等」而非「可满足」（关键反例）

```
前提 2x+y=40，学生写 y=40+2x（抄错符号）
  代入前提 → 2x+(40+2x)=40 → 4x=0
  这个方程**可满足**（x=0, y=40）
  但学生没声明定义域 = 主张「对任意 x 都成立」，而只对 x=0 成立
  → 与前提冲突 → 判错  ✅ 抄错符号被抓住
```

### 规则 3 的实现方案（用户确认的「甲：撒点」）

在「其他变量各自的定义域」上取若干点，找到**一个**非零点即判「不恒等」。

我向用户说明的取舍：甲漏掉的只有「仅在极个别点不为零」的情形
（如 `x²/x` 与 `x` 只在 x=0 不同），而那类由 `premise_structure` 的
**奇点比对**（`removable_singularity`）独立负责 —— 两层合起来覆盖
精确求解（乙方案）的全部能力，且无性能风险。用户答「可以」。

### 「抄错但自洽 → pass，交 LLM」的取舍（用户已接受）

用户明确：「至于如果就在第二步结束，最终 LLM 也会裁决」。
**加入规则 3 后**，`y=40+2x` 被判错（靠「未声明定义域即主张全域成立」），
只有「真的处处恒等」才 pass —— 比上一轮更严格且更符合数学。

### 改动清单

**`python/sympy_server.py`**

| 新增/修改 | 内容 |
|---|---|
| **删除** `_is_new_definition` / `_seen_symbol_names` | 判据被五类规则取代 |
| `_appeared_symbols(relations)` | 祖先前提中出现过的全部符号名 |
| `_solve_unique_var(rel)` | 解出唯一变量；**优先认「裸符号侧」**，再扫「纯数值解」，最后退回符号解 |
| `_var_domain(relations, sym)` | 定义域：**先查等式钉死**（`x=0` → `{0}`），无则走 `_premise_domain` |
| `_sample_points(dom, n)` | 从取值集合取代表点；**未识别形态兜底按 ℝ 取点** |
| `_domain_identity_holds(residual, relations, others)` | 残差在定义域上是否恒为零（撒点） |
| `_judge_atomic` 五类规则 | 除零检查**前置**；规则 1/2/3 分流 |

**`src/services/scene/premiseChain.ts`**
- `legitFeedback` 加 `new_definition` / `value_assign_ok` / `relation_ok` 三码话术
- `illegal` 分支加 `constraint_conflict` / `division_by_zero` / `unparsable` 话术

### ★ 实施中实测暴露的四处缺陷（全部实测确认并修复）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | `y=40+2x` 判 pass（应 illegal） | `_sample_points` 未识别 `_premise_domain` 返回的 `Intersection` 形态 → 取点为空 → 拿不到样本 → 返回 None（判不了）→ 被当「不冲突」放行 | 兜底：未识别形态按 ℝ 取点 |
| 2 | `y=a/x` 判 pass（应 illegal） | 五类规则先跑，`y=a/x` 解出 `a=x*y` → a 未出现 → 命中规则 1 → **绕过除零检查** | 除零检查**前置**到五类规则之前 |
| 3 | `y=40+2x` 仍判 pass | `sp.Symbol('y')` 与前提中 `Symbol('y', real=True)`（`_compile_symbols` 产出）**不是同一对象** → `subs` 静默不生效 → 残差仍含 y → 数值代入失败 → 被误判「恒等」 | 取前提中的真实符号对象；加「代入失败守卫」；采样计数改为「算得出数值才算样本」 |
| 4 | 前提 `x=0` 时 `y=40+2x` 判 illegal（应 pass） | ① `_solve_unique_var` 按字母序先解出 **x**（`(y-40)/2`），误当「给 x 定关系」；② `_premise_domain` **只汇总不等式**，`x=0` 这类等式钉死不参与 | 优先认「裸符号侧」；`_var_domain` 补等式钉死 |

### 探针验证（12/12 全通过）

| # | 输入 | 前提 | 期望 | 实测 | 码 |
|---|---|---|---|---|---|
| 1 | `A=x*y` | `2*(x+y)=40` | legit | ✅ | `new_definition` |
| 2 | `40=x` | `2*x+y=40` | legit | ✅ | `value_assign_ok` |
| 3 | `y=1` | `2*x+y=40` | legit | ✅ | `value_assign_ok` |
| 4 | `40=y+99` | `2*x+y=40` | legit | ✅ | `value_assign_ok` |
| 5 | `y=40+2*x` | `2*x+y=40` | **illegal** | ✅ | `constraint_conflict` |
| 6 | `y=40-2*x` | `2*x+y=40` | legit | ✅ | `relation_ok` |
| 7 | `y=40+2*x` | `2*x+y=40`, `x=0` | legit | ✅ | `relation_ok` |
| 8 | `40=x` | `+ x<0` | illegal | ✅ | `constraint_conflict` |
| 9 | `y=a/x` | `+ x=0` | illegal | ✅ | `division_by_zero` |
| 10 | `1=2` | 任意 | illegal | ✅ | `not_derivable` |
| 11 | `1=2=3` | 任意 | illegal | ✅ | `not_derivable` |
| 12 | `2*x+y=40=y+2*x` | `2*x+y=40` | legit | ✅ | `chain_all_pairs_ok` |

**关键对照**：
- 用例 5 vs 6：符号差一个负号，前者判错后者通过 —— **靠规则 3 抓住抄错**
- 用例 7：前提 `x=0` 钉死定义域后，同一个 `y=40+2x` 变为 legal —— 定义域判据生效
- 用例 3 vs 5：`y=1`（值指派）pass，`y=40+2x`（函数关系）illegal —— 两类分流正确

### 红线

- `npx tsc --noEmit` → **`TSC=0`**
- 临时文件清理（`scripts/` 仅剩 `build-sympy.cmd`）

### 仍需人工验证（**必须重启 app**）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 提交 `A=x*y`（A 未声明） | ✅ pass，提示「已登记该变量的定义」 |
| 2 | 提交 `y=1`（前提 `2x+y=40`） | ✅ pass，提示「本步为赋值」 |
| 3 | 提交 `y=40+2x`（抄错符号） | ❌ 判错，提示「只在部分取值上成立」 |
| 4 | 提交 `y=40+2x` 且前提含 `x=0` | ✅ pass（定义域钉死） |
| 5 | 前提含 `x<0` 时提交 `40=x` | ❌ 判错，提示与前提冲突 |
| 6 | 提交 `y=a/x` 且前提含 `x=0` | ❌ 判错，提示分母可能为 0 |
| 7 | 提交 `1=2=3` | ❌ 判错 |

---

## 10.8 轮次 I 终版追加：公式块自带的限定条件（已实施）

### 起因（用户提出「补上缺口」）

我在 §10.7 末尾如实指出一个缺口：**等式自身携带的限定条件未被处理**。
用户确认补上，并给出实现方式：

> 「这相当于是预处理阶段的事情，如果用户在公式块中写 `y=40+2x；(x=0)`，
> 按照预处理分块分成 `y=40+2x` 和 `x=0`，这时候我们要把 `x=0` 提到前面，
> 相当于先提交 `x=0` 作为前提，再提交 `y=40+2x`」

### 用户口径的三次收敛（关键）

**第一次**：分号分隔，第一段是主式 → 我提出「按顺序」

**第二次（否定顺序，改为形式）**：

> 「**不一定是这个顺序，不以顺序作为判断限定条件的依据，把形式作为判断依据**；
> 我建议识别括号，把括号作为形式判断依据之一，也就是说这个限定条件按照
> **分隔符 + （）内等式不等式**作为是否为限定条件的判断，例如
> `等式;(x>0,y=0)`；**3 分隔符都接受；兼容旧写法**」

**第三次（扩大识别范围）**：

> 「全都判定，把 `x=数值`、`> <` 这些形式都放在前面行不行，因为
> `符号=数值` 可能是用户得出的计算结果，**提前的话是否作为前提都是成立的**」

**我确认该口径数学上成立**：值指派型（`x=5`）的检查方式**本身**就是
「与前提是否一致」，而「把它当前提」时的检查正是同一件事，两者等价。
故可统一按「提升为前提 + 自身判定」处理，无副作用。

### 最终识别规则（形式判断，与顺序无关）

**一段是「限定条件」段 ⟺ 满足其一**：

| # | 形式 | 例 |
|---|---|---|
| 1 | **被括号包裹**且内容是**关系式** | `(x=0)`、`（x>0）` |
| 2 | **是不等式**（含链式） | `x>0`、`0<x<20` |
| 3 | **能解出某变量为常数** | `x=0`、`40=x`、`40=y+99`（→ y=−59） |

**不满足的 → 主式**（如 `2x+y=40`、`xy=4`、`y=40+2x`、`x*y=4`、`(x+1)`）

区分要点（这是本规则的**核心**）：

| 输入 | 解出什么 | 是限定条件吗 |
|---|---|---|
| `x=0` | 常数 | ✅ 是（值指派） |
| `y=40+2x` | **含 x 的表达式** | ❌ 否 —— 它声称「对所有 x 成立」，**光当前提不够**，还须过「全域恒等」那关 |
| `(x+1)` | 不是关系式 | ❌ 否（普通括号运算，避免重演「括号被误拆」的老问题） |

### 处理流程

```
① 按顶层分隔符切段（;  ；  ,  ，）—— 深度扫描，保护括号内分隔符
② 逐段识别：限定条件段 / 主式段（形式判断，不看顺序）
③ 限定条件**逐个判定**（用户要求「全都判定」）→ 并入前提
④ 剩余段当主式，用「图前提 + 全部已确认的约束段」判定
⑤ 若全部段都是限定条件 → 只做③，全一致则 pass
```

### ★ 关键设计：约束段用「相容性」判据，不是「可推导性」

**为什么必须分开**（`_judge_constraint` 的由来）：
约束段（不等式 / 括号关系式）若走 `_judge_atomic` 的正常路径，
会被 `_check_derivable_ex` 按「能否由前提**推出**」判定 ——
而 `x>0` 这类自加约束本就不是从前提推出的，**必然被判 illegal**。
但用户口径第 1 条要求的是「**与前提无冲突**」（相容性），两者判据不同。

| 段类型 | 判据 | 函数 |
|---|---|---|
| 限定条件段 | 并入前提 → **可满足性** | `_judge_constraint` |
| 主式段 | 由前提**推出**（或五类规则） | `_judge_atomic` → `_judge_one` |

### 深度扫描保护括号内分隔符（关键实现）

```
_split_top_level(raw, seps)
```

**为什么不能直接 `re.split`**：
- `(x>0,y=0)` 里的逗号是**约束内部分隔符**
- `f(x,y)` 里的逗号是**函数参数分隔符**

两者都在括号内，直接按逗号切会产出 `(x>0` / `y=0)` 这样的碎片。
深度扫描时括号内 `depth > 0`，天然跳过这两种情形。

### 改动清单

**`python/sympy_server.py`**

| 新增/修改 | 内容 |
|---|---|
| `_OPEN_PARENS` / `_CLOSE_PARENS` | 括号字符集（含全角 `（【` / `）】`） |
| `_LOCAL_SEP` | 顶层分隔符 `";；,，"` |
| `_split_top_level(raw, seps)` | 深度扫描切段（保护括号内分隔符） |
| `_unwrap_parens(seg)` | 剥一层括号，返回 `(内容, 是否带括号)` |
| `_is_constraint_segment(seg, locals_map)` | **形式判断**该段是否为限定条件（三条判据） |
| `_split_local_constraints(raw, locals_map)` | 拆成 `(mains, cons)`；括号内多条自动展开 |
| `_judge_constraint(seg, use_ctx)` | 约束段专用判定（**相容性**，非可推导性） |
| `cmd_session_step` 重构 | 嵌套 `_judge_one`（含链式）；约束段逐个判定并累积；多主式段逐段判定 |

### 探针验证（14/14 全通过）

**新增用例（8 条）**：

| # | 输入 | 前提 | 期望 | 实测 | 码 |
|---|---|---|---|---|---|
| C1 | `y=40+2*x; x=0` | `2x+y=40` | legit | ✅ | `relation_ok` |
| C2 | **`x=0; y=40+2*x`**（**顺序颠倒**） | `2x+y=40` | legit | ✅ | `relation_ok` |
| C3 | `y=40+2*x; x>0` | `2x+y=40` | illegal | ✅ | `constraint_conflict` |
| C4 | `x=0, y=40`（**逗号** + 全约束段） | `2x+y=40` | legit | ✅ | `constraint_ok` |
| C5 | `x=5, y=40`（**与前提冲突**） | `2x+y=40` | illegal | ✅ | `constraint_conflict` |
| C6 | `y=40+2*x; (x=0)`（**括号包裹**） | `2x+y=40` | legit | ✅ | `relation_ok` |
| C7 | `（y=40+2*x）;（x>0）`（**全角括号**） | `2x+y=40` | illegal | ✅ | `constraint_conflict` |
| C8 | `y=2*x; x<0`（**自声明与图前提冲突**） | `x>0` | illegal | ✅ | `constraint_conflict` |

**回归用例（6 条，确认未破坏既有行为）**：

| # | 输入 | 前提 | 期望 | 实测 |
|---|---|---|---|---|
| R1 | `y=40+2*x` | `2x+y=40` | illegal | ✅ |
| R2 | `y=40-2*x` | `2x+y=40` | legit | ✅ |
| R3 | `2*x+y=40=x` | `2x+y=40` | legit | ✅ |
| R4 | `1=2=3` | `2x+y=40` | illegal | ✅ |
| R5 | `A=x*y` | `2*(x+y)=40` | legit | ✅ |
| R6 | `y=a/x` | + `x=0` | illegal | ✅ |

**关键对照**：
- **C1 vs C2**：顺序颠倒，结论相同 —— **形式判断生效，与书写顺序无关**
- **C3 vs C1**：把 `x=0` 换成 `x>0`，前者判错 —— 约束段被真正纳入判定
- **C7**：全角括号同样被识别
- **C8**：自声明约束若与图前提冲突，被用户口径第 1 条自动抓住
- **R1 vs C1**：同样的 `y=40+2x`，带 `x=0` 时 pass、不带时判错 —— **限定条件的作用可见**

### 红线

- `npx tsc --noEmit` → **`TSC=0`**
- 临时文件清理（`scripts/` 仅剩 `build-sympy.cmd`）

### 写法规范（供文档与 UI 提示使用）

```
公式块可自带限定条件，用 ; ； , ， 分隔（都用括号括起来亦可）：

  y=40+2x; x=0            ← 主式 + 一个约束
  y=40+2x; (x=0)          ← 括号写法，等价
  y=40+2x; x>0; y<100     ← 多个约束
  x=0, y=40               ← 全部都是约束（无主式）也可以
  （y=40+2x）;（x>0）      ← 全角括号同样识别

识别依据是**形式**，与书写顺序无关：
  · 括号包裹的关系式
  · 不等式（含链式，如 0<x<20）
  · 能解出某个变量为常数的等式（如 x=0、40=x、40=y+99）
其余段视为主式，按前提链判定。

注意：`y=40+2x` 本身**不是**限定条件（它声称对任意 x 成立，
须过「全域恒等」检查），故 `y=40+2x; x=0` 才会 pass。
```

### 仍需人工验证（**必须重启 app**）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 提交 `y=40+2x; x=0`（前提 `2x+y=40`） | ✅ pass |
| 2 | 提交 `x=0; y=40+2x`（顺序颠倒） | ✅ pass（结论相同） |
| 3 | 提交 `y=40+2x; x>0` | ❌ 判错 |
| 4 | 提交 `x=0, y=40` | ✅ pass |
| 5 | 提交 `x=5, y=40` | ❌ 判错（与前提冲突） |
| 6 | 提交 `y=40+2x`（不带约束） | ❌ 判错（回归，行为不变） |

- 临时探针文件 `scripts/_pN.py` 已删除
</final_file_content>

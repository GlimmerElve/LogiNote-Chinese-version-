# -*- coding: utf-8 -*-
"""LaTeX 优先解析通道（路线 A）。

## 为什么单独成模块
`sympy_server.py` 已近 4000 行，大段替换反复失败（与 `premise_engine.py`
分离时同样的原因）。独立后 `sympy_server.py` 只需薄委托。

## 与既有 Python 语法通道的关系（**并存，不替换**）
项目原本有两条输入形态：
  ① Python 语法（`2*x+y=40`、`diff(A(x), x)`）→ `_to_diff`（sympify 通道）
  ② **LaTeX 语法（`\\frac{m_0}{\\sqrt{1-v^2/c^2}}`）→ 本模块**

MathLive 编辑器产出的是 **LaTeX**，此前必须经 LLM 转译才能喂给引擎。
本模块让 LaTeX **直达 SymPy**，零 LLM 调用。

`_p1.py` 三轮探针（项目既有）已确认 `parse_latex` 是原定路线，
唯一障碍是 `antlr4-python3-runtime` 版本不符（装 4.9.3，SymPy 要求 4.11）。
升到 4.11 后实测 26/28 通过（见 `_p4.py`）。

## 实测确定的规则（**全部来自探针，非猜测**）

### 1. 撇号导数必须预处理（p6/p7/p8 实测）
`parse_latex` 不认识 Python 的 `diff()` / `Derivative()`：
  `diff(A(x), x)` → `di*(f*f(A(x), x))`   ← 被按字母拆解，完全错误
且 `A'(x)` 会被解析成「名为 `A'` 的函数」，**不是导数**。

故必须先把撇号转成 **LaTeX 导数记法**：
  `A'(x)`   → `\\frac{d}{dx} A(x)`                      → `Derivative(A(x), x)`
  `A''(x)`  → `\\frac{d}{dx}\\frac{d}{dx} A(x)`          → `Derivative(A(x), (x, 2))`

**注意一阶与高阶的写法不同**（p8 穷举实测）：
  - 一阶：`\\frac{d}{dx} A(x)` ✅（`\\frac{d A(x)}{dx}` 也可）
  - 高阶：`\\frac{d^{2}}{dx^{2}} A(x)` ❌（被当作乘法 `(d**2/(dx**2))*A(x)`）
          必须**嵌套写**：`\\frac{d}{dx}` 重复 n 次 ✅

### 2. 下标输出需归一（p5 实测）
`parse_latex` 把 `m_0` / `m_{0}` 都解析为**符号名 `m_{0}`**，而项目口径是 `m0`
（见 §4.1 `_SYM_TOKEN_RE = [A-Za-z]\\d*`）。故 `sstr` 输出要做
`m_{0}` → `m0` 的字符级归一。

### 3. 等式返回 `Eq`，链式返回**嵌套 Eq**（p5 实测）
  `2x + y = 40`  → `Eq(2*x + y, 40)`
  `a = b = c`    → `Eq(Eq(a, b), c)`   ← 注意是嵌套，不是三段列表
需展平为相邻段列表，交调用方的链式分支处理。

### 4. 与符号表的协作
`parse_latex` 无 `locals` 参数，符号由 LaTeX 文本自身决定（`m_0` → `Symbol('m_{0}')`）。
归一后需与场景声明的符号名对齐（如场景声明 `m0`，归一后即匹配）。
"""

import re

import sympy as sp

try:
    from sympy.parsing.latex import parse_latex as _parse_latex
    _PARSE_LATEX_AVAILABLE = True
except Exception:  # noqa: BLE001
    _parse_latex = None
    _PARSE_LATEX_AVAILABLE = False


# ---------------------------------------------------------------- 预处理

# 撇号导数记法：函数名 + 1~3 个撇号 + (单个自变量)
# 与 sympy_server.py 的 _DERIV_RE 保持同一口径（只处理括号内为单一标识符）
_DERIV_RE = re.compile(r"([A-Za-z_]\w*)\s*(['\u2032]{1,3})\s*\(\s*([A-Za-z_]\w*)\s*\)")

# 各种撇号字符 → 半角
_PRIME_TRANS = str.maketrans({
    "\u2032": "'", "\u2019": "'", "\u2018": "'", "\u02b9": "'",
})

# 全角括号/方括号 → 半角
_FULLWIDTH_TRANS = str.maketrans({
    "\uff08": "(", "\uff09": ")", "\u3010": "[", "\u3011": "]",
})

# LaTeX \left( ... \right) → ( ... )
_LEFT_RIGHT_RE = re.compile(r"\\(?:left|right)\s*([.()\[\]|])")


# ---------------------------------------------------------------- 轮次 W 新增
#
# LaTeX `\prime` 撇号 → 半角撇号（MathLive 导数键的实测产出形态）
#
# ## 为什么必须单独处理（vmlx 探针 #F1 / #F3 实测确认）
#   MathLive 输入撇号时产出的是 **`F^{\prime}(x)`**（LaTeX 宏），
#   而下方 `_DERIV_RE` 只认「名字 + 撇号 + (参数)」**紧邻**的形态 ——
#   中间夹着 `^{...}` 时匹配不到。
#   于是它一路流到 `sympy_server._normalize_notation` 的 `_CARET_RE`，
#   被转成 `F**{\prime}(x)`（`^`→`**`），sympify 直接抛
#   「could not parse 'F**{\prime}*(x)'」（实测报错原文）。
#
#   故此处**先把 `^{\prime...}` 还原成 `'`**，使其回到 `_DERIV_RE`
#   能识别的形态（`F'(x)`），再由 `_prime_to_latex_deriv` 转 LaTeX 导数记法。
#
# 支持三种写法（`\s*` 容忍宏之间/花括号内的空格）：
#   `^{\prime}`         → `'`
#   `^{\prime\prime}`   → `''`
#   `^{\prime \prime}`  → `''`
_PRIME_BRACE_RE = re.compile(r"\^\{\s*((?:\\prime\s*)+)\}")
_LATEX_PRIME_RE = re.compile(r"\\prime\b")

# LaTeX 细碎空格命令 → `\,`
#
# ## 为什么统一转 `\,` 而非删掉或转普通空格（vmlx #H1/#H2 实测）
#   `\,` 可被 parse_latex 正常处理（#H1 pass）；而 `\;`、`\ ` 会失败
#   （#H2 fail，报 `could not parse '2\'`）。
#   **转成 `\,` 最稳** —— 复用已验证通路；若「删掉」则可能把左右两个
#   记号粘连成一个（如 `2\;x` → `2x` 语义变化，虽然此处恰好等价，
#   但 `a\;b` 这种就危险）。`\!` 是负空格（仅排版用），直接删除无副作用。
_LATEX_SPACE_RE = re.compile(r"\\[;>]|\\\s")
_LATEX_NEGSPACE_RE = re.compile(r"\\!")

# MathLive 偏导分式。SymPy parse_latex 能处理一阶
# ``\frac{\partial u}{\partial x}``，但会把高阶/混合偏导误解为普通除法。
# 这里只识别“偏导符 + 阶数 + 被导式”这个确定形态，再改写成
# parse_latex 已可靠支持的嵌套一阶算子。
_PARTIAL_NUM_RE = re.compile(
    r"^\s*\\partial(?:\s*\^\s*(?:\{\s*(\d+)\s*\}|(\d+)))?\s*(.*?)\s*$",
    re.S,
)
_PARTIAL_DEN_TERM_RE = re.compile(
    r"\s*(?:\\,\s*)*\\partial\s*"
    r"([A-Za-z](?:_\{?\w+\}?)?)"
    r"(?:\s*\^\s*(?:\{\s*(\d+)\s*\}|(\d+)))?",
)

# parse_latex 会把 ``\int_0^1 2x`` 的上限读成 ``12``。LaTeX 语义中未加
# 花括号的上下标本来就只包含紧随其后的一个 token，因此先显式补成
# ``\int_{0}^{1} 2x``，既消除歧义，也与 MathLive 的标准序列化一致。
_INT_BOUND_TOKEN = r"-?(?:\\[A-Za-z]+|[A-Za-z]\w*|\d+(?:\.\d+)?)"
_INT_LOWER_RE = re.compile(
    r"(\\int(?:\s*\\limits)?\s*)_(?!\{)\s*(" + _INT_BOUND_TOKEN + r")"
)
_INT_UPPER_RE = re.compile(
    r"(\\int(?:\s*\\limits)?\s*(?:_\{[^{}]*\})?\s*)\^(?!\{)\s*("
    + _INT_BOUND_TOKEN
    + r")"
)


def _latex_prime_to_apostrophe(text):
    r"""`^{\prime...}` → 对应个数的半角撇号；裸 `\prime` → `'`。

    见 `_PRIME_BRACE_RE` 上方注释（MathLive 导数键实测产出）。
    """
    def _brace_repl(m):
        return "'" * len(_LATEX_PRIME_RE.findall(m.group(1)))

    t = _PRIME_BRACE_RE.sub(_brace_repl, text)
    return _LATEX_PRIME_RE.sub("'", t)


def _latex_spaces_to_thin(text):
    """把 `\\;` / `\\ ` / `\\>` 统一为 `\\,`；`\\!` 删除。

    见 `_LATEX_SPACE_RE` 上方注释（vmlx #H2 实测）。
    """
    t = _LATEX_SPACE_RE.sub(r"\\,", text)
    return _LATEX_NEGSPACE_RE.sub("", t)


def _brace_unbraced_integral_bounds(text):
    """按 LaTeX 单-token 规则为积分的裸上下限补花括号。"""
    t = _INT_LOWER_RE.sub(lambda m: "%s_{%s}" % (m.group(1), m.group(2)), text)
    return _INT_UPPER_RE.sub(lambda m: "%s^{%s}" % (m.group(1), m.group(2)), t)


def _read_braced(text, start):
    """读取 start 处的平衡 ``{...}``，返回 (内容, 结束位置)。"""
    if start >= len(text) or text[start] != "{":
        return None, start
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start + 1:i], i + 1
    return None, start


def _partial_denominator_vars(text):
    r"""解析 ``\partial x^2`` / ``\partial x\partial y`` 的求导变量序列。"""
    out = []
    pos = 0
    while pos < len(text):
        m = _PARTIAL_DEN_TERM_RE.match(text, pos)
        if not m:
            return None
        count = int(m.group(2) or m.group(3) or "1")
        if count < 1 or count > 8:
            return None
        out.extend([m.group(1)] * count)
        pos = m.end()
    return out or None


def _normalize_partial_derivatives(text):
    r"""MathLive 高阶/混合偏导分式 → 嵌套一阶偏导算子。

    例：``\frac{\partial^2 u}{\partial x\partial y}`` 会改写成
    ``\frac{\partial}{\partial y}\frac{\partial}{\partial x}u``，
    parse_latex 随后会稳定生成 ``Derivative(u, x, y)``。

    该扫描器只处理两个平衡花括号的 ``\frac``；任一阶数不一致
    或分母不是纯偏导项时保留原文，避免猜测语义。
    """
    if not isinstance(text, str) or "\\partial" not in text:
        return text
    out = []
    pos = 0
    while True:
        hit = text.find("\\frac", pos)
        if hit < 0:
            out.append(text[pos:])
            break
        out.append(text[pos:hit])
        i = hit + len("\\frac")
        while i < len(text) and text[i].isspace():
            i += 1
        num, after_num = _read_braced(text, i)
        if num is None:
            out.append(text[hit:i])
            pos = i
            continue
        j = after_num
        while j < len(text) and text[j].isspace():
            j += 1
        den, after_den = _read_braced(text, j)
        if den is None:
            out.append(text[hit:j])
            pos = j
            continue

        nm = _PARTIAL_NUM_RE.match(num)
        variables = _partial_denominator_vars(den) if nm else None
        order = int((nm.group(1) or nm.group(2) or "1")) if nm else 0
        if not nm or not variables or order != len(variables):
            out.append(text[hit:after_den])
            pos = after_den
            continue

        operand = _normalize_partial_derivatives((nm.group(3) or "").strip())
        # LaTeX 算子从外到内应逆序生成，使 parse_latex 的 Derivative
        # 变量顺序与原分母一致。
        ops = "".join(
            "\\frac{\\partial}{\\partial %s}" % var
            for var in reversed(variables)
        )
        out.append(ops + operand)
        pos = after_den
    return "".join(out)


def _prime_to_latex_deriv(text):
    """把撇号导数转成 **LaTeX** 导数记法（供 parse_latex 使用）。

    一阶与高阶写法不同（p8 穷举实测，见模块 docstring §1）：
      A'(x)   → \\frac{d}{dx} A(x)
      A''(x)  → \\frac{d}{dx}\\frac{d}{dx} A(x)    ← 嵌套，不是 \\frac{d^{2}}{dx^{2}}
    """
    def _repl(m):
        name, primes, arg = m.group(1), m.group(2), m.group(3)
        n = len(primes)
        op = "\\frac{d}{d%s} " % arg
        return op * n + "%s(%s)" % (name, arg)

    return _DERIV_RE.sub(_repl, text)


def preprocess_latex(raw):
    """LaTeX 文本预处理：撇号导数 + 全角括号 + \\left\\right 归一。

    只做**确定性字符替换**，不涉及语义判断。
    """
    if not isinstance(raw, str):
        return ""
    t = raw.strip()
    if t.startswith("$") and t.endswith("$"):
        t = t[1:-1]
    t = t.translate(_PRIME_TRANS)
    t = t.translate(_FULLWIDTH_TRANS)
    t = t.replace("∂", "\\partial")
    t = _LEFT_RIGHT_RE.sub(r"\1", t)
    # 轮次 W：`^{\prime}` → `'`（必须在 `_prime_to_latex_deriv` **之前**，
    # 否则 `\prime` 形态匹配不到 `_DERIV_RE`）。见 `_PRIME_BRACE_RE` 注释。
    t = _latex_prime_to_apostrophe(t)
    # 轮次 W：`\;` / `\ ` → `\,`；`\!` 删除。见 `_LATEX_SPACE_RE` 注释。
    t = _latex_spaces_to_thin(t)
    t = _brace_unbraced_integral_bounds(t)
    # SymPy 只能稳定解析一阶偏导算子；先把高阶/混合形态
    # 展开为嵌套一阶，再交给同一 parse_latex 通道。
    t = _normalize_partial_derivatives(t)
    return _prime_to_latex_deriv(t)


# ---------------------------------------------------------------- 后处理

# 下标归一：m_{0} → m0、x_{1} → x1（项目口径为「字母+可选数字下标」）
_SUBSCRIPT_BRACE_RE = re.compile(r"([A-Za-z])_\{(\w+)\}")
_SUBSCRIPT_PLAIN_RE = re.compile(r"([A-Za-z])_(\w)")


def normalize_subscripts(text):
    """把 `m_{0}` / `x_1` 归一到项目口径 `m0` / `x1`（p5 实测需要）。"""
    if not isinstance(text, str):
        return ""
    s = _SUBSCRIPT_BRACE_RE.sub(r"\1\2", text)
    return _SUBSCRIPT_PLAIN_RE.sub(r"\1\2", s)


def flatten_equation(expr):
    """把（可能嵌套的）Eq 展平成段列表。

    `Eq(a, b)`          → ['a', 'b']
    `Eq(Eq(a, b), c)`   → ['a', 'b', 'c']    ← 链式等式（p5 实测形态）
    非 Eq               → None（表示「不是等式」）
    """
    if not isinstance(expr, sp.Eq):
        return None
    left = flatten_equation(expr.lhs)
    rhs = sp.sstr(expr.rhs)
    if left is None:
        return [sp.sstr(expr.lhs), rhs]
    return left + [rhs]


def _expand_bare_function_derivatives(expr, function_params):
    """按场景函数签名把 ``Derivative(u, x)`` 补成 ``Derivative(u(x,y), x)``。

    MathLive 的常见 PDE 写法会省略因变量的形参列表（``∂u/∂x``）。
    只对场景已明确给出 ``params`` 的函数补全；未声明签名时不猜。
    """
    if expr is None or not function_params:
        return expr
    reps = {}
    try:
        derivatives = list(expr.atoms(sp.Derivative))
    except Exception:  # noqa: BLE001
        return expr
    for node in derivatives:
        base = node.expr
        if not isinstance(base, sp.Symbol):
            continue
        params = (function_params or {}).get(str(base)) or []
        if not params:
            continue
        known = {str(s): s for s in node.free_symbols}
        args = [known.get(str(p), sp.Symbol(str(p), real=True)) for p in params]
        try:
            call = sp.Function(str(base))(*args)
            reps[node] = sp.Derivative(call, *node.variable_count, evaluate=False)
        except Exception:  # noqa: BLE001
            continue
    if not reps:
        return expr
    try:
        return expr.xreplace(reps)
    except Exception:  # noqa: BLE001
        return expr


# ---------------------------------------------------------------- 主入口

def latex_to_expr(raw, symbol_names=None, function_params=None):
    """LaTeX → SymPy 对象（**不做等式归一**）。

    返回 dict：
      成功：{"ok": True, "expr": <sympy对象>, "is_equation": bool,
             "segments": [str] | None}
      失败：{"ok": False, "error": str}

    `segments` 非 None 表示输入是等式（含链式），调用方据此走等式分支。
    段列表已做下标归一，可直接喂给 `_to_diff` 等既有函数。
    """
    if not _PARSE_LATEX_AVAILABLE:
        return {
            "ok": False,
            "error": (
                "LaTeX 解析不可用：需要 antlr4-python3-runtime==4.11"
                "（当前未安装或版本不符）"
            ),
        }

    text = preprocess_latex(raw)
    if not text:
        return {"ok": False, "error": "表达式为空"}

    try:
        expr = _parse_latex(text)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": "LaTeX 解析失败：%s" % (e,)}

    # ``∂u/∂x`` 的 u 在 LaTeX AST 中是裸 Symbol。若场景已声明
    # u(x,y)，在展平 Eq / sstr 之前补成真实函数调用。
    expr = _expand_bare_function_derivatives(expr, function_params)

    # --- 轮次 O 修复（关键，GUI 实测缺陷）---
    # **布尔结果 → 本通道放弃**（返回 ok=False，由调用方静默回落 Python 归一链）。
    #
    # 为什么必须拦（实测确认的完整链路）：
    #   输入 `2x+3y=2x+3\left(kx-7\right)=23`（MathLive 的 smartFence=true
    #   会把圆括号自动升级为 `\left( \right)`，故必然进本通道）——
    #   `parse_latex` 对**三段链式** `a=b=c` 生成 `Eq(Eq(a,b), c)`，
    #   而 SymPy 见「Eq(布尔, 表达式)」结构上**确定不等**，遂**当场求值**
    #   为 `BooleanFalse`（`_parse_latex` 返回的不是 Eq 对象！）。
    #
    #   后果链：`flatten_equation(False)` → None（它只认 sp.Eq）
    #     → 被误判为「非等式」分支 → `sp.sstr(False)` = "False"
    #     → 返回 {"ok": True, "expr": False, "text": "False"}
    #     → 调用方 `_to_diff` 信了 ok=True，把 "False" 当表达式串
    #     → `_strip_implicit_mul("False")` 逐字母插乘号得 **"F*a*l*s*e"**
    #     → sympify 得 F·a·l·s·e → 判定报「未定义的符号：F、a、e、l、s」
    #   用户看到的正是这五个凭空出现的符号（它们就是 "False" 的字母）。
    #
    # 为什么返回 ok=False 就够了：`_to_diff` 对 LaTeX 通道失败**本就设计为
    #   静默回落**（保持既有通道行为不变）。而 Python 归一链已实测能正确
    #   处理这条输入 —— `_split_chain` 把它切成 3 段合法链式等式
    #   （实测 holder["text"] = `2*x+3*y=2*x+3*(k*x-7)=23`）。
    #
    # 影响面：两段等式/普通表达式/不等式的结果仍是 Expr 或 Eq，
    #   走原有路径，**零影响**；仅「链式导致布尔求值」这一种情形改变。
    # 注：`bool` 与 `BooleanAtom` 都要判 —— Python 的 True/False 与
    #   SymPy 的 S.true/S.false 不是同一体系。
    if isinstance(expr, (bool, sp.logic.boolalg.BooleanAtom)):
        return {
            "ok": False,
            "error": "LaTeX 解析结果为布尔值（链式等式超出 parse_latex 能力），改走归一链",
        }

    # 等式：展平为段列表（链式会得到 >2 段）
    segs = flatten_equation(expr)
    if segs is not None:
        norm_segs = [normalize_subscripts(s) for s in segs]
        if len(norm_segs) > 2:
            # 链式等式：交调用方的链式分支逐对判定
            return {
                "ok": True,
                "expr": None,
                "is_equation": True,
                "segments": norm_segs,
            }
        lhs_s, rhs_s = norm_segs[0], norm_segs[1]
        try:
            lhs = sp.sympify(lhs_s)
            rhs = sp.sympify(rhs_s)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": "等式两侧解析失败：%s" % (e,)}
        return {
            "ok": True,
            "expr": sp.simplify(lhs - rhs),
            "is_equation": True,
            "segments": norm_segs,
        }

    # 非等式：归一后原样返回（保留 Derivative / Abs / 不等式等结构）
    #
    # **必须同时回传归一后的字符串 `text`**（轮次 J 修复，实测确认的缺陷）：
    #   初版只回传 sympy 对象，调用方对非等式走 `sp.sstr(expr)` —— 而
    #   parse_latex 把 `m_0` 解析为**符号名 `m_{0}`**（p5 实测），
    #   `sstr` 后仍是 `m_{0}`，未经下标归一就流入 `_strip_implicit_mul`，
    #   被逐段拆成 `m` 与 `{0}` → 产出 `m*{0}`，而 Python 的 `{0}` 是 set
    #   → sympify 抛 `unsupported operand type(s) for *: 'Symbol' and 'set'`
    #   （验收用例 L1/L3 实测确认）。
    #   等式分支已对 segments 做过归一，故只有分支漏了这一步。
    return {
        "ok": True,
        "expr": expr,
        "text": normalize_subscripts(sp.sstr(expr)),
        "is_equation": False,
        "segments": None,
    }


# ---------------------------------------------------------------- 口径转换

# SymPy 的 sstr 记法 → 项目 NLP 口径（`_strip_implicit_mul` 白名单内的写法）
#
# 为什么需要：`parse_latex("||x| - 1|")` 得到 `Abs(Abs(x) - 1)`（p5 实测），
# 早期 `Abs` 不在内置算子白名单，曾被拆成 `A*b*s*(...)`。
# 现在 Abs / abs 均为受保护的内置算子；仍保留小写项目别名，维持既有输出格式。
#
# 只做**已验证必要**的替换，不做大范围改写 —— 其余 sstr 输出
# （sqrt / log / exp / Derivative / sin / cos ...）都已在白名单内，原样保留。
_SYMPY_TO_PROJECT = (
    # 单词边界匹配，避免误伤（如变量名 Abss）
    (re.compile(r"\bAbs\b"), "abs"),
)


def to_project_syntax(text):
    """把 SymPy 的 sstr 记法转成项目 NLP 口径（白名单内的函数名）。

    只做白名单对齐所需的最小替换，见 `_SYMPY_TO_PROJECT` 的说明。
    """
    if not isinstance(text, str):
        return ""
    for pat, repl in _SYMPY_TO_PROJECT:
        text = pat.sub(repl, text)
    return text


def latex_available():
    """LaTeX 解析是否可用（供 ping 命令上报）。"""
    return _PARSE_LATEX_AVAILABLE

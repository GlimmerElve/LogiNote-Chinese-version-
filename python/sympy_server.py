"""SymPy 计算服务（S4 数理场景后端）

常驻进程，通过 stdin/stdout 的 NDJSON（一行一个 JSON）与 Electron 主进程通信。

协议：
  请求：{"id": "req-1", "cmd": "verify_equiv", "args": {...}}
  成功：{"id": "req-1", "ok": true, "result": {...}}
  失败：{"id": "req-1", "ok": false, "error": "...", "errorCode": "PARSE_ERROR"}

命令清单：
  ping           探活，返回协议版本与依赖版本
  parse          sympify 表达式，返回变量列表
  verify_equiv   5 级兜底等价性判定
  limit          求极限
  check_units    单位字符串合法性自检（完整量纲检查在 LLM 侧）
  plot_data      采样生成绘图数据
  substitute     符号代入求值
  simplify       表达式化简

错误码：
  PARSE_ERROR / SYMBOL_NOT_DECLARED / INTERNAL_ERROR / PROTOCOL_ERROR
"""

import json
import random
import re
import sys
import traceback
from itertools import permutations

# 强制 UTF-8，避免 Windows 控制台默认 GBK 导致中文乱码
try:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

import sympy as sp

PROTOCOL_VERSION = 1
# 数值采样点数（与前端 EQUIV_SAMPLE_POINTS 一致）
EQUIV_SAMPLE_POINTS = 200
# 数值采样相对误差阈值
NUMERIC_EPS = 1e-9
# 纯数值答案的严格容差（只吸收浮点表示误差，不承担「估算」职责）
STRICT_NUMERIC_TOL = 1e-9
# 有效采样点下限（低于此数判定为 unknown，避免误判）
MIN_VALID_SAMPLES = 10

# 隐式乘法扫描器白名单：这些标识符内部绝不插入 *
# 函数名（后接括号即函数调用，如 sqrt(...)，不可拆）
# diff / Derivative 必须在内：撇号归一后会产出 diff(A(x), x)，
# 若不在白名单，diff 后的 ( 会被当成乘法，损坏语义。
# Abs 是 SymPy 解析/化简后输出的标准名称；必须与输入别名 abs 同属内置算子，
# 让隐式乘法、自动声明、函数声明及前提函数提取使用同一身份。
_IMPLICIT_MUL_FUNCS = (
    "sqrt", "sin", "cos", "tan", "exp", "log", "ln", "abs", "Abs",
    "diff", "Derivative", "integrate", "Integral", "Piecewise", "Matrix",
    "det", "transpose", "factorial", "limit", "Sum", "Product", "simplify", "solve",
)
# SymPy 内置常量名（必须整体保留，避免 pi 被拆成 p*i）
_IMPLICIT_MUL_CONSTS = ("pi", "E", "I", "oo")

# 完整标识符（字母/下划线开头，后接字母数字下划线）：用于区分「函数名」与「变量」
_IDENT_RE = re.compile(r"[A-Za-z_]\w*")
# 函数调用记法：标识符 + 可选空白 + 左括号（用于识别 A(x)、f(x,y)）
_FUNC_CALL_RE = re.compile(r"^([A-Za-z_]\w*)\s*\(")
# 函数「声明」记法（R1，用户规定）：名字 + ( 单个符号 [, 单个符号]* )
#
# 只有括号内是**单个符号**（如 x、x1）时才视为函数声明，这是为了区分：
#     f(x)     -> 函数声明
#     f(x, y)  -> 函数声明（多参数）
#     a(x+1)   -> 乘法（括号内是表达式，不是单个符号）
#
# 为什么必须加这条（实测确认的真实缺陷）：
#   此前判据只要求「未声明标识符 + 左括号」，导致用户写 `x+5=a(x+1)`
#   （本意 a 乘以 (x+1)）被误判为函数调用，解析成 `x+5=a(x+1)`。
# 单个符号的形态用 `[A-Za-z]\d*`（字母+可选数字下标），与 _SYM_TOKEN_RE 一致，
# 故 `x1`、`v0`、`y2` 都算单个符号，而 `x+1`、`2x` 不算。
# 注意：**不可加 `^` 锚定**（实测踩坑）—— _strip_implicit_mul 用
# `.match(s, i)` 带位置参数扫描，而 `^` 只匹配**字符串开头**而非 pos 位置，
# 会导致扫描到中间位置时本正则永不命中。实测后果：`A'(x)` 归一为
# `diff(A(x), x)` 后，中间的 `A` 未被识别为函数 → 产出 `diff(A*(x), x)`
# → sympy 立即求值得 `A`，撇号求导彻底失效。
_FUNC_DECL_RE = re.compile(
    r"([A-Za-z_]\w*)\s*\(\s*([A-Za-z]\d*(?:\s*,\s*[A-Za-z]\d*)*)\s*\)"
)
# 单符号模式：单个字母 + 可选数字下标（如 x、x1、v0）
_SYM_TOKEN_RE = re.compile(r"[A-Za-z]\d*")
# 数字模式（含小数）
_NUM_TOKEN_RE = re.compile(r"\d+(?:\.\d+)?")
# 单等号：前面不是 <>=!:，后面不是 =（排除 ==、>=、<=、!=、:=）
_EQ_SPLIT_RE = re.compile(r"(?<![<>=!:])=(?!=)")

# ---- 记法归一（块 A/D）：用户手写记法 → SymPy 可解析形式 ----

# 撇号导数记法：函数名 + 1~3 个撇号 + (单个自变量)
# 只接受「括号内是单一标识符」的形式，因为 A'(2*t) 存在歧义
# （是「在 2t 处求导后的值」还是「对 2t 求导」），不猜测，交 LLM 转译。
_DERIV_RE = re.compile(r"([A-Za-z_]\w*)\s*(['\u2032]{1,3})\s*\(\s*([A-Za-z_]\w*)\s*\)")
_BARE_PRIME_RE = re.compile(
    r"(?<![A-Za-z0-9_])([A-Za-z_]\w*)\s*('{1,3})(?!\s*\()"
)


def _normalize_bare_prime_derivatives(text, ctx):
    """把 ``y'`` / ``y''`` 补成带自变量的导数；歧义时显式返回缺失依赖。

    MathLive 允许省略 ``(x)``。优先使用函数签名，其次使用 ``y=body(x)``
    前提，最后仅在场景中只有一个其他变量时采用它，避免多变量场景猜测。
    """
    raw = str(text or "").translate(_PRIME_TRANS)
    missing = []

    def _replacement(match):
        name, primes = match.group(1), match.group(2)
        order = len(primes)

        # 普通变量形式的前提 y=body(x) 可以直接给出导数体。
        bodies = []
        for rel in (ctx.get("relations") or []):
            if not isinstance(rel, sp.Eq):
                continue
            for lhs, rhs in ((rel.lhs, rel.rhs), (rel.rhs, rel.lhs)):
                if not isinstance(lhs, sp.Symbol) or str(lhs) != name:
                    continue
                variables = sorted(
                    (s for s in getattr(rhs, "free_symbols", set()) if str(s) != name),
                    key=lambda s: s.name,
                )
                if len(variables) == 1:
                    bodies.append((rhs, variables[0]))
        if len(bodies) == 1:
            body, variable = bodies[0]
            if order == 1:
                return "Derivative((%s), %s)" % (sp.sstr(body), variable)
            return "Derivative((%s), (%s, %d))" % (
                sp.sstr(body), variable, order
            )

        params = list((ctx.get("funcParams") or {}).get(name) or [])
        if len(params) != 1:
            candidates = sorted(
                (str(v) for v in (ctx.get("varNames") or set()) if str(v) != name)
            )
            params = candidates if len(candidates) == 1 else []
        if len(params) != 1:
            missing.append(name)
            return match.group(0)

        variable = str(params[0])
        # ``y'`` 本身明确给出了函数语义；场景生成器常把 y 初始标成 variable，
        # 此处只在该导数表达式的局部上下文中提升为函数，不改写场景数据。
        if isinstance((ctx.get("locals") or {}).get(name), sp.Symbol):
            ctx["locals"][name] = sp.Function(name)
        ctx.setdefault("funcNames", set()).add(name)
        ctx.setdefault("funcParams", {})[name] = [variable]
        if order == 1:
            return "Derivative(%s(%s), %s)" % (name, variable, variable)
        return "Derivative(%s(%s), (%s, %d))" % (
            name, variable, variable, order
        )

    return _BARE_PRIME_RE.sub(_replacement, raw), (missing[0] if missing else None)

# ---- 微分记法（轮次 W）：dX / d(X) / dX/dY ----
#
# 用户场景（原话）：「u 和 h 是变量，前提 R 是常量，u=R+h，du=dh」。
# 数学含义：R 为常量 ⟹ dR = 0 ⟹ du = d(R+h) = dh。
#
# 为什么必须单独一组正则：`_strip_implicit_mul` 会把 `du` 拆成 `d*u`
# （`d` 被当变量），语义被破坏 —— 实测最严重的一例是
#   `du/dt=dh/dt` 被净化为 `t*u = h*t` → 化简得 **`u = h`**，
#   凭空得出「u 等于 h」这个错误结论（应当只说明两者导数相等）。
#
# 单个微分项：`d` + 单符号（du）或 `d` + 括号表达式（d(u+h)）。
# 负向后顾 `(?<![A-Za-z_])`：排除 `adx` 这类「d 紧跟在标识符后」的误匹配；
# **不可用 `\b`**：`2du` 里 `2` 与 `d` 之间不是词边界，会被漏掉（实测确认）。
# 负向前瞻 `(?!diff\b)`：排除白名单算子 `diff` 的首字母 d 被当作微分算子。
_DIFF_ATOM = (
    r"(?<![A-Za-z_])(?!diff\b)"
    r"d\s*(?:\(\s*([^()]+?)\s*\)|([A-Za-z]\d*))"
)
# 微分商：dX/dY（**必须先于** `_DIFF_TERM_RE` 处理，见 `_normalize_diff_text`）
_DIFF_QUOTIENT_RE = re.compile(
    _DIFF_ATOM + r"\s*/\s*" + _DIFF_ATOM
)
# 单个微分项：dX 或 d(expr)
_DIFF_TERM_RE = re.compile(_DIFF_ATOM)

# ---- 莱布尼茨导数算子（轮次 W）：d/dx(expr) / (d/dx)expr / dF/dx ----
#
# ## 为什么需要（vcalc2 探针 #1 / #2 / #5 实测确认）
#   三者语义都是「求导」，但 `_DIFF_ATOM` 只认「d + 单符号」或「d + 括号」，
#   于是标准写法全部走样：
#     `d/dx(x**2)`  → `d*x**2/d(x)`（`dx` 被当微分项，算子结构被拆散）
#     `(d/dx)x**2`  → 同样把 `dx` 当微分项，结构被拆散
#     `dF/dx`       → `Derivative(F, x)`（**丢掉 F 的自变量**）
#
# ①②：算子 + 操作数（括号形 / 前缀形）
_LEIBNIZ_PAREN_RE = re.compile(
    r"(?<![A-Za-z_])d\s*/\s*d\s*([A-Za-z]\d*)\s*\(([^()]*)\)"
)
_LEIBNIZ_PREFIX_RE = re.compile(
    r"\(\s*d\s*/\s*d\s*([A-Za-z]\d*)\s*\)\s*([^=]+?)\s*(?==|$)"
)
# ③：`dF/dx`（F 须为已声明函数，见 `_normalize_leibniz` 的说明）
_LEIBNIZ_FUNC_RE = re.compile(
    r"(?<![A-Za-z_])d\s*([A-Za-z_]\w*)\s*/\s*d\s*([A-Za-z]\d*)"
)
_BARE_DERIVATIVE_RE = re.compile(
    r"\b(?:Derivative|diff)\s*\(\s*([A-Za-z_]\w*)\s*,\s*(?:\(\s*)?([A-Za-z_]\w*)"
)


def _missing_derivative_dependency(text, function_params):
    """返回缺少函数签名的 ``Derivative(y, x)``，避免把它求值成 0。"""
    params = function_params or {}
    for m in _BARE_DERIVATIVE_RE.finditer(str(text or "")):
        dependent, variable = m.group(1), m.group(2)
        if not params.get(dependent):
            return dependent, variable
    return None


def _resolve_bare_derivative_from_relations(text, ctx):
    """用 ``y=表达式(x)`` 前提补全一阶 ``Derivative(y,x)``。"""
    missing = _missing_derivative_dependency(text, ctx.get("funcParams"))
    if missing is None:
        return text, None
    dependent, variable = missing
    bodies = []
    for rel in (ctx.get("relations") or []):
        if not isinstance(rel, sp.Eq):
            continue
        for lhs, rhs in ((rel.lhs, rel.rhs), (rel.rhs, rel.lhs)):
            if not isinstance(lhs, sp.Symbol) or str(lhs) != dependent:
                continue
            names = {str(s) for s in getattr(rhs, "free_symbols", set())}
            if variable in names and dependent not in names:
                bodies.append(rhs)
    if len(bodies) != 1:
        return text, missing
    pattern = re.compile(
        r"\b(?:Derivative|diff)\s*\(\s*"
        + re.escape(dependent)
        + r"\s*,\s*"
        + re.escape(variable)
        + r"\s*\)"
    )
    resolved = pattern.sub(
        "Derivative((%s), %s)" % (sp.sstr(bodies[0]), variable), str(text or "")
    )
    return resolved, (None if resolved != text else missing)


def _judge_explicit_derivative_text(text, ctx):
    """在 SymPy 消去 Derivative 之前判定显式可求值的一阶导数等式。"""
    raw = str(text or "")
    if "Derivative(" not in raw and "diff(" not in raw:
        return None
    segments = _split_chain(raw)
    if not segments or len(segments) != 2:
        return None
    try:
        lhs = sp.sympify(segments[0].strip(), locals=ctx["locals"])
        rhs = sp.sympify(segments[1].strip(), locals=ctx["locals"])
        if lhs.atoms(_AppliedUndef) or rhs.atoms(_AppliedUndef):
            return None
        residual = sp.simplify(lhs.doit() - rhs.doit())
        if residual == 0:
            return {
                "legit": "legit",
                "code": "explicit_derivative_identity",
                "detail": "求导后两侧恒等",
            }
        variables = sorted(residual.free_symbols, key=lambda s: s.name)
        solutions = sp.solve(sp.Eq(residual, 0), variables, dict=True) if variables else []
        if solutions:
            return {
                "legit": "legit",
                "code": "explicit_derivative_solvable",
                "detail": "求导后等式仅在特定取值下成立，非恒等式",
            }
        return {
            "legit": "illegal",
            "code": "explicit_derivative_mismatch",
            "detail": "求导后两侧不相等",
        }
    except Exception:  # noqa: BLE001
        return None


def _normalize_leibniz(text, func_names=None):
    """莱布尼茨导数算子记法 → `Derivative(...)`（轮次 W 新增）。

    三种形态按序归一（互不干扰，已逐一实测）：

      ① `d/dx(expr)`  → `Derivative(expr, x)`  （算子 + 括号操作数）
      ② `(d/dx)expr`  → `Derivative(expr, x)`  （算子整体加括号）
      ③ `dF/dx`       → `Derivative(F(x), x)`  （F 须是**已声明函数**）

    ## 为什么 ③ 必须限定「已声明函数」
      `dy/dx` 里 y 是**普通变量**，语义是「微分 dy 除以 dx」，而非
      「函数 y 的导数」—— 后者由 `_normalize_diff_text` 的既有通道处理
      （→ `Derivative(y, x)`）。若不加限定，`dy/dx` 会被误写成
      `Derivative(y(x), x)`（凭空多出一个自变量），
      破坏既有的微分等式链（`du=dh`，见 `_judge_differential_step`）。

    ## 为什么 ② 的操作数取到 `=` 或行尾
      课本写法 `(d/dx)x**2=2*x` 中，算子只作用于**等号左侧**整段
      （`x**2`），右侧是结论 —— 故以顶层 `=` 为界切分。

    ## 调用位置（`_normalize_notation` 内）
      **必须在 `_normalize_diff_text` 之前** —— 否则 `d/dx` 里的 `dx`
      会先被当作微分项拆成 `d(x)`，算子结构不可恢复（探针 #1/#2 实测）。
    """
    if not isinstance(text, str) or "d" not in text:
        return text

    # ① d/dx(expr)
    def _paren_repl(m):
        return "Derivative(%s, %s)" % ((m.group(2) or "").strip(), m.group(1))

    try:
        text = _LEIBNIZ_PAREN_RE.sub(_paren_repl, text)
    except Exception:  # noqa: BLE001
        pass

    # ② (d/dx)expr
    def _prefix_repl(m):
        return "Derivative(%s, %s)" % ((m.group(2) or "").strip(), m.group(1))

    try:
        text = _LEIBNIZ_PREFIX_RE.sub(_prefix_repl, text)
    except Exception:  # noqa: BLE001
        pass

    # ③ dF/dx（**仅当 F 是已声明函数**；普通变量交既有微分通道）
    if func_names:
        _fset = set(func_names)

        def _func_repl(m):
            _nm, _var = m.group(1), m.group(2)
            if _nm not in _fset:
                return m.group(0)
            return "Derivative(%s(%s), %s)" % (_nm, _var, _var)

        try:
            text = _LEIBNIZ_FUNC_RE.sub(_func_repl, text)
        except Exception:  # noqa: BLE001
            pass

    return text

# 各种撇号字符 → 统一为半角 '
_PRIME_TRANS = str.maketrans({"\u2032": "'", "\u2019": "'", "\u2018": "'", "\u02b9": "'"})

# 全角括号/方括号 → 半角（轮次 F）
#
# 为什么需要：用户在中文输入法下写 `V'（x）`，括号是全角 U+FF08/U+FF09。
# `_DERIV_RE` 只匹配半角括号，撇号因而被原样保留：
#   `V'（x）` → sympify 抛 `TokenError: unterminated string literal`（实测确认）
# 归一为半角后，撇号导数识别链即可正常工作。
_FULLWIDTH_PAREN_TRANS = str.maketrans({
    "\uff08": "(",   # （
    "\uff09": ")",   # ）
    "\u3010": "[",   # 【
    "\u3011": "]",   # 】
})

# LaTeX \left( ... \right) → ( ... )（轮次 F）
# MathLive / LaTeX 源文本可能带 \left \right 修饰，sympify 无法解析。
_LATEX_LEFT_RIGHT_RE = re.compile(r"\\(?:left|right)\s*([.()\[\]|])")

# 幂运算符：^ → **（但要避开已有的 **，避免 ** 被加成 ***）
_CARET_RE = re.compile(r"(?<!\*)\^(?!\*)")

# 中文/全角单位串（出现在末尾时剥离）。范围涵盖 CJK 与常见全角符号。
_CJK_UNIT_RE = re.compile(r"\s*\*?\s*([\u4e00-\u9fff][\u4e00-\u9fff\u00b7\u3001\uff08\uff09]*)\s*$")

# ---- LaTeX 特征判据（轮次 W 抽成共享函数，两处共用）----
#
# ## 为什么必须抽成函数（避免「同一口径两处实现」）
#   原为 `_to_diff` 内联的 4 个条件；轮次 W 要给 `_sympify_relation`
#   **也**接上 LaTeX 通道（见 `_latex_pre_normalize` 的说明）。
#   两处若各写一份，将来新增判据时必然漏改一处 —— 与
#   `_is_function_notation` 同类的隐患。故抽成本函数。
#
# 四条判据（满足任一即视为 LaTeX）：
#   `\\`  —— LaTeX 必含反斜杠（\frac / \sqrt / \pi / \left / \prime …）
#   `|`   —— 绝对值 `|x|` 是 LaTeX 语法，sympify 无法解析
#   `^{`  —— MathLive 上标（`x^{2}`），sympify 会把 `{2}` 当 set
#   `_{`  —— MathLive 下标（`m_{0}`），同上
#
# 四条都**不会**误触发 Python 语法：`|` 在 Python 里是位运算符、
# `^{` / `_{` 不是 Python 的合法运算符组合，数学表达式中均不会出现。
def _has_latex_markers(text):
    """该文本是否含 LaTeX 特征（供 LaTeX 优先通道判据共用）。"""
    if not isinstance(text, str) or not text:
        return False
    return ("\\" in text) or ("|" in text) or ("^{" in text) or ("_{" in text)


def _unsupported_latex_structure(text):
    """识别当前标量前提引擎尚未覆盖的 MathLive 结构。"""
    raw = str(text or "")
    if re.search(r"\\begin\s*\{(?:p|b|B|v|V)?matrix\}", raw):
        return "已识别为矩阵或向量等式，但当前判定引擎尚不支持分量级验证"
    return None


_MATRIX_RE = re.compile(
    r"\\begin\s*\{([pbBvV]?matrix)\}([\s\S]*?)\\end\s*\{\1\}"
)
_MATRIX_TRANSPOSE_RE = re.compile(
    r"\b([A-Za-z_]\w*)\s*\^\s*\{\s*(?:T|\\(?:mathsf|mathrm)\s*\{T\})\s*\}"
)
_MATRIX_INVERSE_RE = re.compile(
    r"\b([A-Za-z_]\w*)\s*\^\s*\{\s*-\s*1\s*\}"
)
_MATRIX_POWER_RE = re.compile(r"\^\s*\{\s*(-?\d+)\s*\}")
_MATRIX_DECORATED_NAME_RE = re.compile(
    r"\\(?:vec|mathbf|boldsymbol)\s*\{\s*([A-Za-z_]\w*)\s*\}"
)
_MATRIX_ENTRY_RE = re.compile(
    r"\b([A-Za-z_]\w*)_\{\s*(\d+)(?:\s*,\s*(\d+))?\s*\}"
)
_LIMIT_EXPR_RE = re.compile(
    r"^\\lim(?:\s*\\limits)?\s*_\{\s*([A-Za-z_]\w*)\s*\\to\s*([^{}]+)\}\s*(.+)$",
    re.DOTALL,
)
_SUM_PRODUCT_RE = re.compile(
    r"^\\(sum|prod)(?:\s*\\limits)?\s*_\{\s*([A-Za-z_]\w*)\s*=\s*([^{}]+)\}"
    r"\s*\^\{\s*([^{}]+)\}\s*(.+)$",
    re.DOTALL,
)
_FACTORIAL_RE = re.compile(r"(?<![A-Za-z0-9_])([A-Za-z_]\w*|\d+)\s*!")


def _looks_like_advanced_math(text):
    raw = str(text or "")
    return bool(
        re.search(
            r"\\(?:lim|sum|prod|nabla|Delta|chi|overline|bar)(?![A-Za-z])"
            r"|\\operatorname\s*\{(?:grad|div|curl|Hess|Jacobian|Laplacian|tr|rank|charpoly|Taylor|Maclaurin|Re|Im|arg|conj|mod|D)\}",
            raw,
            re.IGNORECASE,
        )
        or re.search(r"\\(?:lvert|rvert)(?![A-Za-z])", raw)
        or re.search(r"(?:^|[^A-Za-z0-9_])D_\s*\{?", raw)
        or re.search(r"(?<![A-Za-z0-9_])[HJ]_\{?[A-Za-z_]\w*\}?", raw)
    )


def _normalize_matrix_latex(text):
    """MathLive matrix 环境 -> SymPy ``Matrix`` 表达式。

    ``vmatrix`` 按行列式处理；``Vmatrix`` 仅在后续确认为向量时
    按欧几里得范数处理。
    """
    raw = str(text or "").strip()
    if not _MATRIX_RE.search(raw):
        return None, raw, None

    while True:
        match = _MATRIX_RE.search(raw)
        if not match:
            break
        env, body = match.group(1), match.group(2)
        if _MATRIX_RE.search(body):
            return None, raw, "暂不支持嵌套矩阵"
        rows = [row.strip() for row in re.split(r"\\\\|\\cr\b", body) if row.strip()]
        cells = [[cell.strip() for cell in row.split("&")] for row in rows]
        if not cells or not cells[0] or any(not cell for row in cells for cell in row):
            return None, raw, "矩阵中存在空元素"
        width = len(cells[0])
        if any(len(row) != width for row in cells):
            return None, raw, "矩阵每一行的列数必须相同"
        normalized_rows = []
        for row in cells:
            normalized_cells = []
            for cell in row:
                cell_text = _latex_pre_normalize(cell)
                cell_text = re.sub(
                    r"(?<=[A-Za-z0-9_)])\s+(?=[A-Za-z_(])", "*", cell_text
                )
                normalized_cells.append(cell_text)
            normalized_rows.append("[" + ",".join(normalized_cells) + "]")
        matrix = "Matrix([" + ",".join(normalized_rows) + "])"
        if env == "vmatrix":
            replacement = "__matrix_det__(" + matrix + ")"
        elif env == "Vmatrix":
            replacement = "__vector_norm__(" + matrix + ")"
        else:
            replacement = matrix
        raw = raw[:match.start()] + replacement + raw[match.end():]
    return "matrix", raw, None


def _split_top_level_token(text, token):
    """按顶层 LaTeX 运算符切一次，不切 Matrix 的括号/列表内部。"""
    depth = 0
    index = 0
    while index <= len(text) - len(token):
        char = text[index]
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth = max(0, depth - 1)
        if depth == 0 and text.startswith(token, index):
            return text[:index].strip(), text[index + len(token):].strip()
        index += 1
    return None


def _split_structured_equation(text):
    """切顶层单等号，避开 ``sum_{k=1}`` 这类算子下标。"""
    depth = 0
    hits = []
    for index, char in enumerate(str(text or "")):
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth = max(0, depth - 1)
        elif char == "=" and depth == 0:
            before = text[index - 1] if index else ""
            after = text[index + 1] if index + 1 < len(text) else ""
            if before not in "<>=!" and after != "=":
                hits.append(index)
    if len(hits) != 1:
        return None
    index = hits[0]
    return [text[:index].strip(), text[index + 1:].strip()]


def _matrix_vector_entries(value):
    if not isinstance(value, sp.MatrixBase) or (value.rows != 1 and value.cols != 1):
        return None
    return list(value)


def _matrix_determinant(value):
    if not isinstance(value, sp.MatrixBase):
        raise ValueError("行列式的对象必须是矩阵")
    if value.rows != value.cols:
        raise ValueError("只有方阵才能计算行列式")
    return sp.simplify(value.det())


def _matrix_vector_norm(value):
    entries = _matrix_vector_entries(value)
    if entries is None:
        raise ValueError("未标明范数类型时，双竖线只支持行向量或列向量")
    return sp.sqrt(sp.simplify(sum(sp.conjugate(item) * item for item in entries)))


def _matrix_typed_norm(value, norm_type):
    if not isinstance(value, sp.MatrixBase):
        raise ValueError("范数的对象必须是矩阵或向量")
    kind = str(norm_type or "").strip()
    if kind == "F":
        return sp.sqrt(sp.simplify(sum(
            sp.conjugate(item) * item for item in value
        )))
    if kind == "1":
        return sp.Max(*[
            sp.simplify(sum(sp.Abs(value[row, col]) for row in range(value.rows)))
            for col in range(value.cols)
        ])
    if kind == r"\infty":
        return sp.Max(*[
            sp.simplify(sum(sp.Abs(value[row, col]) for col in range(value.cols)))
            for row in range(value.rows)
        ])
    raise ValueError("当前只支持 Frobenius、1 和无穷矩阵范数")


def _unwrap_matrix_call(text, name):
    prefix = name + "("
    if not text.startswith(prefix) or not text.endswith(")"):
        return None
    depth = 0
    for index, char in enumerate(text[len(name):], start=len(name)):
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0 and index != len(text) - 1:
                return None
    return text[len(prefix):-1] if depth == 0 else None


def _replace_matrix_entries(text, matrix_defs):
    """将 A_{1,2} / v_{2} 换成已知矩阵或向量的对应元素（1 起始）。"""
    def replace(match):
        name, first, second = match.group(1), match.group(2), match.group(3)
        value = (matrix_defs or {}).get(name)
        if not isinstance(value, sp.MatrixBase):
            return match.group(0)
        row = int(first)
        if second is not None:
            col = int(second)
            if row < 1 or col < 1 or row > value.rows or col > value.cols:
                raise ValueError("矩阵 %s 的下标 (%d,%d) 越界" % (name, row, col))
            return "(" + sp.sstr(value[row - 1, col - 1]) + ")"
        entries = _matrix_vector_entries(value)
        if entries is None:
            raise ValueError("非向量矩阵 %s 必须写两个下标，如 %s_{1,2}" % (name, name))
        if row < 1 or row > len(entries):
            raise ValueError("向量 %s 的下标 %d 越界" % (name, row))
        return "(" + sp.sstr(entries[row - 1]) + ")"

    return _MATRIX_ENTRY_RE.sub(replace, text)


def _advanced_function_defs(ctx):
    out = dict(ctx.get("functionDefs") or {})
    out.update(_func_body_defs_from_relations(
        ctx.get("relations") or [], ctx.get("funcNames") or set()
    ))
    return out


def _advanced_named_function(name, ctx):
    definition = _advanced_function_defs(ctx).get(name)
    if not definition:
        raise ValueError("函数 %s 尚未通过已连接前提定义" % name)
    params = list(definition.get("params") or [])
    body = definition.get("body")
    if body is None:
        raise ValueError("函数 %s 缺少可计算的函数体" % name)
    return params, body


def _advanced_vector_field(name, ctx, matrix_defs):
    value = (matrix_defs or {}).get(name)
    entries = _matrix_vector_entries(value)
    if entries is None:
        raise ValueError("向量场 %s 尚未通过已连接前提定义" % name)
    symbols = sorted(
        set().union(*(getattr(item, "free_symbols", set()) for item in entries)),
        key=lambda symbol: symbol.name,
    )
    if len(symbols) != len(entries):
        raise ValueError("向量场的分量数必须与坐标变量数一致")
    # ponytail: 裸矩阵定义没有形参顺序，暂按变量名排序；
    # 后续支持“向量值函数签名”后应改用显式 params。
    return symbols, entries


def _normalize_bound(text, ctx, matrix_defs):
    raw = str(text or "").strip()
    raw = raw.replace(r"\infty", "oo")
    value, _ = _eval_matrix_expression(raw, ctx, matrix_defs)
    if isinstance(value, sp.MatrixBase):
        raise ValueError("边界必须是标量")
    return value


def _advanced_scalar_substitute(value, ctx):
    substitutions = {}
    for relation in (ctx.get("relations") or []):
        if not isinstance(relation, sp.Eq):
            continue
        for symbol, other in (
            (relation.lhs, relation.rhs), (relation.rhs, relation.lhs),
        ):
            if not isinstance(symbol, sp.Symbol) or isinstance(other, sp.MatrixBase):
                continue
            try:
                if other.has(sp.Derivative, sp.Integral) or other.atoms(_AppliedUndef):
                    continue
            except Exception:  # noqa: BLE001
                continue
            substitutions.setdefault(symbol, other)
    out = value
    for _ in range(len(substitutions) + 1):
        replaced = out.subs(substitutions, simultaneous=True)
        if replaced == out:
            break
        out = replaced
    return sp.simplify(out)


def _eval_advanced_expression(text, ctx, matrix_defs):
    """返回 ``(matched, value)``；只处理整个式子就是高级算子的情形。"""
    raw = str(text or "").strip()

    match = _LIMIT_EXPR_RE.fullmatch(raw)
    if match:
        variable_name, target_raw, body_raw = match.groups()
        direction = "+-"
        direction_match = re.search(r"\^\s*\{?\s*([+-])\s*\}?\s*$", target_raw)
        if direction_match:
            direction = direction_match.group(1)
            target_raw = target_raw[:direction_match.start()].strip()
        variable = sp.Symbol(variable_name, real=True)
        local_ctx = dict(ctx)
        local_ctx["locals"] = dict(ctx.get("locals") or {})
        local_ctx["locals"][variable_name] = variable
        body, _ = _eval_matrix_expression(body_raw, local_ctx, matrix_defs)
        target = _normalize_bound(target_raw, local_ctx, matrix_defs)
        if isinstance(body, sp.MatrixBase):
            return True, body.applyfunc(lambda item: sp.limit(item, variable, target, dir=direction))
        return True, sp.limit(body, variable, target, dir=direction)

    match = _SUM_PRODUCT_RE.fullmatch(raw)
    if match:
        operator, variable_name, lower_raw, upper_raw, body_raw = match.groups()
        variable = sp.Symbol(variable_name, integer=True)
        local_ctx = dict(ctx)
        local_ctx["locals"] = dict(ctx.get("locals") or {})
        local_ctx["locals"][variable_name] = variable
        body_text = body_raw.strip()
        if body_text.startswith("{") and body_text.endswith("}"):
            depth = 0
            closes_at_end = False
            for index, char in enumerate(body_text):
                if char == "{":
                    depth += 1
                elif char == "}":
                    depth -= 1
                    if depth == 0:
                        closes_at_end = index == len(body_text) - 1
                        break
            if closes_at_end:
                body_text = body_text[1:-1].strip()
        body, _ = _eval_matrix_expression(body_text, local_ctx, matrix_defs)
        lower = _normalize_bound(lower_raw, local_ctx, matrix_defs)
        upper = _normalize_bound(upper_raw, local_ctx, matrix_defs)
        function = sp.summation if operator == "sum" else sp.product
        if isinstance(body, sp.MatrixBase):
            return True, body.applyfunc(lambda item: function(item, (variable, lower, upper)))
        return True, function(body, (variable, lower, upper))

    compact = re.sub(r"\s+", "", raw)
    compact = re.sub(r"\\operatorname\{grad\}", r"\\nabla", compact, flags=re.IGNORECASE)
    compact = re.sub(r"\\operatorname\{div\}", r"\\nabla\\cdot", compact, flags=re.IGNORECASE)
    compact = re.sub(r"\\operatorname\{curl\}", r"\\nabla\\times", compact, flags=re.IGNORECASE)

    complex_call = re.fullmatch(
        r"\\operatorname\{(Re|Im|arg|conj|mod)\}\((.+)\)",
        compact,
        re.IGNORECASE,
    )
    complex_bar = re.fullmatch(r"\\(?:overline|bar)\{(.+)\}", compact)
    complex_abs = re.fullmatch(r"\\lvert(.+)\\rvert", compact)
    if complex_call or complex_bar or complex_abs:
        if complex_call:
            operator, operand_raw = complex_call.groups()
            operator = operator.lower()
        elif complex_bar:
            operator, operand_raw = "conj", complex_bar.group(1)
        else:
            operator, operand_raw = "mod", complex_abs.group(1)
        value, _ = _eval_matrix_expression(operand_raw, ctx, matrix_defs)
        if isinstance(value, sp.MatrixBase):
            raise ValueError("复数算子的对象必须是标量")
        value = _advanced_scalar_substitute(value, ctx)
        operations = {
            "re": sp.re,
            "im": sp.im,
            "arg": sp.arg,
            "conj": sp.conjugate,
            "mod": sp.Abs,
        }
        return True, sp.simplify(operations[operator](value))

    charpoly = re.fullmatch(
        r"\\operatorname\{charpoly\}_\{?([A-Za-z_]\w*)\}?\((.+)\)",
        compact,
        re.IGNORECASE,
    )
    charpoly = charpoly or re.fullmatch(
        r"\\chi_\{?([A-Za-z_]\w*)\}?\(([A-Za-z_]\w*)\)", compact
    )
    if charpoly:
        if compact.lower().startswith(r"\operatorname{charpoly}"):
            variable_name, matrix_text = charpoly.groups()
        else:
            matrix_text, variable_name = charpoly.groups()
        value, _ = _eval_matrix_expression(matrix_text, ctx, matrix_defs)
        if not isinstance(value, sp.MatrixBase):
            raise ValueError("特征多项式的对象必须是矩阵")
        if value.rows != value.cols:
            raise ValueError("只有方阵才能计算特征多项式")
        variable = (ctx.get("locals") or {}).get(variable_name)
        if not isinstance(variable, sp.Symbol):
            variable = sp.Symbol(variable_name)
        polynomial = sp.expand(value.charpoly(variable).as_expr())
        polynomial = polynomial.xreplace({
            symbol: variable
            for symbol in polynomial.free_symbols
            if symbol.name == variable_name and symbol != variable
        })
        return True, polynomial

    taylor = re.fullmatch(
        r"\\operatorname\{Taylor\}_\{([A-Za-z_]\w*)=([^{}]+)\}"
        r"\^\{(\d+)\}\(([A-Za-z_]\w*)\)",
        compact,
        re.IGNORECASE,
    )
    maclaurin = re.fullmatch(
        r"\\operatorname\{Maclaurin\}_\{?(\d+)\}?\(([A-Za-z_]\w*)\)",
        compact,
        re.IGNORECASE,
    )
    if taylor or maclaurin:
        if taylor:
            variable_name, point_raw, order_raw, function_name = taylor.groups()
        else:
            order_raw, function_name = maclaurin.groups()
            params, _ = _advanced_named_function(function_name, ctx)
            if len(params) != 1:
                raise ValueError("Maclaurin 展开只支持一元函数")
            variable_name = params[0].name
            point_raw = "0"
        params, body = _advanced_named_function(function_name, ctx)
        if len(params) != 1 or params[0].name != variable_name:
            raise ValueError("Taylor 展开变量必须与一元函数参数一致")
        point = _normalize_bound(point_raw, ctx, matrix_defs)
        if isinstance(point, sp.MatrixBase):
            raise ValueError("Taylor 展开点必须是标量")
        order = int(order_raw)
        return True, sp.expand(
            sp.series(body, params[0], point, order + 1).removeO()
        )

    match = re.fullmatch(r"\\operatorname\{(tr|rank)\}\((.+)\)", compact, re.IGNORECASE)
    if match:
        value, _ = _eval_matrix_expression(match.group(2), ctx, matrix_defs)
        if not isinstance(value, sp.MatrixBase):
            raise ValueError("%s 的对象必须是矩阵" % match.group(1))
        if match.group(1).lower() == "tr":
            if value.rows != value.cols:
                raise ValueError("只有方阵才能计算迹")
            return True, sp.simplify(value.trace())
        return True, sp.Integer(value.rank())

    match = re.fullmatch(r"\\nabla\\cdot([A-Za-z_]\w*)", compact)
    if match:
        variables, entries = _advanced_vector_field(match.group(1), ctx, matrix_defs)
        return True, sp.simplify(sum(sp.diff(item, variable) for item, variable in zip(entries, variables)))

    match = re.fullmatch(r"\\nabla\\times([A-Za-z_]\w*)", compact)
    if match:
        variables, entries = _advanced_vector_field(match.group(1), ctx, matrix_defs)
        if len(entries) != 3:
            raise ValueError("旋度只支持三维向量场")
        x, y, z = variables
        p, q, r = entries
        return True, sp.Matrix([
            sp.diff(r, y) - sp.diff(q, z),
            sp.diff(p, z) - sp.diff(r, x),
            sp.diff(q, x) - sp.diff(p, y),
        ])

    match = re.fullmatch(r"\\nabla(?:([A-Za-z_]\w*)\([^)]*\)|([A-Za-z_]\w*))", compact)
    if match:
        name = match.group(1) or match.group(2)
        params, body = _advanced_named_function(name, ctx)
        return True, sp.Matrix([sp.diff(body, variable) for variable in params])

    laplacian = re.fullmatch(r"(?:\\Delta|\\nabla\^\{?2\}?)([A-Za-z_]\w*)", compact)
    laplacian = laplacian or re.fullmatch(
        r"\\operatorname\{Laplacian\}\(([^)]+)\)", compact, re.IGNORECASE
    )
    if laplacian:
        params, body = _advanced_named_function(laplacian.group(1), ctx)
        return True, sp.simplify(sum(sp.diff(body, variable, 2) for variable in params))

    directional = re.fullmatch(
        r"(?:D|\\operatorname\{D\})_\{?([A-Za-z_]\w*)\}?([A-Za-z_]\w*)",
        compact,
        re.IGNORECASE,
    )
    if directional:
        vector_name, function_name = directional.groups()
        params, body = _advanced_named_function(function_name, ctx)
        entries = _matrix_vector_entries((matrix_defs or {}).get(vector_name))
        if entries is None:
            raise ValueError("方向向量 %s 尚未通过已连接前提定义" % vector_name)
        if len(entries) != len(params):
            raise ValueError("方向向量维数必须与函数自变量个数一致")
        return True, sp.simplify(sum(
            entry * sp.diff(body, variable)
            for entry, variable in zip(entries, params)
        ))

    hessian = re.fullmatch(r"H_?\{?([A-Za-z_]\w*)\}?", compact)
    hessian = hessian or re.fullmatch(r"\\operatorname\{Hess\}\(([^)]+)\)", compact, re.IGNORECASE)
    if hessian:
        params, body = _advanced_named_function(hessian.group(1), ctx)
        return True, sp.hessian(body, params)

    jacobian = re.fullmatch(r"J_?\{?([A-Za-z_]\w*)\}?", compact)
    jacobian = jacobian or re.fullmatch(r"\\operatorname\{Jacobian\}\(([^)]+)\)", compact, re.IGNORECASE)
    if jacobian:
        variables, entries = _advanced_vector_field(jacobian.group(1), ctx, matrix_defs)
        return True, sp.Matrix(entries).jacobian(variables)

    return False, None


def _eval_matrix_expression(text, ctx, matrix_defs=None):
    """解析含矩阵字面量/已连接矩阵定义的表达式。"""
    kind, normalized, error = _normalize_matrix_latex(text)
    if error:
        raise ValueError(error)
    normalized = re.sub(r"\\(?:left|right)\s*", "", normalized).strip()
    decorated_names = _MATRIX_DECORATED_NAME_RE.findall(normalized)
    missing_vectors = [name for name in decorated_names if name not in (matrix_defs or {})]
    if missing_vectors:
        raise ValueError("向量 %s 尚未通过已连接前提定义" % "、".join(missing_vectors))
    normalized = _MATRIX_DECORATED_NAME_RE.sub(r"\1", normalized)
    advanced_matched, advanced_value = _eval_advanced_expression(
        normalized, ctx, matrix_defs or {}
    )
    if advanced_matched:
        return advanced_value, normalized
    normalized = _MATRIX_TRANSPOSE_RE.sub(r"transpose(\1)", normalized)
    normalized = _MATRIX_INVERSE_RE.sub(r"\1**(-1)", normalized)
    normalized = _MATRIX_POWER_RE.sub(r"**(\1)", normalized)
    normalized = _replace_matrix_entries(normalized, matrix_defs or {})
    for name in (matrix_defs or {}):
        if re.search(r"\b" + re.escape(name) + r"_\{", normalized):
            raise ValueError("矩阵下标必须是明确的正整数；矩阵用 A_{1,2}，向量用 v_{2}")

    determinant_body = _unwrap_matrix_call(normalized, "__matrix_det__")
    if determinant_body is not None:
        value, _ = _eval_matrix_expression(determinant_body, ctx, matrix_defs)
        return _matrix_determinant(value), normalized
    norm_body = _unwrap_matrix_call(normalized, "__vector_norm__")
    if norm_body is not None:
        value, _ = _eval_matrix_expression(norm_body, ctx, matrix_defs)
        return _matrix_vector_norm(value), normalized

    if normalized.startswith(r"\det"):
        body = normalized[len(r"\det"):].strip()
        if body.startswith("(") and body.endswith(")"):
            body = body[1:-1].strip()
        if not body:
            raise ValueError("det 后缺少矩阵")
        value, _ = _eval_matrix_expression(body, ctx, matrix_defs)
        return _matrix_determinant(value), normalized
    determinant_body = _unwrap_matrix_call(normalized, "det")
    if determinant_body is not None:
        value, _ = _eval_matrix_expression(determinant_body, ctx, matrix_defs)
        return _matrix_determinant(value), normalized

    typed_norm = re.fullmatch(
        r"\\(?:lVert|Vert|\|)(.+)\\(?:rVert|Vert|\|)_\{?(F|1|\\infty)\}?",
        normalized,
    )
    if typed_norm:
        value, _ = _eval_matrix_expression(typed_norm.group(1).strip(), ctx, matrix_defs)
        return _matrix_typed_norm(value, typed_norm.group(2)), normalized

    for left_mark, right_mark in (
        (r"\lVert", r"\rVert"), (r"\Vert", r"\Vert"), (r"\|", r"\|"),
    ):
        if normalized.startswith(left_mark) and normalized.endswith(right_mark):
            body = normalized[len(left_mark):-len(right_mark)].strip()
            value, _ = _eval_matrix_expression(body, ctx, matrix_defs)
            return _matrix_vector_norm(value), normalized

    for operator in (r"\cdot", r"\times"):
        split = _split_top_level_token(normalized, operator)
        if split is None:
            continue
        left, _ = _eval_matrix_expression(split[0], ctx, matrix_defs)
        right, _ = _eval_matrix_expression(split[1], ctx, matrix_defs)
        left_vector = _matrix_vector_entries(left)
        right_vector = _matrix_vector_entries(right)
        if left_vector is not None and right_vector is not None:
            if len(left_vector) != len(right_vector):
                raise ValueError("向量维度不一致")
            if operator == r"\cdot":
                return sp.simplify(sum(a * b for a, b in zip(left_vector, right_vector))), normalized
            if len(left_vector) != 3:
                raise ValueError("叉积只支持三维向量")
            return sp.Matrix(left_vector).cross(sp.Matrix(right_vector)), normalized
        try:
            return left * right, normalized
        except Exception as exc:  # noqa: BLE001
            raise ValueError("矩阵乘法维度不匹配") from exc

    normalized = normalized.replace(r"\cdot", "*").replace(r"\times", "*")
    normalized = _FACTORIAL_RE.sub(r"factorial(\1)", normalized)
    if kind is None:
        normalized = _latex_pre_normalize(normalized)
    local_map = dict(ctx.get("locals") or {})
    local_map.update(matrix_defs or {})
    local_map.update({"Matrix": sp.Matrix, "det": sp.det, "transpose": sp.transpose})
    names = list(local_map.keys())
    normalized = _normalize_notation(normalized, None, _function_names_of(local_map))
    normalized = _strip_implicit_mul(
        normalized, names, tuple(_IMPLICIT_MUL_FUNCS), None
    )
    return sp.sympify(normalized, locals=local_map), normalized


def _matrix_equation_sides(raw, ctx, matrix_defs=None):
    """返回矩阵等式两侧；当且仅当原文含矩阵环境时接管。"""
    kind, normalized, error = _normalize_matrix_latex(raw)
    if (
        kind is None
        and not _contains_matrix_name(raw, matrix_defs or {})
        and not _looks_like_advanced_math(raw)
    ):
        return None, None, None, error
    if error:
        return None, None, None, error
    segments = _split_structured_equation(normalized)
    if not segments or len(segments) != 2:
        label = "结构化运算" if _looks_like_advanced_math(raw) else "矩阵"
        return None, None, None, label + "节点必须写成一个等式"
    try:
        left, _ = _eval_matrix_expression(segments[0], ctx, matrix_defs)
        right, _ = _eval_matrix_expression(segments[1], ctx, matrix_defs)
    except Exception as exc:  # noqa: BLE001
        label = "结构化运算" if _looks_like_advanced_math(raw) else "矩阵表达式"
        return None, None, None, label + "无法解析：" + str(exc)
    return normalized, left, right, None


def _contains_matrix_name(text, matrix_defs):
    names = sorted((matrix_defs or {}).keys(), key=len, reverse=True)
    if not names:
        return False
    raw = str(text or "")
    if any(
        re.search(r"(?<![A-Za-z0-9_])" + re.escape(name) + r"_\{", raw)
        for name in names
    ):
        return True
    for token in _IDENT_RE.findall(raw):
        if token in matrix_defs:
            return True
        # MathLive 常把 AB 保留为连写；仅在整个标识符能由
        # 已知矩阵名完整切分时，才把它视为矩阵乘积。
        reachable = {0}
        for index in range(len(token)):
            if index not in reachable:
                continue
            for name in names:
                if token.startswith(name, index):
                    reachable.add(index + len(name))
        if len(token) in reachable:
            return True
    return False


def _matrix_definition_shape(raw):
    """返回 ``(name, body)``，仅识别裸标识符一侧的矩阵定义。"""
    _kind, normalized, error = _normalize_matrix_latex(raw)
    if error:
        return None, None
    segments = _split_structured_equation(normalized)
    if not segments or len(segments) != 2:
        return None, None
    left, right = (part.strip() for part in segments)
    if _IDENT_RE.fullmatch(left):
        return left, right
    if _IDENT_RE.fullmatch(right):
        return right, left
    return None, None


def _matrix_premise_context(items, ctx):
    """提取已连接的矩阵定义，并把矩阵等式展开为分量关系。"""
    raw_items = [str(item or "").strip() for item in (items or []) if str(item or "").strip()]
    matrix_defs = {}
    consumed = set()
    failures = []

    # 先解定义；有限轮询允许 B=2A 依赖较早连入的 A=矩阵。
    for _ in range(len(raw_items) + 1):
        changed = False
        for raw in raw_items:
            if raw in consumed:
                continue
            has_literal = bool(_MATRIX_RE.search(raw))
            if (
                not has_literal
                and not _contains_matrix_name(raw, matrix_defs)
                and not _looks_like_advanced_math(raw)
            ):
                continue
            name, body = _matrix_definition_shape(raw)
            if not name:
                continue
            try:
                value, _ = _eval_matrix_expression(body, ctx, matrix_defs)
            except Exception:  # noqa: BLE001
                continue
            if not isinstance(value, sp.MatrixBase):
                continue
            if name in matrix_defs:
                try:
                    same = matrix_defs[name].shape == value.shape and all(
                        sp.simplify(a - b) == 0
                        for a, b in zip(matrix_defs[name], value)
                    )
                except Exception:  # noqa: BLE001
                    same = False
                if not same:
                    failures.append("矩阵 %s 存在互相冲突的定义" % name)
            else:
                matrix_defs[name] = value
                changed = True
            consumed.add(raw)
        if not changed:
            break

    relations = []
    for raw in raw_items:
        if raw in consumed:
            continue
        if (
            not _MATRIX_RE.search(raw)
            and not _contains_matrix_name(raw, matrix_defs)
            and not _looks_like_advanced_math(raw)
        ):
            continue
        normalized, left, right, error = _matrix_equation_sides(raw, ctx, matrix_defs)
        consumed.add(raw)
        if error:
            failures.append(error)
            continue
        left_is_matrix = isinstance(left, sp.MatrixBase)
        right_is_matrix = isinstance(right, sp.MatrixBase)
        if left_is_matrix != right_is_matrix:
            failures.append("矩阵不能与标量直接相等：" + str(normalized))
            continue
        if left_is_matrix:
            if left.shape != right.shape:
                failures.append("矩阵等式两侧维度不一致：" + str(normalized))
                continue
            relations.extend(
                sp.Eq(a, b, evaluate=False) for a, b in zip(left, right)
            )
        else:
            relations.append(sp.Eq(left, right, evaluate=False))
    return matrix_defs, relations, failures, consumed


_CASES_RE = re.compile(
    r"\\begin\s*\{cases\}([\s\S]*?)\\end\s*\{cases\}"
)


def _normalize_cases_latex(text):
    """把 MathLive ``cases`` 分类为分段函数或联立方程组。

    返回 ``(kind, normalized, rows, error)``。分段行形如 ``expr & condition``；
    方程组允许无 ``&``，也允许对齐写法 ``lhs &= rhs``。
    """
    raw = str(text or "").strip()
    match = _CASES_RE.search(raw)
    if not match:
        return None, raw, [], None
    if _CASES_RE.search(raw, match.end()):
        return None, raw, [], "暂不支持一个节点中包含多个 cases 环境"

    body = match.group(1)
    rows = [r.strip() for r in re.split(r"\\\\|\\cr\b", body) if r.strip()]
    if not rows:
        return None, raw, [], "cases 环境中没有可判定的分支或方程"

    cells = [tuple(part.strip() for part in row.split("&", 1)) for row in rows]
    is_piecewise = any(
        len(parts) == 2 and not parts[1].lstrip().startswith("=")
        for parts in cells
    )

    if not is_piecewise:
        equations = []
        for parts in cells:
            row = "".join(parts) if len(parts) == 2 else parts[0]
            normalized = _latex_pre_normalize(row)
            if not normalized or "=" not in normalized:
                return None, raw, [], "方程组中的每一行都必须是等式或不等式"
            equations.append(normalized)
        return "system", ";".join(equations), equations, None

    prefix = raw[:match.start()].strip()
    suffix = raw[match.end():].strip()
    if not prefix.endswith("=") or suffix:
        return None, raw, [], "分段函数必须写成 f(x)=cases 的形式"

    branches = []
    for parts in cells:
        value = _latex_pre_normalize(parts[0])
        if len(parts) == 1 or not parts[1].strip():
            condition = "True"
        else:
            condition_raw = re.sub(
                r"\\text\s*\{\s*(?:if|for|otherwise|当|若|其他)\s*\}",
                "", parts[1], flags=re.IGNORECASE,
            ).strip().lstrip(",")
            condition = "True" if not condition_raw else _latex_pre_normalize(condition_raw)
        branches.append("(%s, %s)" % (value, condition))
    normalized = prefix + "Piecewise(" + ", ".join(branches) + ")"
    return "piecewise", normalized, rows, None


def _piecewise_covers_reals(expr_text, ctx):
    """返回分段条件是否覆盖其唯一实变量；多变量/不可判定时返回 None。"""
    try:
        segments = _split_chain(str(expr_text or "")) or []
        if len(segments) != 2:
            return None
        body = sp.sympify(segments[1].strip(), locals=ctx.get("locals") or {})
        if not isinstance(body, sp.Piecewise):
            return None
        conditions = [condition for _value, condition in body.args]
        if any(condition is sp.true or condition is True for condition in conditions):
            return True
        symbols = set()
        for condition in conditions:
            symbols.update(getattr(condition, "free_symbols", set()))
        if len(symbols) != 1:
            return None
        covered = sp.Union(*(condition.as_set() for condition in conditions))
        return sp.Complement(sp.S.Reals, covered) == sp.S.EmptySet
    except Exception:  # noqa: BLE001
        return None


# --- 轮次 X7 新增：MathLive 微分符 LaTeX 宏展开 ---
#
# ## 用户现象（原话 + GUI 截图，实测确认）
#   「我在无前提条件下提交 du=0 显示错误，因为引擎把 u 当成了未定义的函数」
#   「是 MathLive 里打，打的是 du=0，另外在 MathLive 打 dy=0 自动转化成了
#     \\differentialDy」
#
# ## 根因（探针 scripts/vdu0.py / vdu0b.py 实测）
#   MathLive 宏表（dist/assets/mathlive.min-*.js 实测摘录）：
#     differentialD: "\\mathrm{d}"   rd: "\\mathrm{d}"   odif: "\\mathrm{d}"
#     capitalDifferentialD: "\\mathrm{D}"
#   且 MathLive **序列化时保留宏名**（用户实测：`dy=0` 存成 `\\differentialDy=0`）。
#
#   而引擎的 LaTeX 通道**不认识这两类宏**，把它当普通标识符逐字母拆开
#   （`_strip_implicit_mul` 的「未声明连续字母串按字母+数字逐段拆分」）：
#     `\\mathrm{d}u=0`      → `mathrm*(d*u) = 0`      → `a*d*h*m**2*r*t*u = 0`
#     `\\differentialDu=0`  → `d(i)fferentialDu = 0` → `D*a*e**2*f**2*i*l*n*r*t*u*d(i) = 0`
#   → `d`、`u` 语义全丢 → 判定层只能报 unknown / no_premise。
#
# ## 为什么必须放在 `_latex_pre_normalize` 的**最前**
#   它是 LaTeX 串进入引擎的**第一站**（`cmd_session_step` 与 `_sympify_relation`
#   两个入口都经此），宏展开后 `\\mathrm{d}y` → `dy` 正好与**手写输入同构**，
#   下游 `_normalize_diff_text`（`dy` → `d(y)`）、`_DIFF_EQ_LEFT_RE` 全部复用，
#   零新增语义分支。
#
# ## 为什么只替换这几个精确形态（不改动其它 `\\mathrm{...}`）
#   `\\mathrm{d}` / `\\mathrm{D}` 在数学排版里就是「罗马体 d」，语义上等价于 `d`；
#   其余 `\\mathrm{xxx}` 保持不动，避免放宽既有语义。
#   替换后若紧跟字母（`\\differentialDy`）自然拼成 `dy`，正是期望形态。
#   长宏名**必须先替换**：否则 `\\differential` 前缀会先吃掉 `\\differentialD`。
_LATEX_MATHML_D_RE = re.compile(r"\\mathrm\s*\{\s*d\s*\}")
_LATEX_MATHML_DCAP_RE = re.compile(r"\\mathrm\s*\{\s*D\s*\}")


def _expand_latex_differential_macros(text):
    """把 MathLive 的微分符宏展开为 `d` / `D`（轮次 X7 新增）。

    ## 处理的宏（MathLive 宏表 + 用户实测）
      `\\differentialD`        → `d`   （最常见：打 `dy` 得到 `\\differentialDy`）
      `\\capitalDifferentialD` → `D`
      `\\mathrm{d}`            → `d`
      `\\mathrm{D}`            → `D`

    ## 返回值
      展开后的字符串。**不含上述宏时原样返回**（对既有输入零影响）。
    """
    if not isinstance(text, str) or "\\" not in text:
        return text
    # ① 长宏名先替换（顺序不可颠倒）
    if "\\differentialD" in text:
        text = text.replace("\\differentialD", "d")
    if "\\capitalDifferentialD" in text:
        text = text.replace("\\capitalDifferentialD", "D")
    # ② `\\mathrm{d}` / `\\mathrm{D}`（允许宏内空白）
    if "\\mathrm" in text:
        text = _LATEX_MATHML_D_RE.sub("d", text)
        text = _LATEX_MATHML_DCAP_RE.sub("D", text)
    return text


def _latex_pre_normalize(text, function_params=None):
    """含 LaTeX 特征时先转成**项目语法串**；否则原样返回（轮次 W 新增）。

    ## 为什么需要（vmlx 探针 B5/C3/G3/G4/G5 实测确认）
      前端 `resolveNodeExpression` 对「等号 ≥ 2」的输入**原文直送**
      `session_step`（跳过 `cmd_parse`）—— 目的是防止 `x=4,y=5` 被
      值集合通道压成 `"4, 5"` 而丢掉变量名。
      但 `session_step` 内部的 `_sympify_relation` **原本没有 LaTeX 通道**
      （只有 `cmd_parse` 的 `_to_diff` 有），于是任何含 LaTeX 的多等式
      全部失败（实测报错原文）：
        `\\frac{dy}{dx}=2x=2x` → could not parse '\\frac*{d(y)}*{d(x)}'
        `\\int 2x\\,dx=x^2=x^2` → could not parse '\\int 2*x\\'
        `y=x^{2}=x^{2}`       → ** or pow(): 'Symbol' and 'set'
      而「多步连续变形」正是学生最常用的写法，影响面很大。

    ## 为什么放在 `_sympify_relation` 而非只修前端
      `_sympify_relation` 是**所有前提（facts / assumptions / domains）**
      的解析入口 —— 前提里写 LaTeX 是同一根因。
      在引擎侧修可一次覆盖两个入口，任何调用方都受益。

    ## 失败时**静默回落**（返回原文）
      与 `_to_diff` 的 LaTeX 通道同一口径：不可用 / 解析失败时保持既有
      行为完全不变，由下游既有链路处理（不引入新的失败路径）。

    ## 为什么回传**字符串**而非 SymPy 对象
      `_sympify_relation` 后续要走 `_split_chain`（链式切分）、
      `_strip_implicit_mul`（2x→2*x）等**字符串级**归一，
      故这里只做「LaTeX → 项目语法串」的转换，复用下游全部既有逻辑。
      链式（`a=b=c`）用 `latex_to_expr` 的 `segments` 拼回 `" = "`，
      使下游 `_split_chain` 能正常切分。
    """
    if not _has_latex_markers(text):
        return text
    # --- 轮次 X7 新增：MathLive 微分符宏展开（**必须最前**，理由见函数说明）---
    text = _expand_latex_differential_macros(text)
    text = text.replace(r"\imaginaryI", "I")
    text = re.sub(r"\\mathrm\s*\{\s*i\s*\}", "I", text)
    ok, res = _latex_try_one(text, function_params)
    if ok:
        return res

    # --- 链式等式兜底：按顶层单等号切段，**逐段**转（轮次 W 补充）---
    #
    # ## 为什么需要（实测确认，`parse_latex` 的固有限制）
    #   `parse_latex('y=x^{2}=x^{2}')` 会把三段链编译成
    #   `Eq(Eq(y, x**2), x**2)`，而 SymPy 见「Eq(布尔, 表达式)」结构上
    #   确定不等 → **当场求值为 `BooleanFalse`** → `latex_to_expr` 命中
    #   轮次 O 的守卫返回 `ok: False`（该守卫本是为**前端解析通道**设计的，
    #   那里可回落 Python 归一链；但多等式**直送**路径没有第二条路）。
    #
    #   实测三种形态全部如此：
    #     `\\frac{dy}{dx}=2x=2x`   → 布尔值
    #     `\\int 2x\\,dx=x^{2}=x^{2}` → 布尔值
    #     `y=x^{2}=x^{2}`          → 布尔值
    #   而**单段** LaTeX（`\\frac{dy}{dx}=2x`）完全正常
    #   （实测 `segments = ['Derivative(y, x)', '2*x']`）。
    #
    # ## 做法
    #   按顶层单等号（`_EQ_SPLIT_RE`，已排除 ==/>=/!= 等）切段，
    #   每段都是**单式** → `parse_latex` 可正常处理 → 用 `" = "` 拼回，
    #   交下游 `_split_chain` 按链式逐对判定（复用既有链式能力，零新逻辑）。
    #
    # ## 任一段失败即整体回落
    #   避免「部分转成功、部分保留原文」产生半 LaTeX 半项目语法的混合串
    #   （那种串两边都解析不了）。失败时原样返回，保持既有行为不变。
    _segs = _split_chain(text)
    if _segs and len(_segs) >= 2:
        _out = []
        for _s in _segs:
            _o, _r = _latex_try_one(_s.strip(), function_params)
            if not _o:
                return text
            _out.append(_r)
        return " = ".join(_out)
    return text


def _latex_try_one(text, function_params=None):
    """单段 LaTeX → 项目语法串。返回 (是否成功, 串)。

    抽成独立函数供 `_latex_pre_normalize` 在「整体 / 逐段」两处复用 ——
    避免两套转换口径分叉（同 `_has_latex_markers` 的抽出理由）。
    """
    try:
        lx = latex_engine.latex_to_expr(text, function_params=function_params)
    except Exception:  # noqa: BLE001
        return False, text
    if not lx.get("ok"):
        return False, text
    segs = lx.get("segments")
    if segs:
        return True, " = ".join(segs)
    txt = lx.get("text")
    if isinstance(txt, str) and txt.strip():
        # `Abs` → `abs`（统一为项目输入别名；两种名称均为内置算子）
        return True, latex_engine.to_project_syntax(txt)
    return False, text

# 不等式运算符（用于不等式归一）
_INEQ_OPS = ("<=", ">=", "<", ">")
_INEXACT_RE = re.compile(r"(<=|>=|<|>)")

# ---- 值集合与约束组（轮次 D：多值答案 / 等式带限定）----

# 集合分隔符：中英文逗号、分号、or
# 用途一：拆分多值答案（x1=1, x2=5 → ["x1=1", "x2=5"]）
# 用途二：拆分约束组（x>0,y>0 → ["x>0", "y>0"]）
_SET_SEP_RE = re.compile(r"[,;，；]|\bor\b")

# 末段约束组：主式后紧跟「(含不等号的内容)」，如 "x*y=4 (x>0,y>0)"
# **必须要求括号内含不等号** —— 否则 "(x+1)*(x-1)" 这类普通括号运算会被误拆。
# 约束内部不允许出现嵌套括号（约束是 x>0 / 0<x<20 这类简单形式），故用 [^()]* 限定。
_CONSTRAINT_TAIL_RE = re.compile(
    r"^(?P<main>.*?)\s*[\(\（]\s*(?P<cons>[^()\（\）]*[<>][^()\（\）]*)\s*[\)\）]\s*$",
    re.S,
)

# 纯括号包裹（多值答案的集合记法）：(1,5) / [1,5]
_OUTER_BRACKET_RE = re.compile(r"^[\(\[]\s*(?P<inner>.+?)\s*[\)\]]$", re.S)


# ==========================================================================
# 工具函数
# ==========================================================================

def _err(code: str, msg: str) -> dict:
    """构造结构化错误返回"""
    return {"ok": False, "error": msg, "errorCode": code}


def _build_locals(symbol_names) -> dict:
    """符号名列表 → sympy Symbol 字典（供 sympify 的 locals 参数）"""
    return {name: sp.Symbol(name) for name in (symbol_names or []) if isinstance(name, str) and name}


def _strip_implicit_mul(s, symbol_names=None, function_names=None, holder=None):
    """把隐式乘法写成显式乘法：2x→2*x、2xy→2*x*y、x1y1→x1*y1、2(x+1)→2*(x+1)。

    为什么需要：用户与 MathLive 常写 2x 这类省略乘号的形式，而 SymPy 要求显式 *。
    若不归一，这类输入只能落到 LLM 转译，既慢又不确定。

    关键设计（已用 SymPy 实测验证）：
    - **已声明符号最长优先整体匹配**：symbol_names 中的 m0、x1 必须整体保留，
      否则 m0 会被拆成 m*0，毁掉所有含下标的场景。
    - **函数名与常量名白名单**：sqrt / sin / pi / E 整体保留，
      避免 sqrt( 被插成 sqrt*(、pi 被拆成 p*i。
    - 未命中白名单的连续字母串按「字母+可选数字」逐段拆分
      （Chapter → C*h*a*p*t*e*r），拆出的表达式无法与原式化简为同一结果，
      从而自然拒绝「用多字母单词充当变量名」的写法。
    - **函数记法识别**（关键）：函数名不是变量。遇到「未声明标识符 + 左括号」时
      视为函数调用（如 A(x) → A(x)，而非 A*(x)），函数名记入 holder['functions']。
      已声明为 variable/constant 的标识符仍走乘法 —— 尊重场景定义，故零歧义。

    function_names：场景显式声明为 kind='function' 的函数名列表。
    holder：可选 dict，识别到的函数名写入 holder['functions']（set）。
    """
    if not isinstance(s, str) or not s:
        return s

    func_set = set(_IMPLICIT_MUL_FUNCS) | set(function_names or [])
    known_set = set(list(symbol_names or [])) | func_set | set(_IMPLICIT_MUL_CONSTS)
    longs = sorted(known_set, key=len, reverse=True)
    out = []
    prev = None  # None / 'num' / 'sym' / 'close' / 'open' / 'op' / 'func'
    i, n = 0, len(s)

    while i < n:
        ch = s[i]

        # 1) 最长优先匹配已知符号名 / 函数名 / 常量名
        hit = None
        for t in longs:
            if not t or not s.startswith(t, i):
                continue
            before = s[i - 1] if i > 0 else ""
            after = s[i + len(t)] if i + len(t) < n else ""
            if (before.isalpha() or before == "_") or (after.isalnum() or after == "_"):
                continue
            hit = t
            break
        if hit:
            if prev in ("num", "sym", "close"):
                out.append("*")
            out.append(hit)
            if hit in func_set:
                prev = "func"
                # **函数识别透明化（轮次 C 修复）**：
                # 已声明为 function 的标识符会走「最长优先匹配」这条分支
                # （因为在 known_set 里），而不是下面的 4a 分支，因此
                # 此前不会被登记到 holder['functions']。
                # 后果：`A(x)` 虽被正确解析为函数调用（不是 A*x），
                # 但 detected_functions 为空 → UI 无法显示「已识别为函数」，
                # 用户便无从得知为何 `a(x+1)` 没被当成乘法（D42 要求透明化）。
                # 此处补登记：仅当紧跟左括号时才算函数调用。
                after_hit = s[i + len(hit)] if i + len(hit) < n else ""
                if after_hit == "(" and holder is not None:
                    holder.setdefault("functions", set()).add(hit)
            elif hit[0].isdigit():
                prev = "num"
            else:
                prev = "sym"
            i += len(hit)
            continue

        # 2) 括号：函数名后紧跟左括号不插 *（保持 sqrt(...)）
        if ch in "([{":
            if prev in ("num", "sym", "close"):
                out.append("*")
            out.append(ch)
            prev = "open"
            i += 1
            continue
        if ch in ")]}":
            out.append(ch)
            prev = "close"
            i += 1
            continue

        # 3) 数字
        m = _NUM_TOKEN_RE.match(s, i)
        if m:
            if prev in ("sym", "close", "func"):
                out.append("*")
            out.append(m.group(0))
            prev = "num"
            i = m.end()
            continue

        # 4) 标识符：三分支处理（函数识别 / 已声明 / 逐段拆分）
        m = _IDENT_RE.match(s, i)
        if m:
            ident = m.group(0)
            end = m.end()
            after = s[end] if end < n else ""

            # 4a-0) 微分算子 `d`（轮次 W）：**后面紧跟左括号**即视为算子，
            #       绝不插乘号。
            #
            # ## 为什么必须单独一条（实测确认）
            #   `_normalize_diff_text` 把 `du` 归一成 `d(u)`，但若 `d`
            #   不被识别为算子，`_strip_implicit_mul` 会因 `prev='sym'`
            #   而在 `(` 前插 `*` → 变回 `d*(u)` —— 微分语义**再次丢失**。
            #   实测：`d(u+h)=dh` 被拆成 `d*(h + u) = d(h)`（探针 E3 实测）。
            #
            # ## 为什么判据用「紧跟左括号」而不是加入白名单
            #   白名单（`_IMPLICIT_MUL_FUNCS`）是**无条件**保留：加了 `d` 后
            #   连 `2d` 后的 `d` 也会被当算子。而本判据只在 `d(` 形态生效，
            #   `d = 5`、`2*d`、`d*x` 等既有写法**完全不受影响**。
            #   且 `prev='func'` 使紧随的 `(` 不插 `*`，正好保住 `d(u)`。
            if ident == "d" and after == "(":
                if prev in ("num", "sym", "close"):
                    out.append("*")
                out.append(ident)
                prev = "func"
                i = end
                continue

            # 4a) 函数调用：已声明为函数，或「未声明 + 紧邻 (单个符号)」
            #     这是「A(x) 不得被读成 A*x」的关键分支（函数名不是自由符号）
            #
            # 轮次 H 修正（R1，用户规定）：未声明标识符后跟的括号**必须是单个符号**
            # 才视为函数调用。为什么必须加这条（实测确认的真实缺陷）：
            #   用户写 `x+5=a(x+1)`（本意 a 乘以 (x+1)）原先被判为函数调用，
            #   因为旧判据只看「未声明 + 紧邻左括号」，不看括号里的内容。
            #   加上此条件后 `a(x+1)` → `a*(x+1)`，而 `f(x)` / `f(x,y)` 仍识别为函数。
            decl_m = _FUNC_DECL_RE.match(s, i)
            if ident in func_set or (
                decl_m and decl_m.group(1) == ident and ident not in known_set
            ):
                if prev in ("num", "sym", "close"):
                    out.append("*")
                out.append(ident)
                prev = "func"
                if holder is not None:
                    holder.setdefault("functions", set()).add(ident)
                i = end
                continue

            # 4b) 已声明符号整体保留
            if ident in known_set:
                if prev in ("num", "sym", "close"):
                    out.append("*")
                out.append(ident)
                prev = "sym"
                i = end
                continue

            # 4c) 未声明的连续字母串：按「字母+可选数字」逐段拆分
            #     （Chapter → C*h*a*p*t*e*r，从而自然拒绝多字母单词作变量名）
            pos = i
            while pos < end:
                sm = _SYM_TOKEN_RE.match(s, pos)
                if not sm:
                    break
                if prev in ("num", "sym", "close"):
                    out.append("*")
                out.append(sm.group(0))
                prev = "sym"
                pos = sm.end()
            i = pos if pos > i else end
            continue

        # 5) 运算符及其他字符
        out.append(ch)
        prev = "op"
        i += 1

    return "".join(out)


def _split_chain(s):
    """把输入按等号拆成段列表；非等式返回 None。

    与 _split_equation 的区别：**支持链式等式**（`a = b = c` 返回 3 段），
    用于判定「连续变形」这类书写习惯（用户原话：「我们在求解的过程中，
    都是先把等式列出来，然后逐步推导」）。

    排除 ==、>=、<=、!=、:= 等运算符。
    """
    if not isinstance(s, str):
        return None
    hits = list(_EQ_SPLIT_RE.finditer(s))
    if not hits:
        return None
    segs, last = [], 0
    for m in hits:
        segs.append(s[last : m.start()].strip())
        last = m.end()
    segs.append(s[last:].strip())
    return segs


def _split_equation(s):
    """识别**单等号**等式，返回 (lhs, rhs)；非等式返回 (None, None)。

    多个等号（如 a=b=c）直接抛错 —— 供 plot_data / simplify 等
    **不支持链式等式**的命令继续使用（保持其既有对外行为）。
    verify_equiv 请改用 _split_chain。
    """
    segs = _split_chain(s)
    if segs is None:
        return None, None
    if len(segs) > 2:
        raise ValueError(f"表达式含多个等号，无法判定：{s}")
    return segs[0], segs[1]


def _normalize_notation(s, holder=None, func_names=None):
    """用户手写记法 → SymPy 可解析形式（块 A / 块 D）。

    `func_names`：已声明函数名列表，供 `_normalize_leibniz` 的 `dF/dx` 判据使用。
    为 None 时该分支跳过，行为与加此参数前**完全一致**（向后兼容）。

    处理三类「机械可归一」的写法，避免为它们白跑一次 LLM 转译：

    1. **撇号导数**：A'(x) → diff(A(x), x)；A''(x) → diff(A(x), x, 2)
       - 半角撇号直接让 Python 报 "unterminated string literal"
       - U+2032 更危险：不报错，而是把 A′ 当成**符号名的一部分**（静默错误）
    2. **幂运算符**：m^2 → m**2（Python 的 ^ 是异或，不是幂）
    3. **中文单位**：200 平方米 → 200（单位剥离到 holder['units']）

    为什么只做这三类：它们是**确定性字符替换**，不涉及语义判断。
    而 A'(2*t)（括号内非单一标识符）存在歧义 —— 无法确定是
    「在 2t 处求导」还是「对 2t 求导」—— 故不猜测，留给 LLM 转译。
    """
    if not isinstance(s, str) or not s:
        return s

    text = s.translate(_PRIME_TRANS)   # 各种撇号字符 → 半角撇号
    # 轮次 F：全角括号/方括号 → 半角（中文输入法下的常见写法）
    # 为什么需要：用户写 `V'（x）` 时括号是全角 U+FF08/U+FF09，
    # _DERIV_RE 只匹配半角括号，撇号被原样保留 →
    # sympify 抛 `TokenError: unterminated string literal`（实测确认）。
    text = text.translate(_FULLWIDTH_PAREN_TRANS)
    # 轮次 F：LaTeX \left( ... \right) → ( ... )
    text = _LATEX_LEFT_RIGHT_RE.sub(r"\1", text)
    text = _CARET_RE.sub("**", text)   # ^ → **（避开已有的 **）

    # 撇号导数归一：f'(x) → diff(f(x), x)；二阶 → diff(f(x), x, 2)
    def _deriv_repl(m):
        name, primes, arg = m.group(1), m.group(2), m.group(3)
        if len(primes) == 1:
            return f"diff({name}({arg}), {arg})"
        return f"diff({name}({arg}), {arg}, {len(primes)})"

    text = _DERIV_RE.sub(_deriv_repl, text)

    # --- 莱布尼茨导数算子归一（轮次 W）：d/dx(expr) / (d/dx)expr / dF/dx ---
    # 位置要求：**必须在 `_normalize_diff_text` 之前** ——
    # 否则 `d/dx` 里的 `dx` 会先被当作微分项拆成 `d(x)`，算子结构不可恢复。
    text = _normalize_leibniz(text, func_names)

    # --- 微分记法归一（轮次 W）---
    # 位置要求：**必须在 `_strip_implicit_mul` 之前**（本函数正是它的上游），
    # 否则 `du` 会被拆成 `d*u`（`d` 当变量），语义不可恢复。
    # 为什么放在撇号导数**之后**：`_DIFF_ATOM` 用 `(?!diff\b)` 排除 `diff`，
    # 若撇号导数先转出了 `diff(...)`，本条归一不会再误伤它。
    text = _normalize_diff_text(text)

    # 中文单位剥离（仅当单位位于末尾，且其前不含其他中文）
    # 例：200 平方米 → 200；200*平方米 → 200
    # 若整串含中文标识符（如 面积=200 平方米），不剥离（无法解析，交 LLM）
    um = _CJK_UNIT_RE.search(text)
    if um and not re.search(r"[\u4e00-\u9fff]", text[: um.start()]):
        stripped = text[: um.start()].rstrip().rstrip("*").rstrip()
        if stripped:
            if holder is not None:
                holder.setdefault("units", []).append(um.group(1))
            text = stripped

    return text


def _apply_function_bodies(expr, symbol_table):
    """把函数声明体代入实参（块 B）—— 兑现 §10.3.7 登记但未实施的 body。

    背景：SymbolDecl 已支持 kind='function' + params + body，此前仅登记未使用。
    用户写 A(2*t) 时，SymPy 只当成「未知函数在 2t 处的值」，
    求导永远停在 Derivative(A(2*t), t)，无法与具体表达式比对。

    做法：找出 expr 中所有「已声明函数名(实参)」子表达式，按 params 逐位置代入 body。

    为什么必须做：A'(x) 归一为 diff(A(x), x) 后，若 A 的 body 是 x*(40-2*x)，
    必须先展开 body 才能让 diff 求值出 40-4*x；否则永远停在 Derivative。

    安全：参数个数不匹配 / body 解析失败时静默跳过，不影响表达式的其他部分。
    """
    if not symbol_table or not isinstance(symbol_table, dict):
        return expr
    funcs = {
        n: i for n, i in symbol_table.items()
        if isinstance(i, dict) and i.get("kind") == "function" and i.get("body")
    }
    if not funcs:
        return expr
    try:
        for name, info in funcs.items():
            params = info.get("params") or []
            body_raw = info.get("body")
            if not params or not body_raw:
                continue
            try:
                body = sp.sympify(str(body_raw), locals=_build_locals(params))
            except Exception:
                continue
            try:
                nodes = [f for f in expr.atoms(sp.Function) if f.func.__name__ == name]
            except Exception:
                continue
            reps = {}
            for node in nodes:
                if len(node.args) != len(params):
                    continue  # 实参个数不匹配：不猜测，跳过
                local = {sp.Symbol(p): node.args[i] for i, p in enumerate(params)}
                try:
                    reps[node] = body.subs(local)
                except Exception:
                    continue
            if reps:
                try:
                    expr = expr.xreplace(reps)
                except Exception:
                    continue
    except Exception:
        pass
    return expr


def _eval_derivatives(expr):
    """把未求值的 Derivative 求出数值（块 C）。

    为什么必须做：sp.diff 会立即求值，但用户手写 diff(f(x), x) 经 sympify
    得到的是**惰性**的 Derivative —— sympify 只建立语法树，不执行求导。
    实测：sympify("diff(A(x), x)") 经 sstr 输出 "Derivative(A(x), x)"，
    与 "40-4*x" 比对必然判不等价（即使 A 的 body 已代入）。

    做法：仅当表达式确实含 Derivative 时调 doit()（对无导数表达式是恒等操作，
    但显式判断避免对 Integral / Sum 等产生意外求值副作用）。
    """
    try:
        if expr.has(sp.Derivative):
            return expr.doit()
    except Exception:
        pass
    return expr


def _normalize_diff_text(text):
    """微分记法归一（轮次 W）：`dX/dY` → `Derivative(X, Y)`，其余 `dX` → `d(X)`。

    ## 为什么必须做（实测确认的真实缺陷）
      `_strip_implicit_mul` 会把 `du` 拆成 **`d*u`**（`d` 被当变量）。
      最严重的一例：`du/dt=dh/dt` 被净化为 `t*u = h*t`，
      化简得 **`u = h`** —— 凭空得出「u 等于 h」这个**错误结论**
      （数学上它只说明两者导数相等，差一个常数）。

    ## 为什么商必须先处理
      `_DIFF_TERM_RE` 只认单个 `dX`；若先跑它，`du/dt` 会被拆成两个独立项，
      商的关系丢失。故**必须先跑 `_DIFF_QUOTIENT_RE`**。

    ## 输出形态
      `du/dt`     → `Derivative(u, t)`（白名单内，不再被拆）
      `d(u+h)/dt` → `Derivative(u+h, t)`
      `du`        → `d(u)`（**保留**微分包裹，不展开为裸符号）
    `d(u)` 交 `_judge_differential_step` 处理 —— 只有在那里它才有「微分」语义。
    """
    if not isinstance(text, str) or "d" not in text:
        return text

    def _quot_repl(m):
        x = m.group(1) if m.group(1) is not None else m.group(2)
        y = m.group(3) if m.group(3) is not None else m.group(4)
        return "Derivative(%s, %s)" % ((x or "").strip(), (y or "").strip())

    try:
        text = _DIFF_QUOTIENT_RE.sub(_quot_repl, text)
    except Exception:  # noqa: BLE001
        pass

    def _term_repl(m):
        inner = m.group(1) if m.group(1) is not None else m.group(2)
        return "d(%s)" % ((inner or "").strip(),)

    try:
        text = _DIFF_TERM_RE.sub(_term_repl, text)
    except Exception:  # noqa: BLE001
        pass

    return text


# 微分式判据（轮次 W 双侧 / 轮次 X2 第 2 步扩展单侧）。
#
# ## ① 双侧：`d(A) = d(B)`（轮次 W）
#   只认「整侧就是 `d(…)`」——与 `_is_function_notation` 同口径：
#   混在其它运算里的 `dX` 不当作微分式，交常规判定（避免放宽既有语义）。
_DIFF_EQ_TERM = r"d\s*\(\s*([^()]+?)\s*\)"

# ## ② 单侧：`d(A) = Y` / `Y = d(A)`（轮次 X2 第 2 步新增）
#
# ### 用户现象（原话）
#   「用户在前提 R 为常数，提交 `dR=0`，显示错误……微分式识别仅识别
#     `d(...)=d(...)` 的形式，未识别 `d(...)=0`；`0=d(...)` 形式」
#
# ### 为什么必须单独加两条正则
#   原 `_DIFF_EQ_RE` 要求**两侧都是** `d(...)`，故 `dR=0` 不匹配 →
#   退回常规判定 → `d` 被 `_auto_declare_symbols` 登记为**函数** →
#   判 `function_declared` 并**无条件通过**
#   （实测：连 `dR=5`、`du=0` 都被放行，属确定性漏洞）。
#
# ### 顺序要求：**必须先匹配「双侧」**
#   `d(A)=d(B)` 也能被单侧正则的「右侧任意」分支接住（右侧即 `d(B)`）。
#   若先试单侧，双侧式子会被误判为单侧，丢失「可差积分常数 C」的语义。
#
# ### 为什么右侧用 `[^=]+?` 而非 `.+?`
#   排除链式（`d(x)=d(y)=d(z)`）与意外含等号的写法，
#   避免把整串当作单侧式而绕过链式逐段判定。
#   注：`d(x) >= 5` 这类不等式不会被匹配（`\s*=\s*` 不含 `>`），行为不变。
_DIFF_EQ_BOTH_RE = re.compile(
    r"^\s*" + _DIFF_EQ_TERM + r"\s*=\s*" + _DIFF_EQ_TERM + r"\s*$"
)
_DIFF_EQ_LEFT_RE = re.compile(
    r"^\s*" + _DIFF_EQ_TERM + r"\s*=\s*([^=]+?)\s*$"
)
_DIFF_EQ_RIGHT_RE = re.compile(
    r"^\s*([^=]+?)\s*=\s*" + _DIFF_EQ_TERM + r"\s*$"
)


def _normalize_diff_equation(raw):
    """把微分等式归一为可判定的形式；非微分等式返回 None（轮次 W）。

    ## 用户口径（原话）
      「u 和 h 是变量，前提 R 是常量，u=R+h，du=dh」
      —— 数学含义：R 为常量 ⟹ dR = 0 ⟹ du = d(R+h) = dh。

    ## 归一规则
      `du = dh` → `{"lhs": "u", "rhs": "h"}`（保留「被微分量」两侧）

    ## 为什么**不**直接展开为 `u = h`
      `u = h` 与 `du = dh` 是**两回事**：前者要求两量相等，
      后者只要求「两边微分相同」（可差一个常数）。若展开为 `u = h`，
      在前提 `u = R + h` 下会被判 conflict —— 而那恰恰是**正确**的微分关系。
      故保留被微分量，由 `_judge_differential_step` 按微分判据处理。
    """
    if not isinstance(raw, str) or not raw.strip():
        return None
    text = _normalize_notation(raw)
    text = _normalize_diff_text(text)

    # ① 双侧（**必须先试**，理由见正则定义处的说明）
    m = _DIFF_EQ_BOTH_RE.match(text)
    if m:
        return {
            "lhs": (m.group(1) or "").strip(),
            "rhs": (m.group(2) or "").strip(),
            "lhsIsDiff": True,
            "rhsIsDiff": True,
        }
    # ② 单侧：左侧是微分项（`dR=0`）
    m = _DIFF_EQ_LEFT_RE.match(text)
    if m:
        return {
            "lhs": (m.group(1) or "").strip(),
            "rhs": (m.group(2) or "").strip(),
            "lhsIsDiff": True,
            "rhsIsDiff": False,
        }
    # ③ 单侧：右侧是微分项（`0=dR`）
    m = _DIFF_EQ_RIGHT_RE.match(text)
    if m:
        return {
            "lhs": (m.group(1) or "").strip(),
            "rhs": (m.group(2) or "").strip(),
            "lhsIsDiff": False,
            "rhsIsDiff": True,
        }
    return None


def _judge_differential_step(diff_eq, ctx):
    """微分等式的判定（轮次 W 新增）。

    ## 判据（用户场景：前提 `u=R+h` 且 R 为常量有值，提交 `du=dh`）
      1. 化为差式 `f = A - B`（A/B 是被微分量）
      2. 常量代入其**值**；再逐条前提等式解出**变量类符号**并代入
      3. `f` 化简后**不含任何变量类符号** → `dA = dB` 成立 → pass
         否则 → fail（两边微分不相等）

    ## 用户确认的口径
      Q1：无前提时 `du=dh` → **fail**（u、h 独立时 du≠dh）✅ 见第 3 步
      Q2：常量**必须有值** —— 无值则无从判断，返回 `const_without_value`
          并给出可执行指引（不猜测，符合项目既有原则）

    ## 为什么「常量代入 + 变量解出」两者都要
      - 常量代入：`R` 有值 → `d(R+h)` 里的 R 化掉，差式只留 h 相关项
      - 变量解出：前提 `u = R+h` 把 u 换成 `R+h`，
        故 `f = u - h` → `R + h - h` → `R` → 常量代入 → `5` → 不含变量 → pass
      只做其一都判不出来（实测确认）。
    """
    _lhs_raw = str(diff_eq.get("lhs") or "")
    _rhs_raw = str(diff_eq.get("rhs") or "")
    _lhs_is_diff = bool(diff_eq.get("lhsIsDiff", True))
    _rhs_is_diff = bool(diff_eq.get("rhsIsDiff", True))
    try:
        a = sp.sympify(_lhs_raw, locals=ctx["locals"])
        b = sp.sympify(_rhs_raw, locals=ctx["locals"])
    except Exception as e:  # noqa: BLE001
        return {"legit": "illegal", "code": "unparsable", "detail": "微分式无法解析：%s" % (e,)}

    # --- 轮次 X3 重写：入边是否为空 ---
    #
    # ## 为什么不再用 `constValues` / `_check_const_without_value`
    #   用户口径（原话）：「**系统不区分常量变量，我们也不去定义什么是常量变量**，
    #     只看满足 `du=0` 这种等式作为限制条件就能限制符号的行为与运算逻辑了。」
    #   旧实现依赖「场景声明为 constant 且给出取值」这一前提，
    #   于是：
    #     - `R` 声明为变量（或无值常量）时无法参与判定 → 误判 unknown/fail
    #     - 场景常量值又会被当作「隐含前提」参与判定（与连线机制冲突）
    #   新实现**完全不看**场景的 kind/value —— 一切以「前提等式 + 化简结果」为准，
    #   与轮次 X 的「有连线才有推导关系」口径一致。
    _has_premise = bool(ctx.get("hasPremise"))

    def _reduce(expr):
        """把 expr 在**前提等式**下化简到最简（轮次 X3 重写，替代旧 `_reduce`）。

        ## 旧实现的两个缺陷（实测确认，见 `scripts/vdiff3diag.py` 的输出）
          旧版逻辑是「找到一个**可解**的等式就 `break`」，于是：
            前提 `[Eq(u, R+h), Eq(R, 2)]`，`f = u - h`
            轮1：试 `Eq(u, R+h)` → 候选按字母序 {R,h,u} → 先解 **`R = -h+u`**
                 → `f = -h+u`（**没变**，因为 f 里根本没有 R）→ 立即 break
            轮2~4：重复同一替换 → `f` 恒为 `-h+u`
            最终 `f = -h+u`（**应为 `2`**）
          → 连 `Eq(R, 2)` 这条**能直接钉死 R** 的前提都轮不到。

          两个成因：
            ① 未优先消去 **f 中实际出现**的符号（R 不在 f 里，却被先处理）
            ② 未优先选**常数解**（`R = 2` 比 `R = u-h` 强得多）

        ## 新算法（每轮取一个「最优替换」，直到不动点）
          1. 只把 **`expr` 中实际出现**的符号作为被消元对象 ——
             消一个不相关的符号毫无收益，只会白占轮次（缺陷 ①）
          2. **常数解优先**：`solve` 结果不含自由符号时直接采纳
             （这是最强约束，如 `R = 2`）（缺陷 ②）
          3. 解含符号时，只在「代入后自由符号集**严格变小**」才采纳 ——
             否则 `R → u-h` 这类替换会让表达式更复杂，反而破坏收敛
          4. 每轮只做一个替换，最多 6 轮（保证收敛，且足够覆盖
             `u → R+h → h+2 → 5` 这类多级链）

        ## 返回值
          化简后的表达式。**任何一步失败都不抛错**，返回当前进度
          （判定层只关心「是否还含自由符号」，中途失败会自然退化为 fail）。
        """
        cur = expr
        # 前提等式 → 差式 `lhs - rhs`（统一形态，便于 solve）
        eqs = []
        for _r in (ctx.get("relations") or []):
            if not isinstance(_r, sp.Eq):
                continue
            try:
                _e = sp.simplify(_r.lhs - _r.rhs)
            except Exception:  # noqa: BLE001
                continue
            if _e != 0:
                eqs.append(_e)
        if not eqs:
            return cur

        # 符号名 → 关系式中**真实的 Symbol 对象**。
        # 为什么必须这样取（与 `_solve_unique_var` 同坑）：按名字新建的
        # `sp.Symbol(n)` 与 `_compile_symbols` 产出的对象**不是同一实例**，
        # `subs` 会静默不生效。
        _sym_by_name = {}
        for _e in eqs:
            for _s in getattr(_e, "free_symbols", set()):
                _sym_by_name.setdefault(str(_s), _s)
        for _s in getattr(expr, "free_symbols", set()):
            _sym_by_name.setdefault(str(_s), _s)

        def _subs_pinned(e, table):
            """把 table（符号名 → 值）代入表达式；无表时原样返回。"""
            if not table:
                return e
            _sb = {}
            for _n, _v in table.items():
                _sym = _sym_by_name.get(_n)
                if _sym is not None:
                    _sb[_sym] = _v
            if not _sb:
                return e
            try:
                return sp.simplify(e.subs(_sb))
            except Exception:  # noqa: BLE001
                return e

        # ============ 阶段 0：钉死传播（常数饱和，B4 实测缺陷修复）============
        #
        # ## 为什么必须有这一阶段
        #   前提 `u=R+h, R=2, h=3` 要把 `u` 归约到 `5`，路径是
        #     `u → R+h`（自由集 **1 → 2，变大**）→ `R → 2`、`h → 3` → `5`
        #   而阶段 1 的「自由集严格变小」判据会**拒绝第一步** ——
        #   于是阶段 1 单独跑时 `u` 永远钉不死（实测 B4 FAIL）。
        #
        # ## 做法
        #   先做不动点迭代：反复扫描所有前提等式，凡「解出某符号为
        #   **不含任何未钉死符号**的表达式」就登记为已钉死，直到不再变化。
        #   这样 `R`、`h` 先被钉死（解是纯数值），`u = R+h` 再代入即得 `5`。
        #
        #   B4 传播过程：
        #     第 1 轮：`R=2`（纯值）、`h=3`（纯值）→ 登记
        #     第 2 轮：`u = R+h` → 代入已知 → `5`（纯值）→ 登记
        #     第 3 轮：无变化 → 收敛
        #
        #   B3 对照（`u=R+h, R=2`，无 `h=3`）：`u` 解出后仍含未钉死的 `h`
        #   → **不登记** → `u` 保持自由 → 判定 fail（与用户期望一致）。
        pinned = {}
        for _ in range(6):
            _changed = False
            for _e in eqs:
                for _v in sorted(_e.free_symbols, key=lambda z: str(z)):
                    if str(_v) in pinned:
                        continue
                    try:
                        _sol = sp.solve(_e, _v)
                    except Exception:  # noqa: BLE001
                        continue
                    if not (isinstance(_sol, list) and len(_sol) == 1):
                        continue
                    _val = _subs_pinned(_sol[0], pinned)
                    if getattr(_val, "free_symbols", set()):
                        continue        # 仍含未钉死的符号 → 尚不可定值
                    pinned[str(_v)] = _val
                    _changed = True
            if not _changed:
                break

        # ============ 阶段 1：自由集严格递减 ============
        for _ in range(6):
            cur = _subs_pinned(cur, pinned)
            cur_names = {str(s) for s in getattr(cur, "free_symbols", set())}
            if not cur_names:
                break                      # 已是纯数值 → 无需再化简
            best_rank = None               # 0 = 常数解（最优）；1 = 自由集变小
            best_new = None
            for _e in eqs:
                for _v in sorted(_e.free_symbols, key=lambda z: str(z)):
                    # ① 只消 **cur 中实际出现**的符号
                    if str(_v) not in cur_names:
                        continue
                    try:
                        _sol = sp.solve(_e, _v)
                    except Exception:  # noqa: BLE001
                        continue
                    if not (isinstance(_sol, list) and len(_sol) == 1):
                        continue
                    _val = _sol[0]
                    try:
                        _new = _subs_pinned(
                            sp.simplify(cur.subs({_v: _val})), pinned
                        )
                    except Exception:  # noqa: BLE001
                        continue
                    _is_const = not getattr(_val, "free_symbols", set())
                    _new_names = {str(s) for s in getattr(_new, "free_symbols", set())}
                    # ② 常数解无条件采纳；③ 非常数解须让自由集**严格变小**
                    if _is_const:
                        _rank = 0
                    elif len(_new_names) < len(cur_names):
                        _rank = 1
                    else:
                        continue
                    if best_rank is None or _rank < best_rank:
                        best_rank, best_new = _rank, _new
                        if _rank == 0:
                            break          # 常数解已是最优，无需再看
                if best_rank == 0:
                    break
            if best_new is None:
                break                      # 没有可采纳的替换 → 不动点
            cur = best_new
        return cur

    # --- 场景常量取值表（供 `_free_symbols_under` 代入使用）---
    _consts = dict(ctx.get("constValues") or {})

    def _free_symbols_under(expr):
        """expr 在**当前节点**下仍自由变化的符号（轮次 X3 新增）。

        ## 判据（用户口径）
          一个符号是否「自由」，取决于**当前节点能看到的全部条件**：
            ① 前提等式（`u=R+h`、`R=2` 等）—— 已由 `_reduce` 代入
            ② 场景常量的**取值**（`R` 声明为常量且 value=2）

        ## 为什么把「场景常量取值」也算进来（边界裁定）
          场景常量值是**场景定义的一部分**（相当于该符号的名字就代表那个值），
          不是「沿连线传递的前提」—— 代入它不违反「有连线才有推导关系」。
          实测场景：场景 `R` 为常量(值2)、前提 `u=R+h` 时提交 `dR=0`，
          若不代入则 `R` 仍被视作自由符号 → 误判 fail，
          而 R 明明已是确定值 2。

        ## 与「系统不区分常量变量」不矛盾
          本函数**不查** kind 标签来决定走哪条路 —— 只看
          「代入后还剩哪些符号」，与 `_reduce` 的口径完全一致。

        ## 返回值
          自由符号的 **set**（空集表示「在该节点下已是确定值」）。
        """
        try:
            _syms = set(getattr(expr, "free_symbols", set()) or set())
        except Exception:  # noqa: BLE001
            return set()
        if not _syms or not _consts:
            return _syms
        _subs = {}
        for _n, _v in _consts.items():
            if _v is None:
                continue
            _sym = ctx["locals"].get(_n)
            if _sym is None or _sym not in _syms:
                continue
            try:
                _subs[_sym] = sp.sympify(str(_v), locals=ctx["locals"])
            except Exception:  # noqa: BLE001
                continue
        if not _subs:
            return _syms
        try:
            return set(expr.subs(_subs).free_symbols)
        except Exception:  # noqa: BLE001
            return _syms

    # ============ 轮次 X3：**无入线 → 视为新声明 → pass** ============
    #
    # ## 用户口径（原话）
    #   「无前提没任何入线相当于**不引用场景中规定的任何条件**」
    #   「无任何前提下 `du=0`，判 pass，相当于声明了 u 是个常量」
    #   「无前提 `du=dh` 相当于建立一个微分关系，判 pass」
    #
    # ## 为什么不分单侧/双侧
    #   两者**语义相同**：不引用任何前提时，`dX=Y` 就是「给微分定一条
    #   新规则」，语法成立即为合法 —— 与「函数定义无需被推导」同一口径。
    if not _has_premise:
        return {
            "legit": "legit",
            "code": "differential_declared",
            "detail": "本步作为微分关系的新声明（无连线前提，不引用任何场景条件）",
        }

    # ============ 有入线：统一判据 ============
    #
    # ## 判据（用户口径「只看等式作为限制条件」）
    #   把两侧代入前提化简后，看还剩哪些自由符号：
    #     **单侧** `dX = Y`
    #       `X` 须已化为常量（⟺ `dX ≡ 0`），且 `Y` 须已化为 **0**（恒等）
    #       —— 单侧**不给**「常数任意性」（用户裁定：`dR=5` 必须 fail）
    #     **双侧** `dA = dB`
    #       差式 `A - B` 须已化为常量（可差一个积分常数 C，`du=dh` 即此义）
    #
    # ## 与旧实现的区别（关键）
    #   旧实现依赖「场景声明为 constant 且给出取值」，且用 `& _vars`
    #   （未约束的符号一律算自由）—— 两者都与用户口径不符：
    #     「系统不区分常量变量……只看满足 `du=0` 这种等式作为限制条件」
    #   新实现**完全不看 kind 标签**：只看「代入前提后还剩什么」。
    if not (_lhs_is_diff and _rhs_is_diff):
        if _lhs_is_diff:
            _diff_expr, _value_expr = a, b
        else:
            _diff_expr, _value_expr = b, a
        # ============ 轮次 X7b：**「全是新符号」→ 视为新声明 → pass** ============
        #
        # ## 用户现象（原话）
        #   「没修好，明显是这个等式走了**另一条判定路线**吧」
        #   探针 scripts/vdu0d.py 实测复现：
        #     `du=0` **无入线** → `differential_declared` pass ✅
        #     `du=0` **有入线**（哪怕前提与 u 毫无关系，如 `R=2`）
        #       → `differential_conflict` **fail** ❌ ← GUI 报错根因
        #
        # ## 为什么这是缺陷（判据不自洽）
        #   用户口径（原话）：「无前提没任何入线相当于**不引用场景中规定的
        #   任何条件**」「无任何前提下 `du=0`，判 pass，相当于声明了 u 是个常量」。
        #
        #   而「有入线」这个事实本身**并不意味着** u 被约束了 ——
        #   若前提里**一个字都没提到 u**（如 `R=2`），那么对 u 而言，
        #   「有入线」与「无入线」的**信息量完全相同**，二者**必须同判**。
        #   旧实现却按「有/无入线」二分，造成同一语义得到相反结论。
        #
        # ## 与既有口径一致（零新语义）
        #   `_judge_atomic` 五类规则第 1 条：解出的变量**未在前提出现**
        #   → `new_definition`（登记为定义，不做对错比对）。本处复用同一判据。
        #
        # ## 判据（保守，不越权）
        #   仅当本步引用的符号**全部**未在前提出现 → 新声明 → pass。
        #   只要**有一个**符号出现过，就仍走原判据（既有正确行为不变）：
        #     前提 `u=R+h, R=2, h=3` → u 出现过 → `_reduce` 得 5 → pass ✅
        #     前提 `u=R+h`（h 未钉死）→ u 出现过 → `_reduce` 得 R+h → fail ✅
        _appeared_syms = _appeared_symbols(ctx.get("relations"))
        _ref_syms = {str(_s) for _s in getattr(_diff_expr, "free_symbols", set())}
        if _ref_syms and not (_ref_syms & _appeared_syms):
            return {
                "legit": "legit",
                "code": "differential_declared",
                "detail": (
                    "本步作为微分关系的新声明："
                    + "、".join(sorted(_ref_syms))
                    + " 未在已连线前提中出现，不引用任何含它们的条件"
                ),
            }
        _d1 = _reduce(_diff_expr)
        _d2 = _reduce(_value_expr)
        _f1 = _free_symbols_under(_d1)
        _f2 = _free_symbols_under(_d2)
        if _f1:
            return {
                "legit": "illegal",
                "code": "differential_conflict",
                "detail": (
                    "两边的微分不相等：在前提下 " + sp.sstr(_diff_expr)
                    + " 仍随 " + "、".join(sorted(str(s) for s in _f1))
                    + " 变化，其微分不为 0"
                ),
            }
        if _f2:
            return {
                "legit": "illegal",
                "code": "differential_conflict",
                "detail": (
                    "两边的微分不相等：在前提下 0 无法等于 "
                    + sp.sstr(_value_expr) + "（它仍随 "
                    + "、".join(sorted(str(s) for s in _f2)) + " 变化）"
                ),
            }
        # `X` 已是常量 ⟹ `dX ≡ 0`；右侧也须**恒为 0**（单侧不给常数任意性）
        try:
            _res2 = sp.simplify(_d2)
        except Exception:  # noqa: BLE001
            _res2 = _d2
        if _res2 != 0:
            return {
                "legit": "illegal",
                "code": "differential_conflict",
                "detail": (
                    "两边的微分不相等：在前提下 " + sp.sstr(_diff_expr)
                    + " 是常量（其微分为 0），无法等于 " + sp.sstr(_value_expr)
                ),
            }
        return {
            "legit": "legit",
            "code": "differential_equal",
            "detail": "在前提条件下，两边的微分相等",
        }

    # 双侧 `dA=dB`：同理，若 A、B 的符号**全未在前提出现** → 新声明 → pass
    _bi_syms = {str(_s) for _s in getattr(a, "free_symbols", set())}
    _bi_syms |= {str(_s) for _s in getattr(b, "free_symbols", set())}
    if _bi_syms and not (_bi_syms & _appeared_symbols(ctx.get("relations"))):
        return {
            "legit": "legit",
            "code": "differential_declared",
            "detail": (
                "本步作为微分关系的新声明："
                + "、".join(sorted(_bi_syms))
                + " 未在已连线前提中出现，不引用任何含它们的条件"
            ),
        }
    try:
        f = sp.simplify(a - b)
    except Exception:  # noqa: BLE001
        f = a - b
    f = _reduce(f)
    _left = _free_symbols_under(f)
    if not _left:
        return {
            "legit": "legit",
            "code": "differential_equal",
            "detail": "在前提条件下，两边的微分相等",
        }
    return {
        "legit": "illegal",
        "code": "differential_conflict",
        "detail": (
            "两边的微分不相等：在前提下 " + sp.sstr(f)
            + " 仍随 " + "、".join(sorted(str(s) for s in _left)) + " 变化"
        ),
    }


def _norm_ineq(left_raw, right_raw, op, locals_map=None):
    """把「左 op 右」归一为 (差式, 方向)，方向统一为 '<' 或 '<='。

    - x < 20     → (x-20, '<')
    - 20 > x     → (x-20, '<')   ← 左右互换后方向翻转
    - x >= 5     → (x-5, '<=')   ← 差式取反 + 方向翻转

    为什么统一方向：让「x<20」与「20>x」这类同义写法归一为同一 (差式, 方向)，
    否则同义写法会被判不等价。

    **必须传 locals_map**（轮次 M 修复的真实缺陷）：
        不传时 `sp.sympify("x")` 产出的是**无 `real` 假设**的 `Symbol('x')`，
        而等式侧（`_sympify_relation` 的 `sp.Eq(...)` 分支）用的是带
        `real=True` 的对象 —— 两者**不是同一实例**，后续 `subs` 静默失效。
        实测后果：`x>0` 与 `x=-1` 一起做矛盾检测时，`(x>0).subs(x=-1)`
        仍是 `-x < 0`（未求值），导致「`x=-1` 与前提 `x>0` 矛盾」**漏判**。
    """
    try:
        left = sp.sympify(left_raw, locals=locals_map)
        right = sp.sympify(right_raw, locals=locals_map)
    except Exception:
        return None
    diff = sp.simplify(left - right)
    if op in (">", ">="):
        diff = sp.simplify(-diff)
        op = "<" if op == ">" else "<="
    return diff, op


def _split_ineq_chain(s, symbol_names=None, function_names=None, holder=None):
    """把（可能是链式的）不等式拆成 [(差式, 方向), ...]；非不等式返回 None。

    - 单不等式    x < 20      → [(x-20, '<')]
    - 链式不等式  0 < x < 20  → [(0-x, '<'), (x-20, '<')]

    为什么必须手工拆分：Python 把 0 < x < 20 编译成 `(0 < x) and (x < 20)`，
    而 and 需要布尔值 → bool(Relational) 抛
    "cannot determine truth value of Relational"，sympify 直接失败。
    实测：0<x<20 报 PARSE_ERROR，而单个 x>0 可以（不触发 and）。
    """
    if not isinstance(s, str) or not s:
        return None
    text = _normalize_notation(s, holder)
    text = _strip_implicit_mul(text, symbol_names, function_names, holder)

    ops = _INEXACT_RE.findall(text)
    if not ops:
        return None
    parts = _INEXACT_RE.split(text)
    # 注意：re.split 带捕获组时**保留分隔符**，返回值形如
    # [左0, 运算符0, 左1, 运算符1, 左2, ...]，长度为 2n+1（n = 运算符个数）。
    # 因此段数判断是 2n+1，取段下标是 2i / 2i+2 —— 曾误用 n+1 与 i/i+1，
    # 导致所有不等式都被判为「非不等式」而返回 None。
    if len(parts) != 2 * len(ops) + 1:
        return None

    subs = []
    for i, op in enumerate(ops):
        left, right = parts[2 * i].strip(), parts[2 * i + 2].strip()
        if not left or not right:
            return None
        parsed = _norm_ineq(left, right, op, symbol_names and {
            nm: sp.Symbol(nm, real=True) for nm in symbol_names
        } or None)
        if parsed is None:
            return None
        subs.append(parsed)
    return subs or None


def _ineq_equivalent(user_subs, expected_subs):
    """判定两组不等式子式是否等价（子式集合相同，与书写顺序无关）。

    三态返回：True 等价 / False 不等价 / None 无法判定。

    口径（_norm_ineq 已把方向统一为 '<' / '<='，故此处只需比差式）：
    - 同式            ：simplify(d1 - d2) == 0
    - 同乘正数        ：d1/d2 化简为**正**常数

    为什么**不能**用 `d1 + d2 == 0` 判等价：
    该式看似覆盖「反向」，实则会把**真正相反**的不等式误判为等价 ——
    `x<20`（差式 x-20）与 `x>20`（归一后差式 20-x）互为相反数，
    相加恰好为 0，但它们数学上**互为否定**，判等价是严重错误。
    方向已在 _norm_ineq 统一（如 `-x>-20` 归一为 `x-20<0`），
    故此处无需、也不可再做「反向」判定。
    """
    if not user_subs or not expected_subs:
        return None
    if len(user_subs) != len(expected_subs):
        return False  # 子式个数不同 → 约束强度不同 → 确定不等价

    used = [False] * len(expected_subs)
    for du, ou in user_subs:
        hit = False
        for i, (de, oe) in enumerate(expected_subs):
            if used[i] or ou != oe:
                continue
            try:
                if sp.simplify(du - de) == 0:
                    hit = True
                else:
                    ratio = sp.simplify(du / de)
                    if not ratio.free_symbols and bool(ratio.is_positive):
                        hit = True
            except Exception:
                continue
            if hit:
                used[i] = True
                break
        if not hit:
            return False  # 该子式在参考解中找不到对应 → 确定不等价
    return True if all(used) else False


def _split_constraints(raw):
    """把「主式 + 末段约束组」拆开（轮次 D）。

    `x*y=4 (x>0,y>0)` → (main="x*y=4", cons=["x>0", "y>0"])
    `x*y=4`           → (main="x*y=4", cons=[])

    为什么必须要求括号内含不等号（_CONSTRAINT_TAIL_RE 的设计）：
    普通括号运算 `(x+1)*(x-1)` 也以 `)` 结尾，若无此要求会被误拆成
    main="(x+1)*(x-1" + cons=["..."]. 要求内含 < 或 > 后，
    只有「约束组」这一种形态会被识别，括号运算不受影响。

    约束组内按 [,;，；] 或 or 拆分（与多值答案共用 _SET_SEP_RE）。
    """
    if not isinstance(raw, str) or not raw.strip():
        return raw, []
    text = raw.strip()
    m = _CONSTRAINT_TAIL_RE.match(text)
    if not m:
        return text, []
    main = (m.group("main") or "").strip()
    cons_raw = (m.group("cons") or "").strip()
    if not main or not cons_raw:
        return text, []
    cons = [c.strip() for c in _SET_SEP_RE.split(cons_raw) if c and c.strip()]
    if not cons:
        return text, []
    return main, cons


def _strip_outer_brackets(raw):
    """剥掉整体包裹的圆/方括号：`(1,5)` → `1,5`；`[1,5]` → `1,5`。

    为什么需要：多值答案常用集合记法书写（`(1,5)`、`[1,5]`）。
    sympify 无法解析这两种形态（实测 `list` / `tuple` 无 free_symbols），
    必须在解析前剥掉外层括号，再按分隔符拆成多项。

    安全性：仅当外层括号**整体配对**时才剥（首字符是 ( 或 [ 且尾字符是对应闭合），
    因此 `(x+1)*(x-1)` 这类（首字符是 ( 但尾字符是 )——会被误判）需额外防护：
    此处用「去掉首尾后括号是否仍平衡」判定，不平衡则不剥。
    """
    if not isinstance(raw, str):
        return raw
    text = raw.strip()
    m = _OUTER_BRACKET_RE.match(text)
    if not m:
        return text
    inner = m.group("inner")
    # 平衡性检查：剥掉外层后内部不应出现多余的右括号
    depth = 0
    for ch in inner:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
            if depth < 0:
                return text  # 不平衡 → 外层括号不是包裹式的，不剥
    if depth != 0:
        return text
    return inner.strip()


def _parse_value_set(raw, symbols=None):
    """把输入解析为「值的集合」（轮次 D）。

    支持形态（用户原话里的全部写法）：
      - 单值表达式      `1+x`              → [expr(1+x)]
      - 单方程          `x=2`              → [expr(2)]          ← 取等号右侧
      - 多值赋值组      `x1=1, x2=5`       → [expr(1), expr(5)]
      - 集合记法        `(1,5)` / `[1,5]`  → [expr(1), expr(5)]
      - or 连接         `x=1 or x=5`       → [expr(1), expr(5)]

    返回 (list_of_sympy_expr, is_set)。解析失败抛 ValueError（由调用方转错）。

    为什么要取方程右侧：结论块允许用户写 `x=2` 表示「答案是 2」。
    此时等号左侧只是标记（变量名），不应参与比较 —— 对应决策 2①
    「不匹配变量名，只看值的集合」。
    """
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("表达式为空")

    text = raw.strip()
    if text.startswith("$") and text.endswith("$"):
        text = text[1:-1]
    # 先剥外层集合括号
    text = _strip_outer_brackets(text)

    # 按集合分隔符拆分
    parts = [p.strip() for p in _SET_SEP_RE.split(text) if p and p.strip()]
    if not parts:
        raise ValueError(f"无法解析值集合：{raw}")

    locals_map = _build_locals(symbols)
    out = []
    for p in parts:
        # 每项若是等式则取右侧（左侧是变量标记，不参与比较）
        segs = _split_chain(p)
        if segs is not None and len(segs) == 2:
            p = segs[1].strip()
        try:
            out.append(sp.sympify(p, locals=locals_map))
        except Exception as e:  # noqa: BLE001
            raise ValueError(f"无法解析值集合项：{p}（{e}）")
    return out, (len(out) > 1)


def _value_set_equivalent(ua, ub, symbol_table):
    """判定两个值集合是否等价（**只看值的集合，不匹配变量名** —— 决策 2①）。

    口径：
    - 集合大小必须相同（多一个少一个都判不等价）
    - 每个元素在对方集合中能找到等价项（`simplify(a-b)==0`，或纯数值时走容差）
    - 顺序无关（`x1=1,x2=5` 与 `x2=5,x1=1` 等价）

    三态返回：True 等价 / False 不等价 / None 无法判定（交给常规策略）。

    为什么纯数值用容差：`0.4` 与 `4/10` 应视为同一值（与级别 0 一致）。
    """
    if not ua or not ub:
        return None
    if len(ua) != len(ub):
        return False  # 根的个数不同 → 确定不等价

    used = [False] * len(ub)
    for a in ua:
        hit = False
        for i, b in enumerate(ub):
            if used[i]:
                continue
            # 纯数值：走容差（吸收浮点表示误差）
            if not a.free_symbols and not b.free_symbols:
                try:
                    fa = complex(a.evalf())
                    fb = complex(b.evalf())
                    if abs(fa - fb) / max(1.0, abs(fb)) < STRICT_NUMERIC_TOL:
                        hit = True
                except Exception:
                    hit = False
            if not hit:
                try:
                    hit = sp.simplify(a - b) == 0
                except Exception:
                    hit = False
            if hit:
                used[i] = True
                break
        if not hit:
            return False
    return True if all(used) else False


def _is_function_notation(seg, declared_var_names):
    """判断该段是否是「函数记法」，如 A(x)、f(x,y)、s(t)。

    口径（零歧义）：形如 `name(...)` 且 name **不是**已声明的变量/常量，
    也不是内置函数/常量名。已声明的标识符仍按乘法理解（尊重场景定义）。

    返回函数名（str）或 None（不是函数记法）。
    """
    m = _FUNC_DECL_RE.match((seg or "").strip())
    if not m:
        return None
    name = m.group(1)
    if name in set(declared_var_names or []):
        return None
    if name in _IMPLICIT_MUL_FUNCS or name in _IMPLICIT_MUL_CONSTS:
        return None
    return name


def _classify_equation(segments, declared_var_names, holder=None):
    """判定用户输入的结构类别。

    - `expression`：普通表达式或普通方程，如 `40 - 2*x`、`2*x+y=40`
    - `definition`：函数定义等式，如 `A(x) = x*(40-2*x)`（判定取右侧）
    - `assignment`：常量赋值，如 `x0 = 1`（右侧无自由符号）
    - `chain`：链式等式，如 `a = b = c`（主判定取末段 + 相邻段自洽校验）
    """
    if not segments:
        return "expression"
    if len(segments) > 2:
        if holder is not None:
            holder["chain"] = segments
        return "chain"

    lhs, rhs = segments[0], segments[1]
    lhs_fn = bool(_is_function_notation(lhs, declared_var_names))
    rhs_fn = bool(_is_function_notation(rhs, declared_var_names))
    # 函数定义：**任一侧**是函数记法即可（轮次 H 对称化修复）
    #
    # 为什么必须左右对称（实测确认的缺陷）：
    #   `x^2+1 = f(x)`（与 `f(x) = x^2+1` 等价，只是左右互换）原先只检查左侧，
    #   被判为 expression → 差式为 f(x)-(x^2+1)，代入 body 后恰好为 0，
    #   而参考解 `f(x) = x^2+1` 取右侧得 x^2+1 → 0 vs x^2+1 → 误判 False。
    if lhs_fn != rhs_fn:
        return "definition"
    # 常量赋值：左侧是单个符号名，右侧无自由符号
    if re.fullmatch(r"[A-Za-z_]\w*", lhs or ""):
        try:
            r_expr = sp.sympify(rhs, locals=_build_locals(declared_var_names))
            if not r_expr.free_symbols:
                return "assignment"
        except Exception:
            pass
    return "expression"


def _check_chain_consistency(segments, declared_var_names):
    """链式等式的「相邻段自洽校验」。

    判据（对相邻段 seg_i 与 seg_{i+1}，计算 d = seg_i - seg_{i+1}）：
    - d 化简为 0                     → 自洽
    - 任一相邻段是函数记法（如 A(x)） → 跳过（函数定义链，非等式链）
    - d 含自由符号                    → 跳过（详见下方轮次 E 说明）
    - d 是非零常数                    → 不自洽，记录段号

    为什么需要「合法引入新物理量」豁免：
      面积函数场景中 `面积 = xy = x(40-2x)` 是正确推导，
      但 `xy - x(40-2x) = x*(y-40+2x)` ≠ 0。严格代数校验会把它误判为错误。
      而「引入了 seg_{i+1} 中没有的新量 y」正是这类正确推导的特征。

    返回 {ok: bool, failAtIndex?: int, detail?: str}。
    """
    try:
        locals_map = _build_locals(declared_var_names)
        for idx in range(len(segments) - 1):
            a_raw, b_raw = segments[idx], segments[idx + 1]
            # 函数记法的段跳过：它串起的是「函数定义链」而非「等式链」
            if _is_function_notation(a_raw, declared_var_names):
                continue
            if _is_function_notation(b_raw, declared_var_names):
                continue
            try:
                a = sp.sympify(a_raw.strip(), locals=locals_map)
                b = sp.sympify(b_raw.strip(), locals=locals_map)
            except Exception:
                continue  # 无法解析的段不参与校验（不阻塞主判定）
            try:
                d = sp.simplify(a - b)
            except Exception:
                continue
            if d == 0:
                continue
            # 轮次 E 修正：含自由符号时**不可**按「表达式相等」判不自洽。
            #
            # 为什么（实测确认）：链式 `2*x+y=40=y+2*x` 的相邻段 (40, y+2*x)
            # 差式为 2x+y-40 ≠ 0，但该链表达的是「两条同解方程」——
            # `2*x+y=40` 与 `40=y+2*x` 互为移项，数学上完全自洽。
            # 旧判据在此误报 failAtIndex=2（实测确认），使正确推导被降级为 warn。
            #
            # 现改为：只有「两侧均为纯数值且不相等」才是真正的不自洽（如 `1=2=3`）。
            # 含符号的情形交由等式对匹配裁定（见 cmd_verify_equiv 的链式分支）。
            if d.free_symbols:
                continue
            return {
                "ok": False,
                "failAtIndex": idx + 1,
                "detail": f"第 {idx + 1} 段与第 {idx + 2} 段不是同一个方程",
            }
        return {"ok": True}
    except Exception:
        # 校验本身失败不阻塞主判定（宁可放过，不可误判）
        return {"ok": True}


def _segment_in_ref(seg_raw, ref_segs, declared_var_names):
    """该段是否与参考解的某个段等价（表达式级，用于关联性判定）。

    轮次 F 新增辅助：`_chain_pair_introduces_symbol` 的豁免**必须**先确认
    该对与参考解有关联，否则 `a=b=c` vs `2*x+y=40` 这类完全无关的链式
    会因为「a 有 b 没有的符号」而被错误豁免（实测发现）。
    """
    try:
        locals_map = _build_locals(declared_var_names)
        seg = sp.sympify((seg_raw or "").strip(), locals=locals_map)
    except Exception:  # noqa: BLE001
        return False
    for r in ref_segs or []:
        try:
            rv = sp.sympify((r or "").strip(), locals=locals_map)
            if sp.simplify(seg - rv) == 0:
                return True
        except Exception:  # noqa: BLE001
            continue
    return False


def _chain_pair_introduces_symbol(a_raw, b_raw, declared_var_names, ref_segs=None):
    """判据 B：相邻段是否为「合法引入新物理量」的变形（轮次 F）。

    **关联性前置**（轮次 F 修正）：仅当该对的任一端与参考解的某个段等价时，
    才允许用「引入新符号」豁免。否则完全无关的链式（如 `a=b=c`）会被误判通过。

    为什么需要这个豁免：`面积 = xy = x(40-2x)` 是正确推导，但相邻段并非
    「同一方程的不同写法」，严格代数比对必然不等。其特征是：
    前段含后段没有的符号（此处 y），差异也因此产生。

    与「算错」的区别（这是本轮的关键）：
    - `xy` vs `x(40-2x)` → 前段独有 {y}，差异含 y  → 豁免，合格
    - `40` vs `y+99`     → 前段无符号，extra 为空集 → **不豁免**，判否
    - `10` vs `2*x+y`    → 前段无符号，extra 为空集 → **不豁免**，判否

    即：只有「真的引入了前段独有的新符号」才算合法变形；
    「在已有符号范围内把数值算错」不会被豁免 —— 这正是轮次 F 要抓的错误。
    """
    # 关联性前置：整对与参考解毫无关联时，不得豁免
    # （否则 `a=b=c` vs `2*x+y=40` 会因「a 有 b 没有的符号」被误判通过）
    if ref_segs and not (
        _segment_in_ref(a_raw, ref_segs, declared_var_names)
        or _segment_in_ref(b_raw, ref_segs, declared_var_names)
    ):
        return False

    try:
        locals_map = _build_locals(declared_var_names)
        a = sp.sympify(a_raw.strip(), locals=locals_map)
        b = sp.sympify(b_raw.strip(), locals=locals_map)
    except Exception:  # noqa: BLE001
        return False
    try:
        d = sp.simplify(a - b)
    except Exception:  # noqa: BLE001
        return False
    if d == 0:
        return True  # 完全相等当然合格
    extra = a.free_symbols - b.free_symbols
    return bool(extra) and bool(d.free_symbols & extra)


def _split_symbol_table(symbol_table):
    """从符号表中分离「变量/常量名」与「函数名」。

    函数名不是变量 —— 它不参与自由符号统计、不参与数值采样，
    但必须传给扫描器，以便把 `A(x)` 识别为函数调用而非 `A*x` 乘法。
    """
    var_names, func_names = [], []
    for name, info in (symbol_table or {}).items():
        if isinstance(info, dict) and info.get("kind") == "function":
            func_names.append(name)
        else:
            var_names.append(name)
    return var_names, func_names


class _FunctionNotDeclared(ValueError):
    """未声明的函数被当作函数调用（R8，用户规定「报错并要求先声明」）。

    为什么必须是独立异常类型：需要回传 `FUNCTION_NOT_DECLARED` 错误码，
    而默认的 ValueError → PARSE_ERROR 会让前端无法区分「语法错」与
    「函数忘了声明」—— 后者的提示话术完全不同（要引导用户先写 `f(x)=...`）。
    """


class _FunctionRedefined(ValueError):
    """同一输入内重复声明同一函数（R6，用户选择「报错」）。

    同样需要独立错误码 `FUNCTION_REDEFINED`，以便前端提示「换个函数名」。
    """


# 函数调用带纯数字实参：`f(2)`、`f(3.5)`。
#
# 用途（R8）：未声明的函数以数字实参调用时报错。
# 为什么只针对**数字**实参（用户原话）：
#   「f(2)未声明的情况改成报错，要求先对函数按 f(x)=什么 的形式进行声明定义」
#   —— 而 `f3(x+1)`（表达式实参）按 R3 走乘法 `f3*(x+1)`，两者语义不同：
#   数字实参只可能是「代入求值」，用户显然忘了先定义函数体；
#   表达式实参则常是本意乘法（如 `a(x+1)` 表示 a 乘以 (x+1)）。
_FUNC_NUMCALL_RE = re.compile(r"([A-Za-z_]\w*)\s*\(\s*\d+(?:\.\d+)?\s*\)")


def _check_undeclared_func_call(raw, var_names, function_names):
    """检查「未声明函数 + 数字实参」的调用；命中则抛 _FunctionNotDeclared（R8）。

    排除项（不报错，按既有语义处理）：
      - 场景已声明为 function / variable / constant 的名字
      - SymPy 内置函数名（sqrt / sin / ...）与常量名（pi / E / ...）
    即：只对「用户自造、却未声明」的名字报错。
    """
    if not isinstance(raw, str) or not raw.strip():
        return
    known = set(var_names or []) | set(function_names or [])
    for m in _FUNC_NUMCALL_RE.finditer(raw):
        name = m.group(1)
        if name in known:
            continue
        if name in _IMPLICIT_MUL_FUNCS or name in _IMPLICIT_MUL_CONSTS:
            continue
        raise _FunctionNotDeclared(
            "未定义的函数 " + name + "：请先用 " + name + "(x) = ... 的形式声明它，"
            "再使用 " + name + "(数字) 代入求值"
        )


def _func_defs_from_facts(facts, declared_var_names):
    """从前提集（字符串列表）中提取函数定义。

    返回 {函数名: [(params, body, 原文), ...]} —— **同名会有多条**，
    这正是支链汇合时的情况（两条支链各自声明了同名函数）。

    为什么要从 facts 提取而非另建存储：声明本身就以 fact 形式沿推导链
    传递（如 `"f(x) = x^2+1"`），支链汇合时两条定义自然同时出现在前提集里，
    无需额外数据结构即可发现冲突。
    """
    out = {}
    for raw in (facts or []):
        if not isinstance(raw, str) or not raw.strip():
            continue
        text = raw.strip()
        segs = _split_chain(text)
        if not segs or len(segs) != 2:
            continue
        lhs, rhs = segs[0].strip(), segs[1].strip()
        m = _FUNC_DECL_RE.match(lhs)
        if m:
            body = rhs
        else:
            m = _FUNC_DECL_RE.match(rhs)
            if not m:
                continue
            body = lhs
        name = m.group(1)
        if name in _IMPLICIT_MUL_FUNCS or name in _IMPLICIT_MUL_CONSTS:
            continue
        params = [p.strip() for p in m.group(2).split(",") if p.strip()]
        out.setdefault(name, []).append((params, body, text))
    return out


def _func_def_eq(params_a, body_a, params_b, body_b):
    """两份函数定义是否等价（**形参改名后比较**，R7 用户规定）。

    为什么不能直接比字符串：`f(x)=x^2+1` 与 `f(t)=t^2+1` 是同一个定义，
    只是形参名不同（用户明确要求允许换形参名）。做法是把两组形参
    分别映射到同一批占位符号（_p0 / _p1 ...），再比较函数体。

    返回 True / False。解析失败时返回 True（**宁可放过，不可误判冲突**）——
    冲突会让整步判 fail，代价过高，证据不足时不应下这个结论。
    """
    if len(params_a) != len(params_b):
        return False
    try:
        subs_a, subs_b = {}, {}
        for i, (pa, pb) in enumerate(zip(params_a, params_b)):
            t = sp.Symbol("_p%d" % i)
            subs_a[sp.Symbol(pa)] = t
            subs_b[sp.Symbol(pb)] = t
        ea = sp.sympify(body_a, locals=_build_locals(params_a)).subs(subs_a)
        eb = sp.sympify(body_b, locals=_build_locals(params_b)).subs(subs_b)
        return sp.simplify(ea - eb) == 0
    except Exception:  # noqa: BLE001
        return True


def _check_function_conflicts(facts, declared_var_names):
    """检查前提集中「同名函数定义是否互相冲突」（R9，轮次 H）。

    场景（用户提出的真实风险）：两条支链各自声明了 f，随后汇合到同一节点 ——
    前提集里同时出现 `f(x)=x^2+1` 与 `f(x)=x^3+2`。若不检查，判定会
    静默采纳其中一个定义，用户完全不知道，结论失去依据。

    口径（用户确认）：
      - 形参名不同但函数体等价 → **不算冲突**（`f(x)=x^2+1` ≡ `f(t)=t^2+1`）
      - 函数体不等价           → **判冲突**（用户选择「判 fail，不给通过」）

    返回 (是否冲突, 说明文案, 冲突对信息)。
    """
    defs = _func_defs_from_facts(facts, declared_var_names)
    for name, items in defs.items():
        if len(items) < 2:
            continue
        base_params, base_body, base_raw = items[0]
        for params, body, raw in items[1:]:
            if not _func_def_eq(base_params, base_body, params, body):
                return (
                    True,
                    "两条支链中的函数 " + name + " 定义不同：" +
                    base_raw + " 与 " + raw + "，请改用不同的函数名",
                    {"scene": base_raw, "user": raw},
                )
    return False, "", None


def _iter_user_function_decls(raw, var_names, function_names=None):
    """收集本条输入中用户「声明」的函数（R1~R6，轮次 H 新增）。

    声明判据（用户规定 R1）：`名字(单个符号[, 单个符号]*) = <表达式>`，
    且该名字未在场景符号表中声明为变量/常量/函数。

    链式按**从左到右**累积（R5）——`x^2+1 = f(x) = x+1` 的处理顺序：
      第 1 对 (x^2+1, f(x)) → f 在右侧且未登记 → 登记 f，body = x^2+1
      第 2 对 (f(x), x+1)   → f 已登记 → 视为「使用」而非「声明」，跳过
    这使用户「先定义、再使用」的推导习惯得到支持。

    同一输入内**重复声明**同一函数 → 抛 ValueError（R6，用户选择「报错」）。
    注意：这里只管「同一条输入内」；跨节点 / 跨支链的冲突检测在阶段 5。

    返回 {函数名: {"params": [...], "body": "<已归一表达式>"}}。
    """
    if not isinstance(raw, str) or not raw.strip():
        return {}
    segs = _split_chain(raw)
    if not segs or len(segs) < 2:
        return {}

    declared_var = set(var_names or [])
    known_func = set(function_names or [])
    decls = {}

    def _declarable(name):
        """该名字是否可被用户声明为函数（场景已声明的不覆盖）。"""
        if not name:
            return False
        if name in declared_var or name in known_func:
            return False
        if name in _IMPLICIT_MUL_FUNCS or name in _IMPLICIT_MUL_CONSTS:
            return False
        return True

    def _body_of(seg):
        """把 body 段归一为 SymPy 可解析形式（用户可能写 2x / x^2）。"""
        body_raw = _normalize_notation(seg.strip())
        return _strip_implicit_mul(body_raw, list(declared_var), None)

    for i in range(len(segs) - 1):
        a, b = segs[i].strip(), segs[i + 1].strip()
        ma, mb = _FUNC_DECL_RE.match(a), _FUNC_DECL_RE.match(b)

        # 右侧是声明记法 → body 在左侧
        if mb and _declarable(mb.group(1)):
            name = mb.group(1)
            if name in decls:
                # 已登记过又出现在声明位置 → 重复声明（R6）
                raise ValueError(
                    "函数 " + name + " 在同一条推导中被声明了两次，请改用不同的函数名"
                )
            params = [p.strip() for p in mb.group(2).split(",") if p.strip()]
            decls[name] = {"params": params, "body": _body_of(a)}
            continue

        # 左侧是声明记法 → body 在右侧；已登记则视为「使用」，跳过
        if ma and _declarable(ma.group(1)) and ma.group(1) not in decls:
            name = ma.group(1)
            params = [p.strip() for p in ma.group(2).split(",") if p.strip()]
            decls[name] = {"params": params, "body": _body_of(b)}

    return decls


def _inject_user_decls(symbol_table, raw, var_names, function_names):
    """把用户声明的函数注入符号表，使其后 `_apply_function_bodies` 自动代入。

    实测确认（阶段 2 前置探针）：注入 symbol_table 后，
    现有 `_apply_function_bodies` 即自动完成：
      f(2)   → 5              （代入求值）
      f(x+1) → (x+1)**2+1     （实参展开）
      f(t)   → t**2+1         （换变量，对应 R7）
      f'(x)  → 2*x            （求导）

    返回注入的函数名列表（供 holder['functions'] / detectedFunctions 使用）。
    """
    try:
        decls = _iter_user_function_decls(raw, var_names, function_names)
    except ValueError:
        raise
    if not decls:
        return []
    for name, info in decls.items():
        symbol_table[name] = {
            "kind": "function",
            "params": list(info.get("params") or []),
            "body": info.get("body"),
        }
    return list(decls.keys())


def _merge_decls_into_symbols_arg(symbols_arg, injected):
    """把用户声明的函数合并进调用方传入的 symbols 参数（**保持其原始形态**）。

    为什么必须保持原形态：`_symbol_table_to_dict` 对 dict 输入的判定是
    「dict 且 kind=='function' → 函数；list 长度 2 → 变量；否则 → 常量」。
    若把内部表形态（{"kind":"variable","range":[...]}）回传，会被误判成
    常量（value = str(dict)），破坏所有含范围的符号。故此处按输入形态合并。
    """
    if not injected:
        return symbols_arg
    fdict = {
        nm: {
            "kind": "function",
            "params": list(inf.get("params") or []),
            "body": inf.get("body"),
        }
        for nm, inf in injected.items()
    }
    if isinstance(symbols_arg, dict):
        merged = dict(symbols_arg)
        merged.update(fdict)
        return merged
    if isinstance(symbols_arg, list):
        merged = list(symbols_arg)
        for nm, inf in fdict.items():
            merged.append({
                "name": nm,
                "kind": "function",
                "params": inf["params"],
                "body": inf["body"],
            })
        return merged
    # None 或其他形态 → 仅用函数表（dict 形态可被 _symbol_table_to_dict 解析）
    return fdict


def _to_diff(expr_str, symbols=None, allow_equation=False, holder=None, function_names=None,
             symbol_table=None):
    """把输入归一为 (SymPy 表达式, 是否等式)。

    - 非等式            → (sympify(串), False)
    - 等式 + 允许等式    → (lhs - rhs, True)
    - 等式 + 不允许等式  → 抛 ValueError

    为什么返回「差式」而不是 sp.Eq：
    五级等价性策略全部基于 `a - b` 计算；若返回 Eq 对象，`Eq - Eq` 会抛 TypeError，
    导致全部策略失效。归一为差式后，现有五级策略无需任何修改即可继续工作。

    记法归一链（块 A~D，顺序不可颠倒）：
      1. `_normalize_notation`  —— 撇号导数 / ^ → ** / 中文单位剥离
      2. `_strip_implicit_mul`  —— 2x → 2*x（必须在 1 之后：归一会产出 diff(...)）
      3. sympify
      4. `_apply_function_bodies` —— A(x) 代入 body
      5. `_eval_derivatives`    —— Derivative(...) → 求值（必须在 4 之后）
    """
    if not isinstance(expr_str, str) or not expr_str.strip():
        raise ValueError("表达式为空")

    text = expr_str.strip()
    # 容错：去掉 $ 包裹
    if text.startswith("$") and text.endswith("$"):
        text = text[1:-1]
    # 0) LaTeX 优先通道（路线 A，轮次 J 新增）
    #
    # 为什么需要：MathLive 编辑器产出的是 **LaTeX**（含 \frac、\sqrt、^{}），
    # 而下方归一化链（_normalize_notation / _strip_implicit_mul）是给
    # **Python 语法**设计的 —— 遇到 LaTeX 会产出 `\frac{...}` 这类无法 sympify
    # 的串，只能回落 LLM 转译。走 parse_latex 后 LaTeX **直达 SymPy**，零 LLM。
    #
    # 触发条件（轮次 J 修订 / 轮次 N 补充 `^{` `_{`）：满足任一即走 LaTeX 通道。
    #   - `"\\" in text`：LaTeX 必含反斜杠（\frac / \sqrt / \pi / \left ...），
    #     而 Python 语法（2*x+y=40、diff(A(x),x)）不含。
    #   - `"|" in text`：绝对值 `|x|` 是 LaTeX 语法（p5 实测 `\left|x\right|`
    #     经 parse_latex 得 `Abs(x)`），而 Python 的 sympify **无法解析** `|x|`
    #     （实测报「could not parse '|x|'」）。用户手写简写 `|x|`（不含 \left）
    #     也应走 LaTeX 通道，故此条件必需。
    #   - `"^{" / "_{"`（轮次 N 补充，必需）：**只有带花括号的下标/上标才需此判据**。
    #     MathLive 对「x 的平方」「m 下标 0」默认产出 `x^{2}` / `m_{0}`，
    #     二者均**不含反斜杠**，故原两条判据全部落空 ——
    #     实测确认：`x^{2}` 报「unsupported operand type(s) for **: 'Symbol' and 'set'」、
    #     `m_{0}` 报「... for *: 'Symbol' and 'set'」（`{2}` 被 sympify 当集合字面量）。
    #     而 `latex_engine` 能正确接住（实测：`x^{2}` → `x**2`、`m_{0}` → `m0`）。
    #     为什么必须补：前端原有一层「ASCIIMath 确定性转译」专门处理这类写法，
    #     该层已于轮次 N 删除（详见 services/scene/latexToSympy.ts 墓碑说明），
    #     其职责必须由引擎侧承接，否则这类最常见写法会直接判失败。
    #   三条判据都**不会**误触发 Python 语法：`|` 在 Python 里是位运算符、
    #   `^{` / `_{` 不是 Python 的合法运算符组合，数学表达式中均不会出现。
    #
    #   注：不带花括号的 `x^2` / `m_0` 仍走下方归一链
    #   （`_normalize_notation` 的 `_CARET_RE` 把 `^` 转 `**`），无需进 LaTeX 通道。
    #
    #   --- 轮次 W：判据抽到 `_has_latex_markers` 供 `_sympify_relation` 共用 ---
    #   同一口径两处实现会埋隐患（将来新增判据必漏改一处），
    #   故改调共享函数，行为与原先内联的四条**完全一致**。
    # --- 轮次 X7 新增：MathLive 微分符宏展开（与 `_latex_pre_normalize` 同口径）---
    #
    # ## 为什么此处也要展开（探针 scripts/vdu0b.py 实测确认）
    #   `_latex_pre_normalize` 只管 `session_step` 侧；而前端 `computeAnalyze`
    #   对 eqCount==1 的节点**先跑 `cmd_parse`**（本函数是其上游），
    #   `cmd_parse` 直连 `latex_engine.latex_to_expr`，**绕过了**
    #   `_latex_pre_normalize` —— 于是 `\mathrm{d}u=0` 在此仍被逐字母拆开，
    #   产物 `a*d*h*m**2*r*t*u = 0` 流入 `session_step`（实测 P2/P3/P6）。
    #
    # ## 为什么展开后要**再判一次** `_has_latex_markers`
    #   展开可能把串变成**纯项目语法**（`\mathrm{d}u=0` → `du=0`）。
    #   此时若仍走 LaTeX 通道，`latex_to_expr('du=0')` 的产物不可控；
    #   而走下方 Python 归一链才能得到与手写输入**完全同构**的 `d(u)=0`
    #   （`_normalize_diff_text` 的既有能力），这正是期望形态。
    #   若展开后仍含 LaTeX（如 `\mathrm{d}u+\frac{1}{2}=0`）→ 继续走 LaTeX 通道。
    if _has_latex_markers(text):
        text = _expand_latex_differential_macros(text)
        text = text.replace(r"\imaginaryI", "I")
        text = re.sub(r"\\mathrm\s*\{\s*i\s*\}", "I", text)
    if _has_latex_markers(text):
        _fn_params = {
            n: list((info or {}).get("params") or [])
            for n, info in (symbol_table or {}).items()
            if isinstance(info, dict) and info.get("kind") == "function"
        }
        _lx = latex_engine.latex_to_expr(text, function_params=_fn_params)
        if _lx.get("ok"):
            _segs = _lx.get("segments")
            if _segs:
                # 等式（含链式）：拼回 Python 语法等式串，交下方链式逻辑处理
                text = " = ".join(_segs)
            else:
                # 非等式：用 latex_engine 回传的**已归一字符串**（下标 m_{0}→m0），
                # 不可用 `sp.sstr(_lx["expr"])` —— 那样会把 `m_{0}` 带进下方
                # `_strip_implicit_mul`，被拆成 `m*{0}`（`{0}` 是 set）而报
                # `unsupported operand type(s) for *: 'Symbol' and 'set'`（实测确认）。
                #
                # 同时把 SymPy 的 sstr 记法转回**项目 NLP 口径**：
                #   `Abs(x)`      → `abs(x)`     （L8 嵌套绝对值实测需要）
                #   `Derivative(…)` 保持（`_strip_implicit_mul` 白名单已含 Derivative）
                # Abs / abs 均已受内置算子白名单保护；此处仍保留项目语法归一。
                text = latex_engine.to_project_syntax(
                    _lx.get("text") or sp.sstr(_lx["expr"])
                )
    #
    # 集成方式：**只做「LaTeX → 归一化 Python 语法串」的转换**，然后让下方
    # 既有链路照常处理（链式切分 / 等式关系 / 五级策略全部复用，零重复实现）。
    # 撇号导数转 LaTeX 导数记法、下标 `m_{0}` → `m0` 均由 latex_engine 内部完成。
    #
    # 失败时**静默回落**（不抛错）：保持既有通道行为完全不变（红线 R1/R2）。
    # 例：`200 \text{ 平方米}` 这类解析器不支持的中文单位，仍由 LLM 兜底。
    # 1) 记法归一（块 A/D）：撇号导数、^ → **、中文单位
    text = _normalize_notation(text, holder, function_names)
    # 2) 隐式乘法归一（2x → 2*x；A(x) 保持函数记法）
    text = _strip_implicit_mul(text, symbols, function_names, holder)
    if holder is not None:
        holder["text"] = text

    segs = _split_chain(text)
    locals_map = _build_locals(symbols)

    def _finalize(e):
        """4)+5)：函数体代入 + 导数求值（两者都不会改变非函数表达式）"""
        e = _apply_function_bodies(e, symbol_table)
        return _eval_derivatives(e)

    if segs is None:
        try:
            return _finalize(sp.sympify(text, locals=locals_map)), False
        except Exception as e:  # noqa: BLE001
            raise ValueError(f"无法解析表达式：{expr_str}（{e}）")

    # 链式等式（≥3 段，如 a=b=c）：取**末段**作为主体参与判定。
    # 为什么取末段：用户一路推导下来，最后一个式子才是他真正主张的结论；
    # 而中间段的正确性由 _check_chain_consistency 单独校验（见 cmd_verify_equiv）。
    if len(segs) > 2:
        if not allow_equation:
            raise ValueError(f"该命令不支持链式等式输入：{expr_str}")
        tail = segs[-1]
        tail_segs = _split_chain(tail)
        if tail_segs is None:
            # 末段本身是**表达式**而非等式（如 a=b=c 里的 c）。
            # 此处必须单独返回，否则后续 `segs[0], segs[1]` 会 IndexError。
            try:
                return _finalize(sp.sympify(tail, locals=locals_map)), False
            except Exception as e:  # noqa: BLE001
                raise ValueError(f"无法解析表达式：{expr_str}（{e}）")
        segs = tail_segs

    lhs, rhs = segs[0], segs[1]

    if not allow_equation:
        raise ValueError(f"该命令不支持等式输入：{expr_str}")

    try:
        left = sp.sympify(lhs, locals=locals_map)
        right = sp.sympify(rhs.strip(), locals=locals_map)
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"无法解析等式：{expr_str}（{e}）")
    return _finalize(left - right), True


def _sympify(expr_str, symbols=None, allow_equation=False):
    """把字符串转为 SymPy 表达式；失败抛 ValueError（消息为面向用户的中文）。

    allow_equation 默认 False：含等号输入报错，使 limit / substitute / check_units
    等命令的既有行为完全不变；置 True 时等式按 lhs-rhs 归一为差式（见 _to_diff）。
    """
    if not isinstance(expr_str, str) or not expr_str.strip():
        raise ValueError("表达式为空")
    expr, _is_eq = _to_diff(expr_str, symbols, allow_equation=allow_equation)
    return expr


def _symbol_table_to_dict(symbols) -> dict:
    """
    前端符号表 → {name: {'kind':..., 'value':..., 'range':...}}
    兼容两种输入形态：
      - dict: {"c": "299792458", "v": ["0", "0.99*c"]}
      - list: [{"name":"c","kind":"constant","value":"299792458"}, ...]
    """
    table = {}
    if isinstance(symbols, dict):
        for name, val in symbols.items():
            # 兼容「函数声明 dict」：{"A": {"kind": "function", "params": [...]}}
            if isinstance(val, dict) and val.get("kind") == "function":
                params = val.get("params")
                table[name] = {
                    "kind": "function",
                    "params": [str(p) for p in params] if isinstance(params, (list, tuple)) else [],
                    "body": str(val["body"]) if isinstance(val.get("body"), str) else None,
                }
            elif isinstance(val, (list, tuple)) and len(val) == 2:
                table[name] = {"kind": "variable", "range": [str(val[0]), str(val[1])]}
            else:
                table[name] = {"kind": "constant", "value": str(val)}
    elif isinstance(symbols, list):
        # 兼容「纯符号名数组」（parse 命令的实际契约，如 ["x","y"]）：
        # 元素是字符串时视为变量名。若不做此兼容，`x(40-2x)` 会因 x 未声明
        # 而被误判为函数调用 x(40-2x)，破坏既有的乘法语义。
        if all(isinstance(it, str) for it in symbols):
            for name in symbols:
                if name:
                    table[name] = {"kind": "variable", "range": ["0", "1"]}
            return table
        for item in symbols:
            if not isinstance(item, dict) or not item.get("name"):
                continue
            name = item["name"]
            if item.get("kind") == "function":
                # 函数声明：其名不是变量，不参与自由符号统计
                params = item.get("params")
                table[name] = {
                    "kind": "function",
                    "params": [str(p) for p in params] if isinstance(params, (list, tuple)) else [],
                    "body": str(item["body"]) if isinstance(item.get("body"), str) else None,
                }
            elif item.get("kind") == "variable":
                rng = item.get("range")
                if isinstance(rng, (list, tuple)) and len(rng) == 2:
                    table[name] = {"kind": "variable", "range": [str(rng[0]), str(rng[1])]}
                else:
                    table[name] = {"kind": "variable", "range": ["0", "1"]}
            else:
                table[name] = {"kind": "constant", "value": str(item.get("value", "1"))}
    return table


# ==========================================================================
# 五级等价性策略（命中即返回 True/False，无法判定返回 None）
# ==========================================================================

def _strategy_numeric_exact(a, b):
    """
    级别 0：纯数值容差判定（两侧均无自由符号时适用）。

    为什么必须放在最前：级别 1 的 simplify(a - b) == 0 对纯数值过于严格 ——
    4/10 与 0.4 在浮点意义下相差约 1e-17，simplify 不为 0 便返回 False，
    而 False 会立即短路后续所有策略，造成「数值答案只要有一丝浮点误差就被判错」。
    带符号的公式反而有级别 5 兜底，形成不对称。

    容差取 STRICT_NUMERIC_TOL（1e-9）：只吸收浮点表示误差，不承担「估算」职责。
    数值答案场景要求用户写精确分数，因此不需要宽松容差。

    返回 True / False / None（None = 本策略不适用，交后续策略）。
    """
    try:
        if a.free_symbols or b.free_symbols:
            return None
        fa = complex(a.evalf())
        fb = complex(b.evalf())
        # nan / inf 无法比较，交给后续策略
        if any(x != x or abs(x) == float("inf") for x in (fa.real, fa.imag, fb.real, fb.imag)):
            return None
        return abs(fa - fb) / max(1.0, abs(fb)) < STRICT_NUMERIC_TOL
    except Exception:
        return None


def _strategy_simplify_diff(a, b):
    """级别 1：simplify(a - b) == 0"""
    try:
        return sp.simplify(a - b) == 0
    except Exception:
        return None



def _strategy_expand_diff(a, b):
    """级别 2：simplify(expand(a - b)) == 0"""
    try:
        return sp.simplify(sp.expand(a - b)) == 0
    except Exception:
        return None


def _strategy_ratio(a, b):
    """级别 3：simplify(a/b - 1) == 0（仅当 b 不为 0）"""
    try:
        if sp.simplify(b) == 0:
            return None
        return sp.simplify(a / b - 1) == 0
    except Exception:
        return None


def _strategy_equals(a, b):
    """级别 4：Expr.equals()（SymPy 内置数值等价测试）。

    **修复 A（轮次 C）**：原实现调用 `sp.equals(a, b)`，但 SymPy 1.13
    **不存在模块级 `equals`**（实测 `hasattr(sp, 'equals') -> False`），
    每次调用都抛 AttributeError 并被 except 吞掉 → 本策略自建成起**从未生效**。

    正确写法是表达式对象的方法 `a.equals(b)`（实测三态：True / False / None）。
    SymPy 内部会对若干随机点做符号与数值双重验证，是级别 1~3 化简失败后的
    重要补充 —— 修复后它才真正参与判定。
    """
    try:
        return a.equals(b)
    except Exception:
        return None


def _strategy_numeric(a, b, symbol_table):
    """
    级别 5：随机数值采样比对。
    对每个变量在其范围内取随机点（常量符号取定值），计算相对误差。
    全部采样点相对误差 < NUMERIC_EPS 判等价；有效点不足则返回 None（→ unknown）。
    """
    try:
        symbols = sorted((a.free_symbols | b.free_symbols), key=lambda s: s.name)
        if not symbols:
            return None

        locals_all = _build_locals([s.name for s in symbols])
        plans = {}
        for sym in symbols:
            name = sym.name
            info = symbol_table.get(name)
            if info and info["kind"] == "constant":
                try:
                    plans[sym] = sp.sympify(info["value"], locals=locals_all)
                except Exception:
                    return None
            elif info and info["kind"] == "variable" and info.get("range"):
                try:
                    lo = float(sp.sympify(info["range"][0], locals=locals_all))
                    hi = float(sp.sympify(info["range"][1], locals=locals_all))
                except Exception:
                    return None
                if not (lo < hi):
                    return None
                plans[sym] = (lo, hi)
            else:
                # 未在符号表中声明取值：无法采样
                return None

        valid = 0
        for _ in range(EQUIV_SAMPLE_POINTS):
            subs = {}
            for sym, plan in plans.items():
                if isinstance(plan, tuple):
                    lo, hi = plan
                    span = hi - lo
                    # 内缩 0.1% 避开端点奇点
                    subs[sym] = lo + span * (0.001 + 0.998 * random.random())
                else:
                    subs[sym] = plan
            try:
                fa = complex(a.subs(subs).evalf())
                fb = complex(b.subs(subs).evalf())
            except Exception:
                continue
            if any(x != x or abs(x) == float("inf") for x in (fa.real, fa.imag, fb.real, fb.imag)):
                continue
            # 跳过数值爆炸的采样点（近奇点）
            if abs(fa) > 1e9 or abs(fb) > 1e9:
                continue
            denom = max(1.0, abs(fb))
            if abs(fa - fb) / denom >= NUMERIC_EPS:
                return False
            valid += 1

        if valid < MIN_VALID_SAMPLES:
            return None
        return True
    except Exception:
        return None


# --------------------------------------------------------------------------
# 等式感知策略（级别 0.4 / 0.5 / 0.6）
#
# 为什么需要：用户按真实推导顺序书写时，中间步骤与最终结果在数学上
# **不是同一个对象** —— 前者是方程（约束），后者是表达式（解）。
# 例如标准解 expected_formula = "40-2*x"，用户写 "2x+y=40"，
# 按「表达式等价」口径必然判不等价，但这在教学中是**正确的上游推导**。
#
# 三条策略的统一约定：**永不返回 False**。
# 因为 `False` 会立即短路掉后续更可靠的 simplify_diff / numeric_sampling，
# 而这三条只负责「识别等式语义」，识别不了就该交回常规策略（返回 None）。
# --------------------------------------------------------------------------


def _strategy_eq_proportional(du, de, u_is_eq, e_is_eq):
    """级别 0.4：两侧皆为**方程** → 判是否为同一方程（相差非零常数倍）。

    数学依据：方程 d1 = 0 与 d2 = 0 定义同一约束 ⟺ 存在非零常数 k 使 d1 = k·d2。
    - 2x+y=40 与 y=40-2x    → d1/d2 = 1    → 等价（移项方向不同）
    - 2x+y=40 与 4x+2y=80   → d1/d2 = 1/2  → 等价（两边同乘 2）
    - 2x+y=40 与 x+y/2=20   → d1/d2 = 2    → 等价（两边同除 2）
    - x=1    与 x**2=1      → d1/d2 非常数 → 不等价（数学正确，解集不同）

    返回 True / None（永不 False，避免短路后续策略）。
    """
    if not (u_is_eq and e_is_eq):
        return None
    try:
        # 先各自通分，只比较**分子**（轮次 D 修复）。
        #
        # 为什么必须通分（实测踩坑）：
        #   `x*y=4` 与 `y=4/x` 是同一约束（两边同乘 x），但
        #   du = xy-4、de = y-4/x = (xy-4)/x，直接算 du/de 得 **x**（含自由符号），
        #   旧判据见含符号即返回 None → 判不出等价（实测 FAIL）。
        #   通分后两者分子都是 xy-4，比值 1（非零常数）→ 正确判等价。
        #
        # 为什么仍要求比值为**非零常数**（不放宽为「任意非零函数」）：
        #   `x=1` 与 `x**2=1` 的分子分别是 x-1 与 (x-1)(x+1)，
        #   比值为 1/(x+1)（含符号）→ 判不等价。这正是数学正确的结果
        #   （后者解集为 {1,-1}，与前者的 {1} 不同）。
        #   若放宽为「任意非零函数」，这两个方程会被误判为等价。
        def _numerator(e):
            """取表达式的分子（先通分为单一分式）"""
            num, _den = sp.fraction(sp.together(e))
            return num

        nu, ne = _numerator(du), _numerator(de)
        if ne == 0:
            return None
        ratio = sp.simplify(nu / ne)
        if ratio.free_symbols:
            return None
        return bool(ratio != 0)
    except Exception:
        return None


def _strategy_eq_implicit(du, de, u_is_eq, e_is_eq):
    """级别 0.5：一侧为**方程**、另一侧为**表达式** → 判「该方程是否以该表达式为解」。

    数学依据：设用户方程为 L = R（记 du = L - R），参考解为表达式 E。
    则 du + E = (L - R) + E；若它化简为「非零常数 × 某个单符号 v」，
    说明 L - R = k·v - E，即 L = R 等价于 k·v = E，也就是 **v = E/k** ——
    用户写下的正是「求解 E 所对应的那个方程」。

    - 用户 2x+y=40，参考 40-2*x → (2x+y-40) + (40-2x) = y  → 单符号 → 等价
    - 用户 y=x+1，  参考 x      → (y-x-1) + x = y-1        → 非单符号 → 交回常规
    - 用户 x=20，   参考 40-2*x → (x-20) + (40-2x) = 20-x  → 非单符号 → 交回常规
    - 用户 2x=40，  参考 40-2*x → (2x-40) + (40-2x) = 0    → 无自由符号 → 交回常规

    返回 True / None（永不 False）。
    """
    if u_is_eq == e_is_eq:
        return None
    try:
        residual = sp.simplify(du + de)
        free = residual.free_symbols
        if len(free) != 1:
            return None
        v = next(iter(free))
        k = sp.simplify(residual / v)
        if k.free_symbols:
            return None
        return bool(k != 0)
    except Exception:
        return None


def _strategy_rename_undeclared(
    user_expr,
    expected_expr,
    declared_names,
    user_is_eq=False,
    expected_is_eq=False,
    holder=None,
):
    """级别 0.6：用户使用了**未在场景中声明**的符号名 → 允许重命名后判定。

    设计动机（用户诉求「更宽松的判定方式」）：
    用户可能自造变量名（把 x 写成 a），数学上完全正确，不该判错。
    但不能无限制宽松，否则「把已声明的 y 当成 x」这类张冠李戴也会被放过。

    口径：
    - 用户的**已声明符号**必须在参考解中存在同名符号（防止张冠李戴）。
    - 用户的**未声明符号**可自由映射到参考解中的剩余符号。
    - 两侧自由符号数量必须相同。
    - 符号数超过 5 个时放弃（避免全排列爆炸）。
    - 命中时把映射写入 holder['mapping']，供调用方降级为 warn 并生成提示。

    返回 True / None（永不 False）。
    """
    if user_is_eq or expected_is_eq:
        # 等式语义已由 0.4 / 0.5 处理，避免与它们产生歧义叠加
        return None
    try:
        us = sorted(user_expr.free_symbols, key=lambda s: s.name)
        es = sorted(expected_expr.free_symbols, key=lambda s: s.name)
        if not us or len(us) != len(es) or len(us) > 5:
            return None

        declared = set(declared_names or [])

        # 用户自称的「已声明符号」，参考解里必须真的有同名符号
        e_names = {t.name for t in es}
        pinned = [s for s in us if s.name in declared]
        if any(s.name not in e_names for s in pinned):
            return None

        free_syms = [s for s in us if s.name not in declared]
        if not free_syms:
            return None  # 无自由度：完全交给常规策略

        pinned_names = {s.name for s in pinned}
        pool = [t for t in es if t.name not in pinned_names]
        if len(pool) < len(free_syms):
            return None

        # 关键前置：若两侧符号名完全一致（无需重命名），本策略不适用。
        # 否则 40-2*x vs 40-2*x 这类「本来就同名」的比对会被误判为「重命名等价」，
        # 进而让前端把正确的推导错误地降级为 warn。此时应交回常规策略（返回 None）。
        if {s.name for s in free_syms} == {t.name for t in pool}:
            return None

        # 符号数 ≤5，池子 ≤5，排列数 ≤120，可接受
        for perm in permutations(pool, len(free_syms)):
            subs = {free_syms[i]: perm[i] for i in range(len(free_syms))}
            for s in pinned:
                subs[s] = sp.Symbol(s.name)
            try:
                if sp.simplify(user_expr.subs(subs) - expected_expr) == 0:
                    if holder is not None:
                        holder["mapping"] = {
                            free_syms[i].name: perm[i].name for i in range(len(free_syms))
                        }
                    return True
            except Exception:
                continue
        return None
    except Exception:
        return None


# ==========================================================================
# 命令实现
# ==========================================================================

def cmd_ping(args) -> dict:
    return {
        "pong": True,
        "protocol": PROTOCOL_VERSION,
        "sympy": sp.__version__,
        "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        # LaTeX 优先通道是否可用（antlr4 版本正确时 true）——前端可据此显示状态
        "latex": latex_engine.latex_available(),
    }


def cmd_parse(args) -> dict:
    """解析表达式；等式输入按「保留等号」形式回传，并标注 is_equation。

    为什么等式要保留等号回传：parse 的产物会流向下游 verify_equiv 与绘图。
    若在此处把等式压成差式（lhs-rhs），下游就再也无法区分「方程」与「表达式」，
    「上游方程 vs 下游表达式」这类判定口径便失去了依据。
    """
    raw = args.get("expr")
    symbols = args.get("symbols")
    # 符号表先解析：函数名必须传给扫描器，否则 A(x) 会被读成 A*x 乘法
    sym_table = _symbol_table_to_dict(symbols)
    var_names, func_names = _split_symbol_table(sym_table)
    parse_holder = {}

    # --- 块 E：不等式单独通道 ---
    # 为什么必须在 _to_diff 之前：「0 < x < 20」经 sympify 会因 Python 链式比较
    # 强制求布尔值而抛 "cannot determine truth value of Relational"。
    # 此处先把不等式拆成子式，逐个 sympify 后按「差式 op 0」回传，
    # 使画布上的定义域声明不再报错（判定侧由 _ineq_equivalent 负责）。
    ineq = _split_ineq_chain(raw, var_names, func_names, parse_holder)
    if ineq:
        parts = [f"{sp.sstr(d)} {op} 0" for d, op in ineq]
        free_names = sorted({s.name for d, _o in ineq for s in d.free_symbols})
        return {
            "sympy_expr": " and ".join(parts),
            "variables": free_names,
            "free_symbols": free_names,
            "is_equation": False,
            "is_inequality": True,
            "inequality_count": len(ineq),
            "detected_functions": sorted(parse_holder.get("functions") or []),
        }

    # --- 轮次 X7c：**微分等式直通**（必须早于 `_to_diff`）---
    #
    # ## 用户现象（探针 scripts/vdu0f.py 实测确认，报错文案逐字吻合）
    #   无入线提交 `du=0` → GUI 报「引擎把 u 识别为未定义函数」。
    #
    # ## 根因：`u` 声明为 **function** 时，本函数**把等号弄丢**
    #     实测：`cmd_parse('du=0')` → `sympy_expr='d(u)'`, `is_equation=False` ❌
    #   链路：
    #     ① 下方 `sympify(lhs, locals_map)` 的 `locals_map` 含
    #        `u: sp.Function('u')`（`_compile_symbols` 对 kind='function' 的产出）
    #        → `sympify('d(u)')` 把 **UndefinedFunction 对象本身**当实参
    #        → SymPy 抛 `Invalid argument: expecting an expression,
    #          not UndefinedFunction: u`
    #     ② 落入 except → `sympy_str = sp.sstr(expr)`（差式 `d(u)`）→ **等号丢失**
    #     ③ 前端 `computeAnalyze` 用**parse 产物**送 `session_step`
    #        → `'d(u)'` 无 `=` → `_normalize_diff_equation` 落空
    #        → 落 `_judge_atomic` → `unparsable`（报错原文与 ① 相同）
    #        → GUI 报红。**文案逐字吻合，根因确证。**
    #
    # ## 为什么直通是正确修法（与 `cmd_session_step` 同口径）
    #   `cmd_session_step` 早已在入口用 `_normalize_diff_equation` **最先拦截**，
    #   完全绕开声明/解析流程。`cmd_parse` 是**同一条链的上游**
    #   （前端先 parse 再 step），必须同口径 —— 上游丢掉的等号，下游无法恢复。
    #
    # ## 为什么安全（零影响）
    #   `_normalize_diff_equation` 对非微分输入返回 **None** ——
    #   `2x+y=40`、`x=4` 等一切既有输入原样落到下方链路，行为不变。
    #
    # ## 为什么回传**字符串**
    #   与既有「等式保留等号回传」口径一致：下游 `session_step` 要的是
    #   可再解析的**项目语法串**。
    _de_parse = _normalize_diff_equation(raw)
    if _de_parse is not None:
        # ## 收窄守卫（**必须**，否则改变既有输出形式）
        #   仅在「微分项里含 **Function 类型符号**」时才直通 ——
        #   那是下方 `_to_diff` 的 `sympify` **必然失败**的情形
        #   （`sympify('d(u+h)')` 中 `u` 若是 `sp.Function`，
        #    SymPy 抛 `Invalid argument: expecting an expression,
        #    not UndefinedFunction: u` → 静默降级为差式 → **丢等号**）。
        #
        #   其余微分等式（如 `d(u+h)=dh`）SymPy **解析正常**，
        #   必须让原路径继续 —— 它会输出 SymPy 规范化形式
        #   （`d(h + u) = d(h)`，符号按 SymPy 序）。
        #   若一并直通，会输出**用户原序** `d(u+h) = d(h)`，
        #   与既有基线产生**形式差异**（探针 scripts/vdiff.py #E3 实测）。
        _lm = _compile_symbols(symbols) or _build_locals(var_names)
        _toks = set(_IDENT_RE.findall(
            str(_de_parse.get("lhs") or "") + " "
            + str(_de_parse.get("rhs") or "")
        ))
        if any(isinstance(_lm.get(_t), sp.FunctionClass) for _t in _toks):
            _dl = str(_de_parse.get("lhs") or "").strip()
            _dr = str(_de_parse.get("rhs") or "").strip()
            _ls = ("d(%s)" % _dl) if _de_parse.get("lhsIsDiff") else _dl
            _rs = ("d(%s)" % _dr) if _de_parse.get("rhsIsDiff") else _dr
            _ds = "%s = %s" % (_ls, _rs)
            _dfree = sorted({
                _t for _t in _IDENT_RE.findall(_ds)
                if _t != "d" and _t not in _IMPLICIT_MUL_FUNCS
                and _t not in _IMPLICIT_MUL_CONSTS
            })
            return {
                "sympy_expr": _ds,
                "variables": _dfree,
                "free_symbols": _dfree,
                "is_equation": True,
                "detected_functions": sorted(parse_holder.get("functions") or []),
            }

    # --- 值集合通道（轮次 E）---
    # 为什么必须早于 _to_diff（实测确认的 bug）：
    #   `x=23,y=12` 会被 _split_chain 切成 3 段 ['x', '23,y', '12']，
    #   而 _to_diff 对链式**静默取末段** → 回传 "12"，"x=23" 那一半被丢弃。
    #   下游 verify_equiv 因此只看到 `y=12`，表现为「只识别到一个答案」。
    # 复用轮次 D 已实现的 _detect_value_set（实测已能区分 `x=23,y=12` 与 `a=b=c`）。
    try:
        vs = _detect_value_set(raw, var_names)
    except Exception:  # noqa: BLE001
        vs = None
    if vs and vs[1]:
        vs_items = vs[0]
        vs_free = sorted({s.name for it in vs_items for s in it.free_symbols})
        return {
            "sympy_expr": ", ".join(sp.sstr(it) for it in vs_items),
            "variables": vs_free,
            "free_symbols": vs_free,
            "is_equation": False,
            "is_value_set": True,
            "value_set": [sp.sstr(it) for it in vs_items],
            "detected_functions": sorted(parse_holder.get("functions") or []),
        }

    expr, is_eq = _to_diff(
        raw, var_names, allow_equation=True, holder=parse_holder,
        function_names=func_names, symbol_table=sym_table,
    )
    free = sorted(expr.free_symbols, key=lambda s: s.name)

    # --- 链式等式：保留全部段（轮次 E）---
    # 为什么需要：_to_diff 对链式取末段，末段若非等式会把 is_eq 置 False
    # （实测 `a=b=c` → expr=c, is_eq=False），下游因此把用户的**方程**
    # 误判为「表达式」，走错判定口径（equationRelation 变成 expected_equation_only）。
    # 此处回传全部段，让判定侧按「等式对」语义处理（见 cmd_verify_equiv 的链式分支）。
    _norm_text = parse_holder.get("text")
    _chain_segs = _split_chain(_norm_text) if isinstance(_norm_text, str) else None
    if _chain_segs and len(_chain_segs) > 2:
        _chain_free = set()
        for _seg in _chain_segs:
            try:
                _chain_free |= sp.sympify(_seg, locals=_build_locals(var_names)).free_symbols
            except Exception:  # noqa: BLE001
                continue
        _chain_names = sorted(s.name for s in _chain_free)
        return {
            "sympy_expr": " = ".join(_chain_segs),
            "variables": _chain_names,
            "free_symbols": _chain_names,
            "is_equation": True,
            "is_chain": True,
            "chain_segments": _chain_segs,
            "detected_functions": sorted(parse_holder.get("functions") or []),
        }

    sympy_str = sp.sstr(expr)
    if is_eq:
        # 轮次 E 修复：此处原先直接传 `symbols`（调用方给的**原始参数**），
        # 但 _strip_implicit_mul 期望的是「符号名字符串列表」。
        # 当调用方传 dict 形态符号表（{"x": {...}}）时，
        # `set(list(symbol_names))` 会抛 TypeError: unhashable type: 'dict'
        # （实测确认）—— 使所有「等式 parse」直接崩成 INTERNAL_ERROR。
        # 改用已从符号表正确提取的 var_names + func_names（均为字符串）。
        #
        # --- 轮次 O 修复（关键，GUI 实测缺陷）---
        # **复用 `_to_diff` 已归一好的串**（`parse_holder["text"]`），
        # 而不是拿 `raw` 重新归一。
        #
        # 为什么必须改：`_to_diff` 的 LaTeX 优先通道会把
        #   `2x+3y=2x+3\left(kx-7\right)`
        # 正确转成项目语法 `2*x+3*y = 2*x+3*k*x-21` 并存入 `holder["text"]`；
        # 而此处若用 raw 重跑 `_strip_implicit_mul`，`\left(` 会被当成
        # 函数调用 `left(...)` 保留下来 → `sympify(rhs)` 抛「未定义 left」
        # → 落入下方 except 分支**静默退回差式** → `sympy_expr` **丢掉等号**。
        #
        # 后果链（实测确认）：下游 `session_step` 收到的是「表达式」而非「等式」
        # → `_sympify_relation` 得 `Add` 对象 → `is_Relational=False`
        # → 前提链整条判定退化为 `unknown`（界面上显示为「引擎超时」）。
        #
        # 触发面比想象中广：MathLive 的 `smartFence=true` 会把**任何**圆括号
        # 自动升级为 `\left( \right)`，故「输入里带括号」即触发本缺陷。
        text = (
            _norm_text
            if isinstance(_norm_text, str) and _norm_text.strip()
            else (raw or "")
        ).strip()
        if text.startswith("$") and text.endswith("$"):
            text = text[1:-1]
        lhs, rhs = _split_equation(text)
        # --- 轮次 Q 修复（与 O-1 同源，实测确认）---
        # 此处原为 `_build_locals(var_names + func_names)` —— 它把**函数名**
        # 也建成 `sp.Symbol`，于是 `sympify('F(h)', {F: Symbol})` 抛
        #   `TypeError: 'Symbol' object is not callable`
        # → 落入下方 except → `sympy_str` 退回差式且 `is_eq=False`
        # → **等式被降级为表达式**（等号丢失），下游 `session_step` 收到
        #   `-h**2 + F(h)` 这种裸表达式，判定退化为 `unknown/not_applicable`。
        #
        # 实测对照（场景声明 F 为函数、h 为变量）：
        #   parse('F(h)=h**2')  → 修复前: '-h**2 + F(h)', is_equation=False ❌
        #                       → 修复后: 'F(h) = h**2',  is_equation=True  ✅
        #   parse('y=x**2')     → 'y = x**2', is_equation=True（非函数等式本就正常）
        #
        # 为什么改用 `_compile_symbols`（而非简单去掉 func_names）：
        #   它按 `kind` 产出正确的 SymPy 对象（function → `sp.Function`，
        #   variable → `sp.Symbol`），与 `session_step` 侧**同一套**符号构造，
        #   避免两处语义分叉。实测 `sympify('F(h)', locals=...)` → `F(h)`，
        #   与 `_to_diff` 的产物形式一致（AppliedUndef），下游可正常代入函数体。
        locals_map = _compile_symbols(symbols) or _build_locals(var_names)
        try:
            lhs_s = sp.sstr(sp.sympify(lhs, locals=locals_map))
            rhs_s = sp.sstr(sp.sympify(rhs.strip(), locals=locals_map))
            sympy_str = f"{lhs_s} = {rhs_s}"
        except Exception:  # noqa: BLE001
            # 规范化失败仍退回差式字符串（保证判定链路可降级运行），
            # **但必须把 `is_eq` 同步置 False**。
            #
            # 轮次 O 修正：旧实现只改 `sympy_expr` 而 `is_equation` 仍返回 True，
            # 造成 `sympy_expr="-3*k*x + 3*y + 21"` 却 `is_equation=True`
            # 的**自相矛盾**（实测确认）—— 下游既拿不到等式、又被告知"这是等式"，
            # 无法做出任何正确判断。置 False 后语义自洽：给出的确实不是等式。
            sympy_str = sp.sstr(expr)
            is_eq = False

    return {
        "sympy_expr": sympy_str,
        "variables": [s.name for s in free],
        "free_symbols": [s.name for s in free],
        "is_equation": is_eq,
        # 函数识别透明化：parse 也回传，便于前端展示「已识别为函数」
        "detected_functions": sorted(parse_holder.get("functions") or []),
    }


def _relative_error(a, b):
    """
    计算 a 相对 b 的误差（0~1，用于 numerical_error 指标）。
    仅当两侧均为纯数值（无自由符号）时可算；否则返回 None。

    为什么要由引擎算：该指标在提示词中定义为「0~1 的相对误差，目标 ≤0.05」。
    若交给 LLM 生成，LLM 无法真正计算，只能猜值，指标便退化成
    「对=0 / 错=1」的二值，与设计意图不符（原则 10：系统能算的不交 LLM）。
    """
    try:
        if a.free_symbols or b.free_symbols:
            return None
        fa = complex(a.evalf())
        fb = complex(b.evalf())
        if any(x != x or abs(x) == float("inf") for x in (fa.real, fa.imag, fb.real, fb.imag)):
            return None
        return abs(fa - fb) / max(1.0, abs(fb))
    except Exception:
        return None


def _verify_equiv_core(args) -> dict:
    """等价性判定**核心**：五级兜底 + 三条等式感知策略（0.4 / 0.5 / 0.6）。

    等式输入统一归一为差式（lhs-rhs）参与判定，同时保留「是否等式」标记，
    使「方程 vs 方程」按成比例判定、「方程 vs 表达式」按「是否为该方程的解」判定。

    函数记法与链式等式的处理（本轮新增）：
    - **函数定义** `A(x) = x*(40-2*x)` → 取**右侧**参与判定（左侧函数名不是变量）
    - **链式等式** `a = b = c` → 主判定取**末段**（按等价性策略）+ 相邻段**自洽校验**；
      后者不自洽时降级为 warn 并指出段号，避免「笼统说写错了」
    - **常量赋值** `x0 = 1` → 右侧无自由符号，标记 equationKind='assignment'
    """
    # 符号表先解析：函数名要传给扫描器，否则 A(x) 会被读成 A*x
    symbol_table = _symbol_table_to_dict(args.get("symbols"))
    declared_names = set(symbol_table.keys())
    var_names, func_names = _split_symbol_table(symbol_table)

    user_raw = args.get("user_expr")
    expected_raw = args.get("expected_expr")

    # --- 块 E：不等式等价判定（**必须最先**，早于任何 _to_diff 调用） ---
    # 为什么必须最早：`_to_diff` 对 `0 < x < 20` 会因 Python 链式比较强制求布尔值
    # 而抛 "cannot determine truth value of Relational"（实测确认）。
    # 若把本判定放在 _to_diff 之后，整条命令在到达此处前就已失败，
    # 表现为 `equivalent: None`（命令级 PARSE_ERROR），而非「判不出」。
    #
    # 为什么单独成轨：不等式不产生「差式 = 0」语义，其等价判据是
    # 「子式集合相同 + 方向一致（或同乘正数）」，与方程的成比例判定不同构。
    u_ineq = _split_ineq_chain(user_raw, var_names, func_names)
    e_ineq = _split_ineq_chain(expected_raw, var_names, func_names)
    if u_ineq or e_ineq:
        ineq_verdict = _ineq_equivalent(u_ineq, e_ineq)
        # 判等价 → 直接采信；判不等价 → 也直接采信（不等式语义已足够明确）；
        # 仅「一方是不等式、另一方不是」等无法判定情形（None）才交回后续策略。
        if ineq_verdict is True:
            return {
                "equivalent": True,
                "strategyLevel": 0.3,
                "strategy": "inequality_equivalent",
                "difference": "0",
                "equationRelation": "inequality",
                "equationKind": "inequality",
            }
        if ineq_verdict is False and u_ineq and e_ineq:
            return {
                "equivalent": False,
                "strategyLevel": 0.3,
                "strategy": "inequality_not_equivalent",
                "difference": "\u4e0d\u7b49\u5f0f\u7ea6\u675f\u4e0d\u540c",
                "equationRelation": "inequality",
                "equationKind": "inequality",
            }

    # 函数名在扫描时全程有效（用户可能写 A(x)，参考解也可能写 A(x)）
    user_holder = {}
    user_expr, u_is_eq = _to_diff(
        user_raw, var_names, allow_equation=True,
        holder=user_holder, function_names=func_names, symbol_table=symbol_table,
    )
    e_holder = {}
    expected_expr, e_is_eq = _to_diff(
        expected_raw, var_names, allow_equation=True, holder=e_holder,
        function_names=func_names, symbol_table=symbol_table,
    )

    # 结构分类（expression / definition / assignment / chain）
    user_text = user_holder.get("text") or (user_raw or "")
    user_segments = _split_chain(user_text)
    equation_kind = _classify_equation(user_segments, var_names, user_holder)
    chain_check = None
    if equation_kind == "chain" and user_segments:
        chain_check = _check_chain_consistency(user_segments, var_names)

    # --- 链式等式：展开为等式对，与参考解交叉匹配（轮次 E）---
    # 规则（用户确认）：
    #   1) 比对单位必须是**方程** —— 不得拿单值/表达式去比方程
    #      （实测：把 `a` / `b` / `c` 单独与 `2*x+y=40` 比，三条全 False）
    #   2) 任意一对匹配即可（A）
    #   3) 跳过中间段 → 通过（因为任意两段都在候选对里）
    #   4) 多出段 → 通过，不加提示（B）
    # 为什么放在这里：必须在下方「chain 取末段」的 target_text 逻辑之前拦截，
    # 否则 user_expr 会被改写成末段，等式语义再度丢失。
    if equation_kind == "chain" and user_segments and len(user_segments) >= 2:
        _exp_text = e_holder.get("text") or (expected_raw or "")
        _exp_segs = _split_chain(_exp_text)
        if _exp_segs and len(_exp_segs) >= 2:
            # 参考解的等式对（相邻段）
            _e_pairs = [
                (_exp_segs[i], _exp_segs[i + 1])
                for i in range(len(_exp_segs) - 1)
            ]
            # 用户的**相邻**等式对（a=b / b=c —— 轮次 F 起不再取 a=c 全组合）
            _u_adjacent = [
                (user_segments[i], user_segments[i + 1])
                for i in range(len(user_segments) - 1)
            ]

            # 轮次 F 修正：判据由「任意一对命中即通过」改为「**所有相邻对**都必须合格」。
            #
            # 为什么必须改（用户实测反馈）：
            #   `2*x+y=40=y+99`（第三段明显算错）原先判通过 —— 因为 (2*x+y, 40)
            #   这一对命中了参考解，整个链式被放过，(40, y+99) 从未被校验。
            #   `10=2*x+y=40`（第一段错）同理。用户要求「故意算错必须被抓住」。
            #
            # 合格口径（满足其一）：
            #   A) 该相邻对等价于参考解的某个等式对（交给 _verify_equiv_core）
            #   B) 该相邻对「合法引入新物理量」（差异含前段独有、后段没有的符号，
            #      如 `面积=xy=x(40-2x)`），见 _chain_pair_introduces_symbol
            # 皆不满足 → 该对错误 → 整条链式判否。
            _bad_index = None
            for _idx, (_ui, _uj) in enumerate(_u_adjacent):
                _hit = False
                for _e1, _e2 in _e_pairs:
                    try:
                        _sub = _verify_equiv_core(dict(
                            args,
                            user_expr=f"{_ui} = {_uj}",
                            expected_expr=f"{_e1} = {_e2}",
                        ))
                    except Exception:  # noqa: BLE001
                        continue
                    if _sub.get("equivalent") is True:
                        _hit = True
                        break
                if not _hit:
                    # 传入参考解各段：豁免必须先确认该对与参考解有关联（轮次 F）
                    _hit = _chain_pair_introduces_symbol(
                        _ui, _uj, var_names, ref_segs=_e_pairs and [
                            _s for _p in _e_pairs for _s in _p
                        ]
                    )
                if not _hit and _bad_index is None:
                    _bad_index = _idx

            # --- 轮次 J 修复：chain_check 必须**参与判定**，不得只当装饰品 ---
            #
            # 为什么必须修（`docs/archive/plans/implementation_plan_s4_function.md` 已登记为
            # 「我的实现缺陷」，本轮兑现）：
            #   `_check_chain_consistency` 对 `1=2=3` 这类**纯数值不自洽**
            #   的链式，早已算出 `{ok: False, failAtIndex: 1}`，
            #   但此处原先无条件返回 `equivalent: True`，只把 chain_check
            #   塞进输出字段 —— 正确结论被静默丢弃（探针实测确认）。
            #
            # 触发范围**仅限纯数值不自洽**（`1=2=3`、`5=7=9`）：
            #   `_check_chain_consistency` 内部对「差式含自由符号」的相邻段
            #   一律跳过（见其轮次 E 修正），故 `2*x+y=40=y+2*x` 这类
            #   含符号的正确推导**不会**被本分支拦截，行为完全不变。
            #
            # 为什么在这条分支判否是安全的：
            #   「两侧均为纯数值且不相等」（如 1 与 2）是数学上**确定不成立**
            #   的命题，不存在符号假设/化简能力的歧义空间，
            #   不属 `weakNegative`（证据不足）情形，可直接下结论。
            if chain_check is not None and not chain_check.get("ok", True):
                _ci = chain_check.get("failAtIndex")
                return {
                    "equivalent": False,
                    "strategyLevel": 0.7,
                    "strategy": "chain_inconsistent",
                    "difference": chain_check.get("detail") or "链式等式相邻段不自洽",
                    "equationRelation": "both_equation",
                    "equationKind": "chain",
                    "chainCheck": chain_check,
                    "_chainFailIndex": _ci,
                }

            if _bad_index is None:
                _ok_out = {
                    "equivalent": True,
                    "strategyLevel": 0.7,
                    "strategy": "chain_all_pairs_match",
                    "difference": "0",
                    "equationRelation": "both_equation",
                    "equationKind": "chain",
                }
                if chain_check is not None:
                    _ok_out["chainCheck"] = chain_check
                return _ok_out

            # 有相邻对不合格 → 用户明确要求判否（轮次 F 决策）
            _fail_out = {
                "equivalent": False,
                "strategyLevel": 0.7,
                "strategy": "chain_pair_mismatch",
                "difference": (
                    f"链式等式第 {_bad_index + 1} 段与第 {_bad_index + 2} 段"
                    f"既不等价于参考解，也不构成合法变形"
                ),
                "equationRelation": "both_equation",
                "equationKind": "chain",
            }
            if chain_check is not None:
                _fail_out["chainCheck"] = chain_check
            return _fail_out
        # 参考解不是等式对（如单段表达式）→ 无法按等式对交叉匹配
        _miss = {
            "equivalent": "unknown",
            "strategyLevel": 0.7,
            "strategy": "chain_no_ref_pair",
            "difference": "参考解不含等式对，无法与链式等式交叉匹配",
            "equationRelation": "both_equation",
            "equationKind": "chain",
            "weakNegative": True,
        }
        if chain_check is not None:
            _miss["chainCheck"] = chain_check
        return _miss

    # --- 函数定义 / 链式等式：重定参与判定的「用户侧表达式」 ---
    # 函数定义 A(x)=body → 取**右侧**（函数名不是变量，带入比较会凭空多出自由符号）
    # 链式等式 a=b=c   → 取**末段**（用户一路推导到最后的那个式子）
    # 常量赋值 x0=1    → 取右侧（它定义常量，不是要推导的结论）
    def _body_side(segs):
        """函数定义式里「函数体」所在的下标：`f(x)=body` → 1；`body=f(x)` → 0。

        轮次 H：与 `_classify_equation` 的对称化配套 —— 只有取到**函数体**那一侧，
        才能与另一侧的表达式做有意义的比对。
        """
        if _is_function_notation(segs[0], var_names):
            return 1
        return 0

    target_text = None
    if equation_kind == "definition" and user_segments and len(user_segments) == 2:
        target_text = user_segments[_body_side(user_segments)]
    elif equation_kind == "assignment" and user_segments and len(user_segments) == 2:
        target_text = user_segments[1]
    elif equation_kind == "chain" and user_segments:
        target_text = user_segments[-1]

    if target_text:
        user_expr, u_is_eq = _to_diff(
            target_text, var_names, allow_equation=False,
            function_names=func_names, symbol_table=symbol_table,
        )

    # --- 参考解侧对称处理（轮次 H 修复「两侧不对称」缺陷）---
    #
    # 为什么必须对称（实测确认的缺陷）：
    #   `f(x)=x^2+1` vs `f(x)=x^2+1`（两侧完全一样的函数定义）原先判 False ——
    #   因为只有用户侧走了「取函数体」逻辑（取到 x^2+1），
    #   参考解侧仍走差式（f(x)-(x^2+1)，代入 body 后为 0）→ x^2+1 vs 0 → 误判。
    expected_text = e_holder.get("text") or (expected_raw or "")
    expected_segments = _split_chain(expected_text)
    expected_kind = _classify_equation(expected_segments, var_names)
    if expected_kind == "definition" and expected_segments and len(expected_segments) == 2:
        expected_expr, e_is_eq = _to_diff(
            expected_segments[_body_side(expected_segments)], var_names,
            allow_equation=False, function_names=func_names,
            symbol_table=symbol_table,
        )

    if u_is_eq and e_is_eq:
        equation_relation = "both_equation"
    elif u_is_eq:
        equation_relation = "user_equation_only"
    elif e_is_eq:
        equation_relation = "expected_equation_only"
    else:
        equation_relation = "none"

    # 数值误差：等式不产生「数值答案」语义，故等式场景强制不报该指标
    rel_err = None
    if not (u_is_eq or e_is_eq):
        rel_err = _relative_error(user_expr, expected_expr)

    # 统一两侧的自由符号为同一批 Symbol 实例
    all_names = sorted({s.name for s in (user_expr.free_symbols | expected_expr.free_symbols)})
    locals_map = _build_locals(all_names)
    if all_names:
        remap = {sp.Symbol(n): locals_map[n] for n in all_names}
        user_expr = user_expr.subs(remap)
        expected_expr = expected_expr.subs(remap)

    # 规则 C 命中时回填重命名映射（供前端降级 warn 并生成提示话术）
    rename_holder = {}

    strategies = [
        # 级别 0：纯数值容差（必须先于级别 1，否则浮点误差会被 simplify 判 False 并短路）
        (0, "numeric_exact", lambda: _strategy_numeric_exact(user_expr, expected_expr)),
        # 级别 0.4：两侧皆为方程 → 成比例等价（规则 A）
        (0.4, "equation_proportional",
         lambda: _strategy_eq_proportional(user_expr, expected_expr, u_is_eq, e_is_eq)),
        # 级别 0.5：一侧方程一侧表达式 → 该方程是否以该表达式为解（规则 B）
        (0.5, "equation_implicit",
         lambda: _strategy_eq_implicit(user_expr, expected_expr, u_is_eq, e_is_eq)),
        # 级别 0.6：未声明符号重命名（规则 C，命中即 warn）
        (0.6, "symbol_rename",
         lambda: _strategy_rename_undeclared(
             user_expr, expected_expr, declared_names, u_is_eq, e_is_eq, rename_holder
         )),
        (1, "simplify_diff", lambda: _strategy_simplify_diff(user_expr, expected_expr)),
        (2, "simplify_expand_diff", lambda: _strategy_expand_diff(user_expr, expected_expr)),
        (3, "ratio_minus_one", lambda: _strategy_ratio(user_expr, expected_expr)),
        (4, "sympy_equals", lambda: _strategy_equals(user_expr, expected_expr)),
        (5, "numeric_sampling", lambda: _strategy_numeric(user_expr, expected_expr, symbol_table)),
    ]

    def _result(equivalent, level, name, difference, weak_negative=False):
        """统一返回构造：带回数值误差、等式关系、重命名映射、函数识别、结构类别。

        weak_negative=True 表示「否定结论证据不足」（修复 C）：引擎虽判不等价，
        但数值采样未能给出明确否定（返回 None 而非 False），此时前端应交 LLM 复核 ——
        避免因符号缺正值假设导致用户写对却被判红叉。
        """
        out = {
            "equivalent": equivalent,
            "strategyLevel": level,
            "strategy": name,
            "difference": difference,
            "equationRelation": equation_relation,
            "equationKind": equation_kind,
        }
        if rel_err is not None:
            out["relative_error"] = round(min(1.0, rel_err), 9)
        mapping = rename_holder.get("mapping")
        if mapping:
            out["renamedSymbols"] = mapping
            # 靠重命名才判等价 → 前端应降级为 warn（既宽松又有教学提示）
            out["warnOnly"] = True
        # 函数识别透明化：让用户与 LLM 知道哪些标识符被当成了函数
        funcs = sorted(user_holder.get("functions") or [])
        if funcs:
            out["detectedFunctions"] = funcs
        # 链式等式自洽校验结果（仅链式时出现）；不自洽则降级为 warn
        if chain_check is not None:
            out["chainCheck"] = chain_check
            if not chain_check.get("ok", True):
                out["warnOnly"] = True
        if weak_negative:
            out["weakNegative"] = True
        return out

    # --- 修复 B：False 不再立即短路（延迟否定） ---
    # 为什么必须改（实测确认）：级别 1 的 simplify_diff 在**符号缺正值假设**时会
    # 误判 False —— 例 sqrt(c**2 - v**2) 与 c*sqrt(1 - v**2/c**2) 在 c>0 时恒等，
    # 但无假设时 SymPy 无法把 c**2 提出根号（sqrt(c**2)=|c|），化简停在原地。
    # 而 False 一旦短路，级别 2~5 根本轮不到执行 —— 实测级别 5（数值采样）
    # 对该类式子判等**正确**，却永远没机会开口。
    # 故改为：记录首个否定并继续跑完全部策略；若后续有策略判 True 则以 True 为准；
    # 全部跑完仍无 True，才以首个否定作为结论返回。
    weak_false = None       # (level, name)，首个否定结论
    weak_diff = ""

    for level, name, fn in strategies:
        verdict = fn()
        if verdict is True:
            return _result(True, level, name, "0")
        if verdict is False and weak_false is None:
            weak_false = (level, name)
            try:
                weak_diff = sp.sstr(sp.simplify(user_expr - expected_expr))
            except Exception:
                weak_diff = ""

    if weak_false is not None:
        # --- 修复 C：区分「硬否定」与「弱否定」---
        # 硬否定 = 数值上确凿对不上（级别 5 返回明确 False）→ 直接采信，终局。
        # 弱否定 = 所有策略都推不动、数值采样也拿不到有效点（None）
        #          → 证据不足，标记 weakNegative 交前端走 LLM 复核（方案 B）。
        hard = weak_false[1] == "numeric_sampling"
        if not hard:
            try:
                hard = _strategy_numeric(user_expr, expected_expr, symbol_table) is False
            except Exception:
                hard = False
        return _result(
            False, weak_false[0], weak_false[1], weak_diff,
            weak_negative=(not hard),
        )

    try:
        diff_str = sp.sstr(sp.simplify(sp.expand(user_expr - expected_expr)))
    except Exception:
        diff_str = "(unable to simplify)"
    return _result("unknown", 0, "none", diff_str)


def _detect_value_set(raw, var_names):
    """尝试把输入解析为**值集合**；不是集合形态则返回 None（轮次 D）。

    集合形态判定（避免与普通表达式 / 不等式混淆）：
    - 必须含集合分隔符（中英文逗号、分号、or）或外层集合括号（`(` / `[`）
    - 解析出的每一项必须是「非 Relational 的 Expr」
      （排除 `x>0` 这类约束 —— 它们是关系式而非值）

    为什么要这道防护：`x>0,y>0` 也含逗号，若不排除 Relational，
    约束组会被误当成「值集合 {x>0, y>0}」去比对，语义完全错位。
    """
    if not isinstance(raw, str) or not raw.strip():
        return None
    text = raw.strip()
    if not (_SET_SEP_RE.search(text) or text.startswith("(") or text.startswith("[")):
        return None
    try:
        items, is_set = _parse_value_set(raw, var_names)
    except ValueError:
        return None
    if not items:
        return None
    # 轮次 E 守卫：原文含等号、且解析结果含自由符号 → 语义有歧义
    # （可能是 `a=b,c=d` 这类并列方程，而非「多值答案」），不按值集合处理。
    # 多值答案的典型写法（`x1=1, x2=5` / `(1,5)` / `1,5` / `x=1 or x=5`）
    # 均为纯数值右侧，或无等号，故不受影响。
    if "=" in text and any(it.free_symbols for it in items):
        return None
    for it in items:
        # 排除关系式（x>0 这类约束）。用 is_Relational 属性而非 isinstance 判断，
        # 因 sympy 顶层并未导出 Relational 类（实测 sp.Relational 不存在，
        # 直接引用会抛 AttributeError 使整条命令失败）。
        if getattr(it, "is_Relational", False):
            return None
        try:
            if any(getattr(a, "is_Relational", False) for a in it.atoms()):
                return None
        except Exception:
            return None
    return items, is_set


def _constraints_to_subs(cons, var_names):
    """把约束字符串列表逐条解析为不等式子式；任一条失败返回 None（轮次 D）。

    **为什么必须逐条解析、不可拼接**（实测踩坑）：
    若把 ["x>0", "y>0"] 用 ", ".join() 拼成 "x>0, y>0" 再交给 _split_ineq_chain，
    逗号会被 `sp.sympify("0, y")` 解析成 **Python tuple**，
    随后 `_norm_ineq` 计算 `Symbol - tuple` 抛 TypeError（实测确认）。
    逐条解析则每条都是干净的单不等式，不产生逗号歧义。
    """
    if not cons:
        return None
    out = []
    for c in cons:
        subs = _split_ineq_chain(c, var_names, None)
        if not subs:
            return None
        out.extend(subs)
    return out or None


def cmd_verify_equiv(args) -> dict:
    """等价性判定**外层**：值集合口径 + 约束组联合裁定 + 常规核心（轮次 D）。

    三类板块的比对策略（用户确认的决策 1① / 2①）：

    **A. 结论块 —— 多值答案**（级别 0.2）
        `x1=1, x2=5` / `(1,5)` / `1,5` / `x=1 or x=5` 统一识别为值的集合，
        按「集合大小相同 + 元素一一等价」判定，**不匹配变量名**（决策 2①）。
        先于常规核心执行 —— 否则 `x1=1, x2=5` 会被 _split_chain 当成链式等式，
        静默取末段 `5`，造成「答案不完整却判对」的严重假阳性（实测确认）。

    **B. 过程推导块 —— 等式 + 不等式限定**（如 `xy=4 (x>0,y>0)`）
        主式走常规核心（方程成比例口径），约束组走不等式口径，
        **两者都通过才算通过**；
        用户未写约束而参考解有 → 主式判过时降级为 warn（决策 1①），
        提示「建议补上定义域」但不冤枉学生。

    **C. 常规**（无集合、无约束）→ 直通核心，行为与轮次 C 完全一致。
    """
    symbol_table = _symbol_table_to_dict(args.get("symbols"))
    var_names, _func_names = _split_symbol_table(symbol_table)
    user_raw = args.get("user_expr")
    expected_raw = args.get("expected_expr")

    # ---------- 0. 用户函数声明注入（R1~R7，轮次 H）----------
    # 为什么放在最前：用户可能在本条输入里「首次定义函数」并立即使用
    # （`x^2+1 = f(x) = x+1`）。先收集声明并合并进 symbols，
    # 下游 `_symbol_table_to_dict` → `_apply_function_bodies` 即可自动完成：
    #   f(2) → 5、f(x+1) → 展开、f(t) → 换变量、f'(x) → 求导（实测确认）
    # 两侧都收集：用户侧与参考解侧都可能出现首次定义。
    try:
        _user_decls = {}
        _user_decls.update(_iter_user_function_decls(user_raw, var_names, _func_names))
        _user_decls.update(_iter_user_function_decls(expected_raw, var_names, _func_names))
    except ValueError as e:
        # R6：同一输入内重复声明 → 回传专用错误码（用户选择「报错」）
        raise _FunctionRedefined(str(e))
    if _user_decls:
        args = dict(args)
        args["symbols"] = _merge_decls_into_symbols_arg(args.get("symbols"), _user_decls)
        symbol_table = _symbol_table_to_dict(args.get("symbols"))
        var_names, _func_names = _split_symbol_table(symbol_table)

    # ---------- 0b. 未声明函数的数字调用检查（R8，用户规定「报错」）----------
    # 放在声明收集**之后**：本条输入里刚声明的函数应视为已声明。
    # 只检查「数字实参」（`f(2)`）—— 表达式实参（`a(x+1)`）按 R3 走乘法。
    _check_undeclared_func_call(user_raw, var_names, _func_names)

    # ---------- A. 值集合（多值答案）----------
    u_set = _detect_value_set(user_raw, var_names)
    e_set = _detect_value_set(expected_raw, var_names)
    if u_set or e_set:
        # 仅当至少一侧是**多值集合**才启用集合口径；单值交常规核心
        # （保持 `x=2` vs `2` 这类既有判定的行为完全不变）
        if (u_set and u_set[1]) or (e_set and e_set[1]):
            # 单侧是集合、另一侧是「单值」时，把单值也解析为集合再比
            # （轮次 D 修复）：`x1=1` vs `(1,5)` 应判「个数不同 → 不等价」，
            # 而非落到 unknown。此前单值侧返回 None 直接交 LLM，属过度保守。
            if u_set:
                ua = u_set[0]
            else:
                try:
                    ua = _parse_value_set(user_raw, var_names)[0]
                except ValueError:
                    ua = None
            if e_set:
                eb = e_set[0]
            else:
                try:
                    eb = _parse_value_set(expected_raw, var_names)[0]
                except ValueError:
                    eb = None
            if ua is None or eb is None:
                return {
                    "equivalent": "unknown",
                    "strategyLevel": 0.2,
                    "strategy": "value_set_partial",
                    "difference": "一方为多值集合，另一方无法解析为集合",
                    "equationRelation": "none",
                    "equationKind": "value_set",
                    "weakNegative": True,
                }
            verdict = _value_set_equivalent(ua, eb, symbol_table)
            if verdict is None:
                return {
                    "equivalent": "unknown",
                    "strategyLevel": 0.2,
                    "strategy": "value_set_unknown",
                    "difference": "值集合无法判定",
                    "equationRelation": "none",
                    "equationKind": "value_set",
                    "weakNegative": True,
                }
            return {
                "equivalent": verdict,
                "strategyLevel": 0.2,
                "strategy": "value_set" if verdict else "value_set_not_equivalent",
                "difference": "0" if verdict else "值集合不一致",
                "equationRelation": "none",
                "equationKind": "value_set",
                "valueSet": {
                    "user": [sp.sstr(x) for x in ua],
                    "expected": [sp.sstr(x) for x in eb],
                },
                # 靠集合口径判不出等价时证据可能不足（如含未声明符号），交 LLM 复核
                "weakNegative": (not verdict),
            }

    # ---------- B. 约束组（等式 + 不等式限定）----------
    u_main, u_cons = _split_constraints(user_raw)
    e_main, e_cons = _split_constraints(expected_raw)

    if not u_cons and not e_cons:
        # 无约束 → 直通核心（C. 常规，行为与轮次 C 一致）
        return _verify_equiv_core(args)

    # 主式判定：把约束摘掉后交核心
    core_args = dict(args)
    core_args["user_expr"] = u_main
    core_args["expected_expr"] = e_main
    core = _verify_equiv_core(core_args)

    # 约束判定：逐条解析（不可拼接，见 _constraints_to_subs 的说明）
    u_subs = _constraints_to_subs(u_cons, var_names)
    e_subs = _constraints_to_subs(e_cons, var_names)
    cons_verdict = None
    if u_subs and e_subs:
        cons_verdict = _ineq_equivalent(u_subs, e_subs)

    main_ok = core.get("equivalent") is True

    # 合并裁定
    out = dict(core)
    out["equationKind"] = core.get("equationKind") or "constrained"
    out["userConstraints"] = u_cons
    out["expectedConstraints"] = e_cons

    if not main_ok:
        # 主式就不对：约束是否匹配已无意义，沿用主式结论
        return out

    if not e_cons:
        # 参考解本身无约束 → 约束不参与评判，直接采信主式结论
        return out

    if not u_cons:
        # 决策 1①：用户漏写定义域而参考解有 → 主式判过，但降级 warn 提示补齐
        out["warnOnly"] = True
        out["strategy"] = "constraint_missing"
        out["strategyLevel"] = 0.25
        out["difference"] = "缺少定义域限定：" + "、".join(e_cons)
        return out

    if cons_verdict is True:
        out["strategy"] = "constrained_equivalent"
        out["strategyLevel"] = 0.25
        return out

    if cons_verdict is False:
        out["equivalent"] = False
        out["strategy"] = "constraint_not_equivalent"
        out["strategyLevel"] = 0.25
        out["difference"] = "定义域限定不一致"
        return out

    # 约束无法判定（如含未声明符号）→ 主式已过，降级 warn 交 LLM 复核
    out["warnOnly"] = True
    out["weakNegative"] = True
    out["strategy"] = "constraint_unknown"
    out["strategyLevel"] = 0.25
    out["difference"] = "定义域限定无法判定"
    return out


def cmd_limit(args) -> dict:
    expr = _sympify(args.get("expr"), None)
    var_name = args.get("var")
    to_str = args.get("to")
    direction = args.get("direction", "both")
    if not var_name or to_str is None:
        raise ValueError("limit 需要 var 与 to 参数")

    # 常量符号代入（变量保留）
    symbol_table = _symbol_table_to_dict(args.get("symbols"))
    subs_map = {}
    for name, info in symbol_table.items():
        if info["kind"] == "constant":
            try:
                subs_map[sp.Symbol(name)] = sp.sympify(info["value"])
            except Exception:
                pass
    if subs_map:
        expr = expr.subs(subs_map)

    var_sym = sp.Symbol(var_name)
    to_expr = sp.sympify(to_str, locals={var_name: var_sym})
    if to_expr.free_symbols and subs_map:
        to_expr = to_expr.subs(subs_map)

    dir_map = {"+": "+", "-": "-", "both": "+-"}
    try:
        result = sp.limit(expr, var_sym, to_expr, dir_map.get(direction, "+-"))
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"求极限失败：{e}")

    try:
        is_finite = bool(result.is_finite)
    except Exception:
        is_finite = False

    return {"result": sp.sstr(result), "is_finite": is_finite, "latex": sp.latex(result)}


def cmd_check_units(args) -> dict:
    """
    单位字符串自检（轻量）。
    完整量纲一致性判断由 LLM 在 scene-compute-analyze 中给出。
    这里只验证单位字符串本身是否合法（非空、无非法字符）。
    """
    var_units = args.get("var_units") or {}
    if not isinstance(var_units, dict):
        return {"units_valid": False, "notes": "var_units 必须是对象"}

    illegal = set("(){}[]$\\")
    for name, unit in var_units.items():
        if not isinstance(unit, str):
            return {"units_valid": False, "notes": f"{name} 的单位不是字符串"}
        if any(ch in illegal for ch in unit):
            return {"units_valid": False, "notes": f"{name} 的单位含非法字符：{unit}"}
    return {"units_valid": True, "notes": "单位字符串格式合法（量纲一致性由模型判断）"}


def cmd_plot_data(args) -> dict:
    """采样绘图。

    等式输入（如 "y = 40-2*x"）取右侧作为绘图表达式 —— 绘图只接受
    「可求值表达式」，方程本身无法直接采样。此处由引擎统一承担，
    前端不必再自行切分等号。
    """
    raw = args.get("expr")
    expr, is_eq = _to_diff(raw, None, allow_equation=True)
    if is_eq:
        text = _strip_implicit_mul((raw or "").strip())
        if text.startswith("$") and text.endswith("$"):
            text = text[1:-1]
        _lhs, rhs = _split_equation(text)
        if rhs:
            expr, _rhs_is_eq = _to_diff(rhs.strip(), None, allow_equation=False)

    var_name = args.get("var")
    if not var_name:
        raise ValueError("plot_data 需要 var 参数")

    rng = args.get("range") or ["0", "1"]
    points = int(args.get("points") or 400)
    constants = args.get("constants") or {}

    var_sym = sp.Symbol(var_name)
    subs_map = {}
    for name, val in constants.items():
        try:
            subs_map[sp.Symbol(name)] = sp.sympify(str(val))
        except Exception:
            pass
    if subs_map:
        expr = expr.subs(subs_map)

    lo = float(sp.sympify(str(rng[0])))
    hi = float(sp.sympify(str(rng[1])))
    step = (hi - lo) / max(1, points - 1)

    xs, ys = [], []
    for i in range(points):
        x = lo + step * i
        try:
            y = complex(expr.subs({var_sym: x}).evalf())
        except Exception:
            continue
        if y.imag != 0 or y.real != y.real or abs(y.real) == float("inf"):
            continue
        xs.append(round(x, 10))
        ys.append(round(y.real, 10))

    return {"x": xs, "y": ys, "xLabel": var_name, "yLabel": "f"}


def cmd_substitute(args) -> dict:
    expr = _sympify(args.get("expr"), None)
    subs_in = args.get("subs") or {}
    subs_map = {}
    for name, val in subs_in.items():
        try:
            subs_map[sp.Symbol(name)] = sp.sympify(str(val))
        except Exception:
            pass
    # 链式代入（修复 §6.2 契约）：
    # SymPy 的 dict.subs() 是「同时代入」语义 —— 传入 {"v": "0.99*c", "c": "1"} 时，
    # v 会被替换成 0.99*c，但这次替换**新引入的 c 不会**再被 c->1 替换，
    # 结果停在 1/sqrt(1 - 0.9801*c**2) 且 is_number=False，与文档期望的数值结果不符。
    # 因此循环代入直到不动点；上限 5 次以避免 a->b, b->a 之类的循环定义造成死循环。
    result = expr
    for _ in range(5):
        next_result = result.subs(subs_map)
        if next_result == result:
            break
        result = next_result

    is_number = bool(result.is_number)
    try:
        latex = sp.latex(sp.N(result, 6)) if is_number else sp.latex(result)
    except Exception:
        latex = sp.sstr(result)
    return {"result": sp.sstr(result), "is_number": is_number, "latex": latex}


def cmd_simplify(args) -> dict:
    """化简表达式；等式输入分别化简两侧并保留等号（用户视角更直观）。"""
    raw = args.get("expr")
    expr, is_eq = _to_diff(raw, None, allow_equation=True)

    if is_eq:
        text = _strip_implicit_mul((raw or "").strip())
        if text.startswith("$") and text.endswith("$"):
            text = text[1:-1]
        lhs, rhs = _split_equation(text)
        try:
            left = sp.simplify(sp.sympify(lhs))
            right = sp.simplify(sp.sympify(rhs.strip()))
            return {"result": f"{sp.sstr(left)} = {sp.sstr(right)}", "latex": sp.latex(left)}
        except Exception:  # noqa: BLE001
            # 落回差式化简结果，保证命令不失败
            pass

    result = sp.simplify(expr)
    return {"result": sp.sstr(result), "latex": sp.latex(result)}


def _eval_real(expr, var_sym, x):
    """在 x 处求 expr 的实数值；无定义 / 复数 / 非有限时返回 None"""
    try:
        val = complex(expr.subs({var_sym: x}).evalf())
    except Exception:
        return None
    # 复数 / NaN / Inf 一律视为该点无定义
    if val.imag != 0 or val.real != val.real or abs(val.real) == float("inf"):
        return None
    return val.real


def cmd_solve_intersections(args) -> dict:
    """
    求两条曲线 y=f(x) 与 y=g(x) 在给定区间内的交点。

    为什么用数值法而不是 sp.solve：
      sp.solve 对超越方程（sin/exp/sqrt 混合）经常无解、给出参数化解、或极慢，
      而本场景的诉求只是「在图上把交点标出来」，数值精度完全够用。
      做法：把区间均分成 N 段，找 h(x)=f(x)-g(x) 的**符号变化**区间，
      再用二分法收敛到 tol 精度。
      符号变化法天然跳过「相切但不变号」的退化情形 —— 那种情形在图上
      也无法稳定标注，强行给点反而误导用户。

    参数：
      expr1 / expr2 : 两条曲线的表达式
      var           : 自变量名
      range         : [lo, hi]
      constants     : 常量表（两侧共用，保证同图可比）
      tol           : 收敛精度（默认 1e-9）
      max_roots     : 最多返回的交点数（默认 20，防强振荡函数刷屏）
      scan_points   : 扫描步数（默认 2000，自动钳制到 [200, 20000]）

    返回：{"count": n, "points": [{"x":..., "y":...}, ...]}
    """
    expr1 = _sympify(args.get("expr1"), None)
    expr2 = _sympify(args.get("expr2"), None)
    var_name = args.get("var")
    if not var_name:
        raise ValueError("solve_intersections 需要 var 参数")

    rng = args.get("range") or ["0", "1"]
    constants = args.get("constants") or {}
    tol = float(args.get("tol") or 1e-9)
    max_roots = int(args.get("max_roots") or 20)

    var_sym = sp.Symbol(var_name)

    # 常量代入（两侧共用同一套，保证同图可比）
    subs_map = {}
    for name, val in constants.items():
        try:
            subs_map[sp.Symbol(name)] = sp.sympify(str(val))
        except Exception:
            pass
    if subs_map:
        expr1 = expr1.subs(subs_map)
        expr2 = expr2.subs(subs_map)

    lo = float(sp.sympify(str(rng[0])))
    hi = float(sp.sympify(str(rng[1])))
    if hi < lo:
        lo, hi = hi, lo

    # 差值函数 h(x) = f(x) - g(x)：h 的零点即交点横坐标
    diff_expr = sp.simplify(expr1 - expr2)

    scan_n = int(args.get("scan_points") or 2000)
    scan_n = max(200, min(scan_n, 20000))
    step = (hi - lo) / scan_n

    roots = []
    prev_x = lo
    prev_h = _eval_real(diff_expr, var_sym, prev_x)

    for i in range(1, scan_n + 1):
        x = lo + step * i
        h = _eval_real(diff_expr, var_sym, x)

        if prev_h is None or h is None:
            prev_x, prev_h = x, h
            continue

        root_x = None

        if h == 0:
            # 采样点恰好落在根上。
            # 必须单独处理：此时 prev_h * h == 0，不满足「异号」条件，
            # 而 x**2 = 2*x 这类整点根在均分网格上极为常见，漏判会让交点凭空消失。
            root_x = round(x, 10)
        elif prev_h == 0:
            # 上一个采样点即根，已在上一轮收录，跳过以避免重复
            prev_x, prev_h = x, h
            continue
        elif prev_h * h < 0:
            # 常规情形：两端异号，二分收敛（80 次足够到机器精度，且有 tol 提前退出）
            a, b = prev_x, x
            ha = prev_h
            for _ in range(80):
                if abs(b - a) < tol:
                    break
                mid = (a + b) / 2
                hm = _eval_real(diff_expr, var_sym, mid)
                if hm is None:
                    break
                if ha * hm <= 0:
                    b = mid
                else:
                    a, ha = mid, hm
            root_x = round((a + b) / 2, 10)

        if root_x is not None:
            # 去重：与已有根距离小于一个扫描步长视为同一个根
            if all(abs(root_x - r["x"]) > step for r in roots):
                y_val = _eval_real(expr1, var_sym, root_x)
                if y_val is not None:
                    roots.append({"x": root_x, "y": round(y_val, 10)})
                    if len(roots) >= max_roots:
                        break

        prev_x, prev_h = x, h

    return {"count": len(roots), "points": roots}


# ==========================================================================
# 会话与前提链判定（轮次 G）
#
# 设计要点（对应《前提链判定架构实施计划》）：
#   1. 判定依据从「与参考答案等价」改为「能否由连线决定的前提推出」。
#   2. 前提是**块**不是条 —— 一个 given 节点承载完整使用条件（函数定义 +
#      常量 + 定义域），连线即全量引用。
#   3. 参考答案比对链路（cmd_verify_equiv 等）**完整保留**，作为本模块
#      无法判定时的兜底。
#
# 会话缓存策略：
#   `_SESSIONS` 只存「不变的符号环境」（locals / 函数名 / 常量事实）。
#   facts / assumptions / domains 每次由前端随调用传入（图会变，不缓存），
#   因此 Python 进程重启后行为完全一致，不会丢状态。
#   调用方也可在 session_step / session_assume 里直接带 symbols 参数，
#   此时即使缓存 miss 也能自动重建（完全无状态可用）。
# ==========================================================================

try:
    from sympy.core.function import AppliedUndef as _AppliedUndef
except Exception:  # noqa: BLE001
    _AppliedUndef = ()

_SESSIONS = {}

# 判定核心委托到 premise_engine。
# 为什么必须换掉 sp.satisfiable：它把关系式当作**不可解释的原子命题**，
# 不做代数化简 —— 探针实测确认它导致 `sqrt(c**2) = c`（c>0）、
# 前提 `x=1` 推出 `x=2` 的否定、`2*x+y=40` 推出 `y=40-2*x` 全部判不出。
import premise_engine  # noqa: E402
# 结构分析层（奇点 / 极限 / 值域 / 零点集）。
#
# **必须模块级导入**（轮次 L 修复的真实缺陷）：
#   此前只有 `_var_domain` 内部做了「函数内局部 import」，
#   而 `_judge_atomic` 的「孤立节点确定性判定」分支直接引用
#   `premise_structure.analyze_structure(...)` —— 模块级无此名字 →
#   抛 NameError → 被 `except Exception: pass` **静默吞掉** →
#   值域/极限策略在无连线时完全失效（实测：`sin(x)=2` 报 no_premise
#   而非 range_mismatch/limit_mismatch）。
import premise_structure  # noqa: E402
# LaTeX 优先解析通道（路线 A，轮次 J）：MathLive 产出 LaTeX，经此直达 SymPy，零 LLM。
# 与 premise_engine 同样独立成模块，sympy_server.py 只做薄委托。
import latex_engine  # noqa: E402

# 前提包条目的分类正则
_FUNC_LHS_RE = re.compile(r"^([A-Za-z_][A-Za-z_0-9]*)\s*[\(\[]")
_REL_OPS = ("<=", ">=", "!=", "<", ">")


def _compile_symbols(symbols):
    """符号声明列表 → sympify 的 locals 字典（含正值 / 复数属性）。

    元素可以是：
      - 字符串：视为变量名
      - dict：{name, kind, positive, complex, value, params}
    """
    out = {}
    for item in (symbols or []):
        if isinstance(item, str):
            name = item.strip()
            if name:
                out[name] = sp.Symbol(name, real=True)
            continue
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        name = name.strip()
        if item.get("kind") == "function":
            out[name] = sp.Function(name)
            continue
        if item.get("complex") is True:
            # 复数域：不做 real / positive 假设
            out[name] = sp.Symbol(name)
        elif item.get("positive") is True:
            out[name] = sp.Symbol(name, positive=True)
        else:
            out[name] = sp.Symbol(name, real=True)
    return out


def _compile_function_metadata(symbols, locals_map):
    """编译场景函数的形参签名与可选 body。

    ``_compile_symbols`` 只返回 SymPy locals，``sp.Function`` 本身不保留
    业务层的 ``params``，而 ``∂u/∂x`` 又必须借助这份签名补成
    ``u(x,y)``。因此元数据与 locals 并行缓存，不改变现有符号类型。
    """
    params_map = {}
    defs = {}
    func_names = _function_names_of(locals_map)
    for item in (symbols or []):
        if not isinstance(item, dict) or item.get("kind") != "function":
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        params = [
            str(p).strip() for p in (item.get("params") or [])
            if isinstance(p, str) and str(p).strip()
        ]
        params_map[name] = params
        body_raw = item.get("body")
        if not params or not isinstance(body_raw, str) or not body_raw.strip():
            continue
        body_locals = dict(locals_map or {})
        param_objs = []
        for p in params:
            obj = body_locals.get(p)
            if not isinstance(obj, sp.Symbol):
                obj = sp.Symbol(p, real=True)
                body_locals[p] = obj
            param_objs.append(obj)
        try:
            body_text = _normalize_notation(body_raw, None, func_names)
            body_text = _strip_implicit_mul(
                body_text, list(body_locals.keys()), func_names, None
            )
            body = sp.sympify(body_text, locals=body_locals)
        except Exception:  # noqa: BLE001
            continue
        defs[name] = {"params": param_objs, "body": body}
    return params_map, defs


def _function_params_from_items(items):
    """从连线前提的 ``f(x,y)=...`` 定义中提取函数签名。"""
    out = {}
    for raw in (items or []):
        if not isinstance(raw, str):
            continue
        for seg in (_split_premise_entries(raw) or [raw]):
            try:
                parts = _split_chain(_normalize_notation(seg)) or []
            except Exception:  # noqa: BLE001
                parts = []
            for side in parts:
                m = _FUNC_DECL_RE.fullmatch((side or "").strip())
                if not m:
                    continue
                out.setdefault(
                    m.group(1),
                    [p.strip() for p in m.group(2).split(",") if p.strip()],
                )
    return out


def _function_names_of(locals_map):
    """从 `_compile_symbols` 产出的 locals_map 中提取**函数名**列表（轮次 Q 新增）。

    ## 为什么需要
    `_compile_symbols` 把 kind='function' 的声明产出为 `sp.Function(name)`，
    与普通变量（`sp.Symbol`）**共存于同一个 dict**。而 `_strip_implicit_mul`
    需要**分别**拿到「符号名列表」与「函数名列表」，才能判断
    `F(h)` 是「函数调用」还是「F 乘以 h」。

    ## 不传函数名会发生什么（实测确认的真实缺陷）
    `F(h)`（F 已声明为 function）会被插成 **`F*(h)`**：
      - `F` 命中 `known_set`（已声明符号）→ 走「4b 已声明符号」分支 → `prev='sym'`
      - 随后遇 `(`，因 `prev='sym'` → **插入 `*`**
    → `sympify('F*(h)')` 抛
      `unsupported operand type(s) for *: 'UndefinedFunction' and 'Symbol'`
    用户看到的是「**未声明函数，无法与 h 相乘**」—— 而他明明在 given 里声明了。

    ## 这三者的处理必须严格区分（用户明确要求过）
      `F(h)`      F 声明为 function  → 函数调用 `F(h)`      ✅
      `a(x+1)`    a 未声明           → 乘法 `a*(x+1)`      ✅（R3 规则）
      `x(40-2x)`  x 声明为 variable  → 乘法 `x*(40-2x)`    ✅
    本函数**只返回 Function 类型**，故后两者不受影响。
    """
    return [
        n for n, o in (locals_map or {}).items()
        if isinstance(o, sp.FunctionClass)
    ]


def _split_premise_entries(raw):
    """把前提包内容按分号切分为条目列表（保护括号内的分号）。

    为什么要保护括号：`f(x, (a;b))` 这类输入若直接 split，会把括号内内容
    切断，产出无法解析的碎片。
    """
    if not isinstance(raw, str):
        return []
    out = []
    depth = 0
    buf = []
    for ch in raw:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth = max(0, depth - 1)
        # 轮次 P：分隔符补「换行 / 回车」。
        #
        # 为什么必须补（实测确认的真实缺陷）：
        #   given 块在 UI 上被设计为**可以多行**（`buildGivenNodes` 甚至用 LaTeX
        #   的 `\\` 换行符拼接 display 让多条前提各占一行）。而本函数原先只认
        #   `;` / `；`，于是「一条 entry 内含换行」的多条前提会被当成**单条**
        #   交给下游 → `_sympify_relation` 抛异常 → 被 `_parse_relations`
        #   静默跳过 → **前提全部丢失**，判定退化（用户看到的是「明明连了前提
        #   却判成新变量定义」）。实测：`'2x+3y=23\nkx-y=7\nk=3'` 作为单条
        #   entry 解析出 **0 条**关系式。
        if ch in (";", "\uff1b", "\n", "\r") and depth == 0:
            seg = "".join(buf).strip()
            if seg:
                out.append(seg)
            buf = []
            continue
        buf.append(ch)
    seg = "".join(buf).strip()
    if seg:
        out.append(seg)
    return out


def _restore_subscript_names(text, locals_map):
    """把 LaTeX 吞掉的下划线还原：`g0` → `g_0`（轮次 X2 第 1 步修复）。

    ## 用户现象（GUI 实测）
      场景声明符号 `g_0`，提交 `W=\\frac{m g_0 R H}{R+H}` →
      误判 `constraint_conflict`「与已有前提冲突」。
      用户反馈：给式子「加个 C」就通过了 —— 那是**假通过**
      （`W+C=...` 被当 `C` 的新变量定义 `new_definition` 直接放行，
       根本没走冲突检查）。

    ## 根因（实测确认，非推测）
      SymPy `parse_latex` 把 `g_0` 理解为「g 下标 0」，输出 **`g0`**（下划线丢失）；
      而场景符号注册表 `locals` 里登记的是 **`g_0`**。两者对不上 →
      `g0` 变成**未声明符号** → 前提与提交式的比对失真 → 误判冲突。
      实测：
        `latex_engine.latex_to_expr('g_0')`   → `'g0'`
        `latex_engine.to_project_syntax('m*g_0*R')` → `'m*g_0*R'`（本项目**不**剥下划线）
      故剥下划线的责任在 SymPy 的 LaTeX 通道，需在此处回填。

    ## 口径（保守，只做必要回填）
      - 只对**已在 `locals` 中声明的、含下划线的符号名**建立别名（`g_0` → `g0`）
      - 只在别名**未在 `locals` 中声明**时才回填 —— 避免误伤
        「用户本来就声明了 `x0`」这类情形（探针 C3 守护）
      - 用标识符词边界整体替换，避免 `g0x` 被误改成 `g_0x`
      - 长名优先，避免 `g0` 抢在 `g00` 之前替换
    """
    if not isinstance(text, str) or not text:
        return text
    known = set((locals_map or {}).keys())
    names = [n for n in known if isinstance(n, str) and "_" in n]
    if not names:
        return text
    pairs = []
    for n in sorted(names, key=len, reverse=True):
        alias = n.replace("_", "")
        if not alias or alias == n or alias in known:
            continue
        pairs.append((alias, n))
    if not pairs:
        return text
    for alias, real in pairs:
        try:
            text = re.sub(
                r"(?<![A-Za-z0-9_])" + re.escape(alias) + r"(?![A-Za-z0-9_])",
                real,
                text,
            )
        except Exception:  # noqa: BLE001
            continue
    return text


def _sympify_relation(raw, locals_map, function_params=None):
    """把一行前提/结论串转为 SymPy 关系对象。

    支持：等式（a=b）、不等式（x>0）、链式不等式（0<x<20）、
          链式等式（a=b=c → And(Eq(a,b), Eq(b,c))）、裸表达式。
    """
    text = str(raw or "").strip()
    if not text:
        raise ValueError("表达式为空")
    # --- 轮次 W：LaTeX 优先通道（**必须最先**，早于一切归一）---
    #
    # 为什么最早：LaTeX 里的 `x^{2}` 若先过 `_normalize_notation`，
    # 会被 `_CARET_RE` 转成 `x**{2}` → sympify 把 `{2}` 当 set → 报
    # `** or pow(): 'Symbol' and 'set'`（vmlx #G5 实测报错原文）。
    # 故必须先转成项目语法（`x^{2}` → `x**2`）。
    text = _latex_pre_normalize(text, function_params)
    # --- 轮次 X2 第 1 步修复：下标符号名回填（GUI 实测缺陷）---
    # 位置要求：**必须在 `_latex_pre_normalize` 之后** —— 下划线是
    # 该函数内部的 SymPy LaTeX 通道吞掉的，只有拿到它的产物才能回填。
    # 详见 `_restore_subscript_names` 的 docstring。
    text = _restore_subscript_names(text, locals_map)
    name_list = list((locals_map or {}).keys())
    # 轮次 Q 修复：**必须传函数名**，否则已声明的 F(h) 会被插成 F*(h)
    # （详见 `_function_names_of` 的说明：用户实测「无法与 h 相乘」即此因）。
    func_names = _function_names_of(locals_map)
    text = _normalize_notation(text, None, func_names)
    text = _strip_implicit_mul(text, name_list, func_names, None)

    # Piecewise 的分支条件包含 >= / <，不能让下方的外层不等式扫描器
    # 把整个函数定义误当成一条链式不等式。
    if "Piecewise(" in text:
        segs = _split_chain(text)
        if segs is not None and len(segs) == 2:
            return sp.Eq(
                sp.sympify(segs[0].strip(), locals=locals_map),
                sp.sympify(segs[1].strip(), locals=locals_map),
            )

    # 不等式（含链式）：**必须手工拆分**（轮次 M 修复的既有缺陷）
    #
    # 为什么不能直接 sympify（实测确认的静默 bug）：
    #   Python 把 `0 < x < 3` 编译成 `(0 < x) and (x < 3)`，而 and 需要布尔值 →
    #   `bool(Relational)` 抛 "cannot determine truth value of Relational"。
    #   该异常过去被 `_parse_relations` 的 `except: continue` **静默吞掉** →
    #   **定义域前提被整体丢弃**，判定拿不到约束（表现为「前提失效」）。
    #   复用既有 `_split_ineq_chain`（它已正确处理链式，返回 [(差式, 方向)]）。
    # `≠` / `!=`：**必须显式构造 Ne**（轮次 M 修复的真实缺陷，第 19 例）
    #
    # 为什么不能交给 sympify（实测确认，非推测）：
    #   `sp.sympify("x!=1")` 走的是 Python 的 `x != 1`，而 SymPy 对
    #   「实未知数 != 常数」这种**结构上确定不等**的情形会**当场求值**：
    #   实测返回 Python `True`（bool），而不是 `Ne(x, 1)` 对象。
    #   后果：`_premise_domain` 拿不到「排除 x=1」这条信息 ——
    #   前提 `x≠1` **静默失效**，导致 `(x²-1)/(x-1)=x+1` 在已声明 x≠1 时
    #   仍被判 warn（实测：期望 pass）。
    #   显式构造（并 evaluate=False 阻止求值）后，下游全部正常：
    #   实测 `_premise_domain` → `Union((-oo,1) ∪ (1,oo))`，
    #   `_check_singularities` → None（前提已排除该奇点），判定 → legit。
    if "!=" in text or "\u2260" in text:
        _tmp = text.replace("\u2260", "!=")
        _l_str, _, _r_str = _tmp.partition("!=")
        if _l_str.strip() and _r_str.strip():
            try:
                _lv = sp.sympify(_l_str.strip(), locals=locals_map)
                _rv = sp.sympify(_r_str.strip(), locals=locals_map)
                return sp.Ne(_lv, _rv, evaluate=False)
            except Exception:  # noqa: BLE001
                pass

    if any(op in text for op in _REL_OPS):
        # 轮次 Q：不等式分支同样要传函数名（`F(h) < 0` 这类写法）
        subs = _split_ineq_chain(raw, name_list, func_names, None)
        if subs:
            parts = []
            for d, op in subs:
                # `_norm_ineq` 已把方向统一为 '<' / '<='，差式即「左-右」
                parts.append(sp.Lt(d, 0) if op == "<" else sp.Le(d, 0))
            return sp.And(*parts) if len(parts) > 1 else parts[0]
        return sp.sympify(text, locals=locals_map)

    segs = _split_chain(text)
    if segs is not None and len(segs) == 2:
        return sp.Eq(
            sp.sympify(segs[0].strip(), locals=locals_map),
            sp.sympify(segs[1].strip(), locals=locals_map),
        )
    if segs is not None and len(segs) > 2:
        parts = []
        for i in range(len(segs) - 1):
            parts.append(sp.Eq(
                sp.sympify(segs[i].strip(), locals=locals_map),
                sp.sympify(segs[i + 1].strip(), locals=locals_map),
            ))
        return sp.And(*parts)
    return sp.sympify(text, locals=locals_map)


def _classify_entry_kind(seg, locals_map=None):
    """判定单条目类型（引擎侧兜底分类，主分类由 LLM 完成）。

    - 含不等号             → domain
    - 左边是 名(参数) 形式  → definition
    - 右边无自由符号        → constant
    - 其它等式             → relation
    """
    s = str(seg or "").strip()
    if not s:
        return "relation"
    if any(op in s for op in _REL_OPS):
        return "domain"
    if "=" not in s:
        return "relation"
    lhs, rhs = s.split("=", 1)
    lhs, rhs = lhs.strip(), rhs.strip()
    if _FUNC_LHS_RE.match(lhs):
        return "definition"
    try:
        name_list = list((locals_map or {}).keys())
        # 轮次 Q：同样要传函数名（`F(h) = 常量` 应识别为 definition 而非 constant）
        probe = _strip_implicit_mul(
            _normalize_notation(rhs), name_list, _function_names_of(locals_map), None
        )
        if not sp.sympify(probe, locals=locals_map or {}).free_symbols:
            return "constant"
    except Exception:  # noqa: BLE001
        pass
    return "relation"


def _parse_relations(items, locals_map, failures=None, function_params=None):
    """把字符串列表解析为关系对象列表；无法解析的项跳过（不让单条脏数据毁掉整轮判定）。

    **And 展开**（轮次 M 修复的真实缺陷）：
        链式不等式 `0<x<1` 经 `_sympify_relation` 返回的是一个 `And`
        对象（`And(-x<0, x-1<0)`），而下游（`premise_engine` 的冲突检查、
        `premise_structure._premise_domain`）都按**单条关系式**处理 ——
        `And` 的 `is_Relational` 为 False，会被它们跳过或误判。
        实测后果：`sin(x)=0.5` 在前提 `0<x<1` 下被判 `premise_conflict`（应为 pass）。
        展开为独立关系式后，各层按原来的单条逻辑正常处理。

    **一条 entry 内多式子 → 先拆再解析**（轮次 P 修复的真实缺陷）：
        实测确认：`'2x+3y=23\\nkx-y=7\\nk=3'` 作为**单条** entry 交给
        `_sympify_relation` 会抛 `SympifyError`（把三行拼成了 `23k*x-y`），
        于是被本函数的 `except: continue` **静默跳过** → 前提**全部丢失**，
        判定退化为「新变量定义 / 孤立节点」，用户完全无从察觉。

        而这条路径是真实可达的：
          - given 块 UI 支持多行（`buildGivenNodes` 用 `\\\\` 拼接 display）；
          - `givenEntriesOf` 的「entries 缺省」兜底分支会把整条 display
            作为**单条** fact 传入（旧场景兼容路径）；
          - 若 LLM 未按 prompt 要求逐条解构 entries，也会把多条挤在一条里。

        故此处复用 `_split_premise_entries`（它已处理括号保护 + 分号/换行）
        先拆段、再逐段解析 —— 与「已切分多条」的路径行为完全一致。

    `failures`：可选 list。传入时，无法解析的段会被收集进去（不再静默），
        供调用方把「前提失效」这一事实反馈给用户。
    """
    out = []
    for raw in (items or []):
        if not isinstance(raw, str) or not raw.strip():
            continue
        # 轮次 P：一条 entry 可能挤了多条式子（换行 / 分号 / 中文分号）
        segs = _split_premise_entries(raw) or [raw]
        for seg in segs:
            seg = (seg or "").strip()
            if not seg:
                continue
            try:
                rel = _sympify_relation(seg, locals_map, function_params)
            except Exception:  # noqa: BLE001
                if failures is not None:
                    failures.append(seg)
                continue
            # And 展开：链式不等式 → 多条独立关系式
            try:
                if isinstance(rel, sp.And):
                    out.extend(list(rel.args))
                    continue
            except Exception:  # noqa: BLE001
                pass
            out.append(rel)
    return out


def _session_get(session_id, symbols=None):
    """取会话环境；缓存 miss 且带 symbols 时自动重建（抗进程重启）。"""
    sess = _SESSIONS.get(str(session_id or ""))
    if sess:
        return sess
    if not symbols:
        return None
    locals_map = _compile_symbols(symbols)
    func_params, function_defs = _compile_function_metadata(symbols, locals_map)
    func_names = {n for n, o in locals_map.items() if isinstance(o, sp.FunctionClass)}
    default_rels = []
    for item in symbols or []:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        val = item.get("value")
        if isinstance(name, str) and name in locals_map and isinstance(val, str) and val.strip():
            try:
                default_rels.append(sp.Eq(locals_map[name], sp.sympify(val.strip(), locals=locals_map)))
            except Exception:  # noqa: BLE001
                continue
    # --- 轮次 W：供「微分等式判定」使用的两类元信息 ---
    #
    # ## 为什么需要（实测确认的架构缺口）
    #   微分判据要回答「两边微分是否相同」，其核心是判断
    #   「差式 `A - B` 在前提下是否**还随变量变化**」：
    #     `u = R + h`（R 常量有值）→ `u - h` 代入后 = `R` = 具体值 → 不随变量变化 → 相等
    #   而 `locals` 里 `R`（constant）与 `h`（variable）**都是同一个 Symbol**，
    #   无从区分 —— 故必须额外携带「谁是变量」这一信息，否则判据无法成立。
    #
    # ## const_values 为什么允许 None（用户 Q2 确认）
    #   「场景内必须给一个值才能确定是常量」—— 无值的「常量」名
    #   在数学上无法参与判定（SymPy 不知道它会不会变），
    #   故此处如实记为 None，由 `_judge_differential_step` 报
    #   「常量未给出取值」的可执行指引（不猜测，符合项目既有原则）。
    var_names = set()
    const_values = {}
    for item in symbols or []:
        if not isinstance(item, dict):
            continue
        _nm = item.get("name")
        if not isinstance(_nm, str) or not _nm.strip():
            continue
        _nm = _nm.strip()
        if item.get("kind") == "function":
            continue
        if item.get("kind") == "constant":
            _v = item.get("value")
            const_values[_nm] = _v if (isinstance(_v, str) and _v.strip()) else None
        else:
            var_names.add(_nm)
    return {
        "locals": locals_map,
        "func_names": func_names,
        "func_params": func_params,
        "function_defs": function_defs,
        "default_relations": default_rels,
        "var_names": var_names,
        "const_values": const_values,
    }


def _check_undeclared(rel, declared_names, func_names):
    """检查未声明符号 / 未定义函数。返回错误说明或 None。"""
    try:
        syms = {str(s) for s in rel.free_symbols}
    except Exception:  # noqa: BLE001
        return None
    # --- 轮次 T 修订（用户口径）：**内置常量名（pi / E / I / oo）不算未声明** ---
    # 为什么必须排除（实测确认）：
    #   用户写 `E(x)=1`（E 是自然对数底）时，表达式被解析为 `E*x=1`；
    #   若把 E 计入「未声明符号」，整式会被判 undeclared_symbol。
    #   而用户明确口径：「E 如果是内置的常量，`E(x)=1` 就相当于是在无前提
    #   条件下对 x 变量声明并限制 `x=1/E` → **pass**」。
    #   这些常量在 `_strip_implicit_mul` 里本就在 known_set 中（系统自带、
    #   永远可用），此处保持一致口径。
    unknown = syms - set(declared_names or []) - set(_IMPLICIT_MUL_CONSTS)
    if unknown:
        return "未定义的符号：" + "、".join(sorted(unknown))
    try:
        for sub in sp.preorder_traversal(rel):
            if isinstance(sub, _AppliedUndef):
                fname = getattr(sub.func, "__name__", str(sub.func))
                if fname not in set(func_names or []):
                    return "未定义的函数：" + str(fname)
    except Exception:  # noqa: BLE001
        return None
    return None


def _collect_denominators(expr):
    """递归收集表达式中的所有分母（含负指数幂的底）。"""
    target = expr
    if getattr(expr, "is_Relational", False):
        try:
            target = expr.lhs - expr.rhs
        except Exception:  # noqa: BLE001
            target = expr
    dens = []
    try:
        _num, den = sp.fraction(sp.together(target))
        if den != 0:
            dens.append(den)
    except Exception:  # noqa: BLE001
        pass
    try:
        for sub in sp.preorder_traversal(target):
            if isinstance(sub, sp.Pow):
                e = sub.exp
                if e.is_number and e.is_negative:
                    dens.append(sp.Pow(sub.base, -e))
    except Exception:  # noqa: BLE001
        pass
    return dens


def _check_division_safety(expr, relations):
    """检查分母是否可能为 0。

    规则（用户确认）：未声明定义域时符号默认覆盖整个实数轴，因此 `v/x`
    在 x 无约束时必须报「x 可能为 0」。只有当前提能**证明**分母不为 0
    时才放行。
    """
    # 委托 premise_engine：等式代入 + 数值采样（支持正值假设）
    return premise_engine.check_division_safety(expr, relations)


def _check_premise_conflict(relations):
    """前提集是否自相矛盾。返回 (是否冲突, 说明)。"""
    # 委托 premise_engine（等式代入可提前发现常数矛盾）
    return premise_engine.check_premise_conflict(relations)


def _substitute_function_defs(expr, relations):
    """把前提中的函数定义代入表达式（A(x)=x*(40-2*x) → A(x) 被替换）。"""
    subs_map = {}
    for r in relations:
        if not isinstance(r, sp.Eq):
            continue
        for a, b in ((r.lhs, r.rhs), (r.rhs, r.lhs)):
            try:
                if not a.args:
                    continue
                if not a.free_symbols:
                    continue
                if b.free_symbols - a.free_symbols:
                    continue
                subs_map[a] = b
            except Exception:  # noqa: BLE001
                continue
    if not subs_map:
        return expr
    try:
        return expr.subs(subs_map, simultaneous=True)
    except Exception:  # noqa: BLE001
        return expr


def _eval_calculus(expr):
    """把未求值的 Derivative / Integral 求出来（用于微积分步骤判定）。"""
    changed = False
    new = expr
    try:
        for sub in list(sp.preorder_traversal(expr)):
            if isinstance(sub, (sp.Derivative, sp.Integral)):
                try:
                    v = sub.doit()
                    if v != sub:
                        new = new.subs(sub, v)
                        changed = True
                except Exception:  # noqa: BLE001
                    continue
    except Exception:  # noqa: BLE001
        return expr, False
    return new, changed


def _check_derivable(relations, current, locals_map):
    """判定当前结论能否由前提推出。

    返回 'legit' | 'illegal' | 'unknown'。

    判定阶梯（命中即返回，全部不适用则 unknown → 上层回落参考解兜底）：
      A 等式：与某条前提等式同解（相差非零常数倍）
      B 微积分：一侧是导数/积分，求值后比对
      C satisfiable：前提 ∧ ¬当前 无解 ⟹ 蕴含
    """
    # 委托 premise_engine（等式代入 + 微积分求值 + 数值采样）。
    # 保留第三参数以维持既有调用签名不变。
    return premise_engine.check_derivable(relations, current)


def _check_derivable_ex(relations, current, locals_map):
    """结构化版本（轮次 G 新增）：额外给出 `warn` 与原因码 `code`。

    为什么要单独出口：字符串三态无法表达「结论正确但有保留」——
    可去奇点（约分隐含前提）、部分定义域（仅在区间上成立）。
    用户已确认这类判 `warn`：不误判为错，同时给出教学提示。

    也用于区分「确实判不了」与「缺符号信息」：后者可给出可执行指引
    （用户方案：缺信息就明说，不猜测）。
    保留 locals_map 参数以维持既有调用签名不变。
    """
    return premise_engine.check_derivable_ex(relations, current)


def _appeared_symbols(relations):
    """祖先前提中出现过的全部符号名。

    用途（轮次 I 五类规则）：区分「**全新变量**的定义」（rule 1）与
    「**已有变量**的值指派 / 函数关系」（rule 2/3）。
    `A=x*y` 里 A 从没出现过 → 新变量定义；`y=40+2x` 里 y 在前提 `2x+y=40` 里
    出现过 → 是给已有变量定关系，须校验一致性。
    """
    names = set()
    for r in relations or []:
        try:
            names |= {str(s) for s in r.free_symbols}
        except Exception:  # noqa: BLE001
            continue
    return names


def _solve_unique_var(rel):
    """等式若能解出某变量的**唯一表达式**，返回 (变量名, 表达式)；否则 None。

    为什么用「唯一解」而非「一侧是裸符号」（轮次 I 修订，用户口径）：
      - `40=x`     → 一侧裸符号，解出 x=40
      - `40=y+99`  → 两侧都不是裸符号，但解出 y=-59
      - `y=40+2x`  → 解出 y=40+2x（含符号的解，同样唯一）
      - `A=x*y`    → 解出 A=x*y
    四者的共性都是「**给某个变量定值或定关系**」，用户要求统一按此识别。
    旧判据只认「一侧是裸符号」，导致 `40=y+99` 漏掉（探针实测）。

    变量数上限 6：超过则 `sp.solve` 代价过高且结果多不唯一，交后续关卡。
    """
    if not isinstance(rel, sp.Eq):
        return None

    # 优先取「裸符号那一侧」作为被定义量（轮次 I 修正）。
    #
    # 为什么必须先走这一步（探针用例 7 实测缺陷）：
    #   `y = 40 + 2*x` 里 x 与 y 都可由该式「唯一解出」——
    #   解 y 得 `40+2x`，解 x 也得 `(y-40)/2`。下方循环按字母序先试 x，
    #   于是把这条式子当成「给 x 定关系」（vname='x'），而学生本意是给 y 定值。
    #   后果：规则 3 拿 `x=(y-40)/2` 代入前提 `x=0`，残差仍含 y，
    #   再对 y 采样判「非恒等」→ 把合法的 `y=40+2x` 误判为冲突（用例 7 FAIL）。
    #   先认「裸符号侧」即可无歧义地确定被定义量（这正是学生的书写意图）。
    # 两侧都不是裸符号（如 `40 = y+99`）时本步落空，交由下方循环求解。
    for _sym_side, _other_side in ((rel.lhs, rel.rhs), (rel.rhs, rel.lhs)):
        if isinstance(_sym_side, sp.Symbol):
            if str(_sym_side) not in {str(s) for s in _other_side.free_symbols}:
                return str(_sym_side), _other_side

    try:
        diff = rel.lhs - rel.rhs
    except Exception:  # noqa: BLE001
        return None
    syms = sorted(diff.free_symbols, key=lambda s: s.name)
    if not syms or len(syms) > 6:
        return None
    # 先扫「解不含自由符号」的变量（定值；如 `40=y+99` → y=-59），
    # 再退回「唯一符号解」（定关系）。避免在多变量式上随字母序误选。
    fallback = None
    for v in syms:
        try:
            sols = sp.solve(diff, v)
        except Exception:  # noqa: BLE001
            continue
        if not (isinstance(sols, list) and len(sols) == 1):
            continue
        if not sols[0].free_symbols:
            return str(v), sols[0]
        if fallback is None:
            fallback = (str(v), sols[0])
    return fallback


def _var_domain(relations, sym):
    """该符号在前提约束下的取值集合；无约束则为全体实数。

    直接复用 `premise_structure._premise_domain` —— 它已实现
    「逐条不等式求交」的完整逻辑（含 `solve_univariate_inequality`）。
    此处不重写，避免出现第二套定义域语义。
    """
    # 先查**等式**约束：`x=0` 这类把变量钉死为常数的等式。
    #
    # 为什么必须补这一步（探针用例 7 实测缺陷）：
    #   `_premise_domain` 只汇总**不等式**（它内部只调
    #   `solve_univariate_inequality`），等式约束完全不参与 ——
    #   于是前提 `x=0` 下 x 的定义域仍被当成全体实数 ℝ，
    #   规则 3 在 ℝ 上采样必然取到非零点，把合法的 `y=40+2x`
    #   误判为「非恒等 → 冲突」（用例 7 实测 FAIL）。
    #   钉死为 {0} 后，残差 4x 在该点恒为 0，判定恢复正确。
    # --- 轮次 X6 修复（**统一入口过滤**）：含 Integral / Derivative 的等式不参与任何 solve ---
    #
    # ## 为什么必须在此统一定义（探针 scripts/vintegral2.py 实测）
    #   本函数有**两处**对前提等式调 `sp.solve`：
    #     ① 下方「逐条解出常数」分支（`pinned`）—— 实测使 E2 耗时 **24.0s**
    #     ② 末尾「多条等式联立」分支（`_eqs`）—— 实测使 E2 **死循环**（需 Ctrl+C）
    #   两处遇到含**未求值 Integral** 的等式时，SymPy 都走
    #   `_tsolve` → `factor` → `together` 的**病态深递归**。
    #   故**统一在函数入口**过滤一次，让**所有** solve 都受益 ——
    #   避免「修了一处漏另一处」（这正是本轮踩过的坑）。
    #
    # ## 为什么过滤是安全的（能力零损失）
    #   本函数目的是「把某变量**钉死为常数** / 缩小其定义域」。
    #   含积分 / 导数的等式**结构上无法解出某变量的常数解**
    #   （积分号内是被积变量，无法反解出它的常量值）—— 对目标**零贡献**，
    #   只会白白触发 SymPy 的病态路径。
    #   表达式方程（`2x+3y=23`）的联立能力**完整保留**，
    #   轮次 O 修复的 GUI 缺陷（`...=23` 被误判 fail）不会复发。
    def _has_calc(_rel):
        """该关系式是否含未求值的 Integral / Derivative（轮次 X6 新增）。"""
        try:
            return bool(_rel.has(sp.Integral) or _rel.has(sp.Derivative))
        except Exception:  # noqa: BLE001
            return False

    _plain_eqs = [
        r for r in (relations or [])
        if isinstance(r, sp.Eq) and not _has_calc(r)
    ]

    pinned = []
    for r in _plain_eqs:
        try:
            sols = sp.solve(r.lhs - r.rhs, sym)
        except Exception:  # noqa: BLE001
            continue
        if isinstance(sols, list) and len(sols) == 1 and not sols[0].free_symbols:
            pinned.append(sols[0])
    if len(pinned) == 1:
        return sp.FiniteSet(pinned[0])
    if len(pinned) > 1:
        # 多条等式给出不同值 → 前提本身矛盾（上层 conflict 检查会先拦），
        # 此处取交集语义：只有公共值才是可行域。
        try:
            return sp.Intersection(*[sp.FiniteSet(v) for v in pinned])
        except Exception:  # noqa: BLE001
            return sp.FiniteSet(*pinned)
    # --- 轮次 O 新增（B1）：多条等式**联立**求解 ---
    #
    # 为什么必须补（GUI 实测缺陷的根因之一）：
    #   前提四条等式**联立**可把 x 钉死为唯一值 4：
    #     2x+3y=23 ∧ kx-y=7 ∧ k=3 ∧ y=kx-7  →  {k:3, x:4, y:5}
    #   但**逐条孤立看**，每条都解不出 x 的常数 ——
    #   于是落回下方「不等式定义域」返回 ℝ，`_domain_identity_holds`
    #   采样到 x=1（前提根本不允许的点），残差 `11*(4-x)/(3x)` 非零
    #   → 误判「本步声明的关系比前提更强」→ 用户正确的 `...=23` 被判 fail。
    #
    # 为什么限制变量数 ≤ 6：`sp.solve` 的联立代价随变量数快速上升，
    #   且变量过多时解多不唯一，收益不抵开销（与 `_solve_unique_var` 同口径）。
    #
    # 为什么只在「恰好一个常数解」时采纳：多解 / 含符号解意味着该变量
    #   并未被前提唯一确定，此时**不可**缩小定义域 —— 否则会把合法取值
    #   误排除，方向性错误。仅在唯一确定时才返回单点集。
    # --- 轮次 X6 修复（**关键**）：含 Integral / Derivative 的等式**排除联立** ---
    #
    # ## 用户现象与根因（探针 scripts/vintegral2.py 实测，堆栈见 vint2_out.txt）
    #   前提含 `W=∫_0^H ... dh`（未求值 Integral）时，判定链会走到：
    #     `_judge_atomic` → `_domain_identity_holds` → `_var_domain`
    #       → `sp.solve([Eq(W, Integral(...)), ...], 全部符号, dict=True)`
    #         → sympy `_tsolve` → `factor` → `together` → **深递归，永不返回**
    #   前端 `COMPUTE_TIMEOUT_MS`(15s) 触发 → 用户看到「**引擎超时**」。
    #
    #   「带中间步骤能过」的原因：链式切分后**每一对都含 Integral**
    #   → 走 `_judge_atomic` 的**积分等式通道**（`_is_int_eq`）→ 提前 return，
    #   **绕开了 `_domain_identity_holds` / `_var_domain`**（与用户描述一致）。
    #
    # ## 为什么排除是安全的（轮次 O 能力**零损失**）
    #   本联立分支的目的**只是**「把某变量钉死为常数」（如 {x: 4}）。
    #   含积分 / 导数的等式**结构上无法解出某变量的常数解**
    #   （积分号内是被积变量，无法反解出它的常数值）——
    #   即它对本分支**目标零贡献**，只会白白触发 SymPy 的病态路径。
    #   排除后，**表达式方程**（`2x+3y=23`）的联立能力**完整保留**，
    #   轮次 O 修复的 GUI 缺陷（`...=23` 被误判 fail）不会复发。
    _eqs = _plain_eqs          # 复用入口处已过滤的列表（见函数开头的统一过滤）
    if len(_eqs) >= 2:
        _syms = set()
        for _r in _eqs:
            _syms |= _r.free_symbols
        if 1 <= len(_syms) <= 6:
            try:
                _sols = sp.solve(_eqs, sorted(_syms, key=lambda s: s.name), dict=True)
            except Exception:  # noqa: BLE001
                _sols = None
            if isinstance(_sols, list):
                _vals = []
                for _s in _sols:
                    if not isinstance(_s, dict) or sym not in _s:
                        continue
                    try:
                        if not _s[sym].free_symbols:
                            _vals.append(_s[sym])
                    except Exception:  # noqa: BLE001
                        continue
                if len(_vals) == 1:
                    return sp.FiniteSet(_vals[0])
    # 无等式钉死 → 走既有不等式定义域
    try:
        import premise_structure
        return premise_structure._premise_domain(relations, sym)
    except Exception:  # noqa: BLE001
        return sp.S.Reals


def _finite_interval_bounds(dom):
    """把（可能**无界**的）区间端点转为**有限**代表值（轮次 X2 第 1 步修复）。

    ## 为什么必须做（GUI 实测缺陷）
      前提里写 `H>0` 时，`_var_domain` 会返回 `Interval.open(0, oo)`；
      原 `_sample_points` 直接 `float(dom.end)` → `inf`，
      再算 `lo + span * (i + 0.5) / n` → **采样值全为 `inf`**。
      实测：`H` 的 domain 为 `Interval.open(0, oo)` 时采样得到 `[inf, inf, inf]`。

      污染后果：`_domain_identity_holds` 用 `inf` 代入残差 →
      数值判定被污染 → 本步被误报 `constraint_conflict`
      （用户 GUI 现象：「与已有前提冲突」，而实际并不冲突）。

    ## 口径
      有界端点沿用原值；无界端点向内收一个有限范围（量级 ±5，避开 0 附近奇点），
      使采样点始终是**有限实数**。仅影响「取代表点」这一辅助动作，
      不改变任何数学判据本身。
    """
    lo = hi = None
    try:
        if dom.start.is_finite:
            lo = float(dom.start)
    except Exception:  # noqa: BLE001
        lo = None
    try:
        if dom.end.is_finite:
            hi = float(dom.end)
    except Exception:  # noqa: BLE001
        hi = None
    if lo is None and hi is None:
        return -5.0, 5.0
    if lo is None:
        hi = hi if hi is not None else 5.0
        lo = hi - (abs(hi) + 5.0)
    if hi is None:
        hi = lo + (abs(lo) + 5.0)
    return lo, hi


def _sample_points(dom, n):
    """从取值集合中取 n 个代表点；取不到时返回 []。"""
    pts = []
    try:
        if dom is sp.S.Reals:
            return [random.uniform(-5.0, 5.0) for _ in range(n)]
        if isinstance(dom, sp.Interval):
            lo, hi = _finite_interval_bounds(dom)
            span = hi - lo
            if span <= 0:
                return [lo]
            return [lo + span * (i + 0.5) / n for i in range(n)]
        if isinstance(dom, sp.FiniteSet):
            for e in dom:
                try:
                    pts.append(float(e))
                except Exception:  # noqa: BLE001
                    continue
            return pts or []
        if isinstance(dom, sp.Union):
            args = list(dom.args)
            per = max(1, n // max(1, len(args)))
            for a in args:
                pts.extend(_sample_points(a, per))
            return pts
    except Exception:  # noqa: BLE001
        return []
    # 兜底：未识别的集合形态（Intersection / UniversalSet / 其他 Set）
    # 一律按**全体实数**取点。
    #
    # 为什么必须兜底（探针实测缺陷）：前提只含等式时，`_premise_domain`
    # 返回的并非 `sp.S.Reals` 本身，而是 Intersection 一类的复合集合 ——
    # 不兜底则取点为空 → `_domain_identity_holds` 拿不到样本返回 None →
    # 「抄错符号」的残差（`y=40+2x` 代入前提后的 `4x`）无人发现，
    # 被误判为 legal 关系（探针用例 5 实测 FAIL）。
    if not pts:
        for _ in range(n):
            pts.append(random.uniform(-5.0, 5.0))
    return pts


def _point_allowed(relations, subs):
    """采样值 `subs` 是否落在前提允许的范围内（轮次 O 新增，B2 配套）。

    做法：把 `subs` 逐条代入前提，看每条是否成立。

    三态返回：
      True  —— 全部前提在该取值下**确定成立**
      False —— 某条前提在该取值下**确定不成立**（该点越界）
      None  —— 有前提无法求值（如仍含其它自由符号）→ 判不了

    为什么必须区分 False 与 None（关键）：
      两者都会让调用方**忽略**该采样点，但语义完全不同 ——
      False 是「这个点前提不允许，在该点检验结论无意义」；
      None 是「我判断不了，保守不据此下结论」。
      调用方对二者的处置一致（跳过），故此处只需如实区分，不合并。
    """
    for r in relations or []:
        try:
            v = r.subs(subs)
        except Exception:  # noqa: BLE001
            return None
        try:
            if v is sp.S.true:
                continue
            if v is sp.S.false:
                return False
            # 未求值（仍含符号 / 无法判定真值）→ 该点无法确认
            return None
        except Exception:  # noqa: BLE001
            return None
    return True


def _domain_identity_holds(residual, relations, others):
    """残差在「其他变量各自的定义域」上是否**恒为零**（轮次 I 规则 3）。

    判据（用户口径「甲：撒点」，已确认）：
      「等式没声明定义域，就表明认定该关系在负无穷到正无穷都成立」
      → 在定义域内取若干点，只要找到**一个**非零点即判定「不恒等」。

    为什么撒点够用：撒点漏掉的只有「仅在极个别点不为零」的情形
    （如 `x**2/x` 与 `x` 只在 x=0 不同），而那类由
    `premise_structure` 的**奇点比对**（`removable_singularity`）独立负责 ——
    两层合起来即覆盖精确求解（乙方案）的全部能力，且无性能风险。

    返回 True（恒零）/ False（找到反例）/ None（取不到样本，判不了）。
    """
    if not others:
        try:
            return sp.simplify(residual) == 0
        except Exception:  # noqa: BLE001
            return None
    # --- 轮次 X6 性能修复（**关键**）：domain 在单次判定内**不变** → 循环外算一次 ---
    #
    # ## 为什么必须缓存（cProfile 实测：探针 scripts/vprof.py）
    #   本函数循环 24 次，每次都重新调 `_var_domain(relations, s)` ——
    #   而 `_var_domain` 内部要对每条前提等式调 `sp.solve`（**昂贵**）。
    #   实测 E2 场景（given 含 `F(h)=m*g0*R²/(R+h)²`）：
    #     `_var_domain` 被调用 **192 次**（24 轮 × N 个符号），
    #     累计 **15.06s**，占整体 18.3s 的 **82%** —— 前端 15s 超时的直接成因。
    #
    #   但 `relations` 在本函数执行期间**完全不变**，故 domain 也**不变** ——
    #   每轮重算是纯粹的**重复计算**，缓存后语义**零改变**，仅消除冗余。
    #
    # ## 预期效果
    #   solve 调用从 `24 × N` 降到 `N`（N = len(others)，通常 1~3），
    #   即减少 **~96%** 的求解开销。
    _dom_cache = {}

    def _dom_of(_s):
        """带缓存的 `_var_domain`（见上方说明：单次判定内 domain 不变）。"""
        if _s not in _dom_cache:
            _dom_cache[_s] = _var_domain(relations, _s)
        return _dom_cache[_s]

    # --- 轮次 X6 新增（③ 兜底）：残差中的**定积分**先求值 ---
    #
    # ## 为什么必须补（A3 实测：错答案被误判「恒等」而放行）
    #   本函数末尾用 `complex(sp.N(residual.subs(subs)))` 求值。
    #   若残差含**未求值的 `Integral`**（前提是「符号 = 定积分」时极易出现），
    #   则 `sp.N(...)` **必然抛异常** → 走 `except: continue` →
    #   **采不到任何样本** → `got_sample` 保持 False → 返回 None →
    #   上层把「判不了」当作「恒等」**放行**（实测 A3：
    #   `W=m*g0*R*H/R`（分母漏 +H）判 `relation_ok` ❌）。
    #
    # ## 为什么只求**定积分**（与 `_eval_definite_calculus` 同口径）
    #   定积分结果**唯一**，求值无损，求值后即可正常采样；
    #   不定积分代表**原函数集合**（可差任意 C），求值会丢失自由度
    #   → 保留原式（那类残差交由专门通道处理）。
    #
    # ## 为什么放在循环**外**（只算一次）
    #   `residual` 在本函数内不变，求值也只需一次 —— 与上方 domain 缓存
    #   同一理由：避免重复计算。
    try:
        if residual is not None and residual.has(sp.Integral):
            residual = _eval_definite_calculus(residual)
    except Exception:  # noqa: BLE001
        pass

    got_sample = False
    for _ in range(24):
        subs = {}
        for s in others:
            pts = _sample_points(_dom_of(s), 1)
            if not pts:
                subs = None
                break
            subs[s] = pts[0]
        if subs is None:
            continue
        # 关键：只有**成功算出数值**才算取到样本。
        # 为什么（探针用例 5 实测缺陷）：先前在构造出 subs 时就置
        # got_sample=True，即使后续 complex() 抛异常（残差含未代入的
        # 自由符号时必然如此）也算「取到了样本」→ 最终返回 True（恒等）
        # → 「抄错符号」被放行。改为「算得出数值才算样本」，使代入失败
        # 的情形正确归入 None（判不了），而不是伪装成「恒等」。
        try:
            val = complex(sp.N(residual.subs(subs)))
        except Exception:  # noqa: BLE001
            continue
        # --- 轮次 O 新增（B2）：越界采样守卫 ---
        #
        # 为什么必须加（GUI 实测缺陷的根因之二）：
        #   本函数自称「在定义域上验恒等」，但它用的 `_var_domain` 只是
        #   **近似**定义域（旧版不做联立，见 `_var_domain` 的 B1 说明）。
        #   一旦定义域被高估，采样就会取到**前提不允许的点**，
        #   在那里的非零残差被误读为「本步声明比前提更强」→ 误判 fail。
        #   实测：前提为方程组（唯一解 x=4）时，采样到 x=1 使残差
        #   `11*(4-x)/(3x)` 非零 → 用户正确的 `...=23` 被判错。
        #
        # 判据（轮次 O 定稿）：**只过滤「确定越界」的点**，即
        #   `_point_allowed(...) is False`。
        #
        # 为什么不能把 None（判不了）也一并跳过（关键，会破坏既有能力）：
        #   采样时只代入了 `others`（本例是 x），而前提里往往**还有别的变量**
        #   （如 `2x+3y=23` 里的 y）。此时 `Eq(...)` 代入后仍含 y → 无法判定
        #   真值 → `_point_allowed` 必然返回 None。
        #   若把 None 也跳过，**所有**采样点都会被丢弃 → got_sample=False
        #   → 返回 None → 上层视为「恒等」→ 既有的「抄错符号」检测
        #   （`y=40+2x` vs 前提 `2x+y=40` 的残差 4x）会**静默失效**。
        #   故 None 必须保持原有行为（当作有效样本）。
        #
        # 为什么 False 必须过滤：那是「前提在该点确定不成立」，
        #   在该点检验「结论是否处处成立」本身无效 —— 前提根本不允许这个点。
        #   这正是 GUI 实测里 `...=23` 被误判 fail 的直接成因。
        if _point_allowed(relations, subs) is False:
            continue
        got_sample = True
        if abs(val.real) > 1e-9 or abs(val.imag) > 1e-9:
            return False      # 找到（前提允许的）反例 → 不恒等
    return True if got_sample else None


def _chain_segments(raw, locals_map):
    """把原始输入切成链式等式的段列表；非链式（段数 < 3）返回 None。

    为什么需要单独出口（轮次 I）：链式判定的口径是「逐段两两比对」
    （a 与 b 比、b 与 c 比），而不是把整串当一个关系式。
    `_split_chain` 只做字符串切分，故此处先补上记法归一
    （`^`→`**`、`2x`→`2*x`），使切出的段可直接交回单段判定。
    """
    text = str(raw or "").strip()
    if not text:
        return None
    name_list = list((locals_map or {}).keys())
    # 轮次 Q：链式段也要传函数名，否则 `F(h)=...=...` 这类链式会被插成 F*(h)
    func_names = _function_names_of(locals_map)
    try:
        text = _normalize_notation(text)
        text = _strip_implicit_mul(text, name_list, func_names, None)
        return _split_chain(text)
    except Exception:  # noqa: BLE001
        return None


# 括号字符集（含全角）：用于顶层分隔符扫描与括号剥除。
# 为什么必须含全角：学生在中文输入法下写的常是 `（x>0）`。
_OPEN_PARENS = "([{（【"
_CLOSE_PARENS = ")]}）】"

# 局部限定条件的顶层分隔符（用户口径：三种都接受）。
_LOCAL_SEP = ";；,，"


def _split_top_level(raw, seps=_LOCAL_SEP):
    """按**顶层**分隔符切段，保护括号内的分隔符。

    为什么必须用深度扫描而非直接 `re.split`（关键）：
      `(x>0,y=0)` 里的逗号是**约束内部分隔符**，`f(x,y)` 里的逗号是
      **函数参数分隔符** —— 两者都在括号内。直接按逗号切会把它们切断，
      产生 `(x>0` / `y=0)` 这样的碎片，整条判定失败。
      深度扫描时括号内 depth > 0，天然跳过这两种情形。
    """
    if not isinstance(raw, str):
        return []
    out, buf, depth = [], [], 0
    for ch in raw:
        if ch in _OPEN_PARENS:
            depth += 1
        elif ch in _CLOSE_PARENS:
            depth = max(0, depth - 1)
        if ch in seps and depth == 0:
            seg = "".join(buf).strip()
            if seg:
                out.append(seg)
            buf = []
            continue
        buf.append(ch)
    seg = "".join(buf).strip()
    if seg:
        out.append(seg)
    return out


def _unwrap_parens(seg):
    """整段被括号包裹时剥掉一层，返回 (内容, 是否带括号)。

    为什么需要「是否带括号」这个标记：它是判据 1 的依据 ——
    `(x=y)` 这类式子本身解不出常数（是关系式而非定值），
    但有括号即为「用户明确声明这是限定条件」。
    """
    t = (seg or "").strip()
    if len(t) < 2 or t[0] not in _OPEN_PARENS or t[-1] not in _CLOSE_PARENS:
        return t, False
    inner = t[1:-1]
    depth = 0
    for ch in inner:
        if ch in _OPEN_PARENS:
            depth += 1
        elif ch in _CLOSE_PARENS:
            depth -= 1
            if depth < 0:
                return t, False   # 不平衡 → 外层括号非包裹式（如 (a)+(b)）
    if depth != 0:
        return t, False
    return inner.strip(), True


def _is_constraint_segment(seg, locals_map):
    """该段是否为「限定条件」段（轮次 I 追加，用户口径）。

    判据（**形式判断，与书写顺序无关** —— 用户明确要求），满足其一即算：
      1. **被括号包裹**且内容是**关系式**（等式或不等式）
      2. **是不等式**（含链式，如 `x>0`、`0<x<20`）
      3. **能解出某变量为常数**（含 `数值=符号` 方向）
         `x=0`、`40=x`、`40=y+99`（→ y=−59）

    为什么判据 3 也算限定条件（用户原话）：
      「`符号=数值` 可能是用户得出的计算结果，提前的话是否作为前提都是成立的」
      数学上成立 —— 值指派型的检查方式**本身**就是「与前提是否一致」，
      而「把它当前提」时的检查正是同一件事，两者等价。
      故统一按「提升为前提 + 自身判定」处理，无副作用。

    为什么 `y=40+2x` **不算**限定条件：
      它声称「对所有 x 都成立」，是**函数关系**而非定值 ——
      光当前提不够（代入前提解得 `4x=0` 是可满足的），
      还须过「全域恒等」这一关。这正是「抄错符号」被抓住的机制
      （见 `_domain_identity_holds`）。

    为什么 `(x+1)` **不算**限定条件：剥括号后是表达式而非关系式，
    属普通括号运算，留给主式判定（避免重演「括号运算被误拆」的老问题）。
    """
    text = (seg or "").strip()
    if not text:
        return False

    body, wrapped = _unwrap_parens(text)
    if not body:
        return False

    # 判据 2：不等式（含链式）
    if any(op in body for op in _REL_OPS):
        return True

    try:
        rel = _sympify_relation(body, locals_map)
    except Exception:  # noqa: BLE001
        return False

    # --- 轮次 W 新增（块2 配套）：含 **积分 / 导数** 的式子**不算限定条件** ---
    #
    # ## 为什么必须排除（vcalc2 #22 / #C2 实测确认的误判）
    #   `∫2x dx = x²+C` 里 C 本是**积分常数**，但 `_solve_unique_var`
    #   在 solve 内部会先把 Integral 求值（`∫2x dx` → `x²`），
    #   方程 `x² - C - x² = 0` 化简成 `-C = 0` → 解出 `C = 0`（无自由符号）
    #   → **判据 3 误命中** → 整式被归为「限定条件」
    #   → 走 `_judge_constraint`（**只查与前提的冲突**，不查「能否由前提推出」）
    #   → 报 `constraint_conflict`（实测 #22），或让 #C2 同样误判。
    #
    # ## 语义边界（判据为何是「含积分/导数」）
    #   限定条件的语义是「**给变量定值 / 定域**」（`x=0`、`x>0`）；
    #   而含 Integral / Derivative 的式子是**推导结论**
    #   （「求解一个积分」「说明导数关系」），必须走**推导判定**
    #   （`_check_derivable_ex` / 本轮的积分等式通道）。
    #   二者的判据不同，故此处按**形式**分流，与该文件既有约定一致
    #   （`_is_constraint_segment` 的 docstring：「把形式作为判断依据」）。
    try:
        if isinstance(rel, sp.Eq) and (
            rel.lhs.has(sp.Integral) or rel.rhs.has(sp.Integral)
            or rel.lhs.has(sp.Derivative) or rel.rhs.has(sp.Derivative)
        ):
            return False
    except Exception:  # noqa: BLE001
        pass

    # 判据 1：括号包裹 + 内容是关系式
    if wrapped and getattr(rel, "is_Relational", False):
        return True

    # 判据 3：等式且能解出常数
    if isinstance(rel, sp.Eq):
        sol = _solve_unique_var(rel)
        if sol and not sol[1].free_symbols:
            return True

    return False


def _split_local_constraints(raw, locals_map):
    """把输入拆成 (主式段列表, 限定条件段列表)（轮次 I 追加，用户口径）。

    用户口径（原话）：
      「把形式作为判断依据」—— 不看顺序，只看每段的**形式**。
      「相当于先提交 x=0 作为前提，再提交 y=40+2x」—— 条件提升为前提。

    流程：
      1. `_split_top_level` 按顶层分隔符切段（保护括号内分隔符）
      2. 逐段 `_is_constraint_segment` 判定
      3. 限定条件若是括号包裹的，**剥括号后再展开** ——
         `(x>0,y=0)` 一条应展开为 `x>0` 与 `y=0` 两条约束
      4. 其余段归主式

    返回 (mains, cons)。全部段都是限定条件时 mains 为空。
    """
    mains, cons = [], []
    for s in _split_top_level(raw):
        body, wrapped = _unwrap_parens(s)
        if not _is_constraint_segment(s, locals_map):
            mains.append(s)
            continue
        if wrapped:
            # 括号内可能含多条（`(x>0,y=0)`）→ 逐个展开
            subs = _split_top_level(body)
            cons.extend(subs or [body])
        else:
            cons.append(s)
    return mains, cons


def _judge_constraint(seg, use_ctx):
    """限定条件段的判定（轮次 I 追加，用户口径第 1 条）。

    **为什么不能用 `_judge_atomic`**（关键）：
      约束段（不等式 / 括号关系式）若走 `_judge_atomic` 的正常路径，
      会被 `_check_derivable_ex` 按「能否由前提**推出**」判定 ——
      而 `x>0` 这类自加约束本就不是从前提推出的，必然被判 illegal。
      但用户口径第 1 条要求的是「**与前提无冲突**」（相容性），
      不是「可由前提推出」。两者判据不同，必须分开。

    判据（用户原话「该推导链前置所有前提与等式无冲突」）：
      把该段并入前提集 → 查可满足性
      - 可满足   → legit（该约束在此前提下成立）
      - 不可满足 → illegal constraint_conflict

    例（前提 `2x+y=40`）：
      `x=0`  → 解得 x=0,y=40  → 相容 → pass
      `x>0`  → 可满足          → 相容 → pass
      `x<0` 且图前提含 `x>0`   → 冲突   → 判错
    """
    # --- 轮次 T：限定条件段也必须支持自动声明（三处共享）---
    # 为什么：`a=2`、`F(2)=4` 这类「符号=数值」被 `_split_local_constraints`
    # 归入本通道（判据不同、不能走 `_judge_atomic`），若此处不补全，
    # 就会**绕过 ❶❷❸** 而被误报「未定义的符号 a / F」（实测确认）。
    use_ctx, _decl_err = _prepare_declarations(use_ctx, seg)
    if _decl_err is not None:
        return _decl_err

    try:
        rel = _sympify_relation(seg, use_ctx["locals"], use_ctx.get("funcParams"))
    except Exception as e:  # noqa: BLE001
        return {"legit": "illegal", "code": "unparsable", "detail": str(e)}

    bad = _check_undeclared(rel, use_ctx["declared"], use_ctx["funcNames"])
    if bad:
        return {"legit": "illegal", "code": "undeclared_symbol", "detail": bad}

    conflict, msg = _check_premise_conflict(list(use_ctx["relations"]) + [rel])
    if conflict:
        return {
            "legit": "illegal",
            "code": "constraint_conflict",
            "detail": "本步与已有前提冲突，无法同时成立：" + str(msg or ""),
        }

    # --- 定值指派后的矛盾检测（轮次 M 新增，第 23 例）---
    # 为什么必须补：`x=-1` 这类段能解出常数 → 归入本通道，而
    # `premise_engine` 的冲突检查**未能发现**它与 `x>0` 的矛盾
    # （实测判成 legit），必须再做一次「代入后求值为假」的确定检查。
    _pc, _pmsg = premise_structure.pinned_conflict(list(use_ctx["relations"]) + [rel])
    if _pc:
        return {
            "legit": "illegal",
            "code": "constraint_conflict",
            "detail": "本步的取值与已有前提矛盾：" + str(_pmsg or ""),
        }

    return {
        "legit": "legit",
        "code": "constraint_ok",
        "detail": "本步声明的限定条件与已有前提一致",
    }


def _integral_defs_from_relations(relations):
    """提取前提中「**符号 = 积分**」的定义式（轮次 X6 新增）。

    ## 为什么必须单独识别（本轮 A3/B2 实测确认）
      前提 `W = ∫_0^H f(h) dh`（定积分）/ `A = ∫2x dx`（不定积分）声明的是
      「某符号**按积分定义**」，而既有链路一律当**普通方程**处理：
        ① 前提里的 `Integral` 从不求值 → 残差含未求值 `Integral` →
           `_domain_identity_holds` 的 `sp.N` 必失败 → 采不到样本 →
           **误判「恒等」而放行**（实测 A3：错误答案 `W=m*g0*R*H/R` 判 legit）；
        ② `_check_premise_conflict` 不认识「+C 任意性」→ 把合法的
           `A=x**2+5`（与 `x**2` 差常数）判成「前提互相矛盾」（实测 B2）。

    ## 返回
      {符号名: 含 Integral 的表达式}。只收「**一侧是裸符号**、
      另一侧含 `Integral`」的等式 —— 与项目既有口径一致
      （`_solve_unique_var` 同样先认裸符号侧）。
    """
    out = {}
    for r in (relations or []):
        if not isinstance(r, sp.Eq):
            continue
        for a, b in ((r.lhs, r.rhs), (r.rhs, r.lhs)):
            if not isinstance(a, sp.Symbol):
                continue
            try:
                if not b.has(sp.Integral):
                    continue
            except Exception:  # noqa: BLE001
                continue
            out.setdefault(str(a), b)
    return out


def _judge_integral_definition(expr_raw, ctx):
    """前提含「符号 = 积分」定义时，本步 `符号 = 表达式` 的判定（轮次 X6 新增）。

    ## 用户裁定（本轮确认，已定案）
      **Q1**：定积分前提 + 提交**错值** → **fail**
        （定积分结果**唯一**，不给任何「差常数」宽容）
      **Q2**：不定积分前提 + 提交**差常数** → **pass**
        （`+C` 是积分常数，数学上合法）

    ## 判据
      **定积分** `Q = ∫_a^b f dv` —— 求值后**严格相等**：
        `W = m*g0*R*H/(R+H)` vs `∫_0^H m*g0*R²/(R+h)² dh` → 相等 → **pass**
        `W = m*g0*R*H/R`（分母漏 +H）→ 差非零 → **fail**
      **不定积分** `Q = ∫f dv` —— 代表**原函数集合**，判「**导数相同**」：
        `A = x**2`   → d/dx = `2x` = 被积函数 → **pass**
        `A = x**2+5` → 同上（差常数不影响导数）→ **pass**
        `A = x**2+x` → `2x+1` ≠ `2x` → **fail**

    ## 为什么不定积分用「导数相同」而非「与原函数差为常数」
      更**本质**，且**不依赖 SymPy 能否积出闭式原函数** ——
      只需对用户表达式求导、与**被积函数**比对，故被积函数含参数
      （`m/g0/R`）或形式复杂时同样稳健。

    ## 为什么必须**早于**除零检查与五类规则（实测 A3/B2 的误判点）
      A3 被五类规则第 3 条的「域上恒等」误放行（`relation_ok`）；
      B2 被 `_check_premise_conflict` 误判矛盾（`constraint_conflict`）。
      本通道在二者之前给出正确结论。

    ## 返回 None = 不适用（完全交既有流程，零副作用）
      仅在「本步一侧是裸符号」且「该符号在前提里有积分定义」时介入。
    """
    text = str(expr_raw or "").strip()
    if not text or "=" not in text:
        return None
    try:
        cur = _sympify_relation(text, ctx["locals"], ctx.get("funcParams"))
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(cur, sp.Eq):
        return None
    # ① 本步须有「裸符号侧」（否则交既有流程，不引入新判定路径）
    _sym_side, _expr_side = None, None
    for _a, _b in ((cur.lhs, cur.rhs), (cur.rhs, cur.lhs)):
        if isinstance(_a, sp.Symbol):
            _sym_side, _expr_side = _a, _b
            break
    if _sym_side is None:
        return None
    # ② 该符号在前提里须有「积分定义」
    _defs = _integral_defs_from_relations(ctx.get("relations"))
    _integ = _defs.get(str(_sym_side))
    if _integ is None:
        return None
    # ③ 前提的函数体先代入（`W=∫F(h)dh` + `F(h)=...` → 具体被积函数）
    try:
        _bdefs = _func_body_defs_from_relations(ctx["relations"], ctx["funcNames"])
        if _bdefs:
            _integ, _ = _apply_func_body_defs(_integ, _bdefs)
    except Exception:  # noqa: BLE001
        pass
    # ④ 取积分节点与积分变量
    _node = None
    try:
        for _nd in sp.preorder_traversal(_integ):
            if isinstance(_nd, sp.Integral) and _nd.limits:
                _node = _nd
                break
    except Exception:  # noqa: BLE001
        return None
    if _node is None:
        return None
    _iv = _node.limits[0][0]
    _is_definite = all(len(_t) == 3 for _t in _node.limits)

    if _is_definite:
        # 定积分：结果**唯一** → **严格相等**
        try:
            _val = _integ.doit()
        except Exception:  # noqa: BLE001
            return None
        if _val.has(sp.Integral):
            return None          # 积不出闭式 → 判不了，交既有流程
        # 本步右侧**自身也可能是积分**（D5：`W = ∫_0^H ... dh`）→ 先求值再比对
        _ex = _expr_side
        try:
            if _ex.has(sp.Integral):
                _ex = _ex.doit()
        except Exception:  # noqa: BLE001
            pass
        try:
            _dif = sp.simplify(_ex - _val)
        except Exception:  # noqa: BLE001
            return None
        if _dif == 0:
            return {
                "legit": "legit",
                "code": "integral_value_ok",
                "detail": "本步与前提中该量的定积分定义一致",
            }
        return {
            "legit": "illegal",
            "code": "integral_value_mismatch",
            "detail": (
                "本步与前提中该量的定积分定义不符：定积分结果唯一，"
                "两者之差 " + sp.sstr(_dif) + " 不为 0"
            ),
        }

    # 不定积分：代表**原函数集合**（差常数 C 合法）→ 判「导数相同」
    try:
        _rhs_d = sp.simplify(sp.diff(_expr_side, _iv))
        _lhs_f = sp.simplify(_node.function)
        _dif = sp.simplify(_rhs_d - _lhs_f)
    except Exception:  # noqa: BLE001
        return None
    if _dif == 0:
        return {
            "legit": "legit",
            "code": "integral_antiderivative_ok",
            "detail": "本步是前提中该量不定积分的原函数之一（可差积分常数 C）",
        }
    return {
        "legit": "illegal",
        "code": "integral_antiderivative_mismatch",
        "detail": (
            "本步与前提中该量的不定积分定义不符：其导数与被积函数之差 "
            + sp.sstr(_dif) + " 不为 0"
        ),
    }


def _same_func_def(params_a, body_a, params_b, body_b):
    """两份函数定义在**形参改名后**是否等价（轮次 R 新增）。

    与 `_func_def_eq` 同一口径，区别只是入参已经是 SymPy 对象（而非字符串）：
    把两组形参映射到同一批占位符号后再比较函数体。

    解析失败时返回 True（**宁可放过，不可误判冲突**）——
    与 `_func_def_eq` 保持一致：证据不足时不下「定义冲突」这种重结论。
    """
    if len(params_a) != len(params_b):
        return False
    try:
        subs_a, subs_b = {}, {}
        for i, (pa, pb) in enumerate(zip(params_a, params_b)):
            t = sp.Symbol("_r%d" % i)
            subs_a[pa] = t
            subs_b[pb] = t
        return sp.simplify(body_a.subs(subs_a) - body_b.subs(subs_b)) == 0
    except Exception:  # noqa: BLE001
        return True


def _is_builtin_func_name(name):
    """该名字是否属「系统级算子 / 内置常量」（轮次 U 新增）。

    它们不是**用户定义的函数**，三张表的提取都必须排除，否则
    `sin(x)` 会被当成「未赋值函数」而诱导系统去 solve 它的 body。
    """
    return (not name) or name in _IMPLICIT_MUL_FUNCS or name in _IMPLICIT_MUL_CONSTS


def _unassigned_funcs(expr, body_defs):
    """expr 中出现的「**未赋值函数**」集合（轮次 U 新增，用户口径）。

    ## 定义（用户三张表里的「未赋值」）
      形如 `name(实参…)` 的函数调用，且该 name
        ① 不是内置算子 / 内置常量（见 `_is_builtin_func_name`）
        ② **没有**已知函数体（body_defs 里没有）—— 「赋值」即「给了 body」

    ## 为什么以 body_defs 判「已赋值」，而不是查 funcNames
      用户口径：「先声明 f(x) 为**无 body** 函数，再根据等式替换 body 为 x+1」
      —— 「已声明」与「已赋值」是**两件事**。`f(x)+g(x)=x^2+2x` 里 f/g
      已声明（在 funcNames 中）但**都未赋值**，故二者都要算进来，
      由调用方按个数分流：
        1 个 → `sp.solve` 补 body；≥2 个 → 存 relation（前提消元判定）。

    ## 为什么返回**真实对象**而非名字
      `sp.solve(rel, 目标)` 需要 AppliedUndef **对象**作求解目标；
      按名字新建对象会因身份不一致而解不出来（与 subs 同一坑）。

    返回 set of AppliedUndef。
    """
    out = set()
    try:
        atoms = expr.atoms(_AppliedUndef)
    except Exception:  # noqa: BLE001
        return out
    for f in atoms:
        name = getattr(f.func, "__name__", "")
        if _is_builtin_func_name(name):
            continue
        if name in (body_defs or {}):
            continue
        out.add(f)
    return out


def _func_relations_from_facts(relations, body_defs):
    """提取「含**未赋值函数**的关系式」（轮次 U 新增，第一张新表）。

    ## 用户口径（原话）
      「相当于系统层根据 `f(x)+g(x)=x^2+3x` 等式建立一个函数关系的表
        `function_relations = [Eq(f(x)+g(x), x**2+2*x)]`」
      —— **保留原式，不做原子化**。

    ## 为什么不能原子化（用户已明确否决旧方案）
      原子化会把 `f(1)`、`f(2)`、`f(x)` 变成互不相干的原子，
      丢失「同一个函数」这一结构信息 → `f(x)=2x` 与 `f(1)=1`
      的冲突**漏判**。保留原式才能让 `sp.solve` / 前提消元看见函数形态。

    ## 为什么从 relations 而非原始 facts 字典提取
      「三张表都从 facts 重新提取 → 无需持久化」（用户口径）。
      而 relations 正是「facts + assumptions + domains + globalDomains
      + 场景默认关系」的**解析后全集** —— 从它提取可一次覆盖全部前提来源，
      且已是 SymPy 对象，无需二次解析（也避免与解析器口径分叉）。

    ## 判据
      等式且含至少一个「未赋值函数」（`_unassigned_funcs` 非空）。
      已声明**并已给 body** 的函数（如 `F(h)=h**2`）**不算** ——
      它属第一张表 function_bodies（由 `_func_body_defs_from_relations` 管）。
    """
    out = []
    for r in relations or []:
        if not isinstance(r, sp.Eq):
            continue
        if _unassigned_funcs(r, body_defs):
            out.append(r)
    return out


def _func_facts_from_facts(relations):
    """提取「函数**点值**事实」（轮次 U 新增，第二张新表）。

    ## 用户口径（原话）
      「再根据 `f(1)=1, f(2)=2` 建立值对应关系表，
        `function_facts = {('f', 1): 1, ('f', 2): 2}`，
        相当于建立函数 f 在 1 处值为 1 这样一个前提，
        后续用户提交函数 body，`f(x)=x` 就可以以此前提来验证」

    ## 判据：**实参全是常数**
      `f(1)=1`    → 实参是常数   → 是「单点实例」，入表       ✅
      `f(x)=x+1`  → 实参是裸符号 → 是**定义**（第一张表），不入 ✅
      `f(x+1)=3`  → 实参是表达式 → 记不清是哪个点，不入       ✅
      这正是 `_func_body_defs_from_relations` 的**镜像判据**
      （两者互为补集：一边收「裸符号实参」，一边收「常数实参」）。

    ## 返回形状（与用户给的完全一致）
      {(name, *常数实参): 值}，如 {('f', 1): 1, ('f', 2): 2}。
    """
    out = {}
    for r in relations or []:
        if not isinstance(r, sp.Eq):
            continue
        for lhs, rhs in ((r.lhs, r.rhs), (r.rhs, r.lhs)):
            if not isinstance(lhs, _AppliedUndef):
                continue
            name = getattr(lhs.func, "__name__", "")
            if _is_builtin_func_name(name):
                continue
            args = list(lhs.args)
            if not args:
                continue
            try:
                if not all(a.is_number for a in args):
                    continue
            except Exception:  # noqa: BLE001
                continue
            try:
                out[(name,) + tuple(args)] = rhs
            except Exception:  # noqa: BLE001
                continue
    return out


def _solve_single_unassigned_func(rel, body_defs, relations, func_facts):
    """「只剩一个未赋值函数」的等式 → 解成 `name(单符号) = 表达式`（轮次 U 新增）。

    ## 用户口径（原话）
      「在前提 `f(x)=x+1` 的情况下用户提交 `f(x)+g(x)=x^2+2x`，还要先完成一步，
        识别到已声明函数 `f(x)`，**替换**为 `x+1+g(x)=x^2+2x`，
        再识别到未声明函数 `g(x)`，先声明为无 body 函数，
        然后再看等式格式可转化为 `g(x)=x^2+x-1`，这就是函数声明的格式」
      → 即「替换 → 声明 → **解出** → 补 body」四步中的第三步。

    ## 为什么用 sp.solve 而不是「裸符号侧」判据
      `_solve_unique_var` 认的是「裸符号侧 / 唯一变量解」，而 `g(x)` 是
      **AppliedUndef** —— 它既非 sp.Symbol，其 free_symbols 也**不含** g
      （探针实测），故既有机制完全「看不见」它。
      `sp.solve(rel, g(x))` 则直接可解（实测 → `[x^2+x-1]`）。

    ## 三层验证（D3 乙：bodies ↔ relations ↔ facts 都要满足）
      ① relations 层：把补出的 body 代入**每条前提**，残差须为 0
      ② facts 层：`f(1)=1` 这类点值，代入 body 后须成立
      ③ 任一不满足 → fail（func_body_conflict），并点明冲突项

    ## D1 除零：**必须分母级检查，不可整体化简**
      实测：SymPy 自动约分 `x**2/x → x`，
      `fraction(together(x**2/x - x)) = (0, 1)` —— 除零条件**彻底丢失**。
      故此处「**单独**把 body 替换进**原式分母**」，
      再查「该分母 = 0」与前提是否**可满足**：可满足 → 有零点 → 除零风险。

    返回 dict 或 None（不适用本通道时）。
    """
    if not isinstance(rel, sp.Eq):
        return None
    _targets = list(_unassigned_funcs(rel, body_defs))
    if len(_targets) != 1:
        return None                     # 0 个 → 既有等式判定；≥2 个 → 走 relation
    _tgt = _targets[0]
    _name = getattr(_tgt.func, "__name__", "")
    if not _name:
        return None
    _args = list(_tgt.args)
    # 实参必须全是**裸符号**才能当形参（`g(x+1)=…` 记不清在哪个点，不猜）
    if not _args or not all(isinstance(a, sp.Symbol) for a in _args):
        return None
    try:
        _sols = sp.solve(rel, _tgt)
    except Exception:  # noqa: BLE001
        return None
    if not (isinstance(_sols, list) and len(_sols) == 1):
        return None                     # 无解 / 多解 → 非函数定义形态
    try:
        _body = sp.simplify(_sols[0])
    except Exception:  # noqa: BLE001
        _body = _sols[0]
    # 解出的表达式若仍含**未赋值函数**，则它不是 body（只是把等式移了项）
    if _body.atoms(_AppliedUndef):
        return None

    _new_defs = dict(body_defs or {})
    _new_defs[_name] = {"params": _args, "body": _body}

    def _conflict(code, detail, div=None):
        return {
            "ok": False,
            "code": code,
            "name": _name,
            "params": _args,
            "body": _body,
            "divRisk": div,
            "detail": detail,
        }

    # ① relations 层
    for _r in (relations or []):
        try:
            _sub, _n = _apply_func_body_defs(_r, _new_defs)
        except Exception:  # noqa: BLE001
            continue
        if not _n or not getattr(_sub, "is_Relational", False):
            continue                    # 与本函数无关的前提：不参与本层验证
        try:
            _d = sp.simplify(_sub.lhs - _sub.rhs)
        except Exception:  # noqa: BLE001
            continue
        if _d != 0:
            return _conflict(
                "func_body_conflict",
                "新声明的函数 " + _name + " 与已有前提不相容："
                "代入后仍有残差，前提无法同时成立",
            )

    # ② facts 层（点值事实）
    for _key, _fval in (func_facts or {}).items():
        try:
            _fname, _fargs = _key[0], list(_key[1:])
        except Exception:  # noqa: BLE001
            continue
        if _fname != _name or len(_fargs) != len(_args):
            continue
        try:
            _fv = _body.subs({p: a for p, a in zip(_args, _fargs)}, simultaneous=True)
            _fd = sp.simplify(_fv - _fval)
        except Exception:  # noqa: BLE001
            continue
        if _fd != 0:
            _at = "、".join(sp.sstr(a) for a in _fargs)
            return _conflict(
                "func_body_conflict",
                "新声明的函数 " + _name + " 与已有点值前提矛盾："
                + _name + "(" + _at + ")=" + sp.sstr(_fval) + " 不成立",
            )

    # ③ 分母级除零（**不可**整体化简，会被 SymPy 约分抹掉）
    _div = None
    try:
        for _den in _collect_denominators(rel):
            _den2, _n2 = _apply_func_body_defs(_den, _new_defs)
            if not _n2:
                continue                # 分母与本函数无关 → 既有除零检查已覆盖
            # 「该分母 = 0」与前提**可满足** → 存在使分母为零的取值 → 风险
            _cf, _ = _check_premise_conflict(list(relations or []) + [sp.Eq(_den2, 0)])
            if not _cf:
                _div = sp.sstr(_den2)
                break
    except Exception:  # noqa: BLE001
        pass

    return {
        "ok": True,
        "code": "func_body_declared",
        "name": _name,
        "params": _args,
        "body": _body,
        "divRisk": _div,
        "detail": (
            "已声明函数 " + _name + "("
            + ", ".join(str(a) for a in _args) + ") = " + sp.sstr(_body)
        ),
    }


def _function_declaration_result(raw, locals_map):
    """整段就是「函数声明」时返回结果 dict；否则 None（轮次 T 新增）。

    ## 用户口径（原话）
      「`a(x)=x+1` 走**函数声明路线，不做等式判定**」
      —— 例 2 的完整期望：先声明变量 x，再声明**函数 a**（body = x+1），**pass**。

    ## 为什么必须与「等式判定」分开
      `a(x)=x+1` 若进普通判定，会被当作**含未知函数 a 的等式**：
      `analyze_structure` 无从判断 `a(x)` 与 `x+1` 的关系 →
      返回 `unknown`（实测确认，这正是例 2 当前不通过的成因）。
      而它的语义是「**给 a 下定义**」，与「推出某个结论」是两回事 ——
      定义无需被推导，语法成立即为合法。

    ## 判据（与 `_auto_declare_symbols` 的 ③ 同源）
      原文**整段**形如 `name(单符号[, 单符号]*)`（即 `_FUNC_DECL_RE.fullmatch`），
      且该名字**未在场景 symbols 中声明**为变量/常量/函数，
      且不是内置算子/常量名 → 认定为「函数声明」。

    ## 为什么要求「整段」形如声明记法
      仅「出现 `name(单符号)`」不足以断定是声明 ——
      `a(x)+1=2` 里的 `a(x)` 是**调用**（那条式子要判等式是否成立）。
      只有整段就是一个函数记法（独占等号一侧）才是**声明**。

    ## 也接受 `body = a(x)` 的左右对称写法（与 `_classify_equation` 一致）
    """
    segs = _split_chain(_normalize_notation(str(raw or "")))
    if not segs or len(segs) != 2:
        return None
    _lhs, _rhs = (segs[0] or "").strip(), (segs[1] or "").strip()
    _m = _FUNC_DECL_RE.fullmatch(_lhs)
    _body = _rhs
    if not _m:
        _m = _FUNC_DECL_RE.fullmatch(_rhs)
        _body = _lhs
    if not _m:
        return None
    _nm = _m.group(1)
    # 已声明为变量/常量/函数 → 不是「新声明」，交常规判定（尊重场景定义）
    if _nm in (locals_map or {}):
        return None
    if _nm in _IMPLICIT_MUL_FUNCS or _nm in _IMPLICIT_MUL_CONSTS:
        return None
    _params = [p.strip() for p in _m.group(2).split(",") if p.strip()]
    return {
        "legit": "legit",
        "code": "function_declared",
        "detail": (
            "已声明函数 " + _nm + "(" + ", ".join(_params) + ")"
            + (" = " + _body if _body else "")
        ),
    }


def _func_body_defs_from_relations(relations, func_names):
    """从前提关系对象中提取**函数定义体**（轮次 R 新增，供代入使用）。

    ## 为什么需要（用户口径）
    「已有前提 `F(h)=h**2` 声明了函数定义，当用户提交 `F(2)=4` 时，
    要处理 `F(2)` 隐含的前提 `h=2`，然后替换 `F(h)`，得到 `h**2=4`」。
    即 `F(h)=h**2` 是一份**对任意 h 成立**的函数定义，凡出现 `F(实参)`
    都可以展开成 `体[形参 := 实参]`。

    ## 只认可「函数声明形状」的等式（与 `_func_defs_from_facts` 同口径）
      `F(h)=h**2`    → 形参是**裸符号**   → 是定义，可代入      ✅
      `F(h,t)=h+t`   → 多形参同样是定义                        ✅
      `F(2)=4`       → 形参是**常数**     → 只是单点实例，**不是定义** ❌
      `F(x+1)=...`   → 形参是表达式       → 同上                ❌
    只有这样，代入用的才是「普遍成立的规律」，而不是把某个特例当规律。

    ## 同名多条定义：不等价则**整名排除**
    两条支链各自声明了 `F` 时，前提集里会同时出现多条同名定义。此处只在
    「形参改名后仍互相等价」时才采用（如 `F(h)=h**2` 与 `F(t)=t**2`）；
    一旦不等价就把该名字**整体排除**，把问题留给既有的
    `_check_function_conflicts`（报「支链函数重名」），
    避免用其中一条静默掩盖冲突。

    返回 {函数名: {"params": [Symbol, ...], "body": Expr}}。
    """
    out = {}
    # --- 轮次 T 放宽：不再要求函数名**预先**在场景 symbols 中声明 ---
    #
    # 为什么必须放宽（实测确认的缺陷）：
    #   given 里写 `F(h)=h**2` 时，`F` 往往**不在**场景 symbols 中
    #   （生成阶段只声明了变量 h）。旧实现 `if name not in known: continue`
    #   使这条定义**提取不到** → 下游报「未定义的符号 F」。
    #   而按用户口径：`F(h)=h**2` 本身就是一份**函数声明**，应当登记。
    #
    # 排除项只保留「内置算子 / 常量名」—— 它们不是用户定义的函数。
    buckets = {}
    for r in relations or []:
        if not isinstance(r, sp.Eq):
            continue
        for lhs, rhs in ((r.lhs, r.rhs), (r.rhs, r.lhs)):
            if not isinstance(lhs, _AppliedUndef):
                continue
            name = getattr(lhs.func, "__name__", "")
            if name in _IMPLICIT_MUL_FUNCS or name in _IMPLICIT_MUL_CONSTS:
                continue
            args = list(lhs.args)
            if not args or not all(isinstance(a, sp.Symbol) for a in args):
                continue
            buckets.setdefault(name, []).append((args, rhs))
            break
    for name, items in buckets.items():
        p0, b0 = items[0]
        ok = True
        for p1, b1 in items[1:]:
            if not _same_func_def(p0, b0, p1, b1):
                ok = False
                break
        if ok:
            out[name] = {"params": p0, "body": b0}
    return out


def _auto_declare_symbols(raw, locals_map, func_names):
    """自动声明原文中**未声明**的标识符（轮次 T 新增，用户口径）。

    ## 判定顺序（**互斥**，命中即退出 —— 用户明确要求）
      ① 算子      在 `_IMPLICIT_MUL_FUNCS` / `_IMPLICIT_MUL_CONSTS` → 跳过
      ② 已声明    在 `locals_map` / `func_names` 中 → 跳过（保留原 kind 与属性）
      ③ 函数      形如 `name(单符号)` 且位于**等号某一侧**（函数声明形状）→ Function
      ④ 变量      其余 → Symbol

    ## 为什么顺序不可颠倒（用户原话）
      「否则会出现，系统先判断 a 是一个未声明的变量，就不会判断 a 是不是一个函数了」
      —— `a(x)=x+1` 中 `a` 必须先被判为**函数**（③），
      否则会被 ④ 抢先生成为变量，导致 `a(x)` 被解析成 `a*x`。

    ## 为什么要「等号某一侧」这个额外条件（关键）
      仅「`name(单符号)`」不足以断定是**声明** ——
      `a(x)+1=2` 里的 `a(x)` 是**调用**而非声明。
      用户口径的例子是 `a(x)=x+1`（整侧就是声明形状），
      故判据取「**整段**形如 `name(单符号)`」。
      非声明形状的 `name(...)` 会走到 ④ 成为变量 → 按乘法处理（如 `a(x+1)`）。

    ## 返回
      (新的 locals_map, 新的 func_names 集合)。**不修改入参**（调用方自行取用）。
    """
    out_locals = dict(locals_map or {})
    out_funcs = set(func_names or [])
    if not isinstance(raw, str) or not raw.strip():
        return out_locals, out_funcs

    text = _normalize_notation(raw)

    # --- ③ 收集「函数用法」：**出现** name(单符号[, 单符号]*) 即算（轮次 U 放宽）---
    #
    # ## 为什么从「整段」放宽为「出现」（用户口径，解决 vgdecl #15）
    #   用户原话（函数声明**两阶段**组装）：
    #     「系统识别到未声明函数，先声明 f(x) 为无 body 函数，
    #       再根据等式替换 body 为 x+1，才算组装完成一个完整的函数声明」
    #   `f(x)+g(x)=x^2+2x` 里的 `f(x)`、`g(x)` 是**函数用法**（不独占等号一侧），
    #   但按上述口径它们**首先要被声明为无 body 函数** ——
    #   否则会被 ④ 抢判成变量，整式被解析成 `f*x+g*x=...`
    #   （实测：假阳性 pass/new_definition，vgdecl #15）。
    #
    # ## 三个安全边界（**已逐一验证行为不变**）
    #   ① `x(40-2*x)`：括号内非单符号 → 本正则不命中 → x 走 ④ 变量（乘法）
    #   ② `sqrt(x)`：sqrt 在 _IMPLICIT_MUL_FUNCS → ① 白名单跳过
    #   ③ `a(x+1)`：括号内非单符号 → 不命中 → a 走 ④ 变量（乘法）
    #   与「真实函数用法」的区别正是「括号内是不是单个符号」，判据未放松。
    #
    # ## 与 `_function_declaration_result` 的判据**刻意不同**（勿合并）
    #   本处判「**是不是函数**」→ 出现即算（形态宽松）；
    #   彼处判「**这次提交是不是一份声明**」→ 必须**整段独占等号一侧**
    #   （否则 `a(x)+1=2` 会被误判为声明而**绕过等式判定**）。
    decl_params: dict = {}
    for m in _FUNC_DECL_RE.finditer(text):
        nm = m.group(1)
        if nm in _IMPLICIT_MUL_FUNCS or nm in _IMPLICIT_MUL_CONSTS:
            continue
        decl_params.setdefault(nm, [p.strip() for p in m.group(2).split(",") if p.strip()])

    # --- 扫描原文中的所有标识符，按 ①→②→③→④ 互斥判定 ---
    used = {m.group(0) for m in _IDENT_RE.finditer(text)}
    for name in sorted(used):
        # ① 算子 / 内置常量：系统级隐藏前提，永不声明
        if name in _IMPLICIT_MUL_FUNCS or name in _IMPLICIT_MUL_CONSTS:
            continue
        # ② 已声明（场景 symbols / 前提登记）：保留原状（含 positive 等属性）
        if name in out_locals or name in out_funcs:
            continue
        # ③ 函数声明形状 → Function（并顺带声明其形参为变量）
        if name in decl_params:
            out_locals[name] = sp.Function(name)
            out_funcs.add(name)
            for p in decl_params[name]:
                if p and p not in out_locals and p not in _IMPLICIT_MUL_FUNCS \
                        and p not in _IMPLICIT_MUL_CONSTS:
                    out_locals[p] = sp.Symbol(p, real=True)
            continue
        # ④ 其余 → 变量
        out_locals[name] = sp.Symbol(name, real=True)

    return out_locals, out_funcs


def _apply_func_body_defs(expr, defs, max_rounds=5):
    """把 expr 中的「已定义函数调用」展开为函数体（轮次 R 新增）。

    逐个把 `F(实参…)` 替换成 `体[形参 := 实参]`；替换后若又冒出可代入的
    函数则继续，直到不动点（最多 `max_rounds` 轮 —— 防 `F(h)=G(h)` /
    `G(h)=F(h)` 这类循环定义造成死循环）。

    实参个数与形参不符时**跳过**该调用（不猜测语义）。
    返回 (新表达式, 替换次数)。
    """
    if not defs or expr is None:
        return expr, 0
    cur, total = expr, 0
    for _ in range(max_rounds):
        try:
            reps = {}
            for f in cur.atoms(sp.Function):
                name = getattr(f.func, "__name__", "")
                d = defs.get(name)
                if not d:
                    continue
                params = d.get("params") or []
                if len(f.args) != len(params):
                    continue
                try:
                    reps[f] = d["body"].subs(
                        {p: a for p, a in zip(params, f.args)}, simultaneous=True
                    )
                except Exception:  # noqa: BLE001
                    continue
            if not reps:
                break
            cur = cur.xreplace(reps)
            total += len(reps)
        except Exception:  # noqa: BLE001
            break
    return cur, total


def _register_premise_functions(ctx):
    """❶ 把**前提中声明的函数**登记进 locals（轮次 T 抽出，用户口径）。

    ## 用户口径（原话）
      「先判断 `F(h)` 是不是**已经声明的函数**，再判断这个是等式还是声明；
        如果是已经声明的函数，就走**等式判断路径**，如果不是就走**函数声明**」

    「已经声明」包含两类：
      1. 场景 symbols 里的 kind='function'（`_compile_symbols` 已处理）
      2. **前提 / given 里声明的函数** —— given 写 `F(h)=h**2` 时，
         场景 symbols 里往往只有 `h`，`F` 是靠这条前提才成为「已声明函数」。
         本函数负责把这类登记进 locals / funcNames。

    ## 为什么必须独立成函数（关键：调用时序 —— 实测确认）
      `_function_declaration_result`（「是等式还是声明」的判据）之一是
      「该名字**未在 locals 中**声明」—— 故**必须先调用本函数**。
      否则 given 里已声明的 `F` 不被视为「已声明」，`F(h)=h**3` 会被误判为
      「函数声明」而**绕过等式判定**（实测：应走 `func_body_solvable`，
      却被 `function_declared` 抢先放行）。**不存在「重定义」机制**——
      该现象纯粹是这段时序被颠倒所致。
    """
    _predefs = _func_body_defs_from_relations(ctx["relations"], ctx["funcNames"])
    if not _predefs:
        return ctx
    ctx = dict(ctx)
    _locs = dict(ctx["locals"])
    _fns = set(ctx["funcNames"])
    _fps = dict(ctx.get("funcParams") or {})
    for _nm in _predefs:
        if _nm not in _fns:
            _locs[_nm] = sp.Function(_nm)
            _fns.add(_nm)
        _fps.setdefault(_nm, [str(p) for p in (_predefs[_nm].get("params") or [])])
    # --- 轮次 T 补充（用户口径）：前提里出现的**自由符号** → 声明为变量 ---
    # 用户原话：「前提 given `F(h)=h*z` 做了几件事：声明函数 F(h)=h*z，
    #   **声明变量 h 和 z**」—— given 还把它引用的符号一并声明为变量。
    #
    # 为什么必须补（实测能力缺口，探针 E2）：提交 `F(2)=3` + given `F(h)=h*z` 时，
    #   ① 本函数登记了 F，但未登记 z；② `_auto_declare_symbols` 只扫**本次提交
    #   文本**（`F(2)=3` 不含 z）→ z 仍未声明；③ 函数体代入得 `2*z=3`，
    #   但守卫 `_check_undeclared` 发现 z 未声明 → **丢弃代入结果**；
    #   ④ 退回原式 → unknown（实测 FAIL）。补后 → `2z=3` 有解 → pass。
    #
    # 为什么取「关系的 free_symbols」：`Eq(F(h),h*z).free_symbols` = {h,z}
    #   形参与函数体引用**一次性全覆盖**；且用**关系中真实 Symbol 对象**
    #   （避免新建 Symbol 身份不一致导致 subs 静默失效）。
    for _r in (ctx.get("relations") or []):
        try:
            _syms = getattr(_r, "free_symbols", None) or set()
        except Exception:  # noqa: BLE001
            continue
        for _s in _syms:
            if str(_s) not in _locs:
                _locs[str(_s)] = _s
    ctx["locals"] = _locs
    ctx["funcNames"] = _fns
    ctx["funcParams"] = _fps
    ctx["declared"] = set(_locs.keys())
    return ctx


def _prepare_declarations(ctx, raw):
    """轮次 T：前提函数登记 → R8 检查 → 自动声明（三处共享）。

    ## 为什么必须抽成共享函数
      ❸「自动声明」原本只加在 `_judge_atomic` 里，但**限定条件段**走的是
      `_judge_constraint`（`_judge_atomic` 的 docstring 已说明二者判据不同、
      必须分开）—— 于是 `a=2`、`F(2)=4` 这类「符号=数值」被
      `_split_local_constraints` 归为限定条件后，**绕过了 ❶❷❸**：
        实测 `a=2` → 「限定条件 a=2 不成立：未定义的符号：a」
        实测 `F(2)=4`（given F(h)=h²）→ 「未定义的符号：F」
      同理 `cmd_session_step` 入口的 `_split_local_constraints`
      **本身也依赖 locals**（`_is_constraint_segment` 要 sympify 判断
      「能否解出常数」），故入口处必须先补全。

    ## 返回
      (新 ctx, 错误 dict 或 None)。错误非空时调用方直接返回该错误。
    """
    _scan = _normalize_notation(str(raw or ""))
    try:
        # ❶ 前提里的函数定义 → 登记为 function（供 ❷ 的 R8 正确放行）
        # 幂等：入口处可能已调用过（时序要求见 `_register_premise_functions`）
        ctx = _register_premise_functions(ctx)

        # ❷ R8：未声明函数 + **数字实参** → 报错（只可能是「代入求值」）
        #    必须在 ❸ 之前，否则 F 会被自动声明成函数，R8 永不触发
        _vars = [n for n, o in ctx["locals"].items() if not isinstance(o, sp.FunctionClass)]
        try:
            _check_undeclared_func_call(_scan, _vars, list(ctx["funcNames"]))
        except _FunctionNotDeclared as _e:  # noqa: PERF203
            return ctx, {"legit": "illegal", "code": "undeclared_symbol", "detail": str(_e)}

        # ❸ 自动声明（互斥：算子 → 已声明 → 函数 → 变量）
        _nl, _nf = _auto_declare_symbols(_scan, ctx["locals"], ctx["funcNames"])
        if len(_nl) != len(ctx["locals"]) or _nf != ctx["funcNames"]:
            ctx = dict(ctx)
            ctx["locals"] = _nl
            ctx["funcNames"] = _nf
            ctx["declared"] = set(_nl.keys())
    except Exception:  # noqa: BLE001
        pass
    return ctx, None


def _context_function_defs(ctx):
    """合并场景 symbols.body 与已连线的函数定义。"""
    out = dict(ctx.get("functionDefs") or {})
    try:
        out.update(_func_body_defs_from_relations(ctx["relations"], ctx["funcNames"]))
    except Exception:  # noqa: BLE001
        pass
    return out


def _partial_constant_subs(ctx, independent_names):
    """PDE 验证时可安全代入的参数定值（不钉死自变量）。"""
    excluded = set(independent_names or [])
    out = {}
    for name, raw in (ctx.get("constValues") or {}).items():
        if name in excluded or raw is None:
            continue
        sym = ctx["locals"].get(name)
        if not isinstance(sym, sp.Symbol):
            continue
        try:
            out[sym] = sp.sympify(str(raw), locals=ctx["locals"])
        except Exception:  # noqa: BLE001
            continue
    for rel in (ctx.get("relations") or []):
        if not isinstance(rel, sp.Eq):
            continue
        for side, other in ((rel.lhs, rel.rhs), (rel.rhs, rel.lhs)):
            if not isinstance(side, sp.Symbol) or str(side) in excluded:
                continue
            try:
                if other.has(sp.Derivative) or other.has(sp.Integral) \
                        or other.atoms(_AppliedUndef):
                    continue
                if {str(s) for s in other.free_symbols} & excluded:
                    continue
            except Exception:  # noqa: BLE001
                continue
            out.setdefault(side, other)
    return out


def _judge_partial_equation(current, ctx, partial_hint=False):
    """偏微分等式的声明/验证分流。

    - 被偏导函数没有 body：本步是 PDE 约束声明，不伪装成已验证恒等式。
    - 所有相关函数都有 body：展开函数体、求偏导，要求残差恒为 0。

    与通用方程“存在一个解即 legit”的口径刻意分开：
    ``u=x**2+y`` 时 ``∂u/∂x=3x`` 虽在 x=0 成立，但不是 PDE 恒等验证。
    """
    if not isinstance(current, sp.Eq):
        return None
    try:
        derivatives = list(current.atoms(sp.Derivative))
    except Exception:  # noqa: BLE001
        return None
    if not derivatives:
        return None

    func_params = ctx.get("funcParams") or {}
    func_atoms = set()
    bare_function_names = set()
    for node in derivatives:
        try:
            func_atoms |= set(node.expr.atoms(_AppliedUndef))
        except Exception:  # noqa: BLE001
            continue
        if isinstance(node.expr, sp.Symbol):
            diff_names = {str(v) for v in node.variables}
            name = str(node.expr)
            if name not in diff_names and (partial_hint or name in ctx.get("funcNames", set())):
                bare_function_names.add(name)
    is_partial = bool(partial_hint)
    if not is_partial:
        for call in func_atoms:
            name = getattr(call.func, "__name__", "")
            if len(call.args) >= 2 or len(func_params.get(name) or []) >= 2:
                is_partial = True
                break
    if not is_partial:
        return None

    if bare_function_names:
        return {
            "legit": "unknown",
            "code": "partial_function_signature_missing",
            "detail": (
                "偏导函数 " + "、".join(sorted(bare_function_names))
                + " 缺少形参签名；请在场景 symbols 中声明 params，"
                "例如 u(x,y) 对应 params=[\"x\",\"y\"]"
            ),
        }

    defs = _context_function_defs(ctx)
    func_names = {
        getattr(call.func, "__name__", "") for call in func_atoms
        if getattr(call.func, "__name__", "")
    }
    missing = sorted(name for name in func_names if name not in defs)
    if missing:
        conflict, msg = _check_premise_conflict(list(ctx.get("relations") or []))
        if conflict:
            return {
                "legit": "conflict",
                "code": "premise_conflict",
                "detail": msg,
            }
        return {
            "legit": "legit",
            "code": "partial_equation_declared",
            "detail": (
                "已登记偏微分约束；函数 " + "、".join(missing)
                + " 尚无函数体，因此本步是声明，不是恒等验证"
            ),
        }

    lhs, rhs = current.lhs, current.rhs
    replaced = 0
    try:
        lhs, n1 = _apply_func_body_defs(lhs, defs)
        rhs, n2 = _apply_func_body_defs(rhs, defs)
        replaced = n1 + n2
        lhs = _eval_derivatives(lhs)
        rhs = _eval_derivatives(rhs)
    except Exception:  # noqa: BLE001
        return {
            "legit": "unknown",
            "code": "partial_not_evaluable",
            "detail": "偏导表达式无法完成函数体代入或求导",
        }

    try:
        if lhs.has(sp.Derivative) or rhs.has(sp.Derivative):
            return {
                "legit": "unknown",
                "code": "partial_not_evaluable",
                "detail": "偏导表达式仍含无法求值的导数，请补充相关函数体",
            }
    except Exception:  # noqa: BLE001
        pass

    independent = set()
    for name in func_names:
        d = defs.get(name) or {}
        independent |= {str(p) for p in (d.get("params") or [])}
    try:
        residual = sp.simplify(lhs - rhs)
        subs = _partial_constant_subs(ctx, independent)
        for _ in range(4):
            new = sp.simplify(residual.subs(subs)) if subs else residual
            if new == residual:
                break
            residual = new
    except Exception:  # noqa: BLE001
        return {
            "legit": "unknown",
            "code": "partial_not_evaluable",
            "detail": "偏微分等式的残差无法化简",
        }

    if residual == 0:
        return {
            "legit": "legit",
            "code": "partial_identity_ok",
            "detail": "代入函数体并求偏导后，两侧恒等",
        }
    return {
        "legit": "illegal",
        "code": "partial_identity_mismatch",
        "detail": (
            "代入函数体并求偏导后，两侧残差 " + sp.sstr(residual)
            + " 不恒为 0" + ("" if replaced else "；未发生函数体替换")
        ),
    }


def _judge_ode_candidate(raw, ctx):
    """验证 ``y(x)=...`` 是否满足已连接的一元 ODE 及初值条件。"""
    try:
        candidate = _sympify_relation(raw, ctx["locals"], ctx.get("funcParams"))
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(candidate, sp.Eq):
        return None

    definition = None
    for call, body in ((candidate.lhs, candidate.rhs), (candidate.rhs, candidate.lhs)):
        if not isinstance(call, _AppliedUndef):
            continue
        params = list(call.args)
        if not params or not all(isinstance(param, sp.Symbol) for param in params):
            continue
        if len({str(param) for param in params}) != len(params):
            continue
        definition = (getattr(call.func, "__name__", ""), params, body)
        break
    if not definition:
        return None

    name, params, body = definition
    if len(params) != 1:
        return None

    def contains_target(expression):
        try:
            return any(
                getattr(call.func, "__name__", "") == name
                for call in expression.atoms(_AppliedUndef)
            )
        except Exception:  # noqa: BLE001
            return False

    relevant = [
        relation for relation in (ctx.get("relations") or [])
        if isinstance(relation, sp.Eq) and contains_target(relation)
    ]
    ode_relations = [
        relation for relation in relevant
        if any(
            contains_target(node.expr)
            for node in relation.atoms(sp.Derivative)
        )
    ]
    if not ode_relations:
        return None

    definitions = {name: {"params": params, "body": body}}
    substitutions = _partial_constant_subs(ctx, {str(param) for param in params})
    for relation in relevant:
        try:
            replaced, count = _apply_func_body_defs(relation, definitions)
            if not count:
                raise ValueError("函数体无法代入")
            if replaced is sp.true or replaced is True:
                residual = sp.S.Zero
            elif replaced is sp.false or replaced is False:
                residual = sp.S.One
            elif isinstance(replaced, sp.Eq):
                lhs = _eval_derivatives(replaced.lhs)
                rhs = _eval_derivatives(replaced.rhs)
                residual = sp.simplify(lhs - rhs)
            else:
                raise ValueError("只支持等式形式的微分方程和初值条件")
            if substitutions:
                residual = sp.simplify(residual.subs(substitutions, simultaneous=True))
        except Exception as exc:  # noqa: BLE001
            return {
                "legit": "unknown",
                "code": "ode_solution_not_evaluable",
                "detail": "候选函数无法完整代入微分方程或初值条件：" + str(exc),
            }
        if residual != 0:
            return {
                "legit": "illegal",
                "code": "ode_solution_mismatch",
                "proofBasis": "unknown",
                "detail": "候选函数不满足已连接的微分方程或初值条件，残差为 " + sp.sstr(residual),
            }
    return {
        "legit": "legit",
        "code": "ode_solution_ok",
        "detail": "候选函数满足已连接的微分方程及全部初值条件",
    }


def _judge_atomic(args, ctx):
    """单个关系式的原子判定（前提链前置关卡的完整规程）。

    为什么从 `cmd_session_step` 抽出（轮次 I）：链式等式必须**逐段**判定，
    而每一段与单段输入要走完全相同的前置关卡（未声明符号 / 除零 /
    前提矛盾 / 函数冲突 / 定义式 / 孤立节点 / 可推导性）。
    不抽出来就得复制整段逻辑，后续任何修正都要改两处，必然漏一处。

    返回 StepLegitResult 形态的 dict。
    """
    # 原文扫描：识别「被当成函数用但场景未声明」的名字（如 E(x)）。
    # 为什么必须扫原文：sympify("E(x)") 会把 E 解析成 SymPy 内置 exp，
    # 既不是 AppliedUndef 也不产生自由符号 E，结构检查完全看不见它（探针 A3 实测）。
    #
    # --- 轮次 O 修复（同「F*a*l*s*e」一族，实测确认）---
    # **扫描前先做记法归一**，否则 LaTeX 残渣会被误报为「未定义的函数」。
    #
    # 为什么必须归一（实测）：输入 `2x+3y=2x+3\left(kx-7\right)` 若**绕过
    #   `cmd_parse` 直接**进入本函数（如探针对照组 / 将来新增的入口），
    #   `\left(` 中的 `left(` 会被 `scan_undeclared_funcs` 的正则
    #   `([A-Za-z_]\w*)\s*\(` 命中 → 报「未定义的函数：left」。
    #   而 `_normalize_notation` 内本就有 `_LATEX_LEFT_RIGHT_RE` 专门剥除
    #   `\left(` / `\right)`（同一套归一已在 `_sympify_relation` 中生效，
    #   故**解析**没问题，只有**扫描**漏了这一步）。
    #
    # 为什么不破坏 `E(x)` 检测：`_normalize_notation` 只做确定性字符替换
    #   （LaTeX 括号 / 全角括号 / 撇号导数 / `^`→`**` / 中文单位），
    #   不触碰标识符本身，故 `E(x)` 仍会被扫出（原有能力不变）。
    _scan_text = _normalize_notation(str(args.get("expr") or ""))
    bad_fn = premise_engine.scan_undeclared_funcs(
        _scan_text, ctx["declared"], ctx["funcNames"]
    )
    if bad_fn:
        return {
            "legit": "illegal",
            "code": "undeclared_symbol",
            "detail": "未定义的函数：" + bad_fn,
        }

    # --- 轮次 T：❶ 前提函数登记 → ❷ R8 检查 → ❸ 自动声明 ---
    #
    # 为什么顺序**不可更换**（用户口径）：
    #   ❶ 必须在 ❷ 之前 —— 否则 given 里已声明的函数会被 R8 误报「未定义」；
    #   ❷ 必须在 ❸ 之前 —— 否则 `F(2)=4` 无前提时，`F` 会被自动声明成函数，
    #      R8 永远不触发（用户明确要求「无前提的 F(2)=4 应判有问题」）。
    #
    # ❸ 的判定顺序（互斥）：算子 → 已声明 → 函数 → 变量（见 `_auto_declare_symbols`）。
    #   需求来源：**没有 UI 供用户显式声明符号**，故系统须按书写自动声明；
    #   而「先判变量就会把函数抢走」（用户原话）正是顺序敏感的根因。
    # --- 轮次 T：❶ 前提函数登记 → ❷ R8 检查 → ❸ 自动声明 ---
    # 实现见 `_prepare_declarations`（三处共享，避免逻辑分叉后漏改一处）；
    # 顺序不可更换的理由亦在该函数的 docstring 中。
    ctx, _decl_err = _prepare_declarations(ctx, args.get("expr"))
    if _decl_err is not None:
        return _decl_err

    try:
        current = _sympify_relation(
            args.get("expr"), ctx["locals"], ctx.get("funcParams")
        )
    except Exception as e:  # noqa: BLE001
        return {"legit": "illegal", "code": "unparsable", "detail": str(e)}

    # 偏微分等式有独立语义：无函数体时是约束声明，有函数体时
    # 必须验证残差恒为 0，不能落入通用方程的“存在特定取值即成立”通道。
    _partial_res = _judge_partial_equation(
        current, ctx, bool(args.get("_partialNotation"))
    )
    if _partial_res is not None:
        return _partial_res

    # 显式可求值导数（如 d/dx(x²)=2x）必须先求导再比较，不能落入
    # “给 x 建立新定义”的通用方程通道。
    try:
        _has_explicit_derivative = bool(
            current.has(sp.Derivative) and not current.atoms(_AppliedUndef)
        )
    except Exception:  # noqa: BLE001
        _has_explicit_derivative = False
    if _has_explicit_derivative and getattr(current, "is_Relational", False):
        _evaluated, _changed = _eval_calculus(current)
        if _changed:
            try:
                _residual = sp.simplify(_evaluated.lhs - _evaluated.rhs)
                if _residual == 0:
                    return {
                        "legit": "legit",
                        "code": "explicit_derivative_identity",
                        "detail": "求导后两侧恒等",
                    }
                _vars = sorted(_residual.free_symbols, key=lambda s: s.name)
                _solutions = sp.solve(sp.Eq(_residual, 0), _vars, dict=True) if _vars else []
                if _solutions:
                    return {
                        "legit": "legit",
                        "code": "explicit_derivative_solvable",
                        "detail": "求导后等式仅在特定取值下成立，非恒等式",
                    }
                return {
                    "legit": "illegal",
                    "code": "explicit_derivative_mismatch",
                    "detail": "求导后两侧不相等",
                }
            except Exception:  # noqa: BLE001
                pass

    # --- 轮次 X6 新增：**积分定义式通道**（用户裁定 Q1/Q2）---
    #
    # ## 为什么必须**最先**拦截（实测 A3 / B2 的误判点）
    #   前提含「符号 = 积分」定义时，既有链路一律当**普通方程**处理，
    #   导致两类确定性误判（探针 scripts/vintegral.py 实测）：
    #     **A3**（定积分）：前提 `W=∫_0^H ...dh`，提交错值 `W=m*g0*R*H/R`
    #       → 走五类规则第 3 条，残差含**未求值 Integral** →
    #         `_domain_identity_holds` 的 `sp.N` 必失败 → 采不到样本 →
    #         **误判「恒等」而放行**（`relation_ok`，实测 legit ❌）
    #     **B2**（不定积分）：前提 `A=∫2x dx`，提交 `A=x**2+5`（差常数，合法）
    #       → `_check_premise_conflict` 不认识「+C 任意性」→
    #         **误判「前提互相矛盾」**（`constraint_conflict`，实测 illegal ❌）
    #   本通道在二者之前给出正确结论（判据见 `_judge_integral_definition`）。
    #
    # ## 返回 None 时完全不影响既有流程
    #   仅当「本步一侧是裸符号」**且**「该符号在前提里有积分定义」才介入；
    #   其余一律交既有链路（含 `∫2x dx = x²` 这类**提交侧**含积分的式子）。
    _intdef_res = _judge_integral_definition(args.get("expr"), ctx)
    if _intdef_res is not None:
        return _intdef_res

    # --- 轮次 W 新增（块2）：积分等式通道（用户口径「左侧积分要带 C」）---
    #
    # ## 用户口径（原话）
    #   「系统对于左侧积分变换没有把 C 加进去」
    #
    # ## 数学判据（一条覆盖全部 5 个用例）
    #   `∫f dv = g` 成立 ⟺ `g - F` 对积分变量 v 是**常数**
    #   （F 为 f 的任一原函数；等价于两边对 v 求导相等）
    #
    #   **不能**要求 `g == F`（那会漏掉 +C 的任意性）；
    #   也**不能**只要求「可满足」（那会放过 #20 的反例）。
    #
    # ## 实测对照（vcalc2 #18/#19/#20/#22/#C2）
    #   `∫2x dx = x²`      → 差 0   → 导数 0 → pass
    #   `∫2x dx = x²+1`    → 差 1   → 导数 0 → pass（C=1）
    #   `∫2x dx = x²+5`    → 差 5   → 导数 0 → pass（C=5）
    #   `∫2x dx = x²+x`    → 差 x   → 导数 1 ≠ 0 → **fail**（用户明确期望 fail）
    #   `∫2x dx = x²+C`（前提 C=5）→ 差 -C → 代入 5 → -5 → pass
    #   `F(x)=x²+1` ⇒ `∫F'(x)dx = F(x)` → 代入后差 1 → pass
    #
    # ## 为什么必须单独成通道
    #   既有链路只把 Integral 求值成原函数（`_eval_calculus`），
    #   **丢失了「+C 的任意性」语义** → 差为非零常数时一律判
    #   `not_derivable` 或 `constraint_conflict`（实测确认）。
    #
    # ## 位置要求：**必须在轮次 R（函数体代入）之前**
    #   轮次 R 对 #C2 会把体代入后算出差 `-1`（非零常数）→ 直接判 illegal，
    #   拦截掉本通道，故必须前置。
    try:
        _is_int_eq = bool(
            getattr(current, "is_Relational", False)
            and (current.lhs.has(sp.Integral) or current.rhs.has(sp.Integral))
        )
    except Exception:  # noqa: BLE001
        _is_int_eq = False
    if _is_int_eq:
        try:
            # ① 积分变量（取第一个 Integral 的变量）
            _iv = None
            for _nd in sp.preorder_traversal(current):
                if isinstance(_nd, sp.Integral) and _nd.limits:
                    _iv = _nd.limits[0][0]
                    break
            if _iv is not None:
                # ② 前提的函数体先代入（#C2 的 `F(x)` → `x²+1`）
                #    这样 `∫F'(x)dx` 才能求值成具体原函数。
                _bdefs = _func_body_defs_from_relations(
                    ctx["relations"], ctx["funcNames"]
                )
                _lhs2, _rhs2 = current.lhs, current.rhs
                if _bdefs:
                    _lhs2, _ = _apply_func_body_defs(_lhs2, _bdefs)
                    _rhs2, _ = _apply_func_body_defs(_rhs2, _bdefs)
                # --- 守卫（vcalc2 #30/#31/#32 回归修复，**主判据**）---
                #
                # ## 为什么必须加（本通道引入的回归）
                #   `∫f(t)dt = F(t)` 里 f 是**未赋值函数** —— 被积函数没有
                #   具体表达式，积分**求不出原函数**，因此「两边之差是否为
                #   常数」这个判据在这里**根本不成立**（差必然含 `Integral`）。
                #   实测：#30/#31/#32 三例被本通道误判为 `integral_not_derivable`。
                #
                #   这类式子的语义是「**建立 f 与 F 之间的函数关系**」，
                #   属**轮次 U（函数关系声明）**的职责 —— 故此处必须放手。
                #
                # ## 判据为何用「含未赋值函数」而非「残留 Integral」
                #   两种写法等价，但前者更**本质**：
                #     有未赋值函数 → 积分不可求 → 判据不适用（#30/#31/#32）
                #     无未赋值函数 → 积分必可求 → 走本通道（#18/#19/#20/#22/#C2）
                #   实测对照：
                #     `∫2x dx = x²+C`          → 无未赋值函数 → 走通道 ✅
                #     `∫F'(x)dx = F(x)`
                #       （前提 `F(x)=x²+1`，F **已赋值**）→ 走通道 ✅
                #     `∫f(t)dt = F(t)`（f 无 body）→ 跳过 → 交轮次 U ✅
                if _unassigned_funcs(current, _bdefs):
                    raise ValueError("integral_with_unassigned_func")
                # ③ 求值（Integral → 原函数；Derivative → 具体式）
                _lhs2 = _eval_derivatives(_eval_calculus(_lhs2)[0])
                _rhs2 = _eval_derivatives(_eval_calculus(_rhs2)[0])
                _idif = sp.simplify(_lhs2 - _rhs2)
                # ④ 前提常量代入（#22 的 `C=5`）：只代「单符号 = 纯值」的前提，
                #    避免把 `F(t)=t²` 这类函数定义误代入。
                for _r in (ctx["relations"] or []):
                    if not isinstance(_r, sp.Eq):
                        continue
                    for _a, _b in ((_r.lhs, _r.rhs), (_r.rhs, _r.lhs)):
                        if isinstance(_a, sp.Symbol) and not _b.free_symbols:
                            try:
                                _idif = _idif.subs(_a, _b)
                            except Exception:  # noqa: BLE001
                                pass
                _idif = sp.simplify(_idif)
                # ⑤ 判据：差为常数（无自由符号，或对积分变量导数为 0）
                # --- 轮次 X6 回滚说明（**重要**）---
                # 本轮曾把定积分改为「严格相等」，但实测**引入回归**：
                #   定义式 `W = ∫(0→H) ... dh`（given 标准写法）走本通道时
                #   `_idif = W - 原函数`，W 是**待定义符号** → 严格相等必失败。
                #   实测：vint A2/D3/D4/D5 由 legit 变 illegal。
                # 故**维持原判据**；「错误答案被放过」是独立缺陷，另行处理。
                # --- 原分流实现（已回滚，保留备查）---
                # 原判据的假阳性（用户裁定「一并修」）
                #
                # ## 原判据的假阳性（用户裁定「一并修」）
                #   原判据统一用「差式对积分变量求导 == 0」判「差为常数」。
                #   它对本轮用户场景里的**定积分**失效 ——
                #     定积分代入上下限后**积分变量消失**（如
                #     `∫_0^H m*g0*R²/(R+h)² dh` 求值后只含 m/g0/R/H，无 h），
                #     于是 `diff(差式, h)` **恒为 0** → 判据恒真
                #     → **错误答案也会被判 pass**。实测（探针 scripts/vintegral.py
                #       A3/A4）：`W=mg0RH/R`（分母漏 +H）被判 legit。
                #
                # ## 修正后的分流（数学依据）
                #   **定积分**：结果**唯一**，不给任何「差常数」宽容
                #     → 差式必须**严格等于 0**
                #   **不定积分**：代表**原函数集合**（可差任意常数 C）
                #     → 维持原判据（差为常数 ⟺ 对积分变量导数为 0）
                #   实测对照（vcalc2 回归守护）：
                #     `∫2x dx = x²+x`（差 x 含积分变量）→ 仍判 **fail** ✅
                #     `∫2x dx = x²+5`（差 5，纯常数）  → 仍判 **pass** ✅
                # ============ 轮次 X6：**定/不定积分 + 定义式/验证式 双分流** ============
                #
                # ## 为什么必须分流（A4 实测：错答案被判 legit）
                #   原判据统一用「差式对积分变量求导 == 0」判「差为常数」。
                #   对**定积分验证式** `∫_0^H f dh = 候选值`：
                #     定积分求值后上下限代入、**积分变量消失** →
                #     `diff(正确值 - 错值, h) ≡ 0`（两者都不含 h）→ 判据**恒真**
                #     → **错误答案被放行**（实测 A4：`∫...=m*g0*R*H/R` 判 legit ❌）。
                #
                # ## 分流口径（数学依据，两条正交）
                #   ① **定积分**（结果唯一）vs **不定积分**（可差任意 C）
                #   ② **验证式**（无裸符号侧，如 `∫...=候选值`）
                #      vs **定义式**（有裸符号侧，如 `W=∫...`）
                #
                #   |  情形               |  判据                        |  依据
                #   |---------------------|------------------------------|------------------
                #   | 定积分 + 验证式      | `_idif == 0`（**严格相等**）  | 结果唯一
                #   | 其余（含定义式/不定） | 差为常数（原判据）            | `W=∫...` 中 W
                #   |                     |                              | 是**待定义**符号，
                #   |                     |                              | 差必然含 W
                #
                # ## 实测对照（本轮 A2/A4/D3/D4/D5 与 vcalc2 回归）
                #   `W=∫...={正确式}` 第1对 `W=∫...` → 有裸符号侧 → 定义式 → pass ✅
                #   `W=∫...={正确式}` 第2对 `∫...=正确式` → 定积分+验证式 → 差 0 → pass ✅
                #   `∫...=错式`（A4）  → 定积分+验证式 → 差 ≠ 0 → **fail** ✅
                #   `W=∫...`（D5 单式）→ 有裸符号侧 → 定义式 → pass ✅
                #   `∫2x dx = x²`（#18）→ **不定**积分 → 原判据 → pass ✅
                #   `∫2x dx = x²+x`    → 不定积分，差 x 含积分变量 → fail ✅
                _has_sym_side = any(
                    isinstance(_x, sp.Symbol) for _x in (current.lhs, current.rhs)
                )
                _orig_definite = False
                try:
                    for _nd in sp.preorder_traversal(current):
                        if isinstance(_nd, sp.Integral) and _nd.limits \
                                and all(len(_t) == 3 for _t in _nd.limits):
                            _orig_definite = True
                            break
                except Exception:  # noqa: BLE001
                    _orig_definite = False
                # --- 轮次 X6 回归修复：**必须要求「有前提」**（vcalc2 #25 实测）---
                #
                # ## 为什么必须加 `_has_premise_int`（回归根因）
                #   本严格化只应对「**引用前提的验证步骤**」生效 ——
                #   即「由前提定义的积分 + 用户提交的候选值」这一场景。
                #   而**无前提**的单段提交（如 vcalc2 #25：`∫_0^1 2x dx = C + 1`）
                #   里 `C` 是用户书写的**任意积分常数** —— 属「新声明」语义
                #   （与 `_judge_atomic` 的「无入线 → 视为新声明 → pass」同口径），
                #   严格化后差 `-C ≠ 0` 会把它**误判 fail**（实测回归）。
                #
                # ## 实测对照（修复后）
                #   有前提（vint A4：facts 含 `W=∫_0^H...`）→ 严格相等 → 错值 **fail** ✅
                #   有前提（vint D1/D2：facts 含 `∫F(h)` + `F(h)=..`）→ 正解 **pass** ✅
                #   无前提（vcalc2 #25）→ 回原判据（差为常数）→ **pass** ✅
                # --- 轮次 X7 修正：判据由「有前提」改为「**右侧未引入新符号**」---
                #
                # ## 为什么必须改（`scripts/vintegral.py` #A4 复验 FAIL）
                #   原判据 `_has_premise_int`（有前提才严格）**过宽** ——
                #   它把「**无前提的链式验证式**」也放进了宽松分支：
                #     #A4：`W=∫_0^H...dh=m*g0*R*H/R`（分母漏 +H 的**错值**）
                #       链式第 2 对 `∫...=m*g0*R*H/R` 无 facts →
                #       `_has_premise_int=False` → 走「差为常数」→
                #       差恰为**非零常数** → 判 pass（应判 fail）❌
                #   #A2 同形态但右侧是**正确式**，恰好也 pass
                #   —— 即该判据对 A2/A4 **不可区分**，是真正的原因。
                #
                # ## 正确的判据（两条用例的**本质差异**）
                #   vcalc2 #25（`∫_0^1 2x dx = C + 1`，应 pass）：
                #     右侧的 `C` 是用户**新引入**的积分常数 ——
                #     属「新声明」语义（与「无入线 → 视为新声明」同口径）。
                #   #A4（`∫_0^H...dh = m*g0*R*H/R`，应 fail）：
                #     右侧 `m/g0/R/H` **全部已在左侧出现** ——
                #     它不是新声明，而是对**同一个量**的候选值断言 → 须严格判。
                #
                #   故判据取「**右侧自由符号集 - 左侧自由符号集 是否为空**」：
                #     为空   → 未引入新符号 → **严格相等**（#A2 ✅ / #A4 ❌ +）
                #     非空   → 引入新符号   → 原判据（差为常数）（#25 ✅）
                #
                # ## 为什么 `_has_premise_int` 必须**去掉**（不可与之并列）
                #   #A2 的 facts 为空（`_has_premise_int=False`）而右侧无新符号
                #   —— 若保留 `and _has_premise_int`，A2 会落回宽松分支；
                #   实测该分支下 A2 也 pass（差为 W 相关项时导数为 0），
                #   但那是**巧合**，判据本身并未成立。去掉后判据自洽。
                try:
                    _no_new_sym = not (
                        set(getattr(_rhs2, "free_symbols", set()))
                        - set(getattr(_lhs2, "free_symbols", set()))
                    )
                except Exception:  # noqa: BLE001
                    _no_new_sym = False     # 取不到符号信息 → 保守走原判据
                if _orig_definite and not _has_sym_side and _no_new_sym:
                    # 定积分验证式 + **右侧未引入新符号** → 结果唯一 → **严格相等**
                    _is_const = (_idif == 0)
                else:
                    _is_const = False
                    if not _idif.free_symbols:
                        _is_const = True
                    else:
                        try:
                            if sp.simplify(sp.diff(_idif, _iv)) == 0:
                                _is_const = True
                        except Exception:  # noqa: BLE001
                            pass
                if _is_const:
                    return {
                        "legit": "legit",
                        "code": "integral_constant_ok",
                        "detail": (
                            "左侧积分与右侧相差积分常数 C，本步成立"
                        ),
                    }
                return {
                    "legit": "illegal",
                    "code": "integral_not_derivable",
                    "detail": (
                        "左侧积分与右侧不是同一个原函数：两者之差 "
                        + sp.sstr(_idif) + " 不是常数"
                    ),
                }
        except Exception:  # noqa: BLE001
            pass

    # --- 除零安全：**必须早于**五类规则 ---
    #
    # 为什么顺序不能颠倒（探针用例 9 实测缺陷）：
    #   `y=a/x` 在五类规则里会先被判为「解出 a = x*y」→ a 未在前提出现
    #   → 命中规则 1「新变量定义」→ pass，**绕过了分母检查**。
    #   而用户口径明确要求「`y=a/x` 在前提 x=0 时判错」——
    #   该式含分母 x，前提又允许 x=0，属确定的非法写法。
    #   故除零检查前置：它拦的是「式子本身在此前提下无定义」，
    #   与「是新变量定义还是值指派」无关，先做不会误伤。
    dz0 = _check_division_safety(current, ctx["relations"])
    # --- 轮次 U 配套（D1，用户口径）：分母含**未赋值函数**时延后判定 ---
    #
    # 为什么必须延后（实测确认）：
    #   `f(x)/g(x)=x` + 前提 `f(x)=x^2` 时，此刻 `g` 还是**未赋值函数**
    #   —— 它的 body 即将由本步「解出」，所以「`g(x)` 可能为 0」现在
    #   根本无从判定（任何未赋值函数都「可能」取 0）。
    #   若在此直接报 illegal，就**轮不到**轮次 U 解出 `g=x` 后再把 body
    #   代进分母、检查「x 是否可能为 0」——而那才是用户口径 D1 要的判据：
    #   「如果出现 `f(x)/g(x)=x`，其中 `f(x)=x^2`，这时候使用 solve
    #     是否能限制 `g(x)=0` 的特殊情况」→ 解出后再查，风险明确则 warn。
    #
    # 限定条件（**只延后这一类**，避免放宽既有除零语义）：
    #   恰好 1 个未赋值函数（轮次 U 能解出它）**且**至少一个分母引用了它。
    if dz0:
        try:
            _early_defs = _func_body_defs_from_relations(ctx["relations"], ctx["funcNames"])
            _early_un = _unassigned_funcs(current, _early_defs)
            if len(_early_un) == 1 and any(
                _unassigned_funcs(_d, _early_defs)
                for _d in _collect_denominators(current)
            ):
                dz0 = None          # 延后到轮次 U（解出 body 后再判分母）
        except Exception:  # noqa: BLE001
            pass
    if dz0:
        # --- 例外：可去奇点（轮次 M，第 18 / 19 例）---
        # 为什么必须例外：`(x^2-1)/(x-1)=x+1` 的分母在 x=1 为 0，但那是
        # **可去奇点**（该点极限存在，约分隐含 x≠1）——
        # 用户明确判定：无前提时 **warn**；前提已声明 x≠1 时 **pass**。
        # 而除零检查只会一律报 illegal，会盖掉这个正确结论。
        # 只在**除零风险已触发**时才咨询结构分析，影响面最小；
        # 结构分析判不出（如 `y=a/x` 在 x 无约束时）则维持原有 illegal。
        try:
            _st = premise_structure.analyze_structure(ctx["relations"], current)
            if _st.get("verdict") == "legit" and _st.get("code") == "ok":
                return {"legit": "legit", "code": _st["code"], "detail": _st["detail"]}
            if _st.get("verdict") == "warn":
                return {"legit": "warn", "code": _st["code"], "detail": _st["detail"]}
        except Exception:  # noqa: BLE001
            pass
        return {"legit": "illegal", "code": dz0, "detail": "分母可能为 0，请先声明该量的定义域"}

    # --- 轮次 R：函数体代入（用户口径）---
    #
    # 用户口径（原话）：「已有前提 F(h)=h**2 声明了函数定义，当用户提交
    # F(2)=4 要处理 F(2) 隐藏的前提 h=2，然后替换 F(h)，为 h**2=4」。
    #
    # 为什么必须补（实测确认的能力缺口）：
    #   轮次 Q 已修好**解析层**（`F(h)` 不再被插成 `F*(h)`），但**判定层**
    #   仍缺「函数体代入」—— 前提里的 `F(h)=h**2` 是一份**对任意 h 成立**的
    #   函数定义，而 `check_derivable_ex` 只做「等式成比例 / 差值化简」，
    #   不会把 `F(2)` 展开成 `2**2`。
    #   实测证据：`_apply_function_bodies(F(2)-4, {F: h**2}) == 0`（机制有效），
    #   但 `check_derivable_ex([Eq(F(h),h**2)], Eq(F(2),4))` 判 illegal；
    #   归因：`_apply_function_bodies` 只在 `_to_diff` 的**输入解析阶段**生效，
    #   **前提比对阶段**没有它。
    #
    # 位置：放在**除零检查之后**，以保持既有除零语义不变 ——
    #   例如 `F(h)/G(h)=h/2` 在 `F(h)=h**2、G(h)=2h` 下，除零检查仍会
    #   基于原式（分母含 `G(h)`）报 `division_by_zero`，与本轮之前一致。
    #
    # 守卫：代入结果若含**未声明符号**，则不据此定论、也不改写 `current`，
    #   让后续既有的「未声明符号」规则照常报错（避免把该规则绕过去）。
    try:
        _fdefs = _func_body_defs_from_relations(ctx["relations"], ctx["funcNames"])
        if _fdefs:
            _subbed, _sub_n = _apply_func_body_defs(current, _fdefs)
            if _sub_n:
                # 求导求值：`F'(h)` 代入函数体后应化成 `2*h` 这类具体式，
                # 否则 `Eq(Derivative(h**2, h), 2*h)` 因结构不同不会自动判等。
                if getattr(_subbed, "is_Relational", False):
                    try:
                        _subbed = sp.Eq(
                            _eval_derivatives(_subbed.lhs),
                            _eval_derivatives(_subbed.rhs),
                        )
                    except Exception:  # noqa: BLE001
                        pass
                if _check_undeclared(_subbed, ctx["declared"], ctx["funcNames"]) is None:
                    _fb_verdict = None
                    if _subbed is sp.S.true:
                        _fb_verdict = "legit"
                    elif _subbed is sp.S.false:
                        _fb_verdict = "illegal"
                    elif getattr(_subbed, "is_Relational", False):
                        try:
                            _fb_diff = sp.simplify(_subbed.lhs - _subbed.rhs)
                        except Exception:  # noqa: BLE001
                            _fb_diff = None
                        if _fb_diff is not None:
                            if _fb_diff == 0:
                                _fb_verdict = "legit"
                            elif not _fb_diff.free_symbols:
                                _fb_verdict = "illegal"
                            else:
                                # --- 轮次 S：含自由符号 → 判「**解集 ∩ 前提域**」是否非空 ---
                                #
                                # ## 判据（用户口径）
                                #   「判定条件是该等式在前提条件下**存在解**」
                                #     `F'(h)=3h` → 代入得 `2h=3h` → 解 h=0（前提允许）→ pass
                                #     `F(h)=h³`  → 代入得 `h²=h³` → 解 h=0,1（前提允许）→ pass
                                #   即：只要**存在**满足全部前提的取值使本步成立，就 pass；
                                #   解集与前提域**无交集**才判否。
                                #
                                # ## 为什么不用「域上恒等检验」（轮次 R 的旧口径，已废弃）
                                #   旧口径要求残差**处处为零**，会把「求解」误判为错：
                                #     `F'(h)=3h` 是用户**在解方程**（求 2h=3h 的根），
                                #     恒等检验见 `-h` 不恒为零 → 判 illegal（实测）——
                                #     而系统**无法也不应**区分「求解」与「声称恒等」两种意图
                                #     （同样的字符串，两种意图，数学上不可区分）。
                                #   用户明确采纳「有解即 pass + 提示非恒等」的口径。
                                #
                                # ## 为什么复用 `_check_premise_conflict`
                                #   `check_premise_conflict` 判的是「前提集是否**自相矛盾**」，
                                #   而「前提 + 本步」矛盾 ⟺ 不存在同时满足两者的取值
                                #   ⟺ **解集 ∩ 前提域 = ∅**。正好是所需判据，无需另写。
                                #
                                #   实测有效性依赖「S1 修复」（同批改动）：旧 `holds()`
                                #   把残差 `Expr(0)` 当 False，会使含等式的前提集误报矛盾
                                #   （`h=0` 在前提 `h²=h³` 下被判 conflict），
                                #   修复后 `is_satisfiable` 才能正确判定「交集是否非空」。
                                _fb_conflict, _ = _check_premise_conflict(
                                    list(ctx["relations"]) + [_subbed]
                                )
                                _fb_verdict = "illegal" if _fb_conflict else "solvable"
                    # --- 轮次 U 插入点守卫（实测确认，探针 #6b）---
                    # 体代入后**仍含未赋值函数**时，本步语义是「声明函数 / 建立
                    # 函数关系」而非「纯等式求解」：
                    #   前提 `f(x)=x+1`，提交 `f(x)+g(x)=x^2+2x`
                    #   → 代入得 `x+1+g(x)=x^2+2x`，残差含 x（非恒等）
                    #   → 旧路径在此判 `func_body_solvable` 就返回，
                    #     **轮次 U 永远轮不到**，用户期望的
                    #     「解出 g(x)=x^2+x-1 并补 body」丢失。
                    # 故此处放弃判定，交轮次 U 按「1 个未赋值函数 → solve 补 body」处置。
                    if getattr(_subbed, "is_Relational", False) \
                            and _unassigned_funcs(_subbed, _fdefs):
                        _fb_verdict = None
                    if _fb_verdict == "legit":
                        return {
                            "legit": "legit",
                            "code": "func_body_ok",
                            # 文案（用户口径）：只讲「恒成立」，**不写具体值**
                            "detail": "满足前提条件，等式恒成立",
                        }
                    if _fb_verdict == "solvable":
                        # 仅特定取值成立（用户口径）：说明「非恒等式」，**不写具体解**
                        #
                        # 为什么点明「非恒等」：同一串 `F'(h)=3h` 既可读作
                        # 「求解」（求 2h=3h 的根）也可读作「声称恒等」——
                        # 系统无法区分意图，但**必须让用户知道**他写下的不是恒等式，
                        # 否则会误以为系统背书了「2h 与 3h 恒等」。
                        # 此处只给变量名、不给具体解（用户明确要求）。
                        _fb_syms = "、".join(
                            sorted(str(_s) for _s in _fb_diff.free_symbols)
                        )
                        return {
                            "legit": "legit",
                            "code": "func_body_solvable",
                            "detail": (
                                "满足前提条件，在 " + _fb_syms + " 的特定取值下等式成立，"
                                "非恒等式"
                            ),
                        }
                    if _fb_verdict == "illegal":
                        return {
                            "legit": "illegal",
                            "code": "constraint_conflict",
                            "detail": "不满足前提条件：本步与已有前提无法同时成立",
                        }
                    # 未能一锤定音 → 以代入后的式子继续走原有阶梯。
                    current = _subbed
    except Exception:  # noqa: BLE001
        pass

    # --- 轮次 U：函数关系 / 未赋值函数（用户三张表方案）---
    #
    # ## 为什么放在这里（必须紧跟轮次 R 之后）
    #   用户口径的四步「**替换 → 声明 → 解出 → 补 body**」，本处正好是后两步：
    #     ① 替换：上面轮次 R 已把**已赋值函数**展开（前提 `f(x)=x+1` →
    #        `f(x)+g(x)=x^2+2x` 被替换成 `x+1+g(x)=x^2+2x`）
    #     ② 声明：`_auto_declare_symbols`（B 处已放宽为「出现即算」）把
    #        `g(x)` 登记为**无 body 函数** → 解析得 AppliedUndef（不是 `g*x`）
    #     ③ 解出：只剩 1 个未赋值函数时用 `sp.solve` 解出它的 body
    #     ④ 补 body：三层验证（relations / facts / 除零）通过才 pass
    #
    # ## 三张表都**重新提取**（用户口径「不写回会话缓存」）
    #   `function_bodies`（已有机制）/ `function_relations`（本轮新增）
    #   / `function_facts`（本轮新增）—— 全部从 `ctx["relations"]` 现算，
    #   故本步通过后无需持久化，下游节点重新提取即可（决策 5 甲）。
    #
    # ## 分流（按未赋值函数的**个数**）
    #   0 个 → 不进入本块（交既有五类规则 / 可推导性）
    #   1 个 → 解出 body（`func_body_declared` / 冲突 fail / 除零风险 warn）
    #  ≥2 个 → 无法解出单个 body → 与已有 relation **消元**成纯变量等式，
    #          再走「有解即 pass」的既有判据（Q3 甲，用户口径）：
    #          「用户再提交 f(x)+g(x)=x²+3x，相当于替换为 x²+2x=x²+3x，
    #            采用等式判定原则，判满足前提条件下 x 限定取值，x=0」
    try:
        _ub_defs = _func_body_defs_from_relations(ctx["relations"], ctx["funcNames"])
        _u_facts = _func_facts_from_facts(ctx["relations"])
        _un = _unassigned_funcs(current, _ub_defs)

        if len(_un) == 1:
            _one = next(iter(_un))
            _one_args = list(_one.args)
            # ① **点值事实**（实参全为常数）→ 登记事实，直接 pass（探针 #2）。
            #    用户口径：「相当于建立函数 f 在 1 处值为 4 这样一个前提」——
            #    `f(1)=4` 是**单点实例**（形参非裸符号），不能走 solve；
            #    但它也无需被推导，登记即为合法。
            #    安全边界：**未声明**函数的同类写法已被 ❷R8 拦下
            #    （无前提 `f(2)=4` → fail），故此处只可能是「已声明函数」。
            if _one_args and all(getattr(a, "is_number", False) for a in _one_args):
                _v_side = current.rhs if current.lhs == _one else current.lhs
                return {
                    "legit": "legit",
                    "code": "func_fact_declared",
                    "detail": (
                        "已登记点值前提 "
                        + getattr(_one.func, "__name__", "") + "("
                        + ", ".join(sp.sstr(a) for a in _one_args) + ") = "
                        + sp.sstr(_v_side)
                    ),
                }
            _u_res = _solve_single_unassigned_func(
                current, _ub_defs, ctx["relations"], _u_facts
            )
            if _u_res is not None:
                if not _u_res.get("ok"):
                    return {
                        "legit": "illegal",
                        "code": _u_res.get("code") or "func_body_conflict",
                        "detail": _u_res.get("detail") or "新声明的函数与已有前提冲突",
                    }
                if _u_res.get("divRisk"):
                    # D1 除零（用户口径）：解出的 body 使原式**分母**可能为 0
                    # → 不能直接放行，降级 warn 提示补定义域。
                    return {
                        "legit": "warn",
                        "code": "division_by_zero",
                        "detail": (
                            _u_res["detail"] + "；但分母 "
                            + str(_u_res["divRisk"]) + " 可能为 0，请先声明其定义域"
                        ),
                    }
                return {
                    "legit": "legit",
                    "code": "func_body_declared",
                    "detail": _u_res["detail"],
                }
            else:
                # --- 轮次 W 新增（块3 / 块5）：解不出 body → 视为「函数关系声明」---
                #
                # ## 为什么需要（vcalc2 探针 #27 / #32 实测确认的同类不同判）
                #   `F'(x)=2x`（一阶导）能通过，但 `F''(x)=2`（二阶导）报
                #   `unknown/no_premise` —— 两者语义完全同类，却得到相反结论。
                #
                #   根因：`_solve_unique_var` 对一阶导**巧合**能解出
                #   `x = Derivative(F(x),x)/2`（唯一符号解）→ 误打误撞走了
                #   「新变量定义」通道；而二阶导 `solve(Derivative(F(x),(x,2))-2, x)`
                #   无解 → `_solve_unique_var` 返回 None → 落到孤立节点分支。
                #   `analyze_structure` 不认识「对未赋值函数的导数 / 积分下定义」
                #   这种语义 → 返回 `unknown`（实测 #27 / #32）。
                #
                # ## 判据（用户口径）
                #   含**未赋值函数**的关系式（本分支的前提），当 `sp.solve`
                #   **解不出该函数的 body** 时（说明它不是「函数定义」而是
                #   「函数之间的关系声明」）→ **先查与前提是否冲突**，
                #   不冲突即为合法声明。
                #
                # ## 为什么「查冲突」就够（不必走可推导性判定）
                #   这类式子的语义是「**建立函数之间的关系**」，而非「由前提
                #   推出某个结论」—— 前提链的可推导性判定对它必然返回
                #   `not_applicable`（含未赋值函数，无从做等式/微积分比对，实测 #32）。
                #   故只需确认它与前提**相容**即可放行，与「函数定义无需被推导」
                #   是同一口径。
                #
                # ## 块5：原有实现限定 `not ctx["relations"]`（仅无前提时兜底）
                #   导致 `∫f(t)dt = F(t)` + 前提 `F(t)=t²` 落到 not_applicable（#32）。
                #   改为「一律先查冲突」后，有前提时同样能放行；
                #   而**矛盾的式子仍会被拦下**（不放宽既有约束）。
                try:
                    _d_conflict, _ = _check_premise_conflict(
                        list(ctx["relations"]) + [current]
                    )
                except Exception:  # noqa: BLE001
                    _d_conflict = True      # 判不了 → 保守不放行
                if not _d_conflict:
                    return {
                        "legit": "legit",
                        "code": "func_relation_declared",
                        "detail": (
                            "已登记函数关系 " + sp.sstr(current.lhs)
                            + " = " + sp.sstr(current.rhs)
                        ),
                    }

        elif len(_un) >= 2:
            _u_rels = _func_relations_from_facts(ctx["relations"], _ub_defs)
            for _pr in _u_rels:
                try:
                    # 前提 relation 与本次提交**相减** → 消去未赋值函数
                    _res = sp.simplify(
                        (_pr.lhs - _pr.rhs) - (current.lhs - current.rhs)
                    )
                except Exception:  # noqa: BLE001
                    continue
                if _res.atoms(_AppliedUndef):
                    continue          # 未完全消元 → 本判据不适用
                if _res == 0:
                    # 与已有 relation 完全一致 → 恒成立
                    return {
                        "legit": "legit",
                        "code": "func_relation_ok",
                        "detail": "本步与已有函数关系一致",
                    }
                if not _res.free_symbols:
                    # 消元后为**非零常数** → 确定矛盾
                    return {
                        "legit": "illegal",
                        "code": "func_relation_conflict",
                        "detail": "本步与已有函数关系冲突，无法同时成立",
                    }
                # 纯变量等式 → 判「解集 ∩ 前提域」是否非空（与轮次 S 同口径）
                _u_cf, _ = _check_premise_conflict(
                    list(ctx["relations"]) + [sp.Eq(_res, 0)]
                )
                if not _u_cf:
                    return {
                        "legit": "legit",
                        "code": "func_relation_solvable",
                        "detail": "在前提条件下存在取值使本步成立，非恒等式",
                    }
            if not _u_rels:
                # 无「函数关系」前提可比对 → 本次提交**就是**在建立这条关系（探针 #1）。
                # 用户口径（原话）：「在没有前提下 `f(x)+g(x)=x^2+2x` 提交意思是
                #   x 任意取值都满足该等式」—— 即无前提时为**函数关系声明**，
                # 语法成立即为合法（与「函数定义无需被推导」同口径）。
                # 不兜底则落到孤立节点判定 → unknown/no_premise。
                return {
                    "legit": "legit",
                    "code": "func_relation_declared",
                    "detail": (
                        "已登记函数关系 " + sp.sstr(current.lhs)
                        + " = " + sp.sstr(current.rhs)
                    ),
                }
    except Exception:  # noqa: BLE001
        pass

    # --- 五类规则：定值 / 定关系式通道（轮次 I 终版，用户口径）---
    #
    # 必须**早于** `_check_undeclared`：`A=x*y` 里 A 尚未声明，走那里必然
    # 报「未定义的符号：A」而判 illegal —— 而这恰是用户要求放行的情形。
    #
    # 用户口径（原话）：
    #   「有没有前提能够反对这个等式的成立，例如有个前提是 y>0，
    #     就是反对 `40=y+99` 的成立，就判错」
    #   「等式没声明定义域，就表明他潜在认定该关系在负无穷到正无穷都成立」
    #
    # 因此三类分别处置：
    #   规则 1（新变量定义）  解出的变量前提里没出现过 → 直接 pass
    #   规则 2（值指派）      解出已有变量为**不含其他变量的值** → 查冲突
    #   规则 3（函数关系）    解出已有变量为**含其他变量的式子** → 查域上恒等
    #
    # 为什么规则 3 必须查「域上恒等」而不是「可满足」（实测反例）：
    #   `y=40+2x` 与前提 `2x+y=40` 代入得 `4x=0`，**可满足**（x=0,y=40），
    #   但学生没声明定义域即等于主张「对任意 x 都成立」，而只对 x=0 成立
    #   → 与前提冲突 → 判错。这正是「抄错符号」被抓住的机制。
    _sol = _solve_unique_var(current)
    if _sol:
        _vname, _vexpr = _sol
        _appeared = _appeared_symbols(ctx["relations"])
        # 规则 1：全新变量 → 登记为定义，不做对错比对
        if _vname not in _appeared:
            return {
                "legit": "legit",
                "code": "new_definition",
                "detail": "已登记变量 " + _vname + " 的定义",
            }
        # 规则 2/3：已有变量 → 先查冲突（值指派场景在此定论）
        _merged = list(ctx["relations"]) + [current]
        _conflict, _msg = _check_premise_conflict(_merged)
        if _conflict:
            return {
                "legit": "illegal",
                "code": "constraint_conflict",
                "detail": "本步与已有前提冲突，无法同时成立：" + str(_msg or ""),
            }
        # 取**前提中的真实符号对象**，而非按名字新建（探针用例 5 实测缺陷）：
        # `sp.Symbol(name)` 与 `Symbol(name, real=True)`（_compile_symbols
        # 产出）**不是同一个对象**，`subs` 会静默不生效 → 残差仍含 `_vname`
        # → 后续数值代入无法求值 → 被误判为「恒等」而放行。
        _sym_of_name = {}
        for _r in ctx["relations"]:
            for _s in getattr(_r, "free_symbols", set()):
                _sym_of_name.setdefault(str(_s), _s)
        _vsym = _sym_of_name.get(_vname, sp.Symbol(_vname))
        _others = sorted(_vexpr.free_symbols, key=lambda s: s.name)
        if not _others:
            # 规则 2：值指派（`40=x`、`y=1`、`40=y+99`）→ 已确认无冲突 → pass
            return {
                "legit": "legit",
                "code": "value_assign_ok",
                "detail": "本步为赋值，与已有前提一致",
            }
        # 规则 3：函数关系 → 把 `v = 表达式` 代进各条前提等式，看残差。
        #
        # 判据顺序（轮次 M 修正，用户 23 用例口径）：
        #   ① 任一前提代入后残差**恒为 0** → 本步与该前提一致 → pass
        #      为什么「任一」就够（第 9 例实测）：`x+y=35` 引用了 given 节点，
        #      而 given 承载**两条**前提（`x+y=35` 与 `2x+4y=94`）；
        #      本步只讲「头数」这一个关系，代入第二条前提必然不为 0
        #      —— 若要求「所有前提都恒等」，就会把正确推导误判为冲突。
        #   ② 否则，某条前提代入后残差为**非零常数** → 确定矛盾 → fail
        #   ③ 否则，域上恒等检验：残差不为零 → 声明比前提更强 → fail
        _confirmed = False
        _const_conflict = False
        _weaker = False
        _checked = False
        for _r in ctx["relations"]:
            if not isinstance(_r, sp.Eq):
                continue
            try:
                _res = sp.simplify((_r.lhs - _r.rhs).subs(_vsym, _vexpr))
            except Exception:  # noqa: BLE001
                continue
            # 代入失败守卫：若残差仍含该变量名，说明替换未生效，
            # 本对判定作废（continue）——宁可不判，不可误判为恒等。
            if any(str(_s) == _vname for _s in _res.free_symbols):
                continue
            _checked = True
            if _res == 0:
                _confirmed = True
                break            # ① 任一前提恒等即通过
            if not _res.free_symbols:
                _const_conflict = True
                continue         # ② 记下矛盾；不提前退出（可能还有恒等的前提）
            _hold = _domain_identity_holds(_res, ctx["relations"], _others)
            if _hold is False:
                _weaker = True
        if _confirmed:
            return {
                "legit": "legit",
                "code": "relation_ok",
                "detail": "本步关系与已有前提一致",
            }
        if _const_conflict or _weaker:
            return {
                "legit": "illegal",
                "code": "constraint_conflict",
                "detail": (
                    "本步声明的关系比前提更强：它只在部分取值上成立，"
                    "未声明定义域即等于主张处处成立，与前提冲突"
                ),
            }
        if _checked:
            return {
                "legit": "legit",
                "code": "relation_ok",
                "detail": "本步关系与已有前提一致",
            }
        # 前提里没有等式可比对（只有不等式）→ 交后续关卡

    bad = _check_undeclared(current, ctx["declared"], ctx["funcNames"])
    if bad:
        return {"legit": "illegal", "code": "undeclared_symbol", "detail": bad}

    conflict, msg = _check_premise_conflict(ctx["relations"])
    if conflict:
        return {"legit": "conflict", "code": "premise_conflict", "detail": msg}

    # 支链同名函数冲突（R9，轮次 H）—— 用户提出的真实风险：
    # 两条支链各自声明了同名函数并在本节点汇合，前提集里会同时出现
    # 两份不同定义。必须在此拦截，否则判定会静默采纳其中一个，
    # 用户完全不知道，结论失去依据。
    _fn_conflict, _fn_msg, _fn_pair = _check_function_conflicts(
        args.get("facts"), ctx["declared"]
    )
    if _fn_conflict:
        return {
            "legit": "conflict",
            "code": "function_conflict",
            "detail": _fn_msg,
            "conflictPair": _fn_pair,
        }

    has_ancestor = bool(args.get("facts") or args.get("assumptions") or args.get("domains"))
    if not has_ancestor:
        # --- 轮次 M 修正：孤立节点走**完整判定**（用户口径确认）---
        #
        # 为什么必须改（用户用 23 个判定用例反推确认的口径）：
        #   等式的判据是「解集非空即成立」，**与有无前提无关** ——
        #   前提只在「解集 ∩ 前提域」这一层起作用。用户明确判定：
        #     `x+y=35`（无连线）  → pass（有公共解）
        #     `x^2=4`（无连线）   → pass（有解）
        #     `sin(x)=0.5`（无连线）→ pass（有解）
        #     `x+1=x+2`（无连线） → fail（无解）
        #     `sin(x)=2`（无连线）→ fail（无解）
        #   而不是原先「无前提一律 unknown/no_premise」。
        try:
            _st = premise_structure.analyze_structure([], current)
            if _st.get("verdict") in ("legit", "warn", "illegal"):
                return {
                    "legit": _st["verdict"],
                    "code": _st["code"],
                    "detail": _st["detail"],
                }
        except Exception:  # noqa: BLE001
            pass

        return {
            "legit": "unknown",
            "code": "no_premise",
            "detail": "引擎未能判定本步合法性",
        }

    _ex = _check_derivable_ex(ctx["relations"], current, ctx["locals"])
    verdict = _ex["verdict"]
    # warn：结论正确但有保留（可去奇点 / 部分定义域）—— 用户确认口径
    if verdict == "warn":
        return {"legit": "warn", "code": _ex["code"], "detail": _ex["detail"]}
    if verdict == "legit":
        return {"legit": "legit", "code": "ok"}
    # 缺符号信息：给出可执行指引，而非笼统「判不了」
    if _ex.get("code") == "missing_symbol_info":
        return {"legit": "unknown", "code": "missing_symbol_info", "detail": _ex["detail"]}
    if verdict == "illegal":
        # --- 交叉验证（轮次 M，第 13 例）：前提链判否时再问结构分析 ---
        # 为什么需要：前提链的否定判定未采用「解集 ∩ 前提域」这一
        # 用户确认的核心口径。实测：`sin(x)=0.5` 在前提 `0<x<1` 下被前提链
        # 判 illegal，而结构分析正确判 pass（解 π/6 ≈ 0.524 落在 (0,1)）。
        # 只采信结构分析的**肯定**结论（legit / warn）—— 它同样能判否，
        # 但否定结论不在此处越权（保持前提链的主导地位）。
        try:
            _st = premise_structure.analyze_structure(ctx["relations"], current)
            if _st.get("verdict") == "legit" and _st.get("code") == "ok":
                return {"legit": "legit", "code": _st["code"], "detail": _st["detail"]}
            if _st.get("verdict") == "warn":
                return {"legit": "warn", "code": _st["code"], "detail": _st["detail"]}
        except Exception:  # noqa: BLE001
            pass
        return {"legit": "illegal", "code": "not_derivable", "detail": "无法由已连线的前提推出本步"}
    # --- 轮次 O 修正（A3）：如实回传原因码，不再硬编码 "timeout" ---
    #
    # 为什么必须改（GUI 实测确认的误导）：
    #   旧实现无条件返回 `code="timeout"`，而 `_check_derivable_ex` 实际
    #   给出的是 `code="not_applicable"`（典型成因：本步被解析成**表达式**
    #   而非等式，`is_Relational=False`，前提链无从判定）。
    #   该 code 经 `computeAnalyze` 的 `strategy: premise_<code>` 传给 LLM
    #   （`buildAnalyzeInput` 的「引擎判定结论」段），LLM 见字面量
    #   "timeout" 便直译成「**引擎超时**」显示给用户 ——
    #   而引擎根本没有超时，它只是「这个形态判不了」。
    #   用户因此在错误方向排查（以为是性能问题）。
    #
    # 改为透传真实原因码后：
    #   - `not_applicable` → 前端可提示「本步形态不在前提链判定范围内」
    #   - `missing_symbol_info` 已在上面单独分支处理（保留可执行指引）
    #   - 未来新增码自动透传，不再被吞掉
    return {
        "legit": "unknown",
        "code": _ex.get("code") or "not_applicable",
        "detail": _ex.get("detail") or "引擎未能判定本步合法性",
    }


def cmd_session_init(args) -> dict:
    """初始化会话：编译符号环境（场景级不变信息，可安全缓存）。"""
    session_id = str(args.get("sessionId") or "").strip()
    if not session_id:
        raise ValueError("sessionId 不能为空")
    symbols = args.get("symbols")
    # 必须强制重建，不可走 _session_get 的缓存短路（探针实测缺陷）：
    # 它命中已有会话时直接返回旧环境，导致「换场景后再次 session_init」时
    # 符号表从未更新，后续步骤里的新符号一律被判为「未声明符号」而误判 illegal。
    # 实测表现为 B3/C1/C2/C4/C5/G1/H1 七例全错；
    # 而先 clear() 再传 symbols 的对照组（H2）恰好通过，正好反证此点。
    if symbols:
        sess = _session_get("__rebuild__", symbols)
        if sess is None:
            sess = {"locals": {}, "func_names": set(), "default_relations": []}
    else:
        sess = _SESSIONS.get(session_id) or {
            "locals": {}, "func_names": set(), "default_relations": []
        }
    _SESSIONS[session_id] = sess
    return {
        "sessionId": session_id,
        "symbolCount": len(sess["locals"]),
        "constFactCount": len(sess["default_relations"]),
    }


def _diff_const_pinned(items):
    """从前提串中提取「被 `dX=0` 钉死为常量」的符号名集合（轮次 X4 新增）。

    ## 用户口径（原话）
      「系统不区分常量变量，我们也不去定义什么是常量变量，只看满足
        `du=0` 这种等式作为限制条件就能限制符号的行为和运算逻辑了。」
      「接下来连了 `dg=0`、`G=mg` 两条线作为前提，提交 `g=10` pass，
        提交 `g=m+1` fail」

    ## 语义
      `dX=0` 作为**前提**（已连线）出现时，它声明的不是「X 等于某个数」，
      而是「X 在本推导链中**不随任何东西变化**」—— 即 X 归入常量。
      此后对它提交：
        `X=<纯常量>`       → 只是给这个常量定一个值 → 与前提相容 → pass
        `X=<含自由符号式>` → 等于声称「常量随变量而变」 → 与前提冲突 → fail

    ## 为什么只认 `dX=0` / `0=dX` 两种形态
      只有「**微分项 = 纯零**」才表达「钉死为常量」。
      `dX=dY` 表达的是「X 与 Y 的变化同步」（差分关系），不钉死任何一方，
      故不登记（与 `_normalize_diff_equation` 的双侧分支保持一致）。

    ## 与「系统不区分常量变量」不冲突
      本函数只按**式子形态**提取限制条件，不查任何 kind 标签 ——
      与 `_judge_differential_step` 的口径完全一致。

    ## 返回值
      符号名 set。**正常场景下为空集**，调用方据此完全放行既有流程
      （即：没有 `dX=0` 前提时，本通道对系统零影响）。
    """
    pinned = set()
    for raw in (items or []):
        if not isinstance(raw, str) or not raw.strip():
            continue
        for seg in (_split_premise_entries(raw) or [raw]):
            seg = (seg or "").strip()
            if not seg:
                continue
            de = _normalize_diff_equation(seg)
            if de is None:
                continue
            _l_is = bool(de.get("lhsIsDiff"))
            _r_is = bool(de.get("rhsIsDiff"))
            if _l_is == _r_is:
                # 两侧都是微分项（`du=dh`）或都不是（已被上面的 None 拦掉）
                # → 是「变化同步」而非「钉死为常量」，不登记。
                continue
            _diff_side = de["lhs"] if _l_is else de["rhs"]
            _val_side = de["rhs"] if _l_is else de["lhs"]
            try:
                if sp.sympify(_val_side, locals={}) != 0:
                    continue                      # 只认「= 0」的形态
            except Exception:                     # noqa: BLE001
                continue
            _name = str(_diff_side or "").strip()
            if _name:
                pinned.add(_name)
    return pinned


def _judge_diff_const_step(expr_raw, ctx, pinned):
    """`dX=0` 前提下的普通等式判定（轮次 X4 新增）。

    返回 StepLegitResult 形态的 dict；**返回 None 表示不干预**（交既有流程）。

    ## 判据（用户口径的统一判据）
      把本步化为差式后，取其中**不在 `pinned` 中**的自由符号：
        空集   → 差式只由「已被钉死的常量」与纯数构成 → 取值可确定 → pass
        非空集 → 含在前提中仍可自由变化的符号       → 取值不可确定 → fail

    ## 实测对照（scripts/_gprobe.py）
      前提 `dg=0` + `G=m*g`
        `g=10`    → 差式 `g-10`，自由符号 {g}，全部已钉死 → pass ✅
        `g=m+1`   → 差式 `g-m-1`，含未钉死的 m         → fail ✅
        `G=10*m`  → 差式 `G-10m`，G、m 均未钉死        → fail

    ## 为什么返回 None 而不是直接判否
      本函数只负责「前提里出现 `dX=0`」这一新增语义。若无该前提下
      差式含自由符号，那是既有各类判定（新变量定义 / 函数关系 / 可推导性）
      的职责，不能在此越权判否 —— 否则会大面积误伤既有用例。
    """
    if not pinned:
        return None
    text = str(expr_raw or "").strip()
    if not text or "=" not in text:
        return None
    # 只处理**单条等式**：链式（`a=b=c`）交由既有链式逐段判定，不在此拦截
    try:
        cur = _sympify_relation(text, ctx["locals"], ctx.get("funcParams"))
    except Exception:                             # noqa: BLE001
        return None
    if not isinstance(cur, sp.Eq):
        return None
    try:
        diff = sp.simplify(cur.lhs - cur.rhs)
    except Exception:                             # noqa: BLE001
        diff = None
    if diff is None:
        return None
    names = {str(s) for s in getattr(diff, "free_symbols", set())}

    # --- 介入范围守卫：本步**必须确实引用**被钉死为常量的符号 ---
    #
    # ## 为什么必须加（避免越权否定）
    #   本通道只负责「`dX=0` 前提下，给 X 定值 / 声称 X 随变量而变」这**一类**
    #   语义。若本步的自由符号与被钉死的符号**毫无交集**，说明它与该前提
    #   无关（如前提 `dg=0`、提交 `G=10*m` —— 差式里根本没有 g），
    #   此时下任何结论都是越权：应当交回既有各类判定。
    #
    #   实测对照：
    #     前提 `dg=0`，提交 `g=10`   → 差式 {g}，与 {g} 有交集 → 介入 → pass
    #     前提 `dg=0`，提交 `G=10*m` → 差式 {G,m}，与 {g} 无交集 → **不介入**
    #                                   （仍走既有 relation_ok，行为不变）
    if not (names & pinned):
        return None

    free = sorted(names - pinned)
    if free:
        return {
            "legit": "illegal",
            "code": "differential_conflict",
            "detail": (
                "前提已把 " + "、".join(sorted(pinned)) + " 定为常量，"
                "本步却让 " + "、".join(free) + " 参与取值，"
                "两者无法同时成立"
            ),
        }
    return {
        "legit": "legit",
        "code": "differential_const_ok",
        "detail": (
            "前提已把 " + "、".join(sorted(pinned)) + " 定为常量，"
            "本步只给其定值，与前提相容"
        ),
    }


def _eval_definite_calculus(expr):
    """把 expr 中**有上下限的 Integral** 与 **Derivative** 求值（轮次 X6 新增）。

    ## 只处理「定积分 / 导数」，**不动**「不定积分」
      定积分 `∫_a^b f du` 的结果**唯一**，求值无损；
      不定积分 `∫f du` 代表**原函数集合**（可差任意常数 C），
      求值成某个原函数会**丢失 C 自由度** —— 会使前提 `A=∫2x dx` 与
      提交 `A=x²+5`（合法的原函数）被判冲突（探针 B2 实测）。
      故不定积分**保留原式**，交下游按「差常数」语义处理。

    ## 为什么需要（用户现象）
      「提交是通过的，但只要删掉中间那个步骤，就会出现引擎超时」
      根因：前提里的定积分**从未求值**，导致
        ① `check_derivable` 四阶梯面对未求值 Integral 全部失效；
        ② `reduce_equalities` 对含 Integral 的前提做 `sp.solve`
           （求 `∫...` 关于积分变量 / 上下限的解）**极慢**
           → 突破前端 `COMPUTE_TIMEOUT_MS`(15s) → 显示「计算超时」。
      归一后前提变成初等表达式，两个问题同时消失。

    ## 安全守卫（与 `_eval_calculus` 同口径）
      求值失败（如 `∫f(h)dh` 中 f 未赋值）时**返回原式**、不抛错 ——
      保住「函数关系声明」语义（轮次 U / vcalc2 #30-32）。
    """
    if expr is None:
        return expr
    try:
        if not (expr.has(sp.Integral) or expr.has(sp.Derivative)):
            return expr
    except Exception:  # noqa: BLE001
        return expr
    out = expr
    try:
        for node in list(sp.preorder_traversal(expr)):
            if isinstance(node, sp.Derivative):
                try:
                    v = node.doit()
                    if v != node:
                        out = out.subs(node, v)
                except Exception:  # noqa: BLE001
                    continue
            elif isinstance(node, sp.Integral):
                # 只求**定积分**：limits 每项为 (var, lo, hi) 三元组才是定积分
                try:
                    if not node.limits:
                        continue
                    if not all(len(t) == 3 for t in node.limits):
                        continue        # 不定积分 → 保留（勿丢 C）
                    v = node.doit()
                    if v != node:
                        out = out.subs(node, v)
                except Exception:  # noqa: BLE001
                    continue
    except Exception:  # noqa: BLE001
        return expr
    return out


def _eval_calculus_relations(relations):
    """把**前提关系式**中的定积分 / 导数统一求值归一（轮次 X6 新增）。

    逐条对 `Eq` 两侧调 `_eval_definite_calculus`；非等式（不等式）原样保留。
    逐条独立 —— 单条求值失败不影响其它条。
    """
    out = []
    for r in (relations or []):
        if not isinstance(r, sp.Eq):
            out.append(r)
            continue
        try:
            _l = _eval_definite_calculus(r.lhs)
            _r = _eval_definite_calculus(r.rhs)
        except Exception:  # noqa: BLE001
            out.append(r)
            continue
        if _l != r.lhs or _r != r.rhs:
            out.append(sp.Eq(_l, _r))
        else:
            out.append(r)
    return out


def _session_context(args):
    """从入参装配一次判定所需的全部上下文（供 step / assume 共用）。"""
    session_id = str(args.get("sessionId") or "").strip()
    sess = _session_get(session_id, args.get("symbols"))
    if sess is None:
        sess = {"locals": {}, "func_names": set(), "default_relations": []}
    locals_map = dict(sess["locals"])
    # 允许调用方临时补充符号
    extra_symbols = args.get("extraSymbols")
    for name, obj in _compile_symbols(extra_symbols).items():
        locals_map.setdefault(name, obj)

    func_params = dict(sess.get("func_params") or {})
    extra_params, extra_defs = _compile_function_metadata(extra_symbols, locals_map)
    for name, params in extra_params.items():
        func_params.setdefault(name, params)
    # given / assumption 里的函数定义也是有效签名来源。
    premise_items = (
        list(args.get("facts") or [])
        + list(args.get("assumptions") or [])
        + list(args.get("domains") or [])
    )
    premise_items = [
        _normalize_cases_latex(item)[1] if _normalize_cases_latex(item)[0] else item
        for item in premise_items
    ]
    for name, params in _function_params_from_items(premise_items).items():
        func_params.setdefault(name, params)

    early_relations = []
    for item in premise_items:
        raw = str(item or "").strip()
        if not raw or _MATRIX_RE.search(raw) or _looks_like_advanced_math(raw):
            continue
        early_relations.extend(
            _parse_relations([raw], locals_map, function_params=func_params)
        )
    early_function_defs = _func_body_defs_from_relations(
        early_relations, set(func_params.keys())
    )
    matrix_defs, matrix_relations, matrix_failures, matrix_consumed = (
        _matrix_premise_context(premise_items, {
            "locals": locals_map,
            "funcNames": set(func_params.keys()),
            "functionDefs": {
                **dict(sess.get("function_defs") or {}),
                **extra_defs,
                **early_function_defs,
            },
        })
    )
    relations = list(matrix_relations)
    premise_parse_failures = list(matrix_failures)

    # 前提来自用户画布上的显式连线。任何一条解析失败都不能静默丢弃，
    # 否则下游会在“少了一个前提”的环境中给出看似确定的判定。
    def _append_premises(items):
        for raw in (items or []):
            text = str(raw or "").strip()
            if not text:
                continue
            if text in matrix_consumed:
                continue
            _case_kind, _case_text, _case_rows, _case_error = _normalize_cases_latex(text)
            if _case_error:
                premise_parse_failures.append(text)
                continue
            if _case_kind:
                text = _case_text
            parsed = _parse_relations([text], locals_map, function_params=func_params)
            if parsed:
                relations.extend(parsed)
            else:
                premise_parse_failures.append(text)

    _append_premises(args.get("facts"))
    _append_premises(args.get("assumptions"))
    _append_premises(args.get("domains"))

    # --- 轮次 X6：**前提中的定积分 / 导数统一求值归一** ---
    #
    # ## 用户现象（原话）
    #   「提交是**通过**的，合格的，但是只要**删掉中间那个步骤**，
    #     就会出现引擎超时」
    #
    # ## 根因（探针 scripts/vintegral.py 实测确认）
    #   前提里的定积分**从未求值**（`premise_engine.py` 全文无 Integral 处理），
    #   于是「本步 = 最终式」（不含 Integral）走到常规阶梯时：
    #     ① `check_derivable` 四阶梯面对未求值 Integral **全部失效**；
    #     ② 更关键：`reduce_equalities`（premise_engine 第 73-81 行）会对含
    #        Integral 的前提做 `sp.solve`（求 `∫...` 关于积分变量 / 上下限的解）
    #        —— SymPy 符号求解**极慢**，耗时突破前端
    #        `COMPUTE_TIMEOUT_MS`(15000ms) → 用户看到「**引擎超时**」。
    #
    #   「带中间步骤能过」的原因：链式切分后每一对都**含 Integral**
    #   → 走 `_judge_atomic` 的积分通道 → **绕开了 `reduce_equalities`**。
    #
    # ## 归一位置为什么在此（关系式组装后、判定前）
    #   一处改动让**所有**下游判定路径（除零检查 / 五类规则 / 可推导性 /
    #   微分判定的 `_reduce` / 假设块冲突检查）都拿到已求值前提 ——
    #   避免在 3~4 处各自补归一而漏改。
    #
    # ## 只求定积分（不定积分保留原式）
    #   见 `_eval_definite_calculus`：不定积分求值会**丢失 C 自由度**，
    #   会把合法的 `A=x²+5`（同为原函数）误判为与前提冲突（探针 B2）。
    # --- 轮次 X6：前提微积分归一**已回滚**（helper 函数保留备查）---
    #
    # ## 回滚原因（实测确认，非推测）
    #   曾把 `relations = _eval_calculus_relations(relations)` 加在此处，
    #   期望「前提中的定积分求值」后 `check_derivable` 能正常工作。
    #   但实测（探针 scripts/vintegral.py）显示：
    #     ① **未修复目标缺陷**：A3（错误答案 `W=mg0RH/R`）仍判 legit。
    #     ② **引入新回归**：与判据 ⑤ 的严格化叠加后，
    #        定义式 `W=∫(0→H)...`（given 标准写法）由 legit 变 illegal
    #        （A2/D3/D4/D5 四项）。
    #   故回滚，恢复改动前状态；「前提含未求值 Integral」引发的
    #   可推导性退化 / 潜在性能问题，需**另行设计**
    #   （区分「定义式」与「验证式」两类语义），不在本轮草率改动。
    #
    # ## 保留物
    #   `_eval_definite_calculus` / `_eval_calculus_relations` 两个 helper
    #   保留（已通过单元测试），供后续按正确语义接入时复用。

    # ============ 轮次 X5：**`globalDomains` 不再并入前提集** ============
    #
    # ## 用户口径（原话）
    #   「无前提没任何入线相当于**不引用场景中规定的任何条件**」
    #   「只有连线才会影响到相关的块」
    #
    # ## 原实现为什么违背该口径（用户 GUI 实测现象）
    #   前端 `collectBranchPremises` 把场景 `compute.boundary_conditions`
    #   映射成 `globalDomains` 后**无条件**随每次判定下发；本函数又在此
    #   无条件并入 `relations` —— 两处叠加的结果是：
    #     未连线节点提交的式子一旦与场景条件抵触
    #       → `_judge_atomic` 判 `constraint_conflict` / `premise_conflict`
    #       → 用户看到「本步与已有前提冲突」，而**他没有任何连线**
    #
    #   这与「场景常量值绕过连线」属**同一类缺陷** —— 该处已于轮次 X
    #   移除 `default_relations`，而 `globalDomains` 是当时**遗漏的第二个后门**。
    #
    # ## 为什么 `boundary_conditions` 本就不该当前提（语义错位）
    #   它是「**待覆盖的边界条件清单**」（服务于 `boundary_coverage` 指标），
    #   而非「题目给定的已知条件」。把「任务清单」当「已知条件」并入判定，
    #   会凭空制造前提 —— 与「有连线才有推导关系」直接冲突。
    #
    # ## 参数仍然接收（契约不变）
    #   `globalDomains` 仍在 args 契约中、前端也仍会传（值为空数组），
    #   此处**显式忽略**它 —— 两层都断，任一层回归都不会重现该缺陷。
    #   `boundary_conditions` 继续在 `computeAnalyze.buildAnalyzeInput` 的
    #   「待覆盖的边界条件」段生效（供 LLM 提示补全），只是不参与**对错裁定**。

    # --- 轮次 X3：入边是否为空（供微分式判定使用）---
    #
    # ## 用户口径（原话）
    #   「无前提没任何入线相当于**不引用场景中规定的任何条件**」
    #   —— 与 `_judge_atomic` 的 `has_ancestor` **同一口径**
    #      （facts / assumptions / domains 三条）。
    #   `globalDomains` 是**场景级**全局条件，不属于「当前节点的入边」，
    #   故不计入（与 `has_ancestor` 保持一致，避免两处口径分叉）。
    #
    # ## 用途
    #   `_judge_differential_step` 用它判「无入线 → 视为新声明 → pass」：
    #     无入线时 `dX=Y`（含 `du=0` / `du=dh`）不引用任何场景条件，
    #     语义就是「给微分定一条规则」→ 直接 pass。
    has_premise = bool(
        args.get("facts") or args.get("assumptions") or args.get("domains")
    )

    # --- 轮次 X 修复（GUI 实测缺陷）：**不再并入 `default_relations`** ---
    #
    # ## 用户口径（原话）
    #   「只有连线才会影响到相关的块。given 给了 R=2，我新建一个**没有连线**的
    #     假设 R=1 提交，按道理应该通过，因为我没有任何连线」。
    #
    # ## 原实现为什么违背该口径（实测链路）
    #   `_session_get` 会把 `compute.symbols[].value`（场景常量取值，如 R=2）
    #   编译成 `default_relations = [Eq(R, 2)]`；本函数此前把它**无条件**
    #   并入每一次判定的前提集。于是：
    #     - 未连线的假设节点 `R=1` → 前端 `facts/assumptions` 均为空 ✅
    #     - 但 `relations` 里仍带着 `Eq(R,2)` → `_judge_atomic` 判
    #       `constraint_conflict` ❌
    #   即：场景常量值从「会话级后门」绕过了连线机制，与本项目核心语义
    #   「**有连线才有推导关系**」（见 `premiseChain.ts` 的文档）直接冲突。
    #
    # ## 为什么不影响轮次 W 的微分判定
    #   「谁是常量 / 常量取什么值」走的是**独立通道** `const_values`
    #   （见 `_session_get` 的 `const_values` 与 `ctx["constValues"]`），
    #   从不依赖 `default_relations`，故本次删除不削弱微分等式判定能力。
    #
    # ## 场景级全局条件**已不再自动生效**（轮次 X5 变更）
    #   原注释曾声明「`boundary_conditions` → `globalDomains` 是场景级全局条件
    #   （对所有节点生效），保留不变」—— 该设计**已被用户口径推翻**：
    #     「无前提没任何入线相当于不引用场景中规定的任何条件」
    #   场景条件要生效，必须由用户在画布上**实际连线**一个承载它的 given 节点。
    #   详见本函数上方 `globalDomains` 处的完整说明。
    #
    # ## `default_relations` 保留但不再参战
    #   `_session_get` 仍会编译它（供 `cmd_session_init` 的 `constFactCount`
    #   诊断计数使用），只是不再进入判定前提集；若将来需要「场景常量作为
    #   全局前提」的语义，应由前端在场景级 `globalDomains` 中显式声明。

    return {
        "sessionId": session_id,
        "locals": locals_map,
        "declared": set(locals_map.keys()),
        "funcNames": set(sess.get("func_names") or []),
        "funcParams": func_params,
        "functionDefs": {
            **dict(sess.get("function_defs") or {}),
            **extra_defs,
        },
        "matrixDefs": matrix_defs,
        "relations": relations,
        "premiseParseFailures": premise_parse_failures,
        # --- 轮次 X3：入边是否为空（见本函数内 `has_premise` 的说明）---
        "hasPremise": has_premise,
        # --- 轮次 W：微分等式判定所需的元信息（见 `_session_get` 的说明）---
        "varNames": set(sess.get("var_names") or []),
        "constValues": dict(sess.get("const_values") or {}),
    }


def _strict_constraint_entails(expr_text, ctx) -> bool:
    """保守判断前提是否蕴含一个约束；判不了时返回 False。"""
    if not ctx.get("hasPremise"):
        return False
    try:
        current = _sympify_relation(
            expr_text, ctx["locals"], ctx.get("funcParams")
        )
        if current is sp.true or current is True:
            return True
        relations = list(ctx.get("relations") or [])
        if any(current == rel for rel in relations):
            return True

        # 先复用前提引擎已有的唯一解代入。例如 x=1 必须能推出 1/x=1；
        # 多解前提 x**2=1 不会产生唯一 substitution，因此不会误放行 x=1。
        _remaining, substitutions, conflict = premise_engine.reduce_equalities(relations)
        if not conflict and substitutions:
            reduced = current
            for _ in range(len(substitutions) + 1):
                next_reduced = reduced.subs(substitutions, simultaneous=True)
                if next_reduced == reduced:
                    break
                reduced = next_reduced
            if reduced is sp.true or reduced is True:
                return True
            if isinstance(reduced, sp.Equality):
                try:
                    if sp.simplify(reduced.lhs - reduced.rhs) == 0:
                        return True
                except Exception:  # noqa: BLE001
                    pass

        symbols = set(getattr(current, "free_symbols", set()))
        for rel in relations:
            symbols.update(getattr(rel, "free_symbols", set()))
        if len(symbols) != 1:
            return False
        symbol = next(iter(symbols))
        contradiction = sp.reduce_inequalities(
            relations + [sp.Not(current)], symbol
        )
        return contradiction is sp.false or contradiction is False
    except Exception:  # noqa: BLE001
        return False


def _apply_step_intent(result, intent, expr_text, ctx) -> dict:
    """把底层“成立”细分为推导、恒等、定义、相容和声明。"""
    out = dict(result or {})
    if intent not in ("derivation", "conclusion"):
        return out

    if intent == "conclusion" and not ctx.get("hasPremise"):
        return {
            "legit": "unknown",
            "code": "conclusion_no_premise",
            "proofBasis": "unknown",
            "detail": "结论节点必须连接至少一个已通过验证的前提或推导步骤",
        }

    if out.get("legit") != "legit":
        # 底层等式推导器可能先返回 not_derivable，但唯一解代入仍能严格推出
        # 不等式结论，例如 log(x)=0 => x>0、1/x=1 => x>0。
        try:
            _intent_current = _sympify_relation(
                expr_text, ctx["locals"], ctx.get("funcParams")
            )
            _intent_is_inequality = bool(
                getattr(_intent_current, "is_Relational", False)
                and not isinstance(_intent_current, sp.Equality)
            )
        except Exception:  # noqa: BLE001
            _intent_is_inequality = False
        if _intent_is_inequality and _strict_constraint_entails(expr_text, ctx):
            return {
                "legit": "legit",
                "code": "constraint_entailed",
                "proofBasis": "entailed",
                "detail": "该约束可由已连接的前提严格推出",
            }

        # 常规推导器对单独不等式返回 not_applicable；节点意图模式下仍需区分
        # “由前提蕴含”和“只是与前提相容”。
        if out.get("code") in ("not_applicable", "no_premise"):
            try:
                current = _sympify_relation(
                    expr_text, ctx["locals"], ctx.get("funcParams")
                )
                is_inequality = bool(
                    getattr(current, "is_Relational", False)
                    and not isinstance(current, sp.Equality)
                )
            except Exception:  # noqa: BLE001
                is_inequality = False
            if is_inequality:
                compatible = _judge_constraint(expr_text, ctx)
                if compatible.get("legit") != "legit":
                    compatible = dict(compatible)
                    compatible.setdefault("proofBasis", "unknown")
                    return compatible
                if _strict_constraint_entails(expr_text, ctx):
                    compatible["code"] = "constraint_entailed"
                    compatible["proofBasis"] = "entailed"
                    return compatible
                return {
                    "legit": "warn" if intent == "derivation" else "illegal",
                    "code": (
                        "compatible_not_derived"
                        if intent == "derivation"
                        else "conclusion_not_derived"
                    ),
                    "proofBasis": "compatible",
                    "detail": "该约束与当前前提相容，但尚未由当前前提推出；若它是附加条件，请改用假设前提节点。",
                }
        out.setdefault("proofBasis", "unknown")
        return out

    code = str(out.get("code") or "")
    definition_codes = {
        "new_definition", "function_declared", "func_body_declared", "matrix_declared",
    }
    declared_codes = {
        "partial_equation_declared",
        "differential_declared",
        "func_fact_declared",
        "func_relation_declared",
    }
    compatible_codes = {
        "func_body_solvable",
        "func_relation_solvable",
        "explicit_derivative_solvable",
        "constraint_ok",
        "value_assign_ok",
    }
    identity_codes = {
        "func_body_ok",
        "partial_identity_ok",
        "integral_constant_ok",
        "differential_equal",
        "differential_const_ok",
        "func_relation_ok",
        "explicit_derivative_identity",
        "ode_solution_ok",
        "matrix_identity",
        "advanced_identity",
    }

    if code in definition_codes:
        basis = "definition"
    elif code in declared_codes:
        basis = "declared"
    elif code in compatible_codes:
        if code in ("constraint_ok", "value_assign_ok") and _strict_constraint_entails(
            expr_text, ctx
        ):
            basis = "entailed"
        else:
            basis = "compatible"
    elif code in identity_codes:
        basis = "identity"
    else:
        basis = "entailed"
    out["proofBasis"] = basis

    if intent == "conclusion":
        if basis not in ("entailed", "identity"):
            return {
                "legit": "illegal",
                "code": "conclusion_not_derived",
                "proofBasis": basis,
                "detail": "该等式与前提相容或可作为声明，但尚未证明它能由当前支路推出",
            }
        return out

    if basis in ("compatible", "declared"):
        out["legit"] = "warn"
        out["code"] = (
            "compatible_not_derived" if basis == "compatible" else "declared_not_derived"
        )
        original = str(out.get("detail") or "").strip()
        suffix = "该式尚未由当前前提推出；若它是附加条件，请改用假设前提节点。"
        out["detail"] = (original + "；" + suffix) if original else suffix
    return out


def _judge_case_system(args, ctx, rows, intent):
    """按节点意图判定 MathLive cases 方程组。"""
    relations = _parse_relations(
        rows, ctx["locals"], function_params=ctx.get("funcParams")
    )
    if len(relations) != len(rows):
        return {
            "legit": "unknown",
            "code": "unparsable",
            "proofBasis": "unknown",
            "detail": "方程组中存在无法解析的行",
        }

    conflict, message = _check_premise_conflict(
        list(ctx.get("relations") or []) + relations
    )
    if conflict:
        return {
            "legit": "conflict" if intent == "assumption" else "illegal",
            "code": "premise_conflict" if intent == "assumption" else "system_conflict",
            "proofBasis": "unknown",
            "detail": "方程组内部或与已连接前提冲突：" + str(message or ""),
        }

    if intent == "assumption":
        return {
            "legit": "legit",
            "code": "system_declared",
            "detail": "方程组已作为一组联合约束加入",
        }
    if intent == "conclusion" and not ctx.get("hasPremise"):
        return {
            "legit": "unknown",
            "code": "conclusion_no_premise",
            "proofBasis": "unknown",
            "detail": "结论方程组必须连接已验证的上游前提",
        }
    if not ctx.get("hasPremise"):
        return {
            "legit": "warn",
            "code": "declared_not_derived",
            "proofBasis": "declared",
            "detail": "方程组语法成立并可联合求解，但尚未由前提推出；若它是条件，请使用假设前提节点",
        }

    first_soft = None
    for index, row in enumerate(rows):
        sub_args = dict(args)
        sub_args["expr"] = row
        result = _apply_step_intent(
            _judge_atomic(sub_args, ctx), intent, row, ctx
        )
        if result.get("legit") in ("illegal", "conflict"):
            result = dict(result)
            result["detail"] = "方程组第 %d 行：%s" % (
                index + 1, result.get("detail") or "不能由前提推出"
            )
            return result
        if result.get("legit") in ("warn", "unknown") and first_soft is None:
            first_soft = dict(result)
            first_soft["detail"] = "方程组第 %d 行：%s" % (
                index + 1, result.get("detail") or "尚未确认"
            )
    if first_soft is not None:
        return first_soft
    return {
        "legit": "legit",
        "code": "system_entailed",
        "proofBasis": "entailed",
        "detail": "方程组每一行均可由已连接前提推出",
    }


def _looks_like_matrix_input(raw, ctx):
    text = str(raw or "")
    explicit_matrix_op = bool(
        _MATRIX_DECORATED_NAME_RE.search(text)
        or re.search(r"\\det\b|\\(?:lVert|rVert|Vert)\b|\\\|", text)
    )
    return bool(_MATRIX_RE.search(text)) or explicit_matrix_op or _looks_like_advanced_math(text) or _contains_matrix_name(
        text, ctx.get("matrixDefs") or {}
    )


def _judge_matrix_step(args, ctx, raw, intent):
    """判定 MathLive 矩阵/向量等式；非定义式复用分量级前提引擎。"""
    matrix_defs = dict(ctx.get("matrixDefs") or {})
    advanced_input = _looks_like_advanced_math(raw)
    name, body = _matrix_definition_shape(raw)
    derived_operator_name = bool(
        name
        and advanced_input
        and re.fullmatch(r"[HJ]_[A-Za-z_]\w*", name)
    )
    if (
        name and not derived_operator_name and name not in matrix_defs
        and not _contains_matrix_name(name, matrix_defs)
    ):
        try:
            value, _ = _eval_matrix_expression(body, ctx, matrix_defs)
        except Exception as exc:  # noqa: BLE001
            return {
                "legit": "unknown",
                "code": "unsupported_expression",
                "proofBasis": "unknown",
                "detail": "矩阵定义无法解析：" + str(exc),
            }
        if isinstance(value, sp.MatrixBase):
            if isinstance((ctx.get("locals") or {}).get(name), sp.FunctionClass):
                return {
                    "legit": "illegal",
                    "code": "matrix_symbol_conflict",
                    "proofBasis": "unknown",
                    "detail": "%s 已被声明为函数，不能同时作为矩阵" % name,
                }
            result = {
                "legit": "legit",
                "code": "matrix_declared",
                "detail": "已声明矩阵 %s，维度为 %d×%d" % (
                    name, value.rows, value.cols
                ),
            }
            if intent == "assumption":
                return result
            return _apply_step_intent(result, intent, raw, ctx)
        if name not in (ctx.get("locals") or {}):
            result = {
                "legit": "legit",
                "code": "new_definition",
                "detail": "已用矩阵或向量运算结果定义标量 %s" % name,
            }
            if intent == "assumption":
                result["code"] = "matrix_constraint_declared"
                result["detail"] = "已将矩阵或向量运算得到的标量等式作为新约束加入"
                return result
            return _apply_step_intent(result, intent, raw, ctx)

    normalized, left, right, error = _matrix_equation_sides(raw, ctx, matrix_defs)
    if error:
        return {
            "legit": "unknown",
            "code": "unsupported_expression",
            "proofBasis": "unknown",
            "detail": error,
        }

    left_is_matrix = isinstance(left, sp.MatrixBase)
    right_is_matrix = isinstance(right, sp.MatrixBase)
    if left_is_matrix != right_is_matrix:
        return {
            "legit": "conflict" if intent == "assumption" else "illegal",
            "code": "matrix_type_mismatch",
            "proofBasis": "unknown",
            "detail": "矩阵不能与标量直接相等",
        }
    if left_is_matrix and left.shape != right.shape:
        return {
            "legit": "conflict" if intent == "assumption" else "illegal",
            "code": "matrix_dimension_mismatch",
            "proofBasis": "unknown",
            "detail": "矩阵等式两侧维度不一致：%s 与 %s" % (
                left.shape, right.shape
            ),
        }

    pairs = list(zip(left, right)) if left_is_matrix else [(left, right)]
    differences = []
    for a, b in pairs:
        if a == b:
            differences.append(sp.S.Zero)
            continue
        try:
            differences.append(sp.simplify(a - b))
        except Exception:  # noqa: BLE001
            differences.append(a - b)
    if differences and all(diff == 0 for diff in differences):
        result = {
            "legit": "legit",
            "code": "advanced_identity" if advanced_input else "matrix_identity",
            "detail": (
                "结构化运算求值后等式两侧相等"
                if advanced_input else "矩阵运算后各对应分量均相等"
            ),
        }
        if intent == "assumption":
            return result
        return _apply_step_intent(result, intent, normalized, ctx)

    if any(not diff.free_symbols and diff != 0 for diff in differences):
        return {
            "legit": "conflict" if intent == "assumption" else "illegal",
            "code": "advanced_mismatch" if advanced_input else "matrix_mismatch",
            "proofBasis": "unknown",
            "detail": (
                "结构化运算求值后等式两侧不相等"
                if advanced_input else "矩阵运算后至少有一个对应分量不相等"
            ),
        }

    rows = ["%s=%s" % (sp.sstr(a), sp.sstr(b)) for a, b in pairs]
    if advanced_input and not left_is_matrix and intent in ("derivation", "conclusion"):
        if _strict_constraint_entails(rows[0], ctx):
            return {
                "legit": "legit",
                "code": "advanced_entailed",
                "proofBasis": "entailed",
                "detail": "结构化运算求值后的等式可由已连接前提推出",
            }
        candidate = _judge_case_system(args, ctx, rows, intent)
        if candidate.get("legit") != "legit":
            return candidate
        return {
            "legit": "warn" if intent == "derivation" else "illegal",
            "code": (
                "compatible_not_derived"
                if intent == "derivation" else "conclusion_not_derived"
            ),
            "proofBasis": "compatible",
            "detail": "结构化运算求值后的等式与前提相容，但尚未由当前前提推出",
        }
    result = _judge_case_system(args, ctx, rows, intent)
    if result.get("code") == "system_declared":
        result = dict(result)
        result["code"] = "matrix_constraint_declared"
        result["detail"] = "矩阵等式已按对应分量作为联合约束加入"
    elif result.get("code") == "system_entailed":
        result = dict(result)
        result["code"] = "matrix_entailed"
        result["detail"] = "矩阵等式的每个对应分量均可由前提推出"
    return result


def cmd_session_step(args) -> dict:
    """判定单步合法性（前提链前置关卡）。

    **链式等式按相邻段逐段比对**（轮次 I，用户明确定的口径）：
    用户原话「a=b=c=d，要验证 a 和 b 相等、b 和 c 相等、c 和 d 相等，
    3 次判断都正确，用户输入的 a=b=c=d 才是正确的」。
    故此处把链式切成相邻等式对逐对判定，任一对不成立即整条不成立。

    为什么不能把链式整串交给 `_sympify_relation`（旧行为）：
    它会把 `1=2=3` 归一为 `And(Eq(1,2), Eq(2,3))`，而 `And` 的
    `free_symbols` 为空、`is_Relational` 为假，`check_derivable` 拿不到
    可比对的关系式（旧路径直接走 `unknown` 回落参考解比对）——
    这正是「链式切了却没逐段判」的成因。

    单段与链式段走**完全相同**的原子规程（见 `_judge_atomic`），
    避免两处逻辑分叉后漏改一处。

    处理顺序（见 `_judge_atomic`）：
      ⓪ 链式切分（≥3 段）→ 逐对判定
      ① 解析表达式
      ② 定义式通道（新变量声明 → 直接 pass，不对错比对）
      ③ 未声明符号 / 未定义函数
      ④ 除零风险
      ⑤ 前提自相矛盾 / 支链函数重名冲突
      ⑥ 孤立节点（无祖先前提）→ unknown（上层判 warn）
      ⑦ 推导合法性
    """
    ctx = _session_context(args)
    intent = str(args.get("intent") or "legacy").strip().lower()

    def _final(result):
        return _apply_step_intent(result, intent, args.get("expr"), ctx)

    if ctx.get("premiseParseFailures"):
        return _final({
            "legit": "unknown",
            "code": "premise_unparsable",
            "detail": "已连接的前提无法解析：" + "；".join(ctx["premiseParseFailures"]),
        })

    _case_kind, _case_text, _case_rows, _case_error = _normalize_cases_latex(
        args.get("expr")
    )
    if _case_error:
        return _final({
            "legit": "unknown",
            "code": "unsupported_expression",
            "detail": _case_error,
        })
    if _case_kind == "system":
        return _judge_case_system(args, ctx, _case_rows, intent)
    if _case_kind == "piecewise":
        args = dict(args)
        args["expr"] = _case_text
        if _piecewise_covers_reals(_case_text, ctx) is False:
            return {
                "legit": "illegal" if intent == "conclusion" else "warn",
                "code": "piecewise_domain_gap",
                "proofBasis": "declared",
                "detail": "分段条件没有覆盖完整实数域；请补充分支或明确函数定义域",
            }

    if _looks_like_matrix_input(args.get("expr"), ctx):
        return _judge_matrix_step(args, ctx, args.get("expr"), intent)

    _unsupported = _unsupported_latex_structure(args.get("expr"))
    if _unsupported:
        return _final({
            "legit": "unknown",
            "code": "unsupported_expression",
            "detail": _unsupported,
        })
    _raw_expr_before_normalize = str(args.get("expr") or "")
    if "\\partial" in _raw_expr_before_normalize or "∂" in _raw_expr_before_normalize:
        args = dict(args)
        args["_partialNotation"] = True

    # --- 轮次 W 前置：LaTeX 归一（**必须绝对最先**）---
    #
    # ## 为什么必须早于一切（vmlx B5/C3/G3/G4/G5 实测确认）
    #   下方 `_split_local_constraints` 会按顶层分隔符切段，而分隔符含
    #   `,`（`_LOCAL_SEP = ";；,，"`）—— LaTeX 的**细空格** `\,` 里正好有逗号，
    #   于是 `\int 2x\,dx=x^{2}=x^{2}` 会被切成
    #   `\int 2x \` 与 ` dx=x^{2}=x^{2}` 两段，整条式子被破坏，
    #   后面 `_sympify_relation` 里的 LaTeX 通道**再也拿不到完整原文**。
    #   故必须在此处先归一，使后续全部环节都拿到项目语法串。
    #
    # ## 归一后为何安全
    #   `_latex_pre_normalize` 内部 `_has_latex_markers` 判据不含 LaTeX 时
    #   **原样返回**，故纯 Python 语法输入的 `args["expr"]` 不变（零影响）。
    _expr_norm = _latex_pre_normalize(
        str(args.get("expr") or ""), ctx.get("funcParams")
    )
    if _expr_norm != args.get("expr"):
        args = dict(args)
        args["expr"] = _expr_norm

    _prime_expr, _missing_prime_dependency = _normalize_bare_prime_derivatives(
        args.get("expr"), ctx
    )
    if _prime_expr != args.get("expr"):
        args = dict(args)
        args["expr"] = _prime_expr
    if _missing_prime_dependency is not None:
        return _final({
            "legit": "unknown",
            "code": "derivative_dependency_missing",
            "detail": (
                "无法确定 %s 的自变量；请声明函数签名（如 %s(x)），"
                "或写成 %s'(x) 后再求导"
                % (
                    _missing_prime_dependency,
                    _missing_prime_dependency,
                    _missing_prime_dependency,
                )
            ),
        })

    if not args.get("_partialNotation"):
        _dependency_probe = _normalize_notation(
            str(args.get("expr") or ""), func_names=ctx.get("funcNames")
        )
        _resolved_derivative, _missing_dep = _resolve_bare_derivative_from_relations(
            _dependency_probe, ctx
        )
        if _resolved_derivative != _dependency_probe:
            args = dict(args)
            args["expr"] = _resolved_derivative
        if _missing_dep is not None:
            _dependent, _variable = _missing_dep
            return _final({
                "legit": "unknown",
                "code": "derivative_dependency_missing",
                "detail": (
                    "无法确定 %s 是否是 %s 的函数；请在场景符号中声明函数签名，"
                    "或写成 %s(%s) 后再求导"
                    % (_dependent, _variable, _dependent, _variable)
                ),
            })

        _explicit_derivative = _judge_explicit_derivative_text(args.get("expr"), ctx)
        if _explicit_derivative is not None:
            return _final(_explicit_derivative)

    # --- 轮次 X2 第 1 步修复：下标符号名回填（**必须早于任何声明流程**）---
    #
    # ## 为什么必须放在这里（实测确认，否则回填会失效）
    #   SymPy 的 LaTeX 通道把 `g_0` 输出成 `g0`（下划线被吞）。若等到
    #   `_sympify_relation` 里才回填，中间会先经过
    #   `_prepare_declarations` → `_auto_declare_symbols`（❸ 自动声明），
    #   而后者会把 `g0` **当作全新变量**写进 `locals`。
    #   于是 `_restore_subscript_names` 的判据「别名已在 locals 中 → 不回填」
    #   被触发，回填**静默失效**。
    #
    #   实测证据（完整链路里 `_check_premise_conflict` 的实际输入）：
    #     前提：Eq(W, Integral(R**2*g_0*m/(R + h)**2, (h, 0, H)))   ← g_0 正确
    #     提交：Eq(W, H*R*g0*m/(H + R))                             ← g0 未回填
    #   两者符号名不一致 → 被误判「前提条件互相矛盾」（用户 GUI 现象）。
    #
    #   `ctx["locals"]` 此刻仍是 `_session_context` 的干净产物（只含场景
    #   声明的 `g_0`，不含被自动声明的 `g0`），故回填判据能正确命中。
    #   详见 `_restore_subscript_names` 的 docstring。
    _expr_restored = _restore_subscript_names(str(args.get("expr") or ""), ctx["locals"])
    if _expr_restored != args.get("expr"):
        args = dict(args)
        args["expr"] = _expr_restored

    # --- 轮次 W：微分等式通道（**必须最先**，早于一切声明流程）---
    #
    # ## 为什么必须最早（实测确认，否则语义不可恢复）
    #   `_normalize_diff_text` 会把 `du` 保护成 `d(u)`；但若先跑
    #   `_prepare_declarations` 的 ❸（自动声明），`d` 会被登记为**变量**，
    #   随后 `_strip_implicit_mul` 就会把 `d(u)` 拆回 `d*u`。
    #   故本通道必须在任何声明/解析之前拦截。
    #
    # ## 用户口径（原话）
    #   「u 和 h 是变量，前提 R 是常量，u=R+h，du=dh」
    #   —— 数学含义：R 为常量 ⟹ dR = 0 ⟹ du = d(R+h) = dh。
    #
    # ## 只拦「两侧各自整体就是一个微分项」的形式
    #   与 `_function_declaration_result` 同口径：混在其它运算里的 `dX`
    #   不当作微分等式（交常规判定），避免放宽既有语义。
    _diff_eq = _normalize_diff_equation(args.get("expr"))
    if _diff_eq is not None:
        return _final(_judge_differential_step(_diff_eq, ctx))

    # --- 轮次 T（用户口径）：**先登记前提中声明的函数** ---
    # 原话：「先判断 F(h) 是不是已经声明的函数，再判断这个是等式还是声明；
    #   如果是已经声明的函数，就走等式判断路径，如果不是就走函数声明」。
    # given 里的 `F(h)=h**2` 就是「已声明函数」—— **必须先登记**，
    # 否则 `F(h)=h**3` 会被误判为「函数声明」而绕过等式判定（实测确认）。
    ctx = _register_premise_functions(ctx)

    if intent in ("derivation", "conclusion"):
        _ode_result = _judge_ode_candidate(args.get("expr"), ctx)
        if _ode_result is not None:
            return _final(_ode_result)

    # --- 轮次 T：**函数声明通道**（用户口径：「a(x)=x+1 走函数声明路线，
    # 不做等式判定」→ 先声明变量 x、再声明函数 a，直接 pass）---
    #
    # ## 时序要求（实测确认，两个方向相反，都必须精确）
    #   ① 必须**先** `_register_premise_functions`（前提里声明的函数）——
    #      given 的 `F(h)=h**2` 使 `F` 成为「已声明函数」，此后
    #      `F(h)=h**3` 应走**等式判定**（func_body_solvable）而非声明通道。
    #   ② 必须**后** `_prepare_declarations` 的 ❸（自动声明）——
    #      否则 `a(x)=x+1` 里的 `a` 会被 ❸ 先登记为 Function，
    #      使本通道「未在 locals 中」的判据误命中而返回 None，通道失效。
    #
    # ## 为什么「不做等式判定」
    #   `a(x)=x+1` 若进普通判定，会被当作**含未知函数 a 的等式**：
    #   结构分析无从判断 `a(x)` 与 `x+1` 的关系 → 返回 unknown（实测，
    #   这正是例 2 此前不通过的成因）。而它的语义是「给 a 下定义」——
    #   定义无需被推导，语法成立即为合法。
    _decl_res = _function_declaration_result(args.get("expr"), ctx["locals"])
    if _decl_res is not None:
        return _final(_decl_res)

    # --- 轮次 T：入口先补全声明（`_split_local_constraints` 依赖它）---
    # 为什么必须在拆解**之前**：`_is_constraint_segment` 要 sympify 判断
    # 「能否解出常数」，而 `a=2` 这类式子需要 `a` 已在 locals 中 ——
    # 否则 `a=2` 会被误判为非限定条件而走错通道。
    ctx, _entry_err = _prepare_declarations(ctx, args.get("expr"))
    if _entry_err is not None:
        return _final(_entry_err)

    # --- 轮次 X4：**dX=0 前提通道**（用户口径「只看等式作为限制条件」）---
    #
    # ## 用户口径（原话）
    #   「系统不区分常量变量，我们也不去定义什么是常量变量，只看满足
    #     du=0 这种等式作为限制条件就能限制符号的行为和运算逻辑了。」
    #   「接下来连了 dg=0、G=mg 两条线作为前提，提交 g=10 pass，
    #     提交 g=m+1 fail」
    #
    # ## 为什么必须在 `_split_local_constraints` **之前**拦截
    #   `g=10` 这类「符号 = 纯数值」会被 `_is_constraint_segment` 判为
    #   **限定条件**，走 `_judge_constraint`（判据只有「与前提是否冲突」），
    #   于是 `g=m+1` 也会被放行（实测 G2：`relation_ok`）。
    #   本通道的判据不同（「是否只由已钉死的常量构成」），必须前置。
    #
    # ## 为什么无 `dX=0` 前提时完全无影响
    #   `_diff_const_pinned` 正常返回**空集**，下句条件不成立，
    #   既有流程一行不改地继续执行（回归风险为零）。
    _dcs_pinned = _diff_const_pinned(
        list(args.get("facts") or [])
        + list(args.get("assumptions") or [])
        + list(args.get("domains") or [])
    )
    if _dcs_pinned:
        _dcs_res = _judge_diff_const_step(args.get("expr"), ctx, _dcs_pinned)
        if _dcs_res is not None:
            return _final(_dcs_res)

    # --- ⓪ 局部限定条件拆解（轮次 I 追加，用户口径）---
    #
    # 学生可在公式块里**自带限制条件**，如 `y=40+2x; x=0`。
    # 用户口径：这些条件**提升为前提** ——「相当于先提交 x=0 作为前提，
    # 再提交 y=40+2x」。识别依据是**形式**而非书写顺序。
    if intent in ("derivation", "conclusion"):
        # 公式/结论节点中的等式是待证明命题，不能按“局部假设”偷偷并入前提。
        mains, cons = [args.get("expr")], []
    else:
        mains, cons = _split_local_constraints(args.get("expr"), ctx["locals"])

    def _judge_one(expr, use_ctx):
        """单段判定（含链式分支）。

        为什么用嵌套函数（轮次 I 追加）：限定条件拆解后可能得到**多个主式段**，
        需要逐段走同一套规程（含链式判定）。嵌套可避免把链式逻辑复制两份。
        """
        segs = _chain_segments(expr, use_ctx["locals"])
        if segs and len(segs) > 2:
            pairs = [(segs[i], segs[i + 1]) for i in range(len(segs) - 1)]
            first_soft = None
            # 前提**累积**（轮次 I 修订，用户口径）：
            # 「a=b=c 的拆分就相当于用户先提交了 a=b，然后再提交 b=c」——
            # 先成立的段成为后一段的前提。用局部 ctx 承载累积，不动调用方入参。
            local_ctx = dict(use_ctx)
            for idx, (a_raw, b_raw) in enumerate(pairs):
                sub_args = dict(args)
                sub_args["expr"] = f"{a_raw} = {b_raw}"
                res = _judge_atomic(sub_args, local_ctx)
                verdict = res.get("legit")
                locator = f"链式等式第 {idx + 1} 段与第 {idx + 2} 段"
                if verdict in ("illegal", "conflict"):
                    # 明确不成立 → 整条判否，并把断点段号带回（用户要知道断在哪）
                    bad = dict(res)
                    bad["detail"] = (locator + "不成立：" + (res.get("detail") or "")).rstrip("：")
                    return bad
                if verdict in ("warn", "unknown") and first_soft is None:
                    # 保留首个「软结论」（有保留 / 判不了），全部段跑完后取它 ——
                    # 不提前返回，才能保证「每一对都验过」（用户要求 3 次判断都做）
                    soft = dict(res)
                    soft["detail"] = (locator + "：" + (res.get("detail") or "")).rstrip("：")
                    first_soft = soft
                # 只有**已确认成立**的段才成为后续段的前提：
                # warn / unknown 尚未确认，加进去会让错误沿链扩散。
                if verdict == "legit":
                    try:
                        _pair = _sympify_relation(
                            f"{a_raw} = {b_raw}", local_ctx["locals"],
                            local_ctx.get("funcParams"),
                        )
                        local_ctx = dict(local_ctx)
                        local_ctx["relations"] = list(local_ctx["relations"]) + [_pair]
                    except Exception:  # noqa: BLE001
                        pass
            if first_soft is not None:
                return first_soft
            return {"legit": "legit", "code": "chain_all_pairs_ok"}

        sub = dict(args)
        sub["expr"] = expr
        return _judge_atomic(sub, use_ctx)

    # --- ① 限定条件**逐个判定**（用户要求「全都判定」）---
    #
    # 为什么用**未并入**的 relations 起手：避免「自己跟自己比」——
    # 若先把 c 并入 relations 再判 c，`_check_premise_conflict` 会拿 c 与自身比对。
    # 为什么只累积 legit：warn / unknown 尚未确认成立，
    # 加进去会让不确定结论沿链扩散为确定结论。
    if cons:
        acc = list(ctx["relations"])
        first_soft = None
        for c in cons:
            probe = dict(ctx)
            probe["relations"] = acc
            res = _judge_constraint(c, probe)
            verdict = res.get("legit")
            if verdict in ("illegal", "conflict"):
                bad = dict(res)
                bad["detail"] = ("限定条件 " + c + " 不成立：" + (res.get("detail") or "")).rstrip("：")
                return _final(bad)
            if verdict in ("warn", "unknown") and first_soft is None:
                soft = dict(res)
                soft["detail"] = ("限定条件 " + c + "：" + (res.get("detail") or "")).rstrip("：")
                first_soft = soft
            if verdict == "legit":
                acc = acc + _parse_relations(
                    [c], ctx["locals"], function_params=ctx.get("funcParams")
                )

        if not mains:
            # 全部段都是限定条件（无可判定主式）→ 一致性通过即 pass
            if first_soft is not None:
                return _final(first_soft)
            return _final({
                "legit": "legit",
                "code": "constraint_ok",
                "detail": "本步声明的限定条件与已有前提一致",
            })
        ctx = dict(ctx)
        ctx["relations"] = acc

    if not mains:
        return _final({"legit": "unknown", "code": "no_premise", "detail": "表达式为空"})

    if len(mains) == 1:
        return _final(_judge_one(mains[0], ctx))

    # --- ② 多个主式段：逐段判定，全过才过（用户要求「全都判定」）---
    first_soft = None
    for i, m in enumerate(mains):
        res = _judge_one(m, ctx)
        verdict = res.get("legit")
        locator = f"第 {i + 1} 段"
        if verdict in ("illegal", "conflict"):
            bad = dict(res)
            bad["detail"] = (locator + "不成立：" + (res.get("detail") or "")).rstrip("：")
            return _final(bad)
        if verdict in ("warn", "unknown") and first_soft is None:
            soft = dict(res)
            soft["detail"] = (locator + "：" + (res.get("detail") or "")).rstrip("：")
            first_soft = soft
    if first_soft is not None:
        return _final(first_soft)
    return _final({"legit": "legit", "code": "all_segments_ok"})


def cmd_session_assume(args) -> dict:
    """校验用户新建的假设前提是否与祖先前提冲突。

    冲突时返回 conflict：场景前提优先（题目给定条件不能被用户假设推翻）。

    --- 轮次 T：与 `_judge_atomic` 同口径（用户要求「变量也要自动声明」）---
    假设节点同样是「用户书写」，因此也必须支持：
      ❶ 前提函数登记 → ❷ R8 检查 → ❸ 自动声明（算子→已声明→函数→变量）
    否则用户写 `a(x)=x+1` 作为假设时会被报「未定义的函数 a」。
    """
    ctx = _session_context(args)

    if ctx.get("premiseParseFailures"):
        return {
            "legit": "unknown",
            "code": "premise_unparsable",
            "detail": "已连接的前提无法解析：" + "；".join(ctx["premiseParseFailures"]),
        }

    raw = args.get("assumption")

    _case_kind, _case_text, _case_rows, _case_error = _normalize_cases_latex(raw)
    if _case_error:
        return {
            "legit": "unknown",
            "code": "unsupported_expression",
            "detail": _case_error,
        }
    if _case_kind == "system":
        return _judge_case_system(args, ctx, _case_rows, "assumption")
    if _case_kind == "piecewise":
        raw = _case_text
        args = dict(args)
        args["assumption"] = raw
        if _piecewise_covers_reals(_case_text, ctx) is False:
            return {
                "legit": "warn",
                "code": "piecewise_domain_gap",
                "detail": "分段条件没有覆盖完整实数域；请补充分支或明确函数定义域",
            }

    if _looks_like_matrix_input(raw, ctx):
        return _judge_matrix_step(args, ctx, raw, "assumption")

    _unsupported = _unsupported_latex_structure(raw)
    if _unsupported:
        return {
            "legit": "unknown",
            "code": "unsupported_expression",
            "detail": _unsupported,
        }

    # --- 轮次 X3：**微分式假设通道**（`dX=Y` / `dX=dY`）---
    #
    # ## 用户口径（原话）
    #   「在**假设前提块**中写 `dg=0` 相当于设定条件限制了 g 是一个确定的值，
    #     且和 `G=mg` 前提**并不冲突**，因为是限制了 g 的取值规则」
    #   「全部 pass（判据 = 约束集可满足；t / R,h 可被隐性钉死）」
    #
    # ## 为什么假设块与推导步的判据**不同**（关键）
    #   推导步是「由前提**推出**」→ 前提必须已把被微分量钉死（否则 fail）；
    #   假设块是「**新增一条声明**」→ 只要与已有前提**相容**即合法。
    #   这解释了用户的两个相反要求：
    #     推导链写 `dg=0`（前提 `G=mg`）→ **fail**（推不出）
    #     假设块写 `dg=0`（前提 `G=mg`）→ **pass**（声明，不冲突）
    #
    # ## 判据（用户裁定「可满足即 pass」）
    #   `dX=Y` 的语义是「X 的微分为 Y」，等价于「把 X 约束为常量」
    #   —— 这**总可以通过给 X 赋值来满足**（自由量会被隐性钉死），
    #   故只需排除「前提自身已矛盾」这一种情形：
    #     ① 已有前提自相矛盾 → conflict（阴性对照：`x=5` + `x=7`）
    #     ② 否则            → pass（本式作为新声明）
    #
    # ## 为什么**不**把微分式交给 `sp.solve`
    #   `d(·)` 不是可解表达式（无法作为 solve 的未知量），
    #   强行代入只会得到「解不出」的假阴性，与用户口径不符。
    _diff_assume = _normalize_diff_equation(raw)
    if _diff_assume is not None:
        _cf0, _msg0 = _check_premise_conflict(list(ctx.get("relations") or []))
        if _cf0:
            return {
                "legit": "conflict",
                "code": "premise_conflict",
                "detail": _msg0,
                "conflictPair": {
                    "scene": "已连线的既有前提",
                    "user": str(raw or "").strip(),
                },
            }
        return {
            "legit": "legit",
            "code": "differential_declared",
            "detail": "本步作为微分关系的新声明，与已有前提相容",
        }

    _assumption_norm = _latex_pre_normalize(str(raw or ""), ctx.get("funcParams"))
    _assumption_norm, _missing_prime_dependency = _normalize_bare_prime_derivatives(
        _assumption_norm, ctx
    )
    if _missing_prime_dependency is not None:
        return {
            "legit": "unknown",
            "code": "derivative_dependency_missing",
            "detail": (
                "无法确定 %s 的自变量；请声明函数签名或写出自变量"
                % _missing_prime_dependency
            ),
        }
    _assumption_norm = _normalize_notation(
        _assumption_norm, func_names=ctx.get("funcNames")
    )
    _assumption_norm, _missing_dep = _resolve_bare_derivative_from_relations(
        _assumption_norm, ctx
    )
    if _assumption_norm != raw:
        raw = _assumption_norm
        args = dict(args)
        args["assumption"] = raw
    if _missing_dep is not None:
        _dependent, _variable = _missing_dep
        return {
            "legit": "unknown",
            "code": "derivative_dependency_missing",
            "detail": (
                "无法确定 %s 是否是 %s 的函数；请在场景符号中声明函数签名，"
                "或写成 %s(%s) 后再求导"
                % (_dependent, _variable, _dependent, _variable)
            ),
        }

    # --- 轮次 X2 第 1 步修复：下标符号名回填（与 `cmd_session_step` 同口径）---
    # 理由见 `cmd_session_step` 内同名注释；假设节点同样是「用户书写」，
    # 若不在声明流程之前回填，`_auto_declare_symbols` 会把 `g0` 当新变量，
    # 使 `_restore_subscript_names` 的回填判据失效（实测确认）。
    _raw_restored = _restore_subscript_names(str(raw or ""), ctx["locals"])
    if _raw_restored != raw:
        raw = _raw_restored
        args = dict(args)
        args["assumption"] = raw

    # ❶❷❸：与 `_judge_atomic` 共用（顺序不可换，理由见 `_prepare_declarations`）
    ctx, _decl_err = _prepare_declarations(ctx, raw)
    if _decl_err is not None:
        return _decl_err

    try:
        assumption = _sympify_relation(raw, ctx["locals"], ctx.get("funcParams"))
    except Exception as e:  # noqa: BLE001
        return {"legit": "illegal", "code": "unparsable", "detail": str(e)}

    bad = _check_undeclared(assumption, ctx["declared"], ctx["funcNames"])
    if bad:
        return {"legit": "illegal", "code": "undeclared_symbol", "detail": bad}

    conflict, msg = _check_premise_conflict(list(ctx["relations"]) + [assumption])
    if conflict:
        return {
            "legit": "conflict",
            "code": "premise_conflict",
            "detail": msg,
            "conflictPair": {
                "scene": "已连线的既有前提",
                "user": str(raw or "").strip(),
            },
        }

    return {"legit": "legit", "code": "ok"}


def cmd_session_split(args) -> dict:
    """把前提包内容按分号切分并分类（供前端解构校验）。"""
    raw = args.get("display")
    locals_map = _compile_symbols(args.get("symbols"))
    entries = []
    for seg in _split_premise_entries(raw):
        entries.append({"display": seg, "kind": _classify_entry_kind(seg, locals_map)})
    return {"count": len(entries), "entries": entries}


def cmd_session_close(args) -> dict:
    """关闭会话，释放缓存。"""
    session_id = str(args.get("sessionId") or "").strip()
    _SESSIONS.pop(session_id, None)
    return {"ok": True}


# ==========================================================================
# 分发与主循环
# ==========================================================================

COMMANDS = {
    "ping": cmd_ping,
    "parse": cmd_parse,
    "verify_equiv": cmd_verify_equiv,
    "limit": cmd_limit,
    "check_units": cmd_check_units,
    "plot_data": cmd_plot_data,
    "substitute": cmd_substitute,
    "simplify": cmd_simplify,
    "solve_intersections": cmd_solve_intersections,
    "session_init": cmd_session_init,
    "session_step": cmd_session_step,
    "session_assume": cmd_session_assume,
    "session_split": cmd_session_split,
    "session_close": cmd_session_close,
}


def handle(req: dict) -> dict:
    """分发单条请求；永不抛异常（统一转为结构化错误）"""
    req_id = req.get("id", "")
    cmd = req.get("cmd")
    args = req.get("args") or {}

    if not isinstance(cmd, str) or cmd not in COMMANDS:
        return {"id": req_id, **_err("PROTOCOL_ERROR", f"未知命令：{cmd}")}

    try:
        result = COMMANDS[cmd](args)
        return {"id": req_id, "ok": True, "result": result}
    # 注意：这两个分支**必须**在 `except ValueError` 之前 ——
    # 二者都是 ValueError 的子类，顺序颠倒会被误转成 PARSE_ERROR，
    # 前端便无法区分「语法错」与「函数忘了声明 / 重复声明」。
    except _FunctionNotDeclared as e:
        # R8：未声明的函数被调用 → 专用错误码，前端据此引导「先声明」
        return {"id": req_id, **_err("FUNCTION_NOT_DECLARED", str(e))}
    except _FunctionRedefined as e:
        # R6：重复声明 → 专用错误码，前端据此提示「换个函数名」
        return {"id": req_id, **_err("FUNCTION_REDEFINED", str(e))}
    except ValueError as e:
        return {"id": req_id, **_err("PARSE_ERROR", str(e))}
    except Exception as e:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        return {"id": req_id, **_err("INTERNAL_ERROR", f"{type(e).__name__}: {e}")}


def main() -> None:
    """主循环：读一行 → 处理 → 写一行"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            # 无法解析的请求没有可靠 id，用空 id 返回
            resp = {"id": "", **_err("PROTOCOL_ERROR", f"请求不是合法 JSON：{e}")}
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()
            continue

        if not isinstance(req, dict):
            resp = {"id": "", **_err("PROTOCOL_ERROR", "请求必须是 JSON 对象")}
        else:
            resp = handle(req)

        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

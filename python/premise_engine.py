"""前提链判定核心（S4 数理场景）。

为什么独立成模块：本模块是「连线即前提」判定链的心脏，逻辑量较大。
独立后 sympy_server.py 只需薄委托，避免在 2900 行大文件里做大段替换。

**弃用 `sp.satisfiable` 的原因**（探针实测确认）：
  它把 `sqrt(c**2) - c != 0` 这类关系式当作**不可解释的原子命题**，
  不做代数化简，因此在 c>0 时也报「可满足」，使 `sqrt(c^2)=c` 被误判为
  illegal；同理 `x=1` 与 `x=2` 的蕴含、`2x+y=40` 推出 `y=40-2x` 也全部判不出。

现改为三层判据：
  1. **等式代入**：用 solve 逐个解出变量并代入，残差化简为 0 → 成立；
     残差为非零常数 → 确定不成立（前提自相矛盾也会在此暴露）。
  2. **数值采样**：在前提允许的取值上验证恒成立；按符号值域属性采样
     （positive → 正区间），使正值假设真正生效。
  3. **成比例同解**：移项 / 两边同乘同除（交给调用方注入的策略函数）。

工具函数通过**延迟导入** sympy_server 获得（运行时时主模块已加载完毕，
不会产生循环导入）。
"""

import random

import sympy as sp


def _sv():
    """延迟导入主模块（避免循环导入）。"""
    import sympy_server
    return sympy_server


def _structure():
    """延迟导入结构分析层（轮次 G 新增）。"""
    import premise_structure
    return premise_structure


# ---------------------------------------------------------------- 基础工具

def residual_of(rel):
    """关系式 → 残差表达式：Eq(l, r) → l - r；其它原样返回。"""
    if isinstance(rel, sp.Eq):
        return rel.lhs - rel.rhs
    return rel


def reduce_equalities(relations):
    """把等式前提逐个解出并代入。

    返回 (剩余条件, 代入表, 是否矛盾)。

    为什么逐个解而不是一次性 solve：多符号方程组常给出参数化解或直接放弃；
    逐个「挑一个符号解出并代入」更稳，且每步都能提前发现矛盾
    （如 `v=m+1` 与 `v=m-1` 代入后得常数 2 ≠ 0）。
    """
    others = []
    subs = {}
    for r in relations:
        if not isinstance(r, sp.Eq):
            others.append(r)
            continue
        try:
            e = sp.simplify(residual_of(r).subs(subs))
        except Exception:  # noqa: BLE001
            others.append(r)
            continue
        if e == 0:
            continue
        if not getattr(e, "free_symbols", None):
            return others, subs, True           # 常数 ≠ 0 → 前提矛盾
        solved = False
        for s in sorted(e.free_symbols, key=lambda z: str(z)):
            try:
                sol = sp.solve(e, s)
            except Exception:  # noqa: BLE001
                sol = []
            if len(sol) == 1:
                subs[s] = sol[0]
                solved = True
                break
        if not solved:
            others.append(e)                    # 解不出，留作待验证条件

    out = []
    for r in others:
        try:
            _v = sp.simplify(r.subs(subs)) if subs else r
        except Exception:  # noqa: BLE001
            out.append(r)
            continue
        # --- 轮次 S 修复（实测确认的既有缺陷）---
        #
        # 代入后**化简为 0** 的条件表示「该条件已被满足」，不得留作待验证条件。
        #
        # 为什么必须过滤（实测证据，`Eq(h²,h³)` ∧ `Eq(h,0)`）：
        #   `h²=h³` 是**含符号的等式**（解集 {0,1}），`reduce_equalities` 解不出
        #   唯一常数（`solve(h²-h³, h)` 返回两个根），于是把它作为残差
        #   `h²-h³` 留在 `others` 里；接着 `h=0` 解出 `subs={h: 0}`，回代后
        #   该残差化简为 **0** —— 说明它在 `h=0` 处**恰好成立**，前提是相容的。
        #   但旧实现把这个 `0` 原样放进 `out`，下游 `is_satisfiable` 用
        #   `holds(0)` 判真假，而 `bool(Integer(0))` 在 SymPy 里是 **False**
        #   （0 就是逻辑假）→ 判成「条件不成立」→ 误报前提矛盾。
        #   实测后果：`h=0` 在前提 `h²=h³` 下被判 `constraint_conflict`（应为 pass）。
        #
        # 为什么过滤而不是改 `holds()`（两者都会做，此处为主修）：
        #   残差归零在此处的**语义**就是「条件已满足」，本就不该进入待验证列表；
        #   过滤后列表语义变得干净（只留**尚未满足**的条件），
        #   与「不等式前提」的处理口径一致（恒真的不等式也不该留）。
        if _v == 0:
            continue
        out.append(_v)
    return out, subs, False


def holds(rel):
    """关系式在当前取值下的真假；True / False / None（无法判定）。

    --- 轮次 S 修正：**只接受关系式**，对裸表达式返回 None（实测确认的缺陷）---

    为什么必须区分（实测证据）：
        本函数原先对任意对象直接 `return bool(rel)`，而 Python/SymPy 的
        `bool(Integer(0))` 是 **False**、`bool(Integer(-4))` 是 **True`
        —— 于是**所有非零表达式都被当成「真」**。当调用方误把「残差表达式」
        （如 `h**2 - h**3` 代入后的 `0`）传进来时，会得到
        「残差为 0 → 条件不成立」的**反直觉结论**，导致前提被误报矛盾
        （实测：`h=0` 在前提 `h²=h³` 下被判 `constraint_conflict`）。

    为什么要保留对 `sp.true` / `sp.false` 的两条判断：
        SymPy 对**可当场判定的关系式**会直接求值成 Python 布尔
        （如正值符号下的 `Eq(sqrt(c**2), c)` → `True`），这两个值
        是**关系式判定结果**，语义正确，必须采信。

    为什么对 Expr 返回 None 而不是抛错：
        调用方（`is_satisfiable` 的 pending 循环）已按「None = 判不了、
        保守跳过」处理，返回 None 不会阻塞流程，也不会把未知误当已知。
    """
    try:
        if rel is sp.true:
            return True
        if rel is sp.false:
            return False
        # 只有关系式（Eq / Ne / Lt / Le / Gt / Ge / And / Or …）才做真值判定；
        # 裸表达式（Add / Mul / Pow …）无「真假」语义，返回 None 交调用方。
        if not getattr(rel, "is_Relational", False):
            return None
        return bool(rel)
    except Exception:  # noqa: BLE001
        return None


def sample_values(symbols, rng=None):
    """按符号值域属性采样（positive → 正区间，negative → 负区间）。"""
    rng = rng or random
    subs = {}
    for s in symbols:
        try:
            if getattr(s, "is_positive", False) is True:
                subs[s] = rng.uniform(0.2, 10.0)
            elif getattr(s, "is_negative", False) is True:
                subs[s] = -rng.uniform(0.2, 10.0)
            else:
                subs[s] = rng.uniform(-10.0, 10.0)
        except Exception:  # noqa: BLE001
            subs[s] = rng.uniform(-10.0, 10.0)
    return subs


def is_satisfiable(relations):
    """关系集是否可满足（等式代入 → 常量不等式判定 → 数值采样）。"""
    ineqs, _subs, conflict = reduce_equalities(relations)
    if conflict:
        return False
    pending = []
    for r in ineqs:
        if not getattr(r, "free_symbols", None):
            if holds(r) is False:
                return False
            continue
        pending.append(r)
    if not pending:
        return True
    free = set()
    for r in pending:
        free |= r.free_symbols
    free_sorted = sorted(free, key=lambda z: str(z))
    for _ in range(60):
        subs = sample_values(free_sorted)
        try:
            if all(holds(r.subs(subs)) is not False for r in pending):
                return True
        except Exception:  # noqa: BLE001
            continue
    return False


def check_division_safety(expr, relations):
    """检查分母是否可能为 0。

    规则（用户确认）：未声明定义域时符号默认覆盖整个实数轴，因此 `v/x`
    在 x 无约束时必须报「x 可能为 0」。
    判据：`分母 = 0` 与既有前提合取后仍可满足 ⟹ 存在使分母为 0 的取值。
    """
    sv = _sv()
    for d in sv._collect_denominators(expr):
        if not getattr(d, "free_symbols", None):
            continue
        try:
            rel = sp.Eq(d, 0)
        except Exception:  # noqa: BLE001
            continue
        if is_satisfiable(list(relations) + [rel]):
            return "division_by_zero"
    return None


def check_premise_conflict(relations):
    """前提集是否自相矛盾。返回 (是否冲突, 说明)。"""
    if not relations:
        return False, None
    if is_satisfiable(relations):
        return False, None
    return True, "前提条件互相矛盾，无法同时成立"


def scan_undeclared_funcs(raw, declared_names, func_names):
    """从**原文**扫描函数调用，找出**真正需要报错**的未声明函数名。

    --- 轮次 T 收窄（用户口径：「先算子 → 再函数 → 后变量」）---

    ## 为什么必须收窄（实测确认的误报）
    旧实现的正则是 `([A-Za-z_]\\w*)\\s*\\(` —— 只要「标识符 + 左括号」就报错。
    于是 `a(x+1)`（本意 `a` 乘以 `x+1`）被误报为「未定义的函数 a」，
    而按用户口径它应走**变量乘法**（`a`、`x` 都自动声明为变量）。

    ## 收窄后的判据（只报两类）
      ① `E(x)` 这类**内置常量名 + 括号**：语义歧义（`E(x)` 是 `exp(x)`
         还是函数 `E`？）。SymPy 会把 `E` 当自然常数并静默算出 `E*x`，
         属**静默错解**，必须报错要求用户改写。
      ② 其余情况**一律不报**，交给下游分层处理：
         - `a(x)`   → 自动声明为**函数**（`_auto_declare_symbols`）
         - `a(x+1)` → 自动声明为**变量** → 乘法 `a*(x+1)`
         - `f(2)`   → 由 **R8**（`_check_undeclared_func_call`）报错
           （数字实参只可能是「代入求值」，用户显然忘了先声明函数）

    ## 为什么算子（sqrt/sin/diff…）不报
    它们是**系统级隐藏前提**，永远可用（`_IMPLICIT_MUL_FUNCS`）。
    """
    import re
    sv = _sv()
    if not isinstance(raw, str):
        return None
    known = set(declared_names or []) | set(func_names or []) | set(sv._IMPLICIT_MUL_FUNCS)
    for m in re.finditer(r"([A-Za-z_]\w*)\s*\(", raw):
        name = m.group(1)
        if name in known:
            continue
        # --- 轮次 T 修订（用户口径）：**一律不报**，全交下游 ---
        # 原先对「内置常量名 + 括号」（如 `E(x)`）报错，理由是该写法有歧义。
        # 但用户已明确口径：
        #   「E 如果是内置的常量，`E(x)=1` 就相当于是在无前提条件下对 x
        #     变量声明并限制 `x=1/E` → **pass**」
        # 即 `E(x)` 本就该读作 `E*x`（自然常数 E 乘 x），不是歧义。
        # 故移除该分支，与用户口径一致。
    return None


def check_derivable_ex(relations, current):
    """结构化版本：在三态之外额外提供 warn 与原因码（轮次 G 新增）。

    为什么要单独出口：字符串三态无法表达「结论正确但有保留」这一类
    —— 可去奇点（约分隐含前提）、部分定义域（仅在区间上成立）。
    用户已确认这类应判 warn：既不误判为错，又能给出教学提示。

    返回 dict：verdict 属于 {legit, warn, illegal, unknown}，附 code / detail。
    """
    # 结构层能给出更精确的四态（含 warn）时优先采信
    try:
        if isinstance(current, sp.Eq):
            st = _structure().analyze_structure(relations, current)
            if st.get("verdict") in ("legit", "warn", "illegal"):
                return st
    except Exception:  # noqa: BLE001
        pass

    # 无前提：区分「孤立节点」与「判不了」——前者用户可去连线解决。
    # 不给这个区分，用户看到的是同一句「判不了」，无从知道该做什么。
    if not relations:
        return {"verdict": "unknown", "code": "no_premise", "detail": "本步没有可追溯的前提依据"}

    v = check_derivable(relations, current)
    if v == "legit":
        return {"verdict": "legit", "code": "ok", "detail": ""}
    if v == "illegal":
        return {"verdict": "illegal", "code": "not_derivable", "detail": "无法由前提推出"}

    # unknown：区分「确实判不了」与「缺符号信息」——后者可给出可执行指引。
    # 用户方案：缺信息就明说，不猜测（不用采样去凑结论）。
    try:
        miss = _structure().scan_missing_symbol_info(current)
    except Exception:  # noqa: BLE001
        miss = []
    if miss:
        return {
            "verdict": "unknown",
            "code": "missing_symbol_info",
            "detail": "需要知道 " + "、".join(miss) + " 的符号（正负）才能判定本步；"
                      "请在场景前提中说明，或新建一个假设节点。",
        }
    return {"verdict": "unknown", "code": "not_applicable", "detail": ""}


def check_derivable(relations, current):
    """判定当前结论能否由前提推出。返回 'legit' | 'illegal' | 'unknown'。

    判定阶梯（命中即返回；全不适用则 unknown → 上层回落参考解兜底）：
      A 等式同解：与某条前提等式相差非零常数倍（移项 / 两边同乘同除）
      B 等式代入：解出变量后代入，残差化简为 0
      C 微积分变形：一侧是导数/积分，求值后比对
      D 数值采样：在前提允许的取值上验证本步是否恒成立
    """
    sv = _sv()
    if not relations:
        return "unknown"

    # 布尔常量（实测缺陷）：`Eq(c, c)` 在 c 为正值时会被 SymPy **自动求值**
    # 为 True（因为 sqrt(c**2) 当场化简成 c），于是 current 不再是关系式对象。
    # 若不加此分支，这类「恒真变形」会因「非关系式」被判 unknown 而回落参考解，
    # 使正确推导得不到前提链背书（探针 G1 实测）。
    if current is sp.true:
        return "legit"
    if current is sp.false:
        return "illegal"

    # 裸表达式无法判断真假（它是在回答「等于多少」，需要参考解兜底）
    if not getattr(current, "is_Relational", False):
        return "unknown"

    # --- A：等式同解（成比例）---
    if isinstance(current, sp.Eq):
        try:
            du = sp.together(residual_of(current))
        except Exception:  # noqa: BLE001
            du = None
        if du is not None and du.free_symbols:
            for r in relations:
                if not isinstance(r, sp.Eq):
                    continue
                try:
                    de = sp.together(residual_of(r))
                    if sv._strategy_eq_proportional(du, de, True, True) is True:
                        return "legit"
                except Exception:  # noqa: BLE001
                    continue

    # --- B：等式代入化简 ---
    ineqs, subs, conflict = reduce_equalities(relations)
    if conflict:
        return "illegal"          # 前提自身矛盾 → 本步不成立

    res = None
    try:
        base = residual_of(current)
        res = sp.simplify(base.subs(subs)) if subs else sp.simplify(base)
    except Exception:  # noqa: BLE001
        res = None

    if res is not None:
        try:
            if res == 0:
                return "legit"
        except Exception:  # noqa: BLE001
            pass
        # 残差是非零**常数** → 确定不成立（如 1=2、前提 x=1 下的 x=2）
        if not getattr(res, "free_symbols", None):
            try:
                if res != 0:
                    return "illegal"
            except Exception:  # noqa: BLE001
                pass

    # --- C：微积分变形 ---
    if isinstance(current, sp.Eq):
        try:
            l0 = sv._substitute_function_defs(current.lhs, relations)
            r0 = sv._substitute_function_defs(current.rhs, relations)
            l1, ch1 = sv._eval_calculus(l0)
            r1, ch2 = sv._eval_calculus(r0)
            if (ch1 or ch2) and sp.simplify(l1 - r1) == 0:
                return "legit"
        except Exception:  # noqa: BLE001
            pass

    # --- C2：结构分析（轮次 G 新增）---
    # 为什么必须在采样之前：采样测的是「点」，而差异可能只出现在**单点**上
    # （如 x**2/x 与 x 仅在 x=0 不同）。采样命中该点的概率为 0，必然漏判。
    # 结构分析用集合运算（奇点集/零点集/极限），能精确定位这类差异。
    try:
        _st = _structure().analyze_structure(relations, current)
        if _st.get("verdict") == "legit":
            return "legit"
        if _st.get("verdict") == "illegal":
            return "illegal"
        # warn（可去奇点 / 部分定义域）：结论正确但有保留。
        # 旧字符串口径只有三态，warn 归为 unknown 交上层（结构化出口另处理）。
    except Exception:  # noqa: BLE001
        pass

    # 缺符号信息优先于采样（实测缺陷 G2）：`sqrt(c**2) = c` 在 c 符号未知时，
    # 采样会撒到负值、拿到反例并判 illegal —— 但真实原因是「缺信息」而非「推导错」。
    # 报「错」会让用户去改一个本来正确的式子，方向完全错了。
    try:
        _miss = _structure().scan_missing_symbol_info(current)
    except Exception:  # noqa: BLE001
        _miss = []
    if _miss:
        return "unknown"

    # --- D：数值采样 ---
    if res is None:
        return "unknown"
    free = set(res.free_symbols)
    for r in ineqs:
        free |= getattr(r, "free_symbols", set())
    if not free:
        return "unknown"
    free_sorted = sorted(free, key=lambda z: str(z))

    valid = 0
    for _ in range(120):
        point = sample_values(free_sorted)
        # 前提中的条件必须成立，否则该采样点不在前提允许的范围内
        try:
            if any(holds(r.subs(point)) is False for r in ineqs):
                continue
        except Exception:  # noqa: BLE001
            continue
        try:
            val = complex(res.subs(point).evalf())
        except Exception:  # noqa: BLE001
            continue
        if val.imag != 0 or val.real != val.real or abs(val.real) == float("inf"):
            continue
        valid += 1
        if abs(val.real) > 1e-6:
            # 找到反例 → 确定不成立。**证伪是可靠的**（有反例就是错）。
            return "illegal"
    if valid == 0:
        return "unknown"

    # 采样全过 → **不判 legit**（轮次 G，用户确认）。
    #
    # 为什么（用户提出的关键缺陷）：采样是**归纳**而非证明 ——
    # 差异可能只出现在采样范围之外，或只出现在单个测度为零的点上。
    # 把「没发现问题」当成「确认正确」会产生假阳性。
    # 故降级为 unknown，交上层回落参考解比对或提示用户补充信息。
    #
    # 注意：结构分析（C2 层）已在采样之前处理了单点差异类问题，
    # 因此走到这里的多是「确实无法定论」的情形。
    return "unknown"

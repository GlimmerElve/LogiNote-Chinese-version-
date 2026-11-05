"""前提链判定的「结构分析」层（轮次 G 新增）。

为什么需要独立一层：数值采样测的是**点**，而两个表达式的差异可能只出现在
**单点**上。典型例子：

    sin(x) / x   与   1

仅在 x=0 处不同（前者无定义）。采样在连续统上命中该点的概率为 0，必然把
「不等」判成「相等」—— 这不是采样点不够多，而是方法**原理上的盲区**。

本模块用全局结构工具（均为确定性集合运算，非归纳）替代点测试：

    sp.singularities  奇点集比对   → 精确定位单点差异
    sp.solveset       解集求解     → 解集为空则无解；非空则有解
    sp.linsolve       方程组求解   → 多变量情形的公共解存在性

**核心判据（轮次 M，用户用 23 个判定用例反推并逐例确认）**：

    等式的本质是**约束**（限制变量取值），不是「恒等式」。
    判据 = 「解集 ∩ 前提取值范围 ≠ ∅」——**有交集即成立**。

用户确认的四处口径：
    1. 解集与前提取值域**有交集** → 成立（`sin(x)=0.5` 在 `x>0` 下属此）
    2. **可去奇点**（约分场景）→ 判 warn；前提已排除该点则不再提示
    3. 缺符号信息时**优先给出可执行指引**，而非笼统的区间提示
    4. 未连线（无前提）时同样按「解集非空即有解」判定，**不比对题目**
"""

import sympy as sp


def _ok(verdict, code, detail=""):
    """构造结构化判定结果。"""
    return {"verdict": verdict, "code": code, "detail": detail}


def _singularities_of(expr, sym):
    """表达式的奇点集（单变量）。无法判定返回 None。"""
    try:
        s = sp.singularities(expr, sym)
    except Exception:  # noqa: BLE001
        return None
    if s is None:
        return None
    try:
        if s is sp.S.EmptySet:
            return set()
        return set(s)
    except Exception:  # noqa: BLE001
        return None


def _limit_finite(expr, sym, point):
    """在该点处的极限是否存在且有限。None 表示判不出。"""
    try:
        lim = sp.limit(expr, sym, point)
    except Exception:  # noqa: BLE001
        return None
    try:
        if lim in (sp.nan, sp.zoo, sp.oo, -sp.oo):
            return False
        return lim.is_finite is not False
    except Exception:  # noqa: BLE001
        return None


def _premise_domain(relations, sym):
    """把前提中的不等式汇总为该符号的取值集合。

    **按名匹配**（轮次 M 修复的隐患）：
        `_prepare_sides` 会把符号替换成带 positive / nonnegative /
        negative 属性的**新 Symbol 对象**，与前提里原有的对象不再是同一实例。
        若用 `sym not in r.free_symbols` 判断，会误判「该符号不在关系式中」
        而直接返回 ℝ —— 前提约束**静默失效**（实测风险）。
        故改为按**符号名**匹配，并用关系式里**真实的那个符号对象**去求解
        （不能拿新符号去解旧关系式，那样 SymPy 认为无关）。
    """
    name = str(sym)
    domain = sp.S.Reals
    excluded = []
    for r in relations or []:
        try:
            if not getattr(r, "is_Relational", False) or isinstance(r, sp.Eq):
                continue
            target = None
            for s in getattr(r, "free_symbols", set()):
                if str(s) == name:
                    target = s
                    break
            if target is None:
                continue
            # `x≠1`（Ne）：**从定义域中挖掉该点**（轮次 M 新增，第 19 例必需）。
            # 为什么单列一支：`solve_univariate_inequality` 对 Ne 支持很差
            # （它不是「区间」语义，而是「补集」语义），直接调用会失败并被
            # 上面的 except 吞掉，导致 `x≠1` 这个前提**静默失效**。
            if isinstance(r, sp.Ne):
                try:
                    pts = sp.solve(r.lhs - r.rhs, target)
                    if isinstance(pts, list):
                        excluded.extend(pts)
                except Exception:  # noqa: BLE001
                    pass
                continue
            sub = sp.solve_univariate_inequality(r, target, relational=False)
            domain = sp.Intersection(domain, sub)
        except Exception:  # noqa: BLE001
            continue
    if excluded:
        try:
            domain = sp.Intersection(domain, sp.Complement(sp.S.Reals, sp.FiniteSet(*excluded)))
        except Exception:  # noqa: BLE001
            pass
    return domain


def pinned_conflict(relations):
    """等式把某符号**钉死为常数**后，是否使其他关系式变成确定假值。

    为什么需要（第 23 例实测缺陷）：
        `x=-1` 与前提 `x>0` 显然矛盾，但既有 `premise_engine` 的冲突检查
        未能发现（实测：判成 legit）。此处做**确定性的**代入检查：
        `x>0` 代入 x=-1 得 `-1 > 0` → `sp.false` → 确定矛盾。

    只认「一侧是裸符号、另一侧无自由符号」的等式（真正的定值指派），
    且只依据**求值为 False** 判否 —— 求值为 True / 无法求值一律不判，
    宁可漏判不可误判。

    返回 (是否冲突, 说明)。
    """
    pinned = {}
    for r in relations or []:
        try:
            if not isinstance(r, sp.Eq):
                continue
            for side, other in ((r.lhs, r.rhs), (r.rhs, r.lhs)):
                if isinstance(side, sp.Symbol) and not other.free_symbols:
                    pinned.setdefault(side, other)
        except Exception:  # noqa: BLE001
            continue
    if not pinned:
        return False, ""
    for r in relations or []:
        try:
            if isinstance(r, sp.Eq) and r.lhs in pinned and r.rhs in pinned:
                continue          # 该等式本身就是钉死项，跳过
            v = r.subs(pinned)
            if v is sp.false:
                return True, "取值被钉死后与既有前提矛盾"
            if getattr(v, "is_Relational", False) and v is sp.false:
                return True, "取值被钉死后与既有前提矛盾"
        except Exception:  # noqa: BLE001
            continue
    return False, ""


def _domain_fixes_sign(dom, sym):
    """前提定义域是否已足以确定该符号的符号（非负 / 非正）。

    为什么需要（实测缺陷）：sqrt(x**2) = x 在数学上需要「x 非负」。
    若题目已经给了 x >= 0，那本步毫无问题，不该再报「缺符号信息」——
    否则用户会收到一条他早已满足的要求，既困惑又显得系统没读懂题目。

    判据：把定义域分别与负半轴、正半轴求交，若其中一个为空，
    说明该符号的符号已确定。
    """
    try:
        if dom is sp.S.Reals:
            return False
        try:
            neg = sp.Intersection(dom, sp.Interval(-sp.oo, 0, True, True))
            if neg is sp.S.EmptySet:
                return True        # 不可能为负 → 非负
        except Exception:  # noqa: BLE001
            pass
        try:
            pos = sp.Intersection(dom, sp.Interval(0, sp.oo, True, True))
            if pos is sp.S.EmptySet:
                return True        # 不可能为正 → 非正
        except Exception:  # noqa: BLE001
            pass
    except Exception:  # noqa: BLE001
        return False
    return False


def _set_nonempty(s):
    """集合是否**确定非空**。None 表示判不出。"""
    if s is None:
        return None
    try:
        if s is sp.S.EmptySet:
            return False
        if s.is_empty is True:
            return False
        if s.is_empty is False:
            return True
    except Exception:  # noqa: BLE001
        pass
    # 具体集合形态（有元素的区间 / 有限集 / 并 / 像集）视为非空
    try:
        if isinstance(s, sp.FiniteSet):
            return len(s.args) > 0
        if isinstance(s, sp.Interval):
            lo, hi = s.start, s.end
            if lo == hi and (s.left_open or s.right_open):
                return False
            return True
        # ImageSet（参量映射的像，如 `{π/6+2nπ}`）
        # **视为非空**（轮次 M 修复，第 10 例必需）：
        #   它是某个 λ 映射在参量集上的像 —— 参量集（通常为整数集）非空
        #   且映射有定义，故像集非空。这正是「sin(x)=0.5 有解」的表达。
        #   不补这一支时它返回 None，导致无连线的 `sin(x)=0.5` 落到
        #   「结构分析未能定论」→ unknown（实测：期望 pass）。
        if isinstance(s, sp.ImageSet):
            return True
        if isinstance(s, sp.Union):
            for a in s.args:
                if _set_nonempty(a) is True:
                    return True
            return None
    except Exception:  # noqa: BLE001
        pass
    return None


def _image_set_has_point_in(sol, domain, depth=0):
    """ImageSet / Union 是否在 domain 内**存在取值**（枚举参量检验）。

    为什么需要（实测缺口）：`sin(x)=0.5` 的解集是 ImageSet
    （`{π/6+2nπ} ∪ {5π/6+2nπ}`），`sp.Intersection` 对它常算不出，
    会落到 unknown —— 而用户口径要求「与前提域有交集即成立」，
    故必须给出确定结论。ImageSet 的参量是整数，枚举若干取值
    即可**确定性地**找到域内的点（找到即证有交集）。

    返回 True（找到域内点）/ None（没找到，不构成否证）。
    """
    if depth > 4:
        return None
    try:
        if isinstance(sol, sp.Union):
            for a in sol.args:
                if _image_set_has_point_in(a, domain, depth + 1) is True:
                    return True
            return None
        if isinstance(sol, sp.ImageSet):
            lam = sol.lamda
            base = sol.base_sets[0] if sol.base_sets else sp.S.Integers
            # 枚举参量：周期性集合取 0, ±1, ±2 ... 若干档即可覆盖域内点
            for n in (0, 1, -1, 2, -2, 3, -3, 4, -4):
                try:
                    if base is sp.S.Integers:
                        val = lam(n)
                    else:
                        # 非整数集（罕见）：只在 n=0 试探
                        val = lam(0) if n == 0 else None
                    if val is None:
                        continue
                    if sp.N(val).is_real is False:
                        continue
                except Exception:  # noqa: BLE001
                    continue
                try:
                    probe = sp.Intersection(sp.FiniteSet(val), domain)
                    if probe is not sp.S.EmptySet and probe.args:
                        return True
                except Exception:  # noqa: BLE001
                    # 求交失败 → 退化为「数值区间比较」
                    try:
                        v = float(sp.N(val))
                        pis = _iter_intervals(domain)
                        for p in pis:
                            lo = float(p.start) if p.start != -sp.oo else -1e308
                            hi = float(p.end) if p.end != sp.oo else 1e308
                            if lo <= v <= hi:
                                return True
                    except Exception:  # noqa: BLE001
                        continue
            return None
    except Exception:  # noqa: BLE001
        return None
    return None


def _intersect_nonempty(sol, domain):
    """解集与前提取值域是否**有交集**（轮次 M：用户确认口径的核心判据）。

    用户口径（已用 23 用例反推并逐例验证）：等式的本质是**约束**
    （限制变量取值），不是「恒等式」。判据是「解集 ∩ 前提域 ≠ ∅」。

    返回 True（有交集）/ False（无交集）/ None（判不出）。

    实现三级（命中即返回）：
      ① `sp.Intersection` 直接求交 —— 区间/有限集等具体形态可定论
      ② 反向检验：解集与「前提域的补集」无交 → 解集整体落在域内 → 有交集
      ③ ImageSet 参量枚举（见 `_image_set_has_point_in`）
    """
    if sol is None:
        return None
    try:
        if sol is sp.S.EmptySet:
            return False
    except Exception:  # noqa: BLE001
        pass

    # ① 直接求交
    try:
        inter = sp.Intersection(sol, domain)
        nz = _set_nonempty(inter)
        if nz is False:
            return False
        if nz is True and not isinstance(inter, sp.Intersection):
            return True
    except Exception:  # noqa: BLE001
        pass

    # ② 反向：解集 ⊆ 前提域（与域补集无交）→ 有交集
    try:
        comp = sp.Complement(sp.S.Reals, domain)
        if _set_nonempty(comp) is False:
            # domain = ℝ：解集非空即「有交集」
            return _set_nonempty(sol)
        outside = sp.Intersection(sol, comp)
        if _set_nonempty(outside) is False:
            return _set_nonempty(sol)
    except Exception:  # noqa: BLE001
        pass

    # ③ ImageSet / Union 参量枚举
    got = _image_set_has_point_in(sol, domain)
    if got is True:
        return True

    return None


def _iter_intervals(dom):
    """把集合展开为 Interval 列表（支持 Interval / Union / Intersection）。

    为什么需要（轮次 K）：前提定义域与解集都可能是**多个区间的并**
    （如 `x<0 or x>2`），而端点提取与逐段比对都要求先拿到单区间。
    """
    out = []
    try:
        if isinstance(dom, sp.Interval):
            out.append(dom)
        elif isinstance(dom, (sp.Union, sp.Intersection)):
            for a in dom.args:
                out.extend(_iter_intervals(a))
    except Exception:  # noqa: BLE001
        pass
    return out


# 轮次 M 移除 `_limit_candidates` / `_check_limits`（用户口径确认后废弃）：
#
# 为什么移除（实测 + 用户判定双重否决）：
#   用户口径（23 用例反推，逐例确认）明确：等式的本质是**约束**，
#   判据是「解集 ∩ 前提域 ≠ ∅」。极限比对与这条判据**方向不同** ——
#   它比较的是「两侧函数是否恒等」，属**恒等式**判据。
#   实测后果：`sin(x)=0.5` 在 x→±∞ 无极限（SymPy 返回 AccumBounds(-1,1)），
#   被本策略当成确定数值比较 → 误判 illegal；而用户明确判定该式为 **pass**
#   （解集与前提域有交集即成立）。故彻底移除，避免误判。
#
#   `sin(x)=2` 这类**无解**情形由 `_check_ranges`（值域无交集）与
#   `solveset` 返回 EmptySet 两条路径覆盖，能力不损失。


def _multivar_solution_status(relations, current, syms):
    """多变量：本步与前提是否**存在公共解**（轮次 M 新增）。

    为什么需要：`solveset` 是单变量工具。多变量情形（鸡兔同笼 `x+y=35`）
    原先直接返回 unknown，导致用户明确要求判 pass 的用例（#1 `x+y=35`、
    #2 `x+y=36`、#9 引用 given）全部落到「判不了」。
    用户口径「有交集即成立」在多变量下等价于「方程组有公共解」。

    实现（保守，只做**确定性**判定）：
      - 汇总所有**等式**为方程组，用 `sp.linsolve` 求解（线性系统可靠）
      - 返回 EmptySet    → 无公共解 → False（矛盾）
      - 返回具体解元组    → 再用不等式逐个筛选 → True / False
      - 非有限解集 / 求解失败 → None（交上层，不强行结论）

    为什么**只认线性**（关键）：非线性方程组的 `sp.solve` 在「解不出」时
    也返回 `[]`，与「确实无解」无法区分 —— 据此判否会误伤正确写法。
    宁可 unknown，不可误判。
    """
    eqs, ineqs = [], []
    for r in list(relations or []) + [current]:
        try:
            if isinstance(r, sp.Eq):
                e = sp.simplify(r.lhs - r.rhs)
                if e != 0:
                    eqs.append(e)
            elif getattr(r, "is_Relational", False):
                ineqs.append(r)
        except Exception:  # noqa: BLE001
            continue
    if not eqs:
        return None
    try:
        ls = sp.linsolve(eqs, syms)
    except Exception:  # noqa: BLE001
        return None

    # 求解失败（非有限解集）→ 判不出
    try:
        if ls is sp.S.EmptySet:
            return False
        if not isinstance(ls, sp.FiniteSet) or len(ls) == 0:
            return None
    except Exception:  # noqa: BLE001
        return None

    if not ineqs:
        return True      # 方程组有解，且无不等式约束 → 有公共解

    # 有不等式：逐个检查解元组能否满足（任一满足即有交集）
    for tup in ls:
        try:
            subs = dict(zip(syms, tup))
        except Exception:  # noqa: BLE001
            return None
        ok = True
        for ineq in ineqs:
            try:
                v = ineq.subs(subs)
                if v is sp.true:
                    continue
                if getattr(v, "free_symbols", None):
                    # 解含自由参量 → 该不等式的真假取决于参量，判不出
                    return None
                ok = False
                break
            except Exception:  # noqa: BLE001
                return None
        if ok:
            return True
    return False         # 方程有解，但全部被不等式排除 → 矛盾


def _check_ranges(lhs, rhs, sym, relations):
    """值域比对（**反证法**，轮次 K 新增）：两侧值域无交集 → 必然不等。

    为什么有效：值域是「函数能取到的全部值」的集合，与化简能力无关。
    典型用例 `sin(x) = 2` —— 左侧值域 [-1,1]、右侧 {2}，交集为空，
    无论 simplify 能否推动都可断定无解。这类「量纲式错误」
    正是化简器最不擅长、而集合运算一眼可辨的情形。

    口径（用户确认）：与「解集 vs 前提定义域」是两种不同比对，两者都要 ——
      前者比较**解集与前提**（见 `_check_interval_against_premises`），
      本函数比较**两侧函数值域**。

    安全边界：只有两侧值域都**算得出**（非 ConditionSet）**且交集为空**才判否；
    算不出、或有交集，一律返回 None（有交集不构成等价证据，故不判 legit）。

    返回 dict（illegal）或 None。
    """
    try:
        from sympy.calculus.util import function_range
    except Exception:  # noqa: BLE001
        return None

    try:
        dom = _premise_domain(relations, sym)
    except Exception:  # noqa: BLE001
        dom = sp.S.Reals
    if not isinstance(dom, sp.Set):
        dom = sp.S.Reals

    try:
        rl = function_range(lhs, sym, dom)
        rr = function_range(rhs, sym, dom)
    except Exception:  # noqa: BLE001
        return None

    # ConditionSet 表示「算不出」，不可据此判否
    try:
        if isinstance(rl, sp.ConditionSet) or isinstance(rr, sp.ConditionSet):
            return None
    except Exception:  # noqa: BLE001
        return None

    try:
        inter = sp.Intersection(rl, rr)
    except Exception:  # noqa: BLE001
        return None

    try:
        if inter is sp.S.EmptySet:
            return _ok(
                "illegal",
                "range_mismatch",
                "两侧值域无交集（左侧 {}，右侧 {}），等式不可能成立".format(rl, rr),
            )
    except Exception:  # noqa: BLE001
        return None
    return None


def scan_missing_symbol_info(current):
    """检测「因缺符号信息而无法化简」的典型痕迹。

    背景（用户方案）：SymPy 卡住时**不会**说明原因。若一律报「缺定义域」，
    会把「化简器能力不足」误报成「缺信息」，给出无效指引。

    故只检测有明确特征的残留形式：
        sqrt(c**2) 未化简    → 引擎不知道 c 的正负
        Abs(c) 未消掉        → 同上
    这些形式的存在是「需要符号信息」的**强信号**，不是猜测。

    返回需要补充信息的符号名列表（可能为空）。
    """
    suspects = []
    try:
        lhs = current.lhs
        rhs = current.rhs
    except Exception:  # noqa: BLE001
        return suspects

    for side in (lhs, rhs):
        try:
            # 未化简的 sqrt(幂) 形式：Pow(底, 1/2) 且底本身是偶次幂
            for pw in side.atoms(sp.Pow):
                base, expo = pw.as_base_exp()
                try:
                    is_half = sp.simplify(expo - sp.Rational(1, 2)) == 0
                except Exception:  # noqa: BLE001
                    is_half = False
                if not is_half:
                    continue
                if base.is_Pow and base.exp % 2 == 0:
                    suspects.extend(str(s) for s in sorted(base.base.free_symbols, key=str))
            # 未消掉的绝对值
            for ab in side.atoms(sp.Abs):
                suspects.extend(str(s) for s in sorted(ab.free_symbols, key=str))
        except Exception:  # noqa: BLE001
            continue

    # 去重保序
    out = []
    for s in suspects:
        if s not in out:
            out.append(s)
    return out


def _prepare_sides(relations, lhs, rhs):
    """把前提施加到两侧：等式代入 + 不等号转符号属性。

    分两步（顺序不可颠倒）：

    **① 等式代入**（端到端测试抓到的缺陷）
        前提 `x=1` 下 `2*x=2` 是正确推导；但若不代入前提，单独看 `2x=2`
        的解集是 `{1}`（有限点集），会被误判为 illegal。
        前提链语义是「能否由前提推出」，故必须让已确定的事实参与判定。

    **② 不等号 → 符号属性**（复杂用例探针抓到的缺陷）
        前提 `c > 0` 时 `sqrt(c**2)` 应能化简为 `c`；但不等式前提本身
        不改变 Symbol 的假设，SymPy 仍视 c 为「符号未知」，化简卡住。
        故检出后用带 positive / nonnegative / negative 属性的新符号替换。

    注意：替换出的**新 Symbol 对象**与原来的不再是同一实例，因此后续
    `sp.limit` / `sp.solveset` 必须使用**替换后**的表达式与符号名（按名匹配）。
    """
    # ① 等式代入
    subs = {}
    for r in relations or []:
        if not isinstance(r, sp.Eq):
            continue
        try:
            e = sp.simplify((r.lhs - r.rhs).subs(subs))
            if e == 0:
                continue
            for s in sorted(e.free_symbols, key=lambda z: str(z)):
                try:
                    sol = sp.solve(e, s)
                except Exception:  # noqa: BLE001
                    sol = []
                if len(sol) == 1:
                    subs[s] = sol[0]
                    break
        except Exception:  # noqa: BLE001
            continue
    if subs:
        try:
            lhs, rhs = lhs.subs(subs), rhs.subs(subs)
        except Exception:  # noqa: BLE001
            pass

    # ② 不等号 → 符号属性
    attrs = {}
    for r in relations or []:
        try:
            if getattr(r, "rhs", None) != 0:
                continue
            s0 = getattr(r, "lhs", None)
            if not getattr(s0, "is_Symbol", False):
                continue
            if isinstance(r, sp.Gt):
                attrs[s0.name] = "positive"
            elif isinstance(r, sp.Ge):
                attrs[s0.name] = "nonnegative"
            elif isinstance(r, sp.Lt):
                attrs[s0.name] = "negative"
        except Exception:  # noqa: BLE001
            continue
    if attrs:
        repl = {}
        for s0 in (lhs.free_symbols | rhs.free_symbols):
            k = attrs.get(s0.name)
            if k == "positive":
                repl[s0] = sp.Symbol(s0.name, positive=True)
            elif k == "nonnegative":
                repl[s0] = sp.Symbol(s0.name, nonnegative=True)
            elif k == "negative":
                repl[s0] = sp.Symbol(s0.name, negative=True)
        if repl:
            try:
                lhs, rhs = lhs.subs(repl), rhs.subs(repl)
            except Exception:  # noqa: BLE001
                pass

    return lhs, rhs


def _check_singularities(lhs, rhs, sym, domain=None):
    """奇点集比对：区分「可去奇点」与「真奇点」。

    **必须早于「残差化简为 0」的判定**（复杂用例探针抓到的真实缺陷）：
        `(x**2-1)/(x-1) = x+1` 的残差 simplify 后为 0，若先判「化简后相同」
        就直接返回 legit，**永远走不到奇点检查** —— 而该式在 x=1 处左侧
        无定义，按用户确认口径应判 warn（可去奇点）。
        奇点比对查的是「两侧定义域」，与化简能力无关，故必须前置。

    三态返回 dict 或 None（None = 无奇点差异，交后续判定）。

    判定口径（**必须比较两侧极限**，而非只看「有定义的一侧」）：
        两侧极限都存在且相等 → 可去奇点 → warn（约分隐含前提）
        任一侧极限不存在     → 该点行为根本不同 → illegal
        两侧极限都存在但不等 → 该点取值不同     → illegal

    为什么不能只看有定义侧（实测缺陷）：`1/x = 0` 中，0 的极限恒存在
    （就是 0），若只检查它便判 warn；而 1/x 在 x=0 的极限是 ∞（不存在）
    —— 两式行为完全不同，应判 illegal。

    **前提域过滤（轮次 M，用户确认口径第 19 例）**：
        `(x^2-1)/(x-1) = x+1` 在无前提时判 warn（约分隐含 x≠1）；
        但若前提**已声明 x≠1**，则该点根本不在讨论范围内 → 判 pass（None）。
        故差异点若不被前提域包含，直接跳过、不参与判定。
    """
    sl = _singularities_of(lhs, sym)
    sr = _singularities_of(rhs, sym)
    if sl is None or sr is None or sl == sr:
        return None

    # 关键：区分「差异点被前提全部排除」与「差异点存在但判不出」。
    #   前者 → 该处差异不在讨论范围内，**交后续判定**（返回 None）
    #   后者 → 本层判不出（返回 unknown）
    # 为什么必须区分（第 19 例实测）：`(x²-1)/(x-1)=x+1` 在前提 `x≠1` 下，
    # 唯一差异点 1 被排除 → 应继续走到「残差化简为 0」→ 判 pass；
    # 若此处直接返回 unknown，正确结论就被「判不了」盖掉了。
    _skipped = 0
    _total = 0
    for pt in sorted((sl - sr) | (sr - sl), key=str):
        _total += 1
        # 前提已排除该点 → 该处差异不在讨论范围内
        if domain is not None:
            try:
                probe = sp.Intersection(sp.FiniteSet(pt), domain)
                if probe is sp.S.EmptySet:
                    _skipped += 1
                    continue
            except Exception:  # noqa: BLE001
                pass

        lim_l = _limit_finite(lhs, sym, pt)
        lim_r = _limit_finite(rhs, sym, pt)
        if lim_l is False or lim_r is False:
            return _ok(
                "illegal",
                "singularity_mismatch",
                "{}={} 处一侧无定义且极限不存在，两式不相等".format(sym, pt),
            )
        if lim_l is True and lim_r is True:
            try:
                same = sp.simplify(
                    sp.limit(lhs, sym, pt) - sp.limit(rhs, sym, pt)
                ) == 0
            except Exception:  # noqa: BLE001
                continue
            if not same:
                return _ok(
                    "illegal",
                    "singularity_mismatch",
                    "{}={} 处两式取值不同，不相等".format(sym, pt),
                )
            # 可去奇点：结论正确，但约分隐含「该点除外」的前提
            # 用户确认口径：判 warn（不误判为错，又有教学提示价值）
            return _ok(
                "warn",
                "removable_singularity",
                "{}={} 处一侧原式无定义（该点极限存在），"
                "约分/化简隐含了「{}≠{}」的前提".format(sym, pt, sym, pt),
            )

    # 到这里说明：差异点全部被判不出（或全部被前提排除）。
    #   - 全被前提排除 → 该差异不在讨论范围内 → 交后续判定（None）
    #   - 存在判不出的点 → 本层无法定论（unknown）
    if _total > 0 and _skipped == _total:
        return None
    # 差异点的极限都判不出 → 交回上层，不强行结论
    return _ok("unknown", "not_applicable", "奇点处行为无法判定")


def analyze_structure(relations, current):
    """结构分析（轮次 G）：用集合比对替代点采样。

    返回 dict（verdict / code / detail）：
        legit   确定成立
        warn    成立但有保留（可去奇点 / 部分定义域）
        illegal 确定不成立
        unknown 本层不适用（多变量 / 超越方程等），交上层采样继续

    判定顺序（顺序本身即正确性的一部分，见各段注释）：
        0 布尔常量 → 1 前提施加 → 2 奇点集比对（按前提域过滤）
        → 3 残差为 0 → 4 常量残差 → 4c 值域比对
        → 5 解集 ∩ 前提域（单变量）/ 公共解（多变量）
        → 6 缺符号信息（仅当上一步判不出时提示）

    为什么顺序如此（轮次 M 重构，用户 23 用例确认）：
      - 0/3/4 是**最强结论**（残差恒等 / 相差非零常数），无条件优先。
      - 2 奇点比对必须早于 3：`(x²-1)/(x-1)=x+1` 残差化简为 0，
        若不前置就永远走不到奇点检查（实测确认的缺陷）。
      - 4c 值域无交集 → 必然无解，是廉价快路径（`sin(x)=2`）。
      - 5 是**核心判据**：解集与前提取值域有交集即成立。
        单变量用 solveset；多变量用 linsolve（鸡兔同笼等）。
      - 6 最后才提示缺符号信息 —— 能定论时不该退回「判不了」。
    """
    # ---- 0 布尔常量（实测缺陷）：SymPy 常把 Eq 当场求值 ----
    # Eq(x,x) 判 True；Eq(x+1, x+2) 差恒为 -1 判 False。两者都不再是 Eq 对象，
    # 若不处理就退回 unknown，明明可定论却放弃。
    if current is sp.true:
        return _ok("legit", "ok", "两侧化简后恒等")
    if current is sp.false:
        return _ok("illegal", "not_derivable", "两侧相差非零常数，不相等")

    if not isinstance(current, sp.Eq):
        return _ok("unknown", "not_applicable", "非等式")

    try:
        lhs = current.lhs
        rhs = current.rhs
    except Exception:  # noqa: BLE001
        return _ok("unknown", "not_applicable", "无法取等式两侧")

    # ---- 1 前提施加（等式代入 + 不等号转属性）----
    lhs, rhs = _prepare_sides(relations, lhs, rhs)

    # 单变量前提：solveset / singularities 均为单变量工具
    syms = sorted(lhs.free_symbols | rhs.free_symbols, key=lambda z: str(z))

    # ---- 2 奇点集比对（必须早于「残差为 0」）----
    if len(syms) == 1:
        # 传入前提域：前提若已排除该奇点（如 `x≠1`），
        # 该处的定义域差异不在讨论范围内 —— 用户确认口径（第 19 例）。
        try:
            _dom2 = _premise_domain(relations, syms[0])
        except Exception:  # noqa: BLE001
            _dom2 = sp.S.Reals
        sing = _check_singularities(lhs, rhs, syms[0], _dom2)
        if sing is not None:
            return sing

    try:
        res = sp.simplify(lhs - rhs)
    except Exception:  # noqa: BLE001
        res = None

    # ---- 3 残差恒为 0（含多变量情形，此判定与变量个数无关）----
    if res is not None:
        try:
            if res == 0:
                return _ok("legit", "ok", "化简后两侧相同")
        except Exception:  # noqa: BLE001
            pass

    # ---- 4 残差为非零常数 → 无论如何都不成立（如 x+1 = x+2）----
    # 为什么显式判断：这是确定性结论，且能避免 solveset 在常量输入下的
    # 行为差异（探针实测：直接交给 solveset 会退回 unknown）。
    if res is not None and not getattr(res, "free_symbols", None):
        try:
            if res != 0:
                return _ok("illegal", "not_derivable", "两式相差非零常数，不相等")
        except Exception:  # noqa: BLE001
            pass

    # ---- 4c 单变量值域比对（无解快路径）----
    if len(syms) == 1:
        _rng = _check_ranges(lhs, rhs, syms[0], relations)
        if _rng is not None:
            return _rng

    # ---- 5 核心判据：解集与前提域是否有交集 ----
    #
    # 用户口径（23 用例反推确认）：等式的本质是**约束**，
    # 「有交集即成立」；解集为空（无解）才是错。
    if res is None:
        pass
    elif len(syms) != 1:
        # ---- 5a 多变量：公共解存在性（鸡兔同笼场景）----
        _mv = _multivar_solution_status(relations, current, syms)
        if _mv is True:
            return _ok("legit", "ok", "本步与前提存在公共解")
        if _mv is False:
            return _ok(
                "illegal",
                "not_derivable",
                "本步与前提无公共解（方程组矛盾）",
            )
        # None → 交第 6 步
    else:
        # ---- 5b 单变量：解集 ∩ 前提域 ----
        sym = syms[0]
        sol = None
        try:
            sol = sp.solveset(res, sym, domain=sp.S.Reals)
        except Exception:  # noqa: BLE001
            sol = None

        if sol is not None:
            try:
                if sol is sp.S.EmptySet:
                    # 无解 → 无论有无前提都判否（用户口径：X+1=X+2、sin(x)=2）
                    return _ok(
                        "illegal",
                        "not_derivable",
                        "不存在使等式成立的取值，本步不成立",
                    )
                if sol is sp.S.Reals:
                    return _ok("legit", "ok", "在全体实数上恒成立")
            except Exception:  # noqa: BLE001
                pass

            try:
                dom = _premise_domain(relations, sym)
            except Exception:  # noqa: BLE001
                dom = sp.S.Reals
            got = _intersect_nonempty(sol, dom)
            if got is True:
                return _ok(
                    "legit",
                    "ok",
                    "解集 {} 与前提取值范围有交集，本步成立".format(sol),
                )
            if got is False:
                return _ok(
                    "illegal",
                    "not_derivable",
                    "解集 {} 与前提取值范围无交集，本步与前提矛盾".format(sol),
                )
            # None → 交第 6 步

    # ---- 6 缺符号信息（仅当上一步判不出时才提示）----
    #
    # 为什么放在最后：能定论时不该退回「判不了」（用户方案：缺信息就明说，
    # 但**只在真的判不出时**才说，否则会盖掉本可给出的确定结论）。
    miss = scan_missing_symbol_info(current)
    if miss and relations:
        # 前提若已限定该符号的正负，则不算缺信息：
        # 用户已写 x>=0，系统再要求「请声明 x 的符号」既重复又令人困惑。
        still = []
        for name in miss:
            try:
                sv = sp.Symbol(name, real=True)
                dom = _premise_domain(relations, sv)
            except Exception:  # noqa: BLE001
                dom = sp.S.Reals
                sv = sp.Symbol(name, real=True)
            if not _domain_fixes_sign(dom, sv):
                still.append(name)
        miss = still
    if miss:
        return _ok(
            "unknown",
            "missing_symbol_info",
            "需要知道 " + "、".join(miss) + " 的符号（正负）才能判定本步；"
            "请在场景前提中说明，或新建一个假设节点。",
        )

    return _ok("unknown", "not_applicable", "结构分析未能定论")

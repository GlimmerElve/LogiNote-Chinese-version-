/**
 * 前提链判定编排层（前提链架构新增）。
 *
 * 职责：把「画布图结构」翻译成「引擎可判定的前提集」，并调用引擎得出结论。
 * 这是本架构的心脏 —— 三层职责严格分离：
 *   1. `collectBranchPremises`：图 → 前提集（纯函数，无 IO）
 *   2. `judgeStepLegitimacy` / `judgeAssumption`：前提集 → 引擎 → 结论（含 IO）
 *   3. 调用方（computeAnalyze）：结论 → 节点状态（含业务编排）
 *
 * 核心语义（用户确认）：
 *   - **有连线才有推导关系**：沿入边反向追溯祖先，没连线的节点不参与前提
 *   - **前提是块不是条**：一个 given 节点承载完整使用条件，连线即全量引用
 *   - **场景前提优先**：用户假设与场景前提冲突时，场景前提胜出
 *   - **场景条件不得隐性生效**（轮次 X5 新增）：`compute.boundary_conditions`
 *     是「**待覆盖的边界条件清单**」，不是「已知条件」——
 *     它**不参与前提判定**，只在 `computeAnalyze` 的 LLM 反馈里作为待办提示。
 */

import type {
  BranchPremises,
  DerivationCanvasState,
  DerivationNode,
  PremiseEntry,
  SceneSpec,
  StepIntent,
  StepLegitResult,
  SymbolDecl,
} from '../../types';
import { collectAncestors } from '../../modules/derivationCanvas/utils/branchGraph';
import { sessionStep, sessionAssume } from './computeClient';
import { s4AllowedNodeTypes } from './sceneS4Policy';
import { createS4ProofEvidence } from './sceneS4Evidence';

/**
 * 构造 `sessionInit` 所需的符号表（轮次 I 新增）。
 *
 * 为什么单独出口而不是直接传 `spec.compute.symbols`：
 *   `sessionInit` 的符号表是**引擎侧**契约（`_compile_symbols`），它按
 *   `name` / `kind` / `positive` / `complex` / `params` / `body` 逐项读取。
 *   直接透传会让字段形态问题悄悄穿透到服务端并静默降级
 *   （如 `kind` 缺失时被当成 constant，导致 `A(x)` 被读成 `A*x`）。
 *   在此显式规范化，噪音拦在边界上，服务端不会拿到半成品。
 *
 * 规范化口径（与引擎 `_compile_symbols` 对齐）：
 *   - 缺 `name` 的项丢弃
 *   - `kind` 只接受三种合法值，其余回退 `variable`
 *     （**不可回退 constant**：常量会参与数值采样并被当定值代入，
 *      把变量误当常量会扭曲所有判定，而 variable 至少保持符号语义）
 *   - `function` 补 `params` / `body` 的合法形态
 *
 * **不做**的事：不从 `compute.given` 反推函数声明。given 条目由 LLM 在
 * 场景生成阶段解构并写入 `symbols`，运行时再猜一遍会产生第二套真相来源。
 */
export function buildSessionSymbols(spec: SceneSpec): SymbolDecl[] {
  const raw = spec.compute?.symbols ?? [];
  const out: SymbolDecl[] = [];
  for (const s of raw) {
    if (!s || typeof s.name !== 'string' || !s.name.trim()) continue;
    const kind =
      s.kind === 'constant' || s.kind === 'variable' || s.kind === 'function'
        ? s.kind
        : 'variable';
    const item: SymbolDecl = { name: s.name.trim(), kind };
    if (typeof s.value === 'string') item.value = s.value;
    if (Array.isArray(s.range) && s.range.length === 2) item.range = [s.range[0], s.range[1]];
    if (typeof s.display === 'string') item.display = s.display;
    if (s.positive === true) item.positive = true;
    if (s.complex === true) item.complex = true;
    if (kind === 'function') {
      item.params = Array.isArray(s.params)
        ? s.params.filter((p): p is string => typeof p === 'string')
        : [];
      if (typeof s.body === 'string' && s.body.trim()) item.body = s.body;
    }
    out.push(item);
  }
  return out;
}

/**
 * 把 given 条目的 symbolic 形式按类型分流。
 *
 * 为什么要分流：`domain` 类条目（如 `m >= 0`）在引擎侧走不等式通道，
 * 与等式/表达式的前提混在一起会互相干扰判定精度。
 */
function splitEntry(entry: PremiseEntry): { kind: string; symbolic: string } {
  const symbolic = typeof entry?.symbolic === 'string' ? entry.symbolic.trim() : '';
  const kind = typeof entry?.kind === 'string' ? entry.kind : 'relation';
  return { kind, symbolic };
}

/**
 * 取 given 节点的前提条目。
 *
 * 三态语义（与 `GivenItem.entries` / `buildGivenNodes` 严格对齐）：
 *   - `entries` 非空   → 前提包模式，逐条展开参与判定
 *   - `entries` 为空数组 → 解构失败降级，**不可引用**（返回空，上层已标注）
 *   - `entries` 缺省   → 旧场景兼容：用 `latex` / `symbol_value` 兜底为单条 relation
 *
 * 为什么优先读**显式** `data.entries`（本轮修复的关键）：
 *   此前用 `as unknown as { entries?: ... }` 强转读取，而 `buildGivenNodes`
 *   从不写入该字段 —— 即使场景生成阶段解构出了 entries，也传不到这里，
 *   于是永远走「display 兜底」分支，把一条含分号的多条目式子当成**单条**
 *   喂给引擎。整条「前提包」设计因此空转，是 D1 缺陷的最后一环。
 */
function givenEntriesOf(data: DerivationNode['data']): PremiseEntry[] {
  // ① 显式 entries（前提链架构的正规路径）
  if (Array.isArray(data.entries)) {
    return data.entries;
  }

  /**
   * ② 旧场景兼容：无 entries 字段时兜底为单条 relation。
   *
   * ## 两条来源都要读（关键，否则旧场景全部失效）
   * `buildGivenNodes` 的三种写入形态决定了内容落在哪个字段：
   *   - entries 非空   → `latex` 是多条目拼接（已被 ① 拦截）
   *   - entries 空数组 → 该节点标记为不可引用（返回空是正确的）
   *   - entries **缺省**（旧场景）→ `display` 被写进 **note**，`latex` 为空
   *
   * 因此若只读 `latex`，**旧场景的所有 given 都会返回空** → 前提链拿不到任何前提，
   * 整条判定退化为「孤立节点」。这是必须同时读 `note` 的原因。
   *
   * 优先级：`latex`（前提包渲染结果）> `note`（旧格式的 display / 或前提包的框外解释）。
   */
  const legacy = (data.latex || data.note || '').trim();
  if (!legacy) return [];
  return [{ kind: 'relation', display: legacy, symbolic: legacy }];
}

/**
 * 从画布图收集节点 N 的支路前提集。
 *
 * 规则（按优先级）：
 *   - 沿入边反向追溯所有祖先；**没连线的节点一律不参与**
 *   - 祖先中的 `given` 节点 → 展开 entries 到 facts / domains
 *   - 祖先中的 `assumption` 节点 → assumptions
 *   - 祖先中状态为 pass 的 `formula` / `conclusion` → facts
 *
 * `globalDomains` **恒为空数组**（轮次 X5）—— 见函数内实现处的说明。
 */
export function collectBranchPremises(
  node: DerivationNode,
  canvas: DerivationCanvasState,
  spec: SceneSpec,
): BranchPremises {
  const ancestorIds = collectAncestors(node.id, canvas.edges || []);
  const allowedTypes = s4AllowedNodeTypes(spec);
  const evidence = createS4ProofEvidence(spec, canvas);
  const byId = new Map<string, DerivationNode>();
  for (const n of canvas.nodes || []) byId.set(n.id, n);

  const facts: string[] = [];
  const assumptions: string[] = [];
  const domains: string[] = [];
  const ignoredAncestorIds: string[] = [];

  const ignore = (id: string) => {
    if (!ignoredAncestorIds.includes(id)) ignoredAncestorIds.push(id);
  };

  for (const id of ancestorIds) {
    const anc = byId.get(id);
    if (!anc) { ignore(id); continue; }
    if (!allowedTypes.includes(anc.type)) { ignore(id); continue; }
    if (!evidence.usablePremise(id)) { ignore(id); continue; }
    const data = anc.data;

    if (anc.type === 'given') {
      const entries = givenEntriesOf(data);
      let usable = false;
      for (const entry of entries) {
        const { kind, symbolic } = splitEntry(entry);
        if (!symbolic) continue;
        usable = true;
        if (kind === 'domain') domains.push(symbolic);
        else facts.push(symbolic);
      }
      if (!usable) ignore(id);
      continue;
    }

    if (anc.type === 'assumption') {
      const expr = (data.latex || '').trim();
      assumptions.push(expr);
      continue;
    }

    // 结论是支路终点，不能反过来成为其他步骤的依据。
    if (anc.type === 'conclusion') {
      ignore(id);
      continue;
    }

    // Already checked by the same engine-backed branch predicate as metrics/completion.
    facts.push(data.latex!.trim());
  }

  /**
   * ============ 轮次 X5：`globalDomains` 不再承载场景条件 ============
   *
   * ## 用户口径（原话）
   *   「无前提没任何入线相当于**不引用场景中规定的任何条件**」
   *   「只有连线才会影响到相关的块」
   *
   * ## 原实现为什么违背该口径（用户实测现象）
   *   此前此处把 `compute.boundary_conditions` 映射为 `globalDomains`，
   *   它**完全不看 `ancestorIds`** —— 无论有没有连线都会带上，随后由
   *   `judgeStepLegitimacy` / `judgeAssumption` 原样发给引擎。
   *   而引擎 `_session_context` 又把它**无条件并入**前提集，于是：
   *     - 未连线节点提交的式子一旦与场景条件抵触
   *       → 判 `constraint_conflict` / `premise_conflict`
   *       → 用户看到「本步与已有前提冲突」（**但他没有任何连线**）
   *
   *   这与「场景常量值绕过连线」是同一类缺陷（该处已于轮次 X 移除
   *   `default_relations`），`globalDomains` 是当时**遗漏的第二个后门**。
   *
   * ## 为什么 `boundary_conditions` 本就不该当前提（语义错位）
   *   它是「**待覆盖的边界条件清单**」，服务于 `boundary_coverage` 指标
   *   （见 `computeAnalyze` 的 LLM 输入），而非「题目给定的已知条件」。
   *   把「任务清单」当「已知条件」并入判定，会凭空制造前提。
   *
   * ## 恒为空数组而非删字段
   *   保留字段可维持 `BranchPremises` 的类型契约与
   *   `sessionStep` / `sessionAssume` 的参数形状不变（最小改动面），
   *   同时后端 `_session_context` 也已同步移除并入逻辑 ——
   *   **两层都断**，任一层回归都不会重现该缺陷。
   *
   * ## `boundary_conditions` 仍然生效（不受影响）
   *   它继续出现在 `computeAnalyze.buildAnalyzeInput` 的
   *   「## 待覆盖的边界条件」段，供 LLM 提示用户补全 —— 只是不再参与
   *   **对错裁定**。
   */
  const globalDomains: string[] = [];

  return { facts, assumptions, domains, globalDomains, ancestorIds, ignoredAncestorIds };
}

/**
 * 判定单个推导步骤的合法性（前提链前置关卡）。
 *
 * **永不抛错**：引擎异常/网络异常统一归约为 `unknown`，
 * 由调用方回落到既有参考解比对链路（叠加式，不替换）。
 */
export async function judgeStepLegitimacy(ctx: {
  sessionId: string;
  userExpr: string;
  premises: BranchPremises;
  intent: StepIntent;
}): Promise<StepLegitResult> {
  const expr = (ctx.userExpr || '').trim();
  if (!expr) {
    return { legit: 'unknown', code: 'unparsable', detail: '表达式为空' };
  }

  const p = ctx.premises;
  const res = await sessionStep({
    sessionId: ctx.sessionId,
    intent: ctx.intent,
    expr,
    facts: p?.facts || [],
    assumptions: p?.assumptions || [],
    domains: p?.domains || [],
    globalDomains: p?.globalDomains || [],
  });

  // 注意：sessionStep 已把引擎失败归一化为 ok:true + unknown（见 computeClient），
  // 因此此处直接取 result，无需处理失败分支。
  return res.result;
}

/**
 * 校验用户新建的假设前提是否与祖先前提冲突。
 *
 * 冲突时返回 `conflict` —— 语义是「场景前提优先」：
 * **已连线**的题目给定条件（`given` 承载的前提）不能被用户假设推翻。
 *
 * ## 轮次 X5 修订：`boundary_conditions` **不在**此列
 *   原注释把 `boundary_conditions` 也列为「不可推翻的场景条件」，该口径已改：
 *   它不参与前提判定（见 `collectBranchPremises` 的 `globalDomains` 说明），
 *   故**不会**与用户假设发生冲突 —— 真正会拦下假设的只有「已连线的 given」。
 *   这与「无前提没任何入线相当于不引用场景中规定的任何条件」完全一致。
 */
export async function judgeAssumption(ctx: {
  sessionId: string;
  assumptionExpr: string;
  premises: BranchPremises;
}): Promise<StepLegitResult> {
  const expr = (ctx.assumptionExpr || '').trim();
  if (!expr) {
    return { legit: 'unknown', code: 'unparsable', detail: '假设内容为空' };
  }

  const p = ctx.premises;
  const res = await sessionAssume({
    sessionId: ctx.sessionId,
    assumption: expr,
    facts: p?.facts || [],
    assumptions: p?.assumptions || [],
    domains: p?.domains || [],
    globalDomains: p?.globalDomains || [],
  });

  // 同 sessionStep：失败已在内层归一化为 ok:true + unknown
  return res.result;
}

/**
 * 前提链判定结论 → 用户可见反馈文案。
 *
 * 设计原则（原则 10「LLM 生成、系统执行」）：
 * 系统只负责**判定**与给出**最低限度的定位信息**，
 * 具体原因的解释与教学建议交给 LLM 助手 —— 避免系统硬编码话术、
 * 又因为缺少语境而说错。
 */
export function legitFeedback(v: StepLegitResult): { status: 'pass' | 'warn' | 'fail'; text: string } {
  switch (v?.legit) {
    case 'legit':
      // 轮次 I 终版：定值 / 定关系式走「并入前提查一致性」通道，与「推导」
      // 是两类语义，提示话术必须区分 —— 说「已由前置步骤推得」会让用户
      // 以为系统验证了他的赋值，而实际只确认了「不冲突/恒等」。
      //
      //   new_definition  引入新变量（如 A=x*y）→ 登记为定义
      //   value_assign_ok 给已有变量定值（如 y=1）→ 与前提一致
      //   relation_ok     给已有变量定关系（如 y=40-2x）→ 与前提恒等
      if (v.code === 'new_definition') {
        return { status: 'pass', text: v.detail || '已登记该变量的定义。' };
      }
      if (v.code === 'value_assign_ok') {
        return { status: 'pass', text: v.detail || '本步为赋值，与已有前提一致。' };
      }
      if (v.code === 'relation_ok') {
        return { status: 'pass', text: v.detail || '本步关系与已有前提一致。' };
      }
      if (v.code === 'partial_identity_ok') {
        return { status: 'pass', text: v.detail || '代入函数体并求偏导后，两侧恒等。' };
      }
      if (v.code === 'explicit_derivative_identity') {
        return { status: 'pass', text: v.detail || '完成求导后，两侧恒等。' };
      }
      if (v.code === 'partial_equation_declared') {
        return { status: 'pass', text: v.detail || '已登记该偏微分约束。' };
      }
      /**
       * 轮次 S 新增：函数体代入后的两种「成立」。
       *
       * 为什么必须与上面的分支区分（用户口径）：
       *   这两类结论来自「**代入已知函数定义**」这条通道，与「本步关系与前提一致」
       *   是不同语义 —— 用户需要知道的是「函数定义已代进去、结论成立」，
       *   而不是「你说的关系与前提不冲突」。
       *
       *   `func_body_ok`        恒成立（如 `F(2)=4` 在 `F(h)=h²` 下）
       *   `func_body_solvable`  **仅特定取值成立**（如 `F'(h)=3h` 在 `F(h)=h²` 下
       *                         代入得 `2h=3h`，只在 h=0 成立）
       *
       * 后者的关键（用户明确要求）：必须点明「**非恒等式**」——
       *   同一串 `F'(h)=3h` 既可读作「求解」（求 2h=3h 的根）也可读作
       *   「声称 2h 与 3h 恒等」。引擎**无法区分**两种意图（数学上同一串），
       *   故按用户口径判 pass，但必须在文案里讲清它不是恒等式，
       *   否则用户会误以为系统背书了「恒等」这个错误主张。
       *
       * 文案由引擎 `detail` 提供（含变量名，**不含具体解** —— 用户要求不让 LLM 写具体值）。
       */
      if (v.code === 'func_body_ok') {
        return { status: 'pass', text: v.detail || '满足前提条件，等式恒成立。' };
      }
      if (v.code === 'func_body_solvable') {
        return {
          status: 'pass',
          text:
            v.detail ||
            '满足前提条件，等式在特定取值下成立，非恒等式。请确认你的意图（求解 / 恒等变形）。',
        };
      }
      return { status: 'pass', text: '本步已由前置步骤推得，成立。' };
    case 'warn':
      // 轮次 G：结论正确但有保留 —— 不误判为错，同时把隐含前提讲清楚。
      // 可去奇点（约分）：约掉的那一项有「不为零」的前提。
      // 部分定义域：等式只在某个区间上成立。
      if (v.code === 'removable_singularity') {
        return {
          status: 'warn',
          text: v.detail || '本步结论成立，但化简隐含了一项「不为零」的前提，请注意定义域。',
        };
      }
      if (v.code === 'partial_domain') {
        return {
          status: 'warn',
          text: v.detail || '本步仅在部分取值范围内成立，请补充定义域前提。',
        };
      }
      return { status: 'warn', text: v.detail || '本步结论成立，但有一定前提条件。' };
    case 'conflict':
      if (v.code?.startsWith('matrix_')) {
        return { status: 'fail', text: v.detail || '矩阵约束无法同时成立。' };
      }
      if (v.code === 'premise_conflict' && v.detail?.includes('方程组')) {
        return { status: 'fail', text: v.detail };
      }
      // 轮次 H 新增 function_conflict：两条支链声明了同名但不同的函数，
      // 汇合到本节点后无法确定该用哪一份定义 —— 用户确认口径为「判 fail」。
      // 单独给码是因为提示话术完全不同：不是「前提矛盾」而是「函数重名」，
      // 可执行的修法是「换个函数名」，笼统说「前提矛盾」用户无从下手。
      if (v.code === 'function_conflict') {
        return {
          status: 'fail',
          text: v.detail || '两条支链中的函数定义不同，请改用不同的函数名。',
        };
      }
      return {
        status: 'fail',
        text:
          '本步引用的前提之间互相矛盾，无法同时成立。' +
          (v.conflictPair ? `（冲突：${v.conflictPair.scene} 与 ${v.conflictPair.user}）` : ''),
      };
    case 'illegal':
      if (v.code?.startsWith('matrix_')) {
        return { status: 'fail', text: v.detail || '矩阵等式不成立。' };
      }
      if (v.code === 'system_conflict') {
        return { status: 'fail', text: v.detail || '方程组内部或与已连接前提冲突。' };
      }
      // 轮次 I：两类「与前提不一致」都归此码，detail 已在引擎侧写明具体原因
      // （值指派与前提冲突／关系式只在部分取值上成立），必须透出来，
      // 否则用户只看到「本步不成立」而无从知道冲突在哪。
      if (v.code === 'constraint_conflict') {
        return { status: 'fail', text: v.detail || '本步与已有前提冲突，无法同时成立。' };
      }
      if (v.code === 'division_by_zero') {
        return { status: 'fail', text: v.detail || '分母可能为 0，请先说明该量的定义域。' };
      }
      if (v.code === 'unparsable') {
        return { status: 'fail', text: v.detail || '本步无法解析，请检查书写。' };
      }
      if (v.code === 'undeclared_symbol') {
        return { status: 'fail', text: v.detail || '存在未定义的符号或函数。' };
      }
      if (v.code === 'compatible_not_derived' || v.code === 'declared_not_derived') {
        return {
          status: 'warn',
          text:
            v.detail ||
            '该式与当前前提相容，但尚未由前提推出；若它是附加条件，请改用假设前提节点。',
        };
      }
      if (v.code === 'partial_identity_mismatch') {
        return { status: 'fail', text: v.detail || '代入函数体并求偏导后，两侧不恒等。' };
      }
      if (v.code === 'explicit_derivative_mismatch') {
        return { status: 'fail', text: v.detail || '完成求导后，两侧不相等。' };
      }
      if (v.code === 'conclusion_not_derived') {
        return {
          status: 'fail',
          text: v.detail || '该结论尚未由当前支路的前提和推导步骤证明。',
        };
      }
      return { status: 'fail', text: '这一步推理存在问题，请检查它与前置步骤的关系。' };
    case 'unknown':
    default:
      // 孤立节点：不算错，只提示缺少依据（用户明确要求）
      if (v?.code === 'no_premise') {
        return {
          status: 'warn',
          text: '这一步缺少前提依据。若能由前面的步骤推得，请连上来源节点。',
        };
      }
      if (v?.code === 'conclusion_no_premise') {
        return {
          status: 'warn',
          text: v.detail || '结论节点必须连接至少一个已通过验证的前提或推导步骤。',
        };
      }
      if (v?.code === 'premise_unparsable' || v?.code === 'upstream_not_verified') {
        return { status: 'warn', text: v.detail || '已连接的上游前提暂时不可用。' };
      }
      if (v?.code === 'partial_function_signature_missing' || v?.code === 'partial_not_evaluable') {
        return { status: 'warn', text: v.detail || '偏导函数信息不完整，暂时无法判定。' };
      }
      if (v?.code === 'derivative_dependency_missing') {
        return {
          status: 'warn',
          text: v.detail || '缺少函数依赖关系，请把因变量声明为函数后再判定导数。',
        };
      }
      if (v?.code === 'not_applicable' || v?.code === 'unsupported_expression') {
        return {
          status: 'warn',
          text: v.detail || '公式已读取，但当前判定引擎暂不支持这种表达式结构。',
        };
      }
      return { status: 'warn', text: '引擎暂时无法判定本步；请检查公式写法及已连接前提，必要时请求讲解。' };
  }
}

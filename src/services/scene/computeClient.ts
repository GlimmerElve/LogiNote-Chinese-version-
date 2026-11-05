/**
 * SymPy 计算服务客户端（渲染进程侧）。
 *
 * 职责：
 * - 统一封装 window.electronAPI.compute 的调用（Web 环境下降级为明确错误）
 * - 把 IPC 层的 ComputeIpcResponse 归一化为「成功 / 失败」联合类型，便于调用方处理
 * - 提供语义化的高层函数（parseExpression / computeLimit / sessionStep 等）
 *
 * 注意：本模块只做「调用 + 归一化」，不做业务判定
 * （步骤合法性由 `premise_engine` 判定，见 premiseChain.ts）。
 */

import {
  COMPUTE_TIMEOUT_MS,
  type ComputeCommand,
  type ComputeIpcResponse,
  type ComputeServiceStatus,
  type SymbolDecl,
  type StepLegitResult,
  type StepLegit,
  type StepIntent,
} from '../../types';

/** 统一的调用结果类型 */
export type ComputeOk<T> = { ok: true; result: T };
export type ComputeFail = { ok: false; error: string; errorCode?: string };
export type ComputeResult<T> = ComputeOk<T> | ComputeFail;

/**
 * 把失败分支归一化为 ComputeFail。
 * 说明：本项目 tsconfig 未开启 strict，TS 无法对判别联合做 truthiness 收窄，
 * 因此统一用此函数显式提取失败信息，避免散落类型断言。
 */
function toFail(res: { ok: boolean; error?: string; errorCode?: string }): ComputeFail {
  return { ok: false, error: res.error || '计算失败', errorCode: res.errorCode };
}

/** Electron 暴露的 compute 能力（与 preload.d.ts 的 ElectronComputeApi 对应） */
interface ComputeApi {
  run: (req: unknown) => Promise<ComputeIpcResponse>;
  status: () => Promise<ComputeServiceStatus>;
}

/** 取 IPC 通道（非 Electron 环境返回 undefined） */
function getComputeApi(): ComputeApi | undefined {
  return (window as unknown as { electronAPI?: { compute?: ComputeApi } }).electronAPI?.compute;
}

/**
 * 执行一条计算命令。
 * - 非 Electron 环境：直接返回 SERVICE_DOWN（不抛错，由调用方决定提示方式）
 * - IPC 抛错：归一化为 INTERNAL_ERROR
 */
export async function runCompute<T = unknown>(
  cmd: ComputeCommand,
  args: Record<string, unknown>,
): Promise<ComputeResult<T>> {
  const api = getComputeApi();
  if (!api) {
    return { ok: false, error: '当前环境不支持本地计算服务（仅桌面版可用）', errorCode: 'SERVICE_DOWN' };
  }

  try {
    const resp = await api.run({ cmd, args });
    if (!resp || resp.ok !== true) {
      return {
        ok: false,
        error: resp?.error || '计算失败',
        errorCode: resp?.errorCode,
      };
    }
    return { ok: true, result: resp.result as T };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'IPC 调用失败', errorCode: 'INTERNAL_ERROR' };
  }
}

/** 查询服务状态（用于 UI 展示「计算引擎加载中」） */
export async function probeComputeService(): Promise<ComputeServiceStatus> {
  const api = getComputeApi();
  if (!api) return { ready: false, warming: false, error: '当前环境不支持本地计算服务' };
  try {
    return await api.status();
  } catch (e) {
    return { ready: false, warming: false, error: (e as Error)?.message };
  }
}

/* ================================================================
 * 高层语义封装
 * ================================================================ */

/** parse 命令的返回结构 */
interface ParseResult {
  sympy_expr: string;
  variables: string[];
  free_symbols: string[];
  /** 引擎识别到单等号时为 true，且 sympy_expr 保留「lhs = rhs」形式 */
  is_equation?: boolean;
  /** 引擎识别到的函数名列表（轮次 A 新增），如 ["A"] */
  detected_functions?: string[];
}

/**
 * SymPy 符号表中的「函数声明」形态（轮次 A 新增）。
 *
 * 用途：把场景里声明为 kind='function' 的函数（如面积函数 A(x)）告知引擎，
 * 使 `A(x)` 被识别为函数调用而非 `A*x` 乘法。
 */
export interface SymbolFunctionDecl {
  kind: 'function';
  params: string[];
  body?: string;
}

/** 符合引擎契约的符号表（常量 / 变量区间 / 函数声明） */
export type SymbolTable = Record<string, string | [string, string] | SymbolFunctionDecl>;

/**
 * 语法解析：把（LLM 转译后的）表达式字符串转为 SymPy 表达式。
 * 返回规范化的表达式字符串与变量列表。
 *
 * 等式支持：引擎在识别到等号时不会被判为语法错误，而是返回
 * `isEquation: true` 并让 `sympyExpr` 保留「lhs = rhs」形式 ——
 * 这样下游仍能区分「方程（约束）」与「表达式（解）」，
 * 「上游方程 vs 下游结果」的判定口径才成立。
 */
export async function parseExpression(
  expr: string,
  /**
   * 符号表（轮次 V 修复，用户实测缺陷）。
   *
   * ## 为什么从 `string[]` 放宽为 `SymbolDecl[]`
   * 原先只接受「名字数组」，调用方 `computeAnalyze` 传的是
   * `spec.compute.symbols.map(s => s.name)` —— **`kind:'function'` 被丢掉**。
   * 引擎 `_symbol_table_to_dict` 对「全是字符串」的数组一律判为
   * `{"kind": "variable"}`，于是 `F(x)` 被当作「已声明变量 F 后跟括号」，
   * 走 `_strip_implicit_mul` 的 4b 分支插入乘号 → **`F*x`**。
   *
   * 实测证据（场景声明 F 为 function）：
   *   parse('F(x)=x', ['F','x'])                          → 'F*x = x'   ❌
   *   parse('F(x)=x', [{name:'F',kind:'function',...}])   → 'F(x) = x'  ✅
   * 而下游 session_step 里 F 是 `sp.Function`，收到 `F*x` 会抛
   *   `unsupported operand type(s) for *: 'UndefinedFunction' and 'Symbol'`
   * —— 用户看到的就是这句报错。
   *
   * ## 为什么引擎侧无需改动
   * `_symbol_table_to_dict` 本就同时支持两种形态（字符串数组只是兼容旧契约）。
   * 故此处放宽类型即可，不触碰 Python。
   *
   * ## 向后兼容
   * 类型定为联合：引擎侧仍接受字符串数组，既有调用不受影响。
   */
  symbols: string[] | SymbolDecl[],
): Promise<
  ComputeResult<{
    sympyExpr: string;
    variables: string[];
    isEquation?: boolean;
    /** 引擎识别到的函数名（轮次 A 新增）；非空时 UI 应提示用户 */
    detectedFunctions?: string[];
  }>
> {
  const res = await runCompute<ParseResult>('parse', { expr, symbols });
  if (!res.ok) return toFail(res as ComputeFail);
  return {
    ok: true,
    result: {
      sympyExpr: res.result?.sympy_expr || '',
      variables: Array.isArray(res.result?.variables) ? res.result.variables : [],
      isEquation: res.result?.is_equation === true,
      detectedFunctions: Array.isArray(res.result?.detected_functions)
        ? res.result.detected_functions.filter((f): f is string => typeof f === 'string')
        : undefined,
    },
  };
}

/**
 * 符号表（前端 SymbolDecl[]）转 SymPy 服务期望的 dict 形式：
 * - constant → 字符串值
 * - variable → [下限, 上限]
 * - function → { kind:'function', params, body }（轮次 A 新增）
 *
 * 为什么函数要单独一档：函数名不是变量，不能参与自由符号统计与数值采样，
 * 但必须让扫描器知道「A(x) 是函数调用」，否则会被归一成 `A*x`，
 * 凭空引入一个不存在的自由符号 A，使正确的函数定义式判为错误。
 */
export function symbolDeclsToTable(symbols: SymbolDecl[]): SymbolTable {
  const table: SymbolTable = {};
  for (const s of symbols || []) {
    if (!s?.name) continue;
    if (s.kind === 'function') {
      table[s.name] = {
        kind: 'function',
        params: Array.isArray(s.params) ? s.params.filter((p): p is string => typeof p === 'string') : [],
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

/**
 * 轮次 N 删除 `verifyEquivalencePure`（参考链等价性判定已整体移除）。
 *
 * 原职责：走 SymPy 五级策略（simplify_diff → expand_diff → ratio_minus_one
 * → sympy_equals → numeric_sampling）比对两个表达式是否等价。
 *
 * 为什么删除：
 *   - 唯一调用方 `equivalence.ts` 已删除；
 *   - 该口径在纯常数场景下会误判（`1=2=3` 两边差式都恰好是 -1），
 *     判定权已迁移到前提链（`premise_engine.session_step`）。
 *
 * 注：底层 `verify_equiv` 命令与 Python 侧实现**保留** —— 它属于计算引擎
 * 的通用能力（如「两式是否等价」的教学工具），不随前端链路一起删。
 * 注：`symbolDeclsToTable` **保留** —— `computeLimit` 仍在使用。
 */

/** 求极限 */
export async function computeLimit(
  expr: string,
  variable: string,
  to: string,
  symbols?: SymbolDecl[],
  direction: '+' | '-' | 'both' = 'both',
): Promise<ComputeResult<{ result: string; isFinite: boolean; latex: string }>> {
  const res = await runCompute<{ result: string; is_finite: boolean; latex: string }>('limit', {
    expr,
    var: variable,
    to,
    direction,
    symbols: symbols ? symbolDeclsToTable(symbols) : undefined,
  });
  if (!res.ok) return toFail(res as ComputeFail);
  return {
    ok: true,
    result: {
      result: res.result?.result ?? '',
      isFinite: Boolean(res.result?.is_finite),
      latex: res.result?.latex ?? '',
    },
  };
}

/** 符号代入求值 */
export async function substituteExpression(
  expr: string,
  subs: Record<string, string>,
): Promise<ComputeResult<{ result: string; isNumber: boolean; latex: string }>> {
  const res = await runCompute<{ result: string; is_number: boolean; latex: string }>('substitute', { expr, subs });
  if (!res.ok) return toFail(res as ComputeFail);
  return {
    ok: true,
    result: {
      result: res.result?.result ?? '',
      isNumber: Boolean(res.result?.is_number),
      latex: res.result?.latex ?? '',
    },
  };
}

/** 化简 */
export async function simplifyExpression(
  expr: string,
): Promise<ComputeResult<{ result: string; latex: string }>> {
  const res = await runCompute<{ result: string; latex: string }>('simplify', { expr });
  if (!res.ok) return res;
  return { ok: true, result: { result: res.result?.result ?? '', latex: res.result?.latex ?? '' } };
}

/** 绘图数据（阶段五图表使用） */
export async function fetchPlotData(
  expr: string,
  variable: string,
  range: [string, string],
  constants?: Record<string, string>,
  points = 400,
): Promise<ComputeResult<{ x: number[]; y: number[]; xLabel: string; yLabel: string }>> {
  const res = await runCompute<{ x: number[]; y: number[]; xLabel: string; yLabel: string }>('plot_data', {
    expr,
    var: variable,
    range,
    constants: constants || {},
    points,
  });
  if (!res.ok) return res;
  return {
    ok: true,
    result: {
      x: Array.isArray(res.result?.x) ? res.result.x : [],
      y: Array.isArray(res.result?.y) ? res.result.y : [],
      xLabel: res.result?.xLabel || variable,
      yLabel: res.result?.yLabel || 'f',
    },
  };
}

/** 单位字符串自检（轻量，完整量纲判断在 LLM 侧） */
export async function checkUnits(
  varUnits: Record<string, string>,
): Promise<ComputeResult<{ unitsValid: boolean; notes: string }>> {
  const res = await runCompute<{ units_valid: boolean; notes: string }>('check_units', { var_units: varUnits });
  if (!res.ok) return toFail(res as ComputeFail);
  return {
    ok: true,
    result: {
      unitsValid: Boolean(res.result?.units_valid),
      notes: res.result?.notes || '',
    },
  };
}

/**
 * 求两条曲线的交点（solve_intersections 命令的语义封装）。
 *
 * 用途（阶段八）：图表面板叠加多条曲线后，把交点直接标在图上 ——
 * 「观察两个函数相交位置」是用户在场景搭建时提出的真实诉求。
 *
 * 计算完全由 SymPy 完成（数值二分法），LLM 不参与（原则 10）。
 * 无交点时返回空数组而非报错，调用方按「无交点」呈现即可。
 */
export async function solveIntersections(
  expr1: string,
  expr2: string,
  variable: string,
  range: [string, string],
  constants?: Record<string, string>,
): Promise<ComputeResult<{ count: number; points: Array<{ x: number; y: number }> }>> {
  const res = await runCompute<{ count: number; points: Array<{ x: number; y: number }> }>(
    'solve_intersections',
    {
      expr1,
      expr2,
      var: variable,
      range,
      constants: constants ?? {},
    },
  );
  if (!res.ok) return toFail(res as ComputeFail);

  const points = Array.isArray(res.result?.points)
    ? res.result.points.filter(
        (p): p is { x: number; y: number } =>
          Boolean(p) && Number.isFinite(p.x) && Number.isFinite(p.y),
      )
    : [];

  return { ok: true, result: { count: points.length, points } };
}

/* ==========================================================================
 * 前提链会话（前提链架构新增）
 *
 * 与既有命令的差别：这批命令带**会话状态**（符号环境）常驻在 Python 进程里，
 * 但前端是权威副本 —— facts / assumptions / domains 每次随调用传入，
 * 不依赖服务端记忆。这样即使 Python 进程重启，判定结果也完全一致。
 * ========================================================================== */

/**
 * 归一化引擎返回的判定结果。
 *
 * 为什么需要：服务端字段可能缺失或类型不符（协议演化、异常分支）。
 * 直接透传会让下游拿到 undefined.legit 而崩，故在此收口。
 */
function normalizeLegitResult(raw: unknown): StepLegitResult {
  const o = (raw ?? {}) as Partial<StepLegitResult>;
  const legit = o.legit;
  // warn 是轮次 G 新增态：结论正确但有保留（可去奇点 / 部分定义域）
  const safeLegit: StepLegit =
    legit === 'legit' ||
    legit === 'warn' ||
    legit === 'illegal' ||
    legit === 'conflict' ||
    legit === 'unknown'
      ? legit
      : 'unknown';
  const out: StepLegitResult = {
    legit: safeLegit,
    code: typeof o.code === 'string' && o.code ? o.code : 'engine_error',
  };
  if (typeof o.detail === 'string') out.detail = o.detail;
  if (o.conflictPair) out.conflictPair = o.conflictPair;
  if (
    o.proofBasis === 'entailed' ||
    o.proofBasis === 'identity' ||
    o.proofBasis === 'definition' ||
    o.proofBasis === 'compatible' ||
    o.proofBasis === 'declared' ||
    o.proofBasis === 'unknown'
  ) {
    out.proofBasis = o.proofBasis;
  }
  return out;
}

/**
 * 初始化会话：编译符号环境（场景启动时调用一次）。
 *
 * 传 symbols 时服务端会**强制重建**（不走缓存短路）—— 这对「同一 sessionId
 * 下换场景符号表」是必需的，否则新符号会被判为未声明而误判 illegal。
 */
export async function sessionInit(
  sessionId: string,
  symbols: SymbolDecl[],
): Promise<ComputeResult<{ sessionId: string; symbolCount: number; constFactCount: number }>> {
  const res = await runCompute<{
    sessionId: string;
    symbolCount: number;
    constFactCount: number;
  }>('session_init', { sessionId, symbols });
  if (!res.ok) return toFail(res as ComputeFail);
  return {
    ok: true,
    result: {
      sessionId: res.result?.sessionId ?? sessionId,
      symbolCount: Number(res.result?.symbolCount ?? 0),
      constFactCount: Number(res.result?.constFactCount ?? 0),
    },
  };
}

/** 单步判定的入参（祖先链由前端从画布图收集后传入） */
export interface SessionStepArgs {
  sessionId: string;
  /** 普通公式允许建立定义；结论节点只接受由前提推出或恒等成立。 */
  intent: StepIntent;
  /** 本步表达式（symbolic 形式） */
  expr: string;
  /** 该支路祖先的事实（等式 / 表达式） */
  facts: string[];
  /** 该支路祖先的假设 */
  assumptions: string[];
  /** 该支路祖先的定义域约束 */
  domains: string[];
  /** 场景级边界条件 */
  globalDomains: string[];
}

/**
 * 判定单步合法性（前提链前置关卡）。
 *
 * **永不抛错** —— 引擎异常归一化为
 * `{ legit: 'unknown', code: 'engine_error' }`，由调用方回落参考解比对，
 * 保证「引擎挂了」不会让整条判定链断掉。
 */
export async function sessionStep(
  args: SessionStepArgs,
): Promise<ComputeOk<StepLegitResult>> {
  const res = await runCompute<StepLegitResult>('session_step', {
    sessionId: args.sessionId,
    intent: args.intent,
    expr: args.expr,
    facts: args.facts,
    assumptions: args.assumptions,
    domains: args.domains,
    globalDomains: args.globalDomains,
  });
  // 引擎失败**不向上抛**：归一化为 ok:true + unknown，由调用方回落参考解比对。
  // 因此返回类型收窄为 ComputeOk —— 调用方无需处理失败分支（也就不会因
  // 非 strict 模式下的联合收窄失效而报错）。
  if (!res.ok) {
    const fail = res as ComputeFail;
    return {
      ok: true,
      result: { legit: 'unknown', code: 'engine_error', detail: fail.error },
    };
  }
  return { ok: true, result: normalizeLegitResult(res.result) };
}

/** 假设前提校验的入参 */
export interface SessionAssumeArgs {
  sessionId: string;
  /** 用户新建的假设 */
  assumption: string;
  facts: string[];
  assumptions: string[];
  domains: string[];
  globalDomains: string[];
}

/**
 * 校验用户新建的假设前提是否与祖先前提冲突。
 *
 * 冲突时返回 `legit: 'conflict'` —— 语义是「场景前提优先」：
 * 题目给定的条件不能被用户假设推翻。
 */
export async function sessionAssume(
  args: SessionAssumeArgs,
): Promise<ComputeOk<StepLegitResult>> {
  const res = await runCompute<StepLegitResult>('session_assume', {
    sessionId: args.sessionId,
    assumption: args.assumption,
    facts: args.facts,
    assumptions: args.assumptions,
    domains: args.domains,
    globalDomains: args.globalDomains,
  });
  if (!res.ok) {
    return {
      ok: true,
      result: { legit: 'unknown', code: 'engine_error', detail: (res as ComputeFail).error },
    };
  }
  return { ok: true, result: normalizeLegitResult(res.result) };
}

/**
 * 按分号切分前提包内容并分类（供前端解构校验）。
 *
 * 用途：LLM 生成 given.display 后，用它验证「能否被切成可识别的条目」；
 * 有任何一条解析不出，就触发重写或降级标注。
 */
export async function sessionSplit(
  display: string,
  symbols: SymbolDecl[],
): Promise<ComputeResult<{ count: number; entries: Array<{ display: string; kind: string }> }>> {
  const res = await runCompute<{
    count: number;
    entries: Array<{ display: string; kind: string }>;
  }>('session_split', { display, symbols });
  if (!res.ok) return toFail(res as ComputeFail);
  const entries = Array.isArray(res.result?.entries) ? res.result.entries : [];
  return { ok: true, result: { count: entries.length, entries } };
}

/** 关闭会话，释放服务端缓存 */
export async function sessionClose(sessionId: string): Promise<ComputeResult<{ ok: boolean }>> {
  const res = await runCompute<{ ok: boolean }>('session_close', { sessionId });
  if (!res.ok) return toFail(res as ComputeFail);
  return { ok: true, result: { ok: true } };
}

/** 供 UI 展示的超时提示常量（与主进程一致） */
export const COMPUTE_TIMEOUT_HINT_MS = COMPUTE_TIMEOUT_MS;

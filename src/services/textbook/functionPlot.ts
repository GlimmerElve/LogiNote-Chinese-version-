/** Optional textbook graphics. A small arithmetic AST, never JavaScript/LaTeX evaluation.
 * This checks drawability, NOT mathematical correctness or the authority of a formula. */
type Expr = { kind: 'number'; value: number } | { kind: 'variable' }
  | { kind: 'unary'; value: Expr } | { kind: 'call'; name: string; value: Expr }
  | { kind: 'binary'; op: string; left: Expr; right: Expr };
const FUNCTIONS: Record<string, (value: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, exp: Math.exp, log: Math.log, sqrt: Math.sqrt, abs: Math.abs,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
};
const own = (value: object, key: string) => Object.hasOwn(value, key);
function check(ok: unknown, message = '函数图参数不明确或不支持'): asserts ok { if (!ok) throw new Error(message); }
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  check(!!value && typeof value === 'object' && !Array.isArray(value));
  check(Object.keys(value).every(key => keys.includes(key)));
}
function label(value: unknown): asserts value is string {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= 160 && !/[<>\u0000-\u001f]/u.test(value));
}
function bounded(value: unknown): asserts value is number {
  check(typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e6);
}
function domain(value: unknown): asserts value is [number, number] {
  check(Array.isArray(value) && value.length === 2); value.forEach(bounded);
  check(value[1] - value[0] >= 1e-6);
}
export interface CompiledFunction {
  canonical: string;
  evaluate: (value: number) => number;
  /** Conservative domain check for fills: never shade across a pole or undefined interval. */
  continuousOn: (from: number, to: number) => boolean;
}
/** Tolerate a small set of mathematical spelling variants at the plot boundary.
 * The result still goes through the same bounded arithmetic AST; no identifiers
 * are split, and no JavaScript, assignments or unknown LaTeX commands run. */
function plotExpressionNotation(source: string, variable: string, parameters: Record<string, number> = {}): string {
  check(source.length > 0 && source.length <= 400);
  let text = source.trim();
  if (text.startsWith('$$') && text.endsWith('$$')) text = text.slice(2, -2);
  else if (text.startsWith('$') && text.endsWith('$')) text = text.slice(1, -1);
  else if (text.startsWith('\\(') && text.endsWith('\\)') || text.startsWith('\\[') && text.endsWith('\\]')) text = text.slice(2, -2);
  text = text.replace(/[\u2212\ufe63\uff0d]/gu, '-').replace(/[\u00d7\u00b7\u22c5]/gu, '*').replace(/\u00f7/gu, '/')
    .replace(/\\(?:left|right)\b/gu, '').replace(/\\(?:cdot|times)\b/gu, '*')
    .replace(/\\(?:quad|qquad)\b|\\[,;!:\s]/gu, ' ')
    .replace(/\\([A-Za-z]+)\b/gu, (original, name: string) => own(FUNCTIONS, name) || name === 'pi' ? name : name === 'ln' ? 'log' : original)
    .replace(/\*\*/gu, '^').replace(/\{/gu, '(').replace(/\}/gu, ')');
  const superscripts: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-' };
  text = text.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+/gu, exponent => `^(${[...exponent].map(char => superscripts[char]).join('')})`);
  const tokens = text.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z][A-Za-z0-9_]*|[()+\-*/^]|\S/gu) || [];
  check(tokens.length <= 150);
  const number = (token: string) => /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(token);
  const symbol = (token: string) => token === variable || own(parameters, token) || token === 'pi' || token === 'e';
  const output: string[] = [], division = [false];
  for (const [index, token] of tokens.entries()) {
    const previous = tokens[index - 1];
    if (previous !== undefined && (number(previous) || symbol(previous) || previous === ')')
      && (symbol(token) || own(FUNCTIONS, token) || token === '(' || previous === ')' && number(token))) {
      // 1/2x can mean either (1/2)*x or 1/(2*x); parentheses are
      // required rather than silently selecting a denominator boundary.
      check(!division.at(-1), '除法后的隐式乘法有歧义，请用显式乘号和括号标明分母');
      output.push('*');
    }
    output.push(token);
    if (token === '(') division.push(false);
    else if (token === ')') { if (division.length > 1) division.pop(); }
    else if (token === '/') division[division.length - 1] = true;
    else if ((token === '+' || token === '-') && previous !== undefined && (number(previous) || symbol(previous) || previous === ')')) division[division.length - 1] = false;
  }
  return output.join(' ');
}
export function compileTextbookFunction(source: string, variable: string, parameters: Record<string, number> = {}): CompiledFunction {
  check(typeof source === 'string' && source.length > 0 && source.length <= 400);
  const tokens = source.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z][A-Za-z0-9_]*|[()+\-*/^]|\S/gu) || [];
  check(tokens.length <= 150); let cursor = 0;
  const expression = (minimum = 0, depth = 0): Expr => {
    check(depth < 24); const token = tokens[cursor++]; let left: Expr;
    if (token === '+' || token === '-') { const value = expression(25, depth + 1); left = token === '-' ? { kind: 'unary', value } : value; }
    else if (token === '(') { left = expression(0, depth + 1); check(tokens[cursor++] === ')'); }
    else if (/^(?:\d|\.)/u.test(token || '')) { const value = Number(token); bounded(value); left = { kind: 'number', value }; }
    else if (token === variable) left = { kind: 'variable' };
    else if (own(parameters, token)) left = { kind: 'number', value: parameters[token] };
    else if (token === 'pi' || token === 'e') left = { kind: 'number', value: token === 'pi' ? Math.PI : Math.E };
    else if (own(FUNCTIONS, token)) { check(tokens[cursor++] === '('); const value = expression(0, depth + 1); check(tokens[cursor++] === ')'); left = { kind: 'call', name: token, value }; }
    else throw new Error('存在未指定的变量、隐式乘法或不支持的函数；支持 sin/cos/tan、asin/acos/atan（或 arc 前缀）、exp/log/sqrt/abs');
    while (cursor < tokens.length) {
      const op = tokens[cursor], priority = ({ '+': 10, '-': 10, '*': 20, '/': 20, '^': 30 } as Record<string, number>)[op];
      if (priority === undefined || priority < minimum) break;
      cursor++; const right = expression(op === '^' ? priority : priority + 1, depth + 1);
      left = { kind: 'binary', op, left, right };
    }
    return left;
  };
  // A declared input may have a constant output (e.g. y=3); this is still a function.
  const ast = expression(); check(cursor === tokens.length, '表达式包含不支持的内容');
  const emit = (node: Expr): string => {
    if (node.kind === 'number') return `(${node.value})`;
    if (node.kind === 'variable') return 'x';
    if (node.kind === 'unary') return `(-${emit(node.value)})`;
    if (node.kind === 'call') return `${node.name}(${emit(node.value)})`;
    return `(${emit(node.left)}${node.op}${emit(node.right)})`;
  };
  const evaluate = (node: Expr, x: number): number => {
    if (node.kind === 'number') return node.value;
    if (node.kind === 'variable') return x;
    if (node.kind === 'unary') return -evaluate(node.value, x);
    if (node.kind === 'call') { const value = evaluate(node.value, x); return Number.isFinite(value) ? FUNCTIONS[node.name](value) : NaN; }
    const a = evaluate(node.left, x), b = evaluate(node.right, x);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
    if (node.op === '^' && a === 0 && b === 0 && node.right.kind !== 'number') return NaN;
    return node.op === '+' ? a + b : node.op === '-' ? a - b : node.op === '*' ? a * b : node.op === '/' ? a / b : a ** b;
  };
  type Range = [number, number];
  const extent = (node: Expr, input: Range): Range => {
    if (node.kind === 'number') return [node.value, node.value];
    if (node.kind === 'variable') return input;
    if (node.kind === 'unary') { const [a, b] = extent(node.value, input); return [-b, -a]; }
    if (node.kind === 'call') {
      const [a, b] = extent(node.value, input), fn = FUNCTIONS[node.name];
      if (node.name === 'sin' || node.name === 'cos') return [-1, 1];
      if (node.name === 'tan') { check(Math.abs(Math.cos(a)) > 1e-10 && Math.abs(Math.cos(b)) > 1e-10 && Math.floor((a + Math.PI / 2) / Math.PI) === Math.floor((b + Math.PI / 2) / Math.PI)); return [fn(a), fn(b)]; }
      if (node.name === 'log') check(a > 0);
      if (node.name === 'sqrt') check(a >= 0);
      if (['asin', 'acos', 'arcsin', 'arccos'].includes(node.name)) check(a >= -1 && b <= 1);
      if (node.name === 'abs') return [a <= 0 && b >= 0 ? 0 : Math.min(Math.abs(a), Math.abs(b)), Math.max(Math.abs(a), Math.abs(b))];
      // acos/arccos decrease; interval bounds must remain ordered for enclosing
      // expressions (notably division and continuity checks used by area fills).
      return [Math.min(fn(a), fn(b)), Math.max(fn(a), fn(b))];
    }
    const [a, b] = extent(node.left, input), [c, d] = extent(node.right, input);
    if (node.op === '+') return [a + c, b + d];
    if (node.op === '-') return [a - d, b - c];
    if (node.op === '/') check(c > 0 || d < 0);
    if (node.op === '^') {
      // Negative bases are continuous only for a fixed integer exponent. A
      // variable exponent or a non-integer exponent needs a nonnegative base;
      // zero additionally requires the entire exponent interval to be positive.
      const fixedInteger = c === d && Number.isInteger(c);
      if (fixedInteger) {
        if (c < 0) check(a > 0 || b < 0);
        if (c === 0 && node.right.kind !== 'number') check(a > 0 || b < 0);
        const values = [a ** c, b ** c];
        if (c > 0 && a <= 0 && b >= 0) values.push(0);
        return [Math.min(...values), Math.max(...values)];
      }
      check(a >= 0 && (a > 0 || c > 0));
      const values = [a ** c, a ** d, b ** c, b ** d];
      if (a <= 1 && b >= 1) values.push(1);
      return [Math.min(...values), Math.max(...values)];
    }
    const values = node.op === '*' ? [a * c, a * d, b * c, b * d]
      : [a / c, a / d, b / c, b / d];
    return [Math.min(...values), Math.max(...values)];
  };
  return { canonical: emit(ast), evaluate: value => evaluate(ast, value), continuousOn: (a, b) => {
    try { return extent(ast, [a, b]).every(Number.isFinite); } catch { return false; }
  } };
}
export interface TextbookFunctionPlot {
  title: string; variable: string; xLabel: string; yLabel: string; xDomain: [number, number]; yDomain: [number, number];
  parameters?: Record<string, number>;
  /** Explicit clipping remains available for asymptotes or a chosen local view. */
  yRange?: 'auto' | 'fixed';
  curves: Array<{ id: string; label: string; expression: string }>;
  area?: { curveId: string; from: number; to: number };
  riemann?: { curveId: string; from: number; to: number; count: number; method: 'left' | 'midpoint' | 'right' };
}
export function parseFunctionPlot(code: string): TextbookFunctionPlot {
  check(code.length <= 6000); const value: unknown = JSON.parse(code);
  object(value, ['title', 'variable', 'xLabel', 'yLabel', 'xDomain', 'yDomain', 'yRange', 'parameters', 'curves', 'area', 'riemann']);
  // An empty optional parameter list carries no values; accept older output
  // without loosening validation for unknown names or nonempty arrays.
  if (Array.isArray(value.parameters) && value.parameters.length === 0) value.parameters = {};
  check(value.yRange === undefined || value.yRange === 'auto' || value.yRange === 'fixed');
  label(value.title); label(value.xLabel); label(value.yLabel);
  check(typeof value.variable === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,15}$/u.test(value.variable)
    && !own(FUNCTIONS, value.variable) && !['pi', 'e', 'constructor', 'prototype'].includes(value.variable));
  domain(value.xDomain); domain(value.yDomain);
  if (value.parameters !== undefined) {
    check(!!value.parameters && typeof value.parameters === 'object' && !Array.isArray(value.parameters));
    check(Object.keys(value.parameters).length <= 8);
    for (const [key, number] of Object.entries(value.parameters)) {
      check(/^[A-Za-z][A-Za-z0-9_]{0,15}$/u.test(key) && key !== value.variable && !own(FUNCTIONS, key) && !['pi', 'e', 'constructor', 'prototype'].includes(key)); bounded(number);
    }
  }
  check(Array.isArray(value.curves) && value.curves.length >= 1 && value.curves.length <= 4);
  const ids = new Set<string>();
  for (const curve of value.curves) {
    object(curve, ['id', 'label', 'expression']); label(curve.label);
    check(typeof curve.id === 'string' && /^[a-zA-Z0-9_-]{1,32}$/u.test(curve.id) && !ids.has(curve.id)); ids.add(curve.id);
    check(typeof curve.expression === 'string');
    let fn: CompiledFunction;
    try { fn = compileTextbookFunction(curve.expression, value.variable, value.parameters as Record<string, number>); }
    catch {
      const expression = plotExpressionNotation(curve.expression, value.variable, value.parameters as Record<string, number>);
      fn = compileTextbookFunction(expression, value.variable, value.parameters as Record<string, number>);
      curve.expression = expression;
    }
    const [from, to] = value.xDomain, [bottom, top] = value.yDomain;
    // Displayability only: avoid publishing an empty frame for a wholly undefined
    // or off-screen curve. This does not assert anything about formula correctness.
    check(Array.from({ length: 65 }, (_, i) => fn.evaluate(from + (to - from) * i / 64))
      .some(y => Number.isFinite(y) && y >= bottom && y <= top)
      || value.yRange !== 'fixed' && fn.continuousOn(from, to) && [fn.evaluate(from),fn.evaluate(to)].every(y => Number.isFinite(y) && Math.abs(y) <= 1e6), '指定窗口内没有可绘制的函数值');
  }
  for (const field of ['area', 'riemann'] as const) {
    const fill = value[field]; if (fill === undefined) continue;
    object(fill, field === 'area' ? ['curveId', 'from', 'to'] : ['curveId', 'from', 'to', 'count', 'method']);
    check(typeof fill.curveId === 'string' && ids.has(fill.curveId)); bounded(fill.from); bounded(fill.to);
    check(fill.from < fill.to && fill.from >= value.xDomain[0] && fill.to <= value.xDomain[1]);
    if (field === 'riemann') check(Number.isInteger(fill.count) && (fill.count as number) >= 2 && (fill.count as number) <= 80 && ['left', 'midpoint', 'right'].includes(fill.method as string));
    const curve = value.curves.find(curve => curve.id === fill.curveId)!;
    check(compileTextbookFunction(curve.expression, value.variable, value.parameters as Record<string, number>).continuousOn(fill.from, fill.to), '不在不连续/未定义区间绘制面积或黎曼矩形');
  }
  return fitFunctionPlotYDomain(value as unknown as TextbookFunctionPlot);
}
/** One bounded pass when a plot is prepared, never while scrolling. Only
 * continuous, finite curves may expand the view; poles keep the given window. */
export function fitFunctionPlotYDomain(plot: TextbookFunctionPlot): TextbookFunctionPlot {
  if (plot.yRange === 'fixed') return plot;
  let low=plot.yDomain[0], high=plot.yDomain[1];
  for (const curve of plot.curves) {
    const fn=compileTextbookFunction(curve.expression,plot.variable,plot.parameters), [from,to]=plot.xDomain;
    if (!fn.continuousOn(from,to)) continue;
    const values=Array.from({length:257},(_,i)=>fn.evaluate(from+(to-from)*i/256));
    if (!values.every(y=>Number.isFinite(y)&&Math.abs(y)<=1e6)) continue;
    low=Math.min(low,...values);high=Math.max(high,...values);
  }
  if (low===plot.yDomain[0]&&high===plot.yDomain[1]) return plot;
  const padding=(high-low)*.04;
  return {...plot,yDomain:[Math.max(-1e6,low-padding),Math.min(1e6,high+padding)]};
}
/** Optional format errors never become chapter repair requests; original fence stays editable. */
export function optionalFunctionPlot(code: string): TextbookFunctionPlot | null {
  try { return parseFunctionPlot(code); } catch { return null; }
}
export function riemannRectangles(plot: TextbookFunctionPlot, count = plot.riemann?.count || 8, method = plot.riemann?.method || 'midpoint') {
  const spec = plot.riemann; check(spec && Number.isInteger(count) && count >= 2 && count <= 80 && ['left', 'midpoint', 'right'].includes(method));
  const curve = plot.curves.find(curve => curve.id === spec.curveId)!;
  const fn = compileTextbookFunction(curve.expression, plot.variable, plot.parameters), dx = (spec.to - spec.from) / count;
  const rectangles = Array.from({ length: count }, (_, i) => {
    const left = spec.from + i * dx, sample = left + (method === 'left' ? 0 : method === 'right' ? dx : dx / 2), height = fn.evaluate(sample);
    check(Number.isFinite(height)); return { left, right: left + dx, sample, height };
  });
  return { rectangles, dx, signedSum: rectangles.reduce((sum, item) => sum + item.height * dx, 0), geometricSum: rectangles.reduce((sum, item) => sum + Math.abs(item.height) * dx, 0) };
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the production position/visibility closures using synthetic geometry.
// Browser parse/paint evidence is recorded separately; these are not paint tests.
const file = 'src/components/textbook/TextbookReader.tsx';
const source = readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
function expression(name: string, env: Record<string, unknown>) {
  let expression: ts.Expression | undefined;
  const walk = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) expression = node.initializer;
    if (name === 'restoreEffect' && ts.isCallExpression(node) && node.expression.getText(ast) === 'useLayoutEffect'
      && node.arguments[0].getText(ast).includes('const retained')) expression = node.arguments[0];
    ts.forEachChild(node, walk);
  }; walk(ast); assert.ok(expression, name);
  const js = ts.transpileModule(`return (${expression.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(env), js)(...Object.values(env));
}
let reads = 0;
const root = { scrollTop: 386950, getBoundingClientRect: () => ({ top: 10 }),
  querySelectorAll: () => Array.from({ length: 4096 }, (_, i) => ({ id: `chapter-${i}`,
    getBoundingClientRect: () => { reads++; return { top: i * 100 - root.scrollTop + 10 }; } })),
  querySelector: () => null };
const writes: string[] = [];
const env = { reader: { current: root }, pendingPosition: { current: undefined as any }, viewport: { current: undefined as any },
  timer: { current: undefined as number | undefined }, clearTimeout() {},
  callback: { current: () => { writes.push('old-project'); } }, note: { id: 'synthetic-A' }, manifest: { revisionId: 'r1' } };
const capture = expression('capturePosition', env), flush = expression('flushPosition', env);
capture();
assert.equal(env.pendingPosition.current.value.blockAnchor, 'chapter-3870');
assert.equal(env.viewport.current.scrollTop, 386950);
assert.ok(reads <= 13, `4096 headings should need logarithmic layout reads, got ${reads}`);
env.callback.current = () => { writes.push('new-project'); }; flush(); flush();
assert.deepEqual(writes, ['old-project'], 'a deferred position write belongs to its captured project callback');
console.log('PASS 4096章只读12次标题布局；最后阅读位置仍写回捕获时的项目，不串新回调');

let timeout = 0;
const restoreEnv = { ...env, active: true, savedPosition: { current: { revisionId: 'r1', scrollTop: 20 } },
  restoring: { current: false }, cancelRestore: { current: () => {} },
  requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout: () => ++timeout, clearTimeout() {}, ResizeObserver: undefined };
root.scrollTop = 0; // display:none may reset DOM scrollTop; the retained viewport must win.
let cleanup = expression('restoreEffect', restoreEnv)();
assert.equal(root.scrollTop, 386950); assert.equal(restoreEnv.restoring.current, true); cleanup();
restoreEnv.active = false; root.scrollTop = 0;
assert.equal(expression('restoreEffect', restoreEnv)(), undefined);
assert.equal(restoreEnv.viewport.current.scrollTop, 386950);
restoreEnv.active = true; restoreEnv.note = { id: 'synthetic-B' };
cleanup = expression('restoreEffect', restoreEnv)();
assert.equal(root.scrollTop, 20, 'another project cannot inherit the retained scrollTop'); cleanup();
restoreEnv.manifest = { revisionId: 'r2' }; root.scrollTop = 0;
assert.equal(expression('restoreEffect', restoreEnv)(), undefined);
assert.equal(root.scrollTop, 0, 'another revision cannot inherit a stale viewport');
console.log('PASS 保留阅读实例后恢复同项目/修订位置，隐藏时不记0，不把旧位置恢复到其它项目/修订');

// Exercise the reader's real leading/trailing reporter with a fake clock, not
// just App's callback (which misses a reader-level trailing-debounce starvation).
{
  let now = 0, serial = 0;
  const timers = new Map<number, { at: number; work: () => void }>();
  const reports: Array<{ at: number; top: number }> = [];
  const reading = { ...env, active: true, restoring: { current: false }, timer: { current: undefined as number | undefined },
    callback: { current: (position: any) => reports.push({ at: now, top: position.scrollTop }) },
    pendingPosition: { current: undefined as any }, viewport: { current: undefined as any },
    setTimeout(work: () => void, delay: number) { timers.set(++serial, { at: now + delay, work }); return serial; },
    clearTimeout(id: number) { timers.delete(id); },
  };
  const advance = (target: number) => {
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      now = next[1].at; timers.delete(next[0]); next[1].work();
    }
    now = target;
  };
  const productionFlush = expression('flushPosition', reading);
  const productionScroll = expression('scroll', { ...reading, flushPosition: productionFlush,
    capturePosition: expression('capturePosition', reading) });
  for (let time = 0; time <= 10000; time += 100) {
    advance(time); root.scrollTop = time; productionScroll();
    assert.ok(timers.size <= 1, 'only one bounded report timer');
  }
  assert.equal(reports[0].at, 0, 'first scroll reports immediately for exit protection');
  assert.ok(reports.length >= 50, 'ten seconds of scrolling cannot starve reports');
  assert.ok(reports.at(-1)!.at >= 9800);
  advance(10180); assert.equal(reports.at(-1)!.top, 10000); assert.equal(timers.size, 0);
  const count = reports.length; advance(20000); assert.equal(reports.length, count, 'no polling when reader is idle');
  reading.active = false;
  expression('scroll', { ...reading, flushPosition: productionFlush, capturePosition: () => assert.fail('hidden capture') })();
  assert.equal(reports.length, count);
  // The capture-phase close listener flushes before App reads its pending ref.
  const listeners = new Map<string, () => void>(); let beforeUnloadEffect: ts.Expression | undefined;
  const find = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0].getText(ast).includes("window.addEventListener('beforeunload'")) beforeUnloadEffect = node.arguments[0];
    ts.forEachChild(node, find);
  }; find(ast); assert.ok(beforeUnloadEffect);
  const js = ts.transpileModule(`return (${beforeUnloadEffect.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const closeEffect = new Function('window', 'flushPosition', 'registerPendingCapture', js)({
    addEventListener(name: string, work: () => void, capture: boolean) { assert.equal(capture, true); listeners.set(name, work); },
    removeEventListener(name: string, _work: () => void, capture: boolean) { assert.equal(capture, true); listeners.delete(name); },
  }, productionFlush, () => () => {});
  const release = closeEffect(); reading.pendingPosition.current = { value: { scrollTop: 123 }, callback: reading.callback.current };
  listeners.get('beforeunload')!(); assert.equal(reports.at(-1)!.top, 123); assert.equal(reading.pendingPosition.current, undefined);
  release(); assert.equal(listeners.size, 0);
  console.log('PASS 连续10秒滚动：首次即时上报、固定180ms窗口汇报最新位置；空闲零轮询、隐藏不捕获，关闭前先冲刷缓冲');
}

assert.match(source, /const ParsedTextbookMarkdown = React\.memo/);
assert.match(source, /<ParsedTextbookMarkdown body=\{body\} sections=\{sections\} manifest=\{manifest\}/);
assert.match(source, /opened && <ul>/);
assert.match(source, /onOpenDocument: onOpenDocument \?/);
const reference = readFileSync('src/components/textbook/SourceReference.tsx', 'utf8');
assert.match(reference, /if \(!active && opened\) close\(\)/);
assert.match(reference, /active && opened && typeof document/);
const plot = readFileSync('src/components/textbook/FunctionPlotBlock.tsx', 'utf8');
const background = readFileSync('src/components/textbook/BackgroundTextbookVisual.tsx', 'utf8');
assert.match(plot, /<BackgroundTextbookVisual kind="function-plot"/);
assert.match(background, /new ResizeObserver\(/);
assert.match(background, /observer\.observe\(element\)/);
assert.match(background, /if \(!enabled \|\| !width \|\| ready\) return/);
assert.match(background, /next >= 80 \?[^\n]+ : 0/);
assert.match(background, /observer\.disconnect\(\)/);
console.log('PASS 固定正文解析与实时来源上下文分离，折叠参考列表按需挂载；隐藏函数图由ResizeObserver恢复，不无限轮询');

import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { MathLiveAnswer } from '../src/components/quickCheck/MathLiveAnswer';
import { answerPreviewParts, bareAnswerFormula, insertAnswerFormula } from '../src/components/quickCheck/mathAnswer';

let checks = 0;
function pass(name: string) { checks++; console.log(`PASS ${name}`); }

// Keep the dialog-local keyboard in normal document flow. MathLive itself has
// no layout engine in these Node fixtures, so check the installed CSS contract
// and our narrowly scoped override; a browser test still verifies real geometry
// and pointer input. Do not fix this with a global .ML__keyboard height rule:
// that would change the default body-hosted S4 keyboard as well.
function declarationsFor(css: string, wanted: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    if (!rule[1].trim().split(',').some(selector => selector.trim() === wanted)) continue;
    for (const declaration of rule[2].split(';')) {
      const separator = declaration.indexOf(':');
      if (separator > 0) declarations.set(declaration.slice(0, separator).trim(), declaration.slice(separator + 1).trim());
    }
  }
  return declarations;
}

// Run the actual component callbacks with synthetic React hooks. This catches
// reentrant blur saves during parent updates/focus restoration, not just markup.
function answerHarness() {
  const path = 'src/components/quickCheck/MathLiveAnswer.tsx';
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const body = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source)).join('\n').replace(/^export\s+/gm, '');
  const code = ts.transpileModule(`${body}\nreturn MathLiveAnswer;`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const all = (node: any): any[] => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(all) : [node, ...all(node.props?.children)];
  let cursor = 0, tree: any[] = [], oldField: any;
  const slots: any[] = [], effects: (() => void)[] = [];
  const draftWrites: string[] = [];
  const textarea = { selectionStart: 2, selectionEnd: 2, focus() { oldField?.onDraftSave('late-blur'); }, setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; } };
  const props = { id: 'sequence-fixture', value: '文字', formulaDraft: 'a+b', onChange: (value: string) => {
    props.value = value;
    oldField?.onDraftSave('reentrant-parent-update');
  }, onFormulaDraftChange: (latex: string) => { props.formulaDraft = latex; draftWrites.push(latex); } };
  const environment = {
    React: { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) },
    useRef: (initial: any) => { const index = cursor++; return slots[index] ||= { current: initial }; },
    useState: (initial: any) => { const index = cursor++; slots[index] ||= { value: initial }; return [slots[index].value, (next: any) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }]; },
    useEffect: (callback: () => void, dependencies: any[]) => { const index = cursor++; if (!slots[index] || dependencies.some((value, i) => value !== slots[index].dependencies[i])) {
      slots[index] = { dependencies }; effects.push(callback);
    } },
    useDialog: () => {}, MathField: 'MathField', FormulaBlock: 'FormulaBlock', answerPreviewParts, insertAnswerFormula,
  };
  const Component = new Function(...Object.keys(environment), code)(...Object.values(environment));
  const render = () => { cursor = 0; tree = all(Component(props)); for (const node of tree) {
    if (node.type === 'textarea') node.props.ref.current = textarea;
    if (node.props?.className === 'quick-check-rendered-answer') node.props.ref.current = { focus() { oldField?.onDraftSave('late-rendered-blur'); } };
  } effects.splice(0).forEach(callback => callback()); };
  const find = (predicate: (node: any) => boolean) => { const node = tree.find(predicate); assert.ok(node); return node.props; };
  const field = () => find(node => node.type === 'MathField');
  const button = (text: string) => find(node => node.type === 'button' && node.props.children.includes(text));
  render();
  return { props, draftWrites, render, field, button, textarea, captureOld: () => { oldField = field(); return oldField; } };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('No live network in MathLive answer fixtures'); };
try {
  const installedMathLive = readFileSync(new URL('../node_modules/mathlive/mathlive.mjs', import.meta.url), 'utf8');
  const packageCss = installedMathLive.split('var virtual_keyboard_default = `')[1]?.split('`;')[0];
  assert.ok(packageCss, 'review keyboard geometry integration if the installed MathLive CSS contract changes');
  assert.equal(declarationsFor(packageCss, '.ML__keyboard').get('height'), '100%');
  assert.equal(declarationsFor(packageCss, '.ML__keyboard').get('overflow'), 'hidden');
  assert.equal(declarationsFor(packageCss, '.MLK__backdrop').get('position'), 'absolute');
  assert.equal(declarationsFor(packageCss, '.MLK__backdrop').get('height'), 'var(--_keyboard-height)');
  assert.match(installedMathLive, /else this\._element\.style\.setProperty\("--_keyboard-height", `\$\{h\}px`\)/u,
    'non-body keyboard host must receive MathLive measured plate height');
  const localCss = readFileSync('src/components/quickCheck/mathLiveAnswer.css', 'utf8');
  const localSelector = '.quick-check-math-keyboard > .ML__keyboard.is-visible';
  const visibleKeyboard = declarationsFor(localCss, localSelector);
  assert.equal(visibleKeyboard.get('height'), 'var(--_keyboard-height)',
    'visible modal keyboard must reserve measured height instead of collapsing into a zero-height clipped parent');
  assert.equal(visibleKeyboard.get('margin-top'), '.65rem');
  assert.equal(declarationsFor(localCss, '.quick-check-math-keyboard').get('position'), 'relative');
  for (const rule of localCss.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    for (const selector of rule[1].trim().split(',')) {
      if (selector.includes('.ML__keyboard')) assert.equal(selector.trim(), localSelector,
        'the height repair must not select a hidden or default body-hosted S4 keyboard');
    }
  }
  assert.equal(declarationsFor(localCss, '.ML__keyboard').size, 0);
  assert.equal(declarationsFor(localCss, 'body > .ML__keyboard').size, 0);
  pass('局部键盘以 MathLive 测量高度占位，防零高度裁切，且不覆盖隐藏键盘或默认 S4 宿主');

  assert.deepEqual(insertAnswerFormula('由此可得结论', '\\frac{1}{2}', { start: 4, end: 4 }), {
    ok: true, value: '由此可得$\\frac{1}{2}$结论', cursor: 17,
  });
  const replacement = insertAnswerFormula('前文错误公式后文', 'x^2', { start: 2, end: 6 });
  assert.deepEqual(replacement, { ok: true, value: '前文$x^2$后文', cursor: 7 });
  assert.deepEqual(insertAnswerFormula('abc', 'x', { start: -3, end: 99 }), { ok: true, value: '$x$', cursor: 3 });
  pass('公式在 textarea 当前光标插入或替换选区，前后原文保持不变');

  assert.deepEqual(insertAnswerFormula('前后', '\\sum_{i=1}^n i', { start: 1, end: 1 }, true), {
    ok: true, value: '前\n$$\n\\sum_{i=1}^n i\n$$\n后', cursor: 23,
  });
  for (const latex of ['$x$', '$$x$$', '\\(x\\)', '\\[x\\]']) assert.equal(bareAnswerFormula(latex), 'x');
  for (const latex of ['', '   ', '$$', '\\placeholder{}']) assert.equal(insertAnswerFormula('保留', latex, { start: 0, end: 0 }).ok, false);
  pass('行内/独立公式不重复包裹分隔符，空公式与空占位不会插入');

  const long = '字'.repeat(3999);
  const rejected = insertAnswerFormula(long, 'x', { start: long.length, end: long.length });
  assert.equal(rejected.ok, false); if (rejected.ok === false) assert.match(rejected.error, /原文和公式草稿均未删减/u);
  assert.equal(long.length, 3999);
  assert.deepEqual(insertAnswerFormula('12345', 'x', { start: 0, end: 5 }, false, 5), { ok: true, value: '$x$', cursor: 3 });
  pass('超限拒绝但不截断，精简或替换原文后可重新插入');

  const parts = answerPreviewParts('先算 $a+b$，再得\n$$x^2$$\n结论');
  assert.deepEqual(parts, [
    { kind: 'text', value: '先算 ' }, { kind: 'formula', value: 'a+b', display: false },
    { kind: 'text', value: '，再得\n' }, { kind: 'formula', value: 'x^2', display: true }, { kind: 'text', value: '\n结论' },
  ]);
  assert.deepEqual(answerPreviewParts('只有 \\$ 和 $未闭合'), [{ kind: 'text', value: '只有 \\$ 和 $未闭合' }]);
  pass('预览只拆文字和显式公式，不解释 HTML 或未闭合的分隔符');

  const props = { id: 'fixture-answer', value: '', onChange: () => {}, formulaDraft: '', onFormulaDraftChange: () => {} };
  const plain = renderToStaticMarkup(<MathLiveAnswer {...props} />);
  assert.match(plain, /<textarea[^>]*id="fixture-answer"[^>]*maxLength="4000"/u);
  assert.match(plain, /for="fixture-answer"/u);
  assert.match(plain, /aria-expanded="false"/u); assert.match(plain, /插入公式/u);
  assert.doesNotMatch(plain, /<math-field/u);
  const saved = renderToStaticMarkup(<MathLiveAnswer {...props} formulaDraft="\\frac{1}{2}" />);
  assert.match(saved, /role="dialog"/u); assert.match(saved, /取消公式/u); assert.match(saved, /插入回答/u);
  assert.match(saved, /quick-check-math-keyboard/u); assert.match(saved, /公式草稿已保留/u);
  const unsafe = renderToStaticMarkup(<MathLiveAnswer {...props} value={'<script>alert(1)</script> $x^2$'} />);
  assert.doesNotMatch(unsafe, /<script>/u); assert.match(unsafe, /&lt;script&gt;/u); assert.match(unsafe, /你的回答（公式已渲染）/u); assert.match(unsafe, /class="katex"/u);
  assert.doesNotMatch(unsafe, /<textarea|<details/u, 'saved formulas render in the main answer, not a collapsed preview or a source textarea');
  assert.match(unsafe, /编辑回答/u);
  pass('实际组件保留无障碍文字输入、草稿入口与安全 KaTeX 预览，SSR不加载 MathLive');

  const sequence = answerHarness();
  const oldEditor = sequence.captureOld();
  sequence.button('插入回答').onClick();
  assert.equal(sequence.props.value, '文字$a+b$'); assert.equal(sequence.props.formulaDraft, '');
  sequence.render(); // Restored rendered-answer focus emits another old blur save.
  oldEditor.onInputDraft('late-input'); oldEditor.onDraftSave('late-save');
  assert.equal(sequence.props.formulaDraft, ''); assert.deepEqual(sequence.draftWrites, ['']);
  sequence.button('编辑回答').onClick(); sequence.render();
  assert.equal(sequence.textarea.selectionStart, '文字$a+b$'.length, 'returning to editing restores the insertion cursor');
  sequence.button('完成编辑').onClick(); sequence.render();
  sequence.button('插入公式').onClick(); sequence.render();
  sequence.field().onInputDraft('c+d'); sequence.render();
  assert.equal(sequence.props.formulaDraft, 'c+d', 'a deliberate new editor session accepts input again');
  const cancellingEditor = sequence.field(); sequence.button('取消公式').onClick();
  cancellingEditor.onDraftSave('blur-after-cancel'); cancellingEditor.onInputDraft('input-after-cancel');
  sequence.render();
  assert.equal(sequence.props.formulaDraft, ''); assert.equal(sequence.props.value, '文字$a+b$');
  pass('实际组件插入/取消先失效旧回调：父更新、焦点恢复和晚到 blur/input 不会复活草稿，新编辑仍可输入');
  console.log(`Quick-check math answer checks passed: ${checks}`);
} finally { globalThis.fetch = originalFetch; }

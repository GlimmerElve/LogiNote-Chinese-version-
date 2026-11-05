import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute the actual component and loader; only React hooks, DOM and package imports are synthetic.
const path = 'src/modules/derivationCanvas/components/MathField.tsx';
const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const body = source.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(source)).join('\n')
  .replace(/^export\s+/gm, '').replace("import('mathlive/fonts.css')", 'loadFonts()').replace("import('mathlive')", 'loadEditor()');
const canvasSource = ts.createSourceFile('canvas.tsx', readFileSync('src/modules/derivationCanvas/DerivationCanvas.tsx', 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
let draftHandler: ts.PropertyAssignment | undefined;
const visit = (n: ts.Node) => {if (ts.isPropertyAssignment(n) && n.name.getText(canvasSource) === 'onDraftSave') draftHandler = n; ts.forEachChild(n, visit);};
visit(canvasSource); assert.ok(draftHandler);
assert.match(draftHandler.getText(canvasSource), /status:\s*'draft',\s*verification:\s*undefined/, 'edited formulas must not display prior verification');
const code = ts.transpileModule(`${body}\nreturn MathField;`, { compilerOptions: {jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None} }).outputText;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const all = (n: any): any[] => !n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(all) : [n, ...all(n.props?.children)];
class DomNode { inside?: DomNode; isButton = false; contains(other: any) { return other?.inside === this; }
  closest(selector: string) {return selector === 'button' && this.isButton ? this : null;} focus() {doc.activeElement = this;} }
class Field extends DomNode {
  value = ''; removed = false; attrs: Record<string, string> = {}; events = new Map<string, any>();
  addEventListener(name: string, fn: any) { this.events.set(name, fn); }
  removeEventListener(name: string) { this.events.delete(name); }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  focus() { doc.activeElement = this; } remove() { this.removed = true; }
}
const doc: any = {activeElement: null, createElement: () => new Field()};
function harness(loadFonts: () => Promise<any> = async () => {}, delayedFrames = false) {
  let cursor = 0, tree: any[], props: any, live = true, afterUnmount = 0, loads = 0;
  const slots: any[] = [], effects: any[] = [], cleanups: any[] = [], fields: Field[] = [], saved: string[] = [], inputs: string[] = [];
  const animationFrames = new Map<number, () => void>(); let lastFrame = 0;
  const keyboard = { container: new DomNode(), hides: 0, hide() { this.hides++; } };
  const wrapper = new DomNode(), host = {appendChild(field: Field) {field.inside = wrapper; fields.push(field);}};
  const staticSurface = new DomNode();
  let exits = 0, edits = 0;
  const hooks = {
    useRef(initial: any) {const i = cursor++; return slots[i] ||= {current: initial};},
    useState(initial: any) {const i = cursor++; slots[i] ||= {value: initial}; return [slots[i].value, (next: any) => {
      if (!live) afterUnmount++; slots[i].value = typeof next === 'function' ? next(slots[i].value) : next;
    }];}, useCallback(fn: any) {cursor++; return fn;},
    useEffect(fn: any, deps: any[]) {const i = cursor++; if (!slots[i] || deps.some((v,j) => v !== slots[i].deps[j])) {
      slots[i] = {deps}; effects.push(() => {cleanups[i]?.(); cleanups[i] = fn();});
    }},
  };
  const env = {...hooks, React: {createElement: (type: any, props: any, ...children: any[]) => ({type, props: {...props, children}})},
    Node: DomNode, HTMLElement: DomNode, document: doc, window: { mathVirtualKeyboard: keyboard },
    requestAnimationFrame: (fn: any) => {
      if (!delayedFrames) { fn(); return 0; }
      const frame = ++lastFrame; animationFrames.set(frame, fn); return frame;
    }, cancelAnimationFrame: (frame: number) => animationFrames.delete(frame),
    katex: {renderToString: (text: string) => text}, hideVirtualKeyboard() {}, forceManualKeyboardPolicy() {},
    loadFonts: () => {loads++; return loadFonts();}, loadEditor: async () => {}};
  const Component = new Function(...Object.keys(env), code)(...Object.values(env));
  props = {value: 'x=1', editing: true, onDraftSave: (s: string) => saved.push(s), onInputDraft: (s: string) => inputs.push(s), onCancel: () => exits++, onRequestEdit: () => edits++};
  const render = () => {cursor = 0; tree = all(Component(props)); for (const n of tree) {
    if (n.props.ref && n.props.className === 'dc-mathfield') n.props.ref.current = host;
    if (n.props.ref && n.props.className?.includes('dc-mathfield-wrap')) n.props.ref.current = wrapper;
    if (n.props.ref && n.props.className?.startsWith('dc-math-static')) n.props.ref.current = staticSurface;
  } effects.splice(0).forEach(fn => fn());};
  const find = (test: (n: any) => boolean) => {const n = tree.find(test); assert.ok(n, 'requested UI rendered'); return n.props;};
  render(); render();
  return {render, fields, saved, inputs, keyboard, find, wrapper, staticSurface, get exits() {return exits;}, get edits() {return edits;}, get loads() {return loads;},
    get pendingFrames() {return animationFrames.size;}, flushFrames() {const frames = [...animationFrames.values()]; animationFrames.clear(); frames.forEach(fn => fn());},
    get afterUnmount() {return afterUnmount;}, update(next: any) {props = {...props, ...next}; render(); render();},
    unmount() {live = false; cleanups.forEach(fn => fn?.());}};
}
function key(key: string, options = {}) {return {key, shiftKey: false, isComposing: false, keyCode: 0, prevented: false,
  preventDefault() {this.prevented = true;}, stopPropagation() {}, ...options};}

const normal = harness(); await flush(); normal.render(); const field = normal.fields[0];
assert.equal(field.attrs['aria-label'], '公式输入'); field.value = 'x=2';
field.events.get('keydown')(key('Enter', {isComposing: true}));
field.events.get('keydown')(key('Enter', {keyCode: 229}));
assert.equal(normal.exits, 0, 'IME confirmation must not finish formula editing');
field.events.get('keydown')(key('Enter')); field.events.get('blur')({relatedTarget: null});
assert.deepEqual(normal.saved, ['x=2']); assert.equal(normal.exits, 1, 'Enter then blur finishes once without validation');
doc.activeElement = null; normal.update({editing: false, value: 'x=2'}); assert.equal(doc.activeElement, normal.staticSurface, 'explicit finish restores formula focus');
normal.update({editing: true}); await flush(); normal.render();
normal.fields[1].value = 'discarded'; normal.find(n => n.type === 'button' && n.props.children.includes('取消')).onClick();
normal.fields[1].events.get('blur')({relatedTarget: null}); assert.equal(normal.exits, 2); assert.deepEqual(normal.saved, ['x=2']);
normal.unmount();

const internal = harness(); await flush(); internal.render(); internal.fields[0].value = 'y=3';
const internalAction = new DomNode(); internalAction.inside = internal.wrapper;
internal.fields[0].events.get('blur')({relatedTarget: internalAction});
assert.equal(internal.exits, 0, 'Tab to editor actions must not prematurely save');
const wrap = internal.find(n => n.props.className?.includes('dc-mathfield-wrap'));
internalAction.isButton = true;
wrap.onKeyDown({...key('Enter'), target: internalAction, nativeEvent: key('Enter')});
assert.equal(internal.exits, 0, 'Enter on the cancel action must not be treated as save');
wrap.onBlur({relatedTarget: null, currentTarget: internal.wrapper}); assert.deepEqual(internal.saved, ['y=3']);
const outsideFocus = new DomNode(); outsideFocus.focus(); internal.update({editing: false, value: 'y=3'});
assert.equal(doc.activeElement, outsideFocus, 'outside blur must not steal the user focus');
internal.unmount();

let attempts = 0; const retry = harness(async () => {if (++attempts === 1) throw new Error('synthetic package load failure');});
await flush(); retry.render(); assert.match(retry.find(n => n.props.role === 'alert').children.join(''), /LaTeX/);
retry.find(n => n.type === 'textarea').onChange({target: {value: '\\frac{1}{2}'}});
retry.find(n => n.type === 'button' && n.props.children.includes('重试')).onClick(); retry.render(); await flush(); retry.render();
assert.equal(retry.loads, 2, 'a rejected module import is not permanently cached');
assert.equal(retry.fields[0].value, '\\frac{1}{2}', 'retry preserves fallback draft');
retry.find(n => n.type === 'button' && n.props.children.includes('暂存')).onClick();
assert.deepEqual(retry.saved, ['\\frac{1}{2}']); retry.unmount();

const fallback = harness(async () => {throw new Error('synthetic');}); await flush(); fallback.render();
fallback.find(n => n.type === 'textarea').onChange({target: {value: 'a+b'}});
fallback.find(n => n.type === 'button' && n.props.children.includes('暂存')).onClick(); assert.deepEqual(fallback.saved, ['a+b']); fallback.unmount();

const staticUi = harness(); staticUi.update({editing: false});
const staticProps = staticUi.find(n => n.props.role === 'button'); assert.equal(staticProps.tabIndex, 0);
staticProps.onKeyDown({...key('Enter'), nativeEvent: key('Enter')}); assert.equal(staticUi.edits, 1);
staticUi.update({value: 'f^{\\doubleprime}(x)'});
assert.equal(staticUi.find(n => Boolean(n.props.dangerouslySetInnerHTML)).dangerouslySetInnerHTML.__html, 'f^{\\prime\\prime}(x)');
staticUi.update({readOnly: true}); assert.equal(staticUi.find(n => n.props.className?.startsWith('dc-math-static')).role, undefined); staticUi.unmount();

let release!: () => void; const late = harness(() => new Promise<void>(resolve => {release = resolve;}));
late.unmount(); release(); await flush(); assert.equal(late.fields.length, 0); assert.equal(late.afterUnmount, 0);

const scoped = harness(); await flush(); scoped.render();
const previousContainer = scoped.keyboard.container;
const localHost = new DomNode(); scoped.update({keyboardContainer: localHost}); await flush(); scoped.render();
assert.equal(scoped.keyboard.container, localHost, 'modal editor owns a keyboard host inside its focus boundary');
const scopedField = scoped.fields.at(-1)!; scopedField.value = '\\sqrt{x}'; scopedField.events.get('input')();
assert.deepEqual(scoped.inputs, ['\\sqrt{x}']); assert.deepEqual(scoped.saved, [], 'live draft notification is not validation or canvas store save');
const keyboardKey = new DomNode(); keyboardKey.inside = localHost;
scopedField.events.get('blur')({relatedTarget: keyboardKey});
scoped.find(n => n.props.className?.includes('dc-mathfield-wrap')).onBlur({relatedTarget: keyboardKey, currentTarget: scoped.wrapper});
assert.equal(scoped.exits, 0, 'Tab or click into modal-local keyboard must not end formula input');
scoped.unmount(); assert.equal(scoped.keyboard.container, previousContainer); assert.equal(scoped.keyboard.hides, 1);

const transferred = harness(); await flush(); transferred.render();
const originalLocal = new DomNode(); transferred.update({keyboardContainer: originalLocal}); await flush(); transferred.render();
const otherOwner = new DomNode(); transferred.keyboard.container = otherOwner;
transferred.unmount(); assert.equal(transferred.keyboard.container, otherOwner); assert.equal(transferred.keyboard.hides, 0, 'cleanup must not hide or move another editor keyboard');

// Installed MathLive uses new Event('blur') / UIEvent('focusout'), so a virtual
// keyboard refocus can omit relatedTarget even though the user stays inside.
const transient = harness(undefined, true); await flush(); transient.render();
const transientHost = new DomNode(); transient.update({keyboardContainer: transientHost}); await flush(); transient.render(); transient.flushFrames();
const transientField = transient.fields.at(-1)!; transientField.value = '8';
const transientWrap = transient.find(n => n.props.className?.includes('dc-mathfield-wrap'));
const transientKey = new DomNode(); transientKey.inside = transientHost;
doc.activeElement = transientKey;
transientField.events.get('blur')({});
transientWrap.onBlur({relatedTarget: null, currentTarget: transient.wrapper});
assert.equal(transient.pendingFrames, 1, 'native synthetic blur and React focusout share one deferred decision');
assert.equal(transient.exits, 0); transient.flushFrames(); assert.equal(transient.exits, 0);
doc.activeElement = new DomNode(); transientField.events.get('blur')({relatedTarget: null});
assert.equal(transient.exits, 0); transientField.focus(); transient.flushFrames();
assert.equal(transient.exits, 0, 'transient focus loss followed by math-field refocus must keep the local keyboard open');
doc.activeElement = new DomNode(); transientField.events.get('blur')({relatedTarget: null});
transientWrap.onBlur({relatedTarget: null, currentTarget: transient.wrapper}); transient.flushFrames();
assert.equal(transient.exits, 1); assert.deepEqual(transient.saved, ['8'], 'actual outside blur still saves once');
assert.equal(transient.pendingFrames, 0); transient.unmount();

const cancelDeferred = harness(undefined, true); await flush(); cancelDeferred.render();
cancelDeferred.update({keyboardContainer: new DomNode()}); await flush(); cancelDeferred.render(); cancelDeferred.flushFrames();
doc.activeElement = new DomNode(); cancelDeferred.fields.at(-1)!.events.get('blur')({});
assert.equal(cancelDeferred.pendingFrames, 1);
cancelDeferred.find(n => n.type === 'button' && n.props.children.includes('取消')).onClick();
assert.equal(cancelDeferred.pendingFrames, 0); cancelDeferred.flushFrames();
assert.equal(cancelDeferred.exits, 1); assert.deepEqual(cancelDeferred.saved, [], 'explicit cancel invalidates the queued blur save');
cancelDeferred.unmount();

const unmountDeferred = harness(undefined, true); await flush(); unmountDeferred.render();
unmountDeferred.update({keyboardContainer: new DomNode()}); await flush(); unmountDeferred.render(); unmountDeferred.flushFrames();
doc.activeElement = new DomNode(); unmountDeferred.fields.at(-1)!.events.get('blur')({});
assert.equal(unmountDeferred.pendingFrames, 1); unmountDeferred.unmount();
assert.equal(unmountDeferred.pendingFrames, 0); unmountDeferred.flushFrames();
assert.equal(unmountDeferred.exits, 0); assert.deepEqual(unmountDeferred.saved, []);

const canvasBlur = harness(undefined, true); await flush(); canvasBlur.render(); canvasBlur.flushFrames();
canvasBlur.fields[0].value = 'canvas'; canvasBlur.fields[0].events.get('blur')({relatedTarget: null});
assert.equal(canvasBlur.exits, 1, 'default S4 null-target blur must remain synchronous');
assert.deepEqual(canvasBlur.saved, ['canvas']); assert.equal(canvasBlur.pendingFrames, 0); canvasBlur.unmount();
console.log('Scene formula editor UI regression passed: keyboard, IME, once-only save/cancel, internal focus, modal synthetic-blur deferral, unchanged S4 blur, failure fallback/retry, draft retention and late load protection.');

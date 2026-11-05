import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { acquireSingleInstance } from '../src/electron/singleInstance';

// Do not import main.ts or Electron: all lifecycle events and windows below are synthetic.
class FakeWindow {
  destroyed = false;
  minimized = false;
  readonly actions: string[] = [];

  isDestroyed(): boolean { return this.destroyed; }
  isMinimized(): boolean {
    assert.equal(this.destroyed, false, 'a destroyed window must not be queried for activation');
    return this.minimized;
  }
  restore(): void { this.actions.push('restore'); this.minimized = false; }
  show(): void { this.actions.push('show'); }
  focus(): void { this.actions.push('focus'); }
}

function harness(options: { primary?: boolean; window?: FakeWindow | null; guard?: boolean } = {}) {
  const events: string[] = [];
  const listeners: (() => void)[] = [];
  const exits: number[] = [];
  const state = { window: options.window ?? null, canActivate: true, reads: 0 };
  const instance = acquireSingleInstance({
    app: {
      requestSingleInstanceLock(): boolean { events.push('lock'); return options.primary ?? true; },
      on(event: 'second-instance', listener: () => void): unknown {
        events.push(`on:${event}`);
        listeners.push(listener);
        return undefined;
      },
      exit(code: number): void { events.push(`exit:${code}`); exits.push(code); },
    },
    getWindow: () => { state.reads++; return state.window; },
    ...(options.guard ? { canActivate: () => state.canActivate } : {}),
  });
  return { instance, events, exits, state, secondInstance: () => listeners.forEach(listener => listener()) };
}

let checks = 0;
function test(name: string, run: () => void): void {
  run();
  checks++;
  console.log('PASS', name);
}

test('lock failure exits immediately without listeners, window reads, or activation', () => {
  const window = new FakeWindow();
  const h = harness({ primary: false, window });
  assert.equal(h.instance.primary, false);
  assert.deepEqual(h.events, ['lock', 'exit:0']);
  assert.deepEqual(h.exits, [0]);
  h.secondInstance();
  h.instance.windowReady();
  h.instance.windowReady();
  assert.equal(h.state.reads, 0);
  assert.deepEqual(window.actions, []);
});

test('primary lock is acquired before its one listener; ordinary windowReady does nothing', () => {
  const window = new FakeWindow();
  const h = harness({ window });
  assert.equal(h.instance.primary, true);
  assert.deepEqual(h.events, ['lock', 'on:second-instance']);
  assert.deepEqual(h.exits, []);
  h.instance.windowReady();
  h.instance.windowReady();
  assert.equal(h.state.reads, 0, 'normal first startup must not be treated as a duplicate launch');
  assert.deepEqual(window.actions, []);
});

test('a normal duplicate launch shows and focuses the existing window', () => {
  const window = new FakeWindow();
  const h = harness({ window });
  h.secondInstance();
  assert.deepEqual(window.actions, ['show', 'focus']);
  h.instance.windowReady();
  assert.deepEqual(window.actions, ['show', 'focus'], 'an already handled event must not remain pending');
});

test('separate duplicates each activate the existing window without reacquiring the lock', () => {
  const window = new FakeWindow();
  const h = harness({ window });
  h.secondInstance();
  h.secondInstance();
  assert.deepEqual(window.actions, ['show', 'focus', 'show', 'focus']);
  assert.deepEqual(h.events, ['lock', 'on:second-instance']);
});

test('a minimized window is restored before show and focus', () => {
  const window = new FakeWindow();
  window.minimized = true;
  const h = harness({ window });
  h.secondInstance();
  assert.deepEqual(window.actions, ['restore', 'show', 'focus']);
});

test('multiple startup duplicates coalesce into one activation after window creation', () => {
  const h = harness();
  h.secondInstance();
  h.secondInstance();
  h.secondInstance();
  const window = new FakeWindow();
  h.state.window = window;
  assert.deepEqual(window.actions, []);
  h.instance.windowReady();
  assert.deepEqual(window.actions, ['show', 'focus']);
  h.instance.windowReady();
  assert.deepEqual(window.actions, ['show', 'focus']);
});

test('a premature windowReady preserves pending activation until a window exists', () => {
  const h = harness();
  h.secondInstance();
  h.instance.windowReady();
  h.instance.windowReady();
  const window = new FakeWindow();
  window.minimized = true;
  h.state.window = window;
  h.instance.windowReady();
  assert.deepEqual(window.actions, ['restore', 'show', 'focus']);
  h.instance.windowReady();
  assert.deepEqual(window.actions, ['restore', 'show', 'focus']);
});

test('a destroyed window is untouched and its replacement receives one pending activation', () => {
  const destroyed = new FakeWindow();
  destroyed.destroyed = true;
  const h = harness({ window: destroyed });
  h.secondInstance();
  h.secondInstance();
  h.instance.windowReady();
  assert.deepEqual(destroyed.actions, []);
  const replacement = new FakeWindow();
  h.state.window = replacement;
  h.instance.windowReady();
  assert.deepEqual(replacement.actions, ['show', 'focus']);
  h.instance.windowReady();
  assert.deepEqual(replacement.actions, ['show', 'focus']);
});

test('a window destroyed synchronously during restore waits for a replacement', () => {
  const window = new FakeWindow();
  window.minimized = true;
  window.restore = () => { window.actions.push('restore'); window.destroyed = true; };
  const h = harness({ window });
  assert.doesNotThrow(() => h.secondInstance());
  assert.deepEqual(window.actions, ['restore'], 'restore may close the window before show/focus');
  const replacement = new FakeWindow();
  h.state.window = replacement;
  h.instance.windowReady();
  assert.deepEqual(replacement.actions, ['show', 'focus'], 'the interrupted activation must remain pending');
  h.instance.windowReady();
  assert.deepEqual(replacement.actions, ['show', 'focus']);
});

test('show/focus exceptions cannot escape the duplicate event and the next event retries', () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  try {
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    for (const failedMethod of ['show', 'focus'] as const) {
      const window = new FakeWindow();
      const originalAction = window[failedMethod].bind(window);
      let failNextAction = true;
      window[failedMethod] = () => {
        if (failNextAction) {
          failNextAction = false;
          window.actions.push(`${failedMethod}:throw`);
          throw new Error(`synthetic ${failedMethod} close race`);
        }
        originalAction();
      };
      const h = harness({ window });
      assert.doesNotThrow(() => h.secondInstance(), `${failedMethod} failure must not crash the owner`);
      assert.deepEqual(window.actions, failedMethod === 'show' ? ['show:throw'] : ['show', 'focus:throw']);
      window.actions.length = 0;
      assert.doesNotThrow(() => h.secondInstance());
      assert.deepEqual(window.actions, ['show', 'focus'], `${failedMethod} failure must be retryable`);
      h.instance.windowReady();
      assert.deepEqual(window.actions, ['show', 'focus'], 'successful retry must clear the pending activation');
    }
    assert.equal(warnings.length, 2, 'each native activation failure is reported without escaping');
  } finally {
    console.warn = originalWarn;
  }
});

test('shutdown prevents a duplicate from activating an existing window', () => {
  const window = new FakeWindow();
  window.minimized = true;
  const h = harness({ window, guard: true });
  h.state.canActivate = false;
  h.secondInstance();
  h.instance.windowReady();
  assert.deepEqual(window.actions, []);
  assert.equal(window.minimized, true);
});

test('shutdown also prevents activation of a duplicate queued during startup', () => {
  const h = harness({ guard: true });
  h.secondInstance();
  h.state.canActivate = false;
  const window = new FakeWindow();
  h.state.window = window;
  h.instance.windowReady();
  h.secondInstance();
  assert.deepEqual(window.actions, []);
});

test('activation becomes available again when a shutdown guard is released', () => {
  const window = new FakeWindow();
  const h = harness({ window, guard: true });
  h.state.canActivate = false;
  h.secondInstance();
  assert.deepEqual(window.actions, []);
  h.state.canActivate = true;
  h.secondInstance();
  assert.deepEqual(window.actions, ['show', 'focus']);
});

// Inspect main.ts as source only: no startup, app profiles, services, or real vault IO.
const mainFile = fileURLToPath(new URL('../src/electron/main.ts', import.meta.url));
const main = ts.createSourceFile(mainFile, readFileSync(mainFile, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
function descendants<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}
const singleInstanceImports = main.statements.filter(ts.isImportDeclaration)
  .filter(node => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === './singleInstance');
assert.equal(singleInstanceImports.length, 1, 'main must import its single-instance helper exactly once');
const namedImports = singleInstanceImports[0].importClause?.namedBindings;
assert.ok(namedImports && ts.isNamedImports(namedImports));
const importedAcquire = namedImports.elements.find(node => (node.propertyName ?? node.name).text === 'acquireSingleInstance');
assert.ok(importedAcquire, 'main must use acquireSingleInstance from the tested helper');
const acquisitions = main.statements.filter(ts.isVariableStatement)
  .flatMap(statement => statement.declarationList.declarations)
  .filter(node => node.initializer && ts.isCallExpression(node.initializer)
    && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === importedAcquire.name.text);
assert.equal(acquisitions.length, 1, 'lock acquisition must run synchronously at module scope exactly once');
const acquisition = acquisitions[0];
assert.ok(ts.isIdentifier(acquisition.name), 'keep the single-instance result available for startup guards');
const instanceName = acquisition.name.text;
const readyCalls = descendants(main, ts.isCallExpression).filter(node => {
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'then') return false;
  const receiver = node.expression.expression;
  return ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)
    && ts.isIdentifier(receiver.expression.expression) && receiver.expression.expression.text === 'app'
    && receiver.expression.name.text === 'whenReady';
});

test('main applies the custom userData path before acquiring the lock and before whenReady', () => {
  const configuration = main.statements.find(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'applyCustomUserDataPath');
  assert.ok(configuration, 'custom userData configuration must run at module scope');
  assert.equal(readyCalls.length, 1, 'check the sole app.whenReady initialization path');
  assert.ok(configuration.getStart(main) < acquisition.getStart(main), 'custom userData determines the lock identity');
  assert.ok(acquisition.getStart(main) < readyCalls[0].getStart(main), 'acquire the lock before scheduling service startup');
});

test('the very first whenReady statement returns for a non-primary process', () => {
  assert.equal(readyCalls.length, 1);
  const callback = readyCalls[0].arguments[0];
  assert.ok(callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && ts.isBlock(callback.body));
  const guard = callback.body.statements[0];
  assert.ok(guard && ts.isIfStatement(guard), 'no service initialization may precede the primary guard');
  assert.ok(ts.isPrefixUnaryExpression(guard.expression) && guard.expression.operator === ts.SyntaxKind.ExclamationToken);
  const condition = guard.expression.operand;
  assert.ok(ts.isPropertyAccessExpression(condition) && ts.isIdentifier(condition.expression));
  assert.equal(condition.expression.text, instanceName);
  assert.equal(condition.name.text, 'primary');
  const returned = ts.isBlock(guard.thenStatement) ? guard.thenStatement.statements : [guard.thenStatement];
  assert.equal(returned.length, 1);
  assert.ok(ts.isReturnStatement(returned[0]) && !returned[0].expression, 'the rejected instance must return before initializing services');
});

console.log(JSON.stringify({ checks, actualElectronStarts: 0, actualRequests: 0, productionWrites: 0 }));

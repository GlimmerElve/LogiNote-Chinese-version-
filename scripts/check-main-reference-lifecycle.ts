/** Execute the actual main-window ownership callbacks without starting Electron. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const mainPath = 'src/electron/main.ts';
const main = await fs.readFile(mainPath, 'utf8');
const ast = ts.createSourceFile(mainPath, main, ts.ScriptTarget.ES2022, true);
const captures: ts.VariableStatement[] = [], subscriptions: ts.ExpressionStatement[] = [];
const walk = (node: ts.Node): void => {
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
    ts.isIdentifier(declaration.name) && declaration.name.text === 'referenceOwner')) captures.push(node);
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
    const call = node.expression, receiver = call.expression;
    if (ts.isPropertyAccessExpression(receiver) && receiver.expression.getText(ast) === 'win.webContents'
      && ['on', 'once'].includes(receiver.name.text) && ts.isStringLiteral(call.arguments[0])
      && ['did-start-navigation', 'destroyed'].includes(call.arguments[0].text)
      && call.arguments[1]?.getText(ast).includes('referenceEnvironments.revoke')) subscriptions.push(node);
  }
  ts.forEachChild(node, walk);
};
walk(ast);
assert.equal(captures.length, 1, 'Exactly one alive-time owner capture must exist');
assert.equal(subscriptions.length, 2, 'Extract both actual reference cleanup subscriptions');
assert.equal(subscriptions.filter(statement => (statement.expression as ts.CallExpression).arguments[0].getText(ast) === "'destroyed'").length, 1);
const production = [...captures, ...subscriptions].sort((a, b) => a.pos - b.pos).map(node => node.getText(ast)).join('\n');
const code = ts.transpileModule(production, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const observations: unknown[] = [];

for (const owner of [17, 93]) {
  let alive = true, windowReads = 0, idReads = 0;
  const handlers = new Map<string, { callback: (...args: any[]) => void; once: boolean }>();
  const calls: Array<[string, number]> = [];
  const contents = {
    get id() { idReads++; if (!alive) throw Error('WebContents object has been destroyed'); return owner; },
    on(name: string, callback: (...args: any[]) => void) { handlers.set(name, { callback, once: false }); },
    once(name: string, callback: (...args: any[]) => void) { handlers.set(name, { callback, once: true }); },
  };
  const win = { get webContents() { windowReads++; if (!alive) throw Error('BrowserWindow object has been destroyed'); return contents; } };
  const revoke = (kind: string) => (id: number) => calls.push([kind, id]);
  runInNewContext(code, { win, referenceEnvironments: { revoke: revoke('environment') },
    referenceQuestions: { revoke: revoke('question') }, revokeReferenceBuilds: revoke('build') });
  assert.equal(idReads, 1, 'Read ownership while alive exactly once');
  assert.ok(handlers.has('did-start-navigation') && handlers.has('destroyed'));
  assert.equal(handlers.get('destroyed')!.once, true, 'Destroy cleanup is subscribed once');
  const capturedReads = { windowReads, idReads };
  const navigation = handlers.get('did-start-navigation')!.callback;
  navigation({ isMainFrame: false, isSameDocument: false });
  navigation({ isMainFrame: true, isSameDocument: true });
  assert.equal(calls.length, 0, 'Subframe and same-document navigation retain ownership');
  navigation({ isMainFrame: true, isSameDocument: false });
  assert.deepEqual(calls, [['environment', owner], ['question', owner], ['build', owner]]);
  assert.deepEqual({ windowReads, idReads }, capturedReads, 'Navigation callback uses the captured ownership ID');
  calls.length = 0;
  alive = false;
  const destroyed = handlers.get('destroyed')!;
  handlers.delete('destroyed'); // Model EventEmitter.once removing its listener before callback.
  assert.doesNotThrow(() => destroyed.callback());
  assert.deepEqual(calls, [['environment', owner], ['question', owner], ['build', owner]]);
  assert.deepEqual({ windowReads, idReads }, capturedReads, 'Destroyed callback never reads a dead native object');
  assert.throws(() => win.webContents, /has been destroyed/u, 'The simulated getter really rejects after destruction');
  assert.throws(() => contents.id, /has been destroyed/u, 'The simulated native ID getter also rejects after destruction');
  observations.push({ owner, cleanupKinds: calls.map(([kind]) => kind), nativeReadsDuringCallbacks: 0, onceListenerRemoved: !handlers.has('destroyed') });
}

const root = await fs.mkdtemp(path.resolve('build/main-reference-lifecycle-'));
const report = { status: 'passed', root, source: mainPath, sourceHash: createHash('sha256').update(production).digest('hex'),
  modelRequests: 0, networkRequests: 0, electronProcesses: 0, observations,
  checks: ['AST提取实际owner捕获及navigation/destroyed回调', '子帧/同文档导航不撤销；主导航撤销三类owner资源',
    '销毁后native getter抛错的模拟中，实际destroyed回调不读原生对象', '两组不同owner均保持隔离且once监听已移除'] };
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, root, checks: report.checks.length, modelRequests: 0, electronProcesses: 0 }));

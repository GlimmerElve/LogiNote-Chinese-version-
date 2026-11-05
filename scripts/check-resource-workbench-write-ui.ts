import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute the production App callback. Persistence, preferences and IPC are
// independently controlled memory boundaries, not an Electron or vault test.
const source = readFileSync('src/App.tsx', 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
let callback: ts.Node | undefined;
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'workbench.onCommitted') callback = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(ast); assert.ok(callback);
const code = ts.transpileModule(`return (${callback.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture(origin = 'agent') {
  const original = { id: 'draft-a', origin, scopeProjectId: 'project-a' };
  const sessionRef = { current: original as typeof original | null };
  const payload = { sessionId: 'native-a', commitId: 'commit-a', draftSessionId: original.id,
    selectedResources: [{ title: '合成资源', url: 'https://synthetic.invalid/resource' }],
    rejectedResources: [{ title: '合成排除', url: 'https://synthetic.invalid/rejected' }], downloadErrors: [] };
  const save = deferred(), disk = deferred(), preference = deferred(), ack = deferred();
  let failSave = false, failPreference = false, failAck = false, ackAccepted = true, writes = 0, published = 0;
  const acknowledgements: any[] = [], closed: any[] = [], activities: any[] = [], requests: any[] = [], panels: any[] = [], clears: any[] = [], warnings: any[] = [];
  const env = {
    resourceDraftSessionRef: sessionRef, notesRef: { current: [] },
    workbench: { completeCommit: async (request: any) => {
      acknowledgements.push(request); await ack.promise;
      if (failAck) throw new Error('合成回执中断'); return ackAccepted;
    } },
    registerDiscoveredResources: (_notes: unknown, session: unknown) => session,
    setResourceCandidateDecision: (_notes: unknown, session: unknown) => session,
    registerResourceBrowserSession: (session: unknown) => session,
    applyConfirmedWorkbenchResources: () => ({ notes: [], summary: { projectCount: 1, localResourceCount: 0 }, changedProjectNotes: [{ id: 'project-a', title: '合成项目', resources: payload.selectedResources }] }),
    persistPlanMutation: async (prepare: (notes: unknown[]) => unknown, root: string) => {
      assert.equal(root, 'project-a'); await save.promise; const mutation = prepare([]);
      writes++; await disk.promise; if (failSave) throw new Error('合成保存失败'); published++; return mutation;
    },
    recordResourceDiscoveryPreferences: async () => { await preference.promise; if (failPreference) throw new Error('合成偏好失败'); },
    closeDraftBrowserSessions: (session: unknown) => closed.push(session),
    updateResourceDraftSession: (session: typeof original | null) => { clears.push(session); sessionRef.current = session; },
    setResourceActivity: (activity: unknown) => activities.push(activity),
    setAgentExternalRequest: (request: unknown) => requests.push(request), setIsAgentOpen: (value: boolean) => panels.push(value),
    console: { warn: (...values: unknown[]) => warnings.push(values) },
  };
  const execute = new Function(...Object.keys(env), code)(...Object.values(env));
  return { execute: () => execute(payload), sessionRef, original, save, disk, preference, ack,
    flags: (options: { save?: boolean; preference?: boolean; ack?: boolean; accepted?: boolean }) => {
      failSave = options.save ?? failSave; failPreference = options.preference ?? failPreference;
      failAck = options.ack ?? failAck; ackAccepted = options.accepted ?? ackAccepted;
    }, acknowledgements, closed, activities, requests, panels, clears, warnings, counts: () => ({ writes, published }),
    release: () => { save.resolve(); disk.resolve(); preference.resolve(); ack.resolve(); } };
}
{
  const h = fixture(); h.execute(); await tick(); assert.equal(h.counts().published, 0); assert.equal(h.acknowledgements.length, 0);
  h.save.resolve(); await tick(); assert.equal(h.counts().writes, 1); assert.equal(h.counts().published, 0);
  h.disk.resolve(); await tick(); assert.equal(h.counts().published, 1); assert.equal(h.acknowledgements.length, 0);
  h.preference.resolve(); await tick(); assert.equal(h.acknowledgements[0].ok, true); assert.equal(h.clears.length, 0);
  h.ack.resolve(); await tick(); assert.equal(h.clears.length, 1); assert.equal(h.requests.length, 1); assert.equal(h.closed.length, 1);
}
for (const phase of ['save', 'preference', 'ack'] as const) {
  const h = fixture(); h.execute(); h.save.resolve(); await tick();
  if (phase !== 'save') { h.disk.resolve(); await tick(); }
  if (phase === 'ack') { h.preference.resolve(); await tick(); }
  const newer = { ...h.original, id: 'draft-b' }; h.sessionRef.current = newer; h.release(); await tick();
  assert.equal(h.counts().published, 1, 'accepted saves remain attached to the original project');
  assert.equal(h.acknowledgements[0].ok, true);
  assert.equal(h.sessionRef.current, newer); assert.equal(h.clears.length, 0); assert.equal(h.closed.length, 0);
  assert.equal(h.activities.length, 0); assert.equal(h.requests.length, 0); assert.equal(h.panels.length, 0);
}
{
  const h = fixture(); h.execute(); h.sessionRef.current = { ...h.original, id: 'draft-b' }; h.release(); await tick();
  assert.equal(h.counts().writes, 0, 'a queued operation rechecks the session before preparing any write');
  assert.equal(h.acknowledgements[0].ok, false); assert.equal(h.activities.length, 0);
}
{
  const h = fixture(); h.flags({ save: true }); h.execute(); h.release(); await tick();
  assert.equal(h.counts().published, 0); assert.equal(h.acknowledgements[0].ok, false); assert.equal(h.sessionRef.current, h.original);
  assert.match(h.activities[0].text, /合成保存失败/); assert.equal(h.clears.length, 0);
}
for (const failure of ['rejected', 'false'] as const) {
  const h = fixture(); h.flags(failure === 'rejected' ? { ack: true } : { accepted: false }); h.execute(); h.release(); await tick();
  assert.equal(h.counts().published, 1); assert.equal(h.acknowledgements.length, 1, 'a saved resource is never followed by a false save acknowledgement');
  assert.match(h.activities[0].text, /资源已保存.*回执未送达/); assert.equal(h.clears.length, 0); assert.equal(h.closed.length, 0); assert.equal(h.requests.length, 0);
}
{
  const h = fixture(); h.flags({ save: true, ack: true }); h.execute(); h.release(); await tick();
  assert.equal(h.counts().published, 0); assert.equal(h.warnings.length, 1);
  assert.match(h.activities[0].text, /合成保存失败/); assert.equal(h.clears.length, 0); assert.equal(h.sessionRef.current, h.original);
}
{
  const h = fixture(); h.flags({ preference: true }); h.execute(); h.release(); await tick();
  assert.match(h.activities[0].text, /偏好保存失败/); assert.doesNotMatch(h.activities[0].text, /已记录/);
  assert.match(h.requests[0].text, /不要宣称已记录偏好/); assert.equal(h.acknowledgements[0].ok, true);
}
{
  const h = fixture('note-editor'); h.execute(); h.release(); await tick(); assert.equal(h.requests.length, 0); assert.equal(h.panels.length, 0);
}
{
  const h = fixture(); h.sessionRef.current = null; h.flags({ ack: true }); h.execute(); h.release(); await tick();
  assert.equal(h.counts().writes, 0); assert.equal(h.warnings.length, 1); assert.equal(h.activities.length, 0);
}
console.log('PASS actual App resource writeback: save/ack order, superseded sessions, queued scope check, errors, saved-but-unacknowledged status and truthful preference feedback (memory boundaries only)');

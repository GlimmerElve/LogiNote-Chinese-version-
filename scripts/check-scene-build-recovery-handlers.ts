import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { SceneBuildInterruptedError, type SceneBuildCheckpoint } from '../src/services/scene/sceneGenerator';
import { SceneSetupError } from '../src/services/scene/sceneSetupStage';
import { SceneClarificationRequired } from '../src/services/scene/sceneUnderstanding';

// Execute the production handler AST with synthetic dependencies. This is not rendered GUI or model E2E.
globalThis.fetch = async () => assert.fail('Build recovery handler checks must not call the network');
const file = 'src/components/SceneMode.tsx';
const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
let expression = '';
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'runPipeline') {
    assert.ok(node.initializer && ts.isArrowFunction(node.initializer));
    assert.equal(expression, '');
    expression = node.initializer.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast); assert.ok(expression);
const compiled = ts.transpileModule(`const handler = ${expression};\nreturn handler;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const PRIVATE = 'PRIVATE_BUILD_INPUT_MUST_NEVER_BE_LOGGED';
const sourceSpec = { sceneId: 'source', meta: { name: PRIVATE }, resources: [] };
const result = { sceneId: 'result', meta: { name: 'Synthetic result' }, resources: [] };
const request = (source = 'auto', changes: Record<string, unknown> = {}) => ({
  source, subject: 'Synthetic subject', knowledgePoints: ['Synthetic point'], sceneSkill: 'S1',
  taskBinding: { noteId: 'synthetic-project' }, ...changes,
});
function harness(decision: 'new' | 'adapt' = 'new') {
  const counts = { materials: 0, architecture: 0, materialVerification: 0, manifest: 0, decision: 0, source: 0, generate: 0, adapt: 0, blank: 0 };
  const refs = {
    pipelineBusyRef: { current: false }, startBusyRef: { current: false }, mountedRef: { current: true },
    pipelineRequestRef: { current: null as unknown }, activeSetupAbortRef: { current: null as unknown },
    pipelineResumeRef: { current: null as any },
  };
  const checkpoint = { version: 1, binding: PRIVATE, recovery: { stages: {} }, failure: { stage: 'accept', code: 'output-truncated', retryable: true } } as unknown as SceneBuildCheckpoint;
  const materialSnapshot = { summary: { candidateCount: 1, usableCount: 1, emptyCount: 0 }, scope: { noteIds: ['synthetic-note'] } };
  const coordinated = { recommendation: { valid: true, recipeId: 'guided-practice', requestedCapabilities: ['single-choice'], requestedPromptModules: ['structured-interaction'] },
    buildContext: { originalRequest: PRIVATE, materialEvidence: { callCount: 1 } } };
  const generations: any[] = [], logs: unknown[][] = [];
  let failNext = true, phase = '', error = '', draft: any;
  const env = {
    ...refs, allNotes: [], AbortController, SceneBuildInterruptedError, SceneClarificationRequired,
    setPhase: (value: string) => { phase = value; }, setErrorMsg: (value: string) => { error = value; },
    setClarificationQuestion: () => undefined, setClarificationAnswer: () => undefined,
    setBusyLabel: () => undefined, setDraft: (value: unknown) => { draft = value; },
    console: { error: (...args: unknown[]) => { logs.push(args); }, warn: (...args: unknown[]) => { logs.push(args); } },
    getSceneProjectMaterials: () => { counts.materials++; return materialSnapshot; },
    bindSceneProjectMaterials: (value: unknown, materials: unknown) => { assert.equal(materials, materialSnapshot); return value; },
    runSceneMultiAgent: async () => { counts.architecture++; counts.materialVerification++; return coordinated; },
    loadManifest: async () => { counts.manifest++; return { scenes: [] }; },
    decideScene: async () => { counts.decision++; return decision === 'adapt' ? { decision, targetSceneId: 'source' } : { decision }; },
    loadScene: async () => { counts.source++; return sourceSpec; },
    createBlankSpec: () => { counts.blank++; return result; },
    generateScene: async (opts: any) => { counts.generate++; return generate(opts); },
    adaptScene: async (opts: any) => { counts.adapt++; assert.equal(opts.sourceSpec, sourceSpec); return generate(opts); },
  };
  async function generate(opts: any) {
    generations.push(opts);
    assert.equal(opts.buildContext, coordinated.buildContext);
    if (failNext) {
      failNext = false;
      opts.onCheckpoint(checkpoint);
      throw new SceneBuildInterruptedError(checkpoint, new SceneSetupError('accept', 'output-truncated', 'Synthetic truncation', 2), true, 'accept', 'output-truncated');
    }
    return result;
  }
  const run = new Function(...Object.keys(env), compiled)(...Object.values(env)) as (req: unknown) => Promise<void>;
  return { run, refs, counts, generations, logs, checkpoint, get phase() { return phase; }, get error() { return error; },
    get draft() { return draft; }, failNext: () => { failNext = true; } };
}

for (const [source, decision] of [['auto', 'new'], ['build', 'new'], ['build', 'adapt']] as const) {
  const h = harness(decision), req = request(source);
  await h.run(req);
  assert.equal(h.phase, 'generating'); assert.match(h.error, /output-truncated/);
  assert.equal(h.refs.pipelineResumeRef.current.checkpoint, h.checkpoint);
  const before = { ...h.counts };
  await h.run(structuredClone(req));
  assert.equal(h.phase, 'preview'); assert.equal(h.draft, result); assert.equal(h.error, '');
  assert.equal(h.refs.pipelineResumeRef.current, null, 'successful preview must release the private checkpoint');
  assert.equal(h.generations.length, 2); assert.equal(h.generations[0].resume, undefined); assert.equal(h.generations[1].resume, h.checkpoint);
  for (const key of ['materials', 'architecture', 'materialVerification', 'manifest', 'decision', 'source'] as const) {
    assert.equal(h.counts[key], before[key], `${source}/${decision}: retry must not repeat accepted ${key}`);
  }
  assert.doesNotMatch(JSON.stringify(h.logs), new RegExp(PRIVATE));
  assert.deepEqual(h.logs[0], ['[scene] 生成失败:', { stage: 'accept', code: 'output-truncated', retryable: true }]);
}

// Both source and original request changes invalidate the private snapshot, including sourceSpec and materials.
for (const changed of [request('build'), request('auto', { subject: 'A different original goal' }), request('build', { sceneId: 'another-source' })]) {
  const h = harness('adapt');
  await h.run(request('auto'));
  const oldCallback = h.generations[0].onCheckpoint;
  h.failNext(); await h.run(changed);
  assert.equal(h.counts.materials, 2); assert.equal(h.counts.architecture, 2);
  assert.equal(h.generations[1].resume, undefined, 'a changed request cannot inherit the preceding builder checkpoint');
  const current = h.refs.pipelineResumeRef.current;
  current.checkpoint = undefined;
  oldCallback(h.checkpoint);
  assert.equal(current.checkpoint, undefined, 'a callback from the old binding cannot overwrite new recovery state');
}

for (const source of ['existing', 'custom']) {
  const h = harness(); await h.run(request(source, { sceneId: 'source' }));
  assert.equal(h.phase, 'preview');
  assert.equal(h.counts.architecture + h.counts.materialVerification + h.counts.manifest + h.counts.decision + h.counts.generate + h.counts.adapt, 0);
  assert.equal(h.refs.pipelineResumeRef.current, null, 'direct preview must also release private materials');
}
for (const ref of ['pipelineBusyRef', 'startBusyRef', 'mountedRef'] as const) {
  const h = harness(); h.refs[ref].current = ref !== 'mountedRef'; await h.run(request());
  assert.equal(Object.values(h.counts).reduce((sum, value) => sum + value, 0), 0);
}
console.log('Scene build recovery handlers passed: production runPipeline AST retries preserve architecture/materials/manifest/decision/source; request changes reset checkpoints, safe logs and direct zero-model previews. Synthetic IO only.');

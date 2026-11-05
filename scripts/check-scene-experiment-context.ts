import assert from 'node:assert/strict';
import { buildSceneExperimentContext, buildSceneExperimentSources } from '../src/services/scene/sceneExperimentContext';
import type { SceneExperimentRecord, SceneMessage, SceneRunState } from '../src/types';

globalThis.fetch = async () => assert.fail('Experiment context checks are synthetic and offline.');
const long = (marker: string, length = 12000) => (marker + '"\\\n🙂').repeat(length).slice(0, length);
const records: SceneExperimentRecord[] = Array.from({ length: 6 }, (_, index) => ({
  id: `context-record-${index + 1}`, sourceUserMessageId: `user-${index + 1}`,
  prompt: long(`prompt-${index}-`), input: long(`input-${index}-`), output: long(`output-${index}-`, 30000),
  model: 'synthetic-model', temperature: .2, maxOutputTokens: 1024, outputFormat: 'text',
  status: index === 3 ? 'failed' : 'complete', error: index === 3 ? 'Assessment failed after the output was received.' : undefined,
  criteria: Array.from({ length: 12 }, (_, criterion) => `criterion-${criterion}`),
  evaluation: Array.from({ length: 12 }, (_, criterion) => ({ criterion: long(`criterion-${criterion}-`, 1000),
    verdict: criterion % 3 === 0 ? 'unmet' : criterion % 3 === 1 ? 'uncertain' : 'met',
    evidence: `DO_NOT_TREAT_AS_SUMMARY_EVIDENCE_${criterion}`, suggestion: long(`suggestion-${criterion}-`, 1000) })),
}));
const original = structuredClone(records);
for (const maxChars of [2400, 4000, 12000]) {
  const context = buildSceneExperimentContext(records, { maxChars, currentUserMessageId: 'user-6' });
  assert.ok(JSON.stringify(context).length <= maxChars, `Summary exceeds ${maxChars} characters`);
  assert.equal(context.latestRecordId, 'context-record-6');
  assert.equal(context.latestFailureId, 'context-record-4');
  assert.deepEqual(context.metadata.map(record => [record.id, record.status]), records.map(record => [record.id, record.status]));
  assert.equal(context.failedRecords, 1);
  assert.equal(context.representation, 'bounded-summary');
  assert.match(context.notice, /不是完整执行记录/);
  assert.doesNotMatch(JSON.stringify(context), /DO_NOT_TREAT_AS_SUMMARY_EVIDENCE/);
  const latest = context.details.find(record => record.id === 'context-record-6');
  const failed = context.details.find(record => record.id === 'context-record-4');
  assert.ok(latest, 'Latest version details should be prioritized');
  assert.ok(failed?.error, 'Latest failure must retain its failure description');
  for (const detail of context.details) for (const key of ['prompt', 'input', 'output'] as const) {
    const fragment = detail[key];
    if (!fragment) continue;
    assert.equal(fragment.originalChars, records.find(record => record.id === detail.id)![key].length);
    assert.equal(fragment.truncated, fragment.text.length < fragment.originalChars);
  }
}
assert.deepEqual(records, original, 'Summary generation must not rewrite executor receipts');
const editable = buildSceneExperimentContext(records);
editable.metadata[0].status = 'failed';
editable.details[0].model.text = 'modified summary';
assert.deepEqual(records, original, 'Summary results must not share mutable raw-record structures');
const single = buildSceneExperimentContext([records[5]], { maxChars: 2400 });
assert.ok(JSON.stringify(single).length <= 2400);
assert.ok(single.details[0].output?.truncated);
assert.equal(buildSceneExperimentContext([]).totalRecords, 0);
assert.throws(() => buildSceneExperimentContext(records, { maxChars: 511 }), RangeError);
assert.throws(() => buildSceneExperimentContext(records, { maxChars: NaN }), RangeError);
assert.throws(() => buildSceneExperimentContext([...records, records[0]]), RangeError);

const message = (id: string, content: string, speakerType: SceneMessage['speakerType'] = 'user'): SceneMessage => ({
  id, content, speakerType, speakerName: speakerType, timestamp: '2026-01-01T00:00:00.000Z',
});
const run = (messages: SceneMessage[]): SceneRunState => ({
  runId: 'context-run', sceneId: 'context-scene', sceneName: 'synthetic', metrics: [], messages,
  turnCount: 0, events: [], status: 'running', startedAt: '2026-01-01T00:00:00.000Z',
});
const sourceRun = run([
  message('old-source', long('old-source-', 18000), 'role'),
  message('another-old-source', long('another-old-', 18000)),
  message('current-source', long('current-source-', 20000)),
  { ...message('streaming-source', 'never-source'), isStreaming: true },
  message('action-source', 'never-source', 'action'),
]);
const sourceSnapshot = structuredClone(sourceRun);
const sources = buildSceneExperimentSources(sourceRun);
assert.ok(JSON.stringify(sources).length <= 32000);
assert.equal(sources.find(source => source.id === 'current-source')?.content, sourceRun.messages[2].content);
assert.equal(sources.some(source => ['streaming-source', 'action-source'].includes(source.id)), false);
assert.ok(sources.some(source => source.unavailable));
for (const source of sources) {
  assert.ok(source.content === undefined || source.content === sourceRun.messages.find(message => message.id === source.id)!.content,
    'An available source must be the complete exact message, not an excerpt');
  if (source.unavailable) assert.equal(source.content, undefined);
}
assert.deepEqual(sourceRun, sourceSnapshot);
const hugeSources = buildSceneExperimentSources(run([message('huge', long('huge-', 40000))]));
assert.equal(hugeSources[0].content, undefined);
assert.equal(hugeSources[0].unavailable, 'source-exceeds-context-budget');
const manyRoles = run([message('last-user', 'keep this complete'), ...Array.from({ length: 7 }, (_, index) => message(`role-${index}`, 'role', 'role'))]);
assert.equal(buildSceneExperimentSources(manyRoles).find(source => source.id === 'last-user')?.content, 'keep this complete');

const formValues = { prompt: long('FORM_PROMPT_', 12000), input: long('FORM_INPUT_', 12000), output: 'json-object' };
const formRun = run([{ ...message('form-user', 'FORM_CONTENT_MUST_NOT_BE_INJECTED'),
  formSubmission: { formId: 'prompt-lab', values: formValues } }]);
const formSnapshot = structuredClone(formRun);
const formSources = buildSceneExperimentSources(formRun);
assert.ok(JSON.stringify(formSources).length <= 32000);
assert.equal(formSources[0].content, undefined);
assert.equal(formSources[0].formSubmission?.formId, 'prompt-lab');
assert.deepEqual(formSources[0].formSubmission?.fields.map(field => field.id), ['prompt', 'input', 'output']);
for (const field of formSources[0].formSubmission!.fields) {
  assert.equal(field.chars, formValues[field.id as keyof typeof formValues].length);
  assert.ok(field.preview.length <= 300);
  assert.ok(formValues[field.id as keyof typeof formValues].startsWith(field.preview));
}
assert.doesNotMatch(JSON.stringify(formSources), /FORM_CONTENT_MUST_NOT_BE_INJECTED|"values"/);
assert.equal(JSON.stringify(formSources).includes(formValues.prompt), false);
assert.equal(JSON.stringify(formSources).includes(formValues.input), false);
assert.deepEqual(formRun, formSnapshot);
const tinyFormSources = buildSceneExperimentSources(formRun, 512);
assert.ok(JSON.stringify(tinyFormSources).length <= 512);
assert.deepEqual(tinyFormSources[0].formSubmission?.fields.map(field => [field.id, field.chars]),
  Object.entries(formValues).map(([id, value]) => [id, value.length]));
assert.throws(() => buildSceneExperimentSources(formRun, 100), RangeError);

console.log('Scene experiment context passed: strict serialized budgets, immutable receipts, latest/failure retention, marked excerpts without judge evidence, complete-or-unavailable sources, and bounded form previews. Synthetic offline checks only.');

// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import * as controlIssues from '../src/services/scene/sceneS2ControlIssue';
import * as controlHints from '../src/services/scene/sceneS2ControlHints';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as controls from '../src/services/scene/sceneS2Controls';
import { s2ChartPoints, s2TableDraftValue, type S2TableDraft } from '../src/services/scene/sceneS2DataViews';
import { S2FieldPreview } from '../src/components/scene/S2FieldPreview';
import { S2ControlInput } from '../src/components/scene/S2FieldEditor';
import { S2ArtifactView } from '../src/components/scene/S2ArtifactView';
import * as dataViews from '../src/services/scene/sceneS2DataViews';
import * as structured from '../src/services/scene/sceneS2Structured';
import { readS2Definition, applyS2Commands, createS2Scene, designS2Canvas, interactS2Canvas, exportS2Workspace, importS2Workspace } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { harness } from './scene-s2-ui-harness';
import { s2DesignFixtureResponse } from './fixtures/s2-design-model';

const prior = globalThis.fetch; globalThis.fetch = async () => { throw new Error('S2 views regression forbids real network'); };
const table = controls.readS2Field({ id: 'rows', label: '试验对照', kind: 'table', required: true, minItems: 1, maxItems: 6,
  columns: [{ id: 'name', label: '名称', type: 'string', required: true }, { id: 'score', label: '得分', type: 'number', nullable: true },
    { id: 'enabled', label: '启用', type: 'boolean' }], view: { kind: 'line', xKey: 'name', yKey: 'score' } });
const rows = [{ name: '', score: 0, enabled: false }, { name: '<script>data</script>', score: null }, { name: '缺失值' }, { name: '负数', score: -2 }, { name: '较高', score: 4 }];
const raw = JSON.stringify(rows), jsonRaw = ' {\n  "enabled": false, "items": [0, null, ""]\n} ', codeRaw = '<script>globalThis.mustNotRun=true</script>\nconst value = "{{user}}";';
const json = controls.readS2Field({ id: 'config', label: 'JSON设置', kind: 'json' }), code = controls.readS2Field({ id: 'source', label: '待测代码', kind: 'code', language: 'javascript' });
const hosts: S2PluginHost[] = [];
try {
  assert.equal(controls.s2SubmitControlDraft(table, controls.s2ControlDraft(table, raw)), raw);
  assert.equal(controls.s2SubmitControlDraft(json, controls.s2ControlDraft(json, jsonRaw)), jsonRaw, 'Root JSON whitespace is source data');
  assert.equal(controls.s2SubmitControlDraft(code, controls.s2ControlDraft(code, codeRaw)), codeRaw);
  assert.equal(controls.s2DefaultFieldText(controls.readS2Field({ ...json, defaultValue: false })), 'false');
  const nested = controls.readS2Field({ id: 'form', label: '组合', kind: 'form', fields: [json, code, table] });
  const nestedValue = { config: JSON.parse(jsonRaw), source: codeRaw, rows };
  assert.deepEqual(JSON.parse(controls.s2SubmitControlDraft(nested, controls.s2ControlDraft(nested, JSON.stringify(nestedValue)))), nestedValue);
  for (const invalid of [
    { ...table, columns: [table.columns![0], table.columns![0]] }, { ...table, view: { kind: 'bar', xKey: 'name', yKey: 'enabled' } },
    { ...table, view: { kind: 'bar', xKey: 'absent', yKey: 'score' } }, { ...table, view: { ...table.view, script: 'run()' } },
    { ...code, language: 'html' }, { ...json, execute: true }, { ...json, defaultValue: { constructor: 'reserved' } },
    { ...code, language: ['javascript'] }, { ...table, columns: [{ id: 'x', label: 'x', type: ['number'] }] }, { ...table, view: { ...table.view, kind: ['bar'] } },
  ]) assert.throws(() => controls.readS2Field(invalid));
  for (const invalid of [[{ score: 1 }], [{ name: 'x', score: '1' }], [{ name: 'x', enabled: null }],
    [{ name: 'x', extra: 1 }], [], [{ name: '中'.repeat(700) }]]) assert.throws(() => controls.validateS2FieldText(table, JSON.stringify(invalid)));
  assert.throws(() => controls.validateS2FieldText(json, '{"__proto__":{}}'));
  assert.throws(() => controls.validateS2FieldText(json, '{"value":1e400}'));
  assert.throws(() => controls.validateS2FieldText(table, '[{"name":"x","score":1e400}]'));
  assert.throws(() => controls.validateS2FieldText(json, '{"a":'));
  const draft = controls.s2ControlDraft(table, raw) as S2TableDraft;
  assert.equal(draft[0].name.text, ''); assert.equal(draft[0].score.text, '0'); assert.equal(draft[0].enabled.text, 'false');
  assert.equal(draft[1].score.state, 'null'); assert.equal(draft[2].score.state, 'missing');
  draft[2].score = { state: 'value', text: '-' };
  assert.throws(() => s2TableDraftValue(table, draft)); assert.equal(draft[2].score.text, '-', 'Invalid partial value is retained');
  draft[2].score.text = 'null'; assert.throws(() => s2TableDraftValue(table, draft), /显式选择/);
  draft[2].score = { state: 'value', text: '2' }; assert.equal(s2TableDraftValue(table, draft)[2].score, 2);
  const chart = s2ChartPoints(table, rows);
  assert.equal(chart.points[1].y, null); assert.equal(chart.points[2].y, null);
  assert.equal(chart.points[0].y, chart.baseline); assert.ok(chart.points[3].y! > chart.baseline); assert.ok(chart.points[4].y! < chart.baseline);
  const extremes = s2ChartPoints(table, [{ name: 'a', score: -1e308 }, { name: 'b', score: 1e308 }]);
  assert.ok(extremes.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  const inherited = controls.readS2Field({ id: 'own', label: '自身字段', kind: 'table', columns: [{ id: 'name', label: '名称', type: 'string' }, { id: 'valueOf', label: '值', type: 'number' }], view: { kind: 'bar', xKey: 'name', yKey: 'valueOf' } });
  assert.equal(s2ChartPoints(inherited, [{ name: 'missing' }]).points[0].value, undefined);
  const ownForm = controls.readS2Field({ id: 'own', label: '自身字段', kind: 'form', fields: [{ id: 'toString', label: '文本', kind: 'text' }] });
  assert.deepEqual(controls.s2ControlDraft(ownForm, '{}'), { toString: undefined });
  assert.equal(controls.s2SubmitControlDraft(ownForm, controls.s2ControlDraft(ownForm, '{}')), '{}');
  const chartMarkup = renderToStaticMarkup(<S2FieldPreview field={table} value={raw} />);
  assert.ok(chartMarkup.includes('<svg')); assert.ok(chartMarkup.includes('&lt;script&gt;data&lt;/script&gt;')); assert.ok(!chartMarkup.includes('<script>'));
  assert.equal((chartMarkup.match(/<polyline/g) ?? []).length, 2, 'Missing/null rows split the line instead of drawing across missing observations');
  assert.ok(chartMarkup.includes('false')); assert.ok(chartMarkup.includes('缺失')); assert.ok(chartMarkup.includes('null'));
  const codeMarkup = renderToStaticMarkup(<S2FieldPreview field={code} value={codeRaw} />);
  assert.ok(codeMarkup.includes('未执行') && !codeMarkup.includes('<script>') && codeMarkup.includes('{{user}}'));
  const inputMarkup = renderToStaticMarkup(<S2ControlInput field={table} draft={controls.s2ControlDraft(table, raw)} disabled={false} onChange={() => {}} />);
  assert.ok(inputMarkup.includes('<caption>')); assert.ok(inputMarkup.includes('scope="col"'));

  const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '合成结构化数据编辑与图表场景', knowledgePoints: [], interactionPack: null });
  const cap = (capabilityId: string) => ({ pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId });
  const definition = readS2Definition({ ...scene.canvasWorkspace, blockTypes: [{ id: 'dataset', label: '数据块', fields: [table, json, code] }],
    plugins: [cap('parse-json'), cap('to-table'), cap('table-to-json')], initial: { nodes: [{ id: 'data', type: 'dataset', position: { x: 0, y: 0 }, values: { rows: raw, config: jsonRaw, source: codeRaw } }], edges: [],
      execution: { version: 1, nodes: [
        { id: 'parse', ...cap('parse-json'), position: { x: 300, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'data', fieldId: 'rows' } } },
        { id: 'table', ...cap('to-table'), position: { x: 600, y: 0 }, bindings: {} }, { id: 'records', ...cap('table-to-json'), position: { x: 900, y: 0 }, bindings: {} },
      ], links: [{ source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: 'table', portId: 'value' } }, { source: { nodeId: 'table', portId: 'table' }, target: { nodeId: 'records', portId: 'table' } }] } } });
  scene.canvasWorkspace = definition;
  assert.deepEqual(importS2Workspace(exportS2Workspace(definition, definition.initial)), definition);
  const unchanged = JSON.stringify(definition.initial);
  assert.throws(() => applyS2Commands(definition, definition.initial, [{ op: 'update-node', id: 'data', values: { config: '{}', rows: '[{"name":"x","score":"bad"}]' } }]));
  assert.equal(JSON.stringify(definition.initial), unchanged);
  const host = new S2PluginHost(scene.sceneId, definition); hosts.push(host); host.setDocument(definition.initial);
  const result = await host.enqueueWorkflow(['records']).completion;
  assert.equal(result.status, 'succeeded');
  const records = host.history().find(entry => entry.request.nodeId === 'records')!.artifacts[0];
  if (records.payload.kind !== 'inline') assert.fail('Expected complete records');
  assert.deepEqual(records.payload.value, rows, 'Explicit parse→table→records retains missing/null/empty/false and raw strings');
  const tableArtifact = host.history().find(entry => entry.request.nodeId === 'table')!.artifacts[0];
  const artifactMarkup = renderToStaticMarkup(<S2ArtifactView artifact={tableArtifact} />);
  assert.ok(artifactMarkup.includes('产物图表类型')); assert.ok(artifactMarkup.includes('只改变显示'));
  const designStages: string[] = [];
  const designed = await designS2Canvas(scene, { disclosure: 'complete', invoke: async call => {
    const stage = JSON.parse(call.userInput).stage; designStages.push(stage);
    if (stage === 'assemble') assert.ok(call.systemPromptOverride!.includes('yKey'));
    const response = s2DesignFixtureResponse(call, definition), value = JSON.parse(response.content);
    if (stage === 'assemble') { value.business.completion.reference.nodes[0].values = { rows: raw, config: jsonRaw, source: codeRaw }; response.content = JSON.stringify(value); }
    return response;
  } });
  assert.deepEqual(designStages, ['understand', 'assemble']); assert.deepEqual(designed.blockTypes, definition.blockTypes);
  const turnStages: string[] = [];
  const reply = await interactS2Canvas(scene, definition.initial, '只解释缺失值和图表断点，不运行', 'data', [], { invoke: async call => {
    const input = JSON.parse(call.userInput); turnStages.push(input.stage);
    assert.deepEqual(input.stage === 'turn-understand' ? input.fieldControls : input.blockTypes, definition.blockTypes);
    assert.ok(input.fieldControlProtocol.includes('code不执行'));
    return { content: JSON.stringify(input.stage === 'turn-understand' ? { understanding: '解释表格', desiredOutcome: '保留数据，仅解释', actions: ['reply'], constraints: [], questions: [] }
      : { understanding: '缺失不等于零', plan: '只解释', reply: '缺失和null在图表中保留断点，false为实际布尔值。', commands: [] }) };
  } });
  assert.deepEqual(turnStages, ['turn-understand', 'turn-act']); assert.deepEqual(reply.commands, []); assert.equal(host.history().length, 3);

  // Actual root editor + recursive controls; draft changes never publish until explicit submit.
  type El = { type: string; props: any; children: any[] }; let slots: any[] = [], cursor = 0;
  const fakeReact = { createElement(type: any, props: any, ...children: any[]): any { return typeof type === 'function' ? type(props) : { type, props: props ?? {}, children }; },
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (v: any) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef(initial: any) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; } };
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/components/scene/S2FieldEditor.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText, { exports, JSON, Map, require: (id: string) => id === 'react' ? fakeReact : id.endsWith('S2FieldPreview') ? { S2FieldPreview: 'committed-preview' } : id.endsWith('sceneS2ControlIssue') ? controlIssues : id.endsWith('sceneS2ControlHints') ? controlHints : controls });
  const ui = harness({ initialDraft: scene }); ui.labelControl('选择块', 'select').props.onChange({ target: { value: 'data' } }); ui.render();
  const parent = ui.elements().find(e => e.type === 'field-editor' && e.props.field.id === 'rows')!;
  let current = raw, submits = 0;
  const props = () => ({ ...parent.props, value: current, onSubmit: (event: any) => { parent.props.onSubmit(structuredClone(event)); current = event.value; submits++; } });
  const render = (): El => { cursor = 0; return exports.S2FieldEditor(props()); };
  const all = (node: any): El[] => Array.isArray(node) ? node.flatMap(all) : node && typeof node === 'object' ? [node, ...all(node.children)] : [];
  let tree = render();
  const change = (label: string, value: string) => { const element = all(tree).find(e => ['input', 'select'].includes(e.type) && e.props['aria-label'] === label); assert.ok(element, label); element.props.onChange({ target: { value } }); tree = render(); };
  change('试验对照 / 第 1 行 / 得分', '-'); tree.props.onSubmit({ preventDefault() {} }); tree = render(); assert.equal(submits, 0);
  assert.equal(all(tree).find(e => e.type === 'committed-preview')!.props.value, raw, 'Preview stays committed after invalid editing');
  change('试验对照 / 第 1 行 / 得分', '7'); tree.props.onSubmit({ preventDefault() {} }); tree.props.onSubmit({ preventDefault() {} }); tree = render(); ui.render();
  assert.equal(submits, 1); assert.equal(JSON.parse(current)[0].score, 7); assert.equal(JSON.parse(current)[0].enabled, false);
  ui.keyShortcut('undo'); ui.render(); assert.equal(ui.flow().props.nodes.find((node: any) => node.id === 'data').data.fields[0].value, raw);
  assert.equal(host.history().length, 3, 'Viewing and editing do not dispatch plugin runs'); ui.dispose();
  // A result table can show all 100 rows in a local chart even though its table preview is 20 rows.
  const fullTable = structured.recordsToS2Table(Array.from({ length: 100 }, (_, i) => ({ label: `row-${i}`, score: i === 99 ? 99 : i % 2 ? null : i })));
  const beforeView = JSON.stringify(fullTable); slots = []; cursor = 0;
  const chartExports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/components/scene/S2ArtifactChart.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText, { exports: chartExports, require: (id: string) => id === 'react' ? fakeReact : id.endsWith('S2ChartPreview') ? { S2ChartPreview: 'chart-preview' } : id.endsWith('sceneS2Structured') ? structured : dataViews });
  const viewSelections: unknown[] = [];
  const renderChart = () => { cursor = 0; return chartExports.S2ArtifactChart({ table: fullTable, onViewChange: (view: unknown) => viewSelections.push(view) }) as El; };
  let artifactTree = renderChart(); assert.ok(!all(artifactTree).some(e => e.type === 'chart-preview'));
  all(artifactTree).find(e => e.props['aria-label'] === '产物图表类型')!.props.onChange({ target: { value: 'line' } }); artifactTree = renderChart();
  assert.deepEqual(JSON.parse(JSON.stringify(viewSelections)), [{ kind: 'line', xKey: 'label', yKey: 'score' }]);
  all(artifactTree).find(e => e.props['aria-label'] === '产物图表类型')!.props.onChange({ target: { value: 'html' } }); artifactTree = renderChart();
  assert.equal(viewSelections.length, 1, 'Unknown view choices are rejected before state/callback changes');
  const chartElement = all(artifactTree).find(e => e.type === 'chart-preview')!;
  assert.equal(chartElement.props.chart.points.length, 100); assert.equal(chartElement.props.chart.points[99].value, 99);
  assert.equal(chartElement.props.chart.points[1].y, null); assert.equal(JSON.stringify(fullTable), beforeView);
  assert.equal(host.history().length, 3); assert.equal(host.remainingCalls, 61);
  assert.equal((globalThis as any).mustNotRun, undefined);
  console.log('S2 data views passed: declared editable typed tables, code/JSON exact text, nested controls, missing/null/empty/false, root draft validation/preview/commit/duplicate/undo, real builder and semantic/action contexts, exact parse-table-records plugin chain, template and atomic-edit checks, chart gaps/negative/extreme coordinates and escaped accessible SSR. Synthetic offline only; no browser or live-model acceptance.');
} finally { hosts.forEach(host => host.close()); globalThis.fetch = prior; }

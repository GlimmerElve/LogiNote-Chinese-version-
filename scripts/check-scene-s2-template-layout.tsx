import assert from 'node:assert/strict';
import { decodeS2PromptParts, compileS2PromptParts, inspectS2PromptTemplate, applyS2PromptParts, inspectS2PromptControls } from '../src/interaction-packs/prompt-lab/promptControls';
import { readS2Definition, createS2Scene, exportS2Workspace, importS2Workspace } from '../src/services/scene/sceneS2Canvas';
import { renderS2TextTemplate } from '../src/interaction-packs/prompt-lab/textTemplate';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import type { S2Document } from '../src/types/sceneS2';
import { browserFreeTemplateDefinition, browserFreeTemplateRequest, browserFreeTemplateText } from './fixtures/s2-browser-definition';
import { harness } from './scene-s2-ui-harness';
import { submitS2InlineContent } from './fixtures/s2-canvas-ui-actions';

const definition = readS2Definition(browserFreeTemplateDefinition, { requireBusiness: true }), original = JSON.stringify(definition);
const document = structuredClone(definition.initial), state = inspectS2PromptTemplate(definition, document, 'render');
assert.ok(state.kind === 'template');
const available = state.available;
let network = 0; const previous = globalThis.fetch;
globalThis.fetch = async () => { network++; throw new Error('Template editing uses local synthetic data only'); };
try {
  assert.equal(state.fieldSource, true); assert.match(state.sourceLabel, /提示词排版块/);
  for (const text of ['', '纯文字 $& <script>只是文字</script>', '  前缀{{role}}后缀\r\n', '{{ role }}{{\nrole\t}}', '{{{role}}}',
    '{"名称":"{{task}}"}\n\n输出：{{constraints}}\n', browserFreeTemplateText]) {
    assert.equal(compileS2PromptParts(decodeS2PromptParts(text, available), available), text);
  }
  for (const text of ['{{unknown}}', '{{role.path}}', '{{constructor}}', '{{role', 'role}}', '{{ role() }}']) assert.throws(() => decodeS2PromptParts(text, available));
  for (const parts of [null, [{ kind: 'text', text: '{{role}}' }], [{ kind: 'material', material: '' }], [{ kind: 'material', material: 'unknown' }],
    [{ kind: 'material', material: 'role', spelling: '{{task}}' }], [{ kind: 'material', material: 'role', spelling: '{{role}}\n' }],
    [{ kind: 'text', text: '', execute: true }], [{ kind: 'material', material: 'role', source: 'outside' }],
    [{ kind: 'text', text: '{' }, { kind: 'text', text: '{role}}' }], Array.from({ length: 129 }, () => ({ kind: 'text', text: '' }))]) assert.throws(() => compileS2PromptParts(parts, available));
  assert.equal(compileS2PromptParts(Array.from({ length: 128 }, () => ({ kind: 'material', material: 'role' })), available), '{{role}}'.repeat(128));
  assert.equal(compileS2PromptParts([{ kind: 'text', text: '字'.repeat(6000) }], available).length, 6000);
  assert.throws(() => compileS2PromptParts([{ kind: 'text', text: '字'.repeat(6001) }], available));
  let reads = 0; const hostile = { kind: 'text' };
  Object.defineProperty(hostile, 'text', { enumerable: true, get() { reads++; return 'never'; } });
  assert.throws(() => compileS2PromptParts([hostile], available)); assert.equal(reads, 0);
  const shared = structuredClone(document), render = shared.execution!.nodes.find(node => node.id === 'render')!;
  shared.execution!.nodes.push({ ...structuredClone(render), id: 'mirror' });
  shared.execution!.links.push({ source: { nodeId: 'bindConstraints', portId: 'variables' }, target: { nodeId: 'mirror', portId: 'variables' } });
  const sharedState = inspectS2PromptTemplate(definition, shared, 'render'); assert.ok(sharedState.kind === 'template');
  const linked = structuredClone(render.bindings.template), text = '前缀 {{ role }}\r\n{{task}}\n再次：{{role}}';
  const applied = applyS2PromptParts(definition, shared, 'render', decodeS2PromptParts(text, available), sharedState.base);
  assert.equal(applied.nodes.find(node => node.id === 'template')!.values.content, text);
  assert.deepEqual(applied.execution, shared.execution); assert.deepEqual(applied.execution!.nodes.find(node => node.id === 'render')!.bindings.template, linked);
  assert.deepEqual(applied.nodes.filter(node => node.id !== 'template'), shared.nodes.filter(node => node.id !== 'template'));
  assert.deepEqual(importS2Workspace(exportS2Workspace(definition, applied)).initial, applied);
  assert.equal(shared.nodes.find(node => node.id === 'template')!.values.content, browserFreeTemplateText);
  assert.throws(() => applyS2PromptParts(definition, applied, 'render', state.parts, sharedState.base), /已变化/);
  const unsupported = structuredClone(document); unsupported.execution!.nodes.find(node => node.id === 'bindRole')!.bindings.key = { kind: 'field', nodeId: 'role', fieldId: 'content' };
  assert.equal(inspectS2PromptTemplate(definition, unsupported, 'render').kind, 'unavailable');
  const unknown = structuredClone(document); unknown.nodes.find(node => node.id === 'template')!.values.content = '{{unknown}}';
  assert.equal(inspectS2PromptTemplate(definition, unknown, 'render').kind, 'unavailable');
  for (const initial of [undefined, { kind: 'literal' as const, value: '旧文本' }]) {
    const fixed = structuredClone(document), target = fixed.execution!.nodes.find(node => node.id === 'render')!;
    if (initial) target.bindings.template = initial; else delete target.bindings.template;
    const fixedState = inspectS2PromptTemplate(definition, fixed, 'render'); assert.ok(fixedState.kind === 'template');
    const next = applyS2PromptParts(definition, fixed, 'render', decodeS2PromptParts(text, available), fixedState.base);
    assert.deepEqual(next.execution!.nodes.find(node => node.id === 'render')!.bindings.template, { kind: 'literal', value: text });
    assert.deepEqual(next.nodes, document.nodes, 'Fixed templates must not overwrite a formerly referenced content block');
  }

  for (const deferStateUpdates of [false, true]) {
    // Parts/raw edit only this node's own literal parameter. Referenced blocks
    // have their own editor and are covered independently below.
    const literal = structuredClone(definition);
    literal.initial.execution!.nodes.find(node => node.id === 'render')!.bindings.template = { kind: 'literal', value: browserFreeTemplateText };
    const scene = createS2Scene(browserFreeTemplateRequest); scene.canvasWorkspace = literal;
    let host!: S2PluginHost; const ui = harness({ initialDraft: scene, deferStateUpdates, onHost(value) { host = value; } });
    try {
      ui.button('开始试验').props.onClick(); ui.render();
      let selectedInline = 'render';
      const inline = () => ui.inline(selectedInline);
      const select = (id: string) => { selectedInline = id; ui.flow().props.onNodeClick({}, { id }); ui.render(); };
      select('render');
      const form = () => inline().elements().find(e => e.type === 'form' && e.props['aria-label'] === '自由编辑提示词排版')!;
      const field = (label: string, type: string, value: string) => { inline().labelControl(label, type).props.onChange({ target: { value } }); ui.render(); };
      const submit = () => { form().props.onSubmit({ preventDefault() {} }); ui.render(); };
      const source = () => ui.flow().props.nodes.find((node: any) => node.id === 'render').data.node.bindings.template.value;
      const old = form().props.onSubmit;
      field('第1片段文字', 'textarea', '# 我的排版\n角色说明：'); old({ preventDefault() {} }); ui.render(); assert.equal(source(), browserFreeTemplateText);
      inline().button('在第1片段后插入材料').props.onClick(); ui.render();
      submit(); assert.equal(source(), browserFreeTemplateText); assert.match(ui.text(), /选择当前可用材料/);
      field('第2片段引用的材料', 'select', 'task'); inline().button('下移第2片段').props.onClick(); ui.render();
      inline().button('上移第3片段').props.onClick(); ui.render(); inline().button('移除第2片段').props.onClick(); ui.render();
      inline().button('添加文字片段').props.onClick(); ui.render();
      field('第10片段文字', 'textarea', '\n复核任务：'); inline().button('添加材料引用').props.onClick(); ui.render();
      field('第11片段引用的材料', 'select', 'task');
      inline().button('查看或编辑完整模板（高级）').props.onClick(); ui.render();
      const full = inline().labelControl('完整模板原文（高级）', 'textarea').props.value;
      assert.equal(full, browserFreeTemplateText.replace('# 提示词草稿', '# 我的排版') + '\n复核任务：{{task}}');
      field('完整模板原文（高级）', 'textarea', full + '\n{{unknown}}'); inline().button('切回按名称编辑').props.onClick(); ui.render();
      assert.equal(inline().labelControl('完整模板原文（高级）', 'textarea').props.value, full + '\n{{unknown}}'); assert.equal(source(), browserFreeTemplateText);
      field('完整模板原文（高级）', 'textarea', full); inline().button('切回按名称编辑').props.onClick(); ui.render();
      select('bindRole'); select('render'); assert.equal(source(), browserFreeTemplateText);
      assert.equal(host.workflowHistory().length, 0); assert.equal(host.remainingCalls, 64); assert.equal(ui.modelCalls(), 0);
      const once = form().props.onSubmit; once({ preventDefault() {} }); once({ preventDefault() {} }); ui.render(); assert.equal(source(), full);
      assert.equal(host.workflowHistory().length, 0); assert.equal(host.remainingCalls, 64);
      const after = ui.flow().props.nodes.find((node: any) => node.id === 'render').data.node;
      assert.deepEqual(after.bindings.template, { kind: 'literal', value: full });
      assert.equal(ui.flow().props.nodes.find((node: any) => node.id === 'template').data.fields[0].value, browserFreeTemplateText, 'A literal editor never overwrites the unused original content block');
      ui.button('运行所选步骤').props.onClick();
      for (let i = 0; i < 40 && host.workflowHistory().at(-1)?.status !== 'succeeded'; i++) { await new Promise(resolve => setTimeout(resolve, 0)); ui.render(); }
      const run = host.workflowHistory().at(-1)!; assert.equal(run.status, 'succeeded'); assert.equal(host.remainingCalls, 60);
      const artifact = host.currentArtifact(run.nodes.find(node => node.nodeId === 'render')!.artifactIds[0]);
      const variables = Object.fromEntries(['role', 'task', 'constraints'].map(id => [id, document.nodes.find(node => node.id === id)!.values.content]));
      assert.ok(artifact.payload.kind === 'inline'); if (artifact.payload.kind === 'inline') assert.equal(artifact.payload.value, renderS2TextTemplate(full, variables));
      const stale = form().props.onSubmit; ui.keyShortcut('undo'); ui.render(); stale({ preventDefault() {} }); ui.render();
      assert.equal(source(), browserFreeTemplateText); assert.match(inline().text(), /草稿已保留/); assert.equal(host.remainingCalls, 60);
      ui.keyShortcut('redo'); ui.render(); assert.equal(source(), full); assert.equal(host.workflowHistory().length, 1);
      const reload = inline().button('载入当前自由排版').props.onClick;
      field('第1片段文字', 'textarea', '新的私有草稿'); reload(); ui.render(); assert.equal(inline().labelControl('第1片段文字', 'textarea').props.value, '新的私有草稿');
      ui.button('结束试验').props.onClick(); ui.render(); submit(); assert.equal(source(), full); assert.equal(ui.modelCalls(), 0);
    } finally { ui.dispose(); }
  }
  // Field-backed templates expose one source navigator, never a duplicate
  // parts/raw editor. Both consumers retain their exact binding to that block.
  for (const deferStateUpdates of [false, true]) for (const readOnly of [false, true]) {
    const sourceDefinition = readS2Definition({ ...structuredClone(definition), initial: structuredClone(shared) });
    sourceDefinition.initial.nodes.find(node => node.id === 'template')!.readOnly = readOnly;
    const scene = createS2Scene(browserFreeTemplateRequest); scene.canvasWorkspace = sourceDefinition;
    let host!: S2PluginHost;
    const ui = harness({ initialDraft: scene, deferStateUpdates, onHost(value) { host = value; } });
    const select = (id: string) => { ui.flow().props.onNodeClick({}, { id }); ui.render(); };
    const inline = () => ui.inline('render');
    const current = (): S2Document => ui.elements().find(element => element.type === 'run-summary')!.props.document;
    try {
      ui.button('开始试验').props.onClick(); ui.render(); select('render');
      assert.ok(inline().elements().some(element => element.props['aria-label'] === '提示词排版来源'));
      assert.ok(!inline().elements().some(element => element.type === 'form'), 'The source navigator does not mount another text/parts/raw form');
      assert.ok(!ui.elements().some(element => /「提示词排版」的材料设置$/.test(element.props['aria-label'] ?? '')), 'A referenced template has no second ordinary material editor');
      const navigation = inline().button(readOnly ? '查看原内容' : '编辑原内容').props.onClick;
      navigation(); ui.render();
      const sourceNode = () => ui.flow().props.nodes.find((node: any) => node.id === 'template');
      assert.equal(sourceNode().selected, true); assert.equal(host.history().length, 0); assert.equal(ui.modelCalls(), 0);
      if (readOnly) {
        assert.equal(sourceNode().data.fields[0].editor, undefined);
        const before = structuredClone(current()); sourceNode().data.fields[0].startEdit(); ui.render();
        assert.deepEqual(current(), before, 'A fixed source remains read-only even through a forged edit activation');
      } else {
        assert.equal(sourceNode().data.fields[0].editor.props.variant, 'inline');
        submitS2InlineContent(ui, 'template', text);
        assert.equal(current().nodes.find(node => node.id === 'template')!.values.content, text);
        for (const id of ['render', 'mirror']) assert.deepEqual(current().execution!.nodes.find(node => node.id === id)!.bindings.template, linked);
        assert.equal(host.history().length, 0, 'Editing the shared source does not execute either consumer');
        const result = await host.enqueueWorkflow(['render', 'mirror']).completion;
        assert.equal(result.status, 'succeeded');
        const variables = Object.fromEntries(['role', 'task', 'constraints'].map(id => [id, document.nodes.find(node => node.id === id)!.values.content]));
        for (const id of ['render', 'mirror']) {
          const artifact = host.currentArtifact(result.nodes.find(node => node.nodeId === id)!.artifactIds[0]);
          assert.equal(artifact.payload.kind, 'inline'); if (artifact.payload.kind === 'inline') assert.equal(artifact.payload.value, renderS2TextTemplate(text, variables));
        }
        ui.render(); select('mirror'); navigation(); ui.render();
        assert.equal(ui.flow().props.nodes.find((node: any) => node.selected).id, 'mirror', 'An old source navigator cannot retake selection after an edit/render');
        assert.equal(sourceNode().data.fields[0].editor, undefined);
      }
      select('render'); const ended = inline().button(readOnly ? '查看原内容' : '编辑原内容').props.onClick;
      ui.button('结束试验').props.onClick(); ui.render(); ended(); ui.render();
      assert.equal(sourceNode().data.fields[0].editor, undefined); assert.equal(ui.modelCalls(), 0);
    } finally { ui.dispose(); }
  }
  // A simple section draft may enter free editing without applying or losing its order/text.
  const literalDefinition = structuredClone(definition); literalDefinition.initial.execution!.nodes.find(node => node.id === 'render')!.bindings.template = { kind: 'literal', value: '角色\n{{role}}' };
  const literalScene = createS2Scene(browserFreeTemplateRequest); literalScene.canvasWorkspace = literalDefinition;
  const ui = harness({ initialDraft: literalScene });
  try {
    ui.button('开始试验').props.onClick(); ui.render(); ui.flow().props.onNodeClick({}, { id: 'render' }); ui.render();
    const inline = () => ui.inline('render');
    inline().labelControl('第1段标题（可选）', 'input').props.onChange({ target: { value: '我改的标题' } }); ui.render();
    const oldSection = inline().elements().find(e => e.type === 'form' && e.props['aria-label'] === '按内容名称安排提示词')!.props.onSubmit;
    inline().button('自由编辑这份排版').props.onClick(); ui.render(); oldSection({ preventDefault() {} }); ui.render();
    assert.equal(inline().labelControl('第1片段文字', 'textarea').props.value, '我改的标题\n');
    assert.equal(ui.flow().props.nodes.find((node: any) => node.id === 'render').data.node.bindings.template.value, '角色\n{{role}}');
    assert.equal(ui.modelCalls(), 0);
  } finally { ui.dispose(); }
  assert.equal(JSON.stringify(definition), original); assert.equal(network, 0);
  console.log('S2 free template layout passed: exact literal grammar/whitespace/CRLF, bounded literal-only inline parts/raw/simple forms, pure field-apply compatibility, field source navigation without a duplicate editor, block-local edit preserving both consumer bindings and their actual local outputs, readonly/stale/end guards, native save/restore and draft undo/redo ownership. Synthetic offline only; no model/network.');
} finally { globalThis.fetch = previous; }

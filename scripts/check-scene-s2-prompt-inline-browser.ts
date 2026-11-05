import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { s2BrowserIsolationConfig } from './vite-s2-browser.config';
import { SYNTHETIC_EXPERIMENT_PNG } from './fixtures/s2-experiment';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = '/scripts/fixtures/s2-prompt-inline-browser.html';
const output = path.join(repository, 'output/scene-s2-prompt-inline');
const modules = process.env.SCENE_BROWSER_MODULES || process.env.LOGINOTE_BROWSER_MODULES || process.env.LOGINOTE_PLAYWRIGHT_MODULES || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const { chromium } = createRequire(path.join(modules, 's2-prompt-inline-browser.cjs'))('playwright');
await fs.mkdir(output, { recursive: true });
const errors: string[] = [], remote: string[] = [], modulePaths = new Set<string>(), checks: string[] = [];
let browser: any, page: any, server: Awaited<ReturnType<typeof createServer>> | undefined;
try {
  const config = s2BrowserIsolationConfig(id => modulePaths.add(id));
  server = await createServer({ ...config, configFile: false, logLevel: 'error',
    optimizeDeps: { ...config.optimizeDeps, entries: [path.join(repository, entry.slice(1))] },
    server: { ...config.server, port: 0, strictPort: false } });
  await server.listen(); const address = server.httpServer!.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.SCENE_BROWSER_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1800, height: 1150 }, reducedMotion: 'reduce' });
  await context.route('**/*', (route: any) => {
    const url = new URL(route.request().url()); if (url.origin === origin) return route.continue();
    remote.push(url.href); return route.abort();
  });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(origin + entry);
  await page.getByRole('heading', { name: 'S2 实验画布', exact: true }).waitFor();
  const title = page.getByRole('heading', { name: 'S2 实验画布', exact: true });
  const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
  const panel = page.getByRole('region', { name: '画布操作面板', exact: true });
  const audit = () => page.evaluate(() => (window as any).__s2PromptInline.audit());
  const messages = () => page.locator('.s2-messages>div').count();
  const fit = async () => { await page.locator('.react-flow__controls-fitview').click(); await page.waitForTimeout(200); };
  const assertDirectTestUI = async () => {
    const text = await page.locator('.s2-trial').textContent();
    const forbidden = text.match(/运行与发送前核对|确认发送|核对并批准本局预算|批准本局模型测试预算|前往核对|等待你的操作|复用说明历史大面板/u);
    assert(!forbidden, `A test click must not depend on hidden confirmation, budget approval or review steps: ${forbidden?.[0] ?? ''}`);
    assert.equal(await page.locator('.s2-trial [aria-label="等待你的操作"]').count(), 0);
    assert.equal(await page.locator('.s2-trial [aria-label="模型测试授权与用量"]').count(), 0);
  };
  await node('assemble').locator('summary').filter({ hasText: '提示词结构' }).waitFor();
  await fit();
  const taskPreview = node('task').locator('.s2-content-preview');
  await taskPreview.click(); assert.equal(await panel.isVisible(), false);
  assert.equal(await node('task').locator('textarea').count(), 0); assert.equal(await messages(), 0);
  await taskPreview.dblclick();
  const taskInput = node('task').getByRole('textbox', { name: '内容', exact: true });
  await taskInput.waitFor(); assert(await taskInput.evaluate((element: HTMLElement) => element === document.activeElement));
  assert.equal(await panel.isVisible(), false);
  const originalTask = (await audit()).draft.canvasWorkspace.initial.nodes.find((item: any) => item.id === 'task').values.content;
  const editedTask = '解释待处理材料，保留原文。\n用一个简短例子说明。';
  await taskInput.fill(editedTask);
  await page.screenshot({ path: path.join(output, 'prompt-inline-editing.png'), fullPage: true });
  await title.click();
  await taskInput.waitFor({ state: 'hidden' }); await taskPreview.getByText(editedTask, { exact: true }).waitFor();
  let snapshot = await audit();
  assert.equal(snapshot.draft.canvasWorkspace.initial.nodes.find((item: any) => item.id === 'task').values.content, editedTask);
  assert.notEqual(editedTask, originalTask); assert.equal(await messages(), 0); assert.equal(snapshot.agentCalls.length, 0);
  checks.push('正式内容节点单击不弹设置，双击真实聚焦并在失焦后校验保存；聊天和Agent调用均不增加');

  const materialPreview = node('testInput').locator('.s2-content-preview');
  const materialOriginal = snapshot.draft.canvasWorkspace.initial.nodes.find((item: any) => item.id === 'testInput').values.content;
  await materialPreview.dblclick();
  const materialInput = node('testInput').getByRole('textbox', { name: '内容', exact: true });
  await materialInput.fill('这段草稿应该丢弃。'); await materialInput.press('Escape');
  await materialInput.waitFor({ state: 'hidden' }); await materialPreview.getByText(materialOriginal, { exact: true }).waitFor();
  await materialPreview.dblclick();
  const editedMaterial = '确认偏误：人们可能偏好支持已有看法的信息。\n这是隔离验收材料。';
  await materialInput.fill(editedMaterial); await materialInput.press('Control+Enter');
  await materialInput.waitFor({ state: 'hidden' }); await materialPreview.getByText(editedMaterial, { exact: true }).waitFor();
  assert.equal(await messages(), 0); assert.equal(await panel.isVisible(), false);
  checks.push('测试材料双击块内编辑，Escape只丢草稿，Ctrl+Enter保存完整多行材料');

  await taskPreview.dblclick(); await taskInput.fill(''); await title.click();
  assert(await taskInput.isVisible()); await node('task').getByRole('alert').first().waitFor();
  snapshot = await audit(); assert.equal(snapshot.draft.canvasWorkspace.initial.nodes.find((item: any) => item.id === 'task').values.content, editedTask);
  await taskInput.fill(editedTask); await title.click(); await taskInput.waitFor({ state: 'hidden' });
  await node('role').locator('.s2-content-preview').dblclick();
  assert.equal(await node('role').getByRole('textbox').count(), 0); assert.equal(await panel.isVisible(), false);
  checks.push('必填失败保留真实编辑器和原值，可修正恢复；固定只读内容不能双击解锁');

  const compose = node('assemble'), inlineDisclosure = compose.locator('details.s2-prompt-node-editor');
  assert.equal(await inlineDisclosure.getAttribute('open'), null);
  assert.equal(await compose.getByRole('region', { name: '组装结构', exact: true }).isVisible(), false);
  await inlineDisclosure.locator(':scope > summary').click();
  await compose.getByRole('region', { name: '组装结构', exact: true }).waitFor();
  assert.equal(await panel.isVisible(), false);
  assert.equal(await compose.getByRole('combobox').count(), 0, 'The assembler wires inputs on the canvas, rather than choosing fields in a second property form');
  const originalBindings = (await audit()).draft.canvasWorkspace.initial.execution.nodes.find((item: any) => item.id === 'assemble').bindings;
  await compose.getByRole('textbox', { name: '入口1标题', exact: true }).fill('角色说明：'); await title.click();
  snapshot = await audit();
  assert.equal(snapshot.draft.canvasWorkspace.initial.execution.nodes.find((item: any) => item.id === 'assemble').bindings.prefixes.value[0], '角色说明：');
  assert.deepEqual(Object.fromEntries(Object.entries(snapshot.draft.canvasWorkspace.initial.execution.nodes.find((item: any) => item.id === 'assemble').bindings).filter(([key]) => /^part/u.test(key))),
    Object.fromEntries(Object.entries(originalBindings).filter(([key]) => /^part/u.test(key))), 'Structure edits preserve all real canvas source mappings');
  assert.equal(await compose.locator('.s2-input-port').count(), 3);
  assert.equal(await messages(), 0); assert.equal(snapshot.agentCalls.length, 0);
  await page.screenshot({ path: path.join(output, 'prompt-inline-compose.png'), fullPage: true });
  await inlineDisclosure.locator(':scope > summary').click();
  checks.push('组装块预设3个真实入口，折叠结构只编辑标题/分隔并失焦保存，来源映射由画布连线保留');

  const beforeNodes = snapshot.draft.canvasWorkspace.initial.execution.nodes.map((item: any) => item.id);
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await panel.waitFor();
  const assemblyGroup = panel.getByRole('region', { name: '提示词组装块', exact: true });
  await assemblyGroup.waitFor();
  for (const name of ['提示词测试块', '结果展示块', '待测资料块']) {
    await panel.getByRole('region', { name, exact: true }).waitFor();
  }
  assert.equal(await panel.locator('.s2-component-menu > section').count(), 5);
  assert.deepEqual(await panel.locator('button[data-s2-component]').evaluateAll((buttons: HTMLButtonElement[]) => buttons.map(button => button.dataset.s2Component)),
    ['content', 'compose', 'model-test', 'result', 'material-text', 'material-file', 'material-image'], 'The same public types as the building Agent are offered in five logical groups');
  assert.equal(await panel.getByRole('region', { name: '其他组件', exact: true }).count(), 0);
  await page.screenshot({ path: path.join(output, 'prompt-inline-add-menu.png'), fullPage: true });
  await assemblyGroup.locator('button[data-s2-component="compose"]').click();
  await page.waitForFunction((before: string[]) => (window as any).__s2PromptInline.audit().draft.canvasWorkspace.initial.execution.nodes.some((item: any) => !before.includes(item.id)), beforeNodes);
  snapshot = await audit();
  const added = snapshot.draft.canvasWorkspace.initial.execution.nodes.find((item: any) => !beforeNodes.includes(item.id));
  assert.equal(added.pluginId, 'text-template'); assert.equal(added.capabilityId, 'compose');
  assert.equal(snapshot.agentCalls.length, 0); assert.equal(snapshot.modelRequests, 0);
  if (await panel.isVisible()) await page.getByRole('button', { name: '关闭画布操作面板', exact: true }).click();
  await fit();
  await page.screenshot({ path: path.join(output, 'prompt-inline-preview.png'), fullPage: true });
  checks.push('按包声明的用途分类显示添加菜单，点击组装提示词直接添加真实capability节点，零模型调用');

  assert.equal(await page.getByRole('button', { name: '开始试验', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /^(开启|关闭)助手$/ }).count(), 0);
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await panel.waitFor();
  const menuButtons = panel.locator('button[data-s2-component]');
  const capabilityStates = await menuButtons.evaluateAll((buttons: HTMLButtonElement[]) => buttons.map(button => ({
    key: button.dataset.s2Component, disabled: button.disabled,
  })));
  assert.equal(capabilityStates.length, 7); assert(capabilityStates.every((cap: any) => !cap.disabled), 'All explicitly public types stay available while running');
  assert(!capabilityStates.some((cap: any) => /bind|render/u.test(cap.key)), 'Private legacy implementations never appear as public types');
  await page.getByRole('button', { name: '关闭画布操作面板', exact: true }).click();
  checks.push('预览与运行共用同一公开目录，七个明确公开类型可添加，内部bind/render不开放');
  await taskPreview.dblclick(); await taskInput.fill(editedTask + '\n运行中再次编辑。'); await title.click();
  await taskInput.waitFor({ state: 'hidden' }); assert.equal(await messages(), 0);
  snapshot = await audit(); assert.equal(snapshot.agentCalls.length, 0); assert.equal(snapshot.modelRequests, 0);
  const question = '解释当前任务和材料。';
  await page.getByRole('textbox', { name: '向 Agent 提出要求', exact: true }).fill(question);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.locator('.s2-messages').getByText(question, { exact: true }).waitFor();
  await page.locator('.s2-messages').getByText(/合成协议回应/).waitFor();
  assert.equal(await messages(), 2);
  assert(!((await page.locator('.s2-messages').innerText()).includes('field-submit')));
  snapshot = await audit(); assert.deepEqual(snapshot.agentCalls.map((call: any) => call.stage), ['public-interaction']);
  checks.push('运行中字段保存不伪造用户聊天；明确发给Agent的消息和对应合成回复正常保留');
  await page.screenshot({ path: path.join(output, 'prompt-inline-running.png'), fullPage: true });
  assert.equal(snapshot.realModelCalls, 0); assert.equal(snapshot.modelRequests, 0);
  assert.equal(snapshot.storageAttempts, 0); assert.equal(snapshot.deniedNetwork, 0);
  assert.equal(snapshot.persistentWrites, 0); assert.equal(snapshot.storeWrites, 0); assert.equal(snapshot.networkCalls, 0);

  // A fresh, opt-in fixture view calls the public pack navigation API; the preceding prompt trial stays unmodified.
  await page.goto(origin + entry + '?navigation=1'); await title.waitFor(); await fit();
  const navBefore = await audit();
  const navigationSource = node('assemble');
  await navigationSource.getByRole('button', { name: '定位第二字段', exact: true }).click();
  const navInput = node('navEdit').getByRole('textbox', { name: '第二字段', exact: true });
  await navInput.waitFor(); await page.waitForTimeout(50);
  assert(await navInput.isVisible(), 'Navigation must not blur-save and close the editor it just opened');
  assert(await navInput.evaluate((element: HTMLElement) => element === document.activeElement));
  const navFields = node('navEdit').locator('.s2-field-port[tabindex="-1"]');
  assert.equal(await navFields.nth(0).locator(':scope > details').getAttribute('open'), null);
  assert.notEqual(await navFields.nth(1).locator(':scope > details').getAttribute('open'), null);
  assert.equal(await node('navEdit').getByRole('textbox', { name: '第一字段', exact: true }).count(), 0);
  assert.equal(await panel.isVisible(), false); assert.equal(await messages(), 0);
  assert.deepEqual((await audit()).draft.canvasWorkspace.initial, navBefore.draft.canvasWorkspace.initial, 'Navigation alone must not change original fields');
  await page.screenshot({ path: path.join(output, 'prompt-inline-navigation-editable.png'), fullPage: true });
  await navInput.fill('仅修改第二字段，第一字段保持原文。'); await title.click();
  await navInput.waitFor({ state: 'hidden' });
  let navSnapshot = await audit();
  assert.deepEqual(navSnapshot.draft.canvasWorkspace.initial.nodes.find((item: any) => item.id === 'navEdit').values,
    { first: '第一字段保持原文。', second: '仅修改第二字段，第一字段保持原文。' });

  await navigationSource.getByRole('button', { name: '定位只读第二字段', exact: true }).click();
  const readOnlyFields = node('navReadOnly').locator('.s2-field-port[tabindex="-1"]');
  await readOnlyFields.nth(1).getByText('只读第二字段原文。', { exact: true }).waitFor();
  assert.notEqual(await readOnlyFields.nth(1).locator(':scope > details').getAttribute('open'), null);
  assert.equal(await readOnlyFields.nth(0).locator(':scope > details').getAttribute('open'), null);
  assert(await readOnlyFields.nth(1).evaluate((element: HTMLElement) => element === document.activeElement));
  assert.equal(await node('navReadOnly').getByRole('textbox').count(), 0); assert.equal(await panel.isVisible(), false);
  navSnapshot = await audit();
  assert.deepEqual(navSnapshot.draft.canvasWorkspace.initial.nodes.find((item: any) => item.id === 'navReadOnly'),
    navBefore.draft.canvasWorkspace.initial.nodes.find((item: any) => item.id === 'navReadOnly'));
  assert.equal(await messages(), 0); assert.equal(navSnapshot.agentCalls.length, 0);
  for (const key of ['realModelCalls', 'modelRequests', 'storageAttempts', 'deniedNetwork', 'persistentWrites', 'storeWrites', 'networkCalls']) assert.equal(navSnapshot[key], 0);
  await page.screenshot({ path: path.join(output, 'prompt-inline-navigation-readonly.png'), fullPage: true });
  checks.push('包视图可准确定位多字段的第二字段，自动展开高级内容并保持输入焦点；只读第二字段只展开和聚焦预览');

  await page.goto(origin + entry + '?template=1'); await title.waitFor(); await fit();
  const sourceBefore = await audit(), editableRender = node('sourceEditable'), readOnlyRender = node('sourceReadOnly');
  for (const sourceNode of [editableRender, readOnlyRender]) {
    await sourceNode.locator('summary').filter({ hasText: '提示词排版' }).click();
    await sourceNode.getByRole('region', { name: '提示词排版来源', exact: true }).waitFor();
    assert.equal(await sourceNode.locator('form,textarea,input,select,.s2-prompt-part').count(), 0,
      'A referenced content field has exactly one editor, inside its original block');
  }
  const sourceBinding = sourceBefore.draft.canvasWorkspace.initial.execution.nodes.find((item: any) => item.id === 'sourceEditable').bindings.template;
  await editableRender.getByRole('button', { name: '编辑原内容', exact: true }).click();
  const originalInput = node('navEdit').getByRole('textbox', { name: '第二字段', exact: true });
  await originalInput.waitFor(); assert(await originalInput.evaluate((element: HTMLElement) => element === document.activeElement));
  assert.equal(await node('navEdit').getByRole('textbox', { name: '第一字段', exact: true }).count(), 0);
  const updatedTemplate = '修改后的原始模板：{{task}}';
  await originalInput.fill(updatedTemplate); await title.click(); await originalInput.waitFor({ state: 'hidden' });
  let sourceSnapshot = await audit();
  assert.equal(sourceSnapshot.draft.canvasWorkspace.initial.nodes.find((item: any) => item.id === 'navEdit').values.second, updatedTemplate);
  assert.deepEqual(sourceSnapshot.draft.canvasWorkspace.initial.execution.nodes.find((item: any) => item.id === 'sourceEditable').bindings.template, sourceBinding);
  assert.equal(await messages(), 0); assert.equal(await panel.isVisible(), false);

  await readOnlyRender.getByRole('button', { name: '查看原内容', exact: true }).click();
  const readonlySourceField = node('navReadOnly').locator('.s2-field-port[tabindex="-1"]').nth(1);
  await readonlySourceField.getByText('固定模板：{{task}}', { exact: true }).waitFor();
  assert(await readonlySourceField.evaluate((element: HTMLElement) => element === document.activeElement));
  assert.equal(await node('navReadOnly').getByRole('textbox').count(), 0);
  assert.equal(await readOnlyRender.getByRole('button', { name: '编辑原内容', exact: true }).count(), 0);
  await page.screenshot({ path: path.join(output, 'prompt-inline-template-source.png'), fullPage: true });

  // Capture the real rendered source button closure. Clicking detached DOM would merely test browser event removal.
  await editableRender.getByRole('button', { name: '编辑原内容', exact: true }).evaluate((button: HTMLElement) => {
    const key = Object.keys(button).find(name => name.startsWith('__reactProps$'));
    const action = key && (button as any)[key]?.onClick;
    if (typeof action !== 'function') throw new Error('Could not capture the production React source-button callback');
    (window as any).__oldSourceButtonAction = action;
  });
  sourceSnapshot = await audit(); const replacement = structuredClone(sourceSnapshot.draft.canvasWorkspace);
  replacement.initial.nodes.find((item: any) => item.id === 'navEdit').values.second = '替换图后的新正文。';
  replacement.initial.execution.nodes.find((item: any) => item.id === 'sourceEditable').bindings.template = { kind: 'field', nodeId: 'navEdit', fieldId: 'first' };
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByText('工作区导入／导出', { exact: true }).click();
  await page.getByRole('textbox', { name: '工作区 JSON', exact: true }).fill(JSON.stringify({ format: 's2-workspace', version: 2,
    interactionPack: { id: 'prompt-lab', version: '0.1.0' }, definition: replacement }));
  await page.getByRole('button', { name: '导入并替换当前预览', exact: true }).click();
  await page.getByText('已导入交互包引用和画布预览', { exact: false }).waitFor();
  const afterReplacement = await audit();
  await page.evaluate(() => (window as any).__oldSourceButtonAction());
  await page.waitForTimeout(50);
  const afterOldAction = await audit();
  assert.deepEqual(afterOldAction.draft, afterReplacement.draft, 'The actual previous source-button callback cannot act on a replacement graph');
  assert.equal(await node('navEdit').getByRole('textbox').count(), 0);
  assert.equal(await page.locator('.react-flow__node.selected').count(), 0);
  assert.deepEqual(afterOldAction.draft.canvasWorkspace.initial.nodes.find((item: any) => item.id === 'navReadOnly'),
    sourceBefore.draft.canvasWorkspace.initial.nodes.find((item: any) => item.id === 'navReadOnly'));
  assert.equal(await messages(), 0); assert.equal(afterOldAction.agentCalls.length, 0);
  for (const key of ['realModelCalls', 'modelRequests', 'storageAttempts', 'deniedNetwork', 'persistentWrites', 'storeWrites', 'networkCalls']) assert.equal(afterOldAction[key], 0);
  checks.push('引用模板仅显示来源导航，正文只在原块编辑且保留field绑定；只读仅查看，真实旧按钮回调不能作用于替换图');

  const modelFlows: Array<{ source: string; modelRequests: number; input: string; imageCount: number }> = [];
  for (const mode of ['text', 'file', 'image']) {
    await page.goto(origin + entry + (mode === 'text' ? '' : `?material=${mode}`)); await title.waitFor(); await fit();
    const initial = await audit(), actualTest = node('testModel'), result = node('showResult');
    await assertDirectTestUI(); assert.equal(initial.preparations, 0); assert.equal(initial.sessions, 0);
    assert(await actualTest.getByRole('button', { name: '测试', exact: true }).isEnabled());
    assert.equal(await actualTest.getByRole('textbox', { name: '输出长度上限', exact: true }).count(), 0);
    const outputLength = actualTest.getByRole('spinbutton', { name: '输出长度上限', exact: true });
    await outputLength.fill('512'); await title.click();
    assert.equal((await audit()).modelRequests, 0);
    const material = mode === 'file' ? node('material') : mode === 'image' ? node('picture') : node('testInput');
    if (mode !== 'text') assert(await material.getByLabel(mode === 'file' ? '选择本地文本资料' : '选择本地图片', { exact: true }).isEnabled());
    const materialText = mode === 'file' ? '  # 本局合成文件\n保留 $& 与 {{literal}}，它们是资料原文。\n  '
      : initial.draft.canvasWorkspace.initial.nodes.find((item: any) => item.id === 'testInput').values.content;
    if (mode === 'file') {
      await material.getByLabel('选择本地文本资料', { exact: true }).setInputFiles({ name: '合成待测资料.md', mimeType: 'text/plain', buffer: Buffer.from(materialText, 'utf8') });
      await material.getByRole('combobox', { name: '选用已提供的文本资料', exact: true }).waitFor();
      assert.match(await material.getByRole('combobox', { name: '选用已提供的文本资料', exact: true }).inputValue(), /^textfile-/);
    } else if (mode === 'image') {
      await material.getByLabel('选择本地图片', { exact: true }).setInputFiles({ name: '合成待测图片.png', mimeType: 'image/png', buffer: Buffer.from(SYNTHETIC_EXPERIMENT_PNG, 'base64') });
      await material.getByRole('img', { name: '待处理图片：合成待测图片.png', exact: true }).waitFor();
    }
    assert.equal(await panel.isVisible(), false, 'Material input stays inside its node');
    const beforeSend = await audit(); assert.equal(beforeSend.modelRequests, 0); assert.equal(beforeSend.preparations, 0);
    const definition = initial.draft.canvasWorkspace, assemble = definition.initial.execution.nodes.find((item: any) => item.id === 'assemble');
    const expectedPrompt = ['role', 'task', 'constraints'].map((id, index) => assemble.bindings.prefixes.value[index]
      + definition.initial.nodes.find((item: any) => item.id === id).values.content).join('\n');
    await actualTest.getByRole('button', { name: '测试', exact: true }).click();
    await result.locator('.s2-node-result').getByText(/合成模型回包/).waitFor();
    const completed = await audit(); assert.equal(completed.modelRequests, 1);
    assert.equal(completed.preparations, 1); assert.equal(completed.sessions, 1, 'The explicit test action prepares its configured synthetic session without another UI step');
    const sent = completed.syntheticRequests[0]; assert.equal(sent.prompt, expectedPrompt); assert.equal(sent.input, materialText);
    assert.equal(sent.maxOutputTokens, 512); assert.equal(sent.imageIds?.length ?? 0, mode === 'image' ? 1 : 0);
    assert.equal(await actualTest.locator('.s2-node-result').count(), 0); assert.equal(await node('assemble').locator('.s2-node-result').count(), 0);
    if (mode !== 'text') assert.equal(await material.locator('.s2-node-result').count(), 0);
    await assertDirectTestUI(); assert.equal(await panel.isVisible(), false);
    assert.equal(await messages(), 0); assert.equal(completed.agentCalls.length, 0);
    for (const key of ['realModelCalls', 'storageAttempts', 'deniedNetwork', 'persistentWrites', 'storeWrites', 'networkCalls']) assert.equal(completed[key], 0);
    await fit(); await page.screenshot({ path: path.join(output, `prompt-five-block-${mode}.png`), fullPage: true });
    modelFlows.push({ source: mode, modelRequests: completed.modelRequests, input: sent.input, imageCount: sent.imageIds?.length ?? 0 });
  }
  checks.push('文本、文件和图片三条链路均只点击一次测试，自动准备已配置会话并发送一次合成请求；无预算或发送确认界面，结果只在结果块展示');

  const boundaries: Array<{ kind: string; requests: number; aborts: number }> = [];
  const startControlled = async (mode: string) => {
    await page.goto(origin + entry + `?control=${mode}`); await title.waitFor(); await fit(); await assertDirectTestUI();
    const initial = await audit(); assert.equal(initial.modelRequests, 0); assert.equal(initial.preparations, 0);
    assert(await node('testModel').getByRole('button', { name: '测试', exact: true }).isEnabled());
  };
  const waitTestEnabled = () => page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>('.react-flow__node[data-id="testModel"] button')]
    .some(button => button.textContent === '测试' && !button.disabled));
  await startControlled('defer');
  await node('testModel').getByRole('button', { name: '测试', exact: true }).dblclick({ delay: 40 });
  await page.waitForFunction(() => (window as any).__s2PromptInline.audit().pendingResponses === 1);
  let pending = await audit(); assert.equal(pending.modelRequests, 1); assert.equal(pending.preparations, 1);
  assert(await node('testModel').getByRole('button', { name: '测试', exact: true }).isDisabled());
  await node('testModel').getByRole('button', { name: '停止', exact: true }).waitFor();
  await assertDirectTestUI(); assert.equal(await panel.isVisible(), false);
  await page.screenshot({ path: path.join(output, 'prompt-direct-pending.png'), fullPage: true });
  await node('testModel').getByRole('button', { name: '停止', exact: true }).click();
  await page.waitForFunction(() => (window as any).__s2PromptInline.audit().aborts === 1); await waitTestEnabled();
  await page.evaluate(() => (window as any).__s2PromptInline.releaseResponses()); await page.waitForTimeout(80);
  pending = await audit(); assert.equal(pending.modelRequests, 1); assert.equal(pending.pendingResponses, 0);
  assert.equal(await node('showResult').getByText(/合成调用编号：1/).count(), 0, 'A stopped request never publishes its later response as a current result');
  boundaries.push({ kind: 'double-click-stop-late-response', requests: pending.modelRequests, aborts: pending.aborts });

  await startControlled('fail'); await node('testModel').getByRole('button', { name: '测试', exact: true }).click();
  const inlineFailure = node('testModel').locator('.s2-workflow-node.s2-node-failed');
  await inlineFailure.waitFor(); assert((await inlineFailure.locator(':scope > p').innerText()).trim().length > 0); await waitTestEnabled();
  const failed = await audit(); assert.equal(failed.modelRequests, 1); assert.equal(failed.failures, 1);
  await page.waitForTimeout(80); assert.equal((await audit()).modelRequests, 1, 'A failure cannot silently retry');
  assert.equal(await node('showResult').getByText(/合成调用编号：1/).count(), 0);
  await assertDirectTestUI(); assert.equal(await panel.isVisible(), false);
  await page.screenshot({ path: path.join(output, 'prompt-direct-failure.png'), fullPage: true });
  await page.evaluate(() => (window as any).__s2PromptInline.setTransportMode('auto'));
  await node('testModel').getByRole('button', { name: '测试', exact: true }).click();
  await node('showResult').getByText(/合成调用编号：2/).waitFor();
  await node('testModel').locator('.s2-workflow-node.s2-node-succeeded').waitFor();
  assert.equal(await node('testModel').getByRole('alert').count(), 0);
  boundaries.push({ kind: 'inline-failure-manual-retry', requests: (await audit()).modelRequests, aborts: (await audit()).aborts });

  await startControlled('auto');
  await node('testModel').getByRole('button', { name: '测试', exact: true }).evaluate((button: HTMLElement) => {
    const key = Object.keys(button).find(name => name.startsWith('__reactProps$')), action = key && (button as any)[key]?.onClick;
    if (typeof action !== 'function') throw new Error('Could not capture the actual production test callback');
    (window as any).__oldTestButtonAction = action;
  });
  await node('task').locator('.s2-content-preview').dblclick();
  await node('task').getByRole('textbox', { name: '内容', exact: true }).fill('编辑只更新原文，不自动测试。'); await title.click();
  await node('task').getByRole('textbox', { name: '内容', exact: true }).waitFor({ state: 'hidden' });
  await page.evaluate(() => (window as any).__oldTestButtonAction()); await page.waitForTimeout(80);
  const stale = await audit(); assert.equal(stale.modelRequests, 0); assert.equal(stale.preparations, 0);
  await node('testModel').getByRole('button', { name: '测试', exact: true }).click();
  await node('showResult').getByText(/合成调用编号：1/).waitFor();
  const fresh = await audit(); assert.equal(fresh.modelRequests, 1); assert(fresh.syntheticRequests[0].prompt.includes('编辑只更新原文，不自动测试。'));
  boundaries.push({ kind: 'stale-callback-and-fresh-click', requests: fresh.modelRequests, aborts: fresh.aborts });

  await startControlled('defer'); await node('testModel').getByRole('button', { name: '测试', exact: true }).click();
  await page.waitForFunction(() => (window as any).__s2PromptInline.audit().pendingResponses === 1);
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByText('合成场景已关闭。', { exact: true }).waitFor();
  await page.waitForFunction(() => (window as any).__s2PromptInline.audit().aborts === 1);
  await page.evaluate(() => (window as any).__s2PromptInline.releaseResponses()); await page.waitForTimeout(80);
  const closed = await audit(); assert.equal(closed.session, 'closed'); assert.equal(closed.modelRequests, 1);
  assert.equal(await page.locator('.s2-trial').count(), 0); assert.equal(await page.getByText(/合成调用编号/).count(), 0);
  boundaries.push({ kind: 'closed-scene-and-late-response', requests: closed.modelRequests, aborts: closed.aborts });
  for (const key of ['realModelCalls', 'storageAttempts', 'deniedNetwork', 'persistentWrites', 'storeWrites', 'networkCalls']) assert.equal(closed[key], 0);
  checks.push('测试状态和停止入口在节点内；双击仅一次发送，失败不自动重试且内联显示，陈旧按钮和关闭场景后的晚回包不能作用于当前画布');

  await page.goto(origin + entry); await title.waitFor(); await fit();
  assert.equal(await page.getByRole('button', { name: '撤销', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '重做', exact: true }).count(), 0);
  const keyboardBefore = await audit(), originalNodeIds = keyboardBefore.draft.canvasWorkspace.initial.execution.nodes.map((item: any) => item.id);
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await panel.locator('button[data-s2-component="compose"]').click();
  if (await panel.isVisible()) await page.getByRole('button', { name: '关闭画布操作面板', exact: true }).click();
  const keyboardAdded = (await audit()).draft.canvasWorkspace.initial.execution.nodes.find((item: any) => !originalNodeIds.includes(item.id)); assert(keyboardAdded);
  await fit(); await node(keyboardAdded.id).locator('.s2-workflow-node > strong').click(); await node(keyboardAdded.id).focus();
  await page.keyboard.press('Delete');
  await page.waitForFunction((id: string) => !(window as any).__s2PromptInline.audit().draft.canvasWorkspace.initial.execution.nodes.some((item: any) => item.id === id), keyboardAdded.id);
  const undoNode = async () => { await node('task').focus(); await page.keyboard.press('Control+z');
    await page.waitForFunction((id: string) => (window as any).__s2PromptInline.audit().draft.canvasWorkspace.initial.execution.nodes.some((item: any) => item.id === id), keyboardAdded.id); };
  const redoNode = async (shortcut: string) => { await node('task').focus(); await page.keyboard.press(shortcut);
    await page.waitForFunction((id: string) => !(window as any).__s2PromptInline.audit().draft.canvasWorkspace.initial.execution.nodes.some((item: any) => item.id === id), keyboardAdded.id); };
  await undoNode(); await redoNode('Control+Shift+z'); await undoNode(); await redoNode('Control+y'); await undoNode();
  const beforeTyping = (await audit()).draft.canvasWorkspace.initial;
  await node('task').locator('.s2-content-preview').dblclick();
  const typing = node('task').getByRole('textbox', { name: '内容', exact: true });
  await typing.fill('只在输入框删除草稿。'); await typing.press('Backspace'); await typing.press('Delete'); await typing.press('Control+z'); await typing.press('Control+Shift+z');
  assert.deepEqual((await audit()).draft.canvasWorkspace.initial, beforeTyping, 'Text editing and native undo/redo must not delete or restore canvas objects');
  await typing.press('Escape'); await typing.waitFor({ state: 'hidden' });

  const link = { source: { nodeId: 'assemble', portId: 'text' }, target: { nodeId: 'testModel', portId: 'prompt' } };
  const edgeId = JSON.stringify([link.source.nodeId, link.source.portId, link.target.nodeId, link.target.portId]);
  const edge = page.locator(`.react-flow__edge[data-id=${JSON.stringify(edgeId)}]`);
  const midpoint = await edge.locator('path.react-flow__edge-interaction').evaluate((path: SVGPathElement) => {
    const point = path.getPointAtLength(path.getTotalLength() / 2), screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(midpoint.x, midpoint.y); await node('task').focus(); await page.keyboard.press('Backspace');
  await page.waitForFunction(() => !(window as any).__s2PromptInline.audit().draft.canvasWorkspace.initial.execution.links.some((item: any) => item.source.nodeId === 'assemble' && item.target.nodeId === 'testModel'));
  const afterEdgeDelete = await audit(); assert.equal(afterEdgeDelete.draft.canvasWorkspace.initial.execution.nodes.length, beforeTyping.execution.nodes.length);
  await node('task').focus(); await page.keyboard.press('Control+z');
  await page.waitForFunction(() => (window as any).__s2PromptInline.audit().draft.canvasWorkspace.initial.execution.links.some((item: any) => item.source.nodeId === 'assemble' && item.target.nodeId === 'testModel'));
  const afterKeyboard = await audit(); assert.deepEqual(afterKeyboard.draft.canvasWorkspace.initial, beforeTyping);
  assert.equal(afterKeyboard.modelRequests, 0); assert.equal(afterKeyboard.preparations, 0); assert.equal(afterKeyboard.agentCalls.length, 0);
  if (await panel.isVisible()) await page.getByRole('button', { name: '关闭画布操作面板', exact: true }).click();
  await fit(); await page.screenshot({ path: path.join(output, 'prompt-canvas-keyboard.png'), fullPage: true });
  checks.push('无撤销/重做按钮；Delete删除节点、Backspace删除连线，Ctrl+Z撤销、Ctrl+Shift+Z及Ctrl+Y重做；输入框删除与原生历史不影响画布');
  assert.deepEqual(errors, []); assert.deepEqual(remote, []);
  const report = { passed: true, execution: 'headless-chrome-production-components', syntheticOnly: true, checks,
    browserErrors: errors, remoteRequests: remote, realModelCalls: snapshot.realModelCalls,
    syntheticModelRequests: modelFlows.reduce((total, flow) => total + flow.modelRequests, 0) + boundaries.reduce((total, boundary) => total + boundary.requests, 0), modelFlows, boundaries,
    agentCalls: snapshot.agentCalls.map((call: any) => call.stage), storageAttempts: snapshot.storageAttempts,
    persistentWrites: snapshot.persistentWrites, storeWrites: snapshot.storeWrites, moduleCount: modulePaths.size,
    screenshots: ['prompt-inline-editing.png', 'prompt-inline-compose.png', 'prompt-inline-add-menu.png',
      'prompt-inline-preview.png', 'prompt-inline-running.png', 'prompt-inline-navigation-editable.png',
      'prompt-inline-navigation-readonly.png', 'prompt-inline-template-source.png', 'prompt-five-block-text.png', 'prompt-five-block-file.png', 'prompt-five-block-image.png',
      'prompt-direct-pending.png', 'prompt-direct-failure.png', 'prompt-canvas-keyboard.png'] };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await Promise.all(['failure.json', 'failure.png'].map(name => fs.rm(path.join(output, name), { force: true })));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: error instanceof Error ? error.message : String(error), checks, errors, remote }, null, 2) + '\n');
  throw error;
} finally { await browser?.close(); await server?.close(); }

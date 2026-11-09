/** Mock generation + real persistence/share regression; native execution is separate. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { InteractiveFigureStore } from '../src/electron/interactiveFigureStore';
import { interactiveFigureKey, prepareInteractiveFigure } from '../src/services/textbook/interactiveFigure';
import { buildInteractiveFigureShare } from '../src/services/textbook/interactiveFigureShare';
import { renderStyledTextbookHtml } from '../src/services/textbook/styledTextbookHtml';
import { INTERACTIVE_TEACHING_MODE_FIXTURES } from './fixtures/interactive-teaching-modes';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
globalThis.fetch = async () => assert.fail('Teaching mode regression must not use the network');
await fs.mkdir('build', { recursive: true });
const root = await fs.mkdtemp(path.resolve('build/interactive-teaching-modes-'));
let store = new InteractiveFigureStore(root);
const rows: Array<{ mode: string; key: string; generationCalls: number; ready: boolean; reopened: boolean; shared: boolean }> = [];
const api = {
  read: (key: string) => store.read(key), write: (key: string, artifact: Parameters<InteractiveFigureStore['write']>[1]) => store.write(key, artifact),
  compareReady: (key: string, expected: unknown, artifact: unknown) => store.compareReady(key, expected, artifact),
  open: async () => ({ processId: 1 }), bounds: async () => {}, visible: async () => {}, close: async () => {}, onFailure: () => () => {},
};
const authorization = { projectId: 'synthetic', legacy: false, teachingPolicy: 1 as const };

for (const fixture of INTERACTIVE_TEACHING_MODE_FIXTURES) {
  const body = `# ${fixture.title}\n\n${fixture.lesson}\n\n> **交互探索**\n>\n> ${fixture.brief}\n\n这是固定合成验收材料。`;
  const key = await interactiveFigureKey(authorization.projectId, body, fixture.brief);
  let calls = 0;
  const generate = async (request: Parameters<NonNullable<Parameters<typeof prepareInteractiveFigure>[4]>['generate']>[0]) => {
    calls++;
    assert.ok(request.systemPromptOverride?.includes(`data-figure-mode="${fixture.mode}"`), 'selected mode guidance reaches mock generation');
    assert.ok(!request.systemPromptOverride?.includes('先让学生输入或选择预测'), 'new modes do not inherit the legacy mandatory quiz');
    assert.ok(request.skipMemoryInjection && request.skipProfileInjection);
    assert.ok(request.userInput.includes(fixture.brief));
    return { content: JSON.stringify({ design: fixture.design, html: fixture.html }) };
  };
  const first = await prepareInteractiveFigure(key, body, fixture.brief, false, { api, generate }, authorization);
  assert.equal(first, fixture.html);
  const ready = await store.read(key);
  assert.equal(ready?.status, 'ready');
  assert.equal(ready?.status === 'ready' && ready.design?.teachingMode, fixture.mode);
  assert.ok(!first.includes('data-figure="prediction"') && !first.includes('data-figure="check"'));
  const raw = JSON.parse(await fs.readFile(path.join(root, 'interactive-figures', `${key}.json`), 'utf8'));
  assert.equal(raw.schemaVersion, 2);
  assert.ok(raw.digest && raw.designDigest);
  // Recreate storage to ensure readiness comes from persisted bytes, not the mock.
  store = new InteractiveFigureStore(root);
  const reopened = await prepareInteractiveFigure(key, body, fixture.brief, false, { api, generate }, authorization);
  assert.equal(reopened, first);
  assert.equal(calls, 1, 'opening a ready mode does not repeat generation');
  let portableCalls = 0;
  const share = await buildInteractiveFigureShare({ noteId: authorization.projectId, title: fixture.title, body }, {
    read: api.read,
    portable: async html => { portableCalls++; return { html: `<!doctype html><html><body>${html}</body></html>`, license: '' }; },
  }, async (title, text) => renderStyledTextbookHtml(title, text), async source => ({ body: source, files: {}, assets: {}, missingImages: 0, missingVisuals: 0, savedImages: 0, savedVisuals: 0, assetError: '' }));
  assert.equal(share.included, 1); assert.equal(share.missing, 0); assert.equal(portableCalls, 1);
  const files = unzipSync(share.bytes), markdown = strFromU8(files['教材.md']);
  assert.ok(markdown.includes('[打开离线交互图](figures/figure-1.html)'));
  assert.ok(markdown.includes(fixture.brief));
  assert.ok(!markdown.includes('<script>') && !markdown.includes('data-figure-mode'));
  assert.ok(strFromU8(files['figures/figure-1.html']).includes(fixture.html));
  assert.ok(strFromU8(files['教材.html']).includes('href="figures/figure-1.html"'));
  await fs.writeFile(path.join(root, `${fixture.mode}.zip`), share.bytes);
  rows.push({ mode: fixture.mode, key, generationCalls: calls, ready: true, reopened: true, shared: true });
}
const report = { synthetic: true, nativeExecution: false, remoteRequests: 0, root, modes: rows };
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

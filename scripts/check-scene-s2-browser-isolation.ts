/** Build/module-route audit only. No browser, user data, model, real settings or network. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { build, createServer, normalizePath } from 'vite';
import { S2_BROWSER_BOUNDARIES, S2_BROWSER_ENTRY, S2_BROWSER_PORT, createS2BrowserIsolationPlugin,
  s2BrowserAllowedModule, s2BrowserAllowedRequest, s2BrowserBoundaryAlias, s2BrowserIsolationConfig } from './vite-s2-browser.config';

const repo = process.cwd(), abs = (name: string) => normalizePath(path.resolve(repo, name));
const config = s2BrowserIsolationConfig();
assert.equal(config.envDir, false); assert.equal(config.publicDir, false); assert.equal(config.appType, 'mpa');
assert.equal(config.envPrefix, 'S2_BROWSER_FIXTURE_NEVER_CONFIGURED_');
assert.equal(config.server?.host, '127.0.0.1'); assert.equal(config.server?.port, S2_BROWSER_PORT); assert.equal(S2_BROWSER_PORT, 5193);
assert.equal(config.server?.strictPort, true); assert.equal(config.server?.hmr, false); assert.equal(config.server?.watch, null);
assert.equal(config.server?.proxy, undefined); assert.equal(config.server?.cors, false); assert.equal(config.server?.fs?.strict, true);
assert.equal(config.cacheDir, path.join(repo, 'node_modules/.vite-s2-browser'));
assert.deepEqual(config.optimizeDeps?.entries, [path.join(repo, S2_BROWSER_ENTRY.slice(1))]);
assert.equal(S2_BROWSER_BOUNDARIES.length, 5);
for (const boundary of S2_BROWSER_BOUNDARIES) {
  assert.equal(s2BrowserAllowedModule(abs(boundary.source)), false, 'An original IO boundary must never be served or loaded');
  assert.equal(s2BrowserAllowedModule(abs(boundary.stub)), true);
  assert.equal(s2BrowserBoundaryAlias(abs(boundary.source)), abs(boundary.stub));
  assert.equal(s2BrowserBoundaryAlias('/' + boundary.source), abs(boundary.stub));
  assert.equal(s2BrowserBoundaryAlias('./' + path.basename(boundary.source, '.ts'), abs(path.join(path.dirname(boundary.source), 'synthetic-importer.ts'))), abs(boundary.stub));
}
assert.equal(s2BrowserBoundaryAlias('./llmService', abs('scripts/fixtures/unrelated.ts')), undefined, 'Alias exact service identity, not arbitrary similarly named files');
for (const entry of [S2_BROWSER_ENTRY, '/scripts/fixtures/s2-browser-acceptance.tsx', '/scripts/fixtures/s2-browser-acceptance.css',
  '/scripts/fixtures/s2-browser-model.ts', '/scripts/fixtures/s2-browser-definition.ts', '/scripts/fixtures/s2-design-model.ts', '/scripts/fixtures/s2-review-task.ts',
  '/src/components/scene/SceneS2CanvasTrial.tsx', '/src/services/scene/sceneS2Canvas.ts', '/src/services/scene/sceneContextBudget.ts',
  '/src/workflows/workflowRegistry.ts', '/src/services/agent/conversationContext.ts', '/@vite/client', '/@id/__x00__s2-browser-vite-client', '/@react-refresh', '/node_modules/@xyflow/react/dist/style.css',
  '/node_modules/.vite-s2-browser/deps/react_jsx-dev-runtime.js']) {
  assert.equal(s2BrowserAllowedRequest(entry), true, entry); assert.equal(s2BrowserAllowedRequest(entry + '?v=synthetic'), true, entry);
  assert.equal(s2BrowserAllowedRequest(entry, 'HEAD'), true, entry);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal(s2BrowserAllowedRequest(entry, method), false);
}
const denied = ['/', '/index.html', '/src/main.tsx', '/src/App.tsx', '/argument-editor.html', '/scripts/fixtures/s2-workflow-simulation.html',
  '/scripts/run-scene-s2-live.ts', '/.ui-preview/s2-agent-live/synthetic/report.json', '/.git/config', '/.env', '/.env.local',
  '/src/services/llmService.ts', '/src/services/llmStorage.ts', '/src/services/scene/sceneSkillStore.ts', '/src/services/reviewSegmentScoring.ts', '/src/services/scene/sceneS2ModelTransport.ts',
  '/src/services/electronUserState.ts', '/src/services/storage.ts', '/src/services/profile/profileStore.ts', '/src/services/ragService.ts',
  '/src/services/memory/memoryContextBuilder.ts', '/src/services/scene/sceneCompute.ts', '/src/services/scene/sceneEngine.ts',
  '/scripts/fixtures/../run-scene-s2-live.ts', '/scripts/fixtures/%2e%2e/run-scene-s2-live.ts', '/scripts/fixtures/%252e%252e/private',
  '//foreign.invalid/src/services/scene/sceneS2Canvas.ts', '/src\\services\\storage.ts', '/@id/__vite-browser-external',
  '/@fs/C:/Users/PRIVATE_TEST_USER/.logi-note/storage-config.json', '/@fs/' + abs('.ui-preview/synthetic-private.json'),
  '/@fs/' + abs('src/services/storage.ts')];
for (const entry of denied) assert.equal(s2BrowserAllowedRequest(entry), false, entry);
for (const module of ['src/App.tsx', 'src/main.tsx', 'src/services/storage.ts', 'src/services/electronUserState.ts', 'src/services/ragService.ts',
  'src/services/profile/profileStore.ts', 'src/services/agent/agentEngine.ts', 'src/services/agent/conversationStore.ts',
  'src/services/memory/episodeStore.ts', 'src/services/memory/memoryContextBuilder.ts',
  'src/services/scene/sceneCompute.ts', '.ui-preview/private.ts']) assert.equal(s2BrowserAllowedModule(abs(module)), false, module);

let middleware: any;
const plugin = createS2BrowserIsolationPlugin();
const configureServer = plugin.configureServer as (server: unknown) => unknown;
configureServer({ middlewares: { use(fn: unknown) { middleware = fn; } } }); assert(middleware);
for (const url of [S2_BROWSER_ENTRY, '/src/App.tsx']) {
  const headers = new Map<string, string>(); let body: string | undefined, next = 0;
  const response = { statusCode: 200, setHeader(name: string, value: string) { headers.set(name, value); }, end(value: string) { body = value; } };
  middleware({ url, method: 'GET' }, response, () => next++);
  assert.match(headers.get('Content-Security-Policy')!, /connect-src 'none'/); assert.match(headers.get('Content-Security-Policy')!, /form-action 'none'/);
  assert.equal(headers.get('Cache-Control'), 'no-store');
  if (url === S2_BROWSER_ENTRY) { assert.equal(next, 1); assert.equal(body, undefined); } else { assert.equal(next, 0); assert.equal(response.statusCode, 403); }
}

// Build write:false traverses the real component/controller/host graph but never executes browser code or provider calls.
const seen = new Set<string>(), actualFetch = globalThis.fetch; let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('S2 isolation audit forbids all network'); };
try {
  const built = await build({ ...s2BrowserIsolationConfig(id => seen.add(id)), configFile: false, logLevel: 'error',
    build: { write: false, minify: false, sourcemap: false, emptyOutDir: false, rollupOptions: { input: abs(S2_BROWSER_ENTRY.slice(1)) } } });
  const outputs = (Array.isArray(built) ? built : [built]).flatMap(result => 'output' in result ? result.output : []);
  assert(outputs.some(item => item.fileName.endsWith('.html'))); assert(outputs.some(item => item.type === 'chunk'));
  const devConfig = s2BrowserIsolationConfig();
  const server = await createServer({ ...devConfig, configFile: false, logLevel: 'error',
    server: { ...devConfig.server, middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const client = await server.transformRequest('/@vite/client'); assert(client);
    assert.match(client.code, /function updateStyle/); assert.match(client.code, /function removeStyle/);
    assert.doesNotMatch(client.code, /WebSocket|setInterval|fetch\(|pingInterval|\[vite\] connecting/,
      'The fixture dev client must not create sockets, reconnect pings or fetch traffic under connect-src none');
    const styles = await server.transformRequest('/src/components/scene/sceneS2Canvas.css'); assert(styles);
    assert.match(styles.code, /@vite\/client/); assert.match(styles.code, /updateStyle/, 'Real CSS still uses the isolated CSS helper');
    for (const match of styles.code.matchAll(/from\s+["']([^"']+)["']/g)) assert(s2BrowserAllowedRequest(match[1]), `Transformed CSS dependency must be allowed: ${match[1]}`);
  } finally { await server.close(); }
  assert.equal(networkAttempts, 0);
} finally { globalThis.fetch = actualFetch; }
for (const required of ['src/components/scene/SceneS2CanvasTrial.tsx', 'src/services/scene/sceneS2Canvas.ts',
  'src/services/scene/sceneS2PluginHost.ts', 'src/services/scene/sceneContextBudget.ts', 'src/services/scene/sceneS2Memory.ts',
  'src/workflows/workflowRegistry.ts', 'src/services/agent/conversationContext.ts', ...S2_BROWSER_BOUNDARIES.map(item => item.stub)]) assert(seen.has(abs(required)), `Actual module graph must include ${required}`);
for (const forbidden of [...S2_BROWSER_BOUNDARIES.map(item => item.source), 'src/services/electronUserState.ts', 'src/services/storage.ts',
  'src/services/profile/profileStore.ts', 'src/services/ragService.ts', 'src/services/memory/memoryContextBuilder.ts',
  'src/services/scene/sceneProjectNoteAccess.ts', 'src/services/knowledgePointSelector.ts', 'src/App.tsx', 'src/main.tsx']) {
  assert(!seen.has(abs(forbidden)), `Private IO graph must not be loaded: ${forbidden}`);
}
assert([...seen].every(s2BrowserAllowedModule));
console.log(`S2 browser isolation passed: 5 exact IO aliases; actual SceneS2CanvasTrial/controller/context-budget/host/memory/model-session graph (${seen.size} audited module IDs) built in memory; persistent settings/notes/profile/RAG/Electron/app entry and real model-test transport excluded; route/method/traversal/private-file rejection, CSP external-connect block, env loading disabled, loopback5193 strict-port/no-HMR/no-proxy. No browser or actual model/network/user-data access; not an interaction or semantic acceptance.`);

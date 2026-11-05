/** Standalone synthetic browser acceptance server. Never imports the production Vite config or application entry. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, normalizePath, type Plugin, type UserConfig } from 'vite';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const normalizedRepo = normalizePath(repo);
export const S2_BROWSER_ENTRY = '/scripts/fixtures/s2-browser-acceptance.html';
export const S2_BROWSER_PORT = 5193;
export const S2_BROWSER_BOUNDARIES = Object.freeze([
  { source: 'src/services/llmService.ts', stub: 'scripts/fixtures/s2-browser-model.ts' },
  { source: 'src/services/llmStorage.ts', stub: 'scripts/fixtures/s2-browser-settings.ts' },
  { source: 'src/services/scene/sceneSkillStore.ts', stub: 'scripts/fixtures/s2-browser-store.ts' },
  { source: 'src/services/reviewSegmentScoring.ts', stub: 'scripts/fixtures/s2-browser-json.ts' },
  { source: 'src/services/scene/sceneS2ModelTransport.ts', stub: 'scripts/fixtures/s2-browser-model-transport.ts' },
]);
const fixtures = new Set(['s2-browser-acceptance.html', 's2-browser-acceptance.tsx', 's2-browser-acceptance.css',
  's2-browser-model.ts', 's2-browser-settings.ts', 's2-browser-store.ts', 's2-browser-json.ts', 's2-browser-definition.ts',
  's2-design-model.ts', 's2-business-model.ts', 's2-browser-model-transport.ts', 's2-review-task.ts', 's2-experiment.ts',
  's2-material-browser.html', 's2-material-browser.tsx', 's2-prompt-inline-browser.html', 's2-prompt-inline-browser.tsx',
  's2-node-views-browser.html', 's2-node-views-browser.tsx', 's2-fault-tree-browser.html', 's2-fault-tree-browser.tsx']);
const components = new Set(['ScenePackView.tsx', 'SceneS2CanvasTrial.tsx', 'S2ArtifactView.tsx', 'S2WorkflowNodeView.tsx', 'S2JsonParameter.tsx',
  'S2ConditionEditor.tsx', 'S2SimpleValueInput.tsx', 'S2HumanInput.tsx', 'S2RunSummary.tsx', 'S2FieldEditor.tsx', 'S2ContentNodeView.tsx', 'S2FieldPreview.tsx', 'S2ArtifactChart.tsx', 'S2ChartPreview.tsx', 'S2ImageMaterials.tsx', 'S2TextMaterialInput.tsx', 'S2ProjectNoteInput.tsx', 'sceneS2Canvas.css']);
// Audited pure prompt/registry/formatting helpers only; no storage, provider or S1/S4 runtime access.
const pureServices = new Set(['scene/sceneOutputSafety.ts', 'scene/sceneContextBudget.ts', 'scene/sceneComponentRegistry.ts',
  'scene/sceneCapabilityRegistry.ts', 'scene/sceneExecutionRegistry.ts', 'scene/sceneInteractionComponentV2.ts',
  'scene/sceneS4ContractDesign.ts', 'scene/sceneS4MetricDesign.ts', 'scene/scenePresentation.ts', 'agent/replyPolicy.ts',
  'agent/conversationContext.ts', 'llmHttpFailure.ts', 'llmImages.ts', 'textbook/localImages.ts']);
const workflows = new Set(['workflowRegistry.ts', 'structuredOutput.ts', 'planGenerationPrompt.ts', 'studyTaskPrompt.ts',
  'knowledgeDiscoveryPrompt.ts', 'knowledgeMasteryPrompt.ts', 'stormPrompt.ts', 'scenePrompt.ts', 'sceneGeneralPrompt.ts',
  'sceneComputePrompt.ts', 'agentPrompt.ts', 'reviewPrompt.ts', 'questionAnswerPrompt.ts', 'conceptGenerationPrompt.ts',
  'documentArgumentV5Prompt.ts', 'argumentQualityPrompt.ts', 'textbookPrompt.ts']);
const directPackages = /^(?:react(?:\/.*)?|react-dom(?:\/.*)?|@xyflow\/react(?:\/.*)?|postcss|postcss-value-parser)$/;
const withoutQuery = (value: string) => value.replace(/[?#].*$/, '');
const normalized = (value: string) => normalizePath(withoutQuery(value));
const boundaryPath = (relative: string) => normalizePath(path.join(repo, relative)).replace(/\.ts$/, '');
const fixtureClientId = '\0s2-browser-vite-client';
// Vite's real dev client opens a socket even with hmr:false. Keep only its CSS helpers in this isolated server.
const fixtureClient = `const sheets=new Map();
export function updateStyle(id,content){let style=sheets.get(id);if(!style){style=document.createElement('style');style.setAttribute('data-s2-browser-style',id);document.head.appendChild(style);sheets.set(id,style);}style.textContent=content;}
export function removeStyle(id){sheets.get(id)?.remove();sheets.delete(id);}
export function createHotContext(){return {data:Object.create(null),accept(){},dispose(){},prune(){},on(){},off(){},invalidate(){throw new Error('S2 fixture disables HMR');},send(){throw new Error('S2 fixture disables HMR');}};}
export function injectQuery(url,query){if(!url.startsWith('.')&&!url.startsWith('/'))return url;const value=new URL(url,'http://s2-fixture.invalid');return url.replace(/[?#].*$/,'')+'?'+query+(value.search?'&'+value.search.slice(1):'')+value.hash;}
export class ErrorOverlay extends HTMLElement{constructor(){super();this.textContent='S2 fixture module failed';this.setAttribute('role','alert');}close(){this.remove();}}
if(!customElements.get('s2-browser-error-overlay'))customElements.define('s2-browser-error-overlay',ErrorOverlay);`;

function canonicalCandidate(source: string, importer?: string): string | undefined {
  const input = withoutQuery(source);
  if (input.startsWith('/@fs/')) return normalized(input.slice('/@fs/'.length));
  if (/^\/(?:src|scripts|node_modules)\//.test(input)) return normalized(path.join(repo, input.slice(1)));
  if (path.isAbsolute(input)) return normalized(input);
  if (input.startsWith('.') && importer && !importer.startsWith('\0')) return normalized(path.resolve(path.dirname(withoutQuery(importer)), input));
  return undefined;
}
export function s2BrowserBoundaryAlias(source: string, importer?: string): string | undefined {
  const candidate = canonicalCandidate(source, importer)?.replace(/\.ts$/, '');
  const entry = S2_BROWSER_BOUNDARIES.find(item => boundaryPath(item.source) === candidate);
  return entry ? normalizePath(path.join(repo, entry.stub)) : undefined;
}
/** Only the audited S2/prompt closure and browser dependencies may be served or loaded. Original IO boundaries are never allowed. */
export function s2BrowserAllowedModule(rawId: string): boolean {
  const id = normalized(rawId);
  // Vite's browser-empty substitutes for PostCSS's Node-only optional IO.
  // These contain no filesystem/network implementation or authority.
  const external = id.replace(/^\0/, '');
  if (external === '__vite-browser-external' || external.startsWith('__vite-browser-external:')) return true;
  if (id.startsWith('\0')) return id === fixtureClientId || /^\0(?:vite\/|commonjsHelpers\.js$)/.test(id)
    || id.slice(1).startsWith(normalizedRepo + '/node_modules/') && /\.[cm]?js$/.test(id.slice(1));
  const candidate = canonicalCandidate(id) ?? id;
  if (S2_BROWSER_BOUNDARIES.some(item => boundaryPath(item.source) === candidate.replace(/\.ts$/, ''))) return false;
  if (!candidate.startsWith(normalizedRepo + '/')) return false;
  const relative = candidate.slice(normalizedRepo.length + 1);
  // Shared pure validators moved out of the Electron tree. Keep the exception
  // exact: the Node ZIP reader, server, storage and authentication stay denied.
  if (/^apps\/community-api\/src\/scenePackage(?:Types|Manifest|Material)\.ts$/.test(relative)) return true;
  if (relative.startsWith('node_modules/')) return /\.(?:[cm]?js|css|map|json|wasm|woff2?|ttf|svg|png)$/.test(relative);
  if (relative.startsWith('scripts/fixtures/')) return fixtures.has(relative.slice('scripts/fixtures/'.length));
  // Exact local package artifacts only. The fixture imports code as text, then exercises the real data-URL loader.
  if (/^output\/scene-pack-examples\/fault-tree\/1\.0\.0\/(manifest\.json|main\.js|styles\.css)$/.test(relative)
    || relative === 'examples/scene-packs/fault-tree/sample.public-canvas.json') return true;
  if (relative.startsWith('src/components/scene/')) return components.has(relative.slice('src/components/scene/'.length));
  if (/^src\/services\/scene\/sceneS2[A-Za-z0-9]+\.ts$/.test(relative)) return true;
  if (/^src\/interaction-packs\/prompt-lab\/(?:index|entry|authoring|reactBridge|manifest|description|runtime|textTemplate|modelCapability|designPolicy|agentRules|help|uiHost|composeControls|promptControls|ComposeEditor|ModelParameters|TemplateControls)\.tsx?$/.test(relative)
    || relative === 'src/interaction-packs/prompt-lab/styles.css') return true;
  if (/^src\/services\/scene\/(?:sceneInteractionHostServices|sceneInteractionPacks|sceneInteractionPackRegistry|sceneInteractionPackManifest|sceneInteractionPackProtocol|sceneInteractionPackMaterials|sceneInteractionPackMaterialProtocol|sceneInteractionPackAssets|sceneInteractionPackLoader|sceneInteractionPackStyles|scenePackEditorServices|scenePackCanvasPolicy|scenePackAuthoringCatalog)\.ts$/.test(relative)) return true;
  if (relative.startsWith('src/services/')) return pureServices.has(relative.slice('src/services/'.length));
  if (relative.startsWith('src/workflows/')) return workflows.has(relative.slice('src/workflows/'.length));
  return relative === 'src/styles/design-tokens.css' || relative === 'src/types.ts' || /^src\/types\/sceneS2(?:Business|Plugin)?\.ts$/.test(relative);
}
/** Routing is independent of Vite's fs guard, so /@fs, encoded traversal and the SPA fallback cannot expose other workspace files. */
export function s2BrowserAllowedRequest(url: string, method = 'GET'): boolean {
  if (!['GET', 'HEAD'].includes(method) || !url.startsWith('/') || url.startsWith('//') || url.includes('\\')) return false;
  let pathname: string;
  try { pathname = decodeURIComponent(withoutQuery(url)); } catch { return false; }
  if (pathname.includes('%') || pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part === '.' || part === '..')) return false;
  if (pathname === '/@vite/client' || pathname === '/@react-refresh') return true;
  if (pathname === '/@id/__x00__s2-browser-vite-client') return true;
  if (pathname.startsWith('/@id/')) return false;
  return s2BrowserAllowedModule(pathname.startsWith('/@fs/') ? pathname.slice('/@fs/'.length) : path.join(repo, pathname.slice(1)));
}

export function createS2BrowserIsolationPlugin(onModule?: (id: string) => void): Plugin {
  const check = (id: string) => {
    if (!s2BrowserAllowedModule(id)) throw new Error(`S2_BROWSER_MODULE_DENIED:${normalizePath(withoutQuery(id))}`);
    onModule?.(normalizePath(withoutQuery(id)));
  };
  return {
    name: 's2-browser-synthetic-isolation', enforce: 'pre',
    async resolveId(source, importer) {
      if (source === '/@vite/client' || source === fixtureClientId || source === '/@id/__x00__s2-browser-vite-client'
        || canonicalCandidate(source, importer) === normalizePath(path.join(repo, 'node_modules/vite/dist/client/client.mjs'))) return fixtureClientId;
      const alias = s2BrowserBoundaryAlias(source, importer); if (alias) return alias;
      if (!canonicalCandidate(source, importer) && !source.startsWith('\0') && !source.startsWith('vite/')
        && !directPackages.test(source) && (!importer || !normalized(importer).includes('/node_modules/'))) {
        throw new Error(`S2_BROWSER_PACKAGE_DENIED:${source}`);
      }
      const result = await this.resolve(source, importer, { skipSelf: true });
      if (result) check(result.id);
      return result;
    },
    load(id) { check(id); return id === fixtureClientId ? fixtureClient : null; },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
        const packageLoaderFixture = request.url?.split('?')[0] === '/scripts/fixtures/s2-fault-tree-browser.html';
        response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'unsafe-inline'${packageLoaderFixture ? ' data:' : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'`);
        if (!s2BrowserAllowedRequest(request.url || '', request.method)) {
          response.statusCode = 403; response.end('S2_BROWSER_ROUTE_DENIED'); return;
        }
        next();
      });
    },
  };
}

export function s2BrowserIsolationConfig(onModule?: (id: string) => void): UserConfig {
  return {
    root: repo, base: '/', appType: 'mpa', publicDir: false,
    envDir: false, envPrefix: 'S2_BROWSER_FIXTURE_NEVER_CONFIGURED_',
    cacheDir: path.join(repo, 'node_modules/.vite-s2-browser'),
    plugins: [createS2BrowserIsolationPlugin(onModule), react()],
    resolve: { alias: S2_BROWSER_BOUNDARIES.map(item => ({ find: normalizePath(path.join(repo, item.source)), replacement: normalizePath(path.join(repo, item.stub)) })) },
    server: { host: '127.0.0.1', port: S2_BROWSER_PORT, strictPort: true, hmr: false, watch: null, open: false,
      cors: false, allowedHosts: ['127.0.0.1'], proxy: undefined,
      fs: { strict: true, allow: [path.join(repo, 'src'), path.join(repo, 'node_modules'), path.join(repo, 'scripts/fixtures')],
        deny: ['.env', '.env.*', '**/.git/**', '**/.ui-preview/**', '**/.logi-note/**'] } },
    optimizeDeps: { entries: [path.join(repo, S2_BROWSER_ENTRY.slice(1))],
      include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@xyflow/react'] },
    build: { emptyOutDir: false, rollupOptions: { input: path.join(repo, S2_BROWSER_ENTRY.slice(1)) } },
  };
}
export default defineConfig(s2BrowserIsolationConfig());

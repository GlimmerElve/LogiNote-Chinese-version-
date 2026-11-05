/** Native file:// acceptance build. Real S2 renderer + pack loader + scene store; offline model boundaries only. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, normalizePath, type Plugin, type UserConfig } from 'vite';
import { S2_BROWSER_BOUNDARIES, s2BrowserAllowedModule } from './vite-s2-browser.config';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const S2_PACK_CLIENT_ENTRY = 'scripts/fixtures/s2-pack-client.html';
export const S2_PACK_CLIENT_BOUNDARIES = S2_BROWSER_BOUNDARIES.filter(item => !item.source.endsWith('/sceneSkillStore.ts'));
const additions = new Set([
  'scripts/fixtures/s2-pack-client.html', 'scripts/fixtures/s2-pack-client.tsx', 'scripts/fixtures/s2-arithmetic-pack.ts',
  'src/components/scene/SceneS2PackBoundary.tsx',
  'src/services/scene/sceneInteractionPackLoader.ts', 'src/services/scene/scenePackEditorServices.ts',
  'src/services/scene/sceneInteractionPackManifest.ts', 'src/services/scene/sceneInteractionPackProtocol.ts',
  'src/services/scene/sceneInteractionPackMaterials.ts', 'src/services/scene/sceneInteractionPackMaterialProtocol.ts',
  'src/services/scene/sceneSkillStore.ts', 'src/services/scene/sceneParadigm.ts', 'src/services/scene/sceneInteraction.ts',
  'src/types/scene.ts', 'src/types/sceneS4.ts',
]);
const clean = (value: string) => normalizePath(value.replace(/[?#].*$/, ''));
function candidate(source: string, importer?: string): string | undefined {
  const input = source.replace(/[?#].*$/, '');
  if (path.isAbsolute(input)) return clean(input);
  if (input.startsWith('.') && importer && !importer.startsWith('\0')) return clean(path.resolve(path.dirname(importer), input));
  return undefined;
}
export function s2PackClientAllowedModule(raw: string): boolean {
  const id = clean(raw), prefix = clean(repo) + '/';
  if (id.startsWith(prefix) && additions.has(id.slice(prefix.length))) return true;
  return s2BrowserAllowedModule(id);
}
export function createS2PackClientIsolationPlugin(onModule?: (id: string) => void): Plugin {
  const check = (id: string) => {
    if (!s2PackClientAllowedModule(id)) throw new Error(`S2_PACK_CLIENT_MODULE_DENIED:${clean(id)}`);
    onModule?.(clean(id));
  };
  return { name: 's2-pack-client-native-isolation', enforce: 'pre',
    async resolveId(source, importer, options) {
      const target = candidate(source, importer)?.replace(/\.ts$/, '');
      const boundary = S2_PACK_CLIENT_BOUNDARIES.find(item => clean(path.join(repo, item.source)).replace(/\.ts$/, '') === target);
      if (boundary) return clean(path.join(repo, boundary.stub));
      if (!candidate(source, importer) && !source.startsWith('\0') && !source.startsWith('vite/')
        && !/^(?:react(?:\/.*)?|react-dom(?:\/.*)?|@xyflow\/react(?:\/.*)?|postcss|postcss-value-parser)$/.test(source)
        && (!importer || !clean(importer).includes('/node_modules/'))) throw new Error(`S2_PACK_CLIENT_PACKAGE_DENIED:${source}`);
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved) check(resolved.id);
      return resolved;
    },
    load(id) { check(id); return null; },
  };
}
export function s2PackClientBuildConfig(outDir = process.env.LOGINOTE_PACK_CLIENT_UI_OUT || path.join(repo, 'output/s2-pack-client-ui'),
  onModule?: (id: string) => void): UserConfig {
  return { root: repo, base: './', appType: 'mpa', publicDir: false, envDir: false,
    envPrefix: 'S2_PACK_CLIENT_FIXTURE_NEVER_CONFIGURED_',
    plugins: [createS2PackClientIsolationPlugin(onModule), react()],
    resolve: { alias: S2_PACK_CLIENT_BOUNDARIES.map(item => ({
      find: clean(path.join(repo, item.source)), replacement: clean(path.join(repo, item.stub)),
    })) },
    build: { outDir, emptyOutDir: false, minify: false, sourcemap: false,
      rollupOptions: { input: path.join(repo, S2_PACK_CLIENT_ENTRY) } },
  };
}
export default defineConfig(s2PackClientBuildConfig());

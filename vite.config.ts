import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'node:fs';
import {defineConfig,loadEnv} from 'vite';
import { scenePackAssetsPlugin } from './scripts/vite-scene-pack-assets.mjs';
import {resolveCommunityWebConfiguration} from './src/services/community/deployment';

export default defineConfig(({mode,command}) => {
  const release = mode === 'release';
  const environment = loadEnv(mode, __dirname, 'VITE_COMMUNITY_');
  const configuration=resolveCommunityWebConfiguration({release,development:command==='serve',developmentWebsiteUrl:'http://127.0.0.1:5174',websiteOverride:environment.VITE_COMMUNITY_WEB_URL,releaseEnabledOverride:environment.VITE_COMMUNITY_RELEASE_ENABLED,desktopExchangeOverride:environment.VITE_COMMUNITY_DESKTOP_EXCHANGE_ENABLED,explicitWebsiteOverride:process.env.VITE_COMMUNITY_WEB_URL!==undefined});
  const releaseEnabled=configuration.releaseEnabled,website=configuration.websiteUrl;
  if (release && releaseEnabled && !website) throw new Error('开放社区的发布构建必须配置正式 HTTPS 社区网址，不能使用 localhost 或回环地址。');
  return {
    base: './',
    // Do not embed .env.local's development URL in distributed clients.
    define: {
      'import.meta.env.VITE_COMMUNITY_WEB_URL': JSON.stringify(website || ''),
      'import.meta.env.VITE_COMMUNITY_RELEASE_ENABLED': JSON.stringify(releaseEnabled ? 'true' : 'false'),
      'import.meta.env.VITE_COMMUNITY_DESKTOP_EXCHANGE_ENABLED': JSON.stringify(configuration.desktopExchangeEnabled ? 'true' : 'false'),
    },
    plugins: [react(), tailwindcss(), scenePackAssetsPlugin(__dirname), {
      name: 'science-drawing-licenses',
      generateBundle() {
        // Runtime is bundled, but dependency license notices must remain in the app artifact.
        this.emitFile({ type: 'asset', fileName: 'licenses/science-drawing.txt', source: [
          readFileSync(path.resolve(__dirname, 'node_modules/smiles-drawer/LICENSE.md'), 'utf8'),
          readFileSync(path.resolve(__dirname, 'node_modules/chroma-js/LICENSE'), 'utf8'),
        ].join('\n\n') });
        this.emitFile({ type: 'asset', fileName: 'licenses/teachable-anatomy.txt', source: readFileSync(path.resolve(__dirname, 'src/electron/vendor/teachable/ANATOMY-LICENSE.txt'), 'utf8') });
      },
    }],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
        // The browser-conditioned entry calls document.createElement at import
        // time. Workers must use the equivalent pure-JS entity table instead.
        'decode-named-character-reference': path.resolve(__dirname, 'node_modules/decode-named-character-reference/index.js'),
      },
    },
    build: {
      // Desktop windows can keep an older entry module in memory while we build.
      // Its hashed lazy chunks must remain readable until that window closes.
      // Release builds explicitly clean a separate dist-release output instead.
      emptyOutDir: false,
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          'argument-editor': path.resolve(__dirname, 'argument-editor.html'),
          'resource-workbench': path.resolve(__dirname, 'resource-workbench.html'),
          cognition: path.resolve(__dirname, 'cognition.html'),
          'mermaid-renderer': path.resolve(__dirname, 'mermaid-renderer.html'),
        },
      },
    },
    server: {
      // Keep the desktop preview from falling through to the community's 5174 port.
      port: 5173,
      strictPort: true,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});

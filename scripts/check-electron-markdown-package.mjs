import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { build, stop } from 'esbuild';
import { compileElectron, electronExternalPackages } from './build-electron.mjs';

// Execute the real parser consumers in a node_modules-free sandbox. A syntax-only
// bundle check would miss the sibling dependency resolution error in app.asar.
const external = await electronExternalPackages(process.cwd());
assert.ok(external.includes('electron'));
assert.ok(external.includes('@xenova/transformers'), 'Keep heavy/native runtime external');
assert.ok(external.includes('onnxruntime-node'), 'Keep the thread-limited native ONNX factory external');
assert.ok(!external.some(name => /^(?:mdast-|micromark(?:-|$))/u.test(name)));
try {
  const result = await build({
    stdin: { contents: `
      export { autoLinkMarkdown } from './src/services/markdownAutoLink.ts';
      export { prepareMarkdownForMdx } from './src/services/markdownMdxCompatibility.ts';
    `, resolveDir: process.cwd(), sourcefile: 'markdown-package-smoke.mjs' },
    bundle: true, platform: 'node', format: 'cjs', external, write: false, logLevel: 'silent',
  });
  const module = { exports: {} };
  const required = [];
  const context = { module, exports: module.exports, TextEncoder, TextDecoder, URL,
    require(name) { required.push(name); throw new Error(`Unexpected external Markdown runtime: ${name}`); } };
  new Script(result.outputFiles[0].text).runInNewContext(context, { timeout: 5000 });
  const source = '# 心理账户\n\n| 概念 | 说明 |\n| --- | --- |\n| 心理账户 | 测试 |\n\n正文[^1]\n\n[^1]: 心理账户\n\n`心理账户`\n\n$x<2$';
  const linked = module.exports.autoLinkMarkdown(source, [{ token: '心理账户', target: '心理账户' }]);
  assert.ok(linked.updatedContent.includes('[[心理账户]]'));
  assert.ok(linked.updatedContent.includes('`心理账户`'));
  assert.ok(linked.updatedContent.includes('$x<2$'));
  assert.equal(module.exports.prepareMarkdownForMdx('数量为 1 < 2。').markdown, '数量为 1 \\< 2。');
  assert.equal(required.length, 0, 'No parser dependency may be resolved from a packaged node_modules tree');
  const bundles = await compileElectron(process.cwd());
  for (const [name, contents] of bundles) {
    assert.doesNotMatch(contents.toString(), /require\(["'](?:mdast-|micromark(?:-|\/|["']))/u,
      `${name} must not leave the startup parser external`);
  }
  assert.match(bundles.get('rag-compute.cjs').toString(), /(?:require|import)\(["']onnxruntime-node["']\)/u,
    'the worker resolves the packaged native binding rather than bundling its relative binary loader');
  console.log('PASS packaged Markdown: real GFM/footnote/math consumers execute without node_modules; main/preload/worker compile; heavy/native dependencies remain external. No app launched or installed files/user data changed.');
} finally { stop(); }

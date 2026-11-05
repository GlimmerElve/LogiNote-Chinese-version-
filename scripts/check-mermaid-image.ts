import assert from 'node:assert/strict';
import { createMermaidImage } from '../src/services/ui/mermaidImage';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><style>text{fill:#123}</style><text x="20" y="30">函数</text></svg>';
const first = createMermaidImage(svg, 400), second = createMermaidImage(svg, 400);
try {
  assert.equal(first.width, 400); assert.equal(first.height, 200);
  assert.ok(first.url.startsWith('data:image/svg+xml;charset=utf-8,')); assert.equal(first.url, second.url);
  const response = await fetch(first.url);
  assert.match(response.headers.get('content-type')!, /^image\/svg\+xml/);
  assert.equal(await response.text(), svg);
  first.dispose(); first.dispose();
  assert.equal(await (await fetch(second.url)).text(), svg, 'one component cannot invalidate an immutable sibling image');
  const originalCreate = URL.createObjectURL;
  try {
    URL.createObjectURL = () => { throw Error('synchronous browser registration is forbidden'); };
    assert.equal(decodeURIComponent(createMermaidImage(svg, 200).url.split(',')[1]), svg);
  } finally { URL.createObjectURL = originalCreate; }
  for (const width of [NaN, Infinity]) assert.throws(() => createMermaidImage(svg, width));
  assert.throws(() => createMermaidImage('<html>not SVG</html>', 200));
  assert.throws(() => createMermaidImage('<svg>' + 'x'.repeat(1_000_000), 200));
  const fallback = createMermaidImage('<svg xmlns="http://www.w3.org/2000/svg"/>', 5000);
  assert.equal(fallback.width, 4096); assert.equal(fallback.height, 300); fallback.dispose();
  console.log('PASS SVG image MIME/Unicode/dimensions, zero synchronous Blob registration, immutable sibling-cache survival and bounded metadata; no image DOM/stylesheet injection');
} finally { first.dispose(); second.dispose(); }

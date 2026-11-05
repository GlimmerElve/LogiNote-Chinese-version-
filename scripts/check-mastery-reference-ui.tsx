import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { masteryReferencePreview } from '../src/services/ui/masteryReferencePreview';
import { MasteryReferenceContext } from '../src/components/MasteryReferenceContext';

globalThis.fetch = async () => assert.fail('Reference presentation must not make a network or model request');
const original = '# 示例知识点\n\n## 定义\n\n这是第一句完整的定义。第二句说明适用范围。\n\n## 应用\n\n' + '后文的完整上下文需要按需展开。'.repeat(35);
const preview = masteryReferencePreview(original);
assert.equal(preview.preview, '这是第一句完整的定义。第二句说明适用范围。…');
assert.ok(preview.truncated && Array.from(preview.preview).length <= 160);
assert.equal(masteryReferencePreview('简短参考内容。').preview, '简短参考内容。');
const emoji = masteryReferencePreview('😀'.repeat(180));
assert.equal(Array.from(emoji.preview).length, 160);
assert.ok(!/[\uD800-\uDBFF]$/u.test(emoji.preview.slice(0, -1)), 'never split a surrogate pair');
assert.ok(!masteryReferencePreview('**概念**来自[资料](https://example.com)，相关于[[原理|别名]]。').preview.includes('**'));
const html = renderToStaticMarkup(<MasteryReferenceContext reference={{ label: '知识点笔记', quote: original, locator: '正文节选' }} />);
assert.ok(html.includes('mastery-reference-preview') && html.includes(preview.preview));
assert.ok(html.includes('展开本次参考上下文') && !html.includes('<details open'));
assert.ok(html.includes('<h5>示例知识点</h5>') && !html.includes('## 定义'), 'expanded context renders Markdown');
assert.ok(html.includes('后文的完整上下文需要按需展开。'), 'the complete original context remains accessible, not replaced by a generated summary');
const unsafe = renderToStaticMarkup(<MasteryReferenceContext reference={{ label: '不可信资料', quote: original
  + '\n\n<script>alert(1)</script>\n\n![远程图](https://example.com/pixel.png)\n\n[链接](javascript:alert(1))' }} />);
assert.ok(!unsafe.includes('<script') && !unsafe.includes('<img') && !unsafe.includes('href='));
assert.ok(unsafe.includes('tabindex="0"') && unsafe.includes('role="region"'));
assert.equal(original.startsWith('# 示例知识点\n\n## 定义'), true, 'input reference is unchanged');
const shortHtml = renderToStaticMarkup(<MasteryReferenceContext reference={{ label: '短参考', quote: '参考片段。' }} />);
assert.ok(shortHtml.includes('参考片段。') && !shortHtml.includes('展开本次参考上下文'));
console.log('PASS: bounded sentence preview, original context preserved, safe Markdown, collapsed long references, accessible scrolling, no extra requests or scoring changes.');

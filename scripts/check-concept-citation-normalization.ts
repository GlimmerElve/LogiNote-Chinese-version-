import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { normalizeConceptCitationMarkers as normalizeConceptCitationMarkersProtected, extractConceptCitationIdsProtected, stripConceptModelSourceList } from '../src/services/conceptCitationMarkers';
import { prepareConceptAugmentation, numberAugmentationEvidence, composeConceptAugmentation } from '../src/services/conceptAugmentation';
import { CONCEPT_AUGMENTATION_PROMPT } from '../src/workflows/conceptGenerationPrompt';
import { initializeWikiKnowledge } from '../src/services/wikiKnowledge';

globalThis.fetch = async () => assert.fail('Citation acceptance must not access a model or network');
const file = 'src/services/conceptFillService.ts', ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
const code = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n').replace(/^export\s+/gmu, '');
const output = ts.transpileModule(code + '\nreturn { generateConcept, extractConceptCitationIds, validateAndFinalizeConceptContent, normalizeConceptCitationMarkers };', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
let modelCalls = 0;
// Exact synthetic response from the first live run, frozen as a portable fixture.
const cached = JSON.parse(readFileSync('scripts/fixtures/concept-softmax-cached-response.json', 'utf8'));
let response = cached;
const evidence = [
  { sourceId: '1', type: 'web', title: 'PyTorch 2.15 official documentation — torch.nn.Softmax', url: 'https://docs.pytorch.org/docs/2.15/generated/torch.nn.Softmax.html', snippet: '合成端口提供已核验的Softmax公式与dim说明。' },
  { sourceId: '2', type: 'web', title: 'PyTorch 2.15 official documentation — torch.nn.LogSoftmax', url: 'https://docs.pytorch.org/docs/2.15/generated/torch.nn.LogSoftmax.html', snippet: '合成端口提供已核验的LogSoftmax公式说明。' },
];
const bindings = { normalizeConceptCitationMarkersProtected, extractConceptCitationIdsProtected, stripConceptModelSourceList, prepareConceptAugmentation, numberAugmentationEvidence, composeConceptAugmentation, CONCEPT_AUGMENTATION_PROMPT,
  crypto: { randomUUID }, window: { electronAPI: { conceptResearch: { search: async () => evidence } } }, searchDocuments: async () => [], searchNotes: async () => [],
  callLLM: async () => { modelCalls++; return response; } };
const service = new Function(...Object.keys(bindings), output)(...Object.values(bindings));
const numberedEvidence = evidence.map((item: any, index: number) => ({ ...item, sourceId: String(index + 8) }));
const normalized = service.normalizeConceptCitationMarkers(cached.content);
assert.deepEqual(service.extractConceptCitationIds(normalized), [8, 9]);
assert.ok(!normalized.includes('【来源 8】') && !normalized.includes('【来源 9】'));
assert.equal(service.normalizeConceptCitationMarkers(normalized), normalized, 'normalization is idempotent');
const final = service.validateAndFinalizeConceptContent(cached.content, 'Softmax', numberedEvidence);
assert.ok(final.includes('- [8] [PyTorch') && final.includes('- [9] [PyTorch'));
const note = { ...initializeWikiKnowledge('Softmax', 'cached-softmax'), content: '# Softmax\n\n已有说明及公式 [7]。', referenceSources: [{ sourceId: '7', title: '旧来源' }] };
const draft = await service.generateConcept(note, 'browser', { mode: 'augment' });
assert.ok(draft.content.startsWith(note.content)); assert.deepEqual(draft.references.map((item: any) => item.sourceId), ['7', '8', '9']);
assert.ok(draft.content.includes('### 本次补充来源') && draft.content.includes('[8]'));

for (const raw of ['新增说明【来源 99】', '新增说明[8]，还有未知说明【来源99】', '新增说明【来源999999】']) {
  assert.throws(() => service.validateAndFinalizeConceptContent(raw, 'Softmax', numberedEvidence), /不存在的来源/u, 'unknown explicit markers stay invalid references, not missing-citation errors');
}
const protectedSamples = [
  '`【来源91】 arr[1]`', '```python\ntext="【来源92】"\narr=[1]\n```', '~~~js\nconst s="【来源93】"; const x=[1];\n~~~',
  '$x+【来源94】+[1]$', '$$x+【来源95】+[1]$$', '\\(x+【来源96】+[1]\\)', '\\[x+【来源97】+[1]\\]',
  '[标签【来源98】](https://example.invalid/【来源99】)', '![图【来源100】](https://example.invalid/【来源101】)',
  'https://example.invalid/【来源102】', '<https://example.invalid/【来源103】>', '[[知识点【来源104】|旧双链]]',
  '[link]: https://example.invalid/【来源105】', '    text="【来源106】"; arr=[1]',
  '     value=arr[8]', '        value=arr[8]', '\t\tvalue=arr[8]',
];
for (const sample of protectedSamples) {
  assert.equal(service.normalizeConceptCitationMarkers(sample), sample, `protected bytes: ${sample}`);
  assert.deepEqual(service.extractConceptCitationIds(sample), [], `protected references: ${sample}`);
  const mixed = `可读解释【来源 8】。\n\n${sample}`;
  assert.deepEqual(service.extractConceptCitationIds(mixed), [8]);
  assert.ok(service.validateAndFinalizeConceptContent(mixed, 'Softmax', numberedEvidence).includes(sample), 'protected text is preserved in the draft');
}
// Regression inputs from the independent three-finding review: indentation and
// Setext headings must not bypass structure checks, and separate fences must
// remain separate. These are synthetic strings, not another model request.
for (const input of ['     value=arr[8]', '        value=arr[8]', '\t\tvalue=arr[8]',
  '事实没有引用。\n\n来源\n----\n- [8] 官方来源',
  '事实没有引用。\n\n来源\n----\n- 【来源8】 官方来源']) {
  assert.deepEqual(service.extractConceptCitationIds(input), [], 'code indices and Setext bibliography labels are not body citations');
  assert.throws(() => service.validateAndFinalizeConceptContent(input, 'Softmax', numberedEvidence), /未返回|没有引用/u);
}
for (const fence of ['```', '~~~']) {
  const separateBlocks = `${fence}\na\n${fence}\n\n事实[8]。\n\n${fence}\nb\n${fence}`;
  assert.equal(stripConceptModelSourceList(separateBlocks), separateBlocks, 'independent code blocks are not one Markdown envelope');
  assert.deepEqual(service.extractConceptCitationIds(separateBlocks), [8]);
  assert.ok(service.validateAndFinalizeConceptContent(separateBlocks, 'Softmax', numberedEvidence).includes(separateBlocks));
}
const setextWithBody = '有效解释[8]。\n\n参考资料\n----\n- [8] 官方来源';
assert.equal(stripConceptModelSourceList(setextWithBody), '有效解释[8]。');
assert.deepEqual(service.extractConceptCitationIds(setextWithBody), [8]);
// These are bibliography declarations, never evidence-bearing explanatory text.
for (const heading of ['## 来源', '### 来源', '## 来源：', '## 参考文献', '### References:']) {
  for (const tail of ['- 【来源8】 官方文档', '【来源8】 官方文档', '- [8] 官方文档']) {
    assert.throws(() => service.validateAndFinalizeConceptContent(`${heading}\n${tail}`, 'Softmax', numberedEvidence), /未返回|没有引用/u);
  }
}
const nonTail = '## 来源\n- 【来源99】 旧的来源区\n\n## 后续解释\n有效解释【来源8】。';
const nonTailFinal = service.validateAndFinalizeConceptContent(nonTail, 'Softmax', numberedEvidence);
assert.ok(nonTailFinal.includes('## 后续解释\n有效解释[8]。'), 'a source section does not erase later valid content');
assert.ok(nonTailFinal.includes('【来源99】'), 'existing source-list labels are not rewritten into body citations');
for (const language of ['js', 'python']) assert.throws(() => service.validateAndFinalizeConceptContent('```' + language + '\nvalue="【来源8】";arr=[1]\n```', 'Softmax', numberedEvidence), /没有引用/u, 'a full language code block is never unwrapped as prose');
for (const wrapper of ['```markdown', '```']) {
  const wrapped = `${wrapper}\n合法说明【来源8】。\n\n## 来源\n- 【来源8】 来源声明\n\`\`\``;
  assert.ok(service.validateAndFinalizeConceptContent(wrapped, 'Softmax', numberedEvidence).includes('合法说明[8]。'));
}
const oldProtocol = '# Softmax\n\n合法的已有输出 [8]。';
assert.equal(service.normalizeConceptCitationMarkers(oldProtocol), oldProtocol);
assert.equal(service.validateAndFinalizeConceptContent(oldProtocol, 'Softmax', numberedEvidence), oldProtocol + '\n\n## 来源\n- [8] [PyTorch 2.15 official documentation — torch.nn.Softmax](https://docs.pytorch.org/docs/2.15/generated/torch.nn.Softmax.html) — 公开网页');
assert.ok(CONCEPT_AUGMENTATION_PROMPT.includes('例如 [8]') && CONCEPT_AUGMENTATION_PROMPT.includes('$...$ 或 $$...$$'));
assert.ok(CONCEPT_AUGMENTATION_PROMPT.includes('原稿中已有但未解释') && CONCEPT_AUGMENTATION_PROMPT.includes('对应'));
response = { content: '新说明【来源99】。' };
await assert.rejects(service.generateConcept(note, 'browser', { mode: 'augment' }), /不存在的来源/u);
console.log(`PASS exact cached Softmax response → local citation recovery, all reference metadata, illegal IDs, protected Markdown spans, strict wrappers, trailing-only sources and unchanged [N] protocol; ${modelCalls} replayed/synthetic responses, 0 real model requests`);

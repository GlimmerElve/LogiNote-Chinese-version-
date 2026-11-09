import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { prepareConceptAugmentation, numberAugmentationEvidence, composeConceptAugmentation, MAX_CONCEPT_AUGMENT_CONTEXT_CHARS } from '../src/services/conceptAugmentation';
import { CONCEPT_AUGMENTATION_PROMPT, CONCEPT_GENERATION_PROMPT } from '../src/workflows/conceptGenerationPrompt';
import { initializeWikiKnowledge, KNOWLEDGE_PLACEHOLDER } from '../src/services/wikiKnowledge';
import { prepareConceptNoteWrite } from '../src/services/ui/conceptNoteWrite';
import { normalizeConceptCitationMarkers as normalizeConceptCitationMarkersProtected, extractConceptCitationIdsProtected, stripConceptModelSourceList } from '../src/services/conceptCitationMarkers';
import type { ConceptSourceEvidence } from '../src/types';

globalThis.fetch = async () => assert.fail('Concept augmentation acceptance must not access a network or model');
const original = '# 条件概率\r\n\r\n用户已有定义 [1]。\r\n\r\n$$P(A|B)=P(A\\cap B)/P(B)$$\r\n\r\n```python\r\nx = [7]\r\n```\r\n\r\n## 来源\r\n- [1] 原有来源。\r\n';
const oldReferences = [{ sourceId: '1', type: 'web' as const, title: '原来源', url: 'https://example.invalid/old' }, { sourceId: '5', type: 'note' as const, title: '旧笔记引用', entityId: 'old-note' }];
const note = { ...initializeWikiKnowledge('条件概率', 'augmentation-note'), content: original, referenceSources: oldReferences };
const prepared = prepareConceptAugmentation(note)!;
assert.equal(prepared.originalContent, original); assert.equal(prepared.citationOffset, 7);
assert.deepEqual(prepared.originalReferences, oldReferences); assert.notEqual(prepared.originalReferences, oldReferences);
const evidence: ConceptSourceEvidence[] = [{ sourceId: '1', type: 'web', title: '新证据甲', url: 'https://example.invalid/new-a', snippet: '在P(B)>0时解释条件概率。' }, { sourceId: '2', type: 'web', title: '新证据乙', url: 'https://example.invalid/new-b', snippet: '条件概率的例子与限制。' }];
assert.deepEqual(numberAugmentationEvidence(evidence, prepared).map(item => item.sourceId), ['8', '9']);
assert.deepEqual(evidence.map(item => item.sourceId), ['1', '2']);
const implicit = prepareConceptAugmentation({ ...note, content: '没有行内引用。', referenceSources: [{ title: '旧引用甲' }, { title: '旧引用乙' }] })!;
assert.equal(implicit.citationOffset, 2, 'metadata with implicit display numbers reserves those numbers');
for (const content of ['', ' \n ', KNOWLEDGE_PLACEHOLDER, `  ${KNOWLEDGE_PLACEHOLDER}\n`]) assert.equal(prepareConceptAugmentation({ ...note, content }), undefined);
const longOriginal = '# 长原稿\n' + '保留内容与公式$y=x^2$。'.repeat(900) + '\n末尾来源[42]';
const longPrepared = prepareConceptAugmentation({ ...note, content: longOriginal })!;
assert.equal(longPrepared.context.length, MAX_CONCEPT_AUGMENT_CONTEXT_CHARS); assert.equal(longPrepared.contextTruncated, true); assert.equal(longPrepared.citationOffset, 42);
assert.ok(composeConceptAugmentation(longPrepared, '# 标题\n\n## 机制\n新内容[43]\n\n## 来源\n- [43] 新来源').startsWith(longOriginal));
const fenced = composeConceptAugmentation(prepared, '# 条件概率\n\n## 机制\n新解释[8]\n\n```text\n## 代码内标题不变\n```\n\n## 来源\n- [8] 新来源');
assert.ok(fenced.startsWith(original)); assert.ok(fenced.includes('## 概念补充\n\n### 机制'));
assert.ok(fenced.includes('```text\n## 代码内标题不变\n```')); assert.ok(fenced.includes('### 本次补充来源'));
assert.equal((fenced.match(/# 条件概率/gu) || []).length, 1);

// Transpile the production service with synthetic retrieval/model boundaries;
// all pure helpers and citation validation remain the real implementations.
function compileService(bindings: Record<string, unknown>) {
  const file = 'src/services/conceptFillService.ts', ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const code = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n').replace(/^export\s+/gmu, '');
  const compiled = ts.transpileModule(code + '\nreturn { generateConcept, buildConceptEvidenceInput };', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(bindings), compiled)(...Object.values(bindings));
}
let modelCalls = 0, emptyEvidence = false;
const requests: any[] = [];
let response: any = { content: '## 定义与机制补充\n当P(B)>0时，条件概率按给定关系计算。[8]' };
const service = compileService({ prepareConceptAugmentation, numberAugmentationEvidence, composeConceptAugmentation, CONCEPT_AUGMENTATION_PROMPT,
  normalizeConceptCitationMarkersProtected, extractConceptCitationIdsProtected, stripConceptModelSourceList,
  crypto: { randomUUID }, window: { electronAPI: { conceptResearch: { search: async () => emptyEvidence ? [] : evidence } } },
  searchDocuments: async () => [], searchNotes: async () => [], callLLM: async (request: any) => { modelCalls++; requests.push(request); return response; },
});
const workflow = { systemPrompt: CONCEPT_GENERATION_PROMPT, defaultParams: { temperature: .12, maxTokens: 3072 } };
const augmented = await service.generateConcept(note, 'browser', { mode: 'augment', workflowSnapshot: workflow });
assert.ok(augmented.content.startsWith(original), 'original body, CRLF, formulas, code and source list remain verbatim');
assert.ok(augmented.content.includes('## 概念补充') && augmented.content.includes('### 本次补充来源\n- [8]'));
assert.deepEqual(augmented.references.slice(0, 2), oldReferences); assert.equal(augmented.references.length, 3);
assert.equal(augmented.references[2].sourceId, '8'); assert.equal(augmented.references[2].url, evidence[0].url);
assert.equal(requests[0].systemPromptOverride, CONCEPT_AUGMENTATION_PROMPT);
assert.equal(requests[0].temperatureOverride, .12); assert.equal(requests[0].maxTokensOverride, 3072);
assert.ok(requests[0].userInput.includes('不是独立证据') && requests[0].userInput.includes('【来源 8｜') && requests[0].userInput.includes('【来源 9｜'));
assert.ok(!requests[0].userInput.includes('【来源 1｜'), 'old citation numbers cannot be borrowed by fresh evidence');
const saved = prepareConceptNoteWrite({ ...note, title: '标题更新仍保留', tags: ['用户标签'] }, note, augmented.content, augmented.references);
assert.equal(saved.content, augmented.content); assert.deepEqual(saved.referenceSources, augmented.references); assert.deepEqual(saved.tags, ['用户标签']);
assert.throws(() => prepareConceptNoteWrite({ ...note, content: original + '用户新修改' }, note, augmented.content, augmented.references), /未覆盖/u);
assert.equal(prepareConceptNoteWrite(saved, note, augmented.content, augmented.references).content, augmented.content, 'retry saves exactly the same composed draft');
assert.equal(note.content, original); assert.deepEqual(note.referenceSources, oldReferences);

response = { content: '错误借用旧引用[1]。' };
await assert.rejects(service.generateConcept(note, 'browser', { mode: 'augment' }), /不存在的来源/u);
response = { content: '没有依据的新增说明。' };
await assert.rejects(service.generateConcept(note, 'browser', { mode: 'augment' }), /没有引用/u);
response = { content: '被截断的新增说明[8]。', diagnostics: { finishReason: 'length' } };
await assert.rejects(service.generateConcept(note, 'browser', { mode: 'augment' }), /截断/u);
emptyEvidence = true; const callsBeforeEmpty = modelCalls;
await assert.rejects(service.generateConcept(note, 'browser', { mode: 'augment' }), /没有检索到/u);
assert.equal(modelCalls, callsBeforeEmpty, 'the original draft alone never substitutes for retrieved evidence'); emptyEvidence = false;

// Default/manual replacement, background-style pinned workflow and placeholders
// still have the exact previous input and citation numbering behavior.
response = { content: '新生成概念说明[1]。' };
for (const options of [{ workflowSnapshot: workflow }, { mode: 'replace', workflowSnapshot: workflow }]) {
  const fresh = await service.generateConcept(note, 'browser', options), request = requests.at(-1);
  assert.ok(!fresh.content.startsWith(original) && !fresh.content.includes('## 概念补充'));
  assert.equal(request.systemPromptOverride, CONCEPT_GENERATION_PROMPT); assert.equal(request.userInput, service.buildConceptEvidenceInput(note, evidence));
  assert.deepEqual(fresh.references.map((item: any) => item.sourceId), ['1']);
}
for (const content of ['', KNOWLEDGE_PLACEHOLDER]) {
  const placeholder = await service.generateConcept({ ...note, content }, 'browser', { mode: 'augment', workflowSnapshot: workflow });
  assert.ok(!placeholder.content.includes('## 概念补充')); assert.equal(requests.at(-1).systemPromptOverride, CONCEPT_GENERATION_PROMPT);
}
response = { content: '新补充说明[43]。' };
const longDraft = await service.generateConcept({ ...note, content: longOriginal }, 'browser', { mode: 'augment' });
assert.ok(longDraft.content.startsWith(longOriginal)); assert.ok(requests.at(-1).userInput.includes('仅展示前8000字符'));
assert.ok(!requests.at(-1).userInput.includes('末尾来源[42]'), 'the bounded original excerpt is distinct from the full retained original');
const cancelled = new AbortController(); cancelled.abort();
const callsBeforeCancel = modelCalls;
await assert.rejects(service.generateConcept(note, 'browser', { mode: 'augment', signal: cancelled.signal }), { name: 'AbortError' });
assert.equal(modelCalls, callsBeforeCancel);
console.log(`PASS manual concept augmentation: verbatim original, bounded non-evidence context, disjoint citations and combined references, guarded save/retry, failure/cancel safety, unchanged default/background and placeholder behavior; ${modelCalls} synthetic model responses, 0 real requests`);

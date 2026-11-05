import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { buildReviewTutorContext, compactReviewTutorHistory, REVIEW_TUTOR_CONTEXT_LIMITS } from '../src/services/reviewTutorContext.ts';
import { buildReviewReferenceCatalog } from '../src/services/reviewReferenceRubric.ts';
import { cognitionIntentCandidates, parseReviewTutorIntent, stripReviewIntentMarkers } from '../src/services/reviewIntent.ts';
import type { NoteItem, ReviewMessage, LlmCallRequest } from '../src/types.ts';
import type { ReviewTutorContextInput } from '../src/services/reviewTutorContext.ts';

globalThis.fetch = async () => assert.fail('No network or model transport in tutor context checks');
const at = '2026-10-07T00:00:00.000Z', meaning = '选择过载是选项超过处理能力时难以决策的现象。', boundary = '选项多不意味着一定发生选择过载。';
const note: NoteItem = { id: 'synthetic-tutor-context-note', noteType: 'knowledge', title: '选择过载',
  content: `## 含义\n${meaning}\n\n## 边界\n${boundary}\n\n## 无关细节\nRAW_BODY_ONLY_UNRELATED`,
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at };
const catalog = await buildReviewReferenceCatalog([note], [note.title], [note.id]);
// Keep only actual first two source intervals, never rewritten or abbreviated quotes.
catalog.candidates = catalog.candidates.slice(0, 2);
const candidates = cognitionIntentCandidates({ status: 'ready', method: 'local-lexical-v1', warning: 'synthetic',
  items: [{ recordId: 'record', revisionId: 'revision', branchId: 'branch', nodeId: 'node', title: note.title,
    text: '我以为多就一定会过载。', textTruncated: false, stance: 'endorsed', branchKind: 'primary', context: '合成历史表述',
    needsReview: false, confirmedAt: at, sourceKind: 'argument_editor', originRevisionId: 'revision', score: 0, usableAsFactEvidence: false }] });
const response = `什么是选择过载？选项多就一定发生吗？\n[认知意图:C1|give_condition]\n[检验:definition]\n[核对:concept_meaning=K1;concept_boundary=K2]`;
const intent = parseReviewTutorIntent(response, { questionMessageId: 'q1', allowedKnowledgeTargets: [note.title],
  fallbackKnowledgeTargets: [note.title], referenceCatalog: catalog, cognitionCandidates: candidates }).intent;
const messages: ReviewMessage[] = [{ id: 'q1', role: 'tutor', content: '请说明定义及边界。', timestamp: at },
  { id: 'a1', role: 'user', content: '选项多可能让我犹豫，但不一定。', timestamp: at }];
const base = { noteTitle: note.title, knowledgeContext: note.content, messages, currentIntent: intent };
const normal: ReviewTutorContextInput = { ...base, mode: 'next-question', isProjectReview: false,
  allowedKnowledgeTargets: [note.title], cognitionCandidates: candidates, referenceCatalog: catalog, hintLevel: 0 };
let checks = 0;
const pass = (name: string) => { checks++; console.log(`PASS ${name}`); };
const request = buildReviewTutorContext(normal);
assert.equal(request.sections.learning, ''); assert.equal(request.trace.fallbackKnowledgeIncluded, false);
assert.equal(request.userInput.includes('RAW_BODY_ONLY_UNRELATED'), false);
assert.equal(request.userInput.split(meaning).length - 1, 1); assert.equal(request.userInput.split(boundary).length - 1, 1);
pass('K originals replace the duplicate knowledge body, not a second abbreviated body');

for (const candidate of catalog.candidates) assert.ok(request.sections.reference.includes(JSON.stringify(candidate)));
assert.match(request.sections.reference, /不是用户信念.*不证明资料权威/u);
assert.match(request.sections.reference, /concept_meaning/u); assert.match(request.sections.reference, /concept_boundary/u);
pass('reference source IDs/version/hash/UTF-16 original quotes and frozen-selection criteria remain intact');

assert.match(request.sections.cognition, /C1/u); assert.match(request.sections.cognition, /不是客观事实/u);
assert.match(request.sections.cognition, /give_condition/u); assert.match(request.sections.task, /\[检验:definition\|example/u);
assert.match(request.sections.task, /知识点允许列表：\["选择过载"\]/u);
assert.match(request.sections.instruction, /只提出一个下一步问题/u);
pass('C intent, task allowlists, same-meaning criteria and one-question instruction are not lost');

const noReference = buildReviewTutorContext({ ...normal, referenceCatalog: undefined, cognitionCandidates: [], knowledgeContext: 'F'.repeat(6200) });
assert.equal(noReference.trace.fallbackKnowledgeIncluded, true); assert.equal(noReference.trace.fallbackKnowledgeTruncated, true);
assert.ok(noReference.sections.learning.includes('F'.repeat(6000))); assert.equal(noReference.sections.learning.includes('F'.repeat(6001)), false);
assert.match(noReference.sections.learning, /不能把此片段当完整标准或缺口证明/u); assert.match(noReference.sections.task, /\[核对:无\]/u);
assert.match(noReference.sections.cognition, /\[认知意图:无\]/u);
pass('no-K fallback retains up to 6000 source characters with explicit incomplete-evidence and no-ID boundaries');

const emptyCatalog = buildReviewTutorContext({ ...normal, referenceCatalog: { ...catalog, candidates: [] } });
assert.equal(emptyCatalog.trace.referenceMode, 'none'); assert.equal(emptyCatalog.trace.fallbackKnowledgeIncluded, true);
assert.match(emptyCatalog.sections.reference, /\[核对:无\]/u);
pass('empty/unavailable catalog supports learning but cannot manufacture a frozen reference standard');

const longMessages = Array.from({ length: 14 }, (_, index): ReviewMessage => ({ id: `m${index}`, role: index % 2 ? 'user' : 'tutor',
  content: `unique-message-${index} ${'H'.repeat(index % 2 ? 850 : 1300)}`, timestamp: at }));
longMessages[13].content = 'LATEST_STUDENT_ORIGINAL';
const compact = compactReviewTutorHistory(longMessages);
assert.equal(compact.truncated, true); assert.ok(compact.text.length <= 7000);
assert.ok(compact.text.includes('LATEST_STUDENT_ORIGINAL')); assert.equal(compact.text.includes('unique-message-0'), false);
const historyRequest = buildReviewTutorContext({ ...normal, messages: longMessages });
assert.equal(historyRequest.trace.historyTruncated, true); assert.match(historyRequest.sections.history, /不能据此断言用户没有说过某条件/u);
assert.ok(historyRequest.userInput.length <= REVIEW_TUTOR_CONTEXT_LIMITS.userInputCharacters);
pass('bounded recent dialogue retains latest answer and labels omissions rather than pretending complete evidence');

const clean = compactReviewTutorHistory([{ ...messages[0], content: response }]);
assert.equal(clean.text.includes('[认知意图:'), false); assert.equal(clean.text.includes('[核对:'), false);
pass('transport-only metadata does not re-enter the conversation history');

assert.throws(() => buildReviewTutorContext({ ...normal, allowedKnowledgeTargets: ['TOO_LONG'.repeat(4000)] }), /超过预算/u);
const hugeReferences = { ...catalog, candidates: [{ ...catalog.candidates[0], quote: 'TOO_LONG_REFERENCE'.repeat(2000) }] };
assert.throws(() => buildReviewTutorContext({ ...normal, referenceCatalog: hugeReferences }), /超过预算/u);
pass('over-budget required originals/targets fail explicitly without prefix truncation or fallback claims');

const reanswer = buildReviewTutorContext({ ...base, mode: 'unaided-reanswer', hintLevel: 3, consultedMaterialCount: 1 });
assert.equal(reanswer.trace.referenceMode, 'frozen-original'); assert.equal(reanswer.sections.learning, '');
assert.equal(reanswer.sections.cognition, ''); assert.match(reanswer.sections.instruction, /同一目标.*无提示重答/u);
assert.match(reanswer.sections.task, /已固定检验任务（不可改变）/u); assert.match(reanswer.sections.task, /give_condition/u);
assert.match(reanswer.sections.reference, /未在本次重新认证事实或版本/u);
assert.equal(reanswer.userInput.includes('RAW_BODY_ONLY_UNRELATED'), false);
assert.equal(reanswer.userInput.includes('本题可选参考检验项'), false);
pass('strong support preserves original task/coordinate/originals and requires independent re-answer without reselecting C/K');

assert.throws(() => buildReviewTutorContext({ ...normal, consultedMaterialCount: 1 }), /强辅助回答必须/u);
assert.throws(() => buildReviewTutorContext({ ...normal, hintLevel: 3 } as any), /强辅助回答必须/u);
assert.throws(() => buildReviewTutorContext({ ...base, mode: 'unaided-reanswer', hintLevel: 0 } as any), /强辅助回答必须/u);
assert.throws(() => buildReviewTutorContext({ ...base, mode: 'support', kind: 'unknown', nextHintLevel: 1 }), /强提示阶梯/u);
pass('invalid task modes cannot bypass strong-hint/consulted-material independent re-answering');

const duplicateRubric = structuredClone(intent);
duplicateRubric.referenceRubric!.items[1] = { ...duplicateRubric.referenceRubric!.items[0], itemId: 'I2', criterionId: 'concept_boundary' };
const dedup = buildReviewTutorContext({ ...base, currentIntent: duplicateRubric, mode: 'unaided-reanswer', hintLevel: 4 });
assert.equal(dedup.sections.reference.split(meaning).length - 1, 1);
assert.match(dedup.sections.reference, /"itemId":"I1"/u); assert.match(dedup.sections.reference, /"itemId":"I2"/u);
pass('an original reused by two frozen criteria is disclosed once while both criterion bindings survive');

const supports = [
  buildReviewTutorContext({ ...base, mode: 'support', kind: 'rephrase', nextHintLevel: 0 }),
  buildReviewTutorContext({ ...base, mode: 'support', kind: 'hint', nextHintLevel: 1 }),
  buildReviewTutorContext({ ...base, mode: 'support', kind: 'unknown', nextHintLevel: 3 }),
  buildReviewTutorContext({ ...base, mode: 'support', kind: 'hint', nextHintLevel: 4 }),
];
assert.match(supports[0].sections.instruction, /不增加解题信息/u);
assert.match(supports[1].sections.instruction, /只指出思考方向.*不给结论/u);
assert.match(supports[2].sections.instruction, /关键条件或中间步骤.*不直接说出最终结论/u);
assert.match(supports[3].sections.instruction, /相似例子.*不直接代答原问题/u);
for (const support of supports) { assert.equal(support.sections.cognition, ''); assert.equal(support.trace.referenceMode, 'frozen-original'); }
pass('rephrase, weak hints, unknown and strong examples preserve the existing hint ladder and task');

const before = JSON.stringify(normal);
const withPackReceipt = { ...normal, currentIntent: { ...intent, referenceStructure: { version: 1 as const, status: 'held' as const,
  originQuestionMessageId: 'q1', reasons: ['SHADOW_PACK_MUST_NOT_ENTER'] } } };
assert.equal(buildReviewTutorContext(withPackReceipt).userInput.includes('SHADOW_PACK_MUST_NOT_ENTER'), false);
assert.equal(JSON.stringify(normal), before); assert.equal(request.trace.automaticMemory, 'disabled'); assert.equal(request.trace.profile, 'not_included');
const project = buildReviewTutorContext({ ...normal, isProjectReview: true }); assert.match(project.sections.task, /最多两个/u);
pass('assembly is read-free/non-mutating, carries no host pack/profile and preserves project intent limits');

// Run the ACTUAL production stream callback with model mocks. No service import
// or provider setup is executed; this checks the empty-response repair and flags.
const chat = readFileSync('src/components/ReviewChat.tsx', 'utf8');
const parsedChat = ts.createSourceFile('ReviewChat.tsx', chat, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
let streamHandler: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'streamTutorResponse') streamHandler = node.initializer;
  ts.forEachChild(node, visit);
} visit(parsedChat); assert.ok(streamHandler);
const compiled = ts.transpileModule(`const tested = ${streamHandler.getText(parsedChat)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const calls: LlmCallRequest[] = []; let updates: any[] = [];
const environment = { previewOnly: false, setIsTutorResponding: () => {}, setError: () => {},
  setMessages: (update: (messages: any[]) => any[]) => { updates = update(updates); }, stripReviewIntentMarkers,
  describeEmptyTutorResponse: () => '两次没有正文', callLLMStream: async (call: LlmCallRequest) => {
    calls.push(call); return new ReadableStream({ start(controller) {
      if (calls.length === 1) controller.enqueue({ type: 'diagnostics', text: '', diagnostics: { finishReason: 'length' } });
      else controller.enqueue({ type: 'content', text: '可见下一问？' }); controller.close();
    } });
  } };
const stream = new Function(...Object.keys(environment), `${compiled}\nreturn tested;`)(...Object.values(environment));
assert.equal((await stream(request.userInput)).content, '可见下一问？'); assert.equal(calls.length, 2);
for (const call of calls) { assert.equal(call.workflow, 'review-tutor'); assert.equal(call.skipMemoryInjection, true);
  assert.equal(call.skipProfileInjection, true); assert.equal(call.thinkingMode, 'disabled'); assert.equal(call.userInput, request.userInput); }
assert.equal(updates.length, 1);
pass('actual streaming callback disables full memory/profile on both bounded attempts and still repairs one empty response');

const previewEnvironment = { ...environment, previewOnly: true };
const previewStream = new Function(...Object.keys(previewEnvironment), `${compiled}\nreturn tested;`)(...Object.values(previewEnvironment));
await assert.rejects(previewStream('not sent'), /不调用导师模型/u); assert.equal(calls.length, 2);
const scoring = chat.slice(chat.indexOf('// 整段评分'), chat.indexOf('const handleFinishReview'));
assert.equal(scoring.includes("workflow: 'review-scoring'"), true); assert.equal(scoring.includes('skipMemoryInjection'), false);
assert.match(chat, /streamTutorResponse\(tutorContext\.userInput\)/u);
pass('preview remains model-free and formal scoring path/parameters are not changed by tutor assembly');

console.log(`Review tutor context checks passed (${checks} groups; synthetic pure-function and actual stream mocks; zero provider/network/vault/score writes).`);

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import type { NoteItem, UploadedDocument } from '../src/types.ts';
import type { ArgumentContextScope } from '../src/services/argumentContext/types.ts';
import { adaptSavedKnowledgeNote } from '../src/electron/rag/argumentSourceAdapter.ts';
import { readSavedArgumentProjectionSource } from '../src/electron/rag/argumentSavedSourceReader.ts';
import { readArgumentReferenceProvenance, buildArgumentReferenceQualificationRequest,
  resolveArgumentReferenceQualification, ARGUMENT_REFERENCE_POLICY_VERSION,
  type ArgumentReferenceProvenance } from '../src/electron/rag/argumentReferencePolicy.ts';
import type { ArgumentProjectionBuildInput } from '../src/services/argumentContext/buildTypes.ts';

// Synthetic temporary files and fixed review votes only; no real vault, cloud or semantic accuracy claim.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Network is forbidden in reference policy checks');
const temporaryParent = path.resolve(os.tmpdir());
const directory = await fs.mkdtemp(path.join(temporaryParent, 'argument-reference-policy-'));
const roots = { vaultRoot: path.join(directory, 'vault'), userStateDir: path.join(directory, 'state'), dataRoot: path.join(directory, 'data') };
const reviewedAt = '2026-10-07T03:00:00.000Z';
const note: NoteItem = { id: 'synthetic-note', title: '合成选择过载', noteType: 'knowledge', content: '没有明确目标时，增加选项可能增加比较负担。比较负担可能降低购买意愿。',
  createdAt: reviewedAt, updatedAt: reviewedAt, tags: [], links: [], backlinks: [], dueDates: [],
  referenceSources: [{ title: '合成来源', type: 'web', url: 'https://example.org/synthetic' }] };
const linked: NoteItem = { ...structuredClone(note), id: 'synthetic-linked', title: '合成关联笔记' };
const scope: ArgumentContextScope = { scopeId: 'synthetic-policy-scope', rootScopeId: 'synthetic-policy-root', corpus: 'reference',
  allowedSourceKinds: ['knowledge-note', 'uploaded-document'], allowedNoteIds: [note.id, linked.id], allowedDocIds: ['synthetic-doc'], allowedRecordIds: [] };
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const saveNote = async (value: NoteItem, extra: NoteItem[] = []) => {
  const items = [value, ...extra], notesMeta = Object.fromEntries(items.map(({ content: _body, ...meta }) => [meta.id, meta]));
  await fs.writeFile(path.join(roots.vaultRoot, 'metadata.json'), JSON.stringify({ version: 1, notesMeta }));
  for (const row of items) await fs.writeFile(path.join(roots.vaultRoot, 'notes', `${row.id}.md`), row.content);
  return adaptSavedKnowledgeNote({ note: value, scope, rootScopeId: scope.rootScopeId });
};
const vote = (reviewId: string, quoteId: string) => ({ version: 1, reviewId, decision: 'eligible',
  relevantContentPresent: true, noCriticalSourceGaps: true, quoteIds: [quoteId], reason: '合成固定审核票：正文可抽取，未认证真实事实。' });
const expectInternalRejection = async (input: ArgumentProjectionBuildInput, provenance: ArgumentReferenceProvenance) => {
  assert.equal(provenance.internalDependenciesComplete, false); assert.equal(provenance.status, 'missing');
  const request = await buildArgumentReferenceQualificationRequest(input, provenance);
  const review = await resolveArgumentReferenceQualification(input, provenance, request,
    vote(request.reviewId, input.quotes[0].quoteId), true, reviewedAt);
  assert.equal(review.decision, 'review_only'); assert.equal(review.checks.provenanceVerified, false);
  assert.equal(review.checks.noCriticalSourceGaps, false);
};

try {
  for (const target of [roots.vaultRoot, roots.userStateDir, path.join(roots.vaultRoot, 'notes'),
    path.join(roots.dataRoot, 'rag-index'), path.join(roots.dataRoot, 'documents')]) await fs.mkdir(target, { recursive: true });
  const input = await saveNote(note), provenance = await readArgumentReferenceProvenance(roots, input);
  assert.equal(provenance.status, 'traceable_declared'); assert.equal(provenance.title, note.title);
  assert.deepEqual(provenance.referenceSources, note.referenceSources);
  assert.equal(provenance.limitations.semanticTruth, 'not_certified');
  assert.equal(provenance.limitations.externalLinks, 'not_fetched_or_authenticated');
  pass('保存的声明出处可追溯，但不抓取URL、不认证世界事实');

  const prepared = await buildArgumentReferenceQualificationRequest(input, provenance), payload = JSON.parse(prepared.request.userInput);
  assert.equal(payload.canonicalText, note.content); assert.deepEqual(payload.quotes, input.quotes);
  assert.deepEqual(payload.hierarchy, input.hierarchy); assert.equal(payload.draft, undefined); assert.equal(payload.selectedAsReference, undefined);
  assert.equal(prepared.request.skipMemoryInjection, true); assert.equal(prepared.request.skipProfileInjection, true);
  assert.ok(prepared.request.userInput.length + prepared.request.systemPrompt.length <= 24000);
  pass('独立审核读取完整正文和宿主Q，不读取抽取候选/画像/权限');

  const raw = vote(prepared.reviewId, input.quotes[0].quoteId);
  const review = await resolveArgumentReferenceQualification(input, provenance, prepared, raw, true, reviewedAt);
  assert.equal(review.decision, 'eligible'); assert.deepEqual(review.evidence, [input.quotes[0].evidence]);
  assert.equal(review.policyVersion, `${ARGUMENT_REFERENCE_POLICY_VERSION}:p-${provenance.fingerprint}`);
  assert.equal(review.checks.provenanceVerified, true); assert.equal(review.checks.reviewIndependent, true);
  pass('明确选择＋可追溯来源＋独立完整审核允许作为可质疑参考');

  assert.equal((await resolveArgumentReferenceQualification(input, provenance, prepared, raw, false, reviewedAt)).decision, 'review_only');
  pass('没有本次明确参考选择不准入');

  const missingNote = { ...structuredClone(note), referenceSources: undefined }, missingInput = await saveNote(missingNote);
  const missing = await readArgumentReferenceProvenance(roots, missingInput), missingRequest = await buildArgumentReferenceQualificationRequest(missingInput, missing);
  const missingReview = await resolveArgumentReferenceQualification(missingInput, missing, missingRequest,
    vote(missingRequest.reviewId, missingInput.quotes[0].quoteId), true, reviewedAt);
  assert.equal(missing.status, 'missing'); assert.equal(missingReview.decision, 'review_only'); assert.equal(missingReview.checks.provenanceVerified, false);
  pass('模型自称eligible不能提升缺出处知识笔记，仍可保留结构审计');

  const urlInBody = { ...missingNote, content: `${note.content}\nhttps://example.org/only-in-body` }, bodyInput = await saveNote(urlInBody);
  assert.equal((await readArgumentReferenceProvenance(roots, bodyInput)).status, 'missing');
  pass('正文出现URL不自动变成宿主溯源记录');

  const invalidReferences = { ...structuredClone(note), referenceSources: [{ title: '无效出处', type: 'web' as const, url: 'javascript:alert(1)' }] };
  assert.equal((await readArgumentReferenceProvenance(roots, await saveNote(invalidReferences))).status, 'missing');
  pass('无效/可执行URL不算可追溯来源');

  const internalNote = { ...structuredClone(note), referenceSources: [{ title: linked.title, type: 'note' as const, entityId: linked.id }] };
  const internal = await readArgumentReferenceProvenance(roots, await saveNote(internalNote, [linked]));
  assert.equal(internal.status, 'traceable_declared'); assert.equal(internal.internalReferences.length, 1);
  assert.equal(internal.internalReferences[0].source.entityId, linked.id);
  pass('内部笔记出处回读实际已保存原文，并绑定关联源版本');

  const singleScope: ArgumentContextScope = { ...scope, scopeId: 'synthetic-single-source',
    allowedSourceKinds: ['knowledge-note'], allowedNoteIds: [note.id], allowedDocIds: [] };
  const singleInput = await adaptSavedKnowledgeNote({ note: internalNote, scope: singleScope, rootScopeId: scope.rootScopeId });
  assert.equal((await readArgumentReferenceProvenance(roots, singleInput)).status, 'missing');
  const singleWithLibrary = await readArgumentReferenceProvenance(roots, singleInput, scope);
  assert.equal(singleWithLibrary.status, 'traceable_declared'); assert.equal(singleWithLibrary.internalReferences.length, 1);
  assert.deepEqual(singleWithLibrary.provenanceScope.allowedNoteIds, [linked.id]);
  assert.deepEqual(singleWithLibrary.provenanceScope.allowedDocIds, []);
  assert.deepEqual(singleInput.scope, singleScope);
  const singlePrepared = await buildArgumentReferenceQualificationRequest(singleInput, singleWithLibrary);
  assert.equal((await resolveArgumentReferenceQualification(singleInput, singleWithLibrary, singlePrepared,
    vote(singlePrepared.reviewId, singleInput.quotes[0].quoteId), true, reviewedAt)).decision, 'eligible');
  pass('生产单源输入通过独立宿主library权限读取其他笔记出处，且不扩大源input.scope');

  const unrelated = { ...structuredClone(linked), id: 'synthetic-unrelated', title: '合成无关资料' };
  await saveNote(internalNote, [linked, unrelated]);
  const unrelatedScope = { ...scope, scopeId: 'another-host-learning-selection', allowedNoteIds: [...scope.allowedNoteIds, unrelated.id] };
  const withUnrelated = await readArgumentReferenceProvenance(roots, singleInput, unrelatedScope);
  assert.equal(withUnrelated.fingerprint, singleWithLibrary.fingerprint);
  assert.deepEqual(withUnrelated.provenanceScope.allowedNoteIds, [linked.id]);
  assert.equal(JSON.parse((await buildArgumentReferenceQualificationRequest(singleInput, withUnrelated)).request.userInput)
    .provenance.provenanceScope.allowedNoteIds.includes(unrelated.id), false);
  pass('无关来源新增和不同项目授权scopeId不改变最小引用绑定、不发送整库IDs');

  const deniedInternal = await readArgumentReferenceProvenance(roots, singleInput, { ...scope, allowedNoteIds: [note.id] });
  assert.equal(deniedInternal.status, 'missing'); assert.notEqual(deniedInternal.fingerprint, singleWithLibrary.fingerprint);
  const deniedPrepared = await buildArgumentReferenceQualificationRequest(singleInput, deniedInternal);
  assert.equal((await resolveArgumentReferenceQualification(singleInput, deniedInternal, deniedPrepared,
    vote(deniedPrepared.reviewId, singleInput.quotes[0].quoteId), true, reviewedAt)).decision, 'review_only');
  pass('内部引用撤权改变provenance指纹并拒绝eligible，不靠单源input自造库权限');

  const changedLinked = { ...structuredClone(linked), content: `${linked.content}这是关联资料的真实保存变更。` };
  await saveNote(internalNote, [changedLinked]);
  const changedInternal = await readArgumentReferenceProvenance(roots, singleInput, scope);
  assert.notEqual(changedInternal.fingerprint, singleWithLibrary.fingerprint);
  assert.notEqual(changedInternal.internalReferences[0].source.version, singleWithLibrary.internalReferences[0].source.version);
  pass('被引用源更新改变内部原文版本和整个provenance指纹');

  await fs.unlink(path.join(roots.vaultRoot, 'notes', `${linked.id}.md`));
  const lostInternal = await readArgumentReferenceProvenance(roots, singleInput, scope);
  assert.equal(lostInternal.status, 'missing'); assert.equal(lostInternal.internalReferences.length, 0);
  const lostPrepared = await buildArgumentReferenceQualificationRequest(singleInput, lostInternal);
  assert.equal((await resolveArgumentReferenceQualification(singleInput, lostInternal, lostPrepared,
    vote(lostPrepared.reviewId, singleInput.quotes[0].quoteId), true, reviewedAt)).decision, 'review_only');
  pass('已授权但丢失的内部笔记原文不能维持准入');
  await saveNote(internalNote, [linked]);
  await assert.rejects(readArgumentReferenceProvenance(roots, singleInput, { ...scope, rootScopeId: 'different-root' }), /invalid_provenance_authorization/);
  await assert.rejects(readArgumentReferenceProvenance(roots, singleInput, { ...scope, corpus: 'personal' }), /invalid_provenance_authorization/);
  pass('独立出处授权只允许本root参考域，拒绝跨root或个人库权限');

  const goodWebMissingNote = { ...structuredClone(note), referenceSources: [...note.referenceSources!,
    { title: '丢失的内部笔记', type: 'note' as const, entityId: linked.id }] };
  const missingMixedInput = await saveNote(goodWebMissingNote);
  await expectInternalRejection(missingMixedInput, await readArgumentReferenceProvenance(roots, missingMixedInput, scope));
  pass('有效web出处不能掩盖明确内部笔记丢失，即使模型全true也不准入');

  const unauthorizedMixedInput = await saveNote(goodWebMissingNote, [linked]);
  await expectInternalRejection(unauthorizedMixedInput, await readArgumentReferenceProvenance(roots, unauthorizedMixedInput,
    { ...scope, allowedNoteIds: [note.id] }));
  pass('有效web出处不能掩盖明确内部笔记未授权');

  const goodNoteMissingDoc = { ...structuredClone(note), referenceSources: [internalNote.referenceSources[0],
    { title: '丢失的内部资料', type: 'document' as const, entityId: 'synthetic-doc' }] };
  const partialInternalInput = await saveNote(goodNoteMissingDoc, [linked]);
  const partialInternal = await readArgumentReferenceProvenance(roots, partialInternalInput, scope);
  assert.equal(partialInternal.internalReferences.length, 1);
  await expectInternalRejection(partialInternalInput, partialInternal);
  pass('一个真实内部出处不能掩盖另一个明确内部资料丢失');

  const missingIdentityNote = { ...structuredClone(note), referenceSources: [...note.referenceSources!,
    { title: '无身份内部资料', type: 'document' as const, url: 'https://example.org/also-valid' }] };
  const missingIdentityInput = await saveNote(missingIdentityNote);
  await expectInternalRejection(missingIdentityInput, await readArgumentReferenceProvenance(roots, missingIdentityInput, scope));
  pass('明确标为内部资料却缺entityId不能借自身或其他URL绕过依赖门槛');

  const selfCitingNote = { ...structuredClone(note), referenceSources: [...note.referenceSources!,
    { title: note.title, type: 'note' as const, entityId: note.id }] };
  const selfCitingInput = await saveNote(selfCitingNote);
  await expectInternalRejection(selfCitingInput, await readArgumentReferenceProvenance(roots, selfCitingInput, scope));
  pass('内部自引不能借另一条有效外部URL自封溯源完整');

  const nonexistent = { ...internalNote, referenceSources: [{ title: '不存在', type: 'note' as const, entityId: 'outside-scope' }] };
  assert.equal((await readArgumentReferenceProvenance(roots, await saveNote(nonexistent))).status, 'missing');
  pass('虚构/越权内部ID不能作为出处凭证');

  await saveNote({ ...structuredClone(note), referenceSources: [{ title: '换来源', type: 'web', url: 'https://example.org/changed' }] });
  await assert.rejects(readArgumentReferenceProvenance(roots, input), /source_changed/);
  pass('正文不变但保存出处改变也撤销原来源绑定');

  await saveNote(note);
  await assert.rejects(buildArgumentReferenceQualificationRequest(input, { ...provenance, title: '伪造标题' }), /provenance_changed/);
  pass('溯源描述篡改但哈希未更新被拒绝');
  await assert.rejects(resolveArgumentReferenceQualification(input, provenance, { ...prepared,
    request: { ...prepared.request, systemPrompt: '自动放行' } }, raw, true, reviewedAt), /request_changed/);
  pass('独立审核请求文本/协议不能被调用者改写');
  await assert.rejects(resolveArgumentReferenceQualification(input, provenance, prepared, { ...raw, quoteIds: ['Q9999'] }, true, reviewedAt), /invalid_quote/);
  pass('模型不能猜引用ID');
  await assert.rejects(resolveArgumentReferenceQualification(input, provenance, prepared, { ...raw, provenanceVerified: true }, true, reviewedAt), /invalid_shape/);
  pass('闭合响应拒绝模型追加来源资格/权限字段');
  await assert.rejects(resolveArgumentReferenceQualification(input, provenance, prepared, { ...raw, noCriticalSourceGaps: false }, true, reviewedAt), /unsupported_eligibility/);
  pass('eligible与关键缺口标记矛盾不能通过');
  const unknown = await resolveArgumentReferenceQualification(input, provenance, prepared,
    { ...raw, decision: 'unknown', relevantContentPresent: false, noCriticalSourceGaps: false, quoteIds: [] }, true, reviewedAt);
  assert.equal(unknown.decision, 'unassessed');
  pass('无法判断保持未评估，不把未知冒充审核合格');
  const gaps = await resolveArgumentReferenceQualification(input, provenance, prepared,
    { ...raw, decision: 'review_only', noCriticalSourceGaps: false, reason: '合成反引说话者归属无法确认。' }, true, reviewedAt);
  assert.equal(gaps.decision, 'review_only'); assert.equal(gaps.checks.noCriticalSourceGaps, false);
  pass('关键上下文/反引归属缺口仅留审计');

  const original = Buffer.from('合成资料中，条件明确时可以提取主张。', 'utf8');
  const metadata: UploadedDocument = { id: 'synthetic-doc', fileName: 'synthetic.txt', fileType: 'txt', extension: '.txt',
    indexable: true, size: original.length, status: 'ready', chunkCount: 0, totalChars: original.toString('utf8').length,
    parseStatus: 'ready', parsedAt: reviewedAt, uploadAt: reviewedAt };
  const text = original.toString('utf8'), sourceHash = createHash('sha256').update(original).digest('hex');
  await fs.writeFile(path.join(roots.dataRoot, 'rag-index', 'manifest.json'), JSON.stringify([metadata]));
  await fs.writeFile(path.join(roots.dataRoot, 'documents', 'synthetic-doc.txt'), original);
  await fs.writeFile(path.join(roots.dataRoot, 'rag-index', 'structured-synthetic-doc.json'), JSON.stringify({ schemaVersion: 1,
    docId: metadata.id, normalizedText: text, sourceHash, materialParserVersion: 1,
    blocks: [{ id: 'synthetic-doc:block:1', textStart: 0, textEnd: text.length, kind: 'paragraph', sectionPath: '',
      locator: { kind: 'text', charStart: 0, charEnd: text.length } }] }));
  const docInput = (await readSavedArgumentProjectionSource({ ...roots, scope }, { kind: 'uploaded-document', entityId: metadata.id }))!;
  const docProvenance = await readArgumentReferenceProvenance(roots, docInput);
  assert.equal(docProvenance.status, 'traceable_saved_original'); assert.equal(docProvenance.uploadedSource?.originalHash, sourceHash);
  const docRequest = await buildArgumentReferenceQualificationRequest(docInput, docProvenance), docRaw = vote(docRequest.reviewId, docInput.quotes[0].quoteId);
  assert.equal((await resolveArgumentReferenceQualification(docInput, docProvenance, docRequest, docRaw, false, reviewedAt)).decision, 'review_only');
  assert.equal((await resolveArgumentReferenceQualification(docInput, docProvenance, docRequest, docRaw, true, reviewedAt)).decision, 'eligible');
  pass('上传原件哈希可追溯仍不能自动准入，需独立内容审核和明确选择');

  const docCitationNote = { ...structuredClone(note), referenceSources: [{ title: '合成上传资料', type: 'document' as const, entityId: metadata.id }] };
  await saveNote(docCitationNote);
  const docCitationInput = await adaptSavedKnowledgeNote({ note: docCitationNote, scope: singleScope, rootScopeId: scope.rootScopeId });
  const docCitation = await readArgumentReferenceProvenance(roots, docCitationInput, scope);
  assert.equal(docCitation.status, 'traceable_declared'); assert.equal(docCitation.internalReferences[0].source.kind, 'uploaded-document');
  assert.deepEqual(docCitation.provenanceScope.allowedDocIds, [metadata.id]); assert.deepEqual(docCitation.provenanceScope.allowedNoteIds, []);
  const docCitationRequest = await buildArgumentReferenceQualificationRequest(docCitationInput, docCitation);
  assert.equal((await resolveArgumentReferenceQualification(docCitationInput, docCitation, docCitationRequest,
    vote(docCitationRequest.reviewId, docCitationInput.quotes[0].quoteId), true, reviewedAt)).decision, 'eligible');
  pass('知识点单源输入可验证无URL的真实上传资料引用，保留原件版本而不扩大稳定scope');
  const deniedDocCitation = await readArgumentReferenceProvenance(roots, docCitationInput, { ...scope, allowedDocIds: [] });
  assert.equal(deniedDocCitation.status, 'missing');
  const deniedDocRequest = await buildArgumentReferenceQualificationRequest(docCitationInput, deniedDocCitation);
  assert.equal((await resolveArgumentReferenceQualification(docCitationInput, deniedDocCitation, deniedDocRequest,
    vote(deniedDocRequest.reviewId, docCitationInput.quotes[0].quoteId), true, reviewedAt)).decision, 'review_only');
  pass('知识点指向未授权上传资料不准入，不能借metadata引用扩大权限');

  const allGoodNote = { ...structuredClone(note), referenceSources: [...note.referenceSources!,
    internalNote.referenceSources[0], docCitationNote.referenceSources[0]] };
  await saveNote(allGoodNote, [linked]);
  const allGoodInput = await adaptSavedKnowledgeNote({ note: allGoodNote, scope: singleScope, rootScopeId: scope.rootScopeId });
  const allGoodProvenance = await readArgumentReferenceProvenance(roots, allGoodInput, scope);
  assert.equal(allGoodProvenance.internalDependenciesComplete, true); assert.equal(allGoodProvenance.internalReferences.length, 2);
  const allGoodRequest = await buildArgumentReferenceQualificationRequest(allGoodInput, allGoodProvenance);
  assert.equal((await resolveArgumentReferenceQualification(allGoodInput, allGoodProvenance, allGoodRequest,
    vote(allGoodRequest.reviewId, allGoodInput.quotes[0].quoteId), true, reviewedAt)).decision, 'eligible');
  pass('web＋内部笔记＋上传资料全部实际授权且完好时正常准入');

  await fs.writeFile(path.join(roots.dataRoot, 'documents', 'synthetic-doc.txt'), '已被替换');
  await assert.rejects(readArgumentReferenceProvenance(roots, docInput), /source_changed/);
  pass('解析未变但上传原文件被替换撤销出处身份');
  await assert.rejects(readArgumentReferenceProvenance(roots, allGoodInput, scope), /source_changed/);
  pass('有效web和笔记不能掩盖上传内部依赖坏SHA，错误保持向宿主传播而不吞掉');
  const changedOriginal = structuredClone(docProvenance); changedOriginal.uploadedSource!.originalHash = 'a'.repeat(64);
  await assert.rejects(buildArgumentReferenceQualificationRequest(docInput, changedOriginal), /provenance_changed/);
  pass('原文件溯源哈希不能被改写');

  await assert.rejects(saveNote({ ...structuredClone(note), content: `${'甲'.repeat(12000)}。${'乙'.repeat(12000)}。` }), /request_budget/);
  const largeNote = { ...structuredClone(note), referenceSources: [1, 2, 3].map(index => ({ title: `合成出处${index}`,
    type: 'web' as const, url: `https://example.org/synthetic/${index}`, snippet: '甲'.repeat(10000) })) };
  const largeInput = await saveNote(largeNote), largeProvenance = await readArgumentReferenceProvenance(roots, largeInput);
  await assert.rejects(buildArgumentReferenceQualificationRequest(largeInput, largeProvenance), /request_budget/);
  pass('超过完整上下文24k请求预算明确拒绝，不截取前缀冒充全文');
  await saveNote(note);
  await assert.rejects(resolveArgumentReferenceQualification(input, provenance, prepared, `\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``, true, reviewedAt), /invalid_json/);
  await assert.rejects(resolveArgumentReferenceQualification(input, provenance, prepared, { ...raw, quoteIds: [input.quotes[0].quoteId, input.quotes[0].quoteId] }, true, reviewedAt), /invalid_review/);
  pass('拒绝包裹式非JSON响应与重复引用');
  const traversal = structuredClone(input); traversal.source.entityId = '../outside';
  await assert.rejects(readArgumentReferenceProvenance(roots, traversal));
  pass('源ID不能用于构造越界文件路径');
  await fs.writeFile(path.join(roots.userStateDir, 'vault-pending-snapshot.json'), '{}');
  await assert.rejects(readArgumentReferenceProvenance(roots, input), /save_in_progress/);
  pass('观察到未完成保存时不读取中间笔记为权威来源');
  console.log(`Reference policy checks passed: ${checks} synthetic groups; no real files or cloud.`);
} finally {
  globalThis.fetch = originalFetch;
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== temporaryParent || !path.basename(resolved).startsWith('argument-reference-policy-')) throw new Error('Unsafe synthetic cleanup target');
  await fs.rm(resolved, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { saveVaultSnapshot } from '../src/electron/vaultSnapshot.ts';
import { withRagSourceTransaction } from '../src/electron/ragSourceTransactions.ts';
import { createArgumentProjectionEnvironmentRegistry, type ArgumentProjectionRoots } from '../src/electron/rag/argumentProjectionEnvironment.ts';
import { createArgumentProjectionSourceScope } from '../src/electron/rag/argumentProjectionRuntime.ts';
import { createArgumentQuestionRuntime } from '../src/electron/rag/argumentQuestionRuntime.ts';
import { readSavedArgumentProjectionSource } from '../src/electron/rag/argumentSavedSourceReader.ts';
import { buildArgumentProjectionReviewInput, finalizeArgumentProjectionBuild } from '../src/services/argumentContext/construction.ts';
import type { ArgumentProjectionBuildInput, ArgumentProjectionDraft } from '../src/services/argumentContext/buildTypes.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import type { ArgumentQuestionFrameSelectors } from '../src/services/argumentContext/questionBindingTypes.ts';
import type { ArgumentQuestionReceipt } from '../src/services/argumentContext/questionReceipt.ts';
import { createReviewArgumentQuestionClient, type ReviewArgumentQuestionApi } from '../src/services/argumentContext/questionBindingClient.ts';
import { freezeReviewAssessment } from '../src/services/reviewAssessment.ts';
import { buildReviewReferenceCatalog, freezeReviewReferenceRubric } from '../src/services/reviewReferenceRubric.ts';
import { inheritReviewQuestionIntent, type ReviewQuestionIntent } from '../src/services/reviewIntent.ts';
import type { ReviewAnswerEvidence } from '../src/services/memory/types.ts';
import type { NoteItem } from '../src/types.ts';
import { fixedAcceptProjectionReview } from './argument-projection-build-fixture.ts';

// Real saved-source/lease/admission/ledger plumbing with synthetic originals and fixed mock votes.
// No network, real user vault, production score, cognitive belief, parser or embedding is touched.
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network allowed in question runtime checks');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-question-runtime-'));
let checks = 0, fixtures = 0, reviews = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const OWNER = 77;
function syntheticNote(id: string, title: string, content: string, noteType: 'knowledge' | 'project' = 'knowledge'): NoteItem {
  return { id, title, content, noteType, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z',
    tags: [], links: [], backlinks: [], dueDates: [] };
}
const saved = syntheticNote('knowledge-A', '合成决策困难', '# 定义\n\n决策困难是无法在选项中作出决定。\n\n## 边界\n\n只有本题指定的复杂选项情境适用。');
const project = syntheticNote('project-A', '合成学习项目', '合成项目，不是真实学习资料。', 'project');
const otherProject = syntheticNote('project-B', '另一个合成项目', '隔离范围。', 'project');
const otherKnowledge = { ...syntheticNote('knowledge-B', '另一个合成知识', '另一个概念的合成定义。'), parentId: otherProject.id };
const source = { ...saved, parentId: project.id };
async function rig() {
  const dataRoot = path.join(temporary, String(++fixtures)); await fs.mkdir(dataRoot);
  const roots: ArgumentProjectionRoots = { dataRoot, vaultRoot: path.join(dataRoot, 'vault'), userStateDir: path.join(dataRoot, 'user-state') };
  let currentRoots = roots, available = true;
  let notes: NoteItem[] = [project, source, otherProject, otherKnowledge];
  const environments = createArgumentProjectionEnvironmentRegistry(() => currentRoots, () => available);
  const questions = createArgumentQuestionRuntime(environments);
  await saveVaultSnapshot(roots.vaultRoot, roots.userStateDir, notes);
  async function environment(owner = OWNER, noteId = project.id) {
    const reply = await environments.getEnvironment(owner, { kind: 'learning-note', noteId });
    assert.equal(reply.status, 'available'); return reply.status === 'available' ? reply.environmentId : assert.fail();
  }
  async function qualification(environmentId: string, decision: 'eligible' | 'review_only', owner = OWNER) {
    return environments.withEnvironment(owner, environmentId, async (runtime, capturedRoots, scope) => {
      const sourceScope = createArgumentProjectionSourceScope(scope, { kind: 'knowledge-note', entityId: source.id });
      return withRagSourceTransaction(Object.values(capturedRoots), async () => {
        const base = await readSavedArgumentProjectionSource({ ...capturedRoots, scope: sourceScope }, { kind: 'knowledge-note', entityId: source.id });
        assert.ok(base);
        return runtime.admission.record(base, { reviewId: `synthetic-admission-${++reviews}`, policyVersion: 'synthetic-review-policy-v1', decision,
          evidence: [base.quotes.at(-1)!.evidence], checks: { provenanceVerified: true, relevantContentPresent: true, noCriticalSourceGaps: true, reviewIndependent: true },
          reason: 'Synthetic host vote; no semantic accuracy claim.', reviewedAt: '2026-10-07T02:00:00.000Z' });
      });
    });
  }
  async function publish(environmentId: string) {
    return environments.withEnvironment(OWNER, environmentId, async runtime => {
      const input = await runtime.host.withSource({ kind: 'knowledge-note', entityId: source.id }, async original => structuredClone(original));
      assert.ok(input);
      const quote = (fragment: string) => { const result = input.quotes.find(q => q.evidence.quote.includes(fragment)); assert.ok(result); return result.quoteId; };
      const draft: ArgumentProjectionDraft = { version: 1, buildId: input.buildId,
        nodes: [{ id: 'N1', role: 'definition', quoteIds: [quote('决策困难是')] }, { id: 'N2', role: 'condition', quoteIds: [quote('复杂选项情境')] }],
        relations: [], groups: [], scopes: [{ id: 'S1', seedNodeId: 'N1', task: 'definition', requiredNodeIds: ['N1', 'N2'],
          requiredRelationIds: [], requiredGroupIds: [], quoteIds: [quote('决策困难是'), quote('复杂选项情境')] }] };
      const review = fixedAcceptProjectionReview(await buildArgumentProjectionReviewInput(input, draft));
      const result = await finalizeArgumentProjectionBuild(input, draft, review);
      const active = await runtime.store.read({ kind: 'knowledge-note', entityId: source.id });
      return runtime.store.publish({ publicationId: `synthetic-pub-${++reviews}`, result, proof: { input, draft, review }, expectedActiveHash: active?.authority.structureHash ?? null });
    });
  }
  async function selectors(questionMessageId = 'synthetic-original-question'): Promise<ArgumentQuestionFrameSelectors> {
    const actual = notes.find(note => note.id === source.id)!;
    const assessment = freezeReviewAssessment('definition', [actual.title]);
    const catalog = await buildReviewReferenceCatalog([actual], [actual.title], [actual.id]);
    const meaning = catalog.candidates.find(item => item.quote.includes('决策困难是'))!, boundary = catalog.candidates.find(item => item.quote.includes('复杂选项情境'))!;
    assert.ok(meaning && boundary);
    return { questionMessageId, knowledgeTargets: [actual.title], assessment,
      referenceRubric: freezeReviewReferenceRubric(`concept_meaning=${meaning.candidateId};concept_boundary=${boundary.candidateId}`, assessment, catalog) };
  }
  async function save(next: NoteItem[]) { notes = structuredClone(next); await saveVaultSnapshot(roots.vaultRoot, roots.userStateDir, notes); }
  return { roots, environments, questions, environment, qualification, publish, selectors, save, notes: () => structuredClone(notes),
    setRoots: (next: ArgumentProjectionRoots) => { currentRoots = next; }, setAvailable: (next: boolean) => { available = next; } };
}

try {
  const r = await rig(), firstEnvironment = await r.environment();
  await r.qualification(firstEnvironment, 'eligible'); assert.equal((await r.publish(firstEnvironment)).status, 'published');
  const original = await r.selectors(), receipt = await r.questions.prepare(OWNER, firstEnvironment, original);
  assert.equal(receipt.status, 'fixed', JSON.stringify(receipt.reasons)); assert.ok(receipt.freezeId && receipt.contractHash);
  assert.equal((await r.questions.verify(OWNER, firstEnvironment, receipt)).status, 'current');
  const firstRead = await r.questions.read(OWNER, firstEnvironment, receipt);
  assert.equal(firstRead.status, 'ready'); assert.ok(firstRead.status === 'ready');
  assert.equal(firstRead.context.coverage, 'complete_required');
  assert.deepEqual(firstRead.context.frames[0].nodes.map(node => node.id), ['N1', 'N2']);
  assert.equal(firstRead.context.quotes.length, 2);
  assert.ok(!JSON.stringify(firstRead).includes('canonicalText') && !JSON.stringify(firstRead).includes(r.roots.vaultRoot));
  assert.deepEqual(Object.keys(receipt).sort(), ['contractHash', 'freezeId', 'originQuestionMessageId', 'reasons', 'selectorsHash', 'status', 'version']);
  pass('实际临时保存来源→HMAC host资格→持久化已审投影→真实host题前receipt→原合同复核');
  pass('宿主只读披露精确必需节点/去重引文，不泄露全文authority或路径');

  const lease2 = await r.environment();
  assert.equal((await r.questions.verify(OWNER, firstEnvironment, receipt)).status, 'held');
  assert.equal((await r.questions.verify(OWNER, lease2, receipt)).status, 'current');
  assert.deepEqual(await r.questions.prepare(OWNER, lease2, original), receipt);
  pass('续租撤销旧environment但新同scope lease可复核旧题；相同question幂等复用原receipt');

  const changed = { ...structuredClone(original), knowledgeTargets: [source.title, '非法新增目标'] };
  assert.equal((await r.questions.prepare(OWNER, lease2, changed)).status, 'held');
  const changedValid = structuredClone(original); changedValid.referenceRubric.items.reverse();
  changedValid.referenceRubric.items.forEach((item, i) => { item.itemId = `I${i + 1}`; });
  assert.deepEqual((await r.questions.prepare(OWNER, lease2, changedValid)).reasons, ['question_already_frozen']);
  assert.equal((await r.questions.verify(OWNER, lease2, receipt)).status, 'current');
  pass('同question改任务/目标/排序不能选新标准或覆盖原合同');

  const unknown = { ...structuredClone(original), selfAuthority: undefined } as ArgumentQuestionFrameSelectors;
  assert.deepEqual((await r.questions.prepare(OWNER, lease2, unknown)).reasons, ['invalid_selectors']);
  const mutable = await r.selectors('late-mutation');
  const preparing = r.questions.prepare(OWNER, lease2, mutable);
  mutable.questionMessageId = 'changed-after-first-await'; mutable.referenceRubric.items[0].quote = '恶意后改草稿';
  const captured = await preparing; assert.equal(captured.status, 'fixed'); assert.equal(captured.originQuestionMessageId, 'late-mutation');
  assert.equal((await r.questions.verify(OWNER, lease2, captured)).status, 'current');
  pass('旧fixed复用前也closed验证undefined字段；第一await前克隆不受调用者迟改影响');

  const reordered: ArgumentQuestionReceipt = { reasons: [...receipt.reasons], selectorsHash: receipt.selectorsHash, contractHash: receipt.contractHash, freezeId: receipt.freezeId,
    originQuestionMessageId: receipt.originQuestionMessageId, status: receipt.status, version: receipt.version };
  assert.equal((await r.questions.verify(OWNER, lease2, reordered)).status, 'current');
  const forged = { ...receipt, freezeId: '00000000-0000-0000-0000-000000000000', contractHash: await argumentContextHash('fake-fixed') };
  assert.deepEqual((await r.questions.verify(OWNER, lease2, forged)).reasons, ['receipt_unavailable']);
  assert.deepEqual(await r.questions.read(OWNER, lease2, forged), { status: 'held', reasons: ['receipt_unavailable'] });
  assert.equal((await r.questions.read(OWNER, lease2, { ...receipt, selectors: original })).status, 'held');
  assert.equal((await r.questions.read(OWNER, firstEnvironment, receipt)).status, 'held');
  assert.deepEqual((await r.questions.verify(OWNER, lease2, { ...receipt, authority: undefined })).reasons, ['environment_unavailable']);
  assert.deepEqual((await r.questions.verify(OWNER, lease2, { ...receipt, contractHash: 'a'.repeat(64) })).reasons, ['receipt_unavailable']);
  pass('receipt键序不影响复核；前端自造fixed/hash/authority不能验证');

  const otherOwnerLease = await r.environment(OWNER + 1);
  assert.deepEqual((await r.questions.verify(OWNER + 1, otherOwnerLease, receipt)).reasons, ['receipt_unavailable']);
  assert.equal((await r.questions.read(OWNER + 1, otherOwnerLease, receipt)).status, 'held');
  const otherSelectionLease = await r.environment(OWNER, otherProject.id);
  assert.deepEqual((await r.questions.verify(OWNER, otherSelectionLease, receipt)).reasons, ['selection_changed']);
  assert.equal((await r.questions.read(OWNER, otherSelectionLease, receipt)).status, 'held');
  const knowledgeSelectionLease = await r.environment(OWNER, source.id);
  assert.deepEqual((await r.questions.verify(OWNER, knowledgeSelectionLease, receipt)).reasons, ['selection_changed']);
  const library = await r.environments.getEnvironment(OWNER, { kind: 'library' }); assert.equal(library.status, 'available');
  assert.ok(library.status === 'available');
  assert.deepEqual((await r.questions.prepare(OWNER, library.environmentId, await r.selectors('library-denied'))).reasons, ['learning_scope_required']);
  pass('webContents owner/项目selection/单知识点selection隔离；library不自封学习标准');

  const otherRoot = await rig(); r.setRoots(otherRoot.roots);
  const changedRootLease = await r.environment();
  assert.deepEqual((await r.questions.verify(OWNER, changedRootLease, receipt)).reasons, ['selection_changed']);
  r.setRoots(r.roots); const currentLease = await r.environment();
  assert.equal((await r.questions.verify(OWNER, currentLease, receipt)).status, 'current');
  pass('同note ID但不同root不能借题前合同；返回原root须新lease并重新源回核');

  let freezeCalls = 0, verifyCalls = 0;
  const api = {
    getEnvironment: (selection: unknown) => r.environments.getEnvironment(OWNER, selection),
    freezeQuestion: (environmentId: string, selectors: ArgumentQuestionFrameSelectors) => { freezeCalls++; return r.questions.prepare(OWNER, environmentId, selectors); },
    verifyQuestion: (environmentId: string, receipt: ArgumentQuestionReceipt) => { verifyCalls++; return r.questions.verify(OWNER, environmentId, receipt); },
    readQuestion: (environmentId: string, receipt: ArgumentQuestionReceipt) => r.questions.read(OWNER, environmentId, receipt),
  } as ReviewArgumentQuestionApi;
  const client = createReviewArgumentQuestionClient(project.id, 'synthetic-client-session', () => api);
  const selected = await r.selectors('tutor-1');
  const intent: ReviewQuestionIntent = { version: 1, questionMessageId: selected.questionMessageId, knowledgeTargets: selected.knowledgeTargets,
    assessment: selected.assessment, referenceRubric: selected.referenceRubric };
  intent.referenceStructure = await client.freeze(intent); assert.equal(intent.referenceStructure.status, 'fixed');
  assert.equal((await client.readReference(intent)).status, 'ready');
  const reanswer = inheritReviewQuestionIntent(intent, 'tutor-rephrase');
  assert.deepEqual(reanswer.referenceStructure, intent.referenceStructure); assert.notEqual(reanswer.questionMessageId, intent.questionMessageId);
  const evidence: ReviewAnswerEvidence[] = [intent, reanswer].map(questionIntent => ({ answer: '合成用户复述', hintLevel: 0, targetKnowledgeNames: [...questionIntent.knowledgeTargets], questionIntent }));
  await client.verifyAnswers(evidence);
  assert.equal(freezeCalls, 1); assert.equal(verifyCalls, 1); assert.ok(evidence.every(answer => answer.referenceStructureVerification?.status === 'current'));
  pass('真实client题前freeze+重答inherit同receipt，finish新lease批量verify按receipt去重');
  const alteredReadIntent = structuredClone(intent); alteredReadIntent.referenceRubric!.items[0].quote = '不是本题原参考';
  assert.equal((await client.readReference(alteredReadIntent)).status, 'held');
  const readMutatingIntent = structuredClone(intent), readingIntent = client.readReference(readMutatingIntent);
  readMutatingIntent.knowledgeTargets = [otherKnowledge.title];
  assert.equal((await readingIntent).status, 'held');
  const readMutableReceipt = structuredClone(receipt), readingReceipt = r.questions.read(OWNER, await r.environment(), readMutableReceipt);
  readMutableReceipt.contractHash = 'c'.repeat(64);
  assert.equal((await readingReceipt).status, 'ready');
  pass('只读client绑定原题，异步迟改拒绝；宿主克隆receipt，外部迟改不污染已捕获请求');

  const clientMutable = structuredClone(intent); clientMutable.questionMessageId = 'client-late-mutation';
  const clientPreparing = client.freeze(clientMutable);
  clientMutable.questionMessageId = 'mutated-client-question'; clientMutable.referenceRubric!.items[0].quote = '迟改草稿';
  const capturedClient = await clientPreparing;
  assert.equal(capturedClient.status, 'fixed');
  assert.equal(capturedClient.originQuestionMessageId, `q-${await argumentContextHash(['synthetic-client-session', 'client-late-mutation'])}`);
  pass('client first await前冻结intent副本，不混入异步过程中被更改的原题选择');

  const mismatched = [structuredClone(evidence[0]), structuredClone(evidence[0])];
  mismatched[1].questionIntent!.knowledgeTargets = [otherKnowledge.title];
  await client.verifyAnswers(mismatched);
  assert.equal(mismatched[0].referenceStructureVerification?.status, 'current');
  assert.equal(mismatched[1].referenceStructureVerification?.status, 'held');
  assert.ok(mismatched[1].referenceStructureVerification?.reasons.includes('intent_changed'));
  const changedRubricEvidence = [structuredClone(evidence[0])]; changedRubricEvidence[0].questionIntent!.referenceRubric!.items[0].quote = '不是原题标准';
  await client.verifyAnswers(changedRubricEvidence); assert.equal(changedRubricEvidence[0].referenceStructureVerification?.status, 'held');
  pass('同receipt缓存也逐answer绑定真实selectorsHash；目标/参考原文变更不能借原题current');

  const lateReceiptEvidence = [structuredClone(evidence[0])];
  const checkingReceipt = client.verifyAnswers(lateReceiptEvidence);
  lateReceiptEvidence[0].questionIntent!.referenceStructure!.contractHash = 'b'.repeat(64);
  await checkingReceipt; assert.equal(lateReceiptEvidence[0].referenceStructureVerification?.status, 'held');
  const lateIntentEvidence = [structuredClone(evidence[0])];
  const checkingIntent = client.verifyAnswers(lateIntentEvidence);
  lateIntentEvidence[0].questionIntent!.knowledgeTargets = [otherKnowledge.title];
  await checkingIntent; assert.equal(lateIntentEvidence[0].referenceStructureVerification?.status, 'held');
  pass('verify await期间receipt或题意改变，不把已认证旧合同结果写给新的回答关联');

  const bounded = Array.from({ length: 14 }, () => structuredClone(evidence[0]));
  await client.verifyAnswers(bounded); assert.ok(bounded.slice(0, 12).every(answer => answer.referenceStructureVerification?.status === 'current'));
  assert.ok(bounded.slice(12).every(answer => answer.referenceStructureVerification?.reasons[0] === 'verification_not_performed'));
  const noApi = createReviewArgumentQuestionClient(project.id, 'no-api-session', () => undefined);
  assert.equal((await noApi.readReference(intent)).status, 'held');
  assert.equal((await noApi.freeze(intent)).status, 'held');
  await noApi.verifyAnswers(evidence); assert.ok(evidence.every(answer => answer.referenceStructureVerification?.status === 'held'));
  pass('client明确标记超过12回答/无IPC未验证，不把漏核回答标为current');

  const heldRig = await rig(), heldLease = await heldRig.environment(), hs = await heldRig.selectors('held-original');
  const heldReceipt = await heldRig.questions.prepare(OWNER, heldLease, hs); assert.equal(heldReceipt.status, 'held'); assert.ok(heldReceipt.freezeId);
  await heldRig.qualification(heldLease, 'eligible'); await heldRig.publish(heldLease);
  const renewedHeldLease = await heldRig.environment();
  assert.deepEqual(await heldRig.questions.prepare(OWNER, renewedHeldLease, hs), heldReceipt);
  assert.equal((await heldRig.questions.verify(OWNER, renewedHeldLease, heldReceipt)).status, 'held');
  assert.equal((await heldRig.questions.read(OWNER, renewedHeldLease, heldReceipt)).status, 'held');
  assert.equal((await heldRig.questions.prepare(OWNER, renewedHeldLease, await heldRig.selectors('new-question'))).status, 'fixed');
  pass('题前held后结构激活不升级旧receipt；只有真正新题才重新冻结');

  const lateRig = await rig(), lateLease = await lateRig.environment();
  await lateRig.qualification(lateLease, 'eligible'); await lateRig.publish(lateLease);
  const lateSelectors = await lateRig.selectors('late-revoke-prepare');
  let release!: () => void, locked!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; }), acquired = new Promise<void>(resolve => { locked = resolve; });
  const lock = withRagSourceTransaction(Object.values(lateRig.roots), async () => { locked(); await released; });
  await acquired;
  const latePreparation = lateRig.questions.prepare(OWNER, lateLease, lateSelectors);
  lateRig.questions.revoke(OWNER); release(); await lock;
  assert.deepEqual((await latePreparation).reasons, ['receipt_unavailable']);
  const afterRevoke = await lateRig.questions.prepare(OWNER, lateLease, await lateRig.selectors('late-verify-revoke'));
  assert.equal(afterRevoke.status, 'fixed');
  const lateVerification = lateRig.questions.verify(OWNER, lateLease, afterRevoke);
  lateRig.questions.revoke();
  assert.deepEqual((await lateVerification).reasons, ['receipt_unavailable']);
  const readBeforeRevoke = await lateRig.questions.prepare(OWNER, lateLease, await lateRig.selectors('late-read-revoke'));
  assert.equal(readBeforeRevoke.status, 'fixed');
  const lateRead = lateRig.questions.read(OWNER, lateLease, readBeforeRevoke);
  lateRig.questions.revoke(OWNER);
  assert.equal((await lateRead).status, 'held');
  pass('prepare/verify进行中owner或global revoke，迟到异步结果不能复活receipt/current');
  pass('只读披露await期间撤销，迟到必要结构不得返回ready');

  const timestampRig = await rig(), timestampLease = await timestampRig.environment();
  await timestampRig.qualification(timestampLease, 'eligible'); await timestampRig.publish(timestampLease);
  const timestampReceipt = await timestampRig.questions.prepare(OWNER, timestampLease, await timestampRig.selectors('timestamp-baseline'));
  assert.equal(timestampReceipt.status, 'fixed');
  await timestampRig.save(timestampRig.notes().map(note => note.id === source.id ? { ...note, updatedAt: '2026-10-07T09:00:00.000Z', flowSummary: '仅合成个人活动状态。' } : note));
  const timestampRenewed = await timestampRig.environment();
  assert.equal((await timestampRig.questions.verify(OWNER, timestampRenewed, timestampReceipt)).status, 'held');
  await timestampRig.environments.withEnvironment(OWNER, timestampRenewed, async runtime => {
    const current = await runtime.host.withSource({ kind: 'knowledge-note', entityId: source.id }, async input => input);
    assert.equal(current?.sourceQualification.status, 'eligible');
    assert.ok(await runtime.store.read({ kind: 'knowledge-note', entityId: source.id }));
  });
  pass('兼容边界：legacy时间改动保守hold passage/rubric，但内容没变不撤真实qualification/projection');

  const qualificationLease = await r.environment(); await r.qualification(qualificationLease, 'review_only');
  assert.equal((await r.questions.verify(OWNER, qualificationLease, receipt)).status, 'held');
  assert.equal((await r.questions.read(OWNER, qualificationLease, receipt)).status, 'held');
  pass('host撤下来源资格后旧已审结构不能继续验证为current');

  const changedSourceNotes = heldRig.notes().map(note => note.id === source.id ? { ...note, content: note.content.replace('无法在选项', '暂时无法在选项'), updatedAt: '2026-10-07T03:00:00.000Z' } : note);
  const validBeforeChange = await heldRig.questions.prepare(OWNER, renewedHeldLease, await heldRig.selectors('before-source-edit'));
  assert.equal(validBeforeChange.status, 'fixed');
  await heldRig.save(changedSourceNotes);
  const changedSourceLease = await heldRig.environment();
  assert.equal((await heldRig.questions.verify(OWNER, changedSourceLease, validBeforeChange)).status, 'held');
  assert.equal((await heldRig.questions.read(OWNER, changedSourceLease, validBeforeChange)).status, 'held');
  assert.equal((await heldRig.questions.prepare(OWNER, changedSourceLease, await heldRig.selectors('before-source-edit'))).status, 'held');
  pass('真实保存正文修改hold旧receipt，不能同题选择新原文补救');

  const restarted = createArgumentQuestionRuntime(r.environments);
  const restartLease = await r.environment();
  assert.deepEqual((await restarted.verify(OWNER, restartLease, receipt)).reasons, ['receipt_unavailable']);
  assert.equal((await restarted.read(OWNER, restartLease, receipt)).status, 'held');
  r.questions.revoke(OWNER); assert.deepEqual((await r.questions.verify(OWNER, restartLease, receipt)).reasons, ['receipt_unavailable']);
  pass('进程重建/owner revoke后旧receipt不可仅凭持久shadow字段恢复认证');

  const evictionRig = await rig(), evictionLease = await evictionRig.environment();
  const firstHeld = await evictionRig.questions.prepare(OWNER, evictionLease, await evictionRig.selectors('eviction-original'));
  for (let index = 0; index < 200; index++) {
    const next = await evictionRig.selectors(`eviction-${index}`);
    next.referenceRubric = { ...next.referenceRubric, status: 'unavailable', items: [], reason: 'missing_selection' };
    await evictionRig.questions.prepare(OWNER, evictionLease, next);
  }
  assert.deepEqual((await evictionRig.questions.verify(OWNER, evictionLease, firstHeld)).reasons, ['receipt_unavailable']);
  pass('每owner 200合同上限明确eviction held，不回放旧shadow自造认证');

  r.setAvailable(false); assert.equal((await r.questions.prepare(OWNER, restartLease, await r.selectors('suspended'))).status, 'held');
  pass('存储环境暂停时准备/复核fail closed；所有测试只触及新建临时数据');

  const reviewSource = await fs.readFile(path.resolve('src/components/ReviewChat.tsx'), 'utf8');
  const streamBody = reviewSource.slice(reviewSource.indexOf('const streamTutorResponse'), reviewSource.indexOf('const handleSendMessage'));
  assert.ok(streamBody.length > 100); assert.ok(!streamBody.includes('setIsTutorResponding(false)') && !streamBody.includes('tutorOperationRef.current = false'));
  const sendBody = reviewSource.slice(reviewSource.indexOf('const handleSendMessage'), reviewSource.indexOf('const requestTutorSupport'));
  const freezeAt = sendBody.indexOf('await argumentQuestionClient.freeze');
  assert.ok(freezeAt > 0 && sendBody.indexOf('lastQuestionIntentRef.current =', freezeAt) > freezeAt);
  assert.ok(sendBody.lastIndexOf('setIsTutorResponding(false)') > freezeAt);
  const helpBody = reviewSource.slice(reviewSource.indexOf('const requestTutorSupport'), reviewSource.indexOf('const handleEndSession'));
  assert.ok(helpBody.includes('inheritReviewQuestionIntent') && !helpBody.includes('argumentQuestionClient.freeze'));
  assert.ok(/disabled=\{isTutorResponding \|\| isScoring/u.test(reviewSource));
  pass('只读源码契约：流结束不提前unlock，题前freeze/提示inherit后才解锁输入；非桌面UI验收');

  console.log(`Argument question runtime checks passed: ${checks} synthetic groups; no semantic accuracy claim.`);
} finally {
  globalThis.fetch = fetchBefore;
  const absolute = path.resolve(temporary), intended = path.resolve(os.tmpdir());
  assert.ok(path.dirname(absolute) === intended && path.basename(absolute).startsWith('loginote-question-runtime-'));
  await fs.rm(absolute, { recursive: true, force: true });
}

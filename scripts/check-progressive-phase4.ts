import { createProgressiveController, type ProgressiveStorageAdapter } from '../src/services/progressiveLearning/runtime';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProgressiveLearningStore } from '../src/electron/progressiveLearningStore';
import { atomicWriteTextFile } from '../src/electron/atomicWrite';
import { ProgressiveReviewWorker } from '../src/services/progressiveLearning/reviewWorker';
import { analyzeProgressivePart, evaluateProgressiveMastery, progressiveMasteryInputs, progressiveReviewReferences, prepareProgressiveMasteryNotes } from '../src/services/progressiveLearning/reviewAnalysis';
import { progressiveReviewEligible, splitProgressiveReview, progressiveCompletion } from '../src/services/progressiveLearning/reviewPolicy';
import { progressiveReviewModelReply, progressiveMasteryModelReply } from './fixtures/progressive-phase4';
import { localProgressiveJudgment } from '../src/services/progressiveLearning/assessment';
import { shareProgressiveTeaching } from '../src/services/progressiveLearning/share';
import type { NoteItem } from '../src/types';
import type { ProgressiveCourse, ProgressiveBeginReply, ProgressiveQuestion, ProgressiveStudyReply } from '../src/services/progressiveLearning/types';
import type { ProgressiveReviewRecord, ProgressiveReviewReply, ProgressiveReviewPacket, ProgressiveReviewLease, ProgressiveAuxiliaryResult } from '../src/services/progressiveLearning/reviewTypes';
const root = await fs.mkdtemp(path.resolve('build/progressive-phase4-contract-'));
const checks: string[] = [];
globalThis.fetch = async () => assert.fail('Phase4 contract checks are offline, no user vault or cloud model');
const quote = '函数要求每个允许输入都有唯一输出，两个不同输入可以有同一输出。';
const body = `# 输入与输出\n\n${quote}\n\n若分母为零，表达式没有意义；根式要求被开方数非负。\n\n${'先检验输入范围，再考察对应结果的唯一性。'.repeat(20)}`;
const question: ProgressiveQuestion = { id: 'q1', kind: 'choice', prompt: '一个输入能同时有两个不同的输出吗？', objective: '检查唯一性', conceptKeys: ['unique'], focus: 'concept', options: [{ id: 'A', text: '不能' }, { id: 'B', text: '能' }], correctOptionId: 'A', referenceAnswer: '不能', explanation: '输出需要唯一', referenceQuote: quote };
function harness(name: string, mainCount = 1, withQuestions = false, legacy = false) {
    const at = new Date().toISOString();
    const directory = path.join(root, name);
    let owner = 1, deleted = false, failWrite = '', failFinish = false, failPersist = false, failProfile = false, knowledgeReady = false;
    let store: ProgressiveLearningStore, notes: NoteItem[] = [];
    const requests: any[] = [], derived: string[] = [], errors: string[] = [], profileIds = new Set<string>();
    let profileCalls = 0, completionCommits = 0;
    let reviewChanged: ((id: string) => void) | undefined;
    const project: NoteItem = { id: name, title: '叶子 ' + name, noteType: 'project', projectRole: 'learning', parentId: 'root-' + name, content: '# 人工项目正文', tags: [], links: [], backlinks: [], createdAt: at, updatedAt: at, dueDates: [{ id: 'deadline-' + name, noteId: name, noteTitle: '叶子 ' + name, taskText: '叶子 ' + name, dueDate: '2026-11-04', estimatedMinutes: 40, priority: 'medium', completed: false }, { id: 'repeat-' + name, noteId: name, noteTitle: '叶子 ' + name, taskText: '每天看两小时书', dueDate: '2026-11-04', startDate: '2026-11-01', priority: 'medium', completed: false, recurrence: { frequency: 'daily' } }] };
    const parent = { ...project, id: project.parentId!, title: '根目标', parentId: undefined, dueDates: [] };
    const sibling = { ...project, id: 'sibling-' + name, title: '兄弟秘密', content: 'SIBLING_SECRET_MUST_NOT_BE_READ', parentId: parent.id, dueDates: [] };
    const knowledge: NoteItem = { ...project, id: 'kp-' + name, title: legacy?'唯一输出的定义':'唯一输出', noteType: 'knowledge', parentId: name, content: 'PRIVATE_MANUAL_KNOWLEDGE_CONTENT_MUST_NOT_BE_READ', dueDates: [] };
    notes = [parent, project, sibling, knowledge];
    function construct() { store = new ProgressiveLearningStore(directory, { readTarget: async () => { if (deleted)
            throw Error('deleted project'); return { note: notes.find(n => n.id === name)!, root: parent, isLeaf: true }; }, write: async (f, t) => { if (failFinish && f.endsWith('course.json') && JSON.parse(t).lastSuccessfulReview) {
            failFinish = false;
            throw Error('injected final receipt save failure');
        } if (failWrite && f.includes(failWrite)) {
            failWrite = '';
            throw Error('injected disk failure');
        } await atomicWriteTextFile(f, t, { allowCopyFallback: false }); }, changed: id => derived.push(id), reviewChanged: id => reviewChanged?.(id), knowledgeIds: async () => knowledgeReady ? [knowledge.id] : [] }); }
    construct();
    const command = async <T = any>(input: any): Promise<T> => { const result = await store.command(input, owner); if (input.op === 'review-completion') completionCommits++; return result as T; };
    const load = () => command<ProgressiveCourse>({ op: 'load', projectNoteId: name });
    const plan = { title: '固定主线', objectives: ['说明输入输出关系'], pages: Array.from({ length: mainCount }, (_, i) => ({ id: 'main-' + (i + 1), title: '主线 ' + (i + 1), objectives: ['理解唯一性'] })) };
    async function publish(reply: ProgressiveBeginReply, questions = withQuestions ? [question] : []) { assert.ok(reply.lease); return command<ProgressiveCourse>({ op: 'publish', lease: reply.lease, teaching: { sequence: reply.course.generation.sequence + 1, plan, title: plan.pages[reply.course.generation.mainlineIndex || 0].title, body:legacy?body.replace('# 输入与输出','# 输入与输出\n\n## 唯一输出的定义'):body, hook: { id: 'hook', kind: 'reflection', prompt: '解释为什么输出需要唯一？' }, concepts: legacy?undefined:[{ key: 'unique', title: '唯一输出', summary: quote }], questions } }); }
    async function initialize() { return publish(await command({ op: 'begin', projectNoteId: name })); }
    async function main() { const c = await load(); return publish(await command({ op: 'next', projectNoteId: name, request: { environmentId: c.environmentId, courseId: c.id, expectedRevision: c.revision, requestId: 'next-' + crypto.randomUUID(), intent: 'mainline', fromPageId: c.progress.currentPageId } })); }
    async function draft(text: string, summary = '') { const c = await load(); return command<ProgressiveCourse>({ op: 'save-progress', projectNoteId: name, progress: { environmentId: c.environmentId, courseId: c.id, expectedProgressVersion: c.progress.version, patch: { restatementDraft: text, summaryDraft: summary, restatementSpans: text ? [{ pageId: c.progress.currentPageId || 'main-1', start: 0, end: text.length }] : [] } } }); }
    async function exit(analyze = true, id = 'exit-' + crypto.randomUUID(), activate = true) { const c = await load(); const reply = await command<ProgressiveReviewReply>({ op: 'review-exit', projectNoteId: name, environmentId: c.environmentId, courseId: c.id, expectedProgressVersion: c.progress.version, exitId: id, analyze }); if (activate)
        await command({ op: 'review-activate', projectNoteId: name, environmentId: c.environmentId, courseId: c.id, exitId: id }); return reply; }
    async function submit(optionId = 'B', nonce = 'submit-' + crypto.randomUUID()) {
        let c = await load();
        await command({ op: 'study', projectNoteId: name, request: { environmentId: c.environmentId, courseId: c.id, pageId: c.page!.id, expectedVersion: c.study!.version, mutation: { kind: 'draft', drafts: { q1: { text: '', optionId } } } } });
        c = await load();
        let r = await command<ProgressiveStudyReply>({ op: 'study', projectNoteId: name, request: { environmentId: c.environmentId, courseId: c.id, pageId: c.page!.id, expectedVersion: c.study!.version, mutation: { kind: 'submit', submissionId: nonce, questionIds: ['q1'] } } });
        const attempt = r.study.attempts.at(-1)!;
        r = await command({ op: 'study', projectNoteId: name, request: { environmentId: c.environmentId, courseId: c.id, pageId: c.page!.id, expectedVersion: r.study.version, mutation: { kind: 'grade', results: [{ attemptId: attempt.id, judgment: localProgressiveJudgment(attempt) }] } } });
        return r;
    }
    let failPart = 0, hold: Promise<void> | null = null, release: (() => void) | null = null;
    const analyze = async (packet: ProgressiveReviewPacket) => {
        requests.push({ part: packet.part!.id, text: packet.text });
        if (hold)
            await hold;
        if (failPart && packet.part!.id === 'part-' + failPart) {
            failPart = 0;
            throw Error('injected model disconnect');
        }
        return analyzeProgressivePart(packet, { call: async (request) => { const input = JSON.parse(request.userInput); assert.ok(!JSON.stringify(input).includes('SIBLING_SECRET')); assert.ok(!JSON.stringify(input).includes('PRIVATE_MANUAL_KNOWLEDGE')); return { content: JSON.stringify(progressiveReviewModelReply(input)) }; } });
    };
    let masteryHold: Promise<void> | null = null, releaseMastery: (() => void) | null = null;
    const evaluate = async (input: any) => { requests.push({ mastery: input.evaluationId, assistance: input.assistance, source: input.source }); if (masteryHold) await masteryHold; return evaluateProgressiveMastery(input, async (request) => ({ content: JSON.stringify(progressiveMasteryModelReply(JSON.parse(request.userInput))) })); };
    function worker() { return new ProgressiveReviewWorker({ command, loadCourse: load, readNotes: () => notes, persist: async (prepare) => { if (failPersist) {
            failPersist = false;
            throw Error('injected note save failure');
        } const next = prepare(notes); await fs.writeFile(path.join(directory, 'actual-notes.json'), JSON.stringify(next)); notes = next; }, analyze, evaluate, profile: async (r, parts) => { profileCalls++; if (failProfile) {
            failProfile = false;
            throw Error('injected profile failure');
        } for (const p of parts)
            profileIds.add(p.analysisV2.analysisRunId); }, cognition: async () => {}, onError: e => errors.push(String(e)) }); }
    return { command, load, initialize, main, draft, exit, submit, worker, plan, directory, requests, derived, errors, project, knowledge, onReviewChange(fn?: (id: string) => void) { reviewChanged = fn; }, get completionCommits() { return completionCommits; }, get notes() { return notes; }, get store() { return store; }, set owner(v: number) { owner = v; }, set deleted(v: boolean) { deleted = v; }, set knowledgeReady(v: boolean) { knowledgeReady = v; }, set failPart(v: number) { failPart = v; }, set failWrite(v: string) { failWrite = v; }, set failFinish(v: boolean) { failFinish = v; }, set failPersist(v: boolean) { failPersist = v; }, set failProfile(v: boolean) { failProfile = v; }, get profileCalls() { return profileCalls; }, get profileIds() { return profileIds; }, reconstruct() { store.releaseOwner(owner); construct(); }, holdAnalysis() { hold = new Promise(r => release = r); }, releaseAnalysis() { hold = null; release?.(); }, holdMastery() { masteryHold = new Promise(r => releaseMastery = r); }, releaseMastery() { masteryHold = null; releaseMastery?.(); } };
}
async function run(h: ReturnType<typeof harness>) { const w = h.worker(); w.kick(); await w.idle(); w.stop(); return h.load(); }
const matrix = harness('completion-matrix', 2, true);
await matrix.initialize();
await matrix.exit(false);
assert.equal((await run(matrix)).completion?.reason, 'mainline_incomplete');
await matrix.main();
const matrixTeachingRevision = (await matrix.load()).revision;
await matrix.exit(false);
assert.equal((await run(matrix)).completion?.reason, 'mainline_pending_answers');
await matrix.submit();
let c = await matrix.load();
await matrix.command({ op: 'save-progress', projectNoteId: c.projectNoteId, progress: { environmentId: c.environmentId, courseId: c.id, expectedProgressVersion: c.progress.version, patch: { currentPageId: 'main-1' } } });
await matrix.submit();
await matrix.exit(false);
c = await run(matrix);
assert.equal(c.revision, matrixTeachingRevision, 'answers, page switches, review exit and completion do not advance teaching');
assert.equal(c.completion?.status, 'committed');
assert.equal(matrix.notes.find(n => n.id === matrix.project.id)!.dueDates.find(d => d.id.startsWith('repeat'))!.completed, false);
assert.equal(matrix.notes.find(n => n.id === matrix.project.id)!.dueDates.find(d => d.id.startsWith('deadline'))!.completed, true);
assert.equal(matrix.requests.length, 0);
assert.ok(!matrix.notes.find(n => n.id === matrix.knowledge.id)!.dsrState);
checks.push('完成矩阵：主线不全/主线待答保持未完成，答错但全提交可完成；不改独立周期任务、不制造掌握分');
const priority = harness('completion-during-old-mastery', 2, true);
await priority.initialize(); priority.knowledgeReady = true; await priority.submit(); await priority.exit();
priority.holdMastery(); const priorityWorker = priority.worker();
const previousWindow = (globalThis as any).window;
(globalThis as any).window = { electronAPI: { progressiveLearning: { onChange: (callback: (id: string) => void) => { priority.onReviewChange(callback); return () => priority.onReviewChange(); } } } };
try { priorityWorker.start(); } finally { (globalThis as any).window = previousWindow; }
async function eventually(check: () => boolean | Promise<boolean>) {
    for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail('expected state before old model request returns');
}
try {
    await eventually(() => priority.requests.some(r => r.mastery));
    await priority.main(); await priority.submit(); await priority.exit();
    // Actual host change notifications reach start() while this same project is active.
    await eventually(async () => (await priority.load()).completion?.status === 'committed');
    assert.equal(priority.notes.find(n => n.id === priority.project.id)!.dueDates[0].completed, true);
    assert.equal((await priority.load()).lastSuccessfulReview, undefined);
    assert.equal(priority.requests.filter(r => r.mastery).length, 1, 'old evaluation remains held; completion is independent');
    for (let i = 0; i < 12; i++) priorityWorker.kick(priority.project.id);
} finally { priority.releaseMastery(); await priorityWorker.idle(); priorityWorker.stop(); }
assert.deepEqual(priority.errors, []);
assert.equal(priority.completionCommits, 1, 'completion lane and normal queue coalesce their writes');
checks.push('旧知识点评价尚未返回时新退出立即同步完成；重复通知合并，答题项目无需复盘，不重复主分析');
const optionalReview = harness('quiz-with-optional-review', 1, true);
await optionalReview.initialize(); await optionalReview.submit(); await optionalReview.draft('函数要求每个允许输入都有唯一输出，不同输入可以得到同样的输出。');
await optionalReview.exit(); optionalReview.holdAnalysis(); const optionalWorker = optionalReview.worker(); optionalWorker.kick();
try {
    await eventually(() => optionalReview.notes.find(n => n.id === optionalReview.project.id)!.dueDates[0].completed);
    assert.equal((await optionalReview.load()).lastSuccessfulReview, undefined, 'optional analysis need not finish before marking quiz project completed');
    await eventually(() => optionalReview.requests.some(r => r.part));
} finally { optionalReview.releaseAnalysis(); await optionalWorker.idle(); optionalWorker.stop(); }
checks.push('全提交的有题项目不等待可选复盘分析；启动恢复先同步完成，再处理模型分析');
const noQuiz = harness('no-quiz');
await noQuiz.initialize();
const noQuizTeachingRevision = (await noQuiz.load()).revision;
await noQuiz.exit(false);
assert.equal((await run(noQuiz)).completion?.reason, 'review_required');
await noQuiz.draft('## 复盘 · 2026-11-01 12:00\n\n');
await noQuiz.exit();
assert.equal((await noQuiz.load()).reviews?.length || 0, 0);
await noQuiz.draft('函数的每个允许输入都对应一个唯一输出，两个不同输入可以输出相同。');
await noQuiz.exit(false);
assert.equal((await run(noQuiz)).reviews?.length || 0, 0);
assert.ok((await noQuiz.load()).progress.restatementDraft);
assert.equal(noQuiz.requests.length, 0);
checks.push('无题叶子需要本项目的全局成功凭据；空白/自动标题不准入，关闭分析保留同一草稿且零分析请求');
const prepared = await noQuiz.exit(true, 'prepared-exit', false);
assert.equal((await noQuiz.command<any[]>({ op: 'review-work' })).length, 0);
await assert.rejects(noQuiz.command({ op: 'review-claim', projectNoteId: noQuiz.project.id, reviewId: prepared.record!.id }));
await noQuiz.command({ op: 'review-activate', projectNoteId: noQuiz.project.id, environmentId: prepared.course.environmentId, courseId: prepared.course.id, exitId: 'prepared-exit' });
c = await run(noQuiz);
assert.equal(c.reviews![0].status, 'analyzed');
assert.ok(c.lastSuccessfulReview);
assert.equal(c.progress.restatementDraft, '');
assert.equal(c.completion?.status, 'committed');
const archived = await noQuiz.command<ProgressiveReviewRecord>({ op: 'review-read', projectNoteId: noQuiz.project.id, reviewId: c.lastSuccessfulReview!.reviewId });
assert.ok(archived.rawText.includes('唯一输出'));
assert.equal(archived.auxiliary, 'waiting_knowledge');
checks.push('退出先保存后激活；主分析成功归档准确版本、清除已分析草稿并形成全局凭据；知识点未准备不阻断成功和完成');
const calls = noQuiz.requests.length;
await noQuiz.exit(false);
await run(noQuiz);
assert.equal(noQuiz.requests.filter(r => r.part).length, 1);
assert.equal((await noQuiz.load()).progress.restatementDraft, '');
noQuiz.knowledgeReady = true;
await run(noQuiz);
c = await noQuiz.load();
assert.equal(c.reviews![0].auxiliary, 'ready');
assert.equal(c.revision, noQuizTeachingRevision, 'analysis receipts and mastery completion keep their own private versions');
assert.equal(noQuiz.requests.filter(r => r.part).length, 1);
assert.ok(noQuiz.notes.find(n => n.id === noQuiz.knowledge.id)!.dsrState?.masteryShadow);
const state = structuredClone(noQuiz.notes.find(n => n.id === noQuiz.knowledge.id)!.dsrState);
await noQuiz.command({ op: 'review-retry', projectNoteId: noQuiz.project.id, reviewId: archived.id });
await run(noQuiz);
assert.deepEqual(noQuiz.notes.find(n => n.id === noQuiz.knowledge.id)!.dsrState, state);
checks.push('重进不回填已分析原文、不重复主分析；知识点创建后仅补掌握度，重复辅助保存不重复累计');
const long = harness('long-review');
await long.initialize();
long.knowledgeReady = true;
const raw = Array.from({ length: 320 }, (_, i) => `第${i + 1}段：函数的每个允许输入都对应唯一输出，输入范围决定条件。🚀\n\n`).join('');
const pieces = splitProgressiveReview(raw);
assert.ok(pieces.length > 1);
assert.equal(pieces.map(p => raw.slice(p.start, p.end)).join(''), raw);
await long.draft(raw);
const ex = await long.exit();
long.failPart = 2;
await run(long);
c = await long.load();
assert.equal(c.reviews![0].status, 'failed');
assert.equal(c.reviews![0].completedParts, 1);
assert.equal(c.lastSuccessfulReview, undefined);
assert.equal(c.progress.restatementDraft, raw);
long.reconstruct();
await long.command({ op: 'review-retry', projectNoteId: long.project.id, reviewId: ex.record!.id });
await long.draft(raw + '这是分析期间追加的新复述，应当继续保留。');
long.failProfile = true;
c = await run(long);
assert.equal(c.reviews![0].status, 'analyzed');
assert.equal(c.reviews![0].auxiliary, 'failed');
assert.equal(c.progress.restatementDraft, '这是分析期间追加的新复述，应当继续保留。');
assert.equal(long.requests.filter(r => r.part === 'part-1').length, 1);
assert.ok(c.lastSuccessfulReview);
const mastery = long.notes.find(n => n.id === long.knowledge.id)!.dsrState!.masteryShadow!;
assert.ok(Object.values(mastery.layers).every(l => l.independentPasses <= 1));
const afterMastery = JSON.stringify(mastery);
await long.command({ op: 'review-retry', projectNoteId: long.project.id, reviewId: ex.record!.id });
await run(long);
assert.equal(JSON.stringify(long.notes.find(n => n.id === long.knowledge.id)!.dsrState!.masteryShadow), afterMastery);
assert.equal(long.requests.filter(r => r.part === 'part-1').length, 1);
checks.push('长复述无截断分段，重启只重试失败分段；保留分析期间新增文本，画像失败不撤销主分析，分段与重试不重复掌握证据');
const duplicate = harness('leases');
await duplicate.initialize();
await duplicate.draft('这个项目用函数的唯一输出条件解释输入和输出之间的对应。');
const dup = await duplicate.exit();
const lease = (await duplicate.command<ProgressiveReviewReply>({ op: 'review-claim', projectNoteId: duplicate.project.id, reviewId: dup.record!.id })).lease!;
duplicate.owner = 2;
assert.equal((await duplicate.command<ProgressiveReviewReply>({ op: 'review-claim', projectNoteId: duplicate.project.id, reviewId: dup.record!.id })).running, true);
await assert.rejects(duplicate.command({ op: 'review-finish', lease }));
duplicate.owner = 1;
const packet = await duplicate.command<ProgressiveReviewPacket>({ op: 'review-packet', lease, partId: 'part-1' });
const references = await progressiveReviewReferences(packet).retrieve({} as any, {} as any, [{ id: 'test', layer: 'concept', nodeIds: [], query: '函数 唯一 输出' }]);
assert.ok(references.every(r => r.sourceId.includes(dup.course.id)));
assert.ok(!JSON.stringify(packet).includes('SIBLING_SECRET'));
const fake = { ...lease, environmentId: 'other-vault' };
await assert.rejects(duplicate.command({ op: 'review-fail', lease: fake, error: 'late' }));
duplicate.store.releaseOwner(1);
checks.push('复盘单任务许可防止并发重复分析，跨环境与过期回包拒绝；页内参考包不读取兄弟/整库或人工知识正文');
const data = harness('answers', 1, true);
await data.initialize();
data.knowledgeReady = true;
let r = await data.submit('B');
c = await data.load();
await data.command({ op: 'study', projectNoteId: data.project.id, request: { environmentId: c.environmentId, courseId: c.id, pageId: 'main-1', expectedVersion: c.study!.version, mutation: { kind: 'view-explanation', attemptId: r.study.attempts[0].id } } });
r = await data.submit('A');
const answerExit = await data.exit();
const claimed = await data.command<ProgressiveReviewReply>({ op: 'review-claim', projectNoteId: data.project.id, reviewId: answerExit.record!.id });
const answerPacket = await data.command<ProgressiveReviewPacket>({ op: 'review-packet', lease: claimed.lease! });
const inputs = progressiveMasteryInputs(answerPacket, data.notes).inputs;
assert.equal(inputs[0].assistance, 'independent');
assert.equal(inputs[1].assistance, 'assisted');
data.store.releaseOwner(1);
await run(data);
assert.equal(data.requests.filter(r => r.part).length, 0);
assert.ok(data.requests.some(r => r.source === 'quick_check'));
assert.equal((await data.load()).lastSuccessfulReview, undefined);
checks.push('仅答题也保存并评价实际知识对象，不造空复盘；首次与重答/查看解析分开，重答不制造新的独立通过');
const failure = harness('durable-first');
await failure.initialize();
await failure.draft('函数是每个输入都有唯一输出的对应，边界条件需要说明清楚。');
await failure.exit();
failure.failWrite = 'course.json';
await run(failure);
assert.equal((await failure.load()).lastSuccessfulReview, undefined);
assert.ok((await failure.load()).progress.restatementDraft);
failure.reconstruct();
await run(failure);
c = await failure.load();
assert.equal(c.reviews![0].status, 'analyzed');
assert.ok(c.lastSuccessfulReview);
checks.push('真实落盘失败不虚报分析成功或清空原文；重建存储后从已提交记录恢复');
const extension = harness('optional-expansion', 1, true);
await extension.initialize();
await extension.submit('B');
let ec = await extension.load();
const extra = await extension.command<ProgressiveBeginReply>({ op: 'next', projectNoteId: ec.projectNoteId, request: { environmentId: ec.environmentId, courseId: ec.id, expectedRevision: ec.revision, requestId: 'extra-test', intent: 'expansion', fromPageId: 'main-1' } });
await extension.command({ op: 'publish', lease: extra.lease!, teaching: { sequence: extra.course.generation.sequence + 1, plan: extension.plan, title: '选学补充', body, questions: [question], concepts: [{ key: 'unique', title: '唯一输出', summary: quote }], hook: { id: 'extra-hook', kind: 'reflection', prompt: '复述条件' } } });
await extension.exit(false);
assert.equal((await run(extension)).completion?.status, 'committed');
checks.push('扩展页仍有未提交题目时不增加原叶子的完成门槛，主线完成不要求用尽预算');
const historical = (await noQuiz.load()).lastSuccessfulReview!;
await noQuiz.draft('这是新一次复述，即使本次分析失败也不得清除已经有效的复盘凭据。');
await noQuiz.exit();
noQuiz.failPart = 1;
c = await run(noQuiz);
assert.equal(c.lastSuccessfulReview?.reviewId, historical.reviewId);
assert.equal(c.completion?.status, 'committed');
assert.ok(c.progress.restatementDraft);
checks.push('已有全局有效复盘后新分析失败仍保留成功凭据和新草稿，完成判定按历史事实执行');
const receipt = harness('receipt-disk-failure');
await receipt.initialize();
await receipt.draft('函数的每个允许输入都对应唯一输出，必须说明定义域范围。');
const re = await receipt.exit();
receipt.failFinish = true;
await run(receipt);
let rc = await receipt.load();
assert.equal(rc.lastSuccessfulReview, undefined);
assert.equal(rc.reviews![0].completedParts, 1);
assert.ok(rc.progress.restatementDraft);
await receipt.command({ op: 'review-retry', projectNoteId: receipt.project.id, reviewId: re.record!.id });
await run(receipt);
rc = await receipt.load();
assert.ok(rc.lastSuccessfulReview);
assert.equal(receipt.requests.filter(x => x.part).length, 1);
checks.push('最终成功回执落盘失败时不清草稿、不虚报全局成功；重试复用已保存主分析结果，零额外模型调用');
c = await failure.load();
const saved = JSON.stringify(shareProgressiveTeaching(c));
assert.ok(!/reviews|lastSuccessfulReview|rawText|auxiliary|completion|assistance|dsrState/u.test(saved));
const original = await failure.command<ProgressiveReviewRecord>({ op: 'review-read', projectNoteId: failure.project.id, reviewId: c.reviews![0].id });
await failure.command({ op: 'review-edit', projectNoteId: failure.project.id, reviewId: original.id, expectedVersion: original.version, text: '用户修改后的归档文本' });
const edited = await failure.command<ProgressiveReviewRecord>({ op: 'review-read', projectNoteId: failure.project.id, reviewId: original.id });
assert.equal(edited.rawText, original.rawText);
assert.equal(edited.status, 'analyzed');
assert.equal(edited.editedText, '用户修改后的归档文本');
checks.push('归档编辑保留原分析版本且不重跑；课程分享白名单排除分析、作答、进度、完成凭据和掌握度');
const live = harness('live-draft-rebase');
await live.initialize();
const adapter: ProgressiveStorageAdapter = { load: live.load, readReview: (id, reviewId) => live.command({ op: 'review-read', projectNoteId: id, reviewId }), begin: (id, sourcePackets) => live.command({ op: 'begin', projectNoteId: id, sourcePackets }), checkpoint: (lease, checkpoint) => live.command({ op: 'checkpoint', lease, checkpoint }), publish: (lease, teaching) => live.command({ op: 'publish', lease, teaching }), saveProgress: (id, progress) => live.command({ op: 'save-progress', projectNoteId: id, progress }), interrupt: (lease, error) => live.command({ op: 'interrupt', lease, error }) };
const controller = createProgressiveController({ note: live.project, allNotes: live.notes }, { storage: adapter, registerFlush: () => () => { }, checkpointIntervalMs: 60000, loadMaterials: async () => [], stream: async () => assert.fail('published page must not generate') });
await controller.start();
const analyzedText = '函数要求每个允许输入对应唯一输出，这是已经提交分析的部分。';
controller.recordRestatement!(analyzedText);
await controller.flush();
await live.exit();
controller.recordRestatement!(analyzedText + '这是尚未保存的新内容。');
controller.saveProgress({ summaryDraft: '后续新总结' });
await run(live);
await controller.flush();
assert.equal(controller.getSnapshot().course!.progress.restatementDraft, '这是尚未保存的新内容。');
assert.equal((await live.load()).progress.summaryDraft, '后续新总结');
controller.recordRestatement!('本地尚未保存的编辑');
await live.draft('外部更新的草稿必须保留');
await assert.rejects(controller.flush());
assert.equal((await live.load()).progress.restatementDraft, '外部更新的草稿必须保留');
controller.dispose();
checks.push('活跃页面收到归档更新后重基未保存的新复述与总结，不复活历史原文；非归档的并发草稿仍拒绝覆盖');

const guarded=harness('completion-receipt-guard',1,true);await guarded.initialize();
const owned=path.join(guarded.directory,'progressive-learning');const ownedProject=(await fs.readdir(owned)).find(n=>n.startsWith('project-'))!;const ownedFile=path.join(owned,ownedProject,'course.json');
let disk=JSON.parse(await fs.readFile(ownedFile,'utf8'));disk.pages[0].questionCount=0;await fs.writeFile(ownedFile,JSON.stringify(disk));await guarded.exit(false);assert.equal((await guarded.load()).completion!.reason,'mainline_pending_answers');
disk=JSON.parse(await fs.readFile(ownedFile,'utf8'));disk.lastSuccessfulReview={reviewId:'review-'+('a'.repeat(64)),textKey:'forged',completedAt:new Date().toISOString()};disk.completion={exitId:'forged-exit',requestedAt:new Date().toISOString(),reason:'eligible',status:'ready',activated:true};await fs.writeFile(ownedFile,JSON.stringify(disk));await run(guarded);assert.equal(guarded.notes.find(n=>n.id===guarded.project.id)!.dueDates[0].completed,false);assert.ok(guarded.errors.length);checks.push('完成预检读取真实主线题与提交事实，不相信错误统计；无匹配主分析记录的成功标记不能自动完成');

const legacyCourse=harness('old-first-page',1,false,true);await legacyCourse.initialize();legacyCourse.knowledgeReady=true;assert.equal((await legacyCourse.load()).page!.concepts,undefined);await legacyCourse.draft('函数的每个输入都对应唯一输出，需要说明输入范围，不能一个输入给出两个不同输出。');await legacyCourse.exit();await run(legacyCourse);assert.ok(legacyCourse.notes.find(n=>n.id===legacyCourse.knowledge.id)!.dsrState?.masteryShadow);assert.equal((await legacyCourse.load()).page!.concepts,undefined);checks.push('第一阶段没有概念元数据的旧页按已发布定义段落建立受限评价上下文，复用真实知识点对象，不重写或重算旧页');
assert.equal(progressiveReviewEligible('短答案'), false);
assert.equal(progressiveReviewEligible('## 复盘 · 2026-11-01 12:00\n\n'), false);
const proof = { status: 'passed', root, checks: checks.length, coverage: checks, network: 'blocked', quality: 'deterministic model replies through production parsing; semantic quality not assessed' };
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof, null, 2));

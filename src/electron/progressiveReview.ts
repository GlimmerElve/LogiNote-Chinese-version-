import {progressivePageConcepts}from './progressiveKnowledge';
import {progressiveStudySummary}from './progressiveStudy';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { StoredProgressiveCourse } from './progressiveLearningStore';
import type { ProgressiveCourse, ProgressiveLessonPage, ProgressivePageStudy, ProgressivePageSummary, ProgressiveStudySummary } from '../services/progressiveLearning/types';
import type { ProgressiveReviewCommand, ProgressiveReviewRecord, ProgressiveReviewSummary, ProgressiveReviewLease, ProgressiveReviewPacket, ProgressiveAuxiliaryResult, ProgressiveReviewReply } from '../services/progressiveLearning/reviewTypes';
import { progressiveReviewEligible, splitProgressiveReview, remainingProgressiveDraft, progressiveCompletion } from '../services/progressiveLearning/reviewPolicy';
import { flowReviewContentText } from '../services/textbook/reviewAdmission';
import { progressiveText } from '../services/progressiveLearning/validation';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const summary = (r: ProgressiveReviewRecord): ProgressiveReviewSummary => ({ id: r.id, version: r.version, submittedAt: r.submittedAt, updatedAt: r.updatedAt, status: r.status, activated: r.activated, textKey: r.textKey, pageIds: r.pageIds, parts: r.parts, completedParts: r.completedParts, auxiliary: r.auxiliary, ...(r.error ? { error: r.error } : {}), ...(r.auxiliaryError ? { auxiliaryError: r.auxiliaryError } : {}) });
interface Host {
    environmentId: string;
    current(): void;
    directory(projectId: string): Promise<string>;
    readJson(file: string, limit: number): Promise<unknown | null>;
    write(file: string, value: unknown, limit?: number): Promise<void>;
    read(projectId: string): Promise<StoredProgressiveCourse | null>;
    save(course: StoredProgressiveCourse): Promise<void>;
    snapshot(course: StoredProgressiveCourse): Promise<ProgressiveCourse>;
    target(projectId: string): Promise<unknown>;
    readPage(projectId: string, pageId: string, hash: string): Promise<ProgressiveLessonPage>;
    study(course: StoredProgressiveCourse, pageId: string): Promise<ProgressivePageStudy>;
    list(): Promise<Array<{
        projectNoteId: string;
    }>>;
    knowledgeIds?(projectId: string, pageId: string, pageHash: string): Promise<string[]>;
    changed?(projectId: string): void;
}
export class ProgressiveReviewAuthority {
    private leases = new Map<string, ProgressiveReviewLease & {
        owner: number;
    }>();
    constructor(private host: Host) { }
    releaseOwner(owner: number) { for (const [key, value] of this.leases)
        if (value.owner === owner)
            this.leases.delete(key); }
    private key(projectId: string, id: string) { return projectId + ':' + id; }
    private id(id: string) { if (!/^review-[a-f0-9]{64}$/u.test(id))
        throw Error('复盘编号无效'); return id; }
    private async file(projectId: string, name: string) { return path.join(await this.host.directory(projectId), 'reviews', name); }
    private async read(course: StoredProgressiveCourse, id: string) {
        this.id(id);
        const ref = course.reviews?.find(r => r.id === id);
        if (!ref)
            throw Error('复盘记录不存在');
        const r = await this.host.readJson(await this.file(course.projectNoteId, `${id}.${ref.version}.json`), 800000) as ProgressiveReviewRecord;
        if (!r || r.schemaVersion !== 1 || r.id !== id || r.version !== ref.version || r.courseId !== course.id || r.projectNoteId !== course.projectNoteId
            || !Array.isArray(r.chunks) || r.chunks.length > 100 || !Array.isArray(r.pageRefs) || !Array.isArray(r.studyRefs))
            throw Error('复盘记录无法读取，原文未覆盖');
        progressiveText(r.rawText, 100000, '复盘原文', true);
        progressiveText(r.summaryText, 100000, '复盘总结', true);
        let end = 0;
        for (const p of r.chunks) {
            if (p.id !== `part-${r.chunks.indexOf(p) + 1}` || p.start !== end || !Number.isSafeInteger(p.end) || p.end <= p.start || p.end > r.rawText.length || p.end - p.start > 2800)
                throw Error('复盘分段无效');
            end = p.end;
        }
        if (r.chunks.length && end !== r.rawText.length)
            throw Error('复盘分段不完整');
        return r;
    }
    private async save(course: StoredProgressiveCourse, r: ProgressiveReviewRecord) {
        r = { ...r, version: r.version + 1, updatedAt: new Date().toISOString() };
        await this.host.write(await this.file(course.projectNoteId, `${r.id}.${r.version}.json`), r, 700000);
        const next = { ...course, reviews: [...(course.reviews || []).filter(x => x.id !== r.id), summary(r)], updatedAt: r.updatedAt };
        await this.host.save(next);
        this.host.changed?.(course.projectNoteId);
        return { course: next, record: r };
    }
    private async blob(course: StoredProgressiveCourse, r: ProgressiveReviewRecord, suffix: string, version: string) {
        if (!/^[a-f0-9]{64}$/u.test(version))
            throw Error('分析结果版本无效');
        const value = await this.host.readJson(await this.file(course.projectNoteId, `${r.id}.${suffix}.${version}.json`), 3000000);
        if (!value || hash(value) !== version)
            throw Error('已保存分析结果无法读取，未重新计分');
        return value;
    }
    private async packet(course: StoredProgressiveCourse, r: ProgressiveReviewRecord, partId?: string): Promise<ProgressiveReviewPacket> {
        const part = partId ? r.chunks.find(p => p.id === partId) : undefined;
        if (partId && !part)
            throw Error('复盘分段不存在');
        const ids = part ? [...new Set(r.spans.filter(s => s.end > part.start && s.start < part.end).map(s => s.pageId))] : r.pageIds;
        if (!ids.length && r.pageIds.length)
            ids.push(r.pageIds[0]);
        const materials = [];
        for (const ref of r.pageRefs.filter(p => ids.includes(p.id))) {
            const page = await this.host.readPage(course.projectNoteId, ref.id, ref.contentHash);
            const knowledgeIds = await this.host.knowledgeIds?.(course.projectNoteId, ref.id, ref.contentHash) || [];
            materials.push({ page:page.concepts===undefined?{...page,concepts:progressivePageConcepts(page)}:page, hash: ref.contentHash, knowledgeIds });
        }
        const attempts: ProgressiveReviewPacket['attempts'] = [];
        if (!part) {
            for (const ref of r.studyRefs) {
                const frozen = { ...course, studyPages: [ref] };
                const study = await this.host.study(frozen, ref.pageId);
                for (const attempt of study.attempts) {
                    const feedback = study.feedback.filter(f => f.questionId === attempt.questionId);
                    attempts.push({ pageId: ref.pageId, attempt, disputed: feedback.some(f => f.status !== 'not-confirmed'), explanationViewed: Boolean(study.explanationViews?.some(v => v.viewedAt <= attempt.submittedAt && study.attempts.find(a => a.id === v.attemptId)?.questionId === attempt.questionId)) });
                }
            }
        }
        return { record: r, ...(part ? { part } : {}), text: part ? r.rawText.slice(part.start, part.end) : r.rawText, materials, attempts };
    }
    private lease(command: {
        lease: ProgressiveReviewLease;
    }, owner: number, course: StoredProgressiveCourse) {
        const incoming = command.lease, lease = incoming && this.leases.get(this.key(course.projectNoteId, incoming.reviewId));
        if (!lease || lease.owner !== owner || lease.token !== incoming.token || incoming.environmentId !== this.host.environmentId || incoming.courseId !== course.id || incoming.projectNoteId !== course.projectNoteId)
            throw Error('复盘执行许可已变化，旧结果未写入');
        return lease;
    }
    private async completionFacts(course:StoredProgressiveCourse){
        const pages=(course.pages||[]).map(p=>({...p})),studyPages=[...(course.studyPages||[])];
        for(const main of course.plan?.pages||[]){const ref=pages.find(p=>p.id===main.id&&p.kind==='mainline');if(!ref)continue;
            const page=await this.host.readPage(course.projectNoteId,ref.id,ref.contentHash),study=await this.host.study(course,ref.id);
            ref.questionCount=page.questions?.length||0;const index=studyPages.findIndex(s=>s.pageId===ref.id);const summary=progressiveStudySummary(study,page);
            if(index<0)studyPages.push(summary);else studyPages[index]=summary;
        }
        return {...course,pages,studyPages};
    }
    private async validateSuccessfulReceipt(course:StoredProgressiveCourse){
        const success=course.lastSuccessfulReview;if(!success)return;
        const record=await this.read(course,success.reviewId);
        if(record.status!=='analyzed'||!record.chunks.length||record.chunks.some(p=>!p.resultHash)||record.completedParts!==record.chunks.length||record.textKey!==success.textKey)throw Error('全局复盘凭据与已保存主分析不一致，未自动完成项目');
    }
    private async reply(course: StoredProgressiveCourse, r?: ProgressiveReviewRecord, lease?: ProgressiveReviewLease): Promise<ProgressiveReviewReply> { return { course: await this.host.snapshot(course), ...(r ? { record: r } : {}), ...(lease ? { lease } : {}) }; }
    async execute(input: ProgressiveReviewCommand, owner: number): Promise<any> {
        this.host.current();
        if (!['review-work', 'review-exit', 'review-activate', 'review-read', 'review-claim', 'review-packet', 'review-result', 'review-finish', 'review-fail', 'review-auxiliary', 'review-acknowledge', 'review-retry', 'review-edit', 'review-completion','review-completion-check'].includes(input.op))
            throw Error('复盘命令无效');
        if (input.op === 'review-work') {
            if (input.projectNoteIds && (!Array.isArray(input.projectNoteIds) || input.projectNoteIds.length > 200 || input.projectNoteIds.some(id => typeof id !== 'string' || !id || id.length > 300)))
                throw Error('复盘恢复范围无效');
            const result = [];
            for (const p of input.projectNoteIds ? [...new Set(input.projectNoteIds)].map(projectNoteId => ({ projectNoteId })) : await this.host.list()) {
                const c = await this.host.read(p.projectNoteId);
                if (!c)
                    continue;
                for (const r of c.reviews || [])
                    if (r.activated !== false && (r.status === 'pending' || r.status === 'running' || (['analyzed', 'saved'].includes(r.status) && ['pending', 'running', 'waiting_knowledge'].includes(r.auxiliary))))
                        result.push({ projectNoteId: c.projectNoteId, reviewId: r.id, environmentId: this.host.environmentId, courseId: c.id });
                if (c.completion?.status === 'ready' && c.completion.activated)
                    result.push({ projectNoteId: c.projectNoteId, completion: true, environmentId: this.host.environmentId, courseId: c.id });
            }
            return result;
        }
        const projectId = 'projectNoteId' in input ? input.projectNoteId : input.lease.projectNoteId;
        progressiveText(projectId, 300, '项目编号');
        await this.host.target(projectId);
        let course = await this.host.read(projectId);
        if (!course)
            throw Error('渐进课程不存在');
        if (input.op === 'review-exit') {
            await this.validateSuccessfulReceipt(course);
            if (input.environmentId !== this.host.environmentId || input.courseId !== course.id)
                throw Error('课程环境已变化');
            progressiveText(input.exitId, 150, '退出提交编号');
            if (typeof input.analyze !== 'boolean' || !Number.isSafeInteger(input.expectedProgressVersion))
                throw Error('退出提交无效');
            if (course.completion?.exitId === input.exitId) {
                const r = (course.reviews || []).find(r => r.id === course!.completion!.reviewId);
                return this.reply(course, r ? await this.read(course, r.id) : undefined);
            }
            if (input.expectedProgressVersion !== course.progress.version)
                throw Error('草稿已更新，请重试退出保存');
            const active = (course.reviews || []).find(r => r.activated !== false && (r.status === 'running' || r.status === 'pending'));
            let r = active ? await this.read(course, active.id) : undefined;
            const textKey = hash({ text: flowReviewContentText(course.progress.restatementDraft) });
            const existing = course.reviews?.find(r => r.textKey === textKey && r.status === 'analyzed');
            const hasStudy = (course.studyPages || []).some(s => s.attempts > 0);
            if (!r && input.analyze && progressiveReviewEligible(course.progress.restatementDraft) && !existing) {
                const rawText = course.progress.restatementDraft, summaryText = course.progress.summaryDraft;
                const id = 'review-' + hash({ course: course.id, textKey });
                const prior = course.reviews?.find(ref => ref.id === id);
                if (prior)
                    r = await this.read(course, id);
                else {
                    if ((course.reviews?.length || 0) >= 128)
                        throw Error('本课程复盘记录已达保存上限，已有原文仍保留');
                    const pageIds = [...new Set([...(course.progress.restatementSpans || []).map(s => s.pageId), course.progress.currentPageId || course.generation.pageId, ...(course.studyPages || []).filter(s => s.attempts > 0).map(s => s.pageId)])];
                    const now = new Date().toISOString();
                    r = { schemaVersion: 1, id, version: 0, activated: false, courseId: course.id, projectNoteId: projectId, rootProjectId: course.rootProjectId, exitId: input.exitId, submittedAt: now, updatedAt: now, status: 'pending', auxiliary: 'pending', textKey, pageIds, parts: 0, completedParts: 0, rawText, summaryText, spans: structuredClone(course.progress.restatementSpans || []), pageRefs: structuredClone((course.pages || []).filter(p => pageIds.includes(p.id))), studyRefs: structuredClone(course.studyPages || []), chunks: splitProgressiveReview(rawText) };
                    r.parts = r.chunks.length;
                }
                r = { ...r, status: 'pending', error: undefined };
                const saved = await this.save(course, r);
                course = saved.course;
                r = saved.record;
            }
            // Answer-only sessions still schedule bounded mastery work, without an empty formal analysis.
            if (!r && hasStudy && input.analyze) {
                const key = hash({ study: course.studyPages?.filter(s => s.attempts > 0).map(s => [s.pageId, s.version]) });
                const id = 'review-' + hash({ course: course.id, answers: key });
                const old = course.reviews?.find(s => s.id === id);
                if (old)
                    r = await this.read(course, id);
                else {
                    const now = new Date().toISOString();
                    r = { schemaVersion: 1, id, version: 0, activated: false, courseId: course.id, projectNoteId: projectId, rootProjectId: course.rootProjectId, exitId: input.exitId, submittedAt: now, updatedAt: now, status: 'saved', auxiliary: 'pending', textKey: key, pageIds: (course.studyPages || []).filter(s => s.attempts > 0).map(s => s.pageId), rawText: '', summaryText: '', spans: [], pageRefs: structuredClone(course.pages || []), studyRefs: structuredClone(course.studyPages || []), chunks: [], parts: 0, completedParts: 0 };
                    const saved = await this.save(course, r);
                    course = saved.course;
                    r = saved.record;
                }
            }
            if (existing) {
                const old = await this.read(course, existing.id);
                course = { ...course, progress: { ...course.progress, ...remainingProgressiveDraft(course.progress, old), version: course.progress.version + 1 } };
            }
            const waiting = Boolean(r && ['pending', 'running'].includes(r.status));
            course = { ...course, completion: { ...progressiveCompletion(await this.completionFacts(course), input.exitId, new Date().toISOString(), waiting), activated: false, ...(r ? { reviewId: r.id } : {}) } };
            await this.host.save(course);
            this.host.changed?.(projectId);
            return this.reply(course, r);
        }
        if (input.op === 'review-activate') {
            if (input.environmentId !== this.host.environmentId || input.courseId !== course.id || course.completion?.exitId !== input.exitId)
                throw Error('退出提交已变化');
            const id = course.completion.reviewId;
            let record = id ? await this.read(course, id) : undefined;
            course = { ...course, completion: { ...course.completion, activated: true } };
            if (record && !record.activated) {
                const saved = await this.save(course, { ...record, activated: true });
                course = saved.course;
                record = saved.record;
            }
            else {
                await this.host.save(course);
                this.host.changed?.(projectId);
            }
            return this.reply(course, record);
        }
        if (input.op === 'review-completion'||input.op === 'review-completion-check') {
            await this.validateSuccessfulReceipt(course);
            if (input.environmentId !== this.host.environmentId || input.courseId !== course.id || course.completion?.exitId !== input.exitId)
                throw Error('完成回执已变化');
            if (!course.completion.activated || course.completion.status !== 'ready' && course.completion.status !== 'committed')
                throw Error('本项目尚不满足完成条件');
            if(progressiveCompletion(await this.completionFacts(course),input.exitId,course.completion.requestedAt).reason!=='eligible')throw Error('主线或提交事实已变化，未自动完成');
            if(input.op==='review-completion-check')return this.reply(course);
            course = { ...course, completion: { ...course.completion, status: 'committed' } };
            await this.host.save(course);
            this.host.changed?.(projectId);
            return this.reply(course);
        }
        const reviewId = 'reviewId' in input ? input.reviewId : input.lease.reviewId;
        let r = await this.read(course, reviewId);
        if (input.op === 'review-read') {
            if (input.auxiliary)
                return r.auxiliaryHash ? this.blob(course, r, 'aux', r.auxiliaryHash) : null;
            if (input.partId) {
                const part = r.chunks.find(p => p.id === input.partId);
                if (!part?.resultHash)
                    return null;
                return this.blob(course, r, part.id, part.resultHash);
            }
            return r;
        }
        if (input.op === 'review-edit') {
            progressiveText(input.text, 100000, '归档编辑', true);
            if (input.expectedVersion !== r.version)
                throw Error('记录已更新，请重新打开');
            const saved = await this.save(course, { ...r, editedText: input.text });
            return this.reply(saved.course, saved.record);
        }
        if (input.op === 'review-retry') {
            if (this.leases.has(this.key(projectId, r.id)))
                return this.reply(course, r);
            const saved = await this.save(course, { ...r, activated: true, status: r.status === 'failed' ? 'pending' : r.status, error: undefined, auxiliary: r.auxiliary === 'failed' ? 'pending' : r.auxiliary, auxiliaryError: undefined });
            return this.reply(saved.course, saved.record);
        }
        if (input.op === 'review-claim') {
            if (r.activated === false)
                throw Error('退出保存尚未完成，不启动分析');
            const key = this.key(projectId, r.id), old = this.leases.get(key);
            if (old)
                return { ...await this.reply(course, r), running: true };
            const lease = { environmentId: this.host.environmentId, projectNoteId: projectId, courseId: course.id, reviewId: r.id, token: randomUUID(), owner };
            const saved = await this.save(course, { ...r, status: r.status === 'pending' || r.status === 'running' ? 'running' : r.status, auxiliary: r.status === 'analyzed' || r.status === 'saved' ? 'running' : r.auxiliary });
            this.leases.set(key, lease);
            return this.reply(saved.course, saved.record, lease);
        }
        const lease = this.lease(input as {
            lease: ProgressiveReviewLease;
        }, owner, course);
        if (input.op === 'review-packet')
            return this.packet(course, r, input.partId);
        if (input.op === 'review-result') {
            const part = r.chunks.find(p => p.id === input.partId);
            if (!part)
                throw Error('分析分段不存在');
            const result = input.result, source = result?.analysisV2?.record?.input;
            if (result?.analysisV2?.schemaVersion !== 2 || result.analysisV2.analysisRunId !== `${r.id}:${part.id}` || source?.attemptId !== `${r.id}:${part.id}` || source.rawText !== r.rawText.slice(part.start, part.end) || !Array.isArray(result.report?.sections))
                throw Error('分析结果与本次原文版本不一致');
            const key = hash(result);
            if (part.resultHash) {
                if (part.resultHash !== key)
                    throw Error('该分段已经保存，未用迟到结果覆盖');
                return this.reply(course, r, lease);
            }
            await this.host.write(await this.file(projectId, `${r.id}.${part.id}.${key}.json`), result, 2500000);
            const chunks = r.chunks.map(p => p.id === part.id ? { ...p, resultHash: key } : p);
            const saved = await this.save(course, { ...r, chunks, completedParts: chunks.filter(p => p.resultHash).length });
            return this.reply(saved.course, saved.record, lease);
        }
        if (input.op === 'review-finish') {
            if (!r.chunks.length || r.chunks.some(p => !p.resultHash))
                throw Error('主分析分段尚未全部完成');
            if (r.status !== 'analyzed') {
                course = { ...course, lastSuccessfulReview: { reviewId: r.id, textKey: r.textKey, completedAt: new Date().toISOString() }, progress: { ...course.progress, ...remainingProgressiveDraft(course.progress, r), version: course.progress.version + 1 } };
                const pending = course.completion;
                if (pending?.reviewId === r.id&&pending.status!=='committed')
                    course.completion = { ...progressiveCompletion(await this.completionFacts(course), pending.exitId, pending.requestedAt), activated: pending.activated, reviewId: r.id };
                const saved = await this.save(course, { ...r, status: 'analyzed', error: undefined, auxiliary: 'pending' });
                course = saved.course;
                r = saved.record;
            }
            return this.reply(course, r, lease);
        }
        if (input.op === 'review-fail') {
            progressiveText(input.error, 1400, '分析状态');
            const auxiliary = input.auxiliary || r.status === 'analyzed' || r.status === 'saved';
            if (!auxiliary && course.completion?.reviewId === r.id&&course.completion.status!=='committed') {
                const old = course.completion;
                course = { ...course, completion: { ...progressiveCompletion(await this.completionFacts(course), old.exitId, old.requestedAt), reviewId: r.id, activated: old.activated } };
            }
            const saved = await this.save(course, { ...r, ...(auxiliary ? { auxiliary: 'failed' as const, auxiliaryError: input.error } : { status: 'failed' as const, error: input.error }) });
            this.leases.delete(this.key(projectId, r.id));
            return this.reply(saved.course, saved.record);
        }
        if (input.op === 'review-auxiliary') {
            if (!['analyzed', 'saved'].includes(r.status))
                throw Error('请先完成主分析');
            const value = input.result;
            if (value?.schemaVersion !== 1 || !Array.isArray(value.mastery) || value.mastery.length > 300 || typeof value.pendingKnowledge !== 'boolean')
                throw Error('掌握度回执无效');
            const packet = await this.packet(course, r);
            const ids = new Set(packet.materials.flatMap(m => m.knowledgeIds));
            for (const row of value.mastery)
                if (!ids.has(row.input?.knowledgePointId) || row.id !== row.input.evaluationId)
                    throw Error('知识点对象尚未建立或回执不属于本课程');
            const key = hash(value);
            await this.host.write(await this.file(projectId, `${r.id}.aux.${key}.json`), value, 2500000);
            const saved = await this.save(course, { ...r, auxiliaryHash: key, auxiliaryApplied: false });
            return this.reply(saved.course, saved.record, lease);
        }
        if (input.op === 'review-acknowledge') {
            if (input.auxiliaryHash !== r.auxiliaryHash)
                throw Error('辅助处理版本已变化');
            const value = await this.blob(course, r, 'aux', r.auxiliaryHash!) as ProgressiveAuxiliaryResult;
            const auxiliary = value.pendingKnowledge ? 'waiting_knowledge' : value.mastery.some(m => m.error) ? 'failed' : 'ready';
            const saved = await this.save(course, { ...r, auxiliaryApplied: true, auxiliary, auxiliaryError: auxiliary === 'failed' ? '部分知识点评价未完成，可重试失败项' : undefined });
            this.leases.delete(this.key(projectId, r.id));
            return this.reply(saved.course, saved.record);
        }
        throw Error('复盘请求无效');
    }
}

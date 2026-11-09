import type { NoteItem, FlowSession } from '../../types';
import type { ProgressiveReviewCommand, ProgressiveReviewReply, ProgressiveReviewWork, ProgressiveReviewPacket, ProgressiveReviewRecord, ProgressiveReviewLease, ProgressiveAuxiliaryResult, ProgressiveMasteryReceipt, ProgressiveReviewSelectionReply, ProgressiveReviewSelectionCandidate } from './reviewTypes';
import type { ProgressiveCourse } from './types';
import type { FlowAnalysisV2Bundle } from '../flowAnalysis/productionV2';
import { progressiveReviewCommand, onProgressiveChange } from './reviewClient';
import { analyzeProgressivePart, progressiveMasteryInputs, evaluateProgressiveMastery, prepareProgressiveMasteryNotes, progressiveAnalysisModel } from './reviewAnalysis';
import { getProjectCompletionTarget, setLearningCompletion } from '../learningCompletion';
import { callLLM } from '../llmService';
import { saveEpisodeWithProfileEvidence } from '../memory/profileWriteback';
import { extractFlowEvidence } from '../memory/evidenceExtractor';
import { buildFlowStatisticsSubmission } from '../flowAnalysis/postStatistics';
import { progressiveCognitionSourceKey } from './reviewCognitionSource';
import { getKnowledgeLifecycle, knowledgeDestination, knowledgeDisposition } from '../knowledgeLifecycle';
import { flowMasteryTextKey } from '../masteryShadow/sourceKey';
interface Host {
    readNotes(): NoteItem[];
    persist(prepare: (notes: NoteItem[]) => NoteItem[]): Promise<void>;
    command?<T = any>(input: ProgressiveReviewCommand): Promise<T>;
    loadCourse?(projectId: string): Promise<ProgressiveCourse | null>;
    analyze?(packet: ProgressiveReviewPacket): Promise<FlowAnalysisV2Bundle>;
    evaluate?: typeof evaluateProgressiveMastery;
    profile?(record: ProgressiveReviewRecord, parts: FlowAnalysisV2Bundle[]): Promise<void>;
    cognition?(record: ProgressiveReviewRecord, parts: FlowAnalysisV2Bundle[], title: string, assertCurrent: () => Promise<void>): Promise<void>;
    onError?(error: unknown): void;
}
export async function persistProgressiveProfile(record: ProgressiveReviewRecord, parts: FlowAnalysisV2Bundle[],
    isCurrent: () => boolean | Promise<boolean> = () => true) {
    for (const part of parts) {
        const episodeId = part.analysisV2.analysisRunId;
        const evidence = extractFlowEvidence({ episodeId, observedAt: part.analysisV2.observedAt, report: part.report, profileInsight: part.profileInsight, analysisV2: part.analysisV2 });
        const text = part.analysisV2.record.input.rawText;
        const statistics = buildFlowStatisticsSubmission(part.analysisV2, episodeId, text);
        await saveEpisodeWithProfileEvidence({ id: episodeId, type: 'flow', status: 'completed', title: '心流复盘', noteId: record.projectNoteId, rootProjectId: record.rootProjectId, startedAt: record.submittedAt, endedAt: record.updatedAt, durationSeconds: 0, summary: part.report.summary, recommendation: part.report.recommendation, evidenceSnippets: evidence.evidenceSnippets, profileSignals: evidence.profileSignals, flowStatistics: statistics, createdAt: record.submittedAt, updatedAt: record.updatedAt }, text.length, isCurrent);
    }
}
/** One queue per renderer host; no model call is awaited by Exit and Save. Durable leases arbitrate duplicate hosts. */
export class ProgressiveReviewWorker {
    private alive = true;
    private running: Promise<void> | null = null;
    private requested = false;
    private activeProject: string | null = null;
    private projectIds = new Set<string>();
    private fullScan = false;
    private completionRequested = new Set<string>();
    private completionScan: Promise<void> | null = null;
    private completing = new Map<string, Promise<void>>();
    /** Stable input coordinates, not metadata versions emitted by this worker's own writes. */
    private settledWork = new Map<string, string>();
    private abort = new AbortController();
    private unsubscribe: (() => void) | null = null;
    private command: NonNullable<Host['command']>;
    private load: NonNullable<Host['loadCourse']>;
    constructor(private host: Host) { this.command = host.command || progressiveReviewCommand; this.load = host.loadCourse || (async (id) => (await import('./client')).loadProgressiveCourse(id)); }
    start() { this.unsubscribe = onProgressiveChange((id, reason) => {
        // Auxiliary model work must not hide a newer exit's completion signal.
        if (id === this.activeProject && reason !== 'knowledge') {
            this.requestCompletion(id);
            // A source edit can revoke this worker while a native cognition
            // write is queued. Recheck pending work once after it unwinds.
            this.projectIds.add(id); this.requested = true;
        }
        else this.kick(id);
    }); this.kick(); return this; }
    stop() { this.alive = false; this.abort.abort(); this.unsubscribe?.(); }
    kick(projectId?: string) { if (!this.alive)
        return; if (projectId)
        { this.projectIds.add(projectId); this.requestCompletion(projectId); }
    else
        this.fullScan = true; this.requested = true; if (this.running)
        return; this.running = this.drain().finally(() => { this.running = null; if (this.requested && this.alive)
        this.kickPending(); }); }
    private kickPending() { this.requested = true; if (!this.running)
        this.running = this.drain().finally(() => { this.running = null; if (this.requested && this.alive)
            this.kickPending(); }); }
    async idle() { while (this.running || this.completionScan) await Promise.all([this.running, this.completionScan]); }
    private requestCompletion(projectId: string) {
        if (!this.alive) return;
        this.completionRequested.add(projectId);
        if (this.completionScan) return;
        this.completionScan = this.drainCompletions().finally(() => {
            this.completionScan = null;
            const next = this.completionRequested.values().next().value;
            if (next && this.alive) this.requestCompletion(next);
        });
    }
    private async drainCompletions() {
        while (this.completionRequested.size && this.alive) {
            const ids = [...this.completionRequested]; this.completionRequested.clear();
            for (const projectNoteId of ids) {
                try {
                    const course = await this.load(projectNoteId);
                    if (this.alive && course?.completion?.status === 'ready' && course.completion.activated)
                        await this.complete({ projectNoteId, environmentId: course.environmentId, courseId: course.id, completion: true });
                } catch (error) { this.host.onError?.(error); }
            }
        }
    }
    private async current(lease: Pick<ProgressiveReviewLease, 'projectNoteId' | 'environmentId' | 'courseId'>) { if (!this.alive)
        throw Error('复盘处理已停止'); const c = await this.load(lease.projectNoteId); if (!c || c.id !== lease.courseId || c.environmentId !== lease.environmentId)
        throw Error('资料库已变化，旧复盘未写入'); return c; }
    private async drain() {
        while (this.requested && this.alive) {
            this.requested = false;
            let jobs: ProgressiveReviewWork[];
            try {
                const projectNoteIds = this.fullScan ? undefined : [...this.projectIds];
                this.fullScan = false;
                this.projectIds.clear();
                jobs = await this.command({ op: 'review-work', ...(projectNoteIds ? { projectNoteIds } : {}) });
            }
            catch (error) {
                this.host.onError?.(error);
                return;
            }
            // On startup too, ready completions precede slow recovered analyses.
            jobs.sort((a, b) => Number(Boolean(b.completion)) - Number(Boolean(a.completion)));
            for (const job of jobs) {
                if (!this.alive)
                    return;
                this.activeProject = job.projectNoteId;
                try {
                    if (job.completion)
                        await this.complete(job);
                    else if (job.reviewId)
                        await this.run(job);
                }
                catch (error) {
                    this.host.onError?.(error);
                }
                finally {
                    this.activeProject = null;
                }
            }
        }
    }
    private complete(job: ProgressiveReviewWork): Promise<void> {
        const key = JSON.stringify([job.environmentId, job.courseId, job.projectNoteId]);
        const previous = this.completing.get(key);
        if (previous) return previous;
        const pending = this.commitCompletion(job).finally(() => this.completing.delete(key));
        this.completing.set(key, pending);
        return pending;
    }
    private async commitCompletion(job: ProgressiveReviewWork) {
        const course = await this.current({ ...job, courseId: job.courseId });
        if (course.completion?.status !== 'ready' || !course.completion.activated)
            return;
        await this.command({op:'review-completion-check',projectNoteId:job.projectNoteId,courseId:job.courseId,environmentId:job.environmentId,exitId:course.completion.exitId});
        // This deliberately ignores the launching execution-task binding, including recurring tasks.
        await this.host.persist(notes => { const target = getProjectCompletionTarget(notes, job.projectNoteId); if (!target)
            throw Error('当前叶子项目计划已变化，未修改其他任务'); return setLearningCompletion(notes, target, true); });
        await this.current(job);
        await this.command({ op: 'review-completion', projectNoteId: job.projectNoteId, courseId: job.courseId, environmentId: job.environmentId, exitId: course.completion.exitId });
    }
    private async run(job: ProgressiveReviewWork) {
        const workId = JSON.stringify([job.environmentId, job.courseId, job.projectNoteId, job.reviewId]);
        const selection = await this.command<ProgressiveReviewSelectionReply>({ op: 'review-selection-read', projectNoteId: job.projectNoteId, reviewId: job.reviewId! });
        if (selection.course.id !== job.courseId || selection.course.environmentId !== job.environmentId) throw Error('复盘所属课程已变化');
        if (selection.record.cognitionWithdrawalPending) {
            await this.command({ op: 'review-cognition-withdraw', projectNoteId: job.projectNoteId, reviewId: job.reviewId! });
            return;
        }
        const knowledgeKey = this.knowledgeKey(selection.candidates);
        if (this.settledWork.get(workId) === this.inputKey(selection.record, knowledgeKey)) return;
        const claim = await this.command<ProgressiveReviewReply>({ op: 'review-claim', projectNoteId: job.projectNoteId, reviewId: job.reviewId! });
        const lease = claim.lease;
        if (!lease || claim.running)
            return;
        let record = claim.record!;
        let mainFinished = ['analyzed', 'saved'].includes(record.status);
        try {
            if (!mainFinished) {
                for (const part of record.chunks) {
                    if (part.resultHash)
                        continue;
                    await this.current(lease);
                    const packet = await this.command<ProgressiveReviewPacket>({ op: 'review-packet', lease, partId: part.id });
                    const result = await (this.host.analyze ? this.host.analyze(packet) : analyzeProgressivePart(packet, progressiveAnalysisModel((request) => callLLM(request, { signal: this.abort.signal }))));
                    await this.current(lease);
                    const reply = await this.command<ProgressiveReviewReply>({ op: 'review-result', lease, partId: part.id, result });
                    record = reply.record!;
                }
                const finished = await this.command<ProgressiveReviewReply>({ op: 'review-finish', lease });
                record = finished.record!;
                mainFinished = true;
            }
            // Completion and primary success never depend on graph display/profile/mastery writes.
            try {
                await this.complete(job);
            }
            catch (error) {
                this.host.onError?.(error);
            }
            await this.current(lease);
            let previous = await this.command<ProgressiveAuxiliaryResult | null>({ op: 'review-read', projectNoteId: job.projectNoteId, reviewId: record.id, auxiliary: true });
            const receipts = new Map<string, ProgressiveMasteryReceipt>((previous?.mastery || []).map(r => [r.id, r]));
            let pendingKnowledge = false;
            const packets: ProgressiveReviewPacket[] = [];
            for (const part of record.chunks)
                packets.push(await this.command({ op: 'review-packet', lease, partId: part.id }));
            packets.push(await this.command({ op: 'review-packet', lease }));
            for (const packet of packets) {
                const work = progressiveMasteryInputs(packet, this.host.readNotes());
                pendingKnowledge ||= work.pendingKnowledge;
                for (const input of work.inputs) {
                    const prior = receipts.get(input.evaluationId);
                    if (prior?.result || prior && (prior.retryRevision || 0) === (record.retryRevision || 0))
                        continue;
                    // Already applied first/retake answers retain stable IDs across subsequent exit snapshots.
                    if (input.source === 'quick_check' && this.host.readNotes().find(n => n.id === input.knowledgePointId)?.dsrState?.masteryShadow?.appliedObservationIds.some(id => id.startsWith(input.evaluationId + ':')))
                        continue;
                    await this.current(lease);
                    const row = await (this.host.evaluate || ((input) => evaluateProgressiveMastery(input, request => callLLM(request, { signal: this.abort.signal }))))(input);
                    receipts.set(row.id, { ...row, retryRevision: record.retryRevision || 0 });
                    if (receipts.size > 300)
                        throw Error('本次知识点处理超过分批上限，主分析与已保存记录仍保留');
                    await this.current(lease);
                    const checkpoint = await this.command<ProgressiveReviewReply>({ op: 'review-auxiliary', lease, result: { schemaVersion: 1, mastery: [...receipts.values()], pendingKnowledge } });
                    record = checkpoint.record!;
                }
            }
            const value: ProgressiveAuxiliaryResult = { schemaVersion: 1, mastery: [...receipts.values()], pendingKnowledge };
            const ready = await this.command<ProgressiveReviewReply>({ op: 'review-auxiliary', lease, result: value });
            record = ready.record!;
            await this.current(lease);
            await this.host.persist(notes => prepareProgressiveMasteryNotes(notes, record.id, value.mastery));
            const parts: FlowAnalysisV2Bundle[] = [];
            for (const part of record.chunks) {
                const result = await this.command<FlowAnalysisV2Bundle | null>({ op: 'review-read', projectNoteId: job.projectNoteId, reviewId: record.id, partId: part.id });
                if (result)
                    parts.push(result);
            }
            if (this.host.profile) await this.host.profile(record, parts);
            else await persistProgressiveProfile(record, parts, async () => { await this.current(lease); return true; });
            await this.current(lease);
            // Personal beliefs are committed only by the explicit foreground
            // confirmation command, never by auxiliary work or restart recovery.
            await this.current(lease);
            const acknowledged = await this.command<ProgressiveReviewReply>({ op: 'review-acknowledge', lease, auxiliaryHash: record.auxiliaryHash! });
            record = acknowledged.record!;
        }
        catch (error) {
            if (!this.alive)
                return;
            try {
                await this.current(lease);
                const failed = await this.command<ProgressiveReviewReply>({ op: 'review-fail', lease, auxiliary: mainFinished, error: (error instanceof Error ? error.message : '复盘暂未完成').slice(0, 1400) });
                record = failed.record!;
                if (!mainFinished)
                    await this.complete(job);
            }
            catch { }
            this.host.onError?.(error);
        }
        finally {
            // Preserve the exact source/knowledge observed by THIS attempt. An
            // edit or a newly available object arriving during the run differs
            // from this key and can resume once after the old lease unwinds.
            this.settledWork.set(workId, this.inputKey(record, knowledgeKey));
        }
    }
    private inputKey(record: ProgressiveReviewRecord, knowledgeKey: string): string {
        return flowMasteryTextKey(JSON.stringify([progressiveCognitionSourceKey(record), record.analysisSelection || null,
            record.retryRevision || 0, knowledgeKey]));
    }
    private knowledgeKey(candidates: ProgressiveReviewSelectionCandidate[]): string {
        const lifecycle = getKnowledgeLifecycle(), notes = new Map(this.host.readNotes().filter(note => note.noteType === 'knowledge').map(note => [note.id, note]));
        return JSON.stringify(candidates.map(candidate => {
            const disposition = knowledgeDisposition(lifecycle, undefined, candidate.title);
            const ids = [...new Set([...candidate.knowledgeIds, ...(disposition ? [disposition.id] : [])])].sort();
            return [candidate.key, ids.map(id => {
                const destination = knowledgeDestination(lifecycle, id), note = destination && notes.get(destination);
                return [id, destination || null, note ? [note.id, note.title, [...(note.aliases || [])].sort()] : null];
            })];
        }).sort(([left], [right]) => String(left).localeCompare(String(right))));
    }
}

import type { NoteItem, LlmCallRequest, LlmCallResponse } from '../../types';
import { getKnowledgeLifecycle, knowledgeDestination, knowledgeDisposition, migratedKnowledge } from '../knowledgeLifecycle';
import type { ProgressiveReviewPacket, ProgressiveMasteryReceipt } from './reviewTypes';
import { runProductionFlowAnalysisV2, type FlowAnalysisV2Bundle } from '../flowAnalysis/productionV2';
import type { ShadowReferenceProvider } from '../flowShadow/references';
import type { ShadowModel, ShadowRequest } from '../flowShadow/runner';
import type { ShadowReferenceCandidate } from '../flowShadow/types';
import { callLLM } from '../llmService';
import { JSON_OBJECT_OUTPUT } from '../../workflows/structuredOutput';
import { flowReviewMaxTokens } from '../flowAnalysis/modelBudgets';
import { MASTERY_SHADOW_CRITERIA } from '../masteryShadow/rubric';
import { MASTERY_SHADOW_LAYERS, type MasteryShadowObservation } from '../masteryShadow/types';
import { buildMasteryShadowEvaluationRequest, parseMasteryShadowEvaluation, type MasteryShadowReferenceItem, type MasteryShadowEvaluationInput } from '../masteryShadow/evaluator';
import { applyMasteryShadowObservations } from '../masteryShadow/stateMachine';
import { progressiveReviewConceptKey } from './reviewSelection';
const compact = (s: string, n: number) => s.slice(0, n);
const tokens = (s: string) => new Set(s.normalize('NFKC').toLocaleLowerCase().match(/[a-z][\w-]+|[\p{Script=Han}]{2}/gu) || []);
/** Page-local literal retrieval, independent of RAG readiness; no siblings or external readers exist here. */
export function progressiveReviewReferences(packet: ProgressiveReviewPacket): ShadowReferenceProvider {
    const segments = packet.materials.flatMap(({ page, hash }) => {
        const texts = [...page.body.split(/\n\s*\n/u), ...(page.concepts || []).map(c => c.summary), ...(page.questions || []).map(q => q.referenceQuote)];
        return texts.filter((text): text is string => typeof text === 'string' && Boolean(text.trim())).flatMap((text, i) => Array.from({ length: Math.ceil(text.length / 1800) }, (_, j) => ({ text: text.slice(j * 1800, (j + 1) * 1800), pageId: page.id, title: page.title, locator: `${page.id} ${hash.slice(0, 12)} 段${i + 1}.${j + 1}` })));
    });
    return { async retrieve(_input, _graph, targets) {
            const result: ShadowReferenceCandidate[] = [];
            for (const target of targets) {
                const query = tokens(target.query);
                const ranked = segments.map((s, i) => ({ ...s, i, score: [...tokens(s.text)].filter(t => query.has(t)).length })).sort((a, b) => b.score - a.score || a.i - b.i);
                const picked = ranked.find(s => s.score > 0);
                if (!picked)
                    continue;
                result.push({ id: `PR-${target.id}`, targetId: target.id, tier: 1, sourceType: 'project_textbook', sourceId: packet.record.courseId + ':' + picked.pageId, title: picked.title, locator: picked.locator, relation: 'other', availability: 'available', text: picked.text, similarity: Math.min(1, picked.score / Math.max(1, query.size)) });
            }
            return result;
        } };
}
export function progressiveAnalysisModel(call = (request: LlmCallRequest, signal?: AbortSignal) => callLLM(request, { signal })): ShadowModel {
    return { async call(request: Readonly<ShadowRequest>, signal) { const result = await call({ providerId: '', model: '', workflow: 'flow-analysis', userInput: request.userInput, systemPromptOverride: request.systemPrompt, outputSchema: JSON_OBJECT_OUTPUT, temperatureOverride: 0.1, maxTokensOverride: flowReviewMaxTokens(request.stage), thinkingMode: 'disabled', skipMemoryInjection: true, skipProfileInjection: true }, signal); return { content: result.content, usage: result.usage }; } };
}
export async function analyzeProgressivePart(packet: ProgressiveReviewPacket, model?: ShadowModel): Promise<FlowAnalysisV2Bundle> {
    if (!packet.part)
        throw Error('缺少复盘分段');
    return runProductionFlowAnalysisV2({ speakingContent: packet.text, noteId: packet.record.projectNoteId, noteTitle: '本次学习复盘', analysisRunId: `${packet.record.id}:${packet.part.id}`, allNotes: [] }, [], undefined, { model: model || progressiveAnalysisModel(), referenceProvider: progressiveReviewReferences(packet) });
}
const sameName = (s: string) => s.normalize('NFKC').trim().toLocaleLowerCase();
export function progressiveMasteryInputs(packet: ProgressiveReviewPacket, notes: NoteItem[]): {
    inputs: MasteryShadowEvaluationInput[];
    pendingKnowledge: boolean;
} {
    const inputs: MasteryShadowEvaluationInput[] = [];
    let pendingKnowledge = false;
    for (const { page, hash, knowledgeIds } of packet.materials) {
        if (!packet.part && !packet.attempts.some(row => row.pageId === page.id)) continue;
        // User selection applies only to the archived restatement. Submitted
        // page questions keep their own original concept bindings.
        const chosen = packet.part && packet.record.analysisSelection?.status === 'confirmed'
            ? new Set(packet.record.analysisSelection.conceptKeys) : null;
        const concepts = (page.concepts || []).filter(concept => !chosen || chosen.has(progressiveReviewConceptKey(concept.title)));
        if (packet.part && !concepts.length) continue;
        const lifecycle = getKnowledgeLifecycle();
        if (concepts.some(c => !knowledgeDisposition(lifecycle, undefined, c.title)) && !knowledgeIds.length)
            pendingKnowledge = true;
        for (const knowledgeId of [...new Set(knowledgeIds.map(id => knowledgeDestination(lifecycle, id)).filter((id): id is string => Boolean(id)))]) {
            const note = notes.find(n => n.id === knowledgeId && n.noteType === 'knowledge');
            if (!note) {
                pendingKnowledge = true;
                continue;
            }
            const conceptsForNote = concepts.filter(c => [note.title, ...(note.aliases || [])].some(t => sameName(t) === sameName(c.title)) || migratedKnowledge(c.title, notes)?.id === note.id);
            if (!conceptsForNote.length)
                continue;
            const references:MasteryShadowReferenceItem[] = conceptsForNote.map((c, i) => ({ id: `P-${page.id}-${i}`, tier: 1 as const, sourceId: packet.record.courseId + ':' + page.id, sourceLabel: page.title, quote: compact(c.summary, 2000), sourceRole: 'primary' as const, criterionIds: MASTERY_SHADOW_CRITERIA.map(c => c.id), layers: [...MASTERY_SHADOW_LAYERS] }));
            const topic=tokens(note.title+' '+conceptsForNote.map(c=>c.summary).join(' '));
            const teaching=page.body.split(/\n\s*\n/u).map((text,index)=>({text,index,score:[...tokens(text)].filter(t=>topic.has(t)).length})).filter(p=>p.score>0).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,2);
            for(const segment of teaching)references.push({id:`B-${page.id}-${segment.index}`,tier:1,sourceId:packet.record.courseId+':'+page.id,sourceLabel:page.title,quote:segment.text.slice(0,2000),sourceRole:'supplement',criterionIds:MASTERY_SHADOW_CRITERIA.map(c=>c.id),layers:[...MASTERY_SHADOW_LAYERS]});
            if (packet.part && packet.text.trim())
                inputs.push({ evaluationId: `pm:${packet.record.id}:${packet.part.id}:${knowledgeId}`, knowledgePointId: knowledgeId, knowledgePointTitle: note.title, occurredAt: packet.record.submittedAt, source: 'flow_review', assistance: 'independent', strength: 'natural', task: { evaluationMode: 'natural_recall', referenceContract: 'criterion-scope-v3', confirmationPolicy: 'open-demonstration-v1', prompt: `只评价本段实际展示的“${note.title}”，未展开的层次不算错。`, responseType: 'open', requiredLayers: [...MASTERY_SHADOW_LAYERS], criterionIds: MASTERY_SHADOW_CRITERIA.map(c => c.id) }, answer: packet.text, references });
            if (!packet.part) {
                const rows = packet.attempts.filter(a => a.pageId === page.id && a.attempt.pageHash === hash && !a.disputed && a.attempt.question.conceptKeys.some(key => conceptsForNote.some(c => c.key === key)));
                for (const row of rows) {
                    const earlier = packet.attempts.slice(0, packet.attempts.indexOf(row)).some(a => a.pageId === page.id && a.attempt.questionId === row.attempt.questionId);
                    const q = row.attempt.question;
                    const answer = row.attempt.answer.optionId ? q.options?.find(o => o.id === row.attempt.answer.optionId)?.text || row.attempt.answer.optionId : row.attempt.answer.text;
                    // Never infer evidence from an ungraded answer or from generated reference answers.
                    if (!row.attempt.judgment || row.attempt.judgment.outcome === 'unverifiable')
                        continue;
                    // This optional teaching hint is not a fabricated reference when absent.
                    const questionReferences: MasteryShadowReferenceItem[] = typeof q.referenceQuote === 'string' && q.referenceQuote.trim()
                        ? [{ id: `Q-${q.id}`, tier: 1, sourceId: packet.record.courseId + ':' + page.id, sourceLabel: page.title, quote: q.referenceQuote, sourceRole: 'supplement', criterionIds: MASTERY_SHADOW_CRITERIA.map(c => c.id), layers: [...MASTERY_SHADOW_LAYERS] }] : [];
                    inputs.push({ evaluationId: `pq:${row.attempt.id}:${knowledgeId}`, knowledgePointId: knowledgeId, knowledgePointTitle: note.title, occurredAt: row.attempt.submittedAt, source: 'quick_check', assistance: row.attempt.assistance || (earlier || row.explanationViewed ? 'assisted' : 'independent'), strength: 'natural', task: { evaluationMode: 'direct_test', referenceContract: 'criterion-scope-v3', confirmationPolicy: 'open-demonstration-v1', prompt: q.prompt, responseType: q.kind === 'choice' ? 'choice' : q.kind === 'judgment' ? 'true_false' : 'application', requiredLayers: [...MASTERY_SHADOW_LAYERS], criterionIds: MASTERY_SHADOW_CRITERIA.map(c => c.id) }, answer, references: [...references, ...questionReferences] });
                }
            }
        }
    }
    return { inputs, pendingKnowledge };
}
export async function evaluateProgressiveMastery(input: MasteryShadowEvaluationInput, call = (request: LlmCallRequest) => callLLM(request)): Promise<ProgressiveMasteryReceipt> {
    try {
        const request = buildMasteryShadowEvaluationRequest(input);
        const response = await call({ providerId: '', model: '', workflow: 'knowledge-mastery-scoring', userInput: request.userInput, systemPromptOverride: request.systemPrompt, outputSchema: JSON_OBJECT_OUTPUT, maxTokensOverride: 7000, temperatureOverride: 0, thinkingMode: 'disabled', skipMemoryInjection: true, skipProfileInjection: true });
        return { id: input.evaluationId, input, result: parseMasteryShadowEvaluation(response.content, input) };
    }
    catch (error) {
        return { id: input.evaluationId, input, error: error instanceof Error ? error.message : '知识点评价暂未完成' };
    }
}
/** One natural observation per review and layer, even when the same idea spans many chunks. */
export function prepareProgressiveMasteryNotes(notes: NoteItem[], reviewId: string, receipts: ProgressiveMasteryReceipt[]): NoteItem[] {
    const grouped = new Map<string, Map<string, MasteryShadowObservation>>();
    for (const row of receipts) {
        if (!row.result)
            continue;
        const checked = parseMasteryShadowEvaluation(row.result, row.input);
        let observations = grouped.get(row.input.knowledgePointId);
        if (!observations)
            grouped.set(row.input.knowledgePointId, observations = new Map());
        for (const original of checked.observations) {
            const layer = original.results[0]?.layer;
            if (!layer)
                continue;
            const id = row.input.source === 'flow_review' ? `pm:${reviewId}:${row.input.knowledgePointId}:${layer}` : original.id;
            const observation = { ...original, id };
            const prior = observations.get(id);
            if (prior && row.input.source === 'flow_review') {
                const criteria = new Map(prior.results.flatMap(r => r.criterionResults || []).map(c => [c.id, c]));
                for (const c of original.results.flatMap(r => r.criterionResults || []))
                    if (!['not_observed', 'not_applicable', 'unverifiable'].includes(c.verdict))
                        criteria.set(c.id, c);
                const values = [...criteria.values()];
                const verdict = values.some(c => c.verdict === 'fail') ? 'fail' : values.some(c => c.verdict === 'partial') ? 'partial' : values.some(c => c.verdict === 'pass') ? 'pass' : 'not_observed';
                observation.results = [{ ...original.results[0], verdict, criterionIds: values.map(c => c.id), criterionResults: values, userEvidenceIds: [...new Set(values.flatMap(c => c.userEvidenceIds))], referenceIds: [...new Set(values.flatMap(c => c.referenceIds))] }];
            }
            observations.set(id, observation);
        }
    }
    const next = notes.map(note => {
        const observations = grouped.get(note.id);
        if (note.noteType !== 'knowledge' || !observations)
            return note;
        const state = applyMasteryShadowObservations(note.dsrState?.masteryShadow, [...observations.values()]);
        if (JSON.stringify(state) === JSON.stringify(note.dsrState?.masteryShadow))
            return note;
        return { ...note, dsrState: { difficulty: 5, stability: 2, lastReviewedAt: null, reviewCount: 0, consecutiveCorrect: 0, consecutiveWrong: 0, ...note.dsrState, masteryShadow: state } };
    });
    return next.every((note, i) => note === notes[i]) ? notes : next;
}

import type { KnowledgePointCandidate, KnowledgePointMasteryResult, NoteItem } from '../../types';
import { callLLM } from '../llmService';
import { JSON_OBJECT_OUTPUT } from '../../workflows/structuredOutput';
import { findNotesByTitleOrAlias, resolveNoteByTitleOrAlias } from '../noteResolver';
import { createFlowReferenceProvider, type FlowReferenceReaders } from '../flowAnalysis/referenceProvider';
import type { ShadowGraph, ShadowInput, ShadowReferenceTarget } from '../flowShadow/types';
import { MASTERY_SHADOW_CRITERIA } from './rubric';
import { buildMasteryShadowEvaluationRequest, parseMasteryShadowEvaluation,
  type MasteryShadowEvaluationCall, type MasteryShadowEvaluationInput,
  type MasteryShadowEvaluationResult, type MasteryShadowReferenceItem } from './evaluator';
import { applyMasteryShadowObservations, createMasteryShadowState, effectiveMasteryShadowState } from './stateMachine';
import { MASTERY_SHADOW_LAYERS, type MasteryShadowState, type MasteryShadowPresentation } from './types';
import { flowMasteryTextKey } from './sourceKey';
import { masteryLayerAssessment } from './presentation';
import { readKnowledgeMastery } from '../masteryReadModel';
import { masteryCriterionQuery, masteryTopicContext } from './referenceFocus';
import { primaryMasteryReferences } from './primaryReferences';
import { packMasteryReferences } from './referenceBudget';
export { flowMasteryTextKey } from './sourceKey';

export interface FlowKnowledgeAssessment {
  knowledgePointId: string;
  name: string;
  existingNoteTitle?: string;
  /** Only explicitly selected new candidates may create a knowledge note. */
  createNote: boolean;
  evaluationId: string;
  evaluation?: MasteryShadowEvaluationResult;
  /** v3 receipts retain the bounded request for the same local save-time validation as review. */
  input?: MasteryShadowEvaluationInput;
  references: MasteryShadowReferenceItem[];
  referenceSelection?: { characters: number; omittedCriterionIds: string[]; limits: ReturnType<typeof packMasteryReferences>['limits'] };
  error?: string;
}

/** Private review receipt; no scores, profile updates or publication authority. */
export interface FlowMasteryBatch {
  schemaVersion: 1 | 2;
  mode: 'shadow';
  sessionId: string;
  projectNoteId: string;
  observedAt: string;
  rawTextKey: string;
  items: FlowKnowledgeAssessment[];
}

export interface FlowMasteryInput {
  sessionId: string;
  projectNoteId: string;
  rawText: string;
  observedAt: string;
  candidates: KnowledgePointCandidate[];
  notes: NoteItem[];
}

const EMPTY_GRAPH: ShadowGraph = { nodes: [], arguments: [], relations: [], unresolved: [] };

async function defaultCall(request: Parameters<MasteryShadowEvaluationCall>[0]) {
  const response = await callLLM({ providerId: '', model: '', workflow: 'knowledge-mastery-scoring',
    userInput: request.userInput, systemPromptOverride: request.systemPrompt,
    outputSchema: JSON_OBJECT_OUTPUT, temperatureOverride: 0, maxTokensOverride: 7000,
    skipMemoryInjection: true, skipProfileInjection: true, thinkingMode: 'disabled' });
  return response.content;
}

/** Bounded RAG retrieval uses the same project/source policy as flow analysis; no index rebuild. */
async function referencesFor(input: FlowMasteryInput, target: { name: string; title?: string; note?: NoteItem },
  readers?: Partial<FlowReferenceReaders>) {
  const current = input.notes.find(note => note.id === input.projectNoteId && note.noteType === 'project');
  if (!current) throw new Error('复盘项目已不存在');
  // A user-selected mentioned knowledge note is an allowed tier-3 source in this invocation only.
  const notes = input.notes.map(note => note.id === current.id
    ? { ...note, links: [...new Set([...note.links, target.title || target.name])] } : note);
  const context = { speakingContent: input.rawText, noteId: current.id, noteTitle: current.title,
    analysisRunId: input.sessionId, allNotes: notes };
  const provider = createFlowReferenceProvider(context, readers, { purpose: 'mastery' });
  const source: ShadowInput = { attemptId: input.sessionId, assessmentRevision: 1,
    observedAt: input.observedAt, rawText: input.rawText, assistance: 'none',
    task: { id: input.sessionId, family: 'free_review', goal: '只评价本次实际展示的知识理解',
      requiredLayers: [], promptedBehaviors: [] } };
  const topic = masteryTopicContext(input.rawText, target.title || target.name,
    input.candidates.map(candidate => candidate.existingNoteTitle || candidate.name));
  const targets: ShadowReferenceTarget[] = MASTERY_SHADOW_CRITERIA.map(criterion => ({
    id: `KP-${criterion.id}`, layer: criterion.layer, nodeIds: [],
    // Neutral rubric queries: never include the user's proposed answer as a retrieval baseline.
    query: masteryCriterionQuery(target.title || target.name, criterion.id, topic),
  }));
  const primaries = new Map<string, MasteryShadowReferenceItem[]>();
  for (const [index, coordinate] of targets.entries()) {
    primaries.set(coordinate.id, await primaryMasteryReferences(target.note, MASTERY_SHADOW_CRITERIA[index].id, coordinate.query, readers));
  }
  // Supplements are bounded and prefetched for the SAME evaluation call: a primary hit may
  // contain a definition but not the application's conditions. No second grading call is added.
  // These are retrieval coordinates only. EMPTY_GRAPH never becomes a user's argument graph.
  const candidates = await provider.retrieve(source, EMPTY_GRAPH, targets);
  const groups: Parameters<typeof packMasteryReferences>[0] = [];
  for (const [index, target] of targets.entries()) {
    const criterion = MASTERY_SHADOW_CRITERIA[index];
    const primary = primaries.get(target.id) || [];
    const available = candidates.filter(item => item.targetId === target.id && item.tier <= 3
      && item.sourceType !== 'model_prior' && item.availability === 'available' && item.text.trim())
      .sort((a, b) => a.tier - b.tier || (b.similarity ?? 0) - (a.similarity ?? 0));
    const selected: MasteryShadowReferenceItem[] = [...primary];
    // One candidate per source tier, not "a readable textbook means sufficient".
    const tiers = new Set<number>();
    for (const candidate of available.filter(item => !tiers.has(item.tier) && !!tiers.add(item.tier))) {
      const quote = candidate.text;
      selected.push({ id: candidate.id, tier: candidate.tier, sourceId: candidate.sourceId,
        sourceRole: 'supplement', sourceLabel: candidate.title, locator: candidate.locator,
        quote, layers: [target.layer], criterionIds: [criterion.id] });
    }
    groups.push({ criterionId: criterion.id, references: selected });
  }
  return packMasteryReferences(groups);
}

export async function evaluateFlowKnowledgeMastery(input: FlowMasteryInput, dependencies: {
  call?: MasteryShadowEvaluationCall;
  referenceReaders?: Partial<FlowReferenceReaders>;
  isCurrent?: () => boolean;
} = {}): Promise<FlowMasteryBatch> {
  if ([...input.rawText].length > 3999) throw new Error('本次复盘超过3999字，尚未发送评价；请先精简或分次复盘');
  if (!input.notes.some(note => note.id === input.projectNoteId && note.noteType === 'project')) {
    throw new Error('复盘项目已不存在');
  }
  const knowledge = input.notes.filter(note => note.noteType === 'knowledge');
  const targets = new Map<string, { name: string; target?: NoteItem }>();
  for (const candidate of input.candidates) {
    const name = candidate.name.trim();
    if (!name) continue;
    const target = resolveNoteByTitleOrAlias(candidate.existingNoteTitle || name, knowledge)
      || resolveNoteByTitleOrAlias(name, knowledge);
    targets.set(target?.id || name.toLocaleLowerCase(), { name, target });
  }
  const batch: FlowMasteryBatch = { schemaVersion: 2, mode: 'shadow', sessionId: input.sessionId,
    projectNoteId: input.projectNoteId, observedAt: input.observedAt, rawTextKey: flowMasteryTextKey(input.rawText), items: [] };
  const tasks = [...targets.values()];
  // Two in flight bounds both model load and the amount of retrieved material held by the renderer.
  for (let index = 0; index < tasks.length; index += 2) {
    if (dependencies.isCurrent?.() === false) throw new Error('本次复盘已停止');
    const rows = await Promise.all(tasks.slice(index, index + 2).map(async ({ name, target }) => {
      const knowledgePointId = target?.id || `note-flow-${flowMasteryTextKey(`${input.sessionId}:${name}`).replace(':', '-')}`;
      const evaluationId = `flow-mastery:${input.sessionId}:${knowledgePointId}`;
      const item: FlowKnowledgeAssessment = { knowledgePointId, name, existingNoteTitle: target?.title,
        createNote: !target, evaluationId, references: [] };
      try {
        const selectedReferences = await referencesFor(input, { name, title: target?.title, note: target }, dependencies.referenceReaders);
        item.references = selectedReferences.references;
        item.referenceSelection = { characters: selectedReferences.characters, omittedCriterionIds: selectedReferences.omittedCriterionIds, limits: selectedReferences.limits };
        if (dependencies.isCurrent?.() === false) throw new Error('本次复盘已停止');
        const evaluationInput: MasteryShadowEvaluationInput = {
          evaluationId, knowledgePointId, knowledgePointTitle: target?.title || name,
          occurredAt: input.observedAt, source: 'flow_review', assistance: 'independent', strength: 'natural',
          task: { evaluationMode: 'natural_recall', referenceContract: 'criterion-scope-v3', confirmationPolicy: 'open-demonstration-v1', responseType: 'open',
            prompt: `自由复盘中有关“${target?.title || name}”的实际理解；不得要求原话没有展开的层次。`,
            // Retrieval context is a hint, not a keyword-only gate: implicit explanations remain assessable.
            expectedFocus: masteryTopicContext(input.rawText, target?.title || name,
              input.candidates.map(candidate => candidate.existingNoteTitle || candidate.name))
              || '本地未找到明确点名段落，请核对是否有隐含解释；其他知识点的回答不算本知识点错答。',
            requiredLayers: [...MASTERY_SHADOW_LAYERS], criterionIds: MASTERY_SHADOW_CRITERIA.map(c => c.id) },
          answer: input.rawText, references: item.references,
        };
        item.input = evaluationInput;
        const raw = await (dependencies.call || defaultCall)(buildMasteryShadowEvaluationRequest(evaluationInput));
        item.evaluation = parseMasteryShadowEvaluation(raw, evaluationInput);
      } catch (error) {
        item.error = error instanceof Error ? error.message : '本次知识点评价未完成';
      }
      return item;
    }));
    batch.items.push(...rows);
  }
  if (dependencies.isCurrent?.() === false) throw new Error('本次复盘已停止');
  return batch;
}

function presentation(item: FlowKnowledgeAssessment, state?: MasteryShadowState): MasteryShadowPresentation {
  const current = state ? effectiveMasteryShadowState(state) : createMasteryShadowState(item.knowledgePointId);
  return { evaluationId: item.evaluationId, status: item.evaluation ? 'evaluated' : 'failed',
    layers: Object.fromEntries(MASTERY_SHADOW_LAYERS.map(layer => {
      const observation = item.evaluation?.observations.find(o => o.results[0]?.layer === layer);
      const criteria = item.evaluation?.criteria.filter(c => MASTERY_SHADOW_CRITERIA.find(d => d.id === c.id)?.layer === layer);
      return [layer, { coverage: observation?.coverage || 'unverifiable',
        verdict: observation?.results[0]?.verdict || 'unverifiable', state: current.layers[layer].state,
        reason: item.error || criteria?.map(c => c.reason).join('；') || '本次没有足够依据。',
        assessment: masteryLayerAssessment(item, layer) }];
    })) as MasteryShadowPresentation['layers'] };
}

export function flowMasteryResults(batch: FlowMasteryBatch, notes: NoteItem[]): KnowledgePointMasteryResult[] {
  return batch.items.map(item => {
    const note = notes.find(note => note.id === item.knowledgePointId);
    const shadow = presentation(item, note?.dsrState?.masteryShadow);
    if (note) {
      const view = readKnowledgeMastery(note);
      shadow.overview = { label: view.displayLabel, summary: view.summary, nextAction: view.nextAction };
    }
    const touched = MASTERY_SHADOW_LAYERS.filter(layer => shadow.layers[layer].coverage === 'assessed');
    return { name: item.name, existingNoteTitle: item.existingNoteTitle, level: touched.at(-1) || 'none',
      // Required by legacy report consumers only. Shadow UI never presents these as scores.
      conceptDelta: 0, judgmentDelta: 0, reasoningDelta: 0, shadow,
      comment: item.error ? '本次评价未完成，原状态保留。'
        : item.evaluation?.summary || '本次未展示足够的知识理解。' };
  });
}

/** Pure mutation prepared against the latest notes; caller saves all affected notes in one transaction. */
export function prepareFlowMasteryOutcome(notes: NoteItem[], batch: FlowMasteryBatch) {
  const project = notes.find(note => note.id === batch.projectNoteId && note.noteType === 'project');
  const record = project?.learningReviewRecords?.find(r => r.sessionId === batch.sessionId && r.projectNoteId === project.id);
  if (!project || !record || (record.masteryInputKey || flowMasteryTextKey(record.rawRestatement)) !== batch.rawTextKey) {
    throw new Error('知识点评价与本次已保存的复盘原文不匹配，未更新掌握状态');
  }
  if (record.masteryAssessment) {
    if (record.masteryAssessment.rawTextKey !== batch.rawTextKey) throw new Error('已有评价来源发生变化');
    return { notes, results: flowMasteryResults(record.masteryAssessment, notes), batch: record.masteryAssessment, duplicate: true };
  }
  // Historical receipts keep their old interpretation; new receipts cannot bypass
  // scope/evidence checks by supplying precomputed observations at save time.
  batch = structuredClone(batch);
  const replacements = new Map<string, NoteItem>();
  const additions: NoteItem[] = [];
  const ids = new Set<string>();
  for (const item of batch.items) {
    if (ids.has(item.knowledgePointId)) throw new Error('本次知识点评价重复');
    ids.add(item.knowledgePointId);
    if (!item.evaluation) continue;
    if (batch.schemaVersion === 2 || item.input?.task.referenceContract === 'criterion-scope-v3') {
      try {
        const request = item.input;
        if (!request || request.task.referenceContract !== 'criterion-scope-v3'
          || request.evaluationId !== item.evaluationId || request.knowledgePointId !== item.knowledgePointId
          || request.source !== 'flow_review' || request.strength !== 'natural' || request.assistance !== 'independent'
          || request.occurredAt !== batch.observedAt || flowMasteryTextKey(request.answer) !== batch.rawTextKey
          || JSON.stringify(request.references) !== JSON.stringify(item.references)) throw new Error('invalid evaluation binding');
        item.evaluation = parseMasteryShadowEvaluation(item.evaluation, request);
      } catch {
        item.error = '评价范围或原话绑定无效，本项保留原掌握状态。';
        item.evaluation = undefined;
        continue;
      }
    }
    const observations = item.evaluation.observations;
    if (observations.some(o => o.knowledgePointId !== item.knowledgePointId
      || o.source !== 'flow_review' || o.strength !== 'natural' || o.id !== `${item.evaluationId}:${o.results[0]?.layer}`)) {
      throw new Error('知识点评价观察来源不一致');
    }
    let target = notes.find(note => note.id === item.knowledgePointId && note.noteType === 'knowledge');
    if (!target && !item.createNote) continue; // Deleted knowledge notes must not be resurrected by late replies.
    const assessed = observations.some(o => o.coverage === 'assessed'
      && o.results.some(r => r.verdict === 'pass' || r.verdict === 'partial' || r.verdict === 'fail'));
    if (!assessed) continue;
    if (!target) {
      if (findNotesByTitleOrAlias(item.name, notes).length) continue; // A concurrent creation or ambiguous name cannot acquire old evidence.
      target = { id: item.knowledgePointId, title: item.name, noteType: 'knowledge',
        content: '请对该知识点进行定义描述', tags: ['学习计划'], links: [], backlinks: [], dueDates: [],
        createdAt: batch.observedAt, updatedAt: batch.observedAt };
    }
    const state = applyMasteryShadowObservations(target.dsrState?.masteryShadow, observations);
    const updated: NoteItem = { ...target, dsrState: {
      difficulty: 5, stability: 2, lastReviewedAt: null, reviewCount: 0, consecutiveCorrect: 0, consecutiveWrong: 0,
      ...target.dsrState, masteryShadow: state,
    } };
    if (notes.some(note => note.id === target!.id)) replacements.set(target.id, updated);
    else additions.push(updated);
  }
  replacements.set(project.id, { ...project, learningReviewRecords: project.learningReviewRecords!.map(r => r.id === record.id
    ? { ...r, masteryAssessment: batch } : r) });
  const next = [...notes.map(note => replacements.get(note.id) || note), ...additions];
  return { notes: next, results: flowMasteryResults(batch, next), batch, duplicate: false };
}

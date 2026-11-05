import { NARRATIVE_GRAPH_PROMPT, NARRATIVE_GRAPH_VERSION } from '../../workflows/documentCoreNarrativeGraphPrompt';
import { prepareCoreInputPacket, runPreparedCoreExtraction } from './runner';
import { projectCoreSemanticOutline, type SemanticOutlineResult } from './semanticOutline';
import { CORE_ARGUMENT_LIMITS, type CoreArgumentInput, type CoreArgumentReply, type CoreArgumentRequest, type CoreArgumentRun } from './types';

export interface NarrativeGraphInput { narrativeId: string; version: string; text: string }
export interface NarrativeParagraph { id: string; text: string; start: number; end: number }
export interface NarrativeGraphRequest extends Omit<CoreArgumentRequest, 'version'> { version: typeof NARRATIVE_GRAPH_VERSION }
export interface NarrativeGraphModel { call(request: Readonly<NarrativeGraphRequest>, signal?: AbortSignal): Promise<CoreArgumentReply> }
export interface NarrativeGraphResult extends Omit<SemanticOutlineResult, 'provenance'> {
  provenance: Omit<SemanticOutlineResult['provenance'], 'version'> & {
    version: typeof NARRATIVE_GRAPH_VERSION; evidenceBasis: 'narrative-paragraphs-not-original-document'; originalSourceVerified: false;
  };
}
export type NarrativeGraphRun = Omit<CoreArgumentRun, 'version' | 'request' | 'result' | 'boundary'> & {
  version: typeof NARRATIVE_GRAPH_VERSION; request: NarrativeGraphRequest; result?: NarrativeGraphResult;
  narrative: NarrativeGraphInput & { paragraphs: NarrativeParagraph[] };
  boundary: Omit<CoreArgumentRun['boundary'], 'sourceBasis'> & {
    sourceBasis: 'saved-narrative-only'; originalDocumentSent: false; originalSourceVerified: false;
  };
};
export function narrativeGraphSource(narrative: NarrativeGraphInput) {
  if (!narrative.narrativeId?.trim() || !narrative.version?.trim() || !narrative.text?.trim()) throw new Error('缺少摘要身份或内容');
  const paragraphs: NarrativeParagraph[] = [...narrative.text.matchAll(/\S[\s\S]*?(?=\r?\n[ \t]*\r?\n|$)/g)].map((m, i) => {
    const text = m[0].trimEnd(), start = m.index!;
    return { id: `B${i + 1}`, text, start, end: start + text.length };
  });
  const source: CoreArgumentInput = { docId: narrative.narrativeId, sourceVersion: narrative.version,
    scope: { kind: 'excerpt', label: '已保存的论证链摘要，仅用于图化；不是论文原文' },
    passages: paragraphs.map(p => ({ id: p.id, section: '', text: p.text })) };
  prepareCoreInputPacket(source); // Identity/size guards only; its document packet is NOT sent.
  return { source, paragraphs };
}
export function prepareNarrativeGraphRequest(narrative: NarrativeGraphInput): NarrativeGraphRequest {
  const { paragraphs } = narrativeGraphSource(narrative);
  const userInput = JSON.stringify({ narrativeId: narrative.narrativeId, narrativeVersion: narrative.version,
    paragraphs: paragraphs.map(({ id, text }) => ({ id, text })),
    boundary: { task: 'convert-saved-narrative-to-graph', originalDocumentProvided: false, originalEvidenceVerified: false } });
  if (userInput.length > CORE_ARGUMENT_LIMITS.packetCharacters) throw new Error('摘要图化请求超出安全预算，未截断');
  return { version: NARRATIVE_GRAPH_VERSION, systemPrompt: NARRATIVE_GRAPH_PROMPT, userInput,
    parameters: { temperature: 0, maxTokens: CORE_ARGUMENT_LIMITS.maxTokens, thinkingMode: 'disabled' } };
}
export function projectNarrativeGraph(raw: string, narrative: NarrativeGraphInput): NarrativeGraphResult {
  const parsed = projectCoreSemanticOutline(raw, narrativeGraphSource(narrative).source);
  return { ...parsed, provenance: { ...parsed.provenance, version: NARRATIVE_GRAPH_VERSION,
    evidenceBasis: 'narrative-paragraphs-not-original-document', originalSourceVerified: false } };
}
const convert = runPreparedCoreExtraction as unknown as (source: CoreArgumentInput, request: NarrativeGraphRequest,
  model: NarrativeGraphModel, parse: (raw: string, input: CoreArgumentInput) => NarrativeGraphResult, signal?: AbortSignal) => Promise<Omit<NarrativeGraphRun, 'narrative' | 'boundary'> & { boundary: CoreArgumentRun['boundary'] }>;
/** Explicit separate experiment, never chained into extraction or production by default. */
export async function runNarrativeGraph(input: NarrativeGraphInput, model: NarrativeGraphModel, signal?: AbortSignal): Promise<NarrativeGraphRun> {
  const narrative = structuredClone(input), { source, paragraphs } = narrativeGraphSource(narrative);
  const result = await convert(source, prepareNarrativeGraphRequest(narrative), model,
    raw => projectNarrativeGraph(raw, narrative), signal);
  return { ...result, narrative: { ...narrative, paragraphs }, boundary: { ...result.boundary,
    sourceBasis: 'saved-narrative-only', originalDocumentSent: false, originalSourceVerified: false } };
}

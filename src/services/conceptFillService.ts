import type { ConceptDraft, ConceptSource, ConceptSourceEvidence, NoteItem, LlmProvider, LlmWorkflowTemplate } from '../types';
import { searchDocuments } from './documentRagClient';
import { callLLM } from './llmService';
import { searchNotes } from './ragService';
import { CONCEPT_AUGMENTATION_PROMPT } from '../workflows/conceptGenerationPrompt';
import { prepareConceptAugmentation, numberAugmentationEvidence, composeConceptAugmentation } from './conceptAugmentation';
import { normalizeConceptCitationMarkers as normalizeConceptCitationMarkersProtected, extractConceptCitationIdsProtected, stripConceptModelSourceList } from './conceptCitationMarkers';

const MAX_EVIDENCE_CHARS = 14_000;

function compact(value: unknown): string {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function conceptSearchTerms(note: NoteItem): string[] {
  const seen = new Set<string>();
  return [note.title, ...(note.aliases || [])]
    .map((term) => compact(term).slice(0, 120))
    .filter((term) => {
      const key = term.normalize('NFKC').toLocaleLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
}

export interface ConceptEvidenceScope { allowedDocIds: string[]; allowedNoteIds: string[]; }
async function retrieveLocalEvidence(note: NoteItem, scope?: ConceptEvidenceScope): Promise<ConceptSourceEvidence[]> {
  const terms = conceptSearchTerms(note);
  const [documents, notes] = await Promise.all([
    Promise.allSettled(scope && !scope.allowedDocIds.length ? [] : terms.map((term, index) => searchDocuments(term, index === 0 ? 5 : 3, scope ? { allowedDocIds: scope.allowedDocIds } : undefined))),
    Promise.allSettled(scope && !scope.allowedNoteIds.length ? [] : terms.map((term, index) => searchNotes(term, index === 0 ? 5 : 3, scope ? { allowedNoteIds: scope.allowedNoteIds } : undefined))),
  ]);
  const documentEvidence: ConceptSourceEvidence[] = documents
    .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof searchDocuments>>> => result.status === 'fulfilled')
    .flatMap((result) => result.value)
    .filter(result => !scope || scope.allowedDocIds.includes(result.docId))
    .map((result, index) => ({
      sourceId: `D${index + 1}`,
      type: 'document',
      title: result.fileName,
      entityId: result.docId,
      sectionPath: result.sectionPath || undefined,
      score: result.score,
      snippet: compact(result.snippet).slice(0, 2400),
    }));
  const noteEvidence: ConceptSourceEvidence[] = notes
    .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof searchNotes>>> => result.status === 'fulfilled')
    .flatMap((result) => result.value)
    .filter((result) => result.noteId !== note.id && compact(result.snippet) && (!scope || scope.allowedNoteIds.includes(result.noteId)))
    .map((result, index) => ({
        sourceId: `N${index + 1}`,
        type: 'note',
        title: result.title,
        entityId: result.noteId,
        score: result.score,
        snippet: compact(result.snippet).slice(0, 2000),
      }));
  return [...documentEvidence, ...noteEvidence];
}

async function retrieveBrowserEvidence(note: NoteItem, signal?: AbortSignal): Promise<ConceptSourceEvidence[]> {
  signal?.throwIfAborted();
  const api = (window as any).electronAPI?.conceptResearch;
  if (!api?.search) throw new Error('当前环境不支持隔离浏览器概念检索');
  const requestId = crypto.randomUUID();
  const stop = () => { try { void Promise.resolve(api.cancel?.(requestId)).catch(() => {}); } catch { /* Older bridges can only stop waiting. */ } };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    signal?.throwIfAborted();
    const results = await api.search(note.title, conceptSearchTerms(note).slice(1), requestId) as ConceptSourceEvidence[];
    signal?.throwIfAborted();
    return Array.isArray(results) ? results.filter((item) => item?.type === 'web' && compact(item.snippet)) : [];
  } finally { signal?.removeEventListener('abort', stop); }
}

function dedupeAndNumberEvidence(items: ConceptSourceEvidence[]): ConceptSourceEvidence[] {
  const seen = new Set<string>();
  const deduped = items.filter((item) => {
    const key = item.url ? `url:${item.url}` : `${item.type}:${item.entityId || item.title}:${item.sectionPath || ''}:${compact(item.snippet).slice(0, 120)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return compact(item.title) && compact(item.snippet);
  });
  const web = deduped.filter((item) => item.type === 'web').slice(0, 4);
  const local = deduped.filter((item) => item.type !== 'web').slice(0, 6);
  return [...web, ...local].map((item, index) => ({ ...item, sourceId: String(index + 1) }));
}

export function buildConceptEvidenceInput(note: NoteItem, evidence: ConceptSourceEvidence[]): string {
  let remaining = MAX_EVIDENCE_CHARS;
  const blocks: string[] = [];
  for (const item of evidence) {
    if (remaining <= 200) break;
    // 预留本地与网页两类证据的位置，避免长网页占满整个上下文。
    const allowance = Math.min(item.type === 'web' ? 2200 : 850, remaining);
    const snippet = compact(item.snippet).slice(0, allowance);
    remaining -= snippet.length;
    blocks.push([
      `【来源 ${item.sourceId}｜${item.type === 'web' ? '公开网页' : item.type === 'document' ? '本地资料' : '本地笔记'}｜${compact(item.title)}】`,
      item.url ? `URL：${item.url}` : '',
      item.sectionPath ? `位置：${item.sectionPath}` : '',
      snippet,
    ].filter(Boolean).join('\n'));
  }
  const aliases = conceptSearchTerms(note).slice(1);
  return `【术语】\n${note.title}${aliases.length ? `\n【别名】\n${aliases.join('、')}` : ''}\n\n【待核验证据】\n${blocks.join('\n\n')}`;
}

function stripModelSourceList(content: string): string {
  return stripConceptModelSourceList(content);
}

export function normalizeConceptCitationMarkers(content: string): string {
  // Existing [N] responses remain byte-identical and require no Markdown parse.
  return content.includes('【来源') ? normalizeConceptCitationMarkersProtected(content) : content;
}

export function extractConceptCitationIds(rawContent: string): number[] {
  const content = normalizeConceptCitationMarkers(stripModelSourceList(String(rawContent || '')));
  // Generation is not a reading/input hot path. Always use the Markdown
  // structure: indentation and heading syntax cannot safely predict its nodes.
  return extractConceptCitationIdsProtected(content);
}

export function validateAndFinalizeConceptContent(
  rawContent: string,
  noteTitle: string,
  evidence: ConceptSourceEvidence[],
): string {
  let content = normalizeConceptCitationMarkers(stripModelSourceList(String(rawContent || '')));
  if (!content) throw new Error('LLM 未返回概念草稿');
  if (!/^#\s+/u.test(content)) content = `# ${noteTitle}\n\n${content}`;
  const cited = extractConceptCitationIds(content);
  if (cited.length === 0) throw new Error('概念草稿没有引用任何检索证据，请重试');
  const allowed = new Set(evidence.map((item) => Number(item.sourceId)));
  const invalid = [...new Set(cited.filter((id) => !allowed.has(id)))];
  if (invalid.length > 0) throw new Error(`概念草稿引用了不存在的来源：${invalid.map((id) => `[${id}]`).join('、')}`);
  const citedSet = new Set(cited);
  const references = evidence.filter((item) => citedSet.has(Number(item.sourceId))).map((item) => {
    const label = item.url ? `[${item.title}](${item.url})` : item.title;
    const location = item.sectionPath ? ` · ${item.sectionPath}` : '';
    const kind = item.type === 'web' ? '公开网页' : item.type === 'document' ? '本地资料' : '本地笔记';
    return `- [${item.sourceId}] ${label} — ${kind}${location}`;
  });
  return `${content}\n\n## 来源\n${references.join('\n')}`;
}

function describeEmptyConceptResponse(
  response: Awaited<ReturnType<typeof callLLM>>,
  evidenceCount: number,
): string {
  const diagnostics = response.diagnostics;
  const reason = diagnostics?.finishReason;
  const prefix = `已读取 ${evidenceCount} 条清洗后的证据，但`;
  if (reason === 'length' || (diagnostics?.reasoningTokens || 0) > 0 || diagnostics?.hadReasoningContent) {
    return `${prefix}模型在思考阶段耗尽了输出额度，未生成最终正文${diagnostics?.reasoningTokens ? `（推理 ${diagnostics.reasoningTokens} tokens）` : ''}。请重试。`;
  }
  if (reason === 'content_filter' || reason === 'SAFETY') {
    return `${prefix}模型供应商拦截了概念草稿。请更换模型或调整概念名称后重试。`;
  }
  if (reason === 'insufficient_system_resource' || reason === 'aborted') {
    return `${prefix}模型供应商中断了本次生成，请稍后重试。`;
  }
  return `${prefix}模型供应商返回的最终正文为空${reason ? `（结束原因：${reason}）` : ''}。请重试或更换模型。`;
}

async function collectEvidence(note: NoteItem, source: ConceptSource, scope?: ConceptEvidenceScope, signal?: AbortSignal): Promise<ConceptSourceEvidence[]> {
  if (scope && source !== 'rag') throw new Error('限定本地资料的组合流程不能读取网页');
  if (source === 'rag') return dedupeAndNumberEvidence(await retrieveLocalEvidence(note, scope));
  if (source === 'browser') return dedupeAndNumberEvidence(await retrieveBrowserEvidence(note, signal));
  const [browser, local] = await Promise.allSettled([
    retrieveBrowserEvidence(note, signal),
    retrieveLocalEvidence(note),
  ]);
  const combined = [
    ...(browser.status === 'fulfilled' ? browser.value : []),
    ...(local.status === 'fulfilled' ? local.value : []),
  ];
  if (combined.length === 0) {
    const failures = [browser, local]
      .filter((result) => result.status === 'rejected')
      .map((result) => result.status === 'rejected' && result.reason instanceof Error ? result.reason.message : '')
      .filter(Boolean);
    throw new Error(failures.join('；') || '没有检索到可用于概念补全的证据');
  }
  return dedupeAndNumberEvidence(combined);
}

/** 先检索证据，再调用用户当前配置的通用 LLM；始终返回预览草稿，不直接写入笔记。 */
export async function generateConcept(
  note: NoteItem,
  source: ConceptSource = 'hybrid',
  options?: { signal?: AbortSignal; onStage?: (stage: 'retrieving' | 'generating') => void;
    providerSnapshot?: LlmProvider; workflowSnapshot?: LlmWorkflowTemplate; beforeModel?: () => Promise<void>; evidenceScope?: ConceptEvidenceScope;
    /** Manual opt-in; batch/background callers retain full generation by default. */
    mode?: 'replace' | 'augment'; existingContent?: string },
): Promise<ConceptDraft> {
  const signal = options?.signal;
  const stopped = () => { if (signal?.aborted) throw new DOMException('概念研究已停止', 'AbortError'); };
  stopped();
  const augmentation = options?.mode === 'augment' ? prepareConceptAugmentation(note, options.existingContent) : undefined;
  options?.onStage?.('retrieving');
  // Public retrieval has an owned cancellation IPC; local/older bridges may
  // still finish in the background. Never start a model from any late result.
  let evidence = await waitForConceptEvidence(() => collectEvidence(note, source, options?.evidenceScope, signal), signal);
  stopped();
  if (evidence.length === 0) {
    throw new Error(source === 'rag'
      ? '本地笔记与资料库中没有检索到相关证据'
      : '没有检索到可公开访问且内容足够的概念来源');
  }
  if (augmentation) evidence = numberAugmentationEvidence(evidence, augmentation);
  await options?.beforeModel?.();
  stopped();
  options?.onStage?.('generating');
  const response = await callLLM({
    providerId: '',
    model: '',
    workflow: 'concept-generation',
    userInput: augmentation
      ? `【待扩充原稿：仅供定位遗漏，不是独立证据】\n${augmentation.context}${augmentation.contextTruncated ? '\n（原稿较长，仅展示前8000字符；未展示部分仍会完整保留。）' : ''}\n【原稿结束】\n原有数字引用已占用至 ${augmentation.citationOffset}；本次只能引用下列新来源。\n\n${buildConceptEvidenceInput(note, evidence)}`
      : buildConceptEvidenceInput(note, evidence),
    skipMemoryInjection: true,
    skipProfileInjection: true,
    thinkingMode: 'disabled',
    ...(options?.workflowSnapshot ? { systemPromptOverride: options.workflowSnapshot.systemPrompt,
      temperatureOverride: options.workflowSnapshot.defaultParams.temperature,
      maxTokensOverride: options.workflowSnapshot.defaultParams.maxTokens } : {}),
    ...(augmentation ? { systemPromptOverride: CONCEPT_AUGMENTATION_PROMPT } : {}),
  }, { signal, providerSnapshot: options?.providerSnapshot });
  stopped();
  if (response.diagnostics?.finishReason === 'length') throw new Error('概念草稿输出被截断，未写入；请检查模型输出额度后重试');
  if (!String(response.content || '').trim()) throw new Error(describeEmptyConceptResponse(response, evidence.length));
  const normalizedContent = normalizeConceptCitationMarkers(response.content);
  const citedSourceIds = new Set(extractConceptCitationIds(normalizedContent).map(String));
  const supplement = validateAndFinalizeConceptContent(normalizedContent, note.title, evidence);
  const content = augmentation ? composeConceptAugmentation(augmentation, supplement) : supplement;
  const citedEvidence = evidence.filter((item) => citedSourceIds.has(item.sourceId));
  return {
    noteId: note.id,
    title: note.title,
    content,
    source,
    references: [...(augmentation?.originalReferences || []), ...citedEvidence.map((item) => ({
      sourceId: item.sourceId,
      type: item.type,
      title: item.title,
      url: item.url,
      entityId: item.entityId,
      sectionPath: item.sectionPath,
      snippet: compact(item.snippet).slice(0, 500),
    }))],
    createdAt: new Date().toISOString(),
  };
}

async function waitForConceptEvidence<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException('概念研究已停止', 'AbortError');
  if (!signal) return read();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('概念研究已停止', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    read().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

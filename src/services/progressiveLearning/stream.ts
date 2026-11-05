import type { ProgressiveMainline, ProgressiveReflectionHook, ProgressiveConcept, ProgressiveQuestion, ProgressiveRoute } from './types';
import { PROGRESSIVE_MAX_BODY, PROGRESSIVE_MAX_RAW, validateProgressiveHook,
  validateProgressiveMainline, validateProgressiveConcepts, validateProgressiveQuestions, projectProgressiveQuestion, validateProgressiveRoute } from './validation';

export interface ProgressiveResponseSeed { plan?: ProgressiveMainline | null; body?: string; maxMainlinePages?: number }
export interface ProgressiveParsedResponse {
  plan: ProgressiveMainline | null;
  body: string;
  hook: ProgressiveReflectionHook | null;
  complete: boolean;
  concepts?: ProgressiveConcept[];
  questions?: ProgressiveQuestion[];
  route?: ProgressiveRoute;
  metadataError?: string;
}
export interface ProgressiveMarkdownBlocks { blocks: string[]; pendingText: string; incompleteStructure: boolean }

/** Only blank-line boundaries outside complete code/formula structures become mounted Markdown. */
export function stableMarkdownBlocks(body: string, final = false): ProgressiveMarkdownBlocks {
  const blocks: string[] = [];
  let start = 0, offset = 0, fence = '', displayMath = false, bracketMath = false;
  for (const line of body.match(/[^\n]*(?:\n|$)/gu) || []) {
    if (!line) continue;
    const value = line.replace(/\r?\n$/u, '');
    const code = value.match(/^\s{0,3}(`{3,}|~{3,})/u)?.[1];
    if (code) {
      if (!fence) fence = code;
      else if (code[0] === fence[0] && code.length >= fence.length) fence = '';
    }
    if (!fence && !code) {
      const dollars = value.match(/(?<!\\)\$\$/gu)?.length || 0;
      if (dollars % 2) displayMath = !displayMath;
      if (/\\\[/u.test(value)) bracketMath = true;
      if (/\\\]/u.test(value)) bracketMath = false;
    }
    offset += line.length;
    if (!value.trim() && !fence && !displayMath && !bracketMath) {
      const block = body.slice(start, offset).trim();
      if (block) blocks.push(block);
      start = offset;
    }
  }
  const incompleteStructure = Boolean(fence || displayMath || bracketMath);
  let pendingText = body.slice(start);
  if (final && !incompleteStructure) {
    if (pendingText.trim()) blocks.push(pendingText.trim());
    pendingText = '';
  }
  return { blocks, pendingText, incompleteStructure };
}

function parseJson(text: string, label: string): unknown {
  try { return JSON.parse(text.trim()); }
  catch { throw new Error(`${label}格式未完成，请保留已生成内容后重试。`); }
}

function mergeContinuation(prefix: string, addition: string): string {
  if (!prefix) return addition.replace(/^\s*\n/u, '');
  if (!addition.trim()) return prefix;
  // A provider may repeat the entire unchanged prefix despite the continuation instruction.
  if (addition.startsWith(prefix)) return addition;
  if (prefix.trim().length >= 100 && addition.trimStart().startsWith(prefix.trimStart().slice(0, 100))) {
    throw new Error('续写返回了不同版本的已保存内容，原文已保留。');
  }
  // Resume can repeat the final sentence. Remove only an exact boundary overlap.
  const limit = Math.min(2000, prefix.length, addition.length);
  for (let size = limit; size >= 24; size--) {
    if (prefix.endsWith(addition.slice(0, size))) return prefix + addition.slice(size);
  }
  const startsBlock = /^(?:#{1,6}\s|```|~~~|\$\$|\\\[)/u.test(addition);
  const endedSentence = /[。！？.!?：:]$/u.test(prefix);
  const separator = !prefix.endsWith('\n') && !addition.startsWith('\n') && (startsBlock || endedSentence) ? '\n\n' : '';
  return prefix + separator + addition;
}

/** Domain stream: plan JSON ends before readable Markdown starts, so no whole-book JSON buffer. */
export function parseProgressiveResponse(raw: string, seed: ProgressiveResponseSeed = {}): ProgressiveParsedResponse {
  if (raw.length > PROGRESSIVE_MAX_RAW) throw new Error('本页响应超过保存上限，已保留可读内容。');
  const markers = [...raw.matchAll(/(?:^|(?<=\n))@@(PLAN|ROUTE|LESSON|CONCEPTS|QUESTIONS|HOOK|END)[ \t]*(?:\r?\n|$)/gu)]
    .map(match => ({ kind: match[1], start: match.index! > 0 ? match.index! - 1 : 0, end: match.index! + match[0].length }));
  const lesson = markers.find(marker => marker.kind === 'LESSON');
  const planMarker = markers.find(marker => marker.kind === 'PLAN');
  const routeMarker = markers.find(marker => marker.kind === 'ROUTE');
  let route: ProgressiveRoute | undefined;
  if (routeMarker) {
    const boundary = markers.find(marker => marker.start > routeMarker.start);
    if (boundary) {
      const candidate = parseJson(raw.slice(routeMarker.end, boundary.start), '后续编排');
      validateProgressiveRoute(candidate);
      route = { kind: candidate.kind, reason: candidate.reason, ...(candidate.correction ? { correction: candidate.correction } : {}) };
    }
  }
  let plan = seed.plan || null;
  if (planMarker && lesson) {
    const candidate = parseJson(raw.slice(planMarker.end, lesson.start), '主线');
    validateProgressiveMainline(candidate, seed.maxMainlinePages || 4);
    if (plan && JSON.stringify(plan) !== JSON.stringify(candidate)) throw new Error('续写不能替换已经保存的主线。');
    plan = { title: candidate.title, objectives: [...candidate.objectives], pages: candidate.pages.map(page => ({
      id: page.id, title: page.title, objectives: [...page.objectives],
    })) };
  }
  if (!lesson) return { plan, body: seed.body || '', hook: null, ...(route ? { route } : {}), complete: route?.kind === 'finish' && markers.some(marker => marker.kind === 'END') };
  if (!plan) throw new Error('正文开始前尚未取得有效的课程主线。');
  const hookMarker = markers.find(marker => marker.kind === 'HOOK' && marker.start > lesson.start);
  const conceptMarker = markers.find(marker => marker.kind === 'CONCEPTS' && marker.start > lesson.start);
  const questionsMarker = markers.find(marker => marker.kind === 'QUESTIONS' && marker.start > lesson.start);
  const end = markers.find(marker => marker.kind === 'END' && marker.start > lesson.start);
  let addition = raw.slice(lesson.end, conceptMarker?.start ?? questionsMarker?.start ?? hookMarker?.start ?? end?.start ?? raw.length);
  if (!hookMarker && !end) addition = addition.replace(/\n@@[A-Z]*[ \t]*$/u, '');
  const body = mergeContinuation(seed.body || '', addition);
  if (body.length > PROGRESSIVE_MAX_BODY) throw new Error('本页正文超过保存上限，不能继续追加。');
  let hook: ProgressiveReflectionHook | null = null;
  let concepts: ProgressiveConcept[] | undefined;
  const conceptEnd = questionsMarker || hookMarker;
  if (conceptMarker && conceptEnd && conceptEnd.start > conceptMarker.start) {
    const candidate = parseJson(raw.slice(conceptMarker.end, conceptEnd.start), '本页知识点');
    validateProgressiveConcepts(candidate);
    concepts = candidate.map(({ key, title, summary }) => ({ key, title, summary }));
  }
  let questions: ProgressiveQuestion[] | undefined, metadataError: string | undefined;
  if (questionsMarker && hookMarker) {
    try {
      const candidate = parseJson(raw.slice(questionsMarker.end, hookMarker.start), '本页题目');
      validateProgressiveQuestions(candidate, body);
      questions = candidate.map(projectProgressiveQuestion);
    } catch (error) { metadataError = error instanceof Error ? error.message : '本页题目格式未完成'; }
  }
  if (hookMarker && end && end.start > hookMarker.start) {
    const candidate = parseJson(raw.slice(hookMarker.end, end.start), '复述提示');
    validateProgressiveHook(candidate);
    hook = { id: candidate.id, kind: 'reflection', prompt: candidate.prompt };
  }
  return { plan, body, hook, ...(concepts ? { concepts } : {}), ...(questions ? { questions } : {}),
    ...(route ? { route } : {}), ...(metadataError ? { metadataError } : {}), complete: Boolean(end && hook && body.trim() && !metadataError) };
}

export class ProgressiveStreamParser {
  raw = '';
  constructor(readonly seed: ProgressiveResponseSeed = {}) {}
  append(text: string): ProgressiveParsedResponse {
    this.raw += text;
    return parseProgressiveResponse(this.raw, this.seed);
  }
  finish(options?: { finishReason?: string }): ProgressiveParsedResponse {
    // Some providers omit the final sentinel after a complete hook. Only their
    // explicit normal-stop receipt can close that envelope; EOF alone cannot.
    if (options?.finishReason === 'stop' && !/(?:^|\n)@@END[ \t]*(?:\r?\n|$)/u.test(this.raw)
      && /(?:^|\n)@@HOOK[ \t]*\r?\n/u.test(this.raw)) {
      const closed = this.raw + '\n@@END\n';
      const candidate = parseProgressiveResponse(closed, this.seed);
      if (candidate.complete && !candidate.metadataError) this.raw = closed;
    }
    const result = parseProgressiveResponse(this.raw, this.seed);
    if (result.route?.kind === 'finish' && result.complete) return result;
    if (result.metadataError) throw Error(result.metadataError);
    if (!result.complete || !result.plan || !result.hook) throw new Error('本页生成尚未完整，已生成的正文和主线已保留。');
    if (result.body.replace(/\s/gu, '').length < 80) throw new Error('本页讲解内容不足，已保留草稿。');
    if (stableMarkdownBlocks(result.body, true).incompleteStructure) throw new Error('本页公式或代码结构尚未闭合，已保留草稿。');
    return result;
  }
}

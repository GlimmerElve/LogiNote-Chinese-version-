import type { AgentCitation, LlmCallRequest, LlmCallResponse } from '../../types';
import { buildInquirySnapshot, INQUIRY_PROMPT, checkInquiryAnswer, type InquiryAnswerError, type InquiryCursor, type InquiryPage, type InquirySource } from '../cognition/inquiry';
import { JSON_OBJECT_OUTPUT } from '../../workflows/structuredOutput';
import { loadPersonalCognition, searchCurrentPersonalCognition } from '../cognition/store';
import { renderCognitionRecall, type CognitionReference } from '../cognition/retrieval';
import { loadLearningEpisodes } from '../memory/episodeStore';
import type { AgentRuntimeContext, AgentToolStep } from './types';
import { executeTool } from './toolRegistry';
import { throwIfAgentAborted } from './runtime/nodeRunner';
import { emptyCognitionFile } from '../cognition/core';
import { buildAgentReplyPolicy, wantsDetailedAgentReply } from './replyPolicy';
import { projectMaterialRows } from '../ragSourcePolicy';
import { buildNoteRagIndexInput } from '../ragService';
import type { CognitionMaterialHit } from '../cognition/materials';
import { savedFlowReviewGraphs, retrieveFlowReviewGraphs } from '../cognition/flowReviewMaterials';
import { cognitionRoleLabel } from '../cognition/roles';

export interface CognitionInquiryResult {
  answer: string; references: CognitionReference[]; citations?: AgentCitation[]; cursor?: InquiryCursor;
  llmCalls: number; promptTokens: number; completionTokens: number;
  budgetExhausted?: boolean;
}
const plain = (text: string) => text.replace(/([\\`*_\[\]<>#])/gu, '\\$1');

export async function runCognitionInquiry(input: {
  question: string; replyRequest?: string; cursor?: InquiryCursor; continuePage?: boolean; allowedTools: Set<string>;
  ctx: AgentRuntimeContext; callLlm: (request: LlmCallRequest) => Promise<LlmCallResponse>;
  signal?: AbortSignal; onStep?: (step: AgentToolStep) => void;
  /** Remaining allowance from the engine's frozen request budget, not live settings. */
  budget?: { toolCalls: number; rounds: number };
}): Promise<CognitionInquiryResult> {
  const result: CognitionInquiryResult = { answer: '', references: [], llmCalls: 0, promptTokens: 0, completionTokens: 0 };
  let remainingCalls = input.budget?.toolCalls ?? Infinity;
  let remainingRounds = input.budget?.rounds ?? Infinity;
  // Page reads and synthesis already count as steps in the engine. Reserve a
  // slot before doing work (including failed model attempts), not after onStep.
  const reserveStep = () => {
    throwIfAgentAborted(input.signal);
    if (remainingCalls <= 0) { result.budgetExhausted = true; return false; }
    remainingCalls--;
    return true;
  };
  const replyRequest = input.replyRequest || input.question;
  const detailed = wantsDetailedAgentReply(replyRequest);
  if (!input.allowedTools.has('retrieve_qa_evidence')) return { ...result, answer: '当前助手角色没有读取个人认知的权限。' };
  if (remainingCalls <= 0 || remainingRounds <= 0) return { ...result, budgetExhausted: true, answer: '本次认知查询预算已用完，尚未读取认知页面。' };
  const wantsProfile = /(?:画像|学习情况|学习习惯|学习风格|表达风格|认知风格|能力|了解自己)/u.test(input.question);
  const wantsLearning = /(?:画像|学习情况|学习习惯|掌握|学会|熟练|薄弱|学习记录|复习记录|切实情况)/u.test(input.question);
  let cognitionUnavailable = false;
  let materials: CognitionMaterialHit[] = [];
  const matchesCurrentSource = (hit: CognitionMaterialHit) => {
    const note = input.ctx.getNotes().find((n) => n.id === hit.noteId);
    if (!note) return false;
    if (hit.sourceKind === 'project-restatement') return projectMaterialRows(buildNoteRagIndexInput(note))
      .some((r) => r.passageId === hit.passageId && r.text === hit.text);
    if (hit.sourceKind === 'flow-review-argument') return retrieveFlowReviewGraphs(savedFlowReviewGraphs(note), input.question, 4)
      .some(g => g.argumentDocId === hit.argumentDocId && g.revisionHash === hit.revisionHash && g.nodeId === hit.nodeId
        && g.text === hit.text && g.relationSummary?.slice(0, 700) === hit.relationSummary);
    return note.argumentDocs?.some((d) => d.doc_id === hit.argumentDocId
      && d.rag?.publishedSnapshot?.revisionHash === hit.revisionHash
      && d.rag.publishedSnapshot.nodes.some((n) => n.id === hit.nodeId)) || false;
  };
  let snapshot: ReturnType<typeof buildInquirySnapshot>;
  try {
    // Seeds improve semantic matching; exact graph expansion always uses one fresh local snapshot.
    const hits = await searchCurrentPersonalCognition(input.question).catch(() => undefined);
    const file = await loadPersonalCognition();
    snapshot = buildInquirySnapshot(file, input.question, hits?.fileRevision === file.revision ? hits : undefined);
    // Queries for endorsed facts/history must not be silently expanded with
    // unconfirmed text. Topic-specific own-understanding queries may read both.
    const asksConfirmedStance = /(?:我.{0,12}(?:相信|认同|认可|确信)|(?:哪些|所有|全部|已确认|当前认同).{0,15}(?:事实|观点|假设|暂定)|认知.{0,8}(?:历史|变化|演变|修订))/u.test(input.question);
    if (!asksConfirmedStance && snapshot.mode !== 'history') {
      materials = (hits?.materials || []).filter(matchesCurrentSource);
    }
    if (hits?.materialsStatus === 'unavailable') snapshot.warnings.push('个人认知素材读取失败，不等于没有素材。');
  } catch {
    throwIfAgentAborted(input.signal);
    if (!wantsProfile && !wantsLearning) return { ...result, answer: renderCognitionRecall() };
    cognitionUnavailable = true;
    snapshot = buildInquirySnapshot(emptyCognitionFile(), input.question);
    snapshot.warnings.push('个人认知库读取失败；本次只回答可读取的画像或学习记录，不能判断认知库为空。');
  }
  throwIfAgentAborted(input.signal);
  const auxiliary: InquirySource[] = [];
  for (const [index, hit] of materials.entries()) auxiliary.push({ id: `M${index + 1}`, kind: 'material',
    title: hit.title.slice(0, 120), text: hit.text, sourceKind: hit.sourceKind,
    stance: 'not_assessed', truncated: hit.textTruncated, relationSummary: hit.relationSummary });
  if (materials.length) snapshot.warnings.push('项目复述、已保存复盘图及已发布论证图是未确认立场的素材，不计入已认同观点或掌握度；复盘图可含待复核问题。');
  if (materials.some((hit) => hit.textTruncated)) snapshot.warnings.push('部分认知素材已截断，仅可视为节选，请通过来源查看完整笔记或论证图。');
  for (const [name, requested, prefix] of [['query_learner_profile', wantsProfile, 'P'], ['query_mastery', wantsLearning, 'L']] as const) {
    if (!requested) continue;
    if (!input.allowedTools.has(name)) { snapshot.warnings.push(`${name === 'query_mastery' ? '掌握记录' : '用户画像'}未获当前角色读取权限。`); continue; }
    if (!reserveStep()) break;
    const args = name === 'query_learner_profile' ? { includeEvidence: true } : {}; const step = { call: { id: `inquiry-${name}`, name, arguments: args }, ...await executeTool(name, args, input.ctx) };
    input.onStep?.(step); throwIfAgentAborted(input.signal);
    if (!step.ok) { snapshot.warnings.push(`${name === 'query_mastery' ? '掌握记录' : '用户画像'}读取失败，不等于没有记录。`); continue; }
    const raw = step.result as { text?: string; rows?: unknown[]; details?: string[] };
    if (name === 'query_learner_profile' && typeof raw.text === 'string') auxiliary.push({ id: 'P1', kind: 'profile', title: '证据门控后的画像摘要', text: raw.text.slice(0, 4000), truncated: raw.text.length > 4000 });
    if (name === 'query_learner_profile' && Array.isArray(raw.details)) raw.details.slice(0, 12).forEach((text, i) => {
      if (typeof text === 'string') auxiliary.push({ id: `P${i + 2}`, kind: 'profile', title: '已采信画像指标的依据', text: text.slice(0, 4000), truncated: text.length > 4000 });
    });
    if (name === 'query_mastery' && Array.isArray(raw.rows)) {
      raw.rows.slice(0, 30).forEach((row, i) => auxiliary.push({ id: `${prefix}${i + 1}`, kind: 'learning', title: '系统掌握度记录（非用户信念）', text: JSON.stringify(row).slice(0, 1600) }));
      snapshot.warnings.push('掌握度接口最多返回 30 项，薄弱项优先，不代表全部知识掌握情况。');
    }
  }
  if (wantsLearning && input.allowedTools.has('query_learner_profile') && !result.budgetExhausted) {
    try {
      const episodes = (await loadLearningEpisodes()).filter((e) => e.type !== 'qa').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      // Keep provenance; do not recycle AI-generated QA as observations of the user.
      for (const [i, episode] of episodes.slice(0, 8).entries()) {
        auxiliary.push({ id: `E${i + 1}`, kind: 'learning', title: episode.title.slice(0, 120), at: episode.updatedAt,
          text: JSON.stringify({ type: episode.type, status: episode.status, score: episode.score,
            evidence: episode.evidenceSnippets?.slice(0, 5).map((e) => ({ type: e.type, source: e.source, text: e.text.slice(0, 500) })) }).slice(0, 3200), truncated: true });
      }
      snapshot.warnings.push('学习证据仅为最近 8 次非答疑活动的压缩记录，不是完整会话或全部学习史。');
    } catch { snapshot.warnings.push('学习活动证据读取失败。'); }
  }
  const pages = [...snapshot.pages];
  for (let i = 0; i < auxiliary.length; i += 8) pages.push({ page: pages.length, sources: auxiliary.slice(i, i + 8), edges: [] });
  if (!pages.length) return { ...result, answer: (result.budgetExhausted ? '本次认知查询预算已用完，尚未读取认知页面。' : cognitionUnavailable ? renderCognitionRecall() : snapshot.counts.currentNodes
    ? '已读取认知库，但没有找到符合本次主题或分类条件的已记录认知。这不代表你没有相关理解；尚未保存的草稿不作为个人认知。'
    : '个人认知库目前没有可用记录。保存复述或复习回答即可自动入库，无需逐条确认；上传资料和 AI 内容不会自动成为你的认知。') + `\n${snapshot.warnings.join('\n')}` };
  let start = 0;
  if (input.continuePage && input.cursor && input.cursor.fileRevision === snapshot.fileRevision && Number.isSafeInteger(input.cursor.nextPage)) {
    if (input.cursor.nextPage >= pages.length) return { ...result, answer: '该查询范围的页面已经读取完毕。你可以指定一个主题继续展开，或询问某条认知的历史变化。' };
    start = Math.max(0, input.cursor.nextPage);
  }
  else if (input.continuePage && input.cursor) snapshot.warnings.push('认知库已变化，已从新快照重新读取，未沿用旧分页。');
  const readPages: InquiryPage[] = [], exposed: InquirySource[] = [];
  const read = (page: number) => {
    const value = pages[page]; readPages.push(value); exposed.push(...value.sources);
    input.onStep?.({ call: { id: `inquiry-page-${page}`, name: 'read_cognition_page', arguments: { page } }, ok: true,
      result: { ...value, fileRevision: snapshot.fileRevision, totalPages: pages.length, counts: snapshot.counts } });
  };
  if (!reserveStep()) return { ...result, answer: '本次认知查询预算已用完，尚未读取认知页面。' };
  read(start);
  let accepted: ReturnType<typeof checkInquiryAnswer>['answer'];
  type Failure = InquiryAnswerError | 'invalid_json' | 'truncated' | 'request_failed' | 'invalid_page_request' | 'budget_exhausted';
  let failure: Failure | undefined, repairUsed = false;
  const failureLabels: Record<Failure, string> = {
    invalid_structure: '回答结构不符合要求', unknown_source: '回答引用了未读取的来源', quote_mismatch: '引文与来源原文不匹配',
    invalid_inline_citation: '正文引用与依据不一致', invalid_json: '模型没有返回可解析的结构化回答',
    unsupported_claim: '未确认素材不能用于判断认同或掌握状态',
    truncated: '模型输出被截断', request_failed: '模型服务调用失败', invalid_page_request: '模型请求了无效或超出本轮额度的页面',
    budget_exhausted: '本次认知查询预算已用完',
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    throwIfAgentAborted(input.signal);
    if (remainingRounds <= 0 || !reserveStep()) { result.budgetExhausted = true; break; }
    remainingRounds--;
    const nextPage = start + readPages.length < pages.length ? start + readPages.length : null;
    // A read response consumes this reserved step; leave one more slot/round
    // for an answer. An uncooperative model cannot bypass this prompt hint.
    const canReadMore = attempt < 3 && !repairUsed && remainingCalls > 0 && remainingRounds > 0;
    try {
      result.llmCalls++;
      const response = await input.callLlm({ providerId: '', model: '', workflow: 'agent-chat', skipMemoryInjection: true, skipProfileInjection: true,
        outputSchema: JSON_OBJECT_OUTPUT,
        systemPromptOverride: `${INQUIRY_PROMPT}\n\n${buildAgentReplyPolicy(replyRequest)}\n默认只生成 1 至 3 个简短 paragraphs；仅本轮明确要求详细时才按需要增加。evidence 始终逐字核验，不因回复简短而省略。`
          + (repairUsed ? '\n上次输出未通过格式或引用检查。请直接用已读来源返回 action=answer，最多三段短回答；逐字复制 evidence.quote，不要再次请求页面。' : ''),
        userInput: JSON.stringify({ question: input.question, mode: snapshot.mode, counts: snapshot.counts, graphSummary: snapshot.graphSummary, warnings: snapshot.warnings,
          fileRevision: snapshot.fileRevision, totalPages: pages.length, nextPage, canReadMore,
          ...(repairUsed ? { correction: failure } : {}), pages: readPages }) });
      throwIfAgentAborted(input.signal);
      result.promptTokens += response.usage?.promptTokens || 0; result.completionTokens += response.usage?.completionTokens || 0;
      let raw: unknown;
      if (response.diagnostics?.finishReason === 'length') failure = 'truncated';
      else {
        try { raw = response.parsedJson ?? JSON.parse(response.content.trim().replace(/^```(?:json)?\s*|\s*```$/gu, '')); }
        catch { failure = 'invalid_json'; }
        if (raw !== undefined) {
          const pageRequest = raw as { action?: string; page?: number } | null;
          if (pageRequest?.action === 'read') {
            if (canReadMore && nextPage !== null && pageRequest.page === nextPage) { read(nextPage); continue; }
            if (nextPage !== null && pageRequest.page === nextPage && (remainingCalls <= 0 || remainingRounds <= 0)) {
              result.budgetExhausted = true; failure = 'budget_exhausted';
            } else failure = 'invalid_page_request';
          } else {
            const checked = checkInquiryAnswer(raw, exposed); accepted = checked.answer; failure = checked.error;
          }
        }
      }
      input.onStep?.({ call: { id: `inquiry-answer-${attempt}`, name: 'synthesize_cognition_answer', arguments: { attempt: attempt + 1 } },
        ok: !!accepted, result: { code: accepted ? 'accepted' : failure, finishReason: response.diagnostics?.finishReason }, error: failure ? failureLabels[failure] : undefined });
      if (accepted) break;
      if (remainingCalls <= 0 || remainingRounds <= 0) { result.budgetExhausted = true; break; }
      if (!repairUsed && attempt < 3) { repairUsed = true; continue; }
      break;
    } catch {
      throwIfAgentAborted(input.signal); failure = 'request_failed';
      input.onStep?.({ call: { id: `inquiry-answer-${attempt}`, name: 'synthesize_cognition_answer', arguments: { attempt: attempt + 1 } }, ok: false,
        result: { code: failure }, error: failureLabels[failure] });
      break; // Do not automatically retry network, authentication, or billing failures.
    }
  }
  const used = accepted?.sources || exposed.slice(0, detailed ? 8 : 2);
  const nextPage = start + readPages.length;
  const coverage = `本次读取第 ${start + 1}–${nextPage} 页，共 ${pages.length} 页；${snapshot.mode === 'topic' ? '范围为相关论证结构，不是整库' : snapshot.mode === 'history' ? '包括当前与历史版本，不能混用立场' : '分类统计基于全部当前已记录认知'}。${nextPage < pages.length ? '尚有未读内容，可直接说“继续”。' : ''}`;
  const excerptLength = detailed ? 500 : 120;
  result.answer = accepted?.text || `已读取个人认知，但${failure ? failureLabels[failure] : '综合回答尚未完成'}${repairUsed ? failure === 'request_failed' ? '，修正请求未完成' : '，一次修正后仍未通过' : ''}。以下仅为原始记录节选，不是综合分析：\n\n${used.map((s) => `[${s.id}] ${plain(s.title)}：${plain(s.text.slice(0, excerptLength))}${s.text.length > excerptLength ? '（节选）' : ''}`).join('\n\n')}`;
  if (accepted && detailed) result.answer += `\n\n依据：\n${used.map((s) => `[${s.id}] ${plain(s.title)}${s.kind === 'cognition' ? ` · ${s.current ? '当前' : '历史'} · ${s.stance === 'endorsed' ? '认同' : '暂定'} · ${cognitionRoleLabel(s)}` : s.kind === 'material' ? ' · 认知素材（未确认立场）' : ' · 系统记录'}${s.at ? ` · ${s.at}` : ''}：“${plain(s.text.slice(0, 180))}”${s.text.length > 180 ? '（节选）' : ''}`).join('\n')}`;
  const sourceKinds = [...new Set(used.map((s) => s.kind === 'cognition' ? `已记录认知（${s.stance === 'endorsed' ? '认同' : '暂定'}${s.current ? '' : '，历史'}）` : s.kind === 'material' ? '认知素材（未确认立场，非事实依据）' : s.kind === 'profile' ? '画像评估（系统记录）' : '学习记录（系统记录）'))].join('、');
  const briefCoverage = `${sourceKinds}；本次读取第 ${start + 1}–${nextPage} 页，共 ${pages.length} 页，仅依据本次已读内容。${nextPage < pages.length ? '尚有未读内容，可说“继续”。' : ''}`;
  const importantWarnings = snapshot.warnings.filter((warning) => /读取失败|权限|新快照/u.test(warning));
  const partialNotice = used.some(source => source.conditionsTruncated) ? '部分适用条件已截断，不能据此判断完整适用范围。'
    : snapshot.warnings.some((warning) => /截断|最多|最近 8 次/u.test(warning)) ? '部分记录为节选，不代表全部学习史。' : '';
  result.answer += detailed
    ? `\n\n${coverage}\n${snapshot.warnings.join('\n')}\n本次只读，未修改认知或掌握度。`
    : `\n\n${briefCoverage}${partialNotice}${importantWarnings.join('')}`;
  if (detailed && snapshot.mode === 'overview' && !cognitionUnavailable) result.answer += `\n当前认知库共 ${snapshot.counts.records} 份结构、${snapshot.counts.currentNodes} 个认知块；当前认同 ${snapshot.counts.endorsedNodes} 个，暂定 ${snapshot.counts.tentative} 个。本次筛选 ${snapshot.counts.selectedNodes} 个。`;
  result.references = used.flatMap((s) => s.reference ? [s.reference] : []).slice(0, 32);
  result.citations = used.flatMap((s): AgentCitation[] => {
    if (s.kind !== 'material') return [];
    const hit = materials[Number(s.id.slice(1)) - 1];
    return hit ? [{ sourceId: s.id, type: 'note', entityId: hit.noteId,
      title: `认知素材（未确认立场） · ${hit.title}`, snippet: hit.text,
      matchKinds: hit.sourceKind === 'project-restatement' ? ['note'] : ['argument'],
      argumentHits: hit.argumentHits, relationSummary: hit.relationSummary }] : [];
  });
  result.cursor = { question: input.question.slice(0, 1000), fileRevision: snapshot.fileRevision, nextPage };
  if (cognitionUnavailable) { result.cursor = undefined; return result; }
  if (materials.some((hit) => !matchesCurrentSource(hit))) return { ...result,
    answer: '回答期间项目复述或论证图发生变化，请重新提问以读取最新素材。', references: [], citations: [], cursor: undefined };
  // A saved edit/forget during model generation invalidates this whole snapshot.
  try {
    if ((await loadPersonalCognition()).revision !== snapshot.fileRevision) return { ...result, answer: '回答期间认知库发生变化，请重新提问以读取最新版本。未沿用旧认知回答。', references: [], citations: [], cursor: undefined };
  } catch { return { ...result, answer: renderCognitionRecall(), references: [], citations: [], cursor: undefined }; }
  return result;
}

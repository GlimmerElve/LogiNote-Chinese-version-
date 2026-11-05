import type { ExpressionStyleKind } from '../../types';
import { buildReviewQueue, calculateRetrievability } from '../../services/reviewScheduler';
import { isProfileIndicatorTrusted } from '../../services/profile/profileTrust';
import { getNotes, getProfile, getEpisodes, readStyleSnapshot } from './store';
import { profileInquiryDetails } from '../../services/profile/inquiryDetails';
import type { AgentMasteryRequest, AgentMasteryRow, AgentReviewQueueItem } from './types';
import { masteryReadMode, readKnowledgeMastery } from '../../services/masteryReadModel';

const STYLE_LABELS: Record<ExpressionStyleKind, string> = {
  academic: '学术建构型', critical: '逻辑批判型', practical: '实用行动型', divergent: '发散探索型', objective: '客观陈述型',
};
const SCALE_NOTE = '数值基准：能力三项 0-100（50 为均值）；认知风格 -100~+100（0 为居中，正值偏向字段名那一极，负值偏向相反一极）';

export async function queryLearnerProfile(request: { includeEvidence?: boolean } = {}): Promise<{ text: string; details?: string[] }> {
  const profile = await getProfile();
  if (!profile || profile.analysisCount === 0) return { text: '尚未形成可用的长期用户画像。' };
  const parts: string[] = [];
  const abilities = [
    ['conceptClarity', '概念清晰度', profile.ability.conceptClarity],
    ['judgmentReasonableness', '判断合理性', profile.ability.judgmentReasonableness],
    ['reasoningValidity', '推理有效性', profile.ability.reasoningValidity],
  ] as const;
  const trustedAbilities = abilities.filter(([key]) => isProfileIndicatorTrusted(profile, 'ability', key));
  if (trustedAbilities.length) parts.push(trustedAbilities.map(([, label, value]) => `${label} ${value.toFixed(0)}`).join('，'));

  const cognitive = [
    ['abstractVsConcrete', '抽象偏向', profile.cognitiveStyle.abstractVsConcrete],
    ['systematicVsScattered', '系统偏向', profile.cognitiveStyle.systematicVsScattered],
    ['divergentVsConvergent', '发散偏向', profile.cognitiveStyle.divergentVsConvergent],
    ['cautiousVsDogmatic', '谨慎偏向', profile.cognitiveStyle.cautiousVsDogmatic],
    ['deepVsSurface', '深度偏向', profile.cognitiveStyle.deepVsSurface],
  ] as const;
  const trustedCognitive = cognitive.filter(([key]) => isProfileIndicatorTrusted(profile, 'cognitive_style', key));
  if (trustedCognitive.length) parts.push(`认知风格：${trustedCognitive.map(([, label, value]) => `${label} ${value.toFixed(0)}`).join('，')}`);

  const style = await readStyleSnapshot();
  const styleItems = Object.entries(style?.display || {})
    .map(([key, value]) => ({ label: STYLE_LABELS[key as ExpressionStyleKind], value: Number(value) || 0 }))
    .filter((item) => item.label && item.value >= 20)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3);
  if (styleItems.length) parts.push(`表达风格偏好：${styleItems.map((item) => `${item.label} ${item.value.toFixed(0)}`).join('，')}`);
  return { text: parts.length ? `${SCALE_NOTE}\n${parts.join('；')}` : '画像证据仍在积累，当前没有达到可信门槛的指标。',
    ...(request.includeEvidence === true ? { details: profileInquiryDetails(profile, await getEpisodes()) } : {}) };
}

export async function queryMastery(request: AgentMasteryRequest = {}): Promise<{ rows: AgentMasteryRow[] }> {
  const requested = new Set((request.noteTitles || []).map((title) => title.trim().toLocaleLowerCase()).filter(Boolean));
  const notes = (await getNotes()).filter((note) => note.noteType === 'knowledge');
  const selected = requested.size
    ? notes.filter((note) => requested.has(note.title.trim().toLocaleLowerCase()) || (note.aliases || []).some((alias) => requested.has(alias.trim().toLocaleLowerCase())))
    : notes;
  const rows = selected.map((note) => {
    const evidenceSamples = note.dsrState?.conceptMasterySamples || 0;
    const masteryState = readKnowledgeMastery(note);
    return {
      noteId: note.id,
      title: note.title,
      mastery: masteryReadMode() === 'legacy' && evidenceSamples >= 2 ? note.dsrState?.conceptMastery : undefined,
      historicalMastery: masteryState.historyScore ?? undefined,
      masteryState,
      evidenceSamples,
      retrievability: note.dsrState ? Math.round(calculateRetrievability(note.dsrState.stability, note.dsrState.lastReviewedAt) * 100) : 10,
      reviewCount: note.dsrState?.reviewCount || 0,
    };
  }).sort((a, b) => masteryReadMode() === 'current'
    ? b.masteryState.reviewPriority - a.masteryState.reviewPriority || a.title.localeCompare(b.title)
    : (a.mastery ?? -1) - (b.mastery ?? -1)).slice(0, 30);
  return { rows };
}

export async function getReviewQueue(): Promise<{ items: AgentReviewQueueItem[] }> {
  const notes = await getNotes();
  const notesById = new Map(notes.map((note) => [note.id, note]));
  const queue = buildReviewQueue(notes);
  return {
    items: queue.map((item) => {
      const evidenceSamples = notesById.get(item.noteId)?.dsrState?.conceptMasterySamples || 0;
      return {
        noteId: item.noteId,
        title: item.noteTitle,
        retrievability: Math.round(item.retrievability * 100),
        difficulty: item.difficulty,
        conceptMastery: evidenceSamples >= 2 ? item.conceptMastery : undefined,
        masteryState: notesById.has(item.noteId) ? readKnowledgeMastery(notesById.get(item.noteId)!) : undefined,
      };
    }),
  };
}

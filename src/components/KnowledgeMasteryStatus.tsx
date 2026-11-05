import type { NoteItem } from '../types';
import { readKnowledgeMastery, type MasteryReadOptions } from '../services/masteryReadModel';
import { MASTERY_SHADOW_LAYERS, MASTERY_SHADOW_STATE_LABELS, MASTERY_SHADOW_STATE_MARKERS } from '../services/masteryShadow/types';
import './KnowledgeMasteryDetails.css';

export function KnowledgeMasteryStatus({ note, options, compact = false }: { note: NoteItem; options?: MasteryReadOptions; compact?: boolean }) {
  const view = readKnowledgeMastery(note, options);
  const historicalWarning = (layer: typeof MASTERY_SHADOW_LAYERS[number]) => view.mode === 'current'
    && view.layers[layer] === 'needs_review' && view.legacyMigration?.activeLayers?.includes(layer)
    && !Object.values(note.dsrState?.masteryShadow?.layers?.[layer]?.criteria || {}).some(criterion => criterion.state === 'needs_review' || criterion.unresolvedFailures > 0);
  const label = (layer: typeof MASTERY_SHADOW_LAYERS[number]) => historicalWarning(layer) ? '历史待复核' : MASTERY_SHADOW_STATE_LABELS[view.layers[layer]];
  const description = (layer: typeof MASTERY_SHADOW_LAYERS[number]) => historicalWarning(layer)
    ? '旧评分的迁移估计，仍需独立验证；已记录的新表现不会因这个标签丢失，也不代表本次作答错误。' : undefined;
  if (compact) return <section className="knowledge-mastery-inline" aria-label={`${note.title}的掌握情况`}>
    {view.mode === 'current' ? MASTERY_SHADOW_LAYERS.map((layer, index) => <span key={layer}>
      <span>{['概念', '判断', '推理'][index]}</span>
      <span className={`knowledge-mastery-inline-state is-${view.layers[layer]}`} title={description(layer)}>
        <i aria-hidden="true">{MASTERY_SHADOW_STATE_MARKERS[view.layers[layer]]}</i>{label(layer)}
      </span>
    </span>) : <span>{view.displayLabel}</span>}
  </section>;
  return <section className="knowledge-mastery-status" aria-label={`${note.title}的掌握情况`}>
    <strong>{view.displayLabel}</strong>
    {view.mode === 'current' && <>
      <p>{view.summary}</p>
      <div className="knowledge-mastery-status-layers">
        {MASTERY_SHADOW_LAYERS.map((layer, index) => <div key={layer}>
          <span>{['概念', '判断', '推理'][index]}</span>
          <span className={`mastery-layer-marker is-${view.layers[layer]}`} aria-hidden="true">{MASTERY_SHADOW_STATE_MARKERS[view.layers[layer]]}</span>
          <strong className={`mastery-state is-${view.layers[layer]}`} title={description(layer)}>{label(layer)}</strong>
        </div>)}
      </div>
      <p>下一步：{view.nextAction}</p>
      {view.reviewCategory === 'verify' && view.assessmentStatus !== 'needs_review' && <small>新证据待核对，原有确认暂时保留。</small>}
      {view.contentStatus !== 'ready' && <small>资料待补全 · 与理解掌握分开记录</small>}
      {view.historyScore != null && <small>历史评分 {Math.round(view.historyScore)}% · 不换算为新确认状态</small>}
    </>}
  </section>;
}

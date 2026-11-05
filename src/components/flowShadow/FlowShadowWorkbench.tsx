import React, { useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, Check, ChevronRight, FileJson2, FlaskConical, GitBranch, Layers3, RotateCcw, ShieldCheck, Sparkles, X } from 'lucide-react';
import { createFlowShadowDemo } from '../../services/flowShadow/demo.ts';
import { prepareShadowAssessment, prepareShadowExtraction, replayShadowResponses } from '../../services/flowShadow/runner.ts';
import { buildShadowProfilePreview } from '../../services/flowShadow/profile.ts';
import { normalizeShadowInput, parseShadowExtraction } from '../../services/flowShadow/protocol.ts';
import { buildShadowReferencePacket, buildShadowReferenceTargets, parseShadowReferenceCandidates, sourcePriorityLabel } from '../../services/flowShadow/references.ts';
import { SHADOW_COGNITIVE_AXES, cognitiveDirectionLabel } from '../../services/flowShadow/profileAlignment.ts';
import { SHADOW_BEHAVIORS, SHADOW_CRITERIA, SHADOW_LAYER_LABELS } from '../../services/flowShadow/rubric.ts';
import type { ShadowAssessment, ShadowBehaviorCode, ShadowGraph, ShadowInput, ShadowIssue, ShadowLayer, ShadowNode, ShadowProfileMetric, ShadowRecord, ShadowRole } from '../../services/flowShadow/types.ts';
import './flowShadow.css';

type View = 'input' | 'assessment' | 'profile';
type Origin = 'synthetic' | 'manual';
type LedgerEntry = { record: ShadowRecord; origin: Origin };
type RequestPreview = ReturnType<typeof prepareShadowExtraction>;
type DiagramLink = { id: string; from: string[]; to: string; kind: 'support' | 'oppose' | 'context' | 'method_for' | 'relates'; reason: string };
const ROLES: Record<ShadowRole, string> = { claim: '主张', premise: '依据', background: '背景', method: '方法' };
const RELATIONS: Record<DiagramLink['kind'], string> = { support: '支持', oppose: '反对', context: '上下文', method_for: '方法来源', relates: '关联' };
const ASSISTANCE: Record<ShadowInput['assistance'], string> = { none: '独立表达', weak: '少量提示', strong: '较多辅助', unknown: '辅助程度未知' };
const FAMILIES: Record<ShadowInput['task']['family'], string> = { free_review: '自由复述', explanation: '概念解释', evaluation: '判断与评议', derivation: '推导与论证' };
const ISSUE_KINDS: Record<ShadowIssue['kind'], string> = { extraction: '抽取待核对', argument_gap: '论证缺口', confirmed_internal: '已定位内部错误', external_unverified: '外部事实未核实', asr_uncertain: '转写歧义' };
const CRITERION_STATES: Record<ShadowAssessment['criteria'][number]['state'], string> = { observed: '已观察', not_demonstrated: '任务要求尚未展示', not_applicable: '本次不适用', uncertain: '证据不足' };
const REFERENCE_STATES: Record<ShadowAssessment['referenceComparisons'][number]['state'], string> = {
  aligned: '一致', partially_aligned: '部分一致', misaligned: '不一致', conflicted: '来源冲突',
  insufficient_reference: '资料不足', not_applicable: '不适用',
};
const LAYERS: ShadowLayer[] = ['concept', 'judgment', 'reasoning'];

function json(value: unknown) { return JSON.stringify(value, null, 2); }
function readObject(raw: string): Record<string, any> {
  const parsed: unknown = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请粘贴完整的 JSON 对象。');
  return parsed as Record<string, any>;
}
function responseTexts(record: ShadowRecord) {
  const extraction = prepareShadowExtraction(record.input);
  const assessment = prepareShadowAssessment(record.input, record.graph, record.references);
  const inputKey = readObject(extraction.userInput).inputKey;
  const assessmentKeys = readObject(assessment.userInput);
  const graphKey = assessmentKeys.graphKey;
  const referenceKey = assessmentKeys.referenceKey;
  return {
    extract: json({ protocol: record.protocol, inputKey, graph: record.graph }),
    assess: json({ protocol: record.protocol, inputKey, graphKey, referenceKey, assessment: record.assessment }),
  };
}
function download(fileName: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([json(value)], { type: 'application/json;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = fileName; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function localDateTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
function profileDay(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}
function profileGroupLabel(key: string) {
  const [, family, dimension, , signature] = key.split(':');
  const taskLabel = FAMILIES[family as ShadowInput['task']['family']] || family;
  const criteria = dimension === 'ability' ? (signature || '').split('+').filter(Boolean)
    .map((id) => SHADOW_CRITERIA.find((item) => item.id === id)?.label || id) : [];
  return `任务类别：${taskLabel}${criteria.length ? ` · 可比判据：${criteria.join('、')}` : ''}`;
}
function behaviorStateLabel(code: ShadowBehaviorCode, behavior?: ShadowAssessment['behaviors'][number]) {
  if (!behavior) return '未提供';
  if (behavior.state === 'not_observed') return '未观察到';
  if (behavior.state === 'uncertain') return '待核对';
  const axis = SHADOW_COGNITIVE_AXES.find(item => item.behavior === code);
  return axis ? `已观察 · ${cognitiveDirectionLabel(axis, behavior.direction)}` : '已观察';
}
function profileMetricValue(metric: ShadowProfileMetric) {
  if (metric.value == null) return <strong className="fs-profile-value">—<small>不补 0</small></strong>;
  if (metric.scale === 'bipolar_-100_100') return <>
    <strong className="fs-profile-value">{metric.value > 0 ? '+' : ''}{metric.value}<small>/ ±100</small></strong>
    <div className="fs-bipolar-scale" aria-label={`${metric.poles?.negative || '负极'}到${metric.poles?.positive || '正极'}，当前${metric.value}`}>
      <span>{metric.poles?.negative}</span><i><b style={{ left: `${Math.max(0, Math.min(100, (metric.value + 100) / 2))}%` }} /></i><span>{metric.poles?.positive}</span>
    </div>
  </>;
  return <strong className="fs-profile-value">{metric.value}<small>/ 100{metric.scale === 'relative_0_100' ? ' 相对构成' : ''}</small></strong>;
}
function profileTrendLabel(metric: ShadowProfileMetric) {
  if (metric.trendDelta == null) return '正在建立基线';
  const delta = metric.trendDelta;
  const magnitude = Math.abs(delta);
  if (magnitude < 3) return metric.dimension === 'cognitive_style' || metric.dimension === 'expression_style' ? '近期稳定' : '基本稳定';
  const strong = magnitude >= 8 ? '明显' : '略微';
  if (metric.dimension === 'cognitive_style') return `${strong}向${delta > 0 ? metric.poles?.positive : metric.poles?.negative}侧移动`;
  if (metric.dimension === 'expression_style') return `${strong}${delta > 0 ? '增加' : '减少'}`;
  return `${strong}${delta > 0 ? '进步' : '下降'}`;
}
function profilePositionLabel(metric: ShadowProfileMetric) {
  if (metric.value == null || metric.scale !== 'bipolar_-100_100') return null;
  if (Math.abs(metric.value) <= 15) return '当前两侧均衡';
  return `当前${Math.abs(metric.value) > 40 ? '明显偏' : '略偏'}${metric.value > 0 ? metric.poles?.positive : metric.poles?.negative}`;
}
function profileMetricDynamics(metric: ShadowProfileMetric) {
  if (metric.value == null) return null;
  const recent = metric.observations.slice(-5);
  return <div className="fs-profile-dynamics">
    <div className={`fs-trend ${metric.trendDelta == null || Math.abs(metric.trendDelta) < 3 ? 'is-stable' : metric.trendDelta > 0 ? 'is-rising' : 'is-falling'}`}>
      <strong>{profileTrendLabel(metric)}</strong><span>{metric.trendDelta == null ? '—' : `${metric.trendDelta > 0 ? '+' : ''}${metric.trendDelta}`}</span>
    </div>
    {profilePositionLabel(metric) && <p className="fs-position-label">{profilePositionLabel(metric)}</p>}
    <dl><div><dt>慢速基线</dt><dd>{metric.baselineValue ?? '—'}</dd></div><div><dt>历史均值</dt><dd>{metric.historicalMean ?? '—'}</dd></div></dl>
    <div className="fs-recent-values" aria-label="最近五次有效观察"><span>最近</span>{recent.map(item => <i key={item.attemptId} title={`${item.attemptId} · ${item.observedAt}`}>{item.value}</i>)}</div>
  </div>;
}
function linksFor(graph: ShadowGraph): DiagramLink[] {
  return [
    ...graph.arguments.flatMap((argument) => (['support', 'oppose'] as const).flatMap((kind) => argument[kind].length ? [{
      id: `${argument.id}:${kind}`, from: argument[kind], to: argument.claim, kind,
      reason: argument[kind].length > 1 ? '此组依据联合使用；各分支不是独立充分证明。' : '依据指向主张。',
    }] : [])),
    ...graph.relations.map((relation) => ({ ...relation, from: [relation.from] })),
  ];
}
function graphPlacement(graph: ShadowGraph, links: DiagramLink[]) {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const next = new Map(graph.nodes.map((node) => [node.id, new Set<string>()]));
  const degree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const ranks = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const link of links.filter((edge) => edge.kind === 'support' || edge.kind === 'oppose')) {
    for (const from of link.from) if (ids.has(from) && ids.has(link.to) && from !== link.to && !next.get(from)!.has(link.to)) {
      next.get(from)!.add(link.to); degree.set(link.to, degree.get(link.to)! + 1);
    }
  }
  const queue = graph.nodes.filter((node) => !degree.get(node.id)).map((node) => node.id);
  for (let i = 0; i < queue.length; i++) for (const target of next.get(queue[i])!) {
    ranks.set(target, Math.max(ranks.get(target)!, ranks.get(queue[i])! + 1));
    degree.set(target, degree.get(target)! - 1);
    if (!degree.get(target)) queue.push(target);
  }
  // Cycles remain visible; this placement never edits or certifies the graph.
  const columns = new Map<number, ShadowNode[]>();
  for (const node of graph.nodes) {
    const rank = ranks.get(node.id)!;
    columns.set(rank, [...(columns.get(rank) || []), node]);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [rank, nodes] of columns) nodes.forEach((node, index) => positions.set(node.id, { x: 30 + rank * 380, y: 42 + index * 162 }));
  return { positions, width: Math.max(660, ...[...columns.keys()].map((rank) => 340 + rank * 380)),
    height: Math.max(280, ...[...columns.values()].map((nodes) => nodes.length * 162 + 48)) };
}

function GraphDiagram({ graph, nodeId, relationId, onSelectNode }: {
  graph: ShadowGraph; nodeId: string; relationId: string; onSelectNode: (id: string) => void;
}) {
  const links = useMemo(() => linksFor(graph), [graph]);
  const layout = useMemo(() => graphPlacement(graph, links), [graph, links]);
  const active = links.find((link) => link.id === relationId);
  const focused = new Set(active ? [...active.from, active.to] : []);
  return <div className="fs-diagram-scroll" tabIndex={0} aria-label="论证图，可滚动；下方节点和关系列表提供完整文本">
    <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label="四角色、五关系候选图">
      <title>论证候选结构；联合依据分支汇合后指向同一主张</title>
      <defs>{Object.keys(RELATIONS).map((kind) => <marker key={kind} id={`fs-arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className={`fs-arrow fs-link-${kind}`} /></marker>)}</defs>
      {links.map((link) => {
        const target = layout.positions.get(link.to);
        if (!target) return null;
        const sources = link.from.flatMap((id) => { const point = layout.positions.get(id); return point ? [point] : []; });
        const joint = sources.length > 1;
        const hub = { x: target.x - 46, y: target.y + 60 };
        const dimmed = relationId ? relationId !== link.id : nodeId ? ![...link.from, link.to].includes(nodeId) : false;
        return <g key={link.id} className={`fs-graph-link fs-link-${link.kind}${dimmed ? ' is-dimmed' : ''}${relationId === link.id ? ' is-selected' : ''}`}>
          <title>{`${link.id} · ${link.from.join(' + ')} → ${link.to} · ${RELATIONS[link.kind]}${joint ? '（联合依据）' : ''}`}</title>
          {sources.map((source, index) => {
            const sx = source.x + 260, sy = source.y + 60, tx = joint ? hub.x : target.x, ty = target.y + 60;
            const curve = Math.max(42, Math.abs(tx - sx) * .45);
            return <path key={index} d={`M ${sx} ${sy} C ${sx + curve} ${sy}, ${tx - curve} ${ty}, ${tx} ${ty}`} markerEnd={joint ? undefined : `url(#fs-arrow-${link.kind})`} />;
          })}
          {joint && <><path d={`M ${hub.x} ${hub.y} L ${target.x} ${hub.y}`} markerEnd={`url(#fs-arrow-${link.kind})`} /><circle cx={hub.x} cy={hub.y} r="5" /></>}
          <text x={target.x - 12} y={target.y + 42} textAnchor="end">{joint ? `联合${RELATIONS[link.kind]} ×${sources.length}` : RELATIONS[link.kind]}</text>
        </g>;
      })}
      {graph.nodes.map((node) => {
        const position = layout.positions.get(node.id)!;
        const dimmed = active && !focused.has(node.id);
        return <foreignObject key={node.id} x={position.x} y={position.y} width="260" height="120" className={dimmed ? 'fs-node-dimmed' : undefined}>
          <button type="button" className={`fs-graph-node fs-role-${node.role}${nodeId === node.id ? ' is-selected' : ''}`} onClick={() => onSelectNode(node.id)} aria-pressed={nodeId === node.id} title={`${node.id} · ${ROLES[node.role]}：${node.text}`}>
            <span className="fs-node-top"><span>{node.id}</span><span className="fs-role-label">{ROLES[node.role]}</span></span>
            <span className="fs-node-body">{node.text}</span>
          </button>
        </foreignObject>;
      })}
    </svg>
  </div>;
}

function SourceQuote({ rawText, quote }: { rawText: string; quote?: string }) {
  const index = quote ? rawText.indexOf(quote) : -1;
  if (!quote || index < 0) return <p className="fs-source-text">{rawText}</p>;
  return <p className="fs-source-text">{rawText.slice(0, index)}<mark>{quote}</mark>{rawText.slice(index + quote.length)}</p>;
}

export function FlowShadowWorkbench() {
  const [initial] = useState(() => createFlowShadowDemo());
  const [record, setRecord] = useState<ShadowRecord>(initial);
  const [input, setInput] = useState<ShadowInput>(() => structuredClone(initial.input));
  const [draftGraph, setDraftGraph] = useState<ShadowGraph>(() => structuredClone(initial.graph));
  const [extractRaw, setExtractRaw] = useState(() => responseTexts(initial).extract);
  const [referenceRaw, setReferenceRaw] = useState(() => json(initial.references.items));
  const [assessRaw, setAssessRaw] = useState(() => responseTexts(initial).assess);
  const [origin, setOrigin] = useState<Origin>('synthetic');
  const [view, setView] = useState<View>('assessment');
  const [selectedNode, setSelectedNode] = useState(initial.graph.nodes[0]?.id || '');
  const [selectedRelation, setSelectedRelation] = useState('');
  const [selectedEvidence, setSelectedEvidence] = useState('');
  const [requestPreview, setRequestPreview] = useState<RequestPreview | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('合成示例已载入。所有观察与分数仅用于验证试验流程。');
  const evidenceRef = useRef<HTMLElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const graphDirty = json(draftGraph) !== json(record.graph);
  const inputDirty = json(input) !== json(record.input);
  const profile = useMemo(() => buildShadowProfilePreview(ledger.map((entry) => entry.record)), [ledger]);
  const links = useMemo(() => linksFor(draftGraph), [draftGraph]);
  const node = draftGraph.nodes.find((item) => item.id === selectedNode);
  const relation = links.find((item) => item.id === selectedRelation);
  const evidence = record.assessment.evidence.find((item) => item.id === selectedEvidence);
  const requestKeys = requestPreview ? readObject(requestPreview.userInput) : null;
  const latestLedger = useMemo(() => {
    const latest = new Map<string, LedgerEntry>();
    for (const entry of ledger) {
      const previous = latest.get(entry.record.input.attemptId);
      if (!previous || previous.record.input.assessmentRevision <= entry.record.input.assessmentRevision) latest.set(entry.record.input.attemptId, entry);
    }
    return [...latest.values()];
  }, [ledger]);

  const reportError = (cause: unknown) => {
    setError(cause instanceof Error ? cause.message : '本地处理未完成，请检查输入。');
    window.requestAnimationFrame(() => errorRef.current?.focus());
  };
  const updateInput = (patch: Partial<ShadowInput>) => { setInput((current) => ({ ...current, ...patch })); setRequestPreview(null); setError(''); };
  const updateTask = (patch: Partial<ShadowInput['task']>) => updateInput({ task: { ...input.task, ...patch } });
  const previewRequest = (stage: 'extract' | 'assess') => {
    setError('');
    try {
      if (stage === 'extract') setRequestPreview(prepareShadowExtraction(input));
      else {
        const normalizedInput = normalizeShadowInput(input);
        const response = parseShadowExtraction(extractRaw, normalizedInput);
        const targets = buildShadowReferenceTargets(response.graph);
        const candidates = parseShadowReferenceCandidates(JSON.parse(referenceRaw), targets);
        const references = buildShadowReferencePacket(normalizedInput, response.graph, candidates);
        setRequestPreview(prepareShadowAssessment(normalizedInput, response.graph, references));
      }
      setNotice(`阶段 ${stage === 'extract' ? '1' : '2'} 请求已在本地生成，尚未发送。`);
    } catch (cause) { reportError(cause); }
  };
  const replay = () => {
    setError('');
    try {
      const normalizedInput = normalizeShadowInput(input);
      const extracted = parseShadowExtraction(extractRaw, normalizedInput);
      const targets = buildShadowReferenceTargets(extracted.graph);
      const candidates = parseShadowReferenceCandidates(JSON.parse(referenceRaw), targets);
      const references = buildShadowReferencePacket(normalizedInput, extracted.graph, candidates);
      const next = replayShadowResponses(normalizedInput, extractRaw, assessRaw, references);
      const initialTexts = responseTexts(initial);
      const synthetic = json(next.input) === json(initial.input) && extractRaw === initialTexts.extract && assessRaw === initialTexts.assess;
      setRecord(next); setInput(structuredClone(next.input)); setDraftGraph(structuredClone(next.graph));
      setOrigin(synthetic ? 'synthetic' : 'manual'); setSelectedNode(next.graph.nodes[0]?.id || ''); setSelectedRelation(''); setSelectedEvidence('');
      setView('assessment'); setNotice('本地回放完成。未发起模型请求；尚未纳入模拟画像。');
    } catch (cause) { reportError(cause); }
  };
  const loadDemo = () => {
    const next = createFlowShadowDemo(); const texts = responseTexts(next);
    setRecord(next); setInput(structuredClone(next.input)); setDraftGraph(structuredClone(next.graph));
    setExtractRaw(texts.extract); setReferenceRaw(json(next.references.items)); setAssessRaw(texts.assess); setOrigin('synthetic'); setError(''); setRequestPreview(null);
    setSelectedNode(next.graph.nodes[0]?.id || ''); setSelectedRelation(''); setSelectedEvidence('');
    setNotice('已恢复合成示例；模拟台账仍保留在本页内存中。');
  };
  const showEvidence = (id: string) => {
    setSelectedEvidence(id);
    window.requestAnimationFrame(() => { evidenceRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }); evidenceRef.current?.focus({ preventScroll: true }); });
  };
  const evidenceButtons = (ids: string[]) => ids.length ? <div className="fs-evidence-links">{ids.map((id) => <button type="button" key={id} onClick={() => showEvidence(id)}>原文 {id}<ChevronRight size={12} aria-hidden="true" /></button>)}</div> : <span className="fs-muted fs-small">未提供原文证据</span>;
  const addToLedger = () => {
    setLedger((current) => [...current, { record: structuredClone(record), origin }]);
    setNotice(`已将 ${record.input.attemptId} · r${record.input.assessmentRevision} 加入模拟台账。按尝试采用最新修订，同修订冲突会显式提示。`);
  };
  const loadTemporalDemo = () => {
    const configs = [
      { id: 'trend-demo-1', at: '2026-10-11T09:00:00+08:00', task: 'trend-task-1', level: 1, direction: -1 as const, expressions: ['evidence_description'] as ShadowBehaviorCode[] },
      { id: 'trend-demo-2', at: '2026-10-12T09:00:00+08:00', task: 'trend-task-2', level: 2, direction: 0 as const, expressions: ['evidence_description', 'concept_framing'] as ShadowBehaviorCode[] },
      { id: 'trend-demo-3', at: '2026-10-13T09:00:00+08:00', task: 'trend-task-2', level: 3, direction: 1 as const, expressions: ['concept_framing', 'mechanism_explanation'] as ShadowBehaviorCode[] },
      { id: 'trend-demo-4', at: '2026-10-15T09:00:00+08:00', task: 'trend-task-3', level: 4, direction: 2 as const, expressions: ['concept_framing', 'mechanism_explanation', 'comparison_review'] as ShadowBehaviorCode[] },
    ];
    const entries = configs.map((config) => {
      const next = structuredClone(initial);
      next.input.attemptId = config.id; next.input.observedAt = config.at; next.input.task.id = config.task;
      next.assessment.criteria.forEach(item => { item.level = config.level; item.state = 'observed'; });
      next.assessment.referenceComparisons.forEach(item => { item.level = config.level; item.state = config.level >= 3 ? 'aligned' : 'partially_aligned'; });
      next.assessment.behaviors = [
        ...config.expressions.map(code => ({ code, state: 'observed' as const, direction: null, evidenceIds: ['E1'], reason: '合成趋势样本，仅用于检验动态聚合显示。' })),
        { code: 'uncertainty_calibration' as const, state: 'observed' as const, direction: config.direction, evidenceIds: ['E7'], reason: '合成趋势方向，仅用于检验双极迁移显示。' },
      ];
      return { record: next, origin: 'synthetic' as const };
    });
    setLedger(entries); setNotice('已载入4次纯合成趋势样本，用于查看当前值、慢速基线、历史均值和方向迁移；正式数据未改动。');
  };

  return <div className="flow-shadow-workbench">
    <a className="fs-skip" href="#fs-main">跳到试验内容</a>
    <header className="fs-topbar"><a className="fs-brand" href="#fs-main"><span className="fs-brand-mark"><Layers3 size={20} aria-hidden="true" /></span>LogiNote <span className="fs-brand-divider" /> <span className="fs-lab-label">实验室</span></a>
      <div className="fs-top-actions"><span className="fs-local-pill"><span />纯本地 · 零写入</span><button type="button" className="fs-button" onClick={() => download(`flow-shadow-${record.input.attemptId.replace(/[^a-zA-Z0-9_-]/gu, '_')}.json`, record)}><ArrowDownToLine size={16} aria-hidden="true" />导出 ShadowRecord</button></div>
    </header>
    <main id="fs-main" className="fs-main">
      <section className="fs-hero"><div><div className="fs-eyebrow"><FlaskConical size={14} aria-hidden="true" /> FLOW SHADOW / 01</div><h1>从原话到论证，<br />每一步都有依据。</h1><p>四角色结构、三层表现与长期观察的隔离试验。<br className="fs-desktop-break" />先核对本次证据，再查看模拟聚合如何变化。</p></div><div className="fs-hero-note"><span className="fs-note-number">02</span><div>个模型请求阶段<br /><span>一次抽取 · 一次证据评价</span></div><p>此页只预览请求、回放手动响应。<br />真实 LLM 实测需另行授权。</p></div></section>
      <div className={`fs-safety-banner ${origin === 'synthetic' ? 'is-synthetic' : ''}`}><FlaskConical size={19} aria-hidden="true" /><div><strong>{origin === 'synthetic' ? '当前为合成示例，不是 LLM 实测结果' : '当前为手动导入响应，来源未经在线核验'}</strong><span>影子量规尚未校准。正式笔记、画像、掌握度、周报与 RAG 均不写入；刷新后本页状态清空。</span></div><span className="fs-shadow-tag">SHADOW</span></div>
      <nav className="fs-view-nav" aria-label="试验视图">{([
        ['input', '01', '输入与请求', FileJson2], ['assessment', '02', '本次评估', GitBranch], ['profile', '03', '模拟画像', Sparkles],
      ] as const).map(([key, number, label, Icon]) => <button type="button" key={key} aria-current={view === key ? 'page' : undefined} className={view === key ? 'is-active' : ''} onClick={() => { setView(key); setError(''); }}><span>{number}</span><Icon size={16} aria-hidden="true" />{label}{key === 'profile' && ledger.length > 0 && <small>{profile.attempts}</small>}</button>)}<button type="button" className="fs-demo-reset" onClick={loadDemo}><RotateCcw size={14} aria-hidden="true" />恢复示例</button></nav>
      <div className="fs-status" role="status" aria-live="polite"><Check size={14} aria-hidden="true" />{notice}</div>
      {error && <div ref={errorRef} tabIndex={-1} className="fs-error" role="alert"><strong>本地校验未通过</strong><p>{error}</p><span>响应文本已保留，可修正后再次回放。</span></div>}

      {view === 'input' && <div className="fs-input-layout">
        <section className="fs-panel"><div className="fs-panel-heading"><div><span className="fs-kicker">SOURCE</span><h2>本次表达与任务</h2></div>{inputDirty && <span className="fs-state-tag">待回放输入</span>}</div>
          <form onSubmit={(event) => { event.preventDefault(); previewRequest('extract'); }} className="fs-form">
            <label htmlFor="fs-raw">口语原文 <span>最多 3999 字，保持原始说法</span></label><textarea id="fs-raw" className="fs-raw-input" value={input.rawText} onChange={(event) => updateInput({ rawText: event.target.value })} rows={9} aria-describedby="fs-raw-help" /><small id="fs-raw-help" className="fs-field-help">{[...input.rawText].length} / 3999 字。粘贴自己的转写；此页不会上传或自动保存。</small>
            <label htmlFor="fs-goal">真实任务目标</label><textarea id="fs-goal" value={input.task.goal} onChange={(event) => updateTask({ goal: event.target.value })} rows={3} placeholder="例如：解释本次数据能支持哪些结论，以及适用条件。" />
            <div className="fs-field-grid"><label htmlFor="fs-attempt">尝试编号<input id="fs-attempt" value={input.attemptId} onChange={(event) => updateInput({ attemptId: event.target.value })} /></label><label htmlFor="fs-revision">评估修订号<input id="fs-revision" type="number" min={1} step={1} value={input.assessmentRevision} onChange={(event) => updateInput({ assessmentRevision: Number(event.target.value) })} /></label><label htmlFor="fs-task-id">任务编号<input id="fs-task-id" value={input.task.id} onChange={(event) => updateTask({ id: event.target.value })} /></label><label htmlFor="fs-observed">表达时间（本地时区）<input id="fs-observed" type="datetime-local" value={localDateTime(input.observedAt)} onChange={(event) => { if (event.target.value) updateInput({ observedAt: new Date(event.target.value).toISOString() }); }} /></label><label htmlFor="fs-family">任务类别<select id="fs-family" value={input.task.family} onChange={(event) => updateTask({ family: event.target.value as ShadowInput['task']['family'] })}>{Object.entries(FAMILIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label htmlFor="fs-assistance">辅助程度<select id="fs-assistance" value={input.assistance} onChange={(event) => updateInput({ assistance: event.target.value as ShadowInput['assistance'] })}>{Object.entries(ASSISTANCE).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
            <div className="fs-attempt-help"><p className="fs-field-help">同一尝试的原文、任务、辅助程度和表达时间保持固定。仅重评时增加修订号；修改源内容请使用新尝试编号，并重新生成两阶段请求 key。</p><button type="button" className="fs-button" onClick={() => { updateInput({ attemptId: `local-${crypto.randomUUID()}`, assessmentRevision: 1 }); setNotice('已生成新尝试编号；请保留真实表达时间，并按新 inputKey 提供两阶段响应。'); }}>生成新尝试编号</button></div>
            <fieldset><legend>任务明确要求的层面</legend><p className="fs-field-help">仅勾选任务确实要求的层面，未勾选不代表表现不足。</p><div className="fs-checks">{LAYERS.map((layer) => <label key={layer}><input type="checkbox" checked={input.task.requiredLayers.includes(layer)} onChange={(event) => updateTask({ requiredLayers: event.target.checked ? [...input.task.requiredLayers, layer] : input.task.requiredLayers.filter((item) => item !== layer) })} />{SHADOW_LAYER_LABELS[layer]}</label>)}</div></fieldset>
            <details className="fs-details"><summary>任务已提示的表达或策略行为</summary><p className="fs-field-help">被任务指定的动作不能直接当作自发长期偏好。</p><div className="fs-checks fs-checks-wrap">{SHADOW_BEHAVIORS.map((behavior) => <label key={behavior.code}><input type="checkbox" checked={input.task.promptedBehaviors.includes(behavior.code)} onChange={(event) => updateTask({ promptedBehaviors: event.target.checked ? [...input.task.promptedBehaviors, behavior.code] : input.task.promptedBehaviors.filter((item) => item !== behavior.code) as ShadowBehaviorCode[] })} />{behavior.label}</label>)}</div></details>
            <button className="fs-button is-primary" type="submit">预览阶段 1 请求<ArrowRight size={16} aria-hidden="true" /></button>
          </form>
        </section>
        <div className="fs-request-column"><section className="fs-panel"><div className="fs-panel-heading"><div><span className="fs-kicker">TWO-STAGE REPLAY</span><h2>响应回放</h2></div><span className="fs-state-tag">网络发送已禁用</span></div><p className="fs-panel-copy">粘贴两阶段响应和本地检索候选。inputKey、graphKey、referenceKey共同绑定本次输入、图和资料包。</p>
          <label className="fs-response-label" htmlFor="fs-extract-response"><span>1</span>论证抽取响应</label><textarea id="fs-extract-response" className="fs-json-input" rows={9} spellCheck={false} value={extractRaw} onChange={(event) => { setExtractRaw(event.target.value); setRequestPreview(null); }} />
          <label className="fs-response-label" htmlFor="fs-reference-candidates"><span>R</span>本地参考候选</label><textarea id="fs-reference-candidates" className="fs-json-input" rows={8} spellCheck={false} value={referenceRaw} onChange={(event) => { setReferenceRaw(event.target.value); setRequestPreview(null); }} /><small className="fs-field-help">仅接受带来源、定位、优先级和正文的候选；LLM既有知识不会进入正式证据包。</small>
          <button type="button" className="fs-button fs-full" onClick={() => previewRequest('assess')}>按此图预览阶段 2 请求<ArrowRight size={15} aria-hidden="true" /></button>
          <label className="fs-response-label" htmlFor="fs-assess-response"><span>2</span>证据评价响应</label><textarea id="fs-assess-response" className="fs-json-input" rows={9} spellCheck={false} value={assessRaw} onChange={(event) => setAssessRaw(event.target.value)} />
          <button type="button" className="fs-button is-primary fs-full" onClick={replay}>校验并在本地回放<ArrowRight size={16} aria-hidden="true" /></button>
        </section>
        <section className="fs-panel fs-request-preview"><div className="fs-panel-heading"><div><span className="fs-kicker">REQUEST PREVIEW</span><h2>{requestPreview ? `阶段 ${requestPreview.stage === 'extract' ? '1 · 抽取' : '2 · 评价'}` : '请求尚未生成'}</h2></div>{requestPreview && <button type="button" className="fs-icon-button" aria-label="下载当前请求 JSON" onClick={() => download(`flow-shadow-${requestPreview.stage}-request.json`, requestPreview)}><ArrowDownToLine size={18} aria-hidden="true" /></button>}</div>
          {requestPreview ? <><dl className="fs-key-list"><div><dt>promptId</dt><dd>{requestPreview.promptId}</dd></div><div><dt>inputKey</dt><dd>{requestKeys?.inputKey}</dd></div>{requestKeys?.graphKey && <div><dt>graphKey</dt><dd>{requestKeys.graphKey}</dd></div>}{requestKeys?.referenceKey && <div><dt>referenceKey</dt><dd>{requestKeys.referenceKey}</dd></div>}</dl><details className="fs-details"><summary>系统提示词</summary><pre>{requestPreview.systemPrompt}</pre></details><details className="fs-details" open><summary>输入 JSON</summary><pre>{requestPreview.userInput}</pre></details><p className="fs-field-help">这些 key 是本地一致性标记，不是来源或语义认证。</p></> : <p className="fs-panel-copy">先生成阶段 1 请求；完成抽取响应和本地资料候选后，再预览阶段 2。按钮仅在本地准备内容。</p>}
        </section></div>
      </div>}

      {view === 'assessment' && <>
        {inputDirty && <div className="fs-pending-input" role="status">输入已修改，以下仍是上次回放结果。完成两阶段响应回放后才会更新本次评估。</div>}
        <div className="fs-result-heading"><div><span className="fs-kicker">THIS ATTEMPT</span><h2>本次表达，已经展示了什么？</h2><p>{record.assessment.summary || '尚未提供总结。'}</p></div><div className="fs-attempt-meta"><span>{record.input.attemptId} · r{record.input.assessmentRevision}</span><small>{FAMILIES[record.input.task.family]} · {ASSISTANCE[record.input.assistance]}</small></div></div>
        <section className="fs-score-grid" aria-label="本次三层证据评价">{LAYERS.map((layer, index) => {
          const score = record.scoring.layers.find((item) => item.layer === layer);
          return <article className="fs-score-card" key={layer}><div className="fs-score-top"><span>0{index + 1} / {SHADOW_LAYER_LABELS[layer]}</span><span className="fs-state-tag">{score?.score == null ? '证据不足' : '试验分数'}</span></div><div className="fs-score-value">{score?.score == null ? '—' : score.score}<small>{score?.score == null ? '未给分' : '/ 100'}</small></div>{score?.score != null && <meter min={0} max={100} value={score.score} aria-label={`${SHADOW_LAYER_LABELS[layer]}试验分数`} />}<p>已评分 {score?.scored ?? 0} / 适用 {score?.applicable ?? 0} 项 · {score?.evidenceCount ?? 0} 条证据</p><span className="fs-score-reason">{score?.reasons.join('；') || '仅评本次表达，不能代表长期能力或知识掌握。'}</span></article>;
        })}</section>
        <section className="fs-panel fs-reference-panel"><div className="fs-panel-heading"><div><span className="fs-kicker">REFERENCE CHECK</span><h2>资料一致性 <span className="fs-heading-count">与内部质量分开</span></h2></div><span className="fs-state-tag">1 → 2 → 3级来源</span></div>
          <p className="fs-panel-copy">先用项目正文/教材，再用项目关联资源，最后用关联知识点。LLM既有知识只可提出待核对项，不能计分。</p>
          <div className="fs-score-grid" aria-label="三层资料一致性评价">{LAYERS.map((layer, index) => {
            const score = record.referenceScoring.layers.find((item) => item.layer === layer);
            return <article className="fs-score-card" key={layer}><div className="fs-score-top"><span>R{index + 1} / {SHADOW_LAYER_LABELS[layer]}</span><span className="fs-state-tag">{score?.score == null ? '资料不足' : '对照分'}</span></div><div className="fs-score-value">{score?.score == null ? '—' : score.score}<small>{score?.score == null ? '不补分' : '/ 100'}</small></div>{score?.score != null && <meter min={0} max={100} value={score.score} aria-label={`${SHADOW_LAYER_LABELS[layer]}资料一致性`} />}<p>已对照 {score?.scoredTargets ?? 0} / 可评价 {score?.evaluableTargets ?? 0} 个目标</p><span className="fs-score-reason">{score?.reasons.join('；') || '有用户原话与可定位资料共同支持。'}</span></article>;
          })}</div>
          <div className="fs-reference-grid">{record.references.targets.map((target) => {
            const selection = record.references.selection.find((item) => item.targetId === target.id);
            const comparison = record.assessment.referenceComparisons.find((item) => item.targetId === target.id);
            const items = (selection?.itemIds || []).flatMap((id) => { const item = record.references.items.find((candidate) => candidate.id === id); return item ? [item] : []; });
            return <article key={target.id} className="fs-reference-target"><div><span className="fs-kicker">{target.id}</span><strong>{SHADOW_LAYER_LABELS[target.layer]}对照</strong><span className="fs-state-tag">{comparison ? REFERENCE_STATES[comparison.state] : '未评价'}{comparison?.level == null ? '' : ` · ${comparison.level}/4`}</span></div><p>{target.query}</p>{items.length ? <ul>{items.map((item) => <li key={item.id}><span>{sourcePriorityLabel(item.tier)}</span><strong>{item.title}</strong><small>{item.locator}</small><blockquote>{item.text}</blockquote></li>)}</ul> : <p className="fs-warning-copy">没有一级至三级可引用资料；不得由LLM常识补分。</p>}{comparison?.reason && <p className="fs-field-help">判定：{comparison.reason}</p>}</article>;
          })}</div>
          {record.references.gaps.length > 0 && <details className="fs-details"><summary>不可用或降级来源 · {record.references.gaps.length} 项</summary><ul>{record.references.gaps.map((gap, index) => <li key={`${gap.targetId}:${gap.sourceId}:${index}`}><strong>{gap.targetId} · {sourcePriorityLabel(gap.tier)}</strong>：{gap.reason}</li>)}</ul></details>}
        </section>
        <section className="fs-panel fs-graph-panel"><div className="fs-panel-heading"><div><span className="fs-kicker">ARGUMENT MAP</span><h2>论证候选图 <span className="fs-heading-count">{draftGraph.nodes.length} 节点 · {links.length} 组关系</span></h2></div><span className={`fs-state-tag ${graphDirty ? 'is-amber' : ''}`}>{graphDirty ? '草稿已修改 · 未重评' : '影子图 · 未认证'}</span></div>
          <p className="fs-panel-copy">点击节点核对内容，点击关系列表查看整组依据。此处仅试编节点文本与角色，评估和模拟画像始终使用导入时的原始图。</p><div className="fs-graph-legend">{Object.entries(ROLES).map(([role, label]) => <span key={role} className={`fs-role-legend fs-role-${role}`}><i />{label}</span>)}<span className="fs-legend-divider" />{Object.entries(RELATIONS).map(([kind, label]) => <span key={kind} className={`fs-relation-legend fs-link-${kind}`}><i />{label}</span>)}</div>
          <div className="fs-graph-layout"><GraphDiagram graph={draftGraph} nodeId={selectedNode} relationId={selectedRelation} onSelectNode={(id) => { setSelectedNode(id); setSelectedRelation(''); }} /><aside className="fs-node-inspector" aria-label="节点草稿与直接关系"><label htmlFor="fs-selected-node">核对节点<select id="fs-selected-node" value={selectedNode} onChange={(event) => { setSelectedNode(event.target.value); setSelectedRelation(''); }}>{draftGraph.nodes.map((item) => <option value={item.id} key={item.id}>{item.id} · {ROLES[item.role]} · {item.text.slice(0, 20)}</option>)}</select></label>
            {node && <><label htmlFor="fs-node-role">本次草稿角色<select id="fs-node-role" value={node.role} onChange={(event) => setDraftGraph((current) => ({ ...current, nodes: current.nodes.map((item) => item.id === node.id ? { ...item, role: event.target.value as ShadowRole } : item) }))}>{Object.entries(ROLES).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label htmlFor="fs-node-text">本次草稿文本<textarea id="fs-node-text" rows={4} value={node.text} onChange={(event) => setDraftGraph((current) => ({ ...current, nodes: current.nodes.map((item) => item.id === node.id ? { ...item, text: event.target.value } : item) }))} /></label><details className="fs-details"><summary>抽取时的原话</summary><blockquote>{node.rawQuote || '未提供可定位原话。'}</blockquote></details></>}
            {graphDirty && <button type="button" className="fs-button fs-full" onClick={() => { setDraftGraph(structuredClone(record.graph)); setNotice('草稿已还原，原始评估一直保持不变。'); }}><RotateCcw size={14} aria-hidden="true" />还原原始图</button>}
          </aside></div>
          <div className="fs-relation-list" aria-label="完整关系列表">{links.map((link) => <button key={link.id} type="button" className={`fs-relation-button fs-link-${link.kind}`} aria-pressed={selectedRelation === link.id} onClick={() => { setSelectedRelation((current) => current === link.id ? '' : link.id); setSelectedNode(''); }}><span>{RELATIONS[link.kind]}{link.from.length > 1 ? ' · 联合' : ''}</span>{link.from.join(' + ')}<ArrowRight size={13} aria-hidden="true" />{link.to}<small>{link.id}</small></button>)}</div>
          {relation && <div className="fs-relation-detail"><strong>{relation.from.join(' + ')} → {relation.to} · {RELATIONS[relation.kind]}</strong><p>{relation.reason}</p></div>}
          {draftGraph.unresolved.length > 0 && <details className="fs-details"><summary>抽取待核对 · {draftGraph.unresolved.length} 项</summary><ul>{draftGraph.unresolved.map((item, index) => <li key={index}>{item.nodeId && `${item.nodeId} · `}{item.reason}</li>)}</ul></details>}
        </section>
        <div className="fs-evaluation-layout"><section className="fs-panel"><div className="fs-panel-heading"><div><span className="fs-kicker">NINE CRITERIA</span><h2>逐项看证据</h2></div><span className="fs-state-tag">0—4 级 · 无额外扣分</span></div>{LAYERS.map((layer) => <div className="fs-criteria-group" key={layer}><h3>{SHADOW_LAYER_LABELS[layer]}</h3>{SHADOW_CRITERIA.filter((criterion) => criterion.layer === layer).map((definition) => {
          const criterion = record.assessment.criteria.find((item) => item.id === definition.id);
          return <details className="fs-criterion" key={definition.id}><summary><span>{definition.label}</span><span className="fs-criterion-status">{criterion ? CRITERION_STATES[criterion.state] : '未提供'}<strong>{criterion?.level == null ? '—' : `${criterion.level}/4`}</strong></span></summary><p className="fs-field-help">{definition.question}</p><p>{criterion?.reason || '未提供该项观察，不据此评价用户。'}</p>{evidenceButtons(criterion?.evidenceIds || [])}{criterion?.opportunityKeys.length ? <small className="fs-field-help">语义机会：{criterion.opportunityKeys.join(' / ')}</small> : null}</details>;
        })}</div>)}</section>
        <div className="fs-observation-column">{(['expression', 'strategy'] as const).map((dimension) => <section key={dimension} className="fs-panel"><div className="fs-panel-heading"><div><span className="fs-kicker">{dimension === 'expression' ? 'EXPRESSION' : 'STRATEGY'}</span><h2>{dimension === 'expression' ? '本次表达方式' : '本次认知策略'}</h2></div></div><p className="fs-panel-copy">{dimension === 'expression' ? '独立观察，不归一化为风格百分比。' : '只记录本次采用的策略，不给人格定论。'}</p>{SHADOW_BEHAVIORS.filter((item) => item.dimension === dimension).map((definition) => {
          const behavior = record.assessment.behaviors.find((item) => item.code === definition.code);
          return <div key={definition.code} className="fs-behavior"><div><strong>{definition.label}</strong><span className={behavior?.state === 'observed' ? 'fs-observed' : 'fs-muted'}>{behaviorStateLabel(definition.code, behavior)}</span></div>{behavior?.reason && <p>{behavior.reason}</p>}{behavior?.state === 'observed' && evidenceButtons(behavior.evidenceIds)}</div>;
        })}<p className="fs-field-help">未观察到不表示相反倾向，也不计作负向偏好。</p></section>)}</div></div>
        <section ref={evidenceRef} tabIndex={-1} className="fs-panel fs-source-panel" aria-labelledby="fs-source-title"><div className="fs-panel-heading"><div><span className="fs-kicker">BACK TO SOURCE</span><h2 id="fs-source-title">回到原话</h2></div><span className="fs-heading-count">{record.assessment.evidence.length} 条证据</span></div><div className="fs-evidence-picker">{record.assessment.evidence.map((item) => <button type="button" key={item.id} aria-pressed={selectedEvidence === item.id} onClick={() => setSelectedEvidence(item.id)}>{item.id}<span>{item.nodeIds.join('、')}</span></button>)}</div>{evidence && <div className="fs-evidence-detail"><span>{evidence.id} · {({ user: '用户表达', quoted: '引用他人', assisted: '辅助材料', uncertain: '归属待核对' })[evidence.attribution]}</span><blockquote>{evidence.quote}</blockquote>{!record.input.rawText.includes(evidence.quote) && <p className="fs-warning-copy">未在原文逐字匹配，不能视为已核实证据。</p>}</div>}<SourceQuote rawText={record.input.rawText} quote={evidence?.quote} /></section>
        <section className="fs-panel"><div className="fs-panel-heading"><div><span className="fs-kicker">ISSUES & LIMITS</span><h2>问题分型与待核对项</h2></div><span className="fs-heading-count">{record.assessment.issues.length} 项</span></div>{record.assessment.issues.length ? <div className="fs-issues">{record.assessment.issues.map((issue) => <article className={`fs-issue fs-issue-${issue.kind}`} key={issue.id}><div><span className="fs-state-tag">{ISSUE_KINDS[issue.kind]}</span><small>{issue.targetIds.join(' · ')} · {({ low: '局部', medium: '重要', high: '严重' })[issue.severity]}</small></div><p>{issue.reason}</p>{evidenceButtons(issue.evidenceIds)}</article>)}</div> : <p className="fs-panel-copy">本响应未报告问题；这不构成外部事实认证。</p>}{record.warnings.length > 0 && <details className="fs-details"><summary>本地规则提醒 · {record.warnings.length} 项</summary><ul>{record.warnings.map((warning, index) => <li key={`${warning.code}:${index}`}><strong>{warning.target}</strong> · {warning.message}</li>)}</ul></details>}<div className="fs-recommendation"><Sparkles size={18} aria-hidden="true" /><p>{record.assessment.recommendation || '本次没有额外建议。'}</p></div></section>
        <div className="fs-result-footer"><div><ShieldCheck size={18} aria-hidden="true" /><span>本次结果与原文绑定。试编图、再次导入均不会自动写入长期画像。</span></div><button type="button" className="fs-button is-primary" onClick={addToLedger}>纳入模拟画像<ArrowRight size={16} aria-hidden="true" /></button></div>
      </>}

      {view === 'profile' && <>
        <div className="fs-result-heading"><div><span className="fs-kicker">SIMULATED PROFILE</span><h2>长期观察，需要不止一次。</h2><p>这里仅计算内存台账。按尝试采用最新修订，同修订冲突保留并提示；重复回放不增加独立样本。</p></div><div className="fs-profile-actions"><button type="button" className="fs-button" onClick={loadTemporalDemo}>载入趋势示例</button><button type="button" className="fs-button is-primary" onClick={addToLedger}>加入当前结果<ArrowRight size={16} aria-hidden="true" /></button></div></div>
        <div className="fs-profile-summary"><div><strong>{profile.attempts}</strong><span>独立尝试</span></div><div><strong>{ledger.length}</strong><span>台账条目（含修订）</span></div><div><strong>0</strong><span>正式画像写入</span></div><div><strong>未采信</strong><span>所有指标均为影子结果</span></div></div>
        {profile.warnings.length > 0 && <div className="fs-profile-warnings" role="status"><strong>聚合提醒</strong><ul>{profile.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
        {(['ability', 'knowledge', 'cognitive_style', 'expression_style'] as const).map((dimension) => {
          const metrics = profile.metrics.filter((metric) => metric.dimension === dimension);
          return <section className="fs-profile-group" key={dimension}><div className="fs-panel-heading"><div><span className="fs-kicker">{dimension.toUpperCase()}</span><h2>{({ ability: '三层表现 · 当前状态与进退趋势', knowledge: '资料一致性 · 当前掌握趋势', cognitive_style: '认知风格双极 · 近期方向迁移', expression_style: '表达风格五维 · 近期偏好迁移' })[dimension]}</h2></div><span className="fs-state-tag">只读影子映射</span></div>{metrics.length ? <div className="fs-profile-metrics">{metrics.map((metric) => <article key={metric.key} className="fs-panel fs-profile-metric"><div><h3>{metric.label}</h3><span className="fs-state-tag">{metric.state === 'insufficient' ? '观察不足' : '动态试算'} · 未采信</span></div><p className="fs-field-help">{profileGroupLabel(metric.key)}</p>{profileMetricValue(metric)}{profileMetricDynamics(metric)}<p>{metric.sampleCount} 个有效样本 · {metric.days} 天 · {metric.taskCount} 个任务</p><p className="fs-field-help">{metric.reasons.join('；') || '仅保留已观察证据，缺失不作反向推断。'}</p>{metric.sampleAttemptIds.length > 0 && <small className="fs-field-help">来源：{metric.sampleAttemptIds.join('、')}</small>}</article>)}</div> : <div className="fs-empty"><Layers3 size={28} aria-hidden="true" /><h3>尚无可对齐证据</h3><p>需要独立、未被任务提示的原话锚点；没有方向或观察机会时保持未知。</p></div>}</section>;
        })}
        <section className="fs-panel"><div className="fs-panel-heading"><div><span className="fs-kicker">SEPARATE THE COUNTS</span><h2>问题分型统计</h2></div><span className="fs-heading-count">{profile.errors.evaluatedAttempts} 次已评尝试</span></div><div className="fs-error-counts">{([
          ['confirmed', '内部错误'], ['gaps', '论证缺口'], ['extraction', '抽取问题'], ['unverified', '外部未核实'], ['unclear', '转写不确定'],
        ] as const).map(([key, label]) => <div key={key}><strong>{profile.errors[key]}</strong><span>{label}</span></div>)}</div><p className="fs-field-help">不同问题分开统计；不把未核实、抽取错误或转写歧义计作用户已确认错误。</p></section>
        <section className="fs-panel"><div className="fs-panel-heading"><div><span className="fs-kicker">LOCAL LEDGER</span><h2>模拟样本台账</h2></div>{ledger.length > 0 && <button type="button" className="fs-button" onClick={() => { setLedger([]); setNotice('模拟台账已清空，正式数据未改动。'); }}>清空模拟台账</button>}</div>{latestLedger.length ? <div className="fs-ledger">{latestLedger.map((entry) => {
          const attempt = entry.record.input.attemptId;
          const history = ledger.filter((item) => item.record.input.attemptId === attempt);
          return <article key={attempt}><div><strong>{attempt}</strong><span>最新 r{entry.record.input.assessmentRevision} · {history.length} 个回放条目</span><small>{profileDay(entry.record.input.observedAt)}（上海） · {entry.record.input.task.id} · {entry.origin === 'synthetic' ? '合成示例' : '手动导入'}</small></div><button type="button" className="fs-icon-button" aria-label={`从模拟台账移除 ${attempt} 的全部修订`} onClick={() => { setLedger((current) => current.filter((item) => item.record.input.attemptId !== attempt)); setNotice(`已从模拟台账移除 ${attempt} 的全部修订。`); }}><X size={17} aria-hidden="true" /></button></article>;
        })}</div> : <div className="fs-empty"><Layers3 size={30} aria-hidden="true" /><h3>还没有模拟样本</h3><p>加入当前示例或手动回放结果，查看证据不足如何呈现。此操作仅影响本页内存。</p></div>}<details className="fs-details"><summary>查看完整台账（保留同修订冲突）</summary><pre>{json(ledger.map((entry) => ({ attemptId: entry.record.input.attemptId, revision: entry.record.input.assessmentRevision, observedAt: entry.record.input.observedAt, origin: entry.origin })))}</pre></details></section>
      </>}
      <footer className="fs-page-footer"><span>LogiNote / Flow Shadow</span><span>{record.rubricVersion} · 非语义认证 · 未连接正式数据</span></footer>
    </main>
  </div>;
}

export default FlowShadowWorkbench;

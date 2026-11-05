import type { ArgDoc, StructureCheck } from '../services/argumentDoc/types';
import { isStructureCheckFresh, planStructureReview, structureGraphKey } from '../services/argumentDoc/structureReview';
import './StructureReviewPanel.css';

/** Current graph feedback is deliberately separate from the immutable spoken-performance report. */
export function StructureReviewPanel({ doc }: { doc: ArgDoc }) {
  const review = doc.structureReview;
  const fresh = review?.graphKey === structureGraphKey(doc);
  const pending = (review?.pendingNodes?.length ?? 0) + (review?.pendingEdges?.length ?? 0);
  const next = planStructureReview(doc);
  const locate = (kind: 'node' | 'edge', id: string) => document.dispatchEvent(new CustomEvent('argument-quality:locate', { detail: { kind, id } }));
  const items: Array<{ kind: 'node' | 'edge'; check: StructureCheck }> = review
    ? [...review.nodes.filter(n => n.state !== 'clear' && doc.nodes.some(node => node.id === n.id)).map(check => ({ kind: 'node' as const, check })),
      ...review.edges.filter(e => e.state !== 'clear' && doc.edges.some(edge => edge.id === e.id)).map(check => ({ kind: 'edge' as const, check })),
      ...doc.nodes.filter(n => n.issue && !review.nodes.some(c => c.id === n.id)).map(n => ({ kind: 'node' as const, check: { id: n.id, state: 'issue' as const, reason: n.issue!, suggestion: n.suggestion ?? undefined } }))]
    : doc.nodes.filter(n => n.issue).map(n => ({ kind: 'node', check: { id: n.id, state: 'issue', reason: n.issue!, suggestion: n.suggestion ?? undefined } }));
  return <section className="structure-review-panel" aria-label="当前结构问题">
    <h3>当前结构问题</h3>
    <p role="status">{review ? fresh ? pending ? '本次检查仍有未完成目标；旧诊断保留。'
      : review.mode === 'changes' ? '已完成本次局部检查，不代表整图或外部事实已核实。'
      : '已执行整图检查；无法判断项仍待核对，不代表事实已核实。' : '结构已修改，以下为上次诊断，待重新评价。'
      : '尚未进行编辑后结构重评；初始问题来自本次复盘分析。'}</p>
    <small>修改后不自动视为已解决。重新评价只更新图的问题，不改原始评分或画像。</small>
    <p>默认下次检查 {next.targets.nodes.length} 个节点、{next.targets.edges.length} 条关系。</p>
    {(next.targets.nodes.length + next.targets.edges.length > 0) && <details><summary>查看检查范围</summary>
      <p>目标：{[...next.targets.nodes, ...next.targets.edges].join('、')}。</p>
      <small>上下文含 {next.context.nodes.length} 个节点、{next.context.edges.length} 条关系；仅供阅读，不逐项评价。</small>
    </details>}
    {items.length === 0 && <p>{pending ? '仍有目标未检查，不能判定它们已通过。' : fresh ? '已检查范围内未发现明确问题，不代表其他范围已通过。' : '暂无问题标记；需要重评才能确认当前结构。'}</p>}
    {items.map(({ kind, check }) => <article key={`${kind}-${check.id}`}>
      <button type="button" onClick={() => locate(kind, check.id)}>{kind === 'edge' ? '关系' : '节点'} {check.id} · {check.state === 'uncertain' ? '无法判断' : '待完善'}{review && !isStructureCheckFresh(doc, kind, check) ? ' · 旧诊断待复核' : ''} · 定位</button>
      <p>{check.reason}</p>{check.suggestion && <small>建议：{check.suggestion}</small>}
    </article>)}
    {fresh && <small>本次检查 {review!.checkedNodes?.length ?? review!.nodes.length} 个节点、{review!.checkedEdges?.length ?? review!.edges.length} 条关系。{pending > 0 ? `还有 ${pending} 个目标待检查，不会自动重发。` : ''}</small>}
    {review?.warnings?.map(message => <p key={message} role="status">{message}</p>)}
  </section>;
}

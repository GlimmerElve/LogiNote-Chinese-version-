import React from 'react';
import type { CognitionGraph } from '../services/cognition/types';
import { flowStructureForNode } from '../services/argumentDoc/flowStructure';

/** Source annotations stay collapsed and distinct from the user's editable current beliefs. */
export function CognitionFlowStructureDetails({ graph, nodeId }: { graph: CognitionGraph; nodeId: string }) {
  const source = flowStructureForNode(graph, nodeId);
  if (!source) return null;
  const text = (id: string) => graph.flowStructure!.nodes.find(n => n.id === id)?.text || id;
  return <details className="cm-provenance"><summary>原始复盘论证结构{source.state === 'source_only' ? ' · 仅供溯源' : ''}</summary>
    {source.state === 'source_only' && <p>当前图已调整；以下是原始分析，不代表当前论证或修改后的原话。</p>}
    {source.rawQuote && <p className="whitespace-pre-wrap break-words">抽取时原话片段（未另行核验）：{source.rawQuote}</p>}
    {source.arguments.map(a => <section key={a.id}><p>主张：{text(a.claim)}</p>
      <p>抽取时状态：{a.status === 'argued' ? '有论证依据' : a.status === 'incomplete' ? '论证不完整' : '仅陈述'}</p>
      {!!a.support.length && <><p>共同支持依据（不表示每项单独充分）：</p><ul>{a.support.map(id => <li key={id}>{text(id)}</li>)}</ul></>}
      {!!a.oppose.length && <><p>反对依据：</p><ul>{a.oppose.map(id => <li key={id}>{text(id)}</li>)}</ul></>}
    </section>)}
    {source.unresolved.map((u, i) => <p key={i}>抽取待核对：{u.reason}</p>)}
  </details>;
}

import React, { useMemo, useState } from 'react';
import { parseMoleculeDiagram } from '../../services/textbook/scienceDiagram';
import type { TextbookManifest } from '../../services/textbook/types';
import { SourceReference, type SourceReferenceProps } from './SourceReference';
import { TextbookFormatFallback } from './CodeBlock';
import { BackgroundTextbookVisual } from './BackgroundTextbookVisual';
export function MoleculeBlock({ code, manifest, ...sourceProps }: { code: string; manifest?: TextbookManifest } & Omit<SourceReferenceProps, 'sourceId' | 'manifest'>) {
  const parsed = useMemo(() => { try { return { value: parseMoleculeDiagram(code, manifest?.sources?.map(source => source.sourceId)) }; }
    catch (error) { return { error: error instanceof Error ? error.message : '参数无效' }; } }, [code, manifest]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  if (!parsed.value) return <TextbookFormatFallback language="molecule" code={code} message={`分子图参数无效：${parsed.error}`} />;
  const molecule = parsed.value;
  return <figure className="textbook-science textbook-molecule" data-molecule-status={status}>
    <figcaption><strong>{molecule.title}</strong><span className="textbook-data-label">二维分子结构 · {molecule.simulated ? '教学示例' : '依据资料'}</span></figcaption>
    <BackgroundTextbookVisual kind="molecule" code={code} height={240} label={`${molecule.title}。${molecule.description}`} onStatus={setStatus} />
    <p className="textbook-science-description">{molecule.description}</p>
    <details><summary>查看结构输入与局限</summary><code>{molecule.smiles}</code><p>此图按 SMILES 绘制，不验证名称与结构是否一致，也不表示真实三维构型或反应机理。</p></details>
    {!!molecule.sourceIds.length && <div>{molecule.sourceIds.map(sourceId => <SourceReference key={sourceId} sourceId={sourceId} manifest={manifest} {...sourceProps} />)}</div>}
  </figure>;
}

import React, { useEffect, useRef, useState } from 'react';
import type { S2Document } from '../../types/sceneS2';
import type { S2PluginHost } from '../../services/scene/sceneS2PluginHost';
import type { S2ImageResourceUi } from '../../services/scene/sceneS2ResourceUi';
import { isS2ImageResource } from '../../services/scene/sceneS2ImageResource';

export interface S2ImageMaterialsProps {
  host: S2ImageResourceUi | null;
  active: boolean;
  isCurrent: () => boolean;
  document?: S2Document;
  selectedNodeId?: string;
  /** The normal canvas uses one picker inside the actual image node. */
  compact?: boolean;
  autoBind?: boolean;
  onBind: (resourceId: string) => void;
  onError: (message: string) => void;
  onChange: () => void;
}
/** A local file chooser, not a model tool. No effect here runs the canvas or sends attachments. */
export function S2ImageMaterials(props: S2ImageMaterialsProps) {
  const { host, active, document, selectedNodeId } = props;
  const [selecting, setSelecting] = useState(false), [notice, setNotice] = useState('');
  const live = useRef(props), mounted = useRef(true); live.current = props;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setSelecting(false); setNotice(''); }, [host, active]);
  const current = () => mounted.current && active && !!host && live.current.host === host && live.current.active && props.isCurrent() && live.current.isCurrent();
  const resources = host?.imageResourceSummary() ?? [];
  const selected = document?.execution?.nodes.find(node => node.id === selectedNodeId && isS2ImageResource(node));
  const connected = !!selected && document?.execution?.links.some(link => link.target.nodeId === selected.id && link.target.portId === 'resource');
  const binding = selected?.bindings.resource;
  const value = binding?.kind === 'literal' && typeof binding.value === 'string' && resources.some(resource => resource.id === binding.value) ? binding.value : '';
  const selectedLabel = selected?.presentation?.label || '图片资料入口';
  const report = (error: unknown) => { if (current()) props.onError(error instanceof Error ? error.message : '图片操作未完成，请重新选择。'); };
  async function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || !current()) return;
    if (props.autoBind && (!selected || connected || live.current.document !== document || live.current.selectedNodeId !== selectedNodeId)) return;
    setSelecting(true); setNotice('正在校验图片，尚未发送。');
    let unbound: string | undefined;
    try {
      const resource = await host!.approveImageFile(file); unbound = resource.id;
      if (!current() || props.autoBind && (live.current.document !== document || live.current.selectedNodeId !== selectedNodeId)) {
        host!.revokeImageFile(resource.id); unbound = undefined; return;
      }
      if (props.autoBind) props.onBind(resource.id);
      unbound = undefined;
      setNotice(props.autoBind ? '图片已选用；选图本身不会运行或发送。' : `已提供“${resource.label}”。在图片资料入口选用后，仍需主动运行和确认发送。`);
      props.onChange();
    } catch (error) {
      if (unbound) try { host!.revokeImageFile(unbound); } catch { /* A rejected binding must not retain its new grant. */ }
      report(error);
    } finally { if (current()) setSelecting(false); }
  }
  if (props.compact) {
    let preview: ReturnType<S2PluginHost['imageResourcePreview']> | undefined;
    try { if (value) preview = host?.imageResourcePreview(value); } catch { /* A revoked image is not re-read. */ }
    return <section className="s2-image-inline nodrag nopan nowheel" aria-label="图片选择与预览">
      <input type="file" aria-label="选择本地图片" title="PNG / JPEG / WebP，单张最多 1 MiB" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
        disabled={!active || !host || selecting || connected || resources.length >= 6} onChange={choose} />
      {connected && <small>图片由连接的来源提供</small>}
      {!connected && !value && <small>请选择本局图片；复用保存的场景时需要重新选择。</small>}
      {preview && <figure style={{ margin: '8px 0' }}><img src={preview.dataUrl} alt={`待处理图片：${preview.label}`} style={{ display: 'block', maxWidth: '100%', maxHeight: 120, objectFit: 'contain' }} />
        <figcaption>{preview.label}</figcaption>
        <button type="button" disabled={!active || selecting || connected} onClick={() => {
          if (!current() || live.current.document !== document || live.current.selectedNodeId !== selectedNodeId) return;
          try { props.onBind(''); host!.revokeImageFile(preview!.id); props.onChange(); setNotice('已移除图片，尚未发送。'); } catch (error) { report(error); }
        }}>移除图片</button></figure>}
      {notice && !preview && <small role="status" aria-live="polite">{notice}</small>}
      {resources.length >= 6 && <small>本次已保留6张图片；可在“更多”的资料管理中移除不再使用的图片。</small>}
    </section>;
  }
  return <section className="s2-model-test s2-image-materials" aria-label="本局图片材料">
    <h3>提供本局图片</h3>
    <p>支持 PNG、JPEG、WebP 静态原图，单张最多 1 MiB，本局最多 6 张且合计 4 MiB。选择图片只接入本局材料，不运行、不发送，也不会自动识图或提取文字。</p>
    <label>选择本地图片<input type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" aria-label="选择本地图片" disabled={!active || !host || selecting || resources.length >= 6}
      onChange={choose} /></label>
    <p role="status" aria-live="polite">{selecting ? '正在校验图片；其他画布操作不受影响。' : notice}</p>
    {!resources.length && <p>尚未提供图片。保存的场景不包含图片文件或本局访问权限。</p>}
    {resources.length > 0 && <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 12 }}>
      {resources.map(resource => {
        let preview = ''; try { preview = host!.imageResourcePreview(resource.id).dataUrl; } catch { /* Retired resource is not fetched or recovered by path. */ }
        return <li key={resource.id} style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {preview && <img src={preview} alt={`本局图片预览：${resource.label}`} style={{ width: 88, height: 72, objectFit: 'contain', borderRadius: 6 }} />}
          <span style={{ flex: '1 1 140px', overflowWrap: 'anywhere' }}>{resource.label} · {(resource.bytes / 1024).toFixed(1)} KiB</span>
          <button type="button" disabled={!active || !host} aria-label={`撤回图片 ${resource.label}`} onClick={() => {
            if (!current()) return;
            try {
              host!.revokeImageFile(resource.id); setNotice(`已撤回“${resource.label}”，相关待发送请求已失效；已收到的文字和用量记录仍保留。`); props.onChange();
            } catch (error) { report(error); }
          }}>撤回图片</button>
        </li>;
      })}
    </ul>}
    {selected && <label>为“{selectedLabel}”选择图片<select aria-label="为图片资料入口选择图片" value={value} disabled={!active || !host || connected}
      onChange={event => {
        const id = event.target.value;
        if (!current() || live.current.document !== document || live.current.selectedNodeId !== selectedNodeId || connected) return;
        try {
          if (id && !host!.imageResourceSummary().some(resource => resource.id === id)) throw new Error('这张图片已撤回，请重新选择。');
          props.onBind(id); setNotice(id ? '已设置这一步使用的图片；选图本身不会运行或发送。' : '已清除此步的图片选择，清除操作不会运行。'); props.onChange();
        } catch (error) { report(error); }
      }}><option value="">请选择本局图片</option>{resources.map(resource => <option key={resource.id} value={resource.id}>{resource.label}</option>)}</select>
      <small>{connected ? '这个入口已由连线提供材料。若要手动选择，先取消该输入连线。' : '选用只设置图片入口。主动运行后，发送确认页会展示本次实际原图、提示词和模型。'}</small>
    </label>}
    <p>原图不写进提示词或场景模板。若当前固定模型不支持图片，会明确停止，保留原图，不换模型、不丢图发送。</p>
  </section>;
}

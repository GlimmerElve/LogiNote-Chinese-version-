import React, { useEffect, useRef, useState } from 'react';
import { Upload, RefreshCw, Play, Package } from 'lucide-react';
import type { H5pLocalApi, H5pLocalPackage } from '../../types/h5p';
import './h5pLibrary.css';

function api(): H5pLocalApi | undefined { return (window as any).electronAPI?.h5p; }
export function H5pLibraryPanel() {
  const [packages, setPackages] = useState<H5pLocalPackage[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false), mounted = useRef(false);
  const restart = (item: H5pLocalPackage) => void action(`restart-${item.id}`, async service => {
    if (typeof service.restart !== 'function') throw new Error('请重启更新后的桌面版后再恢复进度。');
    const result = await service.restart(item.id);
    return result.canceled ? '已取消，原进度未改动。' : result.backup ? '原进度已备份，可重新打开场景从头开始。' : '暂无进度记录，可直接打开场景。';
  });
  const action = async (kind: string, run: (service: H5pLocalApi) => Promise<string>) => {
    if (lock.current) return;
    const service = api();
    if (!service) { setErrors(['H5P 本地运行需要更新后的桌面版，请重启应用后重试。']); return; }
    lock.current = true; setBusy(kind); setNotice(''); setErrors([]);
    try {
      const message = await run(service);
      if (mounted.current) setNotice(message);
      const list = await service.list();
      if (mounted.current) { setPackages(list.packages); setErrors(list.errors); }
    } catch (error) { if (mounted.current) setErrors([error instanceof Error ? error.message : 'H5P 操作失败']); }
    finally { lock.current = false; if (mounted.current) setBusy(''); }
  };
  useEffect(() => {
    mounted.current = true;
    void action('refresh', async () => '');
    return () => { mounted.current = false; };
  }, []);
  return <section className="h5p-library" aria-label="H5P 本地场景库" aria-busy={Boolean(busy)}>
    <div className="h5p-library-head">
      <div><p className="h5p-eyebrow">INTERACTIVE LIBRARY</p><h3>本地互动场景</h3><p className="h5p-muted">导入可信场景，在独立窗口中体验。</p></div>
      <div className="h5p-library-actions">
        <button type="button" className="h5p-button" disabled={Boolean(busy)} onClick={() => void action('refresh', async () => '')} aria-label="刷新 H5P 场景库"><RefreshCw className={`h-4 w-4 ${busy === 'refresh' ? 'animate-spin motion-reduce:animate-none' : ''}`} /></button>
        <button type="button" className="h5p-button is-primary" disabled={Boolean(busy)} onClick={() => void action('import', async service => {
          const result = await service.importPackage();
          return result.canceled ? '已取消导入。' : result.package?.missing.length ? '已保存场景包，但缺少依赖，暂不能播放。' : '已导入，可打开场景。';
        })}><Upload className="h-4 w-4" />{busy === 'import' ? '正在检查并导入…' : '导入 .h5p'}</button>
      </div>
    </div>
    <details className="h5p-library-help"><summary>导入要求与运行边界</summary><p>包上限 128 MB，单文件展开上限 32 MB。需包含完整运行依赖；不会自动联网下载，外链媒体不可用。只保存包自身支持的进度；报告的分数不代表掌握度。</p></details>
    {notice && <p role="status" className="h5p-notice">{notice}</p>}
    {errors.map((error, index) => <p key={index} role="alert" className="h5p-error">{error}</p>)}
    {!packages.length && !busy && !errors.length && <div className="h5p-empty"><Package aria-hidden="true" /><h4>为探索收藏一个新场景</h4><p className="h5p-muted">还没有本地 H5P 场景，可从右上角导入 .h5p 包。</p></div>}
    {busy === 'refresh' && !packages.length && <p role="status" className="h5p-muted">正在读取场景库…</p>}
    <div className="h5p-library-list">
      {packages.map(item => <article key={item.id} className="h5p-library-card">
        <div className="h5p-library-card-head">
          <div className="min-w-0"><h4><Package aria-hidden="true" />{item.title}</h4>
            <p className="h5p-muted">{(item.bytes / 1024 / 1024).toFixed(1)} MB</p>
          </div>
          <button type="button" className="h5p-button is-primary" disabled={Boolean(busy) || Boolean(item.missing.length) || Boolean(item.progressError)} onClick={() => void action(item.id, async service => {
            await service.open(item.id); return '已在独立窗口打开。';
          })}><Play className="h-4 w-4" />{busy === item.id ? '正在打开…' : '打开场景'}</button>
        </div>
        {item.missing.length > 0 && <p className="h5p-error">缺少兼容依赖：{item.missing.join('、')}。请从作者处获取包含这些依赖的完整 .h5p 包。</p>}
        {item.progressError && <div><p role="alert" className="h5p-error">{item.progressError}</p><button type="button" className="h5p-button" disabled={Boolean(busy)} onClick={() => restart(item)}>备份进度并重新开始</button></div>}
        {!item.progressError && (item.resumeAvailable || item.lastPlayedAt) && <button type="button" className="h5p-button" disabled={Boolean(busy)} onClick={() => restart(item)}>备份进度并重新开始</button>}
      </article>)}
    </div>
  </section>;
}

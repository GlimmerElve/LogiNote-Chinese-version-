import React, { useState } from 'react';
import { Network } from 'lucide-react';
import { openCognitionManager } from '../services/cognition/managerWindow';
import './CognitionManager.css';
import './PersonalCognition.css';

export function PersonalCognitionLauncher() {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function open() { if (busy) return; setBusy(true); setError(''); try { await openCognitionManager(); } catch (cause) { setError(cause instanceof Error ? cause.message : '窗口打开失败'); } finally { setBusy(false); } }
  return <section className="cm-launcher cognition-ui" aria-label="个人认知库"><div><h3>我的认知图谱</h3><p>查看我认同的观点、已有的逻辑关系，以及正在变化的理解。</p>{error && <p role="alert">{error}</p>}</div>
    <button type="button" className="cognition-action" disabled={busy} onClick={() => void open()}><Network aria-hidden="true" />{busy ? '正在打开…' : '打开个人认知窗口'}</button></section>;
}

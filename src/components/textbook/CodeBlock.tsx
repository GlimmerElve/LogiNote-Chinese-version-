import React, { useEffect, useRef, useState } from 'react';

interface Token { from: number; to: number; className: string }
export const CodeBlock = React.memo(function CodeBlock({ code, language = '' }: { code: string; language?: string }) {
  const host = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [highlight, setHighlight] = useState<{ code: string; language: string; tokens: Token[] }>();
  const tokens = highlight?.code === code && highlight.language === language ? highlight.tokens : [];
  const [copyStatus, setCopyStatus] = useState('');
  useEffect(() => {
    const element = host.current;
    if (!element || visible) return;
    const parentsOpen = () => {
      let parent = element.parentElement;
      while (parent) { if (parent instanceof HTMLDetailsElement && !parent.open) return false; parent = parent.parentElement; }
      return true;
    };
    const check = () => {
      if (!parentsOpen()) return;
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.bottom >= -300 && rect.top <= window.innerHeight + 300) setVisible(true);
    };
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting) && parentsOpen()) setVisible(true);
    }, { rootMargin: '300px 0px' });
    observer?.observe(element);
    // Modern browsers already observe details opening and clipping. Only the
    // fallback needs global listeners (and toggle must be captured).
    if (!observer) {
      check(); document.addEventListener('toggle', check, true);
      document.addEventListener('scroll', check, { capture: true, passive: true });
    }
    return () => { observer?.disconnect(); document.removeEventListener('toggle', check, true); document.removeEventListener('scroll', check, true); };
  }, [visible]);
  useEffect(() => {
    let cancelled = false; let cancelWork = () => {}; setCopyStatus('');
    if (!visible || !language || code.length > 32_000) return;
    const idle = (work: () => void) => {
      if (cancelled) return;
      if (typeof window.requestIdleCallback === 'function') {
        const id = window.requestIdleCallback(() => { if (!cancelled) work(); }, { timeout: 1000 });
        cancelWork = () => window.cancelIdleCallback(id);
      } else {
        const id = window.setTimeout(() => { if (!cancelled) work(); }, 32);
        cancelWork = () => window.clearTimeout(id);
      }
    };
    idle(() => {
      void Promise.all([import('@codemirror/language-data'), import('@lezer/highlight')]).then(async ([data, highlighter]) => {
        if (cancelled) return;
        const name = language.toLowerCase();
        const definition = data.languages.find((item) => item.name.toLowerCase() === name || item.alias.some((alias) => alias.toLowerCase() === name));
        if (!definition) return;
        const support = await definition.load(); if (cancelled) return;
        idle(() => {
          try {
            const next: Token[] = [];
            highlighter.highlightTree(support.language.parser.parse(code), highlighter.classHighlighter, (from, to, className) => next.push({ from, to, className }));
            if (!cancelled) setHighlight({ code, language, tokens: next });
          } catch { /* Keep the original plain source on parser failure. */ }
        });
      }).catch(() => { /* Plain source is always available; highlighting is optional. */ });
    });
    return () => { cancelled = true; cancelWork(); };
  }, [code, language, visible]);
  const pieces: React.ReactNode[] = []; let cursor = 0;
  for (const token of tokens) {
    if (token.from > cursor) pieces.push(code.slice(cursor, token.from));
    pieces.push(<span key={`${token.from}:${token.to}`} className={token.className}>{code.slice(token.from, token.to)}</span>); cursor = token.to;
  }
  if (cursor < code.length) pieces.push(code.slice(cursor));
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopyStatus('已复制'); }
    catch { setCopyStatus('无法自动复制，请选择源码复制'); }
  };
  return <figure ref={host} className="textbook-code-block">
    <figcaption><span>{language || '代码'}</span><button type="button" onClick={() => void copy()} aria-label="复制代码">复制</button><span role="status" aria-live="polite">{copyStatus}</span></figcaption>
    <pre tabIndex={0}><code>{tokens.length ? pieces : code}</code></pre>
  </figure>;
});
export function TextbookFormatFallback({ code, message, language }: { code: string; message: string; language: string }) {
  return <div className="textbook-format-error" role="status"><p>{message}</p><details><summary>查看并恢复 {language} 源码</summary><CodeBlock code={code} language={language} /></details></div>;
}

/** Mermaid measures real SVG text/paths while rendering. Keep those temporary
 * nodes out of the document's flow and layout tree without display:none (which
 * would make its measurements zero). A timed-out card must not remove this
 * host until its actual render promise settles and releases the shared lock. */
export async function withMermaidMeasurementHost<T>(render: (host: HTMLElement) => Promise<T>, owner: Document = document): Promise<T> {
  const host = owner.createElement('div');
  host.dataset.textbookMermaidMeasure = 'true';
  host.setAttribute('aria-hidden', 'true');
  host.inert = true;
  Object.assign(host.style, {
    position: 'fixed', left: '-100000px', top: '0', width: '960px', height: '1000px',
    contain: 'layout style paint', boxSizing: 'border-box', overflow: 'hidden',
    margin: '0', padding: '0', border: '0', opacity: '0', pointerEvents: 'none',
  });
  owner.body.appendChild(host);
  try { return await render(host); }
  finally { host.remove(); }
}

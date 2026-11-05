/** Conservative page-coverage label, not a claim that a paper was read in full.
 * Inspect normalized heading copies only: never unescape or rewrite source
 * Markdown, LaTeX, code or the text used for frozen evidence coordinates. */
export function inferWebEvidenceKind(url: string, content: string): 'article' | 'abstract' {
  let pathname = '', hostname = '';
  try { const parsed = new URL(url); pathname = parsed.pathname; hostname = parsed.hostname; } catch { /* URL admission is separate */ }
  if ((/(?:^|\.)arxiv\.org$/iu.test(hostname) && /^\/abs\//iu.test(pathname))
    || /\/abstracts?(?:\/|$)|\/abstract(?:\d|[_.])/iu.test(pathname)) return 'abstract';
  let fenced = false;
  const lines = content.split(/\r?\n/u).flatMap(raw => {
    if (/^\s*(?:```|~~~)/u.test(raw)) { fenced = !fenced; return []; }
    if (fenced) return [];
    return [raw.replace(/\\([#*\[\]])/gu, '$1').replace(/^\s*(?:>\s*)?(?:#{1,6}\s*)?/u, '').replace(/\*\*/gu, '').trim()];
  });
  const abstract = lines.some(line => /^(?:【\s*摘要\s*】|\[\s*(?:摘要|abstract)\s*\]|摘要|abstract)(?:\s*[:：]|\s*$)/iu.test(line));
  const bodyHeadings = new Set(lines.flatMap(line => {
    const match = /^(?:\d+(?:\.\d+)*[.、]?\s*)?(引言|前言|研究方法|方法|材料与方法|实验方法|实验设计|实验|结果|研究结果|讨论|结论|introduction|background|methods?|materials and methods|results?|discussion|conclusions?)\s*[:：]?\s*$/iu.exec(line);
    return match ? [match[1].toLocaleLowerCase()] : [];
  }));
  return abstract && bodyHeadings.size < 2 ? 'abstract' : 'article';
}

/** Character count misses short but formula-heavy textbooks. This is only a
 * cheap routing estimate; Markdown interpretation remains in the reader worker. */
export function needsBackgroundTextbookReading(content: string, characterLimit: number): boolean {
  if (content.length > characterLimit) return true;
  let mathDelimiters = 0;
  let opening: { delimiter: string; offset: number } | undefined;
  for (const hit of content.matchAll(/\\.|\${1,2}/gu)) {
    if (!hit[0].startsWith('$')) continue;
    mathDelimiters += hit[0].length;
    if (mathDelimiters >= 48) return true;
    if (!opening) opening = { delimiter: hit[0], offset: hit.index };
    else if (opening.delimiter === hit[0]) {
      if (hit.index - opening.offset > 512) return true;
      opening = undefined;
    }
  }
  // Older generated pages also contain bare notation. Estimate density without
  // parsing or running KaTeX on the interface thread before routing to a worker.
  let notation = 0;
  for (const _hit of content.matchAll(/[=^≤≥≠∫Σ]|\b(?:lim|sin|cos|tan|ln)\s*\(/gu)) {
    if (++notation >= 48) return true;
  }
  return [...content.matchAll(/^ {0,3}(?:`{3,}|~{3,})(?:mermaid|chart|function-plot|science-diagram|molecule)\b/gmu)].length >= 3;
}

/** A standard Markdown quote stays understandable in other readers. */
export function findInteractiveFigure(body: string): string | null {
  let fence = '', collecting = false; const text: string[] = [];
  for (const line of body.split(/\r?\n/u)) {
    const fenceLine = line.replace(/^ {0,3}(?:>\s?)+/u, '');
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(fenceLine)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ''; continue; }
    if (fence) continue;
    if (!collecting) { if (/^ {0,3}>\s*\*\*交互探索\*\*\s*$/u.test(line)) collecting = true; continue; }
    const quoted = /^ {0,3}>\s?(.*)$/u.exec(line);
    if (!quoted) break;
    if (quoted[1].trim()) text.push(quoted[1].trim());
    if (text.join(' ').length > 1200) return null;
  }
  const result = text.join(' ').trim();
  return result && result.length <= 1200 ? result : null;
}

/** Find portable quote spans without treating fenced examples as live figures. */
export function findInteractiveFigureEntries(body: string): Array<{ brief: string; start: number; end: number }> {
  const entries: Array<{ brief: string; start: number; end: number }> = [];
  let fence = '', start = -1, end = 0, parts: string[] = [], overflow = false;
  const finish = () => {
    const brief = parts.join(' ').trim();
    if (start >= 0 && !overflow && brief && brief.length <= 1200) entries.push({ brief, start, end });
    start = -1; parts = []; overflow = false;
  };
  const lines = body.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/gu);
  for (const match of lines) {
    const raw = match[0]; if (!raw) continue;
    const line = raw.replace(/(?:\r\n|\n|\r)$/u, ''), offset = match.index!;
    const fenceLine = line.replace(/^ {0,3}(?:>\s?)+/u, '');
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(fenceLine)?.[1];
    if (marker) { if (start >= 0) finish(); if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ''; continue; }
    if (fence) continue;
    if (start >= 0) {
      const quoted = /^ {0,3}>\s?(.*)$/u.exec(line);
      if (quoted) { if (quoted[1].trim()) parts.push(quoted[1].trim()); end = offset + line.length; if (parts.join(' ').length > 1200) overflow = true; continue; }
      finish();
    }
    if (/^ {0,3}>\s*\*\*交互探索\*\*\s*$/u.test(line)) { start = offset; end = offset + line.length; }
  }
  finish(); return entries;
}

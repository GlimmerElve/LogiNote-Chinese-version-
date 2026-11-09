/** A narrow display recovery for generated LaTeX environments whose Markdown
 * delimiters were omitted or became bare brackets. Never infer row separators
 * from already-decoded Markdown text: the caller supplies the original slice. */
export interface GeneratedMathEnvironment { end: number; tex: string; recoverable: boolean }
const supported = /^(?:cases|dcases|rcases|(?:p|b|B|v|V)?matrix|smallmatrix|aligned|gathered|array)$/u;
const limit = 16_000;

export function generatedMathEnvironmentAt(value: string, start: number, citationIds: ReadonlySet<string>): GeneratedMathEnvironment | undefined {
  const opening = value.startsWith('\\[', start) ? '\\[' : value[start] === '[' && value[start + 1] !== '[' ? '[' : '';
  if (!opening && !/[A-Za-z\\]/u.test(value[start] || '')) return;
  const innerStart = start + opening.length;
  const begin = /\\begin\s*\{([A-Za-z]+)\}/u.exec(value.slice(innerStart, innerStart + 320));
  if (!begin || !supported.test(begin[1])) return;
  const prefix = value.slice(innerStart, innerStart + begin.index);
  // A formula prefix such as m(a)= is allowed. Ordinary prose and Markdown
  // are not promoted just because a later sentence mentions a LaTeX command.
  if (prefix.length > 240 || !/^[\sA-Za-z0-9\\{}()[\].,+*/^_=<>|:'!\-]*$/u.test(prefix)
    || !opening && (/[\[\]]/u.test(prefix) || prefix.trim() && !/[=<>]/u.test(prefix))) return;
  const first = innerStart + begin.index;
  const tokens = /\\(begin|end)\s*\{([A-Za-z]+)\}/gu;
  tokens.lastIndex = first;
  const stack: string[] = [];
  let environmentEnd = -1;
  for (let token = tokens.exec(value); token && token.index - innerStart < limit; token = tokens.exec(value)) {
    if (!supported.test(token[2])) return;
    if (token[1] === 'begin') stack.push(token[2]);
    else if (stack.pop() !== token[2]) return;
    if (!stack.length) { environmentEnd = tokens.lastIndex; break; }
    if (stack.length > 12) return;
  }
  if (environmentEnd < 0 || environmentEnd - innerStart > limit) return;
  let end = environmentEnd;
  if (opening) {
    const closing = opening === '\\[' ? '\\]' : ']';
    const whitespace = /^[ \t\r\n]*/u.exec(value.slice(end))![0];
    end += whitespace.length;
    if (!value.startsWith(closing, end)) return;
    end += closing.length;
    // Authored links, images and reference definitions retain their meaning.
    const trailing=value.slice(end), reference=/^[ \t]*\[([^\]\r\n]+)\]/u.exec(trailing);
    if (trailing.startsWith('(') || /^[ \t]*:/u.test(trailing) || value[start - 1] === '!'
      || reference && !citationIds.has(reference[1]) && !/^[A-Z]\d+$/u.test(reference[1])) return;
  }
  // The existing MDX compatibility gate escapes a literal < in prose as \<.
  // Inside this confirmed math environment it is still the same comparison;
  // remove only that isolated Markdown escape, never a \\ row separator.
  const tex = value.slice(innerStart, environmentEnd).trim().replace(/(?<!\\)\\</gu, '<');
  if (!tex || /\r?\n[ \t]*\r?\n|[`$]|https?:\/\//u.test(tex)) return;
  // The supported cases/matrices are high-confidence math; retain their exact
  // numbers, conditions, punctuation and intentional \\ row separators.
  const recoverable = !/^(?:d|r)?cases$/u.test(begin[1]) || tex.includes('&') && tex.includes('\\\\');
  return { end, tex, recoverable };
}

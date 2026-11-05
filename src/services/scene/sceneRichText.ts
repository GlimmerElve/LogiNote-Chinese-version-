const MATH_INLINE_PREFIX = 'SCENE_MATH_INLINE:';
const MATH_BLOCK_PREFIX = 'SCENE_MATH_BLOCK:';

function mathToken(latex: string, display: boolean): string {
  const value = latex.trim();
  if (!value) return '';
  return `\`${display ? MATH_BLOCK_PREFIX : MATH_INLINE_PREFIX}${encodeURIComponent(value)}\``;
}

function transformTextSegment(text: string): string {
  const withBlocks = text
    .replace(/(^|[^\\])\$\$([\s\S]+?)\$\$/g, (_, prefix: string, latex: string) => {
      const token = mathToken(latex, true);
      return token ? `${prefix}\n\n${token}\n\n` : _;
    })
    .replace(/(^|[^\\])\\\[([\s\S]+?)\\\]/g, (_, prefix: string, latex: string) => {
      const token = mathToken(latex, true);
      return token ? `${prefix}\n\n${token}\n\n` : _;
    });

  return withBlocks
    .replace(/(^|[^\\])\$([^\n$]+?)\$/g, (match, prefix: string, latex: string) => {
      const token = mathToken(latex, false);
      return token ? `${prefix}${token}` : match;
    })
    .replace(/(^|[^\\])\\\((.+?)\\\)/g, (match, prefix: string, latex: string) => {
      const token = mathToken(latex, false);
      return token ? `${prefix}${token}` : match;
    });
}

function transformOutsideCode(markdown: string, transform: (text: string) => string): string {
  const codePattern = /(`{3,})[\s\S]*?\1|(~{3,})[\s\S]*?\2|(`+)[^\n]*?\3/g;
  let result = '';
  let cursor = 0;

  for (const match of markdown.matchAll(codePattern)) {
    const index = match.index ?? 0;
    result += transform(markdown.slice(cursor, index));
    result += match[0];
    cursor = index + match[0].length;
  }

  return result + transform(markdown.slice(cursor));
}

/** Convert TeX delimiters outside Markdown code spans/fences into renderer tokens. */
export function prepareSceneMarkdown(markdown: string): string {
  return transformOutsideCode(markdown, transformTextSegment);
}

export function prepareSceneCitationMarkdown(
  markdown: string,
  validIndexes: ReadonlySet<number>,
): { markdown: string; referencedIndexes: number[] } {
  const referenced = new Set<number>();
  const prepared = transformOutsideCode(markdown, (text) => text.replace(
    /(^|[^!\\])\[(\d+)\](?!\()/g,
    (match, prefix: string, rawIndex: string) => {
      const index = Number(rawIndex);
      if (!validIndexes.has(index)) return match;
      referenced.add(index);
      return `${prefix}[${index}](#scene-citation-${index})`;
    },
  ));
  return { markdown: prepared, referencedIndexes: [...referenced] };
}

export function readSceneCitationHref(href?: string): number | undefined {
  const match = href?.match(/^#scene-citation-([1-9]\d*)$/);
  return match ? Number(match[1]) : undefined;
}

export function readSceneMathToken(value: string): { latex: string; display: boolean } | undefined {
  const normalized = value.replace(/\n$/, '');
  const display = normalized.startsWith(MATH_BLOCK_PREFIX);
  const prefix = display ? MATH_BLOCK_PREFIX : MATH_INLINE_PREFIX;
  if (!normalized.startsWith(prefix)) return undefined;

  try {
    const latex = decodeURIComponent(normalized.slice(prefix.length));
    return latex ? { latex, display } : undefined;
  } catch {
    return undefined;
  }
}

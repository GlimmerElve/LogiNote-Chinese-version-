/** Citation metadata is the authority; bare numeric brackets remain valid math
 * when no source metadata declares them. Old concept references without an ID
 * use their historical one-based list position. */
export function generatedMathCitationIds(
  references?: readonly { sourceId?: string }[],
  textbookSources?: readonly { sourceId: string }[],
): readonly string[] {
  const ids = new Set<string>();
  const add = (id: string) => { if (/^\d+$/u.test(id)) ids.add(id); };
  references?.forEach((source, index) => add(source.sourceId || String(index + 1)));
  textbookSources?.forEach(source => add(source.sourceId));
  return [...ids];
}

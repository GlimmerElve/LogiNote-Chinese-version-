/** Exact pure parser boundary; excludes review scoring/profile/storage dependencies. */
export function parseJsonLenient(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/g, '').replace(/```/g, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return JSON.parse(stripped.trim());
  return JSON.parse(stripped.slice(start, end + 1));
}

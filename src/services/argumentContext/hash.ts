/** Web Crypto keeps this pure service usable in the renderer, Node checks and a later host adapter. */
export function compareArgumentContextIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function argumentContextHash(value: unknown): Promise<string> {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).sort(([a], [b]) => compareArgumentContextIds(a, b))
      .filter(([, item]) => item !== undefined).map(([key, item]) => [key, canonical(item)]));
    return input;
  };
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function argumentCanonicalTextHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

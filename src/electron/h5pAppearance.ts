/** Only appearance values cross into the untrusted player; never application data. */
export const H5P_APPEARANCE_KEYS = ['--ln-bg-app', '--ln-bg-surface', '--ln-text-primary', '--ln-text-secondary',
  '--ln-text-on-accent', '--ln-border', '--ln-accent', '--ln-accent-hover', '--ln-focus-ring', '--ln-font-body', '--ln-font-display'] as const;
export interface H5pAppearance { theme: 'light' | 'dark'; tokens: Record<string, string> }
export function normalizeH5pAppearance(theme: unknown, raw: unknown): H5pAppearance {
  const tokens: Record<string, string> = {};
  if (raw && typeof raw === 'object') for (const key of H5P_APPEARANCE_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length < 400 && /^[\w\s#(),.%"'\-]+$/u.test(value)) tokens[key] = value;
  }
  return { theme: theme === 'dark' ? 'dark' : 'light', tokens };
}

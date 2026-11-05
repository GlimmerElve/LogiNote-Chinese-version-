import type { VaultSettings } from '../../types';
export const ACCENT_PRESETS = ['indigo', 'purple', 'emerald', 'coral', 'rose', 'amber', 'teal', 'slate'] as const;
export function normalizeAccent(value: unknown): NonNullable<VaultSettings['accentColor']> {
  if (typeof value !== 'string') throw new Error('请选择强调色或提供 #RRGGBB 颜色');
  if (ACCENT_PRESETS.includes(value as typeof ACCENT_PRESETS[number])) return value as typeof ACCENT_PRESETS[number];
  if (/^#[\da-f]{6}$/iu.test(value)) return value.toUpperCase() as `#${string}`;
  throw new Error('自定义强调色必须是 #RRGGBB 格式');
}
type Rgb = [number, number, number];
const luminance = (rgb: Rgb) => rgb.map(channel => channel / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
const mix = (rgb: Rgb, target: Rgb, ratio: number): Rgb => rgb.map((channel, index) => Math.round(channel * (1 - ratio) + target[index] * ratio)) as Rgb;
const hex = (rgb: Rgb) => '#' + rgb.map(channel => channel.toString(16).padStart(2, '0')).join('');
export function customAccentTokens(value: string, dark: boolean): Record<string, string> {
  const color = normalizeAccent(value); if (!color.startsWith('#')) return {};
  const rgb = [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16)) as Rgb;
  const background: Rgb = dark ? [23, 28, 24] : [255, 254, 250];
  const target: Rgb = dark ? [255, 255, 255] : [0, 0, 0];
  let accent = rgb;
  for (let ratio = 0; ratio <= 1; ratio += 0.02) {
    accent = mix(rgb, target, ratio);
    const a = luminance(accent), b = luminance(background);
    if ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5) break;
  }
  const l = luminance(accent);
  return { '--ln-accent': hex(accent), '--ln-accent-hover': hex(mix(accent, target, 0.12)),
    '--ln-accent-soft': hex(mix(rgb, background, 0.9)), '--ln-accent-muted': hex(mix(rgb, background, 0.45)),
    '--ln-focus-ring': `rgba(${accent.join(',')},0.4)`, '--ln-text-on-accent': (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? '#000000' : '#ffffff' };
}
export function applyAccentAppearance(value: unknown, dark: boolean, root: Pick<HTMLElement, 'dataset' | 'style'>): void {
  let accent: NonNullable<VaultSettings['accentColor']>;
  try { accent = normalizeAccent(value || 'emerald'); } catch { accent = 'emerald'; }
  const custom = accent.startsWith('#');
  root.dataset.accent = custom ? 'custom' : accent;
  const tokens = customAccentTokens(custom ? accent : 'emerald', dark);
  for (const key of ['--ln-accent', '--ln-accent-hover', '--ln-accent-soft', '--ln-accent-muted', '--ln-focus-ring', '--ln-text-on-accent']) {
    if (tokens[key]) root.style.setProperty(key, tokens[key]); else root.style.removeProperty(key);
  }
}

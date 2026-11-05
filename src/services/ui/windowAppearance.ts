export type WindowTheme = 'light' | 'dark';

export interface WindowAppearanceApi {
  initialTheme?: WindowTheme;
  getTheme(): Promise<unknown>;
  onThemeChanged(callback: (theme: unknown) => void): () => void;
  updateTheme?(theme: WindowTheme): Promise<boolean>;
}

export function normalizeWindowTheme(value: unknown): WindowTheme | null {
  return value === 'light' || value === 'dark' ? value : null;
}

export function resolvePreferredWindowTheme(preference: unknown, systemDark: boolean): WindowTheme {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : normalizeWindowTheme(preference) || 'light';
}

/** OS changes affect appearance, not the user's persisted 'system' preference. */
export function connectPreferredWindowTheme(preference: unknown, media: Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>, apply: (theme: WindowTheme) => void): () => void {
  const refresh = () => apply(resolvePreferredWindowTheme(preference, media.matches));
  refresh();
  if (preference !== 'system') return () => {};
  media.addEventListener('change', refresh);
  return () => media.removeEventListener('change', refresh);
}

export function windowThemeBackground(theme: WindowTheme): string {
  return theme === 'dark' ? '#171c18' : '#fbf8f1';
}

export function applyWindowTheme(theme: WindowTheme, root: Pick<HTMLElement, 'classList' | 'style'>): void {
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

/** A delayed initial read cannot overwrite a newer event, or update a closed window. */
export function connectWindowAppearance(
  api: WindowAppearanceApi | undefined,
  apply: (theme: WindowTheme) => void,
  onError: (error: unknown) => void = () => {},
): () => void {
  if (!api) return () => {};
  let active = true, revision = 0;
  const initial = normalizeWindowTheme(api.initialTheme);
  if (initial) apply(initial);
  const receive = (value: unknown) => {
    const theme = normalizeWindowTheme(value);
    if (!active || !theme) return;
    revision += 1;
    apply(theme);
  };
  let unsubscribe = () => {};
  const startedAt = revision;
  try { unsubscribe = api.onThemeChanged(receive); } catch (error) { onError(error); }
  void Promise.resolve().then(() => active ? api.getTheme() : undefined).then(value => {
    if (active && revision === startedAt) receive(value);
  }).catch(error => { if (active) onError(error); });
  return () => { if (!active) return; active = false; unsubscribe(); };
}

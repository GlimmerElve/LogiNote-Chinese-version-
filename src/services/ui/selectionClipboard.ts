/** Keep the native copy attempt in the click gesture; never use a hidden textarea fallback. */
export function writeSelectionClipboard(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) return Promise.reject(new Error('clipboard-unavailable'));
  return navigator.clipboard.writeText(text);
}

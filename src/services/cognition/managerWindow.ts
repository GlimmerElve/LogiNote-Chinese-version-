import type { WindowAppearanceApi } from '../ui/windowAppearance';
export function cognitionWindowApi() {
  return (window as unknown as { electronAPI?: {
    cognitionManager?: { open(): Promise<void>; setBusy(busy: boolean): void };
    userState?: { getAgentTaskScope?(): Promise<string> };
    appearance?: WindowAppearanceApi; argument?: { openNote(noteId: string): Promise<void> };
  } }).electronAPI;
}
export function isCognitionManagerOpenRequest(text: string): boolean {
  return !/(?:不要|别|不必|无需|不想|不希望).{0,20}(?:打开|显示|进入|认知)/u.test(text)
    && /^(?:请|帮我|麻烦|我想|我要|我想要|请帮我)?\s*(?:打开|进入|调出|显示).{0,25}(?:个人认知|认知库|认知图谱)/u.test(text.trim());
}
export async function openCognitionManager(): Promise<{ opened: true }> {
  const api = cognitionWindowApi();
  if (api) {
    if (!api.cognitionManager?.open) throw new Error('请重新构建并重启应用以打开个人认知窗口');
    await api.cognitionManager.open();
  } else {
    const target = window.open(new URL('./cognition.html', window.location.href), 'loginote-personal-cognition');
    if (!target) throw new Error('窗口未打开，请允许本站弹出窗口后重试'); target.focus();
  }
  return { opened: true };
}

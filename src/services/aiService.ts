
function getAiApi(): any | null {
  return (window as any).electronAPI?.ai || null;
}

export async function requestAutoLink(
  content: string,
  existingNoteTitles: string[]
): Promise<{ updatedContent: string; addedLinks: string[] }> {
  const ai = getAiApi();
  if (!ai) {
    throw new Error("当前环境不支持 IPC 调用（仅桌面版可用）");
  }

  return ai.autoLink({ content, existingNoteTitles });
}
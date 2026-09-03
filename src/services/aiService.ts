import { AiSegmentResponse, LlmProvider } from "../types";
import { loadLlmSettings } from "./llmStorage";

function getAiApi(): any | null {
  return (window as any).electronAPI?.ai || null;
}

/** 解析 text-segmentation workflow 绑定的 provider（用于兜底的后端分词） */
function resolveSegmentProvider(): LlmProvider | null {
  const settings = loadLlmSettings();
  const bound = settings.workflowBinding['text-segmentation'];
  const pid = bound || settings.defaultProviderId;
  if (pid) {
    const p = settings.providers.find((x) => x.id === pid && x.enabled);
    if (p) return p;
  }
  return settings.providers.find((x) => x.enabled) || null;
}

export async function requestAiLogicSegmentation(
  text: string,
  noteTitle: string,
  existingNotes: string[] = []
): Promise<AiSegmentResponse> {
  const ai = getAiApi();
  if (!ai) {
    throw new Error("当前环境不支持 IPC 调用（仅桌面版可用）");
  }

  const provider = resolveSegmentProvider();
  if (!provider) {
    throw new Error("未找到可用的 LLM 服务商，请在设置中配置并启用至少一个。");
  }

  const resp = await ai.segment({
    text,
    noteTitle,
    existingNotes,
    provider: {
      apiType: provider.apiType,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      selectedModel: provider.selectedModel,
      models: provider.models,
    },
  });

  return resp as unknown as AiSegmentResponse;
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
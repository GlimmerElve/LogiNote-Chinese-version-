# Implementation Plan

将 LogiNote Pro 从「Express 后端(localhost:3000)」架构，完整迁移到「Electron IPC」架构；STT 保留独立 Python SenseVoice 进程，但改为动态端口并保证退出清理，实现打包后单 exe（界面+API 零 localhost）、零 Express。

## 背景与目标

当前项目有两个本地依赖：
1. `server.ts`（Express，3000 端口）提供前端页面 + 5 个 HTTP API（`/api/ai/proxy`、`/api/ai/segment`、`/api/ai/auto-link`、`/api/ai/resource-search`、`/api/ai/concept-generation`）；
2. `python/stt_server.py`（WebSocket，固定 8765 端口）提供语音转文字（SenseVoice / sherpa-onnx / pyaudio）。

打包后：
- 前端页面改用 `loadFile(dist/index.html)`（file:// 协议）加载；
- 5 个 API 全部迁移进 Electron 主进程并通过 IPC 暴露，前端 `fetch("/api/...")` 全部替换为 IPC；
- STT 保留 SenseVoice（识别效果不变），打包为独立 `stt_server.exe`，由主进程 spawn，使用**动态空闲端口**（不固定 8765），并在窗口退出时清理进程残留。

**硬性约束（用户明确要求）：**
- 禁止在 main 进程中引入/启动任何 Express/Nest、任何本地 HTTP 服务、任何 localhost 服务；
- 删除所有 `fetch("http://127.0.0.1:3000")` 与 `fetch("/api/...")` 调用，全部替换为 IPC；
- 前端用 `loadFile(dist/index.html)` 加载。

**STT 的最终决策（用户确认）：**
- 保留 SenseVoice（不切换到 whisper），即 STT 不走 Node IPC，而是保留独立 Python 进程；
- STT 端口**动态分配**，不固定 8765；
- Electron 窗口退出时清理 STT 进程残留；
- Python STT 打包为独立 `stt_server.exe`。

## Types

新增文件 `src/electron/ipcTypes.ts`（主进程与 preload 共用的类型定义）：

```ts
// LLM 统一请求（渲染进程收集好 provider 配置后传给主进程）
export interface LlmIpcRequest {
  provider: {
    apiType: 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama';
    baseUrl: string;
    apiKey: string;
    selectedModel?: string;
    models: string[];
  };
  systemPrompt: string;
  userInput: string;
  temperature: number;
  maxTokens: number;
  outputSchema?: object;
  tools?: LlmTool[];
  messages?: ChatMessage[];
}

// LLM 统一响应
export interface LlmIpcResponse {
  content: string;
  parsedJson?: unknown;
  usage?: { promptTokens: number; completionTokens: number };
}

// 流式分片
export interface StreamChunkIpc {
  type: 'reasoning' | 'content';
  text: string;
}

// AI 分词
export interface SegmentIpcRequest { text: string; noteTitle: string; existingNotes: string[]; provider: LlmProvider; }
export interface AutoLinkIpcRequest { content: string; existingNoteTitles: string[]; }

// DeepSeek 资源搜索 / 概念补全
export interface ResourceSearchIpcRequest { title: string; pathText: string; provider: LlmProvider; }
export interface ConceptGenIpcRequest { term: string; provider: LlmProvider; }
```

说明：`LlmProvider`、`LlmTool`、`ChatMessage`、`ResourceItem` 复用现有 `src/types.ts`，主进程通过 `import type` 复用，不重复定义。STT 不新增 IPC 类型（仍走 WebSocket，但端口动态传递）。

## Files

### 新增文件

1. **`src/electron/ipcTypes.ts`**
   主进程与 preload 共用的 IPC 类型（见 Types 节）。

2. **`src/electron/apiHandlers.ts`**
   承载原 `server.ts` 的 5 个 API 逻辑，导出纯函数供 main.ts 注册 IPC：
   - `proxyLlmRequest(req: LlmIpcRequest): Promise<LlmIpcResponse>`：按 apiType 转发到外部 API（Node `fetch`，无 CORS 限制）；
   - `streamLlmRequest(req, onChunk)`：流式转发（SSE 解析）；
   - `segmentText(req)`：AI 逻辑分词（兜底，走 provider 或 Gemini）；
   - `autoLink(req)`：纯本地字符串替换；
   - `resourceSearch(req)`：DeepSeek web_search 转发 + 解析；
   - `conceptGeneration(req)`：DeepSeek web_search 转发 + 解析。

### 修改文件

1. **`src/electron/main.ts`**
   - 删除 `DEV_URL` 常量与 `loadURL(DEV_URL)`；
   - `createWindow` 改为 `loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))`；
   - 注册新的 IPC handler（llm / ai）；
   - `spawnSttServer` 改为：动态空闲端口获取 → spawn `stt_server.exe`（打包态）或 `python stt_server.py`（开发态），携带 `--port` 与模型路径环境变量；
   - 增强退出清理：`before-quit` 与 `window-all-closed` 都 `sttProcess.kill()`，并确保进程树残留清理。

2. **`src/electron/preload.ts`**
   暴露：
   - `electronAPI.llm.request(...)`、`electronAPI.llm.stream(...)`、`electronAPI.llm.probe(...)`；
   - `electronAPI.ai.segment(...)`、`electronAPI.ai.autoLink(...)`、`electronAPI.ai.resourceSearch(...)`、`electronAPI.ai.conceptGeneration(...)`；
   - `electronAPI.stt.getPort()`（返回动态端口）与 `electronAPI.stt.getStatus()`。

3. **`src/electron/preload.d.ts`**
   补充上述接口的完整类型声明。

4. **`src/services/llmService.ts`**
   - `callLLM` 不再 `fetch(url)` 直连 / `fetch('/api/ai/proxy')`，改为 `window.electronAPI.llm.request(...)`；
   - 保留 RAG 上下文注入、parsedJson 解析等与网络无关的逻辑。

5. **`src/services/llmStreamService.ts`**
   - `callLLMStream` 不再 `fetch(url)`，改为 `window.electronAPI.llm.stream(...)` 并订阅 chunk 事件，重新封装为 `ReadableStream<StreamChunk>`。

6. **`src/services/aiService.ts`**
   - `requestAiLogicSegmentation`、`requestAutoLink` 改为 `window.electronAPI.ai.*`。

7. **`src/services/conceptFillService.ts`**
   - `generateConceptByWeb` 改为 `window.electronAPI.ai.conceptGeneration(...)`。

8. **`src/components/NoteEditor.tsx`**
   - 资源推荐的 `fetch('/api/ai/resource-search')` 改为 `window.electronAPI.ai.resourceSearch(...)`。

9. **`src/components/LlmSettingsPanel.tsx`**
   - 探活的 `fetch('/api/ai/proxy')` 改为 `window.electronAPI.llm.probe(...)`。

10. **`src/services/sttClient.ts`**
    - 保留 WebSocket 通路，但 `STT_WS_URL` 改为**动态获取**：`const port = await window.electronAPI.stt.getPort(); ws://127.0.0.1:{port}`。
    - `startStt / stopStt / warmupStt / isModelReady / subscribeModelReady` 接口保持不变。

11. **`python/stt_server.py`**
    - `PORT = 8765` 改为从命令行参数读取：`--port`（默认 8765，开发态兼容）。
    - 其余 SenseVoice 识别逻辑不变。

12. **`vite.config.ts`**
    - 增加 `base: './'`，确保 `file://` 下静态资源相对路径正确。

### 删除文件

1. **`server.ts`**：不再需要 Express 后端（5 个 API 已迁入 `apiHandlers.ts`）。

说明：`python/stt_server.py` **保留**（STT 仍用 SenseVoice），`release/` 中的 `stt_server.exe` **保留**并纳入打包。

## Functions

### 新增函数

- `src/electron/apiHandlers.ts`
  - `proxyLlmRequest(req: LlmIpcRequest): Promise<LlmIpcResponse>`
  - `streamLlmRequest(req: LlmIpcRequest, onChunk: (c: StreamChunkIpc) => void): Promise<void>`
  - `segmentText(req: SegmentIpcRequest): Promise<unknown>`
  - `autoLink(req: AutoLinkIpcRequest): Promise<{ updatedContent: string; addedLinks: string[] }>`
  - `resourceSearch(req: ResourceSearchIpcRequest): Promise<{ markdown: string; resources: ResourceItem[] }>`
  - `conceptGeneration(req: ConceptGenIpcRequest): Promise<{ content: string }>`

- `src/electron/main.ts`
  - `getFreePort(): Promise<number>`（用 `net.createServer().listen(0)` 获取空闲端口）

### 修改函数

- `src/electron/main.ts`
  - `createWindow()`：改为 `loadFile`。
  - `spawnSttServer()`：改为动态端口 + spawn exe/脚本，携带 `--port` 与 `LOGINOTE_MODELS_DIR`。
  - `registerIpcHandlers()`：新增 llm / ai / stt:get-port handler 注册。
  - `before-quit` / `window-all-closed`：增强 sttProcess 清理。

- `src/services/llmService.ts`
  - `callLLM()`：fetch 部分改为 IPC。

- `src/services/llmStreamService.ts`
  - `callLLMStream()`：fetch 部分改为 IPC 订阅。

- `src/services/aiService.ts`
  - `requestAiLogicSegmentation()` / `requestAutoLink()`：fetch 改 IPC。

- `src/services/conceptFillService.ts`
  - `generateConceptByWeb()`：fetch 改 IPC。

- `src/services/sttClient.ts`
  - `ensureConnected()`：STT_WS_URL 改为动态端口（await getPort）。

- `src/components/NoteEditor.tsx` / `src/components/LlmSettingsPanel.tsx`
  - 请求改 IPC。

- `python/stt_server.py`
  - `main()` / 模块级 `PORT` 改为解析 `--port` 参数。

### 删除函数

- `server.ts` 中全部函数（随文件删除）。

## Classes

无新增/修改类。现有 React 组件、Electron 模块均保留，仅内部函数调整。

## Dependencies

- **移除**：`express`（仅 `server.ts` 使用）、`@google/genai`（若 segment 兜底改走 provider 则不再需要）。
- **保留**：`@xenova/transformers`（embedding）、`vite`（构建）。
- **STT 相关（已在之前阶段完成）**：`stt_server.exe`（PyInstaller 打包 SenseVoice，含 sherpa-onnx / silero-vad / pyaudio）。
- **打包**：`electron-builder.yml` 的 `files` 加入 `dist/**/*`；`extraResources` 加入 `models/`（embedding + SenseVoice 模型）与 `release/stt_dist/stt_server/`（stt_server.exe）。

## Testing

1. **类型/编译**：`tsc --noEmit` 全量通过。
2. **构建**：`npm run build` 生成 `dist/`（含 `base: './'`），确认 file:// 下静态资源正确。
3. **LLM 链路**：配置真实 provider，跑「AI 分词 / 知识点识别 / 复盘分析」，确认 `callLLM` / `callLLMStream` 走 IPC 正常。
4. **AI 服务**：验证分词、自动关联、资源推荐、概念补全 4 个功能迁移后正常。
5. **STT**：确认动态端口生效（8765 被占用时也能启动）、语音识别逐句输出正常、退出后无 `stt_server.exe` 残留。
6. **打包**：`npm run dist` 产出；安装后断网/无 Node 环境验证全链路。

## Implementation Order

1. 创建 `src/electron/ipcTypes.ts`（类型基座）。
2. `vite.config.ts` 加 `base: './'`；`main.ts` 的 `createWindow` 改为 `loadFile`。
3. 创建 `src/electron/apiHandlers.ts`，迁移 5 个 API + LLM 转发的纯逻辑。
4. `main.ts` 注册 llm / ai IPC；`preload.ts` + `preload.d.ts` 暴露接口。
5. 改造 `llmService.ts` / `llmStreamService.ts` / `aiService.ts` / `conceptFillService.ts` / `NoteEditor.tsx` / `LlmSettingsPanel.tsx`，删除所有 `fetch("/api/...")` 与直连 fetch，改为 IPC。
6. `python/stt_server.py` 加 `--port` 参数；`main.ts` 的 `spawnSttServer` 改动态端口 + 退出清理；`preload` 暴露 `stt.getPort`；`sttClient.ts` 动态取端口。
7. 删除 `server.ts`；移除 express / @google/genai 依赖。
8. 补全 `electron-builder.yml`（dist + models + stt_server 入包）。
9. 全量 `tsc --noEmit` + `npm run build` + `npm run dist`，安装后全链路验收。

## 风险与注意事项

- **动态端口传递链路**：主进程 `getFreePort()` 拿到的端口需在 spawn 前确定，并通过 IPC 同步给渲染进程；需确保渲染进程先等待端口就绪再连 WebSocket（STT warmup 逻辑已能等待）。
- **端口竞争窗口**：`getFreePort()` 返回后、spawn 前可能有极小概率被占用，可接受；必要时 spawn 后重试。
- **退出清理**：需同时处理正常退出（before-quit）、窗口全关（window-all-closed）与崩溃（child.on('exit')），避免 `stt_server.exe` 残留。
- **file:// 资源路径**：必须 `base: './'`，否则 `loadFile` 后 JS/CSS 404。
- **LLM 流式**：主进程 SSE 流经 IPC 需用 `webContents.send` + `ipcRenderer.on` 订阅，处理 chunk 边界与关闭。
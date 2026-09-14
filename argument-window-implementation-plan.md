# Implementation Plan

[Overview]
将论证结构编辑器从「主窗口内全屏弹窗」重构为「独立 Electron 子窗口」，结果报告保持主窗口内弹窗，二者解耦。

本次改动的背景是：当前论证编辑器与结果报告被放在主窗口同一个 React `<App/>` 里——论证编辑器是 `App.tsx` 里的一个 `fixed inset-0` 全屏 `<div>`，结果报告是 `FlowAnalysisPanel` 弹窗。这导致「编辑旧图」时结果面板为空、「再次提交」结果无法回写报告等一系列耦合问题。解决方案是把论证编辑器拆成独立的 Electron `BrowserWindow`，由它专门负责画布编辑，主窗口只负责结果报告展示与笔记落盘。

高层面做法（方案 A：Vite 多入口）：
- 新增一个只渲染编辑器的 HTML 页面 `argument-editor.html` 与入口 `src/argumentEditorMain.tsx`；
- 主进程 `main.ts` 管理一个 `argumentWindow`，负责创建窗口并把数据（doc/noteId/entryMode）推送给该窗口；
- 编辑器窗口通过 IPC（`save`/`delete`）把结果回传主窗口，由主窗口执行既有的笔记落盘逻辑；
- 结果报告 `FlowAnalysisPanel` 保留在主窗口，分析完成后不再关闭它，与编辑器窗口「同时出现」。

[Types]
本方案不新增共享类型文件，IPC 载荷用结构化字面量在 preload 层透传，渲染层各自用本地 TS 接口。

preload 暴露的 `electronAPI.argument` 所承载的数据形状（渲染层访问时经 `(window as any).electronAPI.argument`）：

```
// 主窗 → 主进程 → 编辑器窗口：打开编辑器并推送初始数据
ArgumentEditorOpenPayload = {
  doc: ArgDoc;          // 论证文档（含 nodes/edges）
  noteId: string | null; // 归属笔记 id（首次新增时可能为 activeNoteId）
  entryMode: 'new' | 'edit';
}

// 编辑器窗口 → 主进程 → 主窗：保存
ArgumentEditorSavePayload = ArgumentEditorOpenPayload  // 含已编辑的 doc

// 编辑器窗口 → 主进程 → 主窗：删除
ArgumentEditorDeletePayload = { docId: string }
```

`ArgDoc`、`ArgNode`、`ArgEdge` 复用既有类型（`src/services/argumentDoc/types.ts`），不新增字段、不改序列化。

[Files]
文件改动清单：新建 3 个文件、修改 5 个文件、删除 0 个文件。

**新建文件：**

1. `argument-editor.html`（项目根，与 `index.html` 平级）
   - 独立编辑器窗口的 HTML 入口，`<div id="root">` + `<script type="module" src="/src/argumentEditorMain.tsx">`。

2. `src/argumentEditorMain.tsx`
   - 编辑器窗口的 React 挂载入口：导入 `createRoot`、`index.css`、`katex.min.css`，渲染 `<ArgumentEditorApp />`；不渲染 `App`、不渲染 `WindowResizeHandles`。

3. `src/ArgumentEditorApp.tsx`
   - 编辑器窗口根组件：持有本地 doc 状态、订阅 `onData` 拿初始数据、实现「再次提交」、`onSubmit` 走 IPC save、`onDelete` 走 IPC delete、渲染 `<ArgumentEditView />`。

**修改文件：**

4. `src/electron/main.ts`
   - 新增 `argumentWindow` 引用 + `createArgumentWindow()`；
   - 新增 IPC `argument-editor:open` / `argument-editor:save` / `argument-editor:delete`。

5. `src/electron/preload.ts`
   - `electronAPI` 下新增 `argument` 命名空间（open/onData/save/delete/onSaved/onDeleted）。

6. `src/App.tsx`
   - 移除全屏编辑器弹窗渲染、移除 `ArgumentEditView`/`ArgumentEditErrorBoundary` 导入、移除 5 个编辑器 state 与相关闭包；
   - `handleArgumentReady` 改为「打开编辑器窗口 + 保留结果报告」；
   - `handleArgumentBlockEdit` 改为「打开编辑器窗口（entryMode='edit'）」；
   - 新增 `onSaved`/`onDeleted` 订阅，驱动落盘。

7. `src/components/ArgumentEditView.tsx`
   - 新增 `hideResultPanel?: boolean` prop；为 true 时不渲染右结果面板与「收起/展开」切换按钮。

8. `vite.config.ts`
   - `build.rollupOptions.input` 增加多入口（`index.html` + `argument-editor.html`）。

[Functions]
函数级改动清单。

**主进程 `src/electron/main.ts`：**

- 新增 `createArgumentWindow(): BrowserWindow`
  - 类似 `createWindow()` 的配置（`frame:false`、`transparent:false`、同 preload），`minWidth/minHeight` 可更小（如 960×640），加载 `dist/argument-editor.html`。
- 新增 IPC（在 `registerIpcHandlers()` 内）：
  - `ipcMain.handle('argument-editor:open', (e, payload) => void)`：缓存 `pendingArgumentData`；若窗口不存在则 `createArgumentWindow()` 并在 `did-finish-load` 后 `webContents.send('argument-editor:data', payload)`，否则 `show()+focus()` 后直接 send。
  - `ipcMain.handle('argument-editor:save', (e, payload) => void)`：`mainWindow?.webContents.send('argument-editor:saved', payload)` 并 `argumentWindow?.close()`。
  - `ipcMain.handle('argument-editor:delete', (e, payload) => void)`：`mainWindow?.webContents.send('argument-editor:deleted', payload)` 并 `argumentWindow?.close()`。

**preload `src/electron/preload.ts`：**

- 新增 `argument` 对象（放入 `electronAPI`）：
  - `open(payload)` → `invoke('argument-editor:open', payload)`
  - `onData(cb)` → `ipcRenderer.on('argument-editor:data', handler)`，返回取消订阅
  - `save(payload)` → `invoke('argument-editor:save', payload)`
  - `delete(docId)` → `invoke('argument-editor:delete', { docId })`
  - `onSaved(cb)` / `onDeleted(cb)` → 订阅 `argument-editor:saved` / `argument-editor:deleted`

**编辑器入口 `src/ArgumentEditorApp.tsx`：**

- 新增 `ArgumentEditorApp`（默认导出）：
  - state：`doc: ArgDoc | null`、`submitting`；ref：`noteIdRef`、`entryModeRef`。
  - `useEffect`：启动时 `hydrateFromUserState()` 灌 LLM 配置；订阅 `onData` 写入初始数据。
  - `handleChange(doc)`：`setDoc(doc)`（仅内存，不落盘）。
  - `handleResubmit()`：迁移自 `App.handleArgumentResubmit` 核心逻辑——`argDocToPreprocess(doc)` → `fetchLayeredEvidence` → `applyVulnerabilities` → 本地 `useCanvasStore.getState().applyVulnerabilityPatch(updated.nodes)` → `setDoc(updated)`。
  - `handleSubmit()`：`electronAPI.argument.save({ ...doc, updated_at }, noteIdRef, entryModeRef)`。
  - `handleDelete()`：`window.confirm` 后 `electronAPI.argument.delete(doc.doc_id)`。

**主窗口 `src/App.tsx`：**

- 修改 `handleArgumentReady(doc, report)`：`if (!doc) { setIsFlowAnalysisOpen(false); return; }` → 改为 `if (!doc) return;` 后 `electronAPI.argument.open({ doc, noteId: activeNoteId, entryMode:'new' })` + `setAnalysisProgressOpen(false)`；**不再** `setIsFlowAnalysisOpen(false)`、不再设置编辑器 state。
- 修改 `handleArgumentBlockEdit(docId)`：找到 doc/noteId 后 `electronAPI.argument.open({ doc, noteId, entryMode:'edit' })`，移除 `setArgumentEditingDoc` 等。
- 新增 `performArgumentBlockDelete(docId)`：执行原 `handleArgumentBlockDelete` 除 `window.confirm` 外的删除落盘逻辑。
- 保留 `handleArgumentBlockDelete(docId)`（正文卡片 × 用，内含 confirm，末尾调用 `performArgumentBlockDelete`）。
- 新增 `saveArgumentDoc(doc, noteId, entryMode)`：原 `handleArgumentSubmit` 的落盘逻辑（`entryMode==='new'` 追加 + 插 block；`'edit'` 覆盖同 doc_id）。
- 新增 `useEffect`：订阅 `electronAPI.argument.onSaved`（→ `saveArgumentDoc`）与 `onDeleted`（→ `performArgumentBlockDelete`）。
- 移除：`handleArgumentChange`、`handleArgumentResubmit`、`handleArgumentSubmit`、`handleArgumentDeleteCurrent`、`argumentEditingDoc`/`argumentEditingNoteId`/`argumentEntryMode`/`argumentReport`/`argumentSubmitting` 五个 state、`ArgumentEditView`/`ArgumentEditErrorBoundary` 导入与全屏弹窗渲染块。

**组件 `src/components/ArgumentEditView.tsx`：**

- 修改 props：新增 `hideResultPanel?: boolean`。
- 当 `hideResultPanel === true`：不渲染右结果面板 `<FlowAnalysisPanel>`，不渲染顶栏「收起/展开结果」切换按钮与右面板「关闭」按钮。

[Classes]
本方案不新增或修改类。`ArgumentCanvas`、`canvasStore`、各 Node/Edge 组件保持不变（编辑器窗口复用同一套，因编辑窗口是独立 JS 上下文，canvasStore 天然隔离，无需改造）。

[Dependencies]
无新增第三方依赖。复用既有 `electron`、`@xyflow/react`、`@mdxeditor/editor`、`vite`、`@vitejs/plugin-react`。

构建联动点：`package.json` 的 `build` 脚本仍为 `vite build`（多入口自动产两个 HTML）；`build:electron` 仍为 esbuild 打包 main/preload；`npm run electron` 不变。

[Testing]
- `npm --prefix ".../ios-风格智能学习计划笔记-(obsidian-loginote)" run lint`（即 `tsc --noEmit`）：确认无 `error TS`。
- `npm --prefix ... run build`：确认 `dist/index.html` 与 `dist/argument-editor.html` 均产出。
- 手动验证清单（启动 Electron 后）：
  1. 首次心流分析完成 → 结果报告留在主窗口弹窗 + 编辑器独立窗口同时出现；
  2. 正文点击 `<ArgumentBlock>` → 只开编辑器独立窗口（不带报告）；
  3. 编辑器窗口内「再次提交」→ 画布节点红黄标记/建议实时更新；
  4. 「保存并退出」→ 主窗口笔记正文或 argumentDocs 正确落盘，编辑器窗口关闭；
  5. 「删除此图」→ 编辑器窗口 confirm 后，主窗同步删除 argumentDocs 与正文 `<ArgumentBlock>`；
  6. 编辑器窗口可拖到主窗口之外独立显示。

[Implementation Order]
1. `vite.config.ts` 增加多入口（先改构建，后续文件可被识别编译）。
2. 新建 `argument-editor.html` + `src/argumentEditorMain.tsx`。
3. `src/electron/main.ts` 新增 `argumentWindow` 与三个 IPC。
4. `src/electron/preload.ts` 新增 `argument` 命名空间。
5. `src/ArgumentEditorApp.tsx` 新建编辑器窗口根组件（含再次提交 + save/delete IPC）。
6. `src/components/ArgumentEditView.tsx` 新增 `hideResultPanel` prop。
7. `src/App.tsx` 移除全屏编辑器、改为窗口调度（open/onSaved/onDeleted）。
8. `npm run lint`（tsc --noEmit）与 `npm run build` 验证。
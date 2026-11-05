# LogiNote Demo-first 改造：工程准备基线

> 已归档：该准备计划已经完成，仅保留作历史参考。

更新日期：2026-10-01

## 本阶段目标

在不开始页面换肤的前提下，先冻结跨页面不可破坏的行为、恢复可重复执行的测试基线，并为后续 P1–P9 改造提供统一验收入口。

## 已冻结契约

- `WorkspaceShell`：普通工作区，按页面决定是否显示全局侧栏。
- `FocusShell`：心流、苏格拉底复习、S1、S4；隐藏全局 Header 与 Sidebar，由页面自己提供退出。
- `ResultShell`：复盘/复习结果；允许恢复全局 Header，不显示工作区侧栏。
- 心流退出：分析关闭时先保存再退出；分析开启时先保存，再执行分析。分析失败不得回滚已保存内容。
- STT：原始转写不可变；本地规则只处理语气词、相邻重复与停顿边界；可选 LLM 文本仅作为分析副本；MiniLM 只负责相似度与分段辅助。
- 复习轨迹：只能展示用户回答与结构化观察，不展示模型隐藏推理；掌握度至少需要两次有效样本。

代码事实源：`src/services/ui/refactorContracts.ts`。

## 起始工作区风险

准备阶段开始时，`git status --porcelain` 共报告 319 个条目，其中 227 个已跟踪变更、92 个未跟踪条目。它们覆盖 `App.tsx`、`types.ts`、核心服务、Electron、场景、计划、资源和构建产物。

因此：

1. 本阶段不提交、不暂存、不清理这些既有改动。
2. 后续页面替换前必须建立用户认可的可恢复快照或隔离基线。
3. 所有修改使用窄补丁；不得整文件覆盖核心脏文件。

## 统一准备度命令

```text
npm run check:ui-refactor-ready
```

该命令顺序验证：TypeScript、跨页面契约、画像、记忆、RAG、Agent、Agent E2E、场景、原子写入、资源浏览与文档解析。任一步失败即停止，并在结尾报告工作区是否仍有未保存改动。

构建门禁独立运行：

```text
npm run build
npm run build:electron
```

在当前受限 Windows 执行环境中，从 Node 子进程再次启动 Vite/esbuild 会被文件系统沙箱拒绝，而同一命令作为顶层进程可正常执行。因此统一行为检查不嵌套构建；CI 或普通开发终端仍应将三条命令作为同一门禁组。

## 开工门槛

- 准备度命令、Web 构建与 Electron 构建全绿。
- 当前既有改动已具备可恢复方式。
- P1 只建立 Design Token 与三类 Shell，不同时改业务数据。
- P2–P6 按页面纵向切片，每片必须保留现有数据写回和专项回归。
- Plan V2、KnowledgeRelation v1 在 UI 接入前先完成版本化类型、迁移和纯函数测试。
- 多角色 SceneSpec V2 不阻塞首版单角色 S1，继续独立立项。

## 本次执行结果

- `npm run check:ui-refactor-ready`：通过。
- `npm run build`：通过；保留既有的 ONNX `eval` 与大 chunk 警告，当前不阻塞 UI 改造。
- `npm run build:electron`：通过。
- 论证 RAG 旧测试已同步到 `publishedSnapshot` 质量门控语义，记忆检查恢复通过。
- 受限 Windows 会话中的 `uv_os_get_passwd` 故障已由测试启动器局部兜底，场景检查恢复通过；生产代码不受影响。
- 当前工作区仍有大量改动；未执行 commit、stash、reset、清理或覆盖操作。

工程准备状态：行为与构建基线已建立；进入 P1 页面替换前，仅剩“为现有脏工作区建立用户认可的可恢复快照”这一项操作性门槛。

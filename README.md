# LogiNote Pro

一款基于 Obsidian 双向链接理念的 iOS 风格智能学习计划笔记应用。以本地优先、隐私安全的 Markdown 知识库为核心，集成语音复盘、AI 分析、间隔复习与知识图谱，帮助学习者在「记录 → 复述 → 复习」的闭环中持续深化理解。

## 技术栈

- **桌面端**：Electron 35
- **前端**：React 19 + TypeScript + Vite 6 + Tailwind CSS 4
- **编辑器**：MDXEditor（CodeMirror 内核）
- **本地 AI 检索**：@xenova/transformers（paraphrase-multilingual-MiniLM-L12-v2）
- **语音转文字**：Python + sherpa-onnx（SenseVoice）+ PyAudio
- **数据存储**：本地 Markdown + metadata.json（Obsidian 兼容）+ IndexedDB 向量索引

## 核心功能

- **双向链接笔记**：支持 `[[笔记标题]]` 与 `[[原名|别名]]` 语法，自动关联、反向链接与知识图谱可视化。
- **逻辑分词**：AI 将长文本解构为概念/定义/逻辑推导/总结等结构化片段，并提取学习任务与双向链接建议。
- **心流学习模式**：沉浸式学习 + 白噪音 + 定时复盘提醒。
- **语音复盘**：本地语音转文字（SenseVoice），逐句伪流式输出，退出后自动触发 AI 分析。
- **知识点识别与掌握度**：两阶段识别知识点（本地匹配 + LLM 语义识别），并按「概念 / 判断 / 推理」三层证据锚点评定掌握度。
- **间隔复习**：基于 DSR 记忆算法的气泡复习、苏格拉底式对话复习。
- **学习可视化**：时间线日历、学习计划、用户能力画像与周报统计。
- **资料文档 RAG**：上传 PDF / Markdown / TXT，本地向量化后用于知识点概念补全与检索增强。

## 数据与隐私

所有笔记正文以 Markdown 文件存储在本地 `vault/` 目录，结构化元数据集中在 `metadata.json`。个人学习状态（复习记忆、掌握度、画像）单独存储在 `user-state/`，与可分享的笔记内容分离。语音识别与向量检索均在本地完成，不依赖云服务。

## 目录结构

```
├── src/                 # 前端源码（React 组件、服务、工作流提示词）
│   ├── electron/        # Electron 主进程、preload、IPC 处理
│   ├── services/        # 业务服务（LLM、RAG、知识点评分、存储等）
│   ├── components/      # UI 组件
│   └── workflows/       # 各类 LLM 提示词模板
├── models/              # 本地模型（SenseVoice + 嵌入模型）
├── python/              # STT 后端脚本
├── dist/                # 前端构建产物
├── dist-electron/       # Electron 主进程构建产物
└── launcher.py          # 桌面版启动器
```

## 本地运行

下载最新安装包即可启动
需要配置以下 LLM 服务商之一（用于 AI 分析、知识点识别等）：

- DeepSeek（默认，支持联网搜索）建议国内使用
- 任意 OpenAI 兼容接口
- Anthropic Claude
- Google Gemini
- Ollama（本地）

## 许可

MIT License

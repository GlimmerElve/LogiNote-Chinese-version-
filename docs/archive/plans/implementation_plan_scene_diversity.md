# Implementation Plan — 场景模拟多样化

> 已归档：该实施计划已被后续方案取代，仅保留作历史参考。

[Overview]
把「场景模拟」从硬编码的"单角色扮演对话"泛化为**由 LLM 选择配方并组装声明式组件的回合引擎**，并让消息渲染支持 Markdown / 公式 / 表格 / 代码块 / 图片，配套**RAG 引用角标**与**划词/右键智能操作**；同时为后续 Agent 工具输出富格式内容预留渲染与交互通道。

当前系统有三处锁死多样性的硬编码（已核实）：
1. **生成层** `src/workflows/scenePrompt.ts`：`SCENE_GENERATE_PROMPT` 的 14 条原则全部围绕"说服/谈判"（原则 2/3/6），并硬性规定 `engineConfig.paradigm 一律填 "single-role-dialogue"`（第 107 行），`role.attributes` 必填性格字段。→ "出题答题"类场景被完全排除。
2. **运行层** `src/services/scene/sceneDirector.ts`：`buildRoleSystemPrompt`（第 111 行）只拼"角色卡 → 用户身份 → 情境/任务 → 规则"，没有"出题官/评判官"这类发言者概念。
3. **渲染层** `src/components/scene/SceneChatView.tsx`：第 78 行 `{m.content}` 直接输出字符串，**无 Markdown、无公式、无代码块**——"枯燥"的直接原因。

**核心洞察**：底层引擎（`sceneRuntime.ts` 的 `SceneRunState` / `checkCompletion` / 回合计数 / 指标合并）**已经是范式无关的通用容器**。S4 数理画布的成功扩展（`sceneRuntime.ts:68` 的 `spec.compute ? initCanvasState(spec) : undefined`）证明了"新增范式 = 新增可选字段 + 分派分支"这一模式的可行性。

**架构选择：C（通用回合契约）+ 最小结构化契约**。不枚举范式，而是引入可选字段 `SceneSpec.behavior` 描述"每轮谁发言、用户做什么、如何评价、如何推进"，由 LLM 在生成阶段自由设计。运行时的发言提示词由 `behavior` 动态拼装，取代原硬编码角色卡模板。

**不新增场景类型**：`S1`（对话场景）**本身就是「流式问答回合范式」**——答题、辩论、引导式教学、苏格拉底追问均属此范式，不应另立类型。因此本计划**升级 S1 的生成提示词**，让新生成的 S1 场景一律携带 `behavior`；**不新增 `G1` 或任何新 sceneSkill 值**，搭建面板的类型选项保持「对话场景 / 数理场景」两项不变。

向后兼容采用「`behavior` 存在性」作为唯一判据，而非类型分派：
- **存量 S1 场景**（无 `behavior`）→ 走原角色扮演提示词 → **零影响**
- **新生成 S1 场景**（有 `behavior`）→ 走通用回合路径 → 支持任意一问一答范式
- **S4 场景**（有 `compute`）→ 走画布路径 → **零影响**

**可视化方案：B（混合形态）**。短对白用气泡保留对话感；含块级结构（表格/代码/公式）或长内容的消息升级为**全宽文档卡片**，为富内容提供足够宽度。判定规则为纯函数，可测。

**引用系统**：为通用范式场景开启 RAG 检索，AI 引用时以**上标数字角标**标注（`[1]`），悬停显示来源片段卡，点击跳转笔记/资料。角标来源数据必须来自 `assembleMemoryContext` 后续补充的结构化 provenance；现有 trace 仅用于审计，信息不足。

**交互系统**：**不使用按钮栏**，改为**划词浮条 + 右键菜单**——用户划选文字后在选区上方浮出智能操作条，动作**随选中内容类型变化**（普通文本/公式/代码/题目各不同）。复用项目已有的 `ContextMenu` 范式。

**范围边界**：本计划交付「通用范式引擎 + 完整可视化规范 + RAG 角标 + 划词交互」。**不实现** Agent 生成图片/表格的工具（属 Agent 计划 P2+），但保证渲染层与交互层能承接其输出。

[Current Status]
已完成第一阶段的最小可运行闭环：`SceneSpec.behavior` 类型与信任边界解析、`compute > behavior > dialogue` 统一分派、S1 生成/改编携带 behavior、确认页展示与编辑、`scene-general-turn` 通用回合工作流，以及纯函数回归检查。存量 S1 与 S4 路径保持不变。

第二阶段已接入统一安全富文本渲染：复用现有 `react-markdown`、`remark-gfm` 与 KaTeX，支持 Markdown、GFM 表格、代码块、行内/块级公式和图片；原始 HTML 默认不解析，外链在新窗口打开，图片延迟加载且不发送 referrer。公式预处理会避开 Markdown 代码段，并对流式未闭合公式降级为普通文本。

第三阶段已完成结构化笔记 RAG provenance：检索结果先经过字段校验、长度限制、分数归一和去重，记忆装配仅暴露实际进入上下文预算的编号来源；`scene-general-turn` 通过可选回调把来源写入对应场景消息。正文合法 `[n]` 渲染为可悬停、可点击的来源角标，漏标时在消息末尾显示来源兜底；无命中、越界编号和代码段中的标记不会生成引用。点击角标按 `noteId` 打开已有笔记。

第四阶段已把划词能力从场景局部组件扩展为全局 `SelectionActionHub`：场景 AI 消息、心流模式 AI 解答、苏格拉底导师消息、笔记编辑区与知识点预览均可通过划词或在有效选区上右键，执行复制、解释、举例、追问和“知识点草案”。动作统一携带来源上下文进入 Agent；选区被视为不可信引用材料，复习页额外禁止直接泄露答案。“知识点草案”会进入独立的权限收窄 Skill，先展示标题、正文和标签预览，只有用户确认后才新建并打开知识点笔记；取消不写入，且不更新画像或掌握度。资料列表目前没有正文阅读器，因此资料正文划词待阅读器落地后接入；论证编辑器与公式源码级选区仍是后续专用适配项。

第五阶段已增加 `scene-setup` Agent Skill：Agent 可读取当前或指定项目、整个项目子树真实关联的知识点及掌握状态，形成受校验的 `SceneInitialRequest` 并交给既有 `SceneMode`。场景搭设默认使用 `build` 以复用已有骨架；仅在用户明确要求全新场景时使用 `auto`。概念应用、答题、诊断、辩论和角色练习走 S1，只有明确的公式推导、解方程、证明或逐步数理演算走 S4。Agent 进入后关闭侧栏，用户仍在专用预览页检查和调整；预览前不保存，也不形成掌握度或画像证据。

第六阶段已完成受控的“场景交互能力协议”和首个组件包：组件注册表统一公布文本、单选、多选、排序、填空及组合题组能力，前端只渲染已注册能力并对用户响应做确定性校验；未知类型、白名单外类型和字段不完整的指令安全降级为文本输入。普通配方仍遵循“一轮一道题或一个行动”；`batch-assessment` 配方可用单个 `question-set` 组合 2~12 道单选、多选和判断题，同屏展示、一次提交、提交后统一反馈，不再要求用户手写“1.B 2.A”。组件协议不携带正确答案或隐藏判据，AI 回合与指标判定会接收题组结构和经校验的原始作答。破损或截断 JSON 会提取已完成的 content 作为 Markdown 展示，不再把 JSON 外壳直接暴露给用户。

第八阶段已把场景搭设改为“配方 + 组件树”移交：`scene-setup` Skill 会从稳定配方中选择 `recipeId`，随 `sceneRequest` 进入生成流程；场景生成和运行提示词从同一个组件注册表生成能力清单，避免多处手写白名单漂移。后续规划 Agent、出题 Agent、资源 Agent 之间只需交换配方 id、学习目标和声明式组件数据，无需交换 React 组件或页面操作指令。

第九阶段已建立跨运行面的统一能力注册表：`turn` 登记 S1 文本、题型和组合题组，`canvas` 登记 S4 已知/假设/公式/结论节点、DAG 推导连线、MathLive、步骤提交、前提链判定和限次求助，`shared` 登记共用富文本展示。原 S1 组件注册表改为统一目录的兼容视图；S4 使用 `guided-derivation` 画布配方。Agent 工具会校验 `sceneSkill` 与 `recipeId` 的运行面兼容性，拒绝跨引擎错误装配。统一的只是能力发现、提示词清单和移交格式，S1 回合引擎与 S4 画布/计算引擎仍保持隔离。

第七阶段已加入交互协议质量审计：每个通用回合记录模型请求类型、最终采用类型、结果状态和固定降级原因码，独立保存到本地 `user-state/scene-interaction-audit.json`。审计不保存题干、用户答案、模型原文或笔记内容，最多保留 500 条且清理 180 天前记录；已预留列表与聚合接口，后续可在审计页面展示接受率、降级率和原因分布。

当前引用范围只包括用户笔记 RAG，不包含资料文档 RAG；后者需要单独统一 `documentRag` 的来源协议。

[Architecture]
本节定义范式泛化与可视化的结构设计。

### 分派优先级（三路径，互不干扰）

```
SceneSpec
  ├─ spec.compute 存在   → S4 数理画布（SceneDerivationView）            【不改】
  ├─ spec.behavior 存在  → 对话场景·通用范式发言（SceneChatView）         【S1 升级后新场景走此路】
  └─ 都不存在            → 对话场景·传统角色扮演（SceneChatView，原路径）  【存量场景，不改】
```

判定函数集中在新建的 `sceneParadigm.ts`，供生成、运行、渲染三处共用，避免判定逻辑分散。

### `behavior` 结构设计（替代硬编码角色卡）

```ts
/**
 * 交互范式的自然语言描述（由 LLM 在生成阶段设计，运行阶段据此拼装发言提示词）。
 * 存在此字段 → 走通用范式路径；缺省 → 走 S1 角色扮演路径（向后兼容）。
 */
export interface SceneBehaviorSpec {
  /** 范式短标签，用于 UI 与场景库索引，如「答题闯关」「引导式教学」「辩论对抗」 */
  kind: string;
  /** AI 每轮扮演什么、以什么方式发言（自然语言，取代原角色卡模板） */
  aiBehavior: string;
  /** 用户每轮需要做什么 */
  userAction: string;
  /** 如何评价用户这一轮的表现（供指标引擎参考） */
  evaluationRule: string;
  /** 推进策略：如何决定下一轮内容（如「根据错题定向出题」「由浅入深」） */
  progressionRule: string;
  /** AI 输出需要哪些格式（由 LLM 自行声明，用于运行时的格式提示与渲染预设） */
  outputFormats?: SceneOutputFormat[];
}

/** 富内容格式（与渲染层能力一一对应） */
export type SceneOutputFormat = 'markdown' | 'latex' | 'code' | 'table' | 'image';
```

**为何用自然语言而非枚举**：需求是"范式依赖 LLM 的理解"。枚举会重新引入硬编码；自然语言让 LLM 描述任意交互形态，同时保留结构化骨架（轮次/指标/完成判定）以保证可运行。

### 通用回合循环（复用现有骨架）

```
用户输入
  ↓
① 通用发言（scene-general-turn，流式，含 RAG 检索）
   · 输入：behavior（五段描述）+ situation/task + 指标现状 + 历史
           + RAG 命中来源（带编号）+ outputFormats 格式要求 + 引用标注要求
   · 输出：AI 发言（可含 Markdown/公式/代码/表格 + [n] 引用角标）+ 可选 [结束:原因]
  ↓
② 指标更新（scene-metric-update，复用现有，零改动）
  ↓
③ 突发事件触发（checkEventTriggers，复用）
  ↓
④ 完成判定（checkCompletion，复用）
```

**六成以上能力复用**：指标引擎、事件系统、完成判定、回合计数、反事实重跑全部沿用。

### 消息形态分派（B 方案核心）

```
SceneMessage（NPC 发言）
  ↓
resolveMessageShape(content)  ← 纯函数判定
  ├─ 'bubble'  短对白/寒暄 → 气泡（保留对话感）
  └─ 'card'    含块级结构或长内容 → 全宽文档卡片（提供宽度）
```

判定规则（详见 [Message Shapes]）：
- 含表格 / 代码块 / 块级公式 / 图片 → **card**
- 或：段落数 ≥ 3 → **card**
- 或：字符数 ≥ 200 → **card**
- 否则 → **bubble**

**用户消息始终为 bubble**（除用户主动粘贴长内容，本计划不做特殊处理）。

### 引用系统架构（RAG 角标）

RAG 检索结果经 `assembleMemoryContext` 注入时为**带编号的清单**（`buildRagContext` 已生成 `1. 笔记「X」…` 格式）。要求 LLM 引用时标注 `[1]`。

```
主进程/渲染进程
  assembleMemoryContext → { prefix, trace }
    · prefix 含编号来源清单（"1. 笔记「导数基础」…"）
    · provenance 给出编号、noteId、标题、相关度与片段；trace 只保留审计摘要
  ↓
  SceneMode 保存本轮 trace（存 SceneTurnCitation）
  ↓
  SceneMessageContent 解析 content 中的 [n] → 渲染为上标角标
  ↓
  悬停 → 显示来源片段卡；点击 → 跳转笔记
```

**兜底**：若 LLM 未标注 `[n]`，但本轮确有 RAG 来源，则在消息末尾显示全部来源角标。保证"有来源必可见"。

**注意**：RAG 检索与 `SceneSpec.behavior` 的 `outputFormats` 无关——是否开启 RAG 由**记忆配方**决定（见 [Memory Recipe]），不是由场景声明决定。

[Memory Recipe]
本节定义新增的记忆配方（RAG 角标的前提）。

### 现状（已核实）

```ts
'scene-role-reply': {
  maxChars: 1000, profileChars: 1000, ragChars: 0, episodeChars: 0,
  rag: false, episodeTypes: [], trustedProfileOnly: true,
}
```

**`rag: false` / `ragChars: 0`** —— 场景对话目前**完全不检索笔记与资料**，仅注入学习画像。因此"引用角标"当前**无来源可引**。

### 新增配方 `scene-general-turn`

在 `src/services/memory/memoryContextBuilder.ts` 的 `RECIPES` 中新增（**仅新增一项，不改动任何既有配方**）：

```ts
'scene-general-turn': {
  maxChars: 2200, profileChars: 800, ragChars: 1200, episodeChars: 0,
  rag: true, episodeTypes: [], trustedProfileOnly: true,
},
```

**设计依据**：
- `rag: true` + `ragChars: 1200`：给出足够的检索内容额度（top-3 命中，每条摘要约 300-400 字）。
- `maxChars: 2200`：profile(800) + rag(1200) + 分隔符余量。**从 1000 提高到 2200**，因为原额度是为"NPC 说话简短"设计的，塞不下检索内容。
- `episodeChars: 0` + `episodeTypes: []`：通用范式场景不使用历史学习事件（避免干扰当前交互）。
- `trustedProfileOnly: true`：沿用场景的画像可信门槛策略。

### 关键隔离

| 配方 | 使用方 | RAG | 影响 |
|---|---|---|---|
| `scene-role-reply` | **传统角色扮演**（存量 S1） | ❌ 保持 `false` | **完全不改**，NPC 维持"人味"，不变教材腔 |
| `scene-general-turn` | **通用范式**（新 S1） | ✅ 开启 | 支持引用角标 |

**为什么传统角色扮演不开 RAG**：角色扮演的沉浸感依赖 NPC"只知道自己该知道的"。若注入用户笔记，NPC 会变得像"读过你笔记的助教"，破坏角色设定。

### 预算影响评估

| 项 | 变化 |
|---|---|
| 通用范式单轮上下文 | 1000 → 2200 字符（约 +1.2K token） |
| 传统角色扮演 | **无变化** |
| 其他 workflow | **无变化** |

[Types]
新增 `behavior` 相关类型、消息形态类型、引用角标类型。全部为**可选新增**，不破坏既有类型。

### 修改 `src/types/scene.ts`

**新增类型**（置于 `SceneSpec` 之前）：
```ts
/** 富内容格式（与渲染层能力一一对应） */
export type SceneOutputFormat = 'markdown' | 'latex' | 'code' | 'table' | 'image';

/**
 * 交互范式的自然语言规范（由 LLM 生成阶段设计）。
 * 存在此字段 → 走通用范式路径；缺省 → 走 S1 角色扮演路径（向后兼容）。
 */
export interface SceneBehaviorSpec {
  kind: string;
  aiBehavior: string;
  userAction: string;
  evaluationRule: string;
  progressionRule: string;
  outputFormats?: SceneOutputFormat[];
}

/** 消息呈现形态（B 方案：短对白用气泡，富内容用全宽卡片） */
export type SceneMessageShape = 'bubble' | 'card';

/**
 * 单条消息的引用来源（本轮 RAG 命中的笔记/资料）。
 * 由 SceneMode 在回合结束后写入 SceneMessage.citations。
 */
export interface SceneCitation {
  /** 角标编号（1 起，与 prompt 中的编号清单一致） */
  index: number;
  /** 来源类型 */
  kind: 'note' | 'document';
  /** 笔记 id（kind='note'） */
  noteId?: string;
  /** 笔记/资料标题 */
  title: string;
  /** 相关度（0~1） */
  score: number;
  /** 摘录片段 */
  snippet: string;
}
```

**修改 `SceneSpec`**：新增一个可选字段（放在 `extras` 之后、`compute` 之前）
```ts
  /** 通用交互范式规范（新增，可选）。存在时运行时走通用回合路径。 */
  behavior?: SceneBehaviorSpec;
```

**修改 `SceneMessage`**：新增两个可选字段
```ts
  /** 富内容格式（可选）：由运行时按 content 判定后写入，供渲染层选择形态 */
  // 注：形态由渲染层纯函数即时判定，不落盘；此字段仅用于忽略历史遗留值
  /** 引用来源（可选，仅 NPC 消息）：本轮 RAG 命中清单，供角标渲染与跳转 */
  citations?: SceneCitation[];
```

**`SceneSpeakerType` 保持不变**：通用场景中"出题""评判"仍用 `role`（发言者名由 `behavior.kind` 决定），无需新增 speaker 类型。

### 修改 `src/types/scene.ts` 的 `SceneManifestEntry.architecture`

新增可选字段，让场景库能展示范式种类：
```ts
    /** 范式短标签（通用场景专用，如「答题闯关」）；S1 传统/S4 缺省 */
    behaviorKind?: string;
```

### 修改 `src/types.ts` 的 `LlmWorkflowId`

末尾**只追加一个** workflow id（生成侧复用现有 `scene-generate`，不新增）：
```ts
  | 'scene-general-turn'       // 对话场景·通用范式回合发言（流式，携带 behavior，可检索 RAG）
```

**不新增 `scene-general-generate`**：S1 生成提示词是**就地升级** `SCENE_GENERATE_PROMPT`（仍走 `scene-generate` workflow），故无需新 workflow id。
**不新增 `SCENE_SKILL_GENERAL`**：不新增场景类型，`SceneSkillType` 保持 `'S0'`~`'S12'` 不变，`sceneS4.ts` 无需改动。

[Files]
完整方案预计修改若干既有文件并创建 8 个新文件，无删除、无移动；第一阶段已优先落地通用范式核心文件。

### 新建文件（7 个）

**范式与形态（纯函数层）**

1. **`src/services/scene/sceneParadigm.ts`** — 范式判定与行为提示词拼装（纯函数）。
   - `resolveSceneParadigm(spec): 'compute' | 'general' | 'dialogue'`（判定优先级：compute > behavior > dialogue）
   - `buildBehaviorPromptSection(spec): string`（把 `behavior` 五段 + `outputFormats` 渲染成提示词段落）
   - `buildOutputFormatHint(formats?): string`（格式枚举 → 富格式使用指令）
   - `buildCitationInstruction(): string`（生成"引用时标注 `[n]`"的指令文本）

2. **`src/services/scene/sceneMessageShape.ts`** — 消息形态判定（纯函数，B 方案核心）。
   - `resolveMessageShape(content: string): SceneMessageShape`
   - 判定规则：含块级结构（` ``` ` / `|` 表格 / `$$` / `![`）或段落数 ≥ 3 或字符数 ≥ 200 → `'card'`；否则 `'bubble'`。
   - 需处理代码围栏内的伪标记（如代码块内的 `|` 不应误判为表格）——**这是实现要点**，见 [Message Shapes]。

3. **`src/services/scene/sceneCitation.ts`** — 引用解析与来源构建（纯函数）。
   - `parseCitationMarkers(content: string): number[]`（抽取正文中出现的 `[n]` 编号，去重排序）
   - `stripCitationMarkers(content: string): string`（把已被角标组件渲染的标记从纯文本路径中剥离，供 speech/复制使用）
   - `buildCitationsFromTrace(trace: MemoryContextTrace): SceneCitation[]`（从 trace 的 rag 段构建来源清单）
   - **注意**：`parseCitationMarkers` 需避免误匹配 Markdown 链接 `[text](url)` 与任务列表 `[x]`——只匹配 `[数字]` 形式。

**渲染组件**

4. **`src/components/scene/SceneMessageContent.tsx`** — 富文本消息渲染（S1/S4/通用共用）。
   - 基于 `react-markdown` + `remark-gfm` + `remark-math` + `rehype-katex`。
   - 支持：表格、列表、代码块、行内/块级公式、图片、引用块。
   - 自定义 `components`：`table`（滚动容器）、`code`（代码块样式 + 复制）、`sup`（角标样式）。
   - 角标渲染：把正文中的 `[n]` 转换为可交互的上标角标（见 [Citation System]）。
   - 保留流式光标。
   - **`React.memo`**：非流式消息不重渲染。

5. **`src/components/SelectionActionHub.tsx` + `src/services/selectionActions.ts`** — 全局划词浮条、右键复用、内容分类与 Agent 请求构造（见 [Selection Actions]）。
   - 划词触发：`window.getSelection()` 取选区文本与矩形，且只接受同一个 `data-selection-surface` 内的选区。
   - 右键触发：只有右键位置与已有有效选区属于同一启用区域时，才接管原生菜单并显示同一浮条。
   - 动作标签随普通文本/公式/代码变化，动作协议保持统一。
   - 组件全局只挂载一次，各业务页面通过数据属性声明来源上下文。

**提示词与测试**

6. **`src/workflows/sceneGeneralPrompt.ts`** — 通用回合发言提示词常量。
   - `SCENE_GENERAL_TURN_PROMPT`：按 `behavior` 规范发言，允许富格式，要求引用标注 `[n]`。

7. **`scripts/check-scene-paradigm.ts`** — 范式、behavior 解析与 SceneSpec 兼容性自检。

8. **`scripts/check-scene-rendering.mjs`** — 纯函数自检（遵循 `check-memory-store.mjs` 范式）。
   - 断言 `resolveMessageShape` 各分支；含代码围栏时不被内部标记误判。
   - 断言 `parseCitationMarkers` 正确抽取 `[1]`、不误匹配 `[text](url)` 与 `[x]`。
   - 断言 `buildCitationsFromTrace` 对空 trace / 无 rag 段 / 有 rag 段的处理。

### 修改文件（10 个）

1. **`src/types/scene.ts`** — 见 [Types]（新增 `SceneBehaviorSpec` / `SceneOutputFormat` / `SceneMessageShape` / `SceneCitation`；`SceneSpec.behavior?`；`SceneMessage.citations?`；`SceneManifestEntry.architecture.behaviorKind?`）。

2. **`src/types.ts`** — `LlmWorkflowId` 追加 `'scene-general-turn'`（**仅一个**；生成侧复用 `scene-generate`）。

3. **`src/workflows/workflowRegistry.ts`** — 注册**一个新** workflow（`scene-general-turn`），复用 `SCENE_GENERAL_TURN_PROMPT`，置于 scene 系列之后。**`scene-generate` 保持不变**。

3a. **`src/workflows/scenePrompt.ts`** — **升级 `SCENE_GENERATE_PROMPT`**（就地重写）：删除"必须角色扮演"的隐含前提，新增"自行设计交互范式并写入 `behavior`"的要求，`role` 降为可选，新增 `outputFormats` 声明要求。**`SCENE_ADAPT_PROMPT`** 补一句"保留源场景的 `behavior` 四段结构"。**`SCENE_ROLE_REPLY_PROMPT` 不改动**（存量 S1 仍用它）。

3b. **`src/services/memory/memoryContextBuilder.ts`** — **新增 `'scene-general-turn'` 配方**（见 [Memory Recipe]）。**仅新增一项，既有配方全部不动**。

4. **`src/services/scene/sceneSkillStore.ts`** — 补 manifest 缺口：
   - `toManifestEntry()` 的 `architecture` 增加 `behaviorKind: spec.behavior?.kind`（缺省 undefined，S1 传统/S4 不受影响）。
   - `normalizeSceneSpec()` 确保 `behavior` 字段被保留（当前 `...s` 展开已覆盖，需在测试中确认）。

5. **`src/services/scene/sceneGenerator.ts`** — 生成侧扩展（**不新增分派分支**）：
   - 新增 `parseBehaviorSpec(raw)`：容错解析 `behavior`，非法返回 `undefined`（保证存量场景不受影响）。
   - `parseSceneSpec` 增加 `behavior: parseBehaviorSpec(parsed.behavior)` 字段。
   - `adaptScene` 把 `behavior` 一并交给 LLM 作为改编锚点（与 `compute` 同等待遇）。
   - `buildManifestPromptSection` 的清单行追加「交互形式：${behaviorKind}」。
   - `generateScene` **保持不变**（仍走 `scene-generate`）。

6. **`src/services/scene/sceneDirector.ts`** — 运行分派扩展：
   - `buildRoleSystemPrompt` 保持不动（传统路径）。
   - 新增 `buildGeneralTurnPrompt(spec, run, tokens)`：用 `behavior` 拼装通用发言指令 + 格式指令 + 引用标注指令 + **可用引用编号清单**（来自 RAG 前缀）。
   - 新增 `streamGeneralTurn(spec, run)`：以 `scene-general-turn` workflow 发起流式发言。
   - 复用 `buildChatHistory` / `renderSceneFacts` / `renderMetricStatus`。

7. **`src/components/scene/SceneChatView.tsx`** — 渲染与形态改造：
   - 用 `SceneMessageContent` 替换第 78 行的纯文本渲染。
   - 用 `resolveMessageShape` 决定消息渲染为 `.bubble` 还是 `.card`。
   - 通用范式下显示 `behavior.kind` 作为发言者名（替代 `spec.role.name`）。
   - 在助手消息上声明 `data-selection-surface="scene"` 与消息、场景来源信息，接入全局划词系统。
   - 挂载角标点击跳转回调（复用现有 `onSelectNoteByTitle` 思路，需新增 prop）。

8. **`src/components/SceneMode.tsx`** — 回合循环与引用数据改造：
   - 按 `resolveSceneParadigm` 分派 `streamRoleReply` 或 `streamGeneralTurn`。
   - **保存本轮 RAG trace**：`assembleMemoryContext` 的 `trace` 需从此处透传（见下「trace 获取路径」）。
   - 回合结束后把 `citations` 写入对应的 NPC 消息。

9. **`src/services/llmStreamService.ts`** — **透传 memory trace**（关键改造）：
   - 现状：`callLLMStream` 内部调用 `assembleMemoryContext` 后**丢弃了 trace**，只用了 `prefix`。
   - 改造：把 `trace` 通过回调或返回结构暴露给调用方（`SceneMode` 需要它来构建 citations）。
   - **保持向后兼容**：以新增可选回调参数实现，不改变既有返回类型（详见 [Citation System] 的「trace 获取路径」）。

10. **`src/components/scene/SceneBuilderPanel.tsx`** — 仅**描述文案**调整（「对话场景」描述改为"流式问答回合（对话/答题/引导等，由 AI 按你的需求设计）"）。**不新增类型选项**。

### 配置更新
- **`package.json`**：新增依赖 `remark-math`、`rehype-katex`（`katex` 与 `@types/katex` 已存在）；scripts 新增 `"check:scene": "node --experimental-strip-types scripts/check-scene-paradigm.mjs && node --experimental-strip-types scripts/check-scene-rendering.mjs"`。

### 删除/移动
- 无。

[Prompts]
本节给出提示词改造的设计要点（实施时按此撰写完整文本）。

### S1 提示词升级策略（生成侧：就地重写 `SCENE_GENERATE_PROMPT`）

**不新建生成提示词**，而是**就地升级** `SCENE_GENERATE_PROMPT`——因为"对话场景"本就等于"流式问答回合范式"，无需两套。

**与现版本的关键差异**：
- **删除**「必须是角色扮演」的隐含前提（原原则 2/3/6 的"说服/谈判/对方态度"措辞改为通用的"用户行动/交互张力/可感后果"）。
- **新增**：要求 LLM 先阅读理解用户的学习目的与补充条件，**自行设计交互范式**，并写入 `behavior` 字段。
- **范式示例引导**（仅作启发，不限定）：答题闯关、自适应练习、引导式教学、苏格拉底追问、辩论对抗、案例诊断、流程演练。
- `role` 字段改为**可选**（通用范式下可为空；`behaviorKind` 承担展示名职责）。为兼容解析，`role` 仍输出但可为最小占位。
- **输出格式声明**：要求 LLM 在 `behavior.outputFormats` 中声明本场景需要哪些富格式（如数学场景声明 `latex`，编程场景声明 `code`）。
- 保留：指标体系、完成条件、突发事件、`extras`、`injectProfile` 等骨架字段的规则（这些是范式无关的）。

**输出结构调整**：在现有 `SceneSpec` JSON 中插入 `"behavior": { "kind", "aiBehavior", "userAction", "evaluationRule", "progressionRule", "outputFormats" }`。

### `SCENE_GENERAL_TURN_PROMPT`（通用回合发言）

**与 `SCENE_ROLE_REPLY_PROMPT` 的关键差异**：
- **删除**"不跳戏/不讲解知识点/不评价用户/长度 2~5 句"等角色扮演专属约束。
- **改为**：按 `behavior.aiBehavior` 决定发言方式；按 `behavior.evaluationRule` 评价用户上一轮；按 `behavior.progressionRule` 推进。
- **新增富格式指令**：明确允许并鼓励使用 Markdown 表格、行内 `$...$`、块级 `$$...$$`、代码块、图片，但要求"只在确实提升表达力时使用"。
- **新增引用标注指令**（关键）：
  ```
  若你的发言参考了下方「参考资料」中的内容，请在对应句末标注来源编号，格式为 [1]、[2]。
  只标注真正参考的内容，不要为了标注而标注。
  若完全未参考资料，不要输出任何编号。
  ```
- 保留 `[结束:原因]` 标记约定（系统靠它判定终局）—— `sceneSignal.splitRoleReply` 无需改动。
- **注意**：`*动作*` 约定在通用范式下不再要求（保留解析兼容，但提示词不引导使用）。

### `sceneSkill` 取值约定（生成入口）

**不新增任何值**。`SceneSkillType` 保持 `'S0'`~`'S12'` 不变，S1 即对话场景（流式问答回合范式）。生成入口通过 `SceneInitialRequest.sceneSkill = 'S1'` 走既有路径，`behavior` 由 LLM 在生成时产出，**与 sceneSkill 无关**。

[Message Shapes]
本节定义 B 方案（混合形态）的判定与样式规范。

### 判定规则（纯函数）

```ts
export function resolveMessageShape(content: string): SceneMessageShape
```

**判定优先级**（命中任一即判为 `card`）：

| # | 条件 | 说明 |
|---|---|---|
| 1 | 含**代码围栏** ` ``` ` | 代码块需宽度与等宽字体 |
| 2 | 含**表格分隔行**（正则 `^\s*\|.*\|\s*$` 且下一行含 `---`） | 表格需横向空间 |
| 3 | 含**块级公式** `$$...$$` | 长公式易超宽 |
| 4 | 含**图片** `![...](...)` | 图片需宽度 |
| 5 | 段落数（空行分隔）`≥ 3` | 长内容分段更易读 |
| 6 | 字符数 `≥ 200` | 长文不适合塞进窄气泡 |

否则 → `bubble`。

### ⚠️ 实现要点：避免误判

**必须在判定前剥离代码围栏内容**，否则：
- 代码里的 `|` 会被误判为表格
- 代码里的 `$$` 会被误判为公式
- 代码里的 `#` 会被误判为标题

**做法**：先按 ` ``` ` 分割，只对**非代码段**做条件 2/3/4 的检测（条件 1 检测围栏本身）。此项必须有测试覆盖。

### 样式规范

| 形态 | 容器类 | 宽度 | 视觉 |
|---|---|---|---|
| `bubble` | `.scene-msg-bubble`（现有） | `max-width: 78%` | 保留现状 |
| `card` | `.scene-msg-card`（新增） | `width: 100%`（占满内容列） | 白底卡片、圆角、内边距略大于气泡 |

**`card` 的附加要求**：
- 发言者名（`behavior.kind` 或角色名）显示在卡片顶部
- 卡片内 Markdown 排版遵循 [Typography] 规范
- 卡片之间保持现有消息间距

**用户消息**：始终 `bubble`（不变）。

### 流式期间形态稳定性（重要）

流式过程中，内容从短变长，**形态可能在某一刻从 bubble 跳到 card**——这会造成视觉跳动。

**处理策略**：
- **一旦判定为 `card`，本轮流式期间不再回退**（形态单调提升）。
- 用 `useState` 记录"本轮已升级为 card"标记，流式结束后重置。
- 若流式开始时就是 card（如直接以 ` ``` ` 开头），则始终 card。

[Citation System]
本节定义 RAG 引用角标的完整链路。

### 角标样式：**上标数字**（已确认）

| 样式 | 多来源区分 | 学术惯例 | 实现难度 |
|---|---|---|---|
| **上标数字** `[1]` ⭐ 采用 | ✅ | ✅ | 中 |
| 圆点图标 `●` | ❌ | ❌ | 低 |

**采用理由**：RAG 一次返回 top-3 来源，必须能区分"这句话出自哪份资料"；且 `react-markdown` 的自定义 `components` 本就需编写（表格/代码已计划），加 `sup` 成本很低。

### 角标渲染规范

```css
.scene-cite {
  font-size: 0.7em;
  vertical-align: super;
  line-height: 0;          /* 关键：防止上标撑高行距 */
  margin-left: 1px;
  padding: 0 3px;
  border-radius: 4px;
  background: rgba(59,130,246,.12);
  color: #2563eb;
  cursor: pointer;
}
.scene-cite:hover { background: rgba(59,130,246,.22); }
```

**渲染方式**：在 `SceneMessageContent` 的 Markdown 渲染后，对文本节点做二次处理，把 `[n]` 替换为 `<sup class="scene-cite">` 组件。实现要点：
- **不处理代码块/行内代码内的 `[n]`**（否则代码示例会被污染）
- **不处理 Markdown 链接** `[text](url)`
- 用自定义 `components.text` 或预分割文本节点实现

### 悬停与点击

| 交互 | 行为 |
|---|---|
| 悬停 | 浮出**来源片段卡**：标题 + 摘要 + 相关度百分比 |
| 点击 | 跳转到对应笔记（复用 `handleSelectNoteByTitle` 或按 `noteId` 打开） |

### 兜底策略（关键）

LLM 可能不标注或漏标。因此：
1. **优先**：解析正文中的 `[n]`，渲染为角标。
2. **兜底**：若正文无任何 `[n]` **但**本轮确有 RAG 来源，则在**消息末尾**追加一组来源角标（`[1][2]`）。
3. **无来源**：若本轮无 RAG 命中，不显示任何角标。

### trace 获取路径（需改造 `llmStreamService`）

**问题**：`assembleMemoryContext` 返回 `{ prefix, trace }`，但 `callLLMStream` 目前**只用 prefix，丢弃 trace**。`SceneMode` 拿不到来源数据。

**改造方案**（保持向后兼容）：

```ts
// llmStreamService.ts — 新增可选参数
export async function callLLMStream(
  request: LlmCallRequest,
  options?: {
    /** 记忆装配完成后的回调，包含 trace 与结构化笔记来源 */
    onMemoryAssembled?: (memory: MemoryContextAssembly) => void;
  },
): Promise<ReadableStream<StreamChunk>>
```

现有 `memory.trace` 只含 sourceIds，无法提供标题、摘要和相关度。应先让装配结果暴露结构化 RAG provenance，再通过可选回调同时返回 trace 与来源条目；不能只凭 trace 构造完整 `SceneCitation`。

**向后兼容**：`options` 为可选；所有现有调用方（`SceneMode` 的 `streamRoleReply`、`ReviewChat` 等）不传即可，行为不变。

**`sceneDirector.streamGeneralTurn` 改造**：接收 `onCitations` 回调并透传给 `callLLMStream`。

**`SceneMode` 改造**：调用 `streamGeneralTurn` 时传入回调，把 `trace` 转成 `SceneCitation[]` 暂存；回合结束后写入该条 NPC 消息的 `citations` 字段。

### 资料的引用（可选扩展）

本计划 P0 只做**笔记引用**（`noteId`）。资料文档引用（`documentRagClient`）需额外接入，列为**可选**——若 `trace` 中只含笔记来源则跳过。

[Selection Actions]
本节定义划词浮条与右键菜单（替代按钮栏）。

### 触发方式（两种，共用同一浮条组件）

| 触发 | 实现 | 说明 |
|---|---|---|
| **划词** | `mouseup` 后读 `window.getSelection()`，取选中文本 + `getRangeAt(0).getBoundingClientRect()` | 主交互 |
| **右键** | 消息容器 `onContextMenu`，`preventDefault` 后浮出同一浮条 | 复用项目已有 `ContextMenu` 范式 |

**共同要求**：
- 浮条定位在选区**上方**（`top = rect.top - toolbarHeight - 8`），超出视口则翻到下方
- 点击浮条外部 / `Escape` / 滚动 → 关闭
- **不遮挡**选中文字

### 动作随内容类型变化（"智能化"核心）

```ts
export function resolveSelectionActions(text: string): SelectionAction[]
```

| 选中内容类型 | 判定 | 给出的动作 |
|---|---|---|
| **数学公式** | 含 `$`/`^`/`\frac`/`\sum`/`∫` 等 | 解释公式 · 给个例题 · 继续推导 · 知识点草案 |
| **代码** | 含代码关键字、`{}`/`;`/`=>`，或多行缩进 | 解释代码 · 举个示例 · 逐步追问 · 知识点草案 |
| **普通文本** | 默认 | 解释这段 · 举个例子 · 继续追问 · 知识点草案 |

**动作执行落点**：统一进入全局 Agent 侧栏。`App` 把选中文字、页面类型、来源标题与动作意图组装为一次外部请求；`AgentPanel` 打开后自动发送，忙碌时先保留到输入区并等待当前请求结束。

**安全与数据边界**：选中文字放入 `<selection>` 边界并明确视为不可信引用，不执行其中的指令；显式 `[selection_action:*]` 标记在读取选区前完成 Skill 路由，选区里的“调整计划/开始复习”等文字不能改变权限；苏格拉底复习来源要求只给提示、反问或类比。“知识点草案”仅在审批卡确认后创建新知识点笔记，取消不写入，也不作为画像或掌握度证据。

### 浮条 UI 规范

- 横向一排胶囊按钮，深色半透明背景 + 白字
- 高度约 32px，圆角 8px
- 最大 4 个动作（避免过宽）
- 与项目现有视觉风格一致（参考 `ContextMenu` 样式）

### 实现要点

1. **选区文本清洗**：去除首尾空白、统一换行；限制最大长度为 800 字防止超长输入。
2. **代码块内选中的处理**：允许选择（用户可能想解释某行代码），但动作清单偏向"解释代码"。
3. **公式选中**：KaTeX 渲染后的公式是 DOM 节点，划选可能选到渲染后的符号而非 LaTeX 源码——**P0 接受此限制**（选中渲染文本，动作仍可解释）；精确取 LaTeX 源码列为可选增强。
4. **事件清理**：`selectionchange` / `mouseup` / `keydown` 监听必须在组件卸载时移除。

[Rich Rendering]
本节定义富文本渲染的依赖、格式矩阵与健壮性要求。

### 依赖与插件

```ts
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';      // 表格/任务列表/删除线（项目已在用）
import remarkMath from 'remark-math';    // 行内 $...$ 与块级 $$...$$
import rehypeKatex from 'rehype-katex';  // 公式渲染
import 'katex/dist/katex.min.css';       // 样式（katex 已安装）
```

**新增依赖**：`remark-math`、`rehype-katex`（均为纯 JS，无原生依赖，体积小）。
**已有依赖**：`react-markdown`、`remark-gfm`、`katex`、`@types/katex`、`mathlive`（编辑器，本计划不涉及）。

### 支持的格式矩阵

| 格式 | 语法 | 实现 |
|---|---|---|
| 基础 Markdown | `#`/`-`/`**`/`>` | `react-markdown` |
| 表格 | `\| a \| b \|` | `remark-gfm` + 自定义 `table` 组件（滚动容器） |
| 代码块 | ` ```lang ` | 自定义 `code` 组件（等宽 + 语言标签 + 复制） |
| 行内公式 | `$E=mc^2$` | `remark-math` + `rehype-katex` |
| 块级公式 | `$$\int_0^1 x dx$$` | 同上 |
| 图片 | `![alt](url)` | `react-markdown`（URL 型） |
| 任务列表 | `- [x]` | `remark-gfm` |
| 引用角标 | `[1]` | 自定义处理（见 [Citation System]） |

**图片支持范围**：本计划仅支持 **URL 型图片**（网络或已有本地路径）。**不做**图片上传/生成——那属于 Agent 工具能力。

### 自定义组件清单

| 组件 | 作用 |
|---|---|
| `table` | 包 `overflow-x: auto` 容器，防窄屏挤压 |
| `code` | 代码块：等宽字体、底色、语言标签、复制按钮（行内 code 与块级 code 需区分） |
| `sup` | 角标样式类 |
| `img` | 限制最大宽度 `max-width: 100%`，加载失败降级为链接 |

### 渲染组件的健壮性要求

1. **流式安全**：Markdown 可能处于"半截"状态（如 `$$` 未闭合）。`react-markdown` 对未闭合语法本身容错（`**x` 保持纯文本）；`rehype-katex` 对未闭合公式降级为纯文本，不抛错。**需测试验证**。
2. **代码围栏未闭合**：流式时 ` ``` ` 可能只有开头，此时内容会被当作代码块渲染——可接受（流式结束后正常）。
3. **样式隔离**：使用 `.scene-msg-text` 作用域，避免污染既有 UI。
4. **性能**：消息列表可能较长；对已渲染完成的历史消息做 `React.memo`，只让流式中的最后一条重渲染。

[Typography]
本节定义排版尺度（对齐 NotebookLM 的可读性标准）。

### 尺度规范

| 元素 | 规范 |
|---|---|
| 正文行高 | `1.7` |
| 段落间距 | `margin: 0.6em 0`（首尾去除） |
| 标题 `h1`~`h3` | 字号收敛（不超过正文 1.4 倍），上下间距 `0.8em 0 0.4em` |
| 列表 | 缩进 `1.2em`，项间距 `0.25em` |
| 代码块 | 字号 `0.85em`，行高 `1.5`，内边距 `0.75em` |
| 表格 | 字号 `0.9em`，单元格内边距 `0.5em 0.75em` |
| 行内公式 | `font-size: 1em`（与正文一致，避免行距跳动） |
| 块级公式 | 上下 `margin: 0.8em 0`，超宽时允许横向滚动 |
| 引用块 | 左侧 `3px` 竖线 + 淡背景 |

### 必须处理的细节

1. **首尾间距清零**：`.scene-msg-text > :first-child { margin-top: 0 }`、`:last-child { margin-bottom: 0 }`，防止气泡/卡片内出现多余空白。
2. **公式行高防跳**：`.katex { line-height: 1.2 }`，且父容器 `line-height: 1.7` 保持正文节奏。
3. **表格/代码块不撑破容器**：外层滚动容器 `max-width: 100%; overflow-x: auto`。

[Isolation & Compatibility]
本节明确零影响保证与验证方式。

### 三路径隔离矩阵

| 路径 | 判定条件 | 受影响范围 | 保证 |
|---|---|---|---|
| S4 数理画布 | `spec.compute` 存在 | 无 | 判定优先级最高，未被改动 |
| S1 传统（存量） | `behavior` 与 `compute` 都不存在 | **渲染**升级为 Markdown + 形态判定；**发言/RAG 不变** | ⚠️ 见下 |
| S1 通用（新生成） | `spec.behavior` 存在 | 新发言路径 + 新配方（RAG）+ 新渲染 | 新场景无存量 |

### 唯一的兼容性风险：S1 传统场景的渲染升级

`SceneChatView` 从纯文本改为 Markdown 渲染，**存量 S1 场景也会走新渲染器**。

**重新核实**：`.scene-msg-text` 本身只有 `margin: 0`，但父级 `.scene-msg-bubble` 已设置 `white-space: pre-wrap`，因此当前纯文本消息会保留换行。切换 Markdown 后必须用真实视觉样例验证单换行、双换行、列表与星号文本的差异，不能假设现有换行全部被折叠。

**改版后会出现三类具体变化**：

| 输入 | 现在 | 改版后 |
|---|---|---|
| 单个换行 | 折叠为空格 | 折叠为空格（**一致**） |
| 两个换行 | 折叠为空格 | **真实分段**（变为两段） |
| `*文字*` | 原样显示星号 | **渲染为斜体** |
| 行首 `- 项` / `1. 项` | 原样显示 | **渲染为列表** |

**风险等级**：

| 项 | 评估 |
|---|---|
| 崩溃 | ❌ 不会（解析失败降级纯文本） |
| 内容丢失 | ❌ 不会（文字完整，仅排版变化） |
| 影响玩法/判定 | ❌ 不会（纯显示层） |
| 视觉变化 | ✅ 会（但方向多为"更规整"） |

**缓解措施**：
1. 在真实样例确认 Markdown 默认单换行与现有 `pre-wrap` 表现不一致后，再决定是否给传统 S1 加 `remark-breaks`。
2. 若不希望任何变化：仅为传统路径保留纯文本渲染分支（**不推荐**，会失去富文本能力）。

**决策**：统一走 Markdown；`remark-breaks` 是否启用由存量 S1 视觉回归结果决定。

### 其他隔离要点

| 项 | 保证 |
|---|---|
| 传统角色扮演的发言与 RAG | **完全不变**（`scene-role-reply` 配方未改） |
| 通用范式不注入历史事件 | `episodeChars: 0` |
| 划词浮条不干扰输入框 | 浮条仅挂载在消息列表容器内；输入区划选不触发 |
| 事件监听泄漏 | 卸载时清理 `selectionchange` / `mouseup` / `keydown` |
| `llmStreamService` 改造 | 新增参数可选，既有调用方零影响 |

### 验证清单

| 验证项 | 方法 |
|---|---|
| S1 传统场景运行无回归 | 用存量 S1 场景跑完整对话，比对渲染视觉与结束判定 |
| S4 场景运行无回归 | 用存量 S4 场景跑完整推导 |
| S1 传统换行视觉 | 构造含单/双换行的角色发言，确认 `remark-breaks` 生效 |
| 通用场景可运行 | 生成答题场景，完成"出题→答题→判分→再出题→结束" |
| 富格式渲染 | 构造含表格/公式/代码/图片的消息，确认全部正确渲染 |
| 形态判定 | 短对白→气泡；长内容/含表格→卡片；流式期间不抖动 |
| 角标渲染 | 含 `[1]` 的消息正确渲染上标；点击可跳转笔记 |
| 角标兜底 | LLM 未标注但有 RAG 来源时，消息末尾显示来源 |
| 划词浮条 | 划选文字弹出浮条且不遮挡；动作随内容类型变化 |
| 右键菜单 | 右键消息弹出同一浮条 |
| 浮条关闭 | 点击外部/Escape/滚动均关闭；无监听泄漏 |
| 流式未闭合公式 | 观察 `$$` 半截状态不崩溃 |
| 现有 AI 功能无回归 | 心流分析、复习、计划生成各跑一次 |

[Agent Integration Point]
本节记录场景能力与 Agent 架构的共享契约；富内容、引用与全局划词请求桥接已经可供 Agent 复用，生成图片等专用工具仍不在本计划内。

### 交接契约

| 通道 | 本计划交付 | Agent 计划可复用方式 |
|---|---|---|
| **富内容渲染** | `SceneMessageContent`（Markdown/公式/表格/代码/图片） | Agent 消息直接复用同一组件渲染 |
| **引用角标** | `SceneCitation` 类型 + 角标渲染 + 来源卡 | Agent 的 RAG 工具返回结果可转为 `SceneCitation[]` |
| **划词交互** | `SelectionActionHub` + `resolveSelectionActions` + 来源数据属性 | 已通过 `externalRequest` 接入 Agent 面板；其他页面只需声明选区来源即可复用 |
| **消息形态判定** | `resolveMessageShape` | Agent 消息同样适用（长答走卡片） |

### 与 Agent 计划的对齐点

1. **输出格式契约**：Agent 工具应产出**标准 Markdown**（含 `$...$` / `$$...$$` / `![]()`），而非自定义结构。本计划的渲染器即按此约定实现。
2. **图片落地**：若 Agent 生成图片，需先把图片写入 `<dataRoot>/` 下的可访问路径，再以相对/`file://` URL 嵌入。本计划只渲染 URL，**不负责图片存储**。
3. **格式声明的复用**：`SceneBehaviorSpec.outputFormats` 可作为 Agent 选择工具的提示（如声明 `latex` 则倾向公式工具）。
4. **划词动作落点**：当前统一进入 Agent，避免每个业务页面重复实现对话路由；若未来需要“继续剧情”，再增加显式的场景内动作，不依赖隐式意图猜测。
5. **引用数据来源的统一**：Agent 的检索工具应返回与本计划 `SceneCitation` 同构的数据，便于共用角标组件。

[Testing]
采用项目现有 `check-*.mjs` 纯函数自检范式 + `npm run lint` 类型校验 + Electron 手动验证。

### 新增测试 1：`scripts/check-scene-paradigm.mjs`
- **`resolveSceneParadigm`**：三种 spec（含 `compute` / 含 `behavior` / 都不含）分别返回 `'compute'` / `'general'` / `'dialogue'`；`compute` 优先于 `behavior`。
- **`buildBehaviorPromptSection`**：输出含 `behavior` 五段文本；`outputFormats` 缺省时不含格式指令，含 `latex` 时含公式指令。
- **`buildOutputFormatHint`**：各格式枚举映射正确；空数组/undefined 返回空串。
- **`parseBehaviorSpec`**：合法输入正确解析；缺 `kind` 等必填字段返回 `undefined`；非对象输入返回 `undefined`。
- **`parseSceneSpec` 兼容性**：不含 `behavior` → `undefined`；含 `behavior` → 正确解析；其他字段行为不变。

### 新增测试 2：`scripts/check-scene-rendering.mjs`
- **`resolveMessageShape`**：
  - 短句 → `'bubble'`
  - 含 ` ``` ` → `'card'`
  - 含表格分隔行 → `'card'`
  - 含 `$$` → `'card'`
  - 含 `![` → `'card'`
  - 3 段以上 → `'card'`
  - 200 字以上 → `'card'`
  - **代码围栏内的 `|` / `$$` 不误判**（关键用例）
- **`parseCitationMarkers`**：
  - `"这是结论[1]。"` → `[1]`
  - `"[1][2] 都引用了"` → `[1,2]`
  - `"[链接](url)"` → `[]`（不误匹配）
  - `"- [x] 完成"` → `[]`（不误匹配任务列表）
  - `"```\n[1]\n```"` → `[]`（不处理代码内）
- **`stripCitationMarkers`**：剥离后不残留多余空格/标点。
- **`buildCitationsFromTrace`**：空 trace → `[]`；无 rag 段 → `[]`；有 rag 段 → 编号从 1 起、`noteId` 与 `sourceIds` 顺序一致。
- **`resolveSelectionActions`**：
  - 普通文本 → 含"解释/存笔记/搜笔记"
  - 含 `$`/`\frac` → 含"解释公式"类动作
  - 含 `A.`/`选` → 含"作答"类动作
  - 空字符串 → 返回空数组

### 现有测试必须保持通过
- `npm run check:memory`（本计划仅向 RECIPES **新增**一项）
- `npm run check:profile`
- `npm run lint`（重点：`LlmWorkflowId` 追加 `'scene-general-turn'` 后所有 switch 无遗漏）

### 手动验证（Electron）
1. **存量 S1 场景**：进入已保存的对话场景，跑 3~4 轮，确认渲染（重点看换行与列表）与结束判定无回归。
2. **存量 S4 场景**：进入数理场景，确认画布流程无回归。
3. **新建对话场景（答题形态）**：搭建面板选「对话场景」+「搭建新场景」，补充条件写"我想做一套自适应练习题，先出 1 题，我答完再根据对错出下一题"。确认：
   - 生成的 `behavior.kind` 体现答题形态
   - 第一轮 AI 出题（而非寒暄）
   - 用户答题后 AI 判分并出下一题
   - 到达题量上限后正常结束
4. **富格式渲染**：诱导 AI 输出表格/公式/代码，确认全部正确渲染且形态为卡片。
5. **引用角标**：构造一个场景，让 AI 引用用户笔记（如"根据你笔记里的定义…"），确认：
   - 角标以上标数字显示
   - 悬停出源片段卡
   - 点击跳转到对应笔记
   - 若 AI 未标注，末尾有兜底角标
6. **划词浮条**：在场景、心流解答、复习导师消息或笔记中划选普通文本 → 浮条出现且不遮挡；划选公式/代码 → 标签随类型变化；点击动作 → Agent 打开并收到带来源的引用请求。
7. **右键菜单**：在有效选区内右键 → 同一浮条出现；无选区、跨区域选区或未启用页面保留原生菜单。
8. **浮条关闭与清理**：点击外部、按 Esc、滚动，均正确关闭；反复开关无监听泄漏（DevTools 检查）。
9. **流式健壮性**：观察流式过程中公式半截状态不崩溃、形态不抖动。

[Implementation Order]
按依赖关系自底向上，每步可独立编译通过。

1. **依赖与类型**：安装 `remark-math` / `rehype-katex`；修改 `src/types/scene.ts`（新增 `SceneOutputFormat` / `SceneBehaviorSpec` / `SceneMessageShape` / `SceneCitation`；`SceneSpec.behavior?`；`SceneMessage.citations?`；`SceneManifestEntry.architecture.behaviorKind?`）；修改 `src/types.ts`（追加 `'scene-general-turn'` **一个** workflow id）。运行 `npm run lint`。
2. **范式与形态纯函数**：新建 `src/services/scene/sceneParadigm.ts` + `sceneMessageShape.ts` + `sceneCitation.ts`。运行 `npm run lint`。
3. **记忆配方**：向 `memoryContextBuilder.ts` 的 RECIPES 新增 `'scene-general-turn'`（含 RAG）。运行 `npm run check:memory` 确认无回归。
4. **富文本渲染组件**：新建 `src/components/scene/SceneMessageContent.tsx`（含 KaTeX 样式、自定义 `table`/`code`/`img`/角标处理、`React.memo`）；在 `index.css` 补充 `.scene-msg-card` / `.scene-cite` / 排版尺度样式。运行 `npm run build` 确认打包与样式无冲突。
5. **提示词改造**：**就地升级** `scenePrompt.ts` 的 `SCENE_GENERATE_PROMPT`（要求产出 `behavior`）+ `SCENE_ADAPT_PROMPT`（保留 behavior）；新建 `src/workflows/sceneGeneralPrompt.ts`（`SCENE_GENERAL_TURN_PROMPT`，含引用标注指令）；在 `workflowRegistry.ts` 注册 `scene-general-turn`。运行 `npm run lint`。
6. **生成侧扩展**：修改 `sceneGenerator.ts`（`parseBehaviorSpec`；`parseSceneSpec` 增加 `behavior`；`adaptScene` 传递 `behavior`；`buildManifestPromptSection` 追加交互形式）；修改 `sceneSkillStore.ts`（`toManifestEntry` 补 `behaviorKind`）。运行 `npm run build:electron`。
7. **trace 透传**：修改 `src/services/llmStreamService.ts`（新增可选 `onMemoryAssembled` 回调，保持既有调用方零影响）。运行 `npm run lint`。
8. **运行侧扩展**：修改 `sceneDirector.ts`（新增 `buildGeneralTurnPrompt` / `streamGeneralTurn`，透传 citations 回调）。运行 `npm run lint`。
9. **全局划词系统**：新建 `src/components/SelectionActionHub.tsx` 与 `src/services/selectionActions.ts`（划词 + 右键 + 内容分类 + 安全请求构造 + 事件清理），在 `App` 接入 `AgentPanel.externalRequest`。运行 `npm run lint` 与 Agent 专项回归。
10. **视图与回合改造**：修改 `SceneChatView.tsx`（渲染器替换、形态分派、声明选区来源、角标跳转回调）；修改 `SceneMode.tsx`（按范式分派发言人、保存 trace、写入 `citations`）；并为心流、复习和笔记视图声明选区来源。运行 `npm run lint`。
11. **搭建入口文案**：修改 `SceneBuilderPanel.tsx` 的「对话场景」描述文案。**不新增类型选项。**
12. **测试**：新建 `scripts/check-scene-paradigm.mjs` + `scripts/check-scene-rendering.mjs`；`package.json` 加 `check:scene`；运行至通过。
13. **端到端手测**：按 [Testing] 手动验证清单（重点：第 1/2 项存量回归、第 3 项答题全流程、第 5 项引用角标、第 6/7 项划词与右键、第 8 项事件清理）。

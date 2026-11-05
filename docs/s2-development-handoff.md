# S2 开发交接说明

更新日期：2026-10-26；初版交接快照为2026-10-25。

本资料面向“插件化计划制定”对话，将现有 S2 实验画布的代码、运行边界和验收证据交给交互包改造。目标是把整套提示词实验模式封装成可分发的交互包，不是重建画布、重新实现调度器，或允许不同范式的节点任意混用。

本文保留初版交接与真实验收记录，后续已完成包目录加载、实现解耦、统一契约、物料和渐进式搭建说明读取。当前开发接口见 [S2 交互包开发指南](scene-s2-plugin-developer-guide.md)，分阶段证据见 [实施说明](scene-interaction-pack-v0.1.md)。旧兼容导出已移除，不能继续按初版路径导入；具体文件以重新生成的清单为准，清单中的历史分类名不代表功能仍在等待实现。

当前提示词包声明内容块双击编辑、不自动打开设置区、隐藏重复内容属性区；组装及模型参数在节点内折叠。引用内容块的模板只导航原块编辑，字面量模板仍在本节点编辑。普通字段修改仅更新本地文档、撤销与控件事件，不合成用户聊天消息；结构化字段校验、人工等待和真实聊天保持各自流程。这些界面选择由包声明，不取消其他包可使用的通用设置区。

## 资料入口

- `docs/s2-development-handoff.md`：产品定位、运行链路、迁移边界、验收范围和交接注意事项。
- `docs/s2-code-index.md`：按职责列出全部匹配文件和主要公开符号。
- `docs/s2-code-inventory.json`：逐文件路径、分类、行数、SHA256、公开符号及其行号、静态和字面量动态导入依赖、相关 package 命令、未纳入命令的检查。
- `scripts/inventory-scene-s2.ts`：只解析源码的清单生成器，不导入应用模块、不读取模型设置、不运行测试或模型。
- `docs/s2-plugin-workbench-plan.md`：既有计划和历史验收。优先读顶部当前补充，再读第71批定位、真实画布追加与未完成项；旧批次不是当前指令。

重新生成清单：

```powershell
node scripts/run-tsx-safe.cjs scripts/inventory-scene-s2.ts --write
```

不加 `--write` 仅输出盘点摘要。清单覆盖 S2 自有文件、测试、夹具、历史证据图片、正式接入及直接共享依赖，不等于整个应用的依赖闭包，也不是可执行插件安装包。并行改造后应重新生成，不将旧行号当作永久定位。

## 目标对话的实施目标

已查阅“插件化计划制定”的当前计划、最近开始实施的回合，以及更早关于整体交互包、范式兼容和两种搭建方式的讨论。当前边界是：

1. S1、S2、S4 作为终端内置范式保留。S2 负责通用画布，S4 仍有自己的数理验证和推演规则。
2. 可分发单位是一整套交互模式包。提示词实验包包含专用组件和样式、本地组装规则、实验操作、搭建及互动 Agent 接口说明、合法组合规则和示例。
3. 终端掌管模型连接和凭据、资源选择和授权、预算、实际发送确认、取消、过期结果隔离、通用调度与保存。
4. 手动搭建和搭建 Agent 使用同一份配置、同一个包校验入口和运行机制，不形成两套产品流程。
5. 包声明范式、宿主接口版本、精确依赖和所需服务。都属于 S2 不代表两个包可以任意组合；跨包组合需要明确的适配关系。
6. 首版目标是放入指定目录、重启加载，移除目录、重启停用。缺包时保留场景原配置并明确报依赖缺失，装回兼容版本后可重新打开。热插拔、在线市场和自动升级不是首期前提。

初版计划采用六阶段：固定旧场景基线并建立包协议；迁移组装规则和专用 UI；接入包运行器与宿主服务；接通搭建 Agent 并覆盖文本、图片和资料实验；实现目录分发、加载和移除；全部兼容回归通过后切换默认路径。以下初版边界不代替后续各轮的实施状态；前三阶段当时只验证架构边界，并不单独证明跨终端分发。

## 当前产品定位与必须保持的体验

S2 是用户主导的实验画布。用户填写、连线、运行、观察和调整；关闭交互助手仍能完整开展实验。搭建 Agent 理解目标并设计画布、材料、合法组件范围、必要说明和可选预期，交互 Agent 按用户表达提供解释、提示、分析或待确认的协作方案。

提示词实验当前基线：

- 所有普通文字共用内容块，角色、任务、输出格式、材料不是不同的块类型。
- 组装节点决定每段用途、顺序、前缀和分隔符。一个实际 `compose` 节点原样组合，不补写、纠正或优化用户内容，不用多层隐藏 `bind/render` 冒充一步。
- 提示词和待处理材料分路：完整提示词进入 `prompt`，原始文本或资料进入 `input`，图片使用单独的原图句柄。
- 模型参数在模型节点内按需编辑。普通输入、纯本地处理不需要 Agent 审批；模型预算与每次真实发送分别确认。
- 原始返回直接显示，分析是否成功不影响结果保留。截断、取消、失败和不确定结束不能伪装成完整成功产物。
- 右侧只保留普通 Agent 聊天，不要求先选解释、提示或分析模式。聊天先理解需求，再按语义读取相关组件和实验记录。
- 预期和评价标准独立保存，不默认注入被测请求。没有明确标准只给建议，不宣判知识已经掌握。
- 普通节点不常驻内部 ID、key/value、用途长文或连线教程；输入控件仍有无障碍名称，必要错误、授权和发送核对不能隐藏。

提示词实验只是首个样例，不能将它的三段内容、固定拓扑或固定对话轮数写死为所有 S2 场景的工作流。

## 四种不同层级的对象

不要把下列对象混为一个“插件”：

- `S2CanvasDefinition`、`canvasWorkspace`：一个场景的设计配置，含目标、策略、块类型、初图、能力选择和可选指标。
- `S2PluginManifest`、`S2PluginPackage`：现有低层能力声明和受审查的本地代码绑定。`S2PluginInstallation` 校验清单和实现，不是外部目录加载器、安全沙箱或用户运行授权。
- workspace、subgraph、composite、blueprint：可保存和复用的设计数据；组合节点展开为真实节点，不携带独立代码或运行授权。
- `SceneInteractionPack`：完整交互模式包，连接 UI、专用规则、Agent 说明、配置校验和宿主服务；已按公共协议从安装目录加载。

画布版本、低层插件协议版本、新交互包协议版本是独立版本轴。现有严格字段解析不允许靠往 `canvasWorkspace` 静默塞未知字段来获得包身份或权限。

## 正式入口和完整运行链

正式产品由 `src/App.tsx` 根据 `sceneSkill === 'S2'` 独立挂载 `SceneS2CanvasTrial`。`SceneMode.tsx` 是 S1/S4 的入口，并明确拒绝把 S2 按其协议打开；部分旧文件头注释已落后于真实分流，不应据此迁移。

主要共享接入文件：

- `src/components/scene/SceneBuilderPanel.tsx`：选范式、已有场景、材料与用户要求；收集请求，不替用户授予运行权限。
- `src/App.tsx`：正式挂载、草稿、退出状态和 S2 项目笔记范围。
- `src/types/scene.ts`：`SceneSpec.canvasWorkspace` 与范式入口类型。
- `src/services/scene/sceneSkillStore.ts`：场景清单、读取与保存。
- `src/services/scene/sceneProjectNoteAccess.ts`：将 App 的项目笔记状态绑定为有限只读来源。
- `src/services/scene/sceneGenerator.ts`：拒绝 S2 走 S1/S4 生成和改编协议。

设计与交互路径分别为：

```text
用户目标 → designS2Canvas → 理解 → 用途索引 → 选择读取 → 装配 → 本地完整校验 → 预览
用户操作 → 文档与绑定校验 → Host按真实依赖执行 → 当前完整产物 → 展示
普通聊天 → turn-understand → 按语义读取有权材料 → turn-act → 回复或待确认方案
```

手动运行没有在节点间插入 Agent 规划。Agent 返回的 `commands`、`pluginRequests` 或 `executionRequest` 是申请，不是实际调用或权限。

## 生产代码导航

### 类型和低层插件内核

类型集中在 `src/types/sceneS2.ts`、`sceneS2Plugin.ts`、`sceneS2Business.ts`、`sceneS2Composite.ts`。

`src/services/scene/` 中：

- `sceneS2PluginProtocol.ts`：有界类型、清单、图、调用、产物、回执和发布上下文校验。
- `sceneS2PluginInstallation.ts`：受信代码绑定与声明一致性，原子注册，固定控件和受控桥的兼容校验。
- `sceneS2PluginRegistry.ts`：当前内建目录、处理器绑定、搭建目录、运行目录和纯讨论目录。
- `sceneS2PluginHost.ts`：本局授权、资源、产物、工作流队列、人工和模型等待、幂等、缓存、取消、修订失效及结果发布。
- `sceneS2Workflow.ts`：执行图解析、条件依赖、DAG 预检、目标及其上游选择、执行语义身份。
- `sceneS2Canvas.ts`：定义与文档解析、保存和导入导出、批量命令校验、搭建和互动入口。

普通 `edges` 是内容语义关系；`execution.links` 才是类型化数据依赖。不能将 S4 证明关系、S1 回合或单选题推进规则混进 S2 执行图。

### 初版能力目录与当前归属

初版完整实验统计为11个插件、26项能力，其中 core 的2项为字段编辑器，24项可组合为执行或展示节点。后续已将 `text-template` 与 `model-test` 移入提示词包，不再作为底座静态业务实现；当前实际目录按所选包及共享能力生成。以下记录版本均为 `1.0.0`；单场景当前最多选择16项能力。

- `core`：`text`、`multiline`。
- `json-check`：`validate`，只检查 JSON 语法，不判业务正确。
- `structured-data`：`parse-json`、`select`、`stringify`、`to-table`、`table-to-json`。
- `structured-view`：`text`、`json-tree`、`table`。
- `workflow-simulation`：`step`、`inspect`，预设示例轨迹，不是执行真实业务。
- `workflow-merge`：`merge-json`、`merge-assessment`、`merge-simulation`，显式互斥合流。
- `human-input`：`text`、`json`、`confirm`，由用户真实提交。
- `text-template`：`compose`、旧 `bind`、旧 `render`。
- `model-test`：`generate`，固定模型会话和逐次发送确认。
- `local-material`：`read-text`、`read-image`。
- `project-notes`：`read-text`，用户批准的具体项目笔记，不是 RAG 或全库搜索。

提示词组装实现位于 `src/interaction-packs/prompt-lab/textTemplate.ts`，其模型能力声明位于包内 `modelCapability.ts`；宿主侧 `sceneS2ModelTest`、`ModelTransport` 继续负责受控模型会话。共享的 `sceneS2Structured`、`JsonCheck`、`Simulation`、`Merge`、`Human`、`TextResource`、`ImageResource`、`ProjectNotes` 等仍在底座。这些低层插件不等于11个可独立装卸的交互包。

### UI 与本地表单

`src/components/scene/SceneS2CanvasTrial.tsx` 仍是大宿主，含预览、开始、结束、画布、编辑历史、执行、资源、模型确认和可选助手。拆包应按职责抽离，不能整份搬走。

- `S2WorkflowNodeView`：节点卡、真实端口、状态、原文和专用控件槽。
- `S2FieldEditor`、`S2JsonParameter`、`S2SimpleValueInput`：声明式字段、草稿及低门槛原生数据编辑。
- `S2ConditionEditor`、`S2HumanInput`：条件配置与运行中人工等待。
- `S2ImageMaterials`：节点原位选图、预览和撤回；底层授权归宿主。
- `S2ArtifactView`、`S2FieldPreview`、`S2ArtifactChart`、`S2ChartPreview`：只读原文、结构、表格与图表。
- `S2RunSummary`：实际目标、上游、等待和外部调用范围说明，不执行。
- `src/interaction-packs/prompt-lab/ComposeEditor.tsx`、`ModelParameters.tsx`、`TemplateControls.tsx`：包内组装、模型参数与旧用途/模板控件，通过通用槽位显示。旧底座组件路径不再提供兼容导出；引用内容块的模板正文只在原块编辑。
- `sceneS2Canvas.css`：项目主题、画布、浮层、聊天和原文显示；仅专用样式适合随包迁移。

配套服务按职责为：`Controls`、`ControlDrafts`、`ControlIssue`、`ControlHints`、`SimpleValueForm`、`ParameterForm`、`DataViews`；以及 `Materials`、`Connections`、`ConnectionIssues`、`RuntimeIssues`、`FieldChoices`、`Layout`、`Events`、`Presentation`、`PluginHelp`。完整文件名、导出与行号见自动索引。

### 搭建 Agent 与交互 Agent

- `sceneS2Design.ts`：默认理解、用途索引、选择读取、装配、本地校验；共享最多一次定向修复。`sceneS2DesignDisclosure.ts` 管理有界选读，显式 `disclosure: 'complete'` 只用于完整上下文兼容调用。显式 `review:true` 的专项审查不能重新变成普通搭建必经步骤。
- `sceneS2DesignRepair.ts`、`sceneS2DesignEvidence.ts`、`sceneS2BusinessDiagnostics.ts`：有界修复和专项结构、来源证据检查。
- `sceneS2Turn.ts`：先理解用户意图，区分回复、修改、执行、正式比对与建议。
- `sceneS2Context.ts`：当前画布、触发实验、实际接线、历史及按需原文读取。索引和摘要不能替代执行输入。
- `sceneS2Memory.ts`：本局有界工作记忆，依据真实用户表达提交；宿主通知只读，不是长期画像。
- `sceneS2ArtifactAccess.ts`：宿主绑定的真实读取器，复制 JSON 索引不能伪造权限。
- `sceneS2AssistantSnapshot.ts`：固定某次实验的只读快照，旧分析不覆盖当前配置。
- `sceneS2ProposalReview.ts`：实质改图的语义一致性复核，不替用户确认或执行。
- `sceneS2Business.ts`、`BusinessRule.ts`、`Assessment.ts`、`Trials.ts`：新旧指标统一读取、本地有限规则、当前证据评价和历史实验比较。
- `sceneContextBudget.ts`、`sceneOutputSafety.ts`、`sceneS2Output.ts`：上下文预算、截断拒绝及有限格式恢复，不补造被截断内容。

根 `criteria` 与旧 `business.criteria` 共用协议；同时存在但不一致时明确报冲突。旧 business 的知识、workflow、私有完成图和覆盖证据继续兼容，但不是默认场景必填项。图片分析助手目前只获句柄与元数据，不能据此声称已理解像素。

### 组合蓝图

`sceneS2Composite`、`CompositeCanvas`、`CompositeLibrary`、`CompositeComparison`、`CompositeInstance`、`CompositeMigration`、`BlueprintDesign` 负责公共接口、层级、展开、来源、版本差异、独立新版副本和明确确认后的重接。

这些模块复用场景设计，不安装代码，不复制预算、资源许可或执行凭据。蓝图库不是全局交互插件市场；现有分组也不等于完整交互模式包。

## 提示词交互包的迁移边界

### 随包迁移的内容

提示词专用组装规则、编辑界面、参数界面、用途说明、设计与修复策略、合法组合关系、示例和包运行操作入口。原始能力 ID、字段形状、前缀与模板语义应保持，以兼容已保存场景。

### 终端保留的内容

通用画布和调度、文档与命令校验、运行身份、修订、幂等、资源与凭据、双预算、实际确认、取消、过期结果隔离、存储与只读证据。包的业务运行器复用这些能力，不能再建立第二个调度中枢。

模型实验文件需要按职责拆分，不能把所有模型逻辑整份下放给包：如何组织本次实验可以归包；实际模型配置、权限、预算和调用记录的最终判定必须留在宿主。

### 初版拆分记录与当前路径

初版盘点期间新增的接口现已由统一契约、加载器和包内实现承接：

- `src/types/sceneInteractionPack.ts`：包引用、manifest、说明、宿主服务、runtime、操作与包接口。
- `src/services/scene/sceneInteractionPackRegistry.ts`：包标识、版本和注册查找。
- `src/services/scene/sceneInteractionHostServices.ts`：终端侧服务适配。
- `src/services/scene/scenePackEditorServices.ts`：通用编辑服务；旧 `scenePromptPackUiHost.ts` 已删除，提示词包在包内 `uiHost.ts` 接收有限帮助接口。
- `src/interaction-packs/prompt-lab/`：`entry`、`index`、`manifest`、`description`、`runtime`、`designPolicy`、`textTemplate`、`composeControls`、`promptControls`、`uiHost`、`ComposeEditor`、`ModelParameters`、`TemplateControls` 等包内模块。

初版曾将 `sceneS2TextTemplate`、`sceneS2ComposeControls`、`sceneS2PromptControls`、底座 `S2ComposeEditor`、`S2ModelParameters` 变为兼容导出；第五轮解耦已将这些旧转发路径删除。当前直接使用包内对应实现，不能把历史路径当作仍可导入的公共 API。原 `PromptSettings.tsx` 已更名为 `TemplateControls.tsx`，导出为 `PromptTemplateControls` 和 `promptTemplateHiddenInputs`；它负责用途及模板控件，不是另一套内容块正文编辑器。准确文件和哈希以清单为准。

### 初版耦合清单（已由后续拆分替代）

以下保留2026-10-25初版风险，不能当作当前待执行的迁移清单。当前底座经通用视图、策略和受控模型桥接入，不按提示词业务 ID 选择专用 UI；实现解耦及隔离终端验收见交互包实施说明。

- 当时 Trial 直接选择 `text-template/model-test` 专用 UI、草稿、part 槽及旧模板编辑器，现专用交互归包，宿主只保留通用编辑与确认边界。
- 当时节点视图、展示词汇和帮助含固定插件判断，后续改为包声明与通用槽位。
- 业务静态注册与专用桥已分离；活动场景仍必须固定注册快照，不能使运行中身份热切换。
- 旧 `composeControls/promptControls` 的反向应用依赖已改为包内实现和有限宿主服务，不将整个应用打进包。
- 目录发现、安装产物、缺包恢复及第二个隔离终端目录已验收；完整安装器、另一台实体设备和不可信包沙箱仍不在这些证据范围内。

## 拆包不得改变的执行边界

1. 已安装、场景选中、Agent 可申请、用户运行授权是不同层级；包清单和自然语言不能生成授权。
2. 编辑可以保留未接完的草稿，运行必须有完整且类型兼容的输入。普通字符串不隐式变成 JSON、图片、凭据或真实业务结果。
3. 纯本地处理不依赖模型判断。执行是否成功与内容是否满足学习目标分开。
4. 模型只接收明确确认的完整提示词和材料，不暗中注入主持规则、预期、画像、历史或 RAG；不能自动换模型、重试或降级丢图。
5. 失败、取消、截断、旧修订、未知结束状态不发布当前成功产物。保留已收到原文与用量，不返还已发生的调用。
6. 助手的忙碌、停止和错误与实验分开；结果分析只读。明确委托填写可以提出待确认方案，不能由分析流程自动改图或再次运行。
7. 模板和包保存设计，不保存 API key、执行凭据、运行许可、附件访问许可、图片像素、预算会话或用户的历史确认。
8. 新旧路径可以并行验收，但一次运行只走一条。真实模型失败不能自动切回旧路径重发，活动运行不能热切换包实现。
9. S1、S4 和 S4 本地判定引擎不随提示词包改造；移除包后 S2 通用画布仍应可用。

## 验证脚本与证据分层

所有 S2 检查和支持文件都在自动索引中。初版 `check-scene-s2-*` 统计为120项；当前数量以重生成清单为准，package 总 S2 命令不是全部检查的同义词。

首批迁移优先保留：

```powershell
npm run check:scene-s2-experiment
npm run check:scene-s2-model-test
npm run check:scene-s2-registration
npm run check:scene-s2-browser
npm run check:scene
```

`check:scene-s2` 是较长的分组回归；历史记录是分段覆盖通过，不应写成某一次总命令从头到尾 exit 0。迁移后的检查必须重新记录，不能把本轮前的结果当作新包已通过。

初版尚未被相关 package 命令引用的9项如下；后续命令接入和新增项以清单的 `checksNotReferencedByPackageCommands` 为准：

- `check-scene-s2-canvas-live-bridge.ts`、`check-scene-s2-canvas-live-config.ts`。
- `check-scene-s2-host-result-live-safety.ts`、`check-scene-s2-host-result-validation.ts`。
- `check-scene-s2-images.ts`、`check-scene-s2-image-materials.tsx`。
- `check-scene-s2-optional-assistant.ts`、`check-scene-s2-task-replay.ts`、`check-scene-s2-ui-evidence.ts`。

区分以下三层：

- 离线：真实解析器、Host、处理器和合成模型／网络响应。harness 不等于浏览器渲染。
- 实际界面：使用生产组件的浏览器操作；5193 的原 `vite-s2-browser.config.ts` 固定合成模型且禁止真实 IO。
- 真实模型：只有明确授权的 live 启动器。`run-scene-s2-canvas-live.ts` 在同一URL显式替换入口和模型节点传输；不能仅凭5193地址判断是合成还是真实服务。

`fixtures/s2-experiment.ts` 是预制的文本、图片、资料实验，不能证明搭建 Agent 自行设计成功。旧 workspace JSON、模拟轨迹页面和精确响应复用脚本是测试资料，不是默认场景拓扑或产品的跨局恢复机制。

真实画布桥是本次固定合成输入、固定模型、1次及512输出预留的验收设施，不是可随包发布的通用HTTP、模型服务或产品额度规范。

## 2026-10-25 已记录的真实验收和预算

本次不新增模型调用，也不重置预算。此前有两个不同层次的真实文本实验：

- `s2-simple-experiment-20261025-b71`：终端生产 Host 真实请求一次。初版报告因错误查找 renderer 的插件执行 history 而汇总 false；原报告保留，`saved-verification.json` 按真实工作流的相同产物ID离线纠正，复核没有再次调用模型。它不能代表当时浏览器已显示。
- `s2-canvas-live-20261025-b71`：从当前浏览器空白内容块填写、组装、预算和完整请求确认后真实发送一次。`deepseek-flash` 返回 `{"姓名": "小林", "城市": "杭州"}`，正常 stop，输入46、输出12 tokens；模型节点和结果块直接显示原文，无回放。

最新证据目录：`.ui-preview/s2-agent-live/s2-canvas-live-20261025-b71/`。

- `request.json`、`dispatch.json`、`response.json`、`report.json`：本次发送与服务器回包。
- `browser-observation.json` 的 `finalView.resultFullyInCanvas === true`：实际画布文字与最终可见位置。
- `canvas-overview.png`、`canvas-result.png`：界面证据。

HTTP报告的 `browserDisplayVerified:false` 是有意把服务器返回和浏览器观察分开，不是结果显示失败。`syntheticOnly:true` 表示只发送合成测试材料，是否真实调用应看 `execution:real-provider`，不能将其误读成合成传输。

当前第70批新增授权池累计15次、39,424预留输出tokens，上限24次、48,000，余9次、8,576。端点为 `s2-canvas-live-20261025-b71`。更早14次、44,544属于另一个旧池，不能合并、重置或用某池剩余次数抵另一池输出预算。本次画布专项的1次额度已消耗，不能暗中继续发送。

真实文本样例通过不证明新默认搭建稳定、助手反馈准确、真实图片兼容、包目录装卸、跨终端分发或所有提示词组合通过。

## 尚未完成和接手风险

- 交互包的安装产物、目录加载移除、缺包恢复及两个隔离终端数据目录已完成对应验收；完整安装器及另一台实体设备仍须单独验收，不能把目录模拟当作全部部署完成。
- 自然语言搭建与交互 Agent 的真实语义质量、真实图片服务商兼容和效果仍待专项验收。
- 原生文件选择器、真实输入法、普通用户任务观察和部分复杂结构的交互仍有未完成项。
- E3 的全局个人库、原地升级与历史来源身份，D4 的第三方包审核和隔离，F 的跨刷新／重启会话恢复不能因本次抽包自动计为完成。
- 丰富旧蓝图库修复样例曾仅剩7个估算上下文tokens；不能重新扩大默认提示词包或强制全量业务证明。
- 类型检查只对注明的入口和依赖范围有效。历史 ES2022 配置下的 ES2023 库诊断仍需与新增问题分开，不能沿用旧错误数量或声称全仓类型清零。
- 同一工作区存在大量既有未提交和未跟踪文件，且另一对话正在修改。源码清单不是可执行的删除或移动列表，不应使用硬重置、批量清理或直接整目录搬迁。

接手时先读当前开发指南、本说明的更新和自动清单，再读提示词实验 fixture、正式 App 分流、Host／Workflow、包协议与 runtime，最后阅读对应离线回归和真实界面证据。保持旧配置和能力 ID；旧兼容导出已删除，不以历史路径或代码存在替代真实交互、权限和生命周期验收。

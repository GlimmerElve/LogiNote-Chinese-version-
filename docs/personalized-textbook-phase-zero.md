# 项目教材阶段零基线

验证日期：2026-10-06

本文保留阶段零时的历史基线。阶段一已接入业务实现，当前进度与剩余缺口见 [阶段一实施记录](personalized-textbook-phase-one.md)；下文的六项失败和未接入说明描述的是阶段零时点。

阶段零完成契约冻结和测试基线，没有启用教材生成，也没有实现折叠学习记录。现有 18 项专项检查中 17 项通过，场景检查有 1 项既有失败；类型检查、Web 构建和 Electron 构建通过。新增严格审计复现 6 项目标缺口，仍返回失败，不能将基线快照匹配视为教材功能通过。

## 冻结的产品与工程边界

`src/services/ui/refactorContracts.ts` 新增独立教材契约版本与四组声明，不修改既有 UI 契约版本、心流退出策略或复习证据门槛。当前只有新检查脚本读取教材契约，业务流程尚未接入。

- 教材按稳定项目 ID 标识。跨天、超期、画像变化或新增资料不自动重新生成；已有教材默认续读。
- `create`、`rewrite`、`append` 分别绑定明确授权。授权限定项目、操作、本地资料范围、联网许可和任务；失效授权不自动继承。写入只影响教材区域，保留版本和最新个人记录。
- 同一项目只允许一个教材修改任务；同一获准操作只发布一次。教材基础内容变化时拒绝覆盖，无关记录变化时从最新笔记合并。成功必须有持久化回执。
- 物料本地优先，联网只补已识别缺口。复习在对话中建议，通过已有入口进行，不插入上一课复习模块。
- 教材、参考资料、未确认个人素材、确认认知分别分类。教材编辑不改变来源身份，教材及结构图组件标记不能成为用户复述。
- 每次完成心流复盘形成一个折叠框，展开显示本次复述和原 `ArgumentBlock`。同次保存重试更新原框，同日另一会话新增框。标题默认实际学习时间，可重命名且不被图回写覆盖。
- 图文档继续存于 `NoteItem.argumentDocs`，保留原图显示、编辑入口、回写及质量发布规则。教材版本变更不删除记录；旧图无法可靠关联会话时，原文和原入口留在原位。
- 会话原文先暂存再分析，最终一起保存复述与图关联；分析关闭或失败不丢文本、不编造图。保留原始转写与分析副本的区分。
- 不改变资源四标签页、自动配额、手工添加及偏好逻辑，不复用资源草案作为教材草案；概念补全保持原标题与别名策略。生成或阅读不更新掌握度、确认认知、论证发布或计划完成状态。

## 新增测试与执行方式

`scripts/fixtures/textbook-phase-zero.ts` 提供合成混合正文：计划任务、公式、图片引用、表格、代码、Mermaid、注释脚注、个人复述和现有结构图引用。另有 12 个后续集成输入样例，覆盖跨天续读、同名不同项目、独立授权、发布重试、内容冲突、并发记录、同日多次学习、重命名、分析失败与旧图关联不明。

这些样例不是用户资料，也不证明多格式渲染、教材任务或折叠组件已经实现。后续阶段须把它们接到真实存储、任务和组件。

- `npm.cmd run check:textbook-contracts`：通过。12 组声明与夹具检查，冻结目标语义，不执行教材生成。
- `npm.cmd run check:textbook-baseline`：通过。正向控制有效，并精确匹配下述 6 项已知目标失败；输出明确标注不是功能验收。
- `npm.cmd run audit:textbook-phase-zero`：退出码 1。严格检查目标行为，当前 6 项失败，不忽略失败或将其转换为成功。

审计直接调用当前 RAG 来源函数，并通过 TypeScript AST 提取、执行当前心流保存对象、输入初始化和图保存分支的窄投影，不复制一份旧算法。源码无法提取或执行异常会报错，不算作已知缺口。它不是 React 生命周期、原生 Electron IPC 或浏览器端到端测试。

## 已复现的目标缺口

1. `flow-isolated-session-overwrites-body`：向现有心流保存边界提供目标设计的“仅本次复述”输入时，保存对象将其整段赋给 `content`，教材、任务和原图入口不在新正文中。这是接口不支持分离会话输入的反例，不代表当前正常追加复述一定丢正文。
2. `flow-input-seeded-from-note-body`：心流复述 ref 仍以完整笔记正文初始化，教材会混入旧复述快照。当前增量分析另有前缀截取；本例不声称当前所有评分都读取教材全文。
3. `unregistered-textbook-becomes-personal-material`：未登记为生成块的教材进入 `project-restatement` 个人素材行。
4. `edited-textbook-loses-source-exclusion`：已登记教材只要修改标题，原字符串排除就失效，教材再次进入个人素材。
5. `argument-markup-becomes-restatement`：即使原教材排除成功，`<ArgumentBlock ... />` 组件标记仍被当作个人复述文字索引。
6. `new-graph-save-retry-duplicates-entry`：以同一图 ID 重放 App 的新图保存分支，重复追加图文档和正文入口，而不是更新原记录。此例验证保存分支，不等同于已验证实际按钮双击时序。

个人素材仍保留 `stance: not_assessed`、`usableAsFactEvidence: false`，现有确认门控没有因此自动生成“用户认同”的认知记录。缺口是来源角色错误及可能的后续引用污染，不是已证实确认认知库被自动写入。

正向控制确认：旧 UI 正常保留正文前缀的追加保存仍保留教材；原生成块未经编辑时可被排除；个人素材不能充当事实；原图编辑分支更新原图 ID 并保留正文入口。

## 现有工程基线

以下 17 项专项检查通过：

- `check:ui-contracts`、`check:profile`、`check:memory`。
- `check:atomic-write`、`check:resource-browser`、`check:document-parsers`。
- `check:rag-foundation`、`check:rag-sources`、`check:rag-semantics`。
- `check:agent`、`check:agent-e2e`、`check:agent-interaction`。
- `check:knowledge-retrieval`、`check:cognition-chain`、`check:review-semantic`。
- `check:user-argument-rag`、`check:argument-quality`。

另外通过 `npm.cmd run lint`、`npm.cmd run build` 和 `npm.cmd run build:electron`。Web 构建有既有依赖 `onnxruntime-web` 的 `eval` 警告及大包提示，不作为无警告构建宣称。

`check:resource-browser` 同时覆盖现有资源词条组装和概念原标题、别名与相关度策略；检查通过不等于重新验收真实搜索引擎页面、登录状态或整套原生 UI。

### 场景检查的既有失败

`npm.cmd run check:scene` 在 `scripts/check-scene-paradigm.ts:684` 失败。夹具搜索结果未标注 `noteType`，预期仍接纳一条；`src/services/ragService.ts` 当前来源门控要求知识点类型，因此返回空数组。预期结果还缺少当前规范输出的类型字段。

阶段零没有改动这两个文件或来源门控，也没有为了让旧夹具通过而放宽来源安全。后续应单独核对夹具与现有来源契约，不将其混入教材业务改造。该检查在此处中止，后面的断言没有执行。

## 工作区与实施范围

工作区已有大量未提交和未跟踪改动。此次只追加教材契约、三个 npm 命令、新检查和夹具，以及本文和实施计划的阶段状态；没有重置、清理、提交或整文件覆盖已有源码。

没有修改 `FlowMode`、`App`、`ragSourcePolicy`、资源推荐或概念补全业务实现；没有安装依赖、联网搜集材料、启动真实教材任务或迁移用户笔记。正常构建重新生成 `dist` 与 `dist-electron` 构建产物，保留其工作区状态。

## 阶段一接入要求

下一步是分离教材区域与个人记录，接通真实会话暂存、折叠框、原结构图入口、来源识别和持久化。阶段零只冻结行为，不提前把拟议 `TextbookManifest` 或 `LearningReviewRecord` 字段塞入现有存储白名单。

阶段一改变保存实现时，要同步替换窄源码投影为真实服务/组件的回归检查，并按实际消除的缺口更新已知失败快照；不能删除严格断言或永久豁免失败。折叠框、标题编辑、图回写、重启恢复、迁移保全与多格式视觉验收仍待后续阶段完成。

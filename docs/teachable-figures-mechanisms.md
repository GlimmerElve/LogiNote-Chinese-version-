# Teachable Figures 教学机制适配

本项目依据 [Teachable Figures SKILL.md](https://github.com/ywEdAi/teachable-figures/blob/049f476d6188a4cd568550de7196fa94c12f4a1a/SKILL.md)、`references/teaching-and-spec.md`、`references/verification.md` 和 `references/rendering-selection.md`，将教学设计要点改写为适用于 LogiNote 的按需提示。渲染器来源及许可证见 `src/electron/vendor/teachable/README.md`。

## 教学约定

在现有 `FigureDesign` 的 `anchor / goal / action / observation / model / prediction / caveat / transfer` 中表达论断、误解、操作、观察、规则、边界和迁移；不增加旧附件无法读取的必填字段。控制项、图和读数使用同一规则；区分来源事实、计算和示意，尊重键盘、重置、减少动态效果与运行隔离。教学正确性和视觉真实性分别验收，不把一次操作或浏览器无报错当作学科证明。

## 机制映射

原 skill 中的机制名称是设计词汇，并不表示这些交互部件已注册或全部具有确定性本地模型。这里选中一种机制时仅加载对应指导，不改变已存储的 `kind`。

| 原机制 | 项目指导 | 教学关注点 |
| --- | --- | --- |
| sampler | `aiMechanisms.ts` | 温度、理论分布、样本量和可重现性 |
| tokens | `aiMechanisms.ts` | 文本切分、计数和计费规则 |
| embedding | `aiMechanisms.ts` | 向量、距离与投影边界 |
| attention | `aiMechanisms.ts` | 分数、权重、加权输出和归一化 |
| architecture | `aiMechanisms.ts` | 部件连接、尺寸与资源关系 |
| training | `aiMechanisms.ts` | 训练及验证曲线、固定对照条件 |
| context | `processMechanisms.ts` | 容量、留存与截断 |
| chunker | `processMechanisms.ts` | 切分、重叠、查询与检索 |
| validator | `processMechanisms.ts` | 规则、失败原因和未知结果 |
| builder | `processMechanisms.ts` | 构件、组合与约束 |
| flow | `processMechanisms.ts` | 步骤、分支、失败与终点 |
| agent | `processMechanisms.ts` | 行动、观察、状态、停止和权限 |
| threshold | `decisionMechanisms.ts` | 阈值、误报和漏报 |
| frontier | `decisionMechanisms.ts` | 多目标取舍与支配关系 |
| scorer | `decisionMechanisms.ts` | 权重、分项和总分 |
| economics | `decisionMechanisms.ts` | 收支、存量、流量和假设 |

原 skill 建议但不预注册的 `assembly / kinematics / section / spatial` 使用 `spatialMechanisms.ts` 的选型指导。既有 `stochastic / structure / mechanical / computation` 保持兼容。等轴测和刚体三维指导分别按实际渲染器加载；它们不提供医学、织物或高精度工程几何。

## 选择与验证边界

选择基于用户选中的教学目标，整页请求仅使用明确的标题；多个机制同时命中时回退通用教学约定。机制识别是保守的本地文本匹配，不是通用语义分类器，未命中不代表主题不适合交互图。

回归入口：`node scripts/run-tsx-safe.cjs scripts/check-teachable-mechanism-coverage.ts`。它验证路由、提示注入和隔离，不代表模型能够正确实现所有机制。实际验收仍需分别检查学科模型、预测与反馈、图形真实性、键盘与重置、主题、窄窗口、性能及适用的几何状态；真正的学习效果需要用户研究。

## 自动检查和定向修复

### 按目的选择呈现方式

新建交互图可分别采用动态演示、过程步进、解释对照和预测检验。目的选择独立于学科机制和二维/三维渲染器；动态演示展示时间演进，步进保留过程的中间状态，对照使用相同输入和可比较视图。前三种不要求预测输入、检查按钮或额外答题；不能用切换预写结论、装饰动画或编造比例代替教学机制。已有受控函数、齿轮等练习保留原模型；明确的动态、步进或对照目的不会被普通函数匹配覆盖。

`interactiveFigurePedagogy.ts` 只加载当前模式的短指导，不增加独立规划请求。未完成新图保存模式并在重试时沿用；旧无模式草稿保留旧协议，已生成附件不会自动重做。新渐进页通过 `generation.figurePolicy:1` 选择 V3 卡片指导，每页 0–1 个且不作为配额；旧任务没有此标记时不升级指导，继续保持冻结请求。

时间演示在独立图形进程使用本地 `TeachingClock`：最多每秒30次状态推进、增量步长封顶，需点击播放；暂停、隐藏、关闭或减少动态效果会停止。重新显示不自行续播，时间滑块或单步仍可读取中间状态。纯 Markdown 保留观察目标，离线分享附件携带相同的运行时，不在笔记正文执行脚本。

模式准入检查对应的播放/暂停、中间状态操作、步进状态或两个对照视图；有限诊断采样多个时间点或连续步骤并检查重置。这些检查仍不证明学科正确性或真实学习效果。心理化学等历史/哲学术语不再触发化学预测遮挡；旧误包装仅显示解包，不改原附件。

离线回归：`npm run check:interactive-teaching-modes`、`npm run check:progressive-figure-policy`。桌面合成案例：`npm run check:interactive-teaching-modes-native`，不调用真实模型。

依据原版 `references/verification.md`，本地探测只提供有限证据。附件可选保存 `repairReceipt`：`clean` 表示本次支持的探测未发现疑点，`repaired` 表示短补丁经过同一探测复核，`unresolved` 表示疑点尚未消除，`unavailable` 表示本次无法验证。这些状态均不代表学科或学习效果验收通过，旧附件无需迁移。

仅实际命中的疑点加载对应修复指导：预测一致性、预算读数、坐标尺度、柱形越界或齿轮接触。一次最多一个受限补丁请求，失败保留原图及结果，不在重新打开时重复请求。对已有 `unresolved` 记录的图，现有操作改为“修复交互图”，优先修补当前附件；明确重新生成其它图仍走原流程。教材正文继续可读，检查期间不在阅读主线程执行绘制或轮询，也不增加本地检查按钮或原始结果面板。

检查和修复记录由附件完整性摘要保护，并随重新打开恢复。并发修改优先保留新版本，旧补丁不能覆盖它。旧图显示兼容后的 HTML 也用于心流页重新打开，避免绕过读取适配。

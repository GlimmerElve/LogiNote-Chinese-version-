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

依据原版 `references/verification.md`，本地探测只提供有限证据。附件可选保存 `repairReceipt`：`clean` 表示本次支持的探测未发现疑点，`repaired` 表示短补丁经过同一探测复核，`unresolved` 表示疑点尚未消除，`unavailable` 表示本次无法验证。这些状态均不代表学科或学习效果验收通过，旧附件无需迁移。

仅实际命中的疑点加载对应修复指导：预测一致性、预算读数、坐标尺度、柱形越界或齿轮接触。一次最多一个受限补丁请求，失败保留原图及结果，不在重新打开时重复请求。对已有 `unresolved` 记录的图，现有操作改为“修复交互图”，优先修补当前附件；明确重新生成其它图仍走原流程。教材正文继续可读，检查期间不在阅读主线程执行绘制或轮询，也不增加本地检查按钮或原始结果面板。

检查和修复记录由附件完整性摘要保护，并随重新打开恢复。并发修改优先保留新版本，旧补丁不能覆盖它。旧图显示兼容后的 HTML 也用于心流页重新打开，避免绕过读取适配。

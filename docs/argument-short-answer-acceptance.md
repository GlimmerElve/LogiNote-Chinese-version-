# 简答场景逐步验收（2026-10-07）

## 验收范围

本次使用“选择过载”合成知识点和固定模拟模型响应，验收当前参考论证系统的构建、定位、任务读取及原题冻结合同。没有调用外部模型，没有读取真实学习库，没有改写生产索引、认知库或掌握度分数。浏览器预览仅通过本地临时 HTTP 服务展示合成产物。

这不是模型抽取准确率验收，也不是完整掌握度评分或认知生长的产品验收。`eligible`、`reviewed_complete`、`complete_for_scope`、`fixed`、`current` 都不表示客观事实已认证或用户已经掌握。

## 复现

依次执行：

```text
node scripts/run-tsx-safe.cjs scripts/demo-argument-short-answer.ts
node scripts/run-tsx-safe.cjs scripts/demo-short-answer-tutor-context.ts
node scripts/build-short-answer-walkthrough.mjs
```

第一个脚本创建自己的临时保存来源与投影存储，调用真实构建服务、bridge、read-task 和 question-frame 服务；仅三个模型适配器响应、一个召回入口为固定替身。临时目录在 finally 清理，原笔记内容前后按字节比对不变。

第二个脚本只读取第一个脚本的合成 JSON 和代码，调用实际纯函数重建第 2 题请求。导师 userInput 模板通过 TypeScript AST 与当前 ReviewChat 逐字核对；system、温度、token 参数来自当前源码。不调用组件、模型或真实检索，不解析服务商配置或凭据。

第三个脚本只把两份合成 JSON 机械嵌入已经保存的逐步演示，不访问网络。

## 每一步产物

1. **保存原文**：四段、184 UTF-16 单元，CRLF 原样保留；区间 `[0,30)`、`[34,76)`、`[80,129)`、`[133,184)`。
2. **不同分块**：默认旧 L1 纯函数产出一个 LF 归一化块；当前知识点 passage 产出四块；论证物理层为四段、四完整句、四容器。这些不是同一层对象。本次只展示 embeddingText / embeddingKey，没有生成向量。
3. **证据候选**：程序生成十四个 Q（完整句＋子句）。节点实际使用 Q1、Q4、Q7、Q11；一个 K 包含多个子句不等于全部选入节点。
4. **固定模拟抽取与审核**：4 节点（definition / condition / example / fact），2 有向边（N2→N1 requires_condition；N3→N1 illustrates），3 已审任务 scope。来源准入、抽取和结构审核是三次独立模型适配器调用，本轮全部返回 mock。
5. **原题目标选择**：单知识点由 ID / 允许名称绑定；固定模拟导师选择 definition，K1→I1→N1/Q1；K2→I2→N2/E1/Q4。另有合成已确认 C1，经实际解析映射为个人认知版本坐标＋give_condition。不得从目标回答反向选择标准。
6. **必要结构读取**：模拟 passage 命中，经真实 bridge 校验来源/版本/原文区间定位 N1；read-task definition 匹配已审 S1，仅读 N1/N2/E1。例子 N3、材料说明 N4、例示边 E2 不进入本题包。
7. **上下文装配**：当前导师两个 messages 为 workflow system，以及“记忆前缀＋正文＋最近对话＋提示记录＋C#摘要＋任务协议＋K#候选”。重建后的 system 1484、user 3335 字符，temperature 0.6、max_tokens 2048、stream true；均未发送。新 sourceFrames 只在题后由 host 读取冻结，未加到导师请求。单独序列化的结构化 context 是演示用，不是正式发送的 payload。
8. **回答与核验**：合成回答 39 UTF-16 单元。原题合同先固定，回答不用于选择参考；核验 current、原合同不变。回答语义评判 not_performed、分数 not_computed，预期语义对照只作为人工示意。
9. **验收边界**：参考构建和按题读取路径跑通，不等于完成结构化评分及认知自动生长。

## 目前生产接入缺口

- 新结构 pack 没有进入导师请求；C# 仍是摘要，不是完整个人逻辑链。
- 新 host 结构没有作为正式回答比对和写分依据，结束复习仍调用旧 review-scoring。
- 确认回答候选、认知目标定位不等于自动创建 support / condition 等认知连线。
- 程序开场题只生成 `[检验]`、不生成 `[核对]`，因此缺原文核对选择时结构合同 held；本演示刻意采用带固定模拟选择的第 2 题。
- 最终 cleanText 剥离隐藏标记，但当前流式阶段可能短暂显示原始标记。

源码边界：ReviewChat 的 inline 导师组装、题后 freeze、结束 verify/prepare 与旧评分路径；llmStreamService 的记忆前缀；argumentQuestionFrames 的 host 读取/冻结；questionBindingClient 的 renderer receipt。通用 source-frames API 和新的 semanticEvaluator 不应被误称为已经成为正式评分消费者。

## 本轮检查

- 两个离线演示脚本实际运行并通过内部断言；外部模型请求零、生产写入零。
- `check:argument-question-frames`：23 个合成合同组通过。
- `check:argument-question-runtime`：21 个合成合同组通过。
- 浏览器逐一切换九个步骤，均有内容、没有 undefined 或 console error；展开完整 user 提示词可读。320 / 736 像素宽度下九步均无页面水平溢出；上下步点击可往返。浏览器工具的 Enter 操作超时，因此不声称完成键盘实测；控件采用原生 select / button。
- `npm.cmd run lint`（tsc --noEmit）通过；这些检查不证明真实模型语义准确率。

使用 visualize、ui-styling 呈现逐步产物；没有修改应用业务代码。

# AP20160300000 本地窗口上下文验收

## 本轮边界

仅新增本地阅读窗口上下文规划与只读验收。没有调用模型、重建生产向量索引、更新认知库或掌握度，也没有改变 AgentSkill。旧 `planArgumentWindows` 默认行为与旧 AP 抽取实验的冻结输入保持兼容。

新入口 `planContextWindows` 位于 `src/electron/rag/argumentWindowContext.ts`。`readContextWindow` 输出正文、前文、后文、匹配注释及精确原文定位；现在是本地组装/预览契约，尚未替换生产上传或旧模型请求入口。

## 本地处理

1. 先验证已有结构化原文，再识别显式 Markdown 脚注或 PDF 页底编号注释候选。
2. PDF 旧索引不保留字体上标：用同号正文标记、页范围和页底位置进行规则匹配，不声称恢复了 PDF 字体信息。实验/情景/情境编号、数量单位、小数不能作为该规则的角标。
3. 页底编号段落没有对应正文调用时不擅自隔离。歧义调用不随意择一。原文和坐标不改写。
4. 已关联注释从正文窗口隔离，但仍在原文覆盖账本中保留；正文按完整句重新规划，避免脚注打断跨页正文续句。
5. 相邻正文窗口共享上一窗口完整末句和下一窗口完整首句，跨章节也可携带。问句及末尾 YES/NO 比例一起携带。共享单元使用原 ID，核心覆盖一次。
6. 引用出现在正文或携带上下文时，整条对应注释进入读取内容，关系仅为来源引用，不推断支持/反对。
7. 必要上下文超过预算时优先缩小核心、沿完整句重组；不能满足时明确阻断，不截断注释冒充完整窗口。

## 验收与限制

- 自动检查：原文覆盖 100%、核心重复字符 0、注释不混入核心、完整边界单元在双方可读取、每个窗口独立检查核心/上下文/总预算。
- 人工语义验收：直接阅读相邻窗口及注释，检查主体、条件、否定、语气、作者归属。规则通过不是语义完整性证书。
- “以上两个方案”等远距离指代、跨栏/表格混排、乱码和作者语义推断不在本轮自动修复范围。保留缺口，不强造关系。
- 不承诺所有 PDF 脚注布局都已支持。合并在多块/跨页的脚注、编号重用、非数字注释、全文书目引用等需要单独的解析契约和样本验收。

## 运行

```powershell
node --experimental-strip-types scripts/check-argument-window-context.ts
node --experimental-strip-types scripts/check-argument-window-planner.ts
node --experimental-strip-types scripts/check-ap-window-pilot.ts
node --experimental-strip-types scripts/check-ap-core-pilot.ts
npm.cmd run lint
node --experimental-strip-types scripts/preview-ap-context-windows.ts --out-dir <绝对路径的非生产预览目录> --serve
```

预览脚本只读取 AP20160300000，比较生成前后生产 JSON 的哈希，写入新的独立报告目录，不覆盖过去的报告。页面支持相邻窗口对照、共享原文位置、角标点击和实际组装内容的展开读取。

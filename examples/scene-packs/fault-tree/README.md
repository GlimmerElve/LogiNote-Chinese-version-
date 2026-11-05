# 事故树分析插件包 · 最简版

`fault-tree@1.0.0`，使用 S2 包协议 v1。需要支持完整节点视图、包内双击和端口位置配置的当前 S2 底座。

这是事故树结构建模与逻辑关系表达包：可手动搭建、修改、接线、保存并复用，不计算概率、最小割集，不判定现实事件是否发生。不需要模型、资料授权、主动运行或额外结果面板。

## 使用

添加菜单只有“事件”和“逻辑门”两个能力组件。

- 事件只有“事件类型”和“内容”两个填写项。事件类型可选顶事件、中间事件、基本事件，新建默认为基本事件；内容最多2000字，没有独立名称或发生状态字段。
- 逻辑门新建默认为与门。双击门符号在与门和或门之间切换；聚焦门后按 Enter 或空格也可以切换。
- 下级事件顶部输出连接门底部任一接入点；两个接入点都支持多条连线，合计支持2～32个不同事件，可将多个事件接在同一点。门顶部输出仍连接一个上级事件底部输入。无需新增端口、添加输入字段或经过确认面板；门下方显示已接入事件数。
- 事件类型切换只更新属性和形状；已有连线不自动删除。未连接或类型角色不符时在节点旁给出提示，仍可保存草稿。
- 拖动、选中、删除和撤销重做使用底座原有操作。上方工具栏“保存场景”保存当前配置，下次从“场景模拟 → 复用已有场景”打开。

完整树需要一个顶事件。基本事件不接下级门，顶事件不作为其他门的输入；中间事件由下级门定义，再向上级门提供事件。每个门连接2～32个不同输入事件和一个输出事件，不允许循环。同一事件不能在同一个门重复计入，包括跨两个接入点重复；可以被不同上级门引用。相同内容不会自动合并为同一事件，程序使用节点 ID 识别身份。单个接入点也遵守 S2 每端口32来源上限；完整画布仍受底座40个执行节点、80条执行连线的总量限制。

`sample.public-canvas.json` 是公共搭建配置；`sample.s2-workspace.json` 是可在当前 S2“更多 → 工作区导入／导出”导入的完整示例。导入后为 A、B 经与门连接顶事件 C。仅换门类型，就得到 `C = OR(A, B)`；OR 表示至少一个下级事件发生，包含同时发生。

`sample.multi-input.public-canvas.json` 和 `sample.multi-input.s2-workspace.json` 提供三个下级事件的可复用示例：`C = AND(A, B, D)`。与门要求全部接入事件发生，或门要求至少一个发生；两个接入点合并为一个集合，不形成左右两组嵌套运算。旧的两个输入示例及已保存场景继续使用原 `left / right` 端口 ID，直接兼容。

## 构建与安装

```powershell
npm run build:scene-pack-fault-tree
npm run check:scene-pack-fault-tree
npm run check:scene-pack-fault-tree-browser
npm run check:scene-pack-fault-tree-theme
node --max-old-space-size=8192 node_modules/typescript/bin/tsc -p scripts/tsconfig.scene-fault-tree.json --pretty false
```

构建输出在 `output/scene-pack-examples/fault-tree/1.0.0/`，包含 `manifest.json`、`main.js`、`agent.json`、`styles.css`。这是独立分发目录，未自动安装到当前用户的应用数据目录。

按开发指南用 `npm run package:scene-pack -- <fault-tree/1.0.0目录> <新输出.zip>` 打包，在桌面“S2 交互包 → 导入 / 更新”确认可信后导入，即可选择“事故树分析”，无需重启；也可手工复制整个版本目录到交互包根目录后重启发现。可从空画布添加组件，也可导入上面的示例。更新使用新版本并存，旧场景保留原精确引用，不自动迁移。保存场景只保存配置及包引用，不把插件代码复制进场景。

`npm run check:scene-pack-fault-tree` 也会生成/核对完整示例工作区，方便在实际应用中复用。可独立验包：

```powershell
npm run validate:scene-pack -- --dir output/scene-pack-examples/fault-tree/1.0.0 --scene examples/scene-packs/fault-tree/sample.pack-config.json
```

## 程序接口与边界

`authoring` 只公开 `event(eventType, content)`、`gate(gateType)` 及其真实端口。Agent 不接触 SVG、CSS、端口位置或双击代码。包内 schema 约束事件/门枚举；`fault-tree-logic.event@1` 和 `fault-tree-logic.condition@1` 使连线自然遵循事件 → 门 → 事件。

`readFaultTreeModel(document)` 直接读取当前配置，返回事件、规则、顶事件 ID 和问题列表。规则形如 `{eventId: 'c', gateId: 'gate', operator: 'AND', inputEventIds: ['a', 'b']}`。这是结构事实，不是事件发生证据。

`inputEventIds` 是长度2～32的事件身份数组，可为 `['a', 'b', 'd', 'e']`。底座端口声明中的 `left / right` 均为 `multiple: true, required: false`；至少两个不同事件的合计要求由包的业务校验和执行器检查，所以允许单点接入全部事件、另一点留空。空白或未接完的草稿仍可保存；明确执行时拒绝少于两个、超过32个、重复事件和不合法角色。

Agent 可通过同一公开 `addNode` 添加事件，再通过 `connect` 将该事件的 `event` 输出连接已有门的 `left` 或 `right`。已有连接不会被替换；填写值和接线仍须按需读取相应参数/端口规则。用户也可以手动从事件顶部拖线到已有来源的接入点。双击切换门类型只改 `gateType`，不改变任何输入集合或连线。

本包在本地入口声明 `execution: 'none'`，编辑后的事件、门类型和连线就是当前模型，不需要运行、测试或额外确认。用户直接说“添加基本事件并连接到这个门”“删除该事件”“只断开这条线”即可，无需补充“不运行”。底座移除交互范围的 execute；公共动作和宿主执行入口也会拒绝误加的 run/cancel，包的运行方法不会启动任务。

按当前协议仍保留 `validate / executeLocal / createRuntime` 的接口形状。低层纯能力及类型传输契约测试可验证事件描述与门定义，不伪造布尔发生值；这些测试不构成用户的运行流程。编辑与保存不会创建运行器或调用 executeLocal。`readModel` 只供本地已接入程序读取当前模型；必要的业务校验、取消与释放服务仍留在底座，未完成草稿仍可保存。

## 验收范围

事件使用紧凑的类型下拉标签和居中内容，基本事件保留圆形，顶/中间事件保留矩形；没有增加事件名称字段或新的确认步骤。颜色取自底座主题变量，深浅色及原生菜单由底座适配。主题浏览器验收会在同一画布上执行浅色→深色→浅色切换，检查下拉选项、文字及缩放控件的对比度、包内样式优先级和配置不变；截图及报告在 `output/fault-tree-theme/`。

独立测试使用实际构建工具、隔离 Electron 包目录和生产加载器，检查真实类型化执行、业务校验、枚举/连线边界、样式与 Agent 隔离、旧回调/只读/取消、保存序列化及新本局恢复。浏览器使用构建后的 ESM 经生产加载器进入实际 S2 画布，验证字段、形状、双击和键盘、撤销重做、真实上下拖线、添加菜单、工具栏保存和场景库重新打开。

上述离线测试不访问真实模型、网络或用户笔记；浏览器场景库使用临时内存存储。截图和报告在 `output/fault-tree-browser/`。完整桌面安装路径可参照底座的 `docs/scene-s2-plugin-developer-guide.md`。

另有显式启用的真实 Agent 验收：

```powershell
npm run check:scene-pack-fault-tree-live -- --execute
```

本轮只检查普通编辑时可用 `npm run check:scene-pack-fault-tree-live -- --execute --edits-only`：从已知的四节点场景开始，全部编辑、解释和保存交互仍使用真实模型与生产画布；不调用模型重复搭建，不回放任何模型回答。

它读取当前应用的模型配置和已安装的 `fault-tree@1.0.0`，要求安装文件与当前构建一致。使用真实模型，经生产 S2 画布的公开搭建及交互链路完成：三个事件与一个与门及正确连线、对话改门/改内容、只解释、对话新增第三/第四个事件并接线、只断开连线、重新连接、删除事件、保存并在全新浏览器上下文重开。编辑指令均不含“不运行”。除事件类型、节点身份、输入集合和连线外，每轮还断言零包运行器、零 executeLocal 调用，最终动作不含 run/cancel，不要求用户运行后生效；不以助手回复中的“已完成”作为成功依据。

模型凭据留在测试进程，使用生产 `callLLM` 和主进程模型转发函数；模型 IPC 与场景文件 IPC 由 Playwright 测试桥接，不是完整桌面外壳验收，也不使用预设或回放答案。只有合成事故树任务和必要的公开上下文发往模型，场景通过生产 `sceneSkillStore` 保存到 `output/fault-tree-agent-live/<时间>/scene-skills/` 的独立磁盘库，不写用户的场景库。单次最多28个模型请求，累计输出额度最多150000 tokens；未传 `--execute` 不会发起模型请求。各次报告保留实际请求数、用量、原始模型回包、截图及成功/失败结果，网络失败不伪装为通过。

可从一次已通过验收的磁盘场景开始，单独检查交互 Agent 的场景理解；这只复用已保存配置，不回放模型答案，所有测试对话均重新调用真实模型：

```powershell
npm run check:scene-pack-fault-tree-live -- --execute --understanding-from output/fault-tree-agent-live/<已通过轮次目录>
```

该模式清空对话后检查场景用途、事件内容和 OR 关系，再实际双击改为 AND、修改事件内容、删除 B 到门的连线，验证下一轮能读到当前状态并指出断线。另检查助手不会从结构推断现实事故或具体概率，也不会猜测未提供的保存及按钮点击记录。每轮检查均断言不产生编辑/运行动作、画布保持原样；报告保留问题、原始回答和每轮实际调用范围，便于复核语义判断。

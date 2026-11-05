# S2 交互包开发指南：从源码到可复用场景

核对日期：2026-10-28。面向编写本地插件包的开发者和编程助手，依据当前代码与仓库工具编写。

完成本指南后，你应能交付一个 ZIP：用户在“场景模拟”中安装并选择它，添加组件、编辑和连线，按业务需要执行，再保存场景供下次复用。新增业务在包内实现；底座提供画布、公开配置校验、类型化连接、执行和保存服务。

本文按开发顺序阅读。[接口参考](scene-s2-plugin-api-reference.md)保留完整字段、限额、兼容路径和错误规则；[v2 物料协议](scene-s2-package-materials-v2.md)只在需要随包分发独立资源文件时阅读。历史实施记录不作为新包的开发步骤。

## 1. 先跑通一个已有包

需要仓库源码、项目开发依赖和可运行的桌面应用。当前没有独立发布的 npm SDK 或脚手架；以下命令均在仓库根目录执行。

按业务选择起点：

- **首个最小包**：读[文字回显示例](../examples/scene-packs/text-echo/README.md)。一个能力节点、一项文字参数、一个回显按钮，复用宿主结果展示；已从新目录完成开发、打包、原生 ZIP 安装和完整桌面保存复用验收。
- **只编辑结构**：读[事故树示例](../examples/scene-packs/fault-tree/README.md)。事件和逻辑门都是能力组件，完整节点由包绘制，声明 `execution: 'none'`，编辑和保存直接生效。
- **点击后本地计算**：从[数值缩放示例](../examples/scene-packs/number-scale/README.md)开始。它没有模型或文件依赖，完整演示声明、计算、按钮、结果和保存。
- **点击后调用模型**：先掌握本地计算链路，再读[提示词包入口](../src/interaction-packs/prompt-lab/entry.ts)和[模型能力声明](../src/interaction-packs/prompt-lab/modelCapability.ts)。模型必须经过宿主模型桥。
- **随包提供文本、JSON 或图片**：在上述结构上参考[物料示例](../examples/scene-packs/material-study/README.md)，使用 v2；普通常量可直接放在代码或默认参数中。

第一次先不改数值缩放示例，运行：

```powershell
npm run build:scene-pack-example
npm run validate:scene-pack -- --dir output/scene-pack-examples/number-scale/1.0.0
npm run check:scene-pack-example
npm run package:scene-pack -- output/scene-pack-examples/number-scale/1.0.0 output/number-scale-1.0.0.zip
```

打包命令要求目标 ZIP 尚不存在；再次打包时换一个输出文件名。构建不会安装到用户应用。

在完整桌面应用中进入“学习 → 场景模拟”，填写场景名，下一步选择“通用画布（试验）”，通过“S2 交互包 → 导入 / 更新”安装 ZIP，再选择该包。用“自定义场景”进入空白画布，检查“添加”菜单；通过“更多 → 工作区导入／导出”导入示例的 `sample.s2-workspace.json`，点击节点内“计算”，应得到 `结果：10`。

先做到这一步，确认开发环境、打包和安装链路可用，再替换业务。ZIP 是安装包；`sample.s2-workspace.json` 是使用这个包的场景配置，两者用途不同。

## 2. 底座怎样把一个包变成画布

包按三个入口接入底座：加载入口 `activate`、本地视图回调、按需创建的运行器。它们的调用时机不同：

```text
安装 ZIP → 发现 manifest → 选择包 → activate → 校验并注册组件和视图
                                                 │
                         authoring 公开目录 ←──────┘
                                │
                   用户添加/编辑 或 Agent 公开动作
                                ↓
                     本地校验、编译、更新画布配置
                         │                 │
                    保存场景          明确执行（包允许时）
                         │                 ↓
                    下次读取配置     createRuntime → host.run
                                           ↓
                                 底座解析输入、调度和校验产物
                                           ↓
                                executeLocal 或宿主模型/资源桥
                                           ↓
                                     包内视图/结果块展示
```

**包负责业务设计。** 定义组件、字段和端口，组合代表什么，块怎么显示、双击做什么，以及是否需要“计算/测试”等执行入口。需要执行的包同时提供状态、错误和必要的停止交互。

**底座负责通用机制。** 管理节点身份、选中拖动、真实连接点、删除与历史、公开修改边界、类型检查、调度取消、产物来源、本局资源及保存。包使用这些服务，不直接修改底座内部状态。

**Agent 使用公开接口。** 用户和 Agent 共用 `authoring` 目录、业务参数及连线校验。Agent 返回公开配置或动作，本地程序实施修改；它不生成 CSS、React 组件、双击代码或运行授权。

加载、渲染、选中、普通编辑和保存都不自动执行。`createRuntime` 不在每次编辑时创建，终端也不自动逐次调用其 `updateConfig`。仅编辑包即使使用“能力组件”，也无需运行。

### 2.1 分清源码、构建产物和场景配置

- **源码目录**：开发者维护的 TypeScript、JSON 和 CSS；构建工具读取这里。
- **构建目录**：产出 `<包ID>/<精确版本>/`，用于验包和生成 ZIP。修改源码不会自动替换已安装的包。
- **安装目录**：`<应用数据根目录>/scene-interaction-packs/<包ID>/<精确版本>/`，由应用安装和加载。它不在场景库中。

`S2PublicCanvas` 是用户/Agent 的搭建格式，只含 `componentId`、实例 ID、公开 `values`、位置与 `connections`。底座把它编译为包本地使用的 `ScenePackConfig { definition, document }`，其中包含真实能力引用、字面量/字段绑定和执行连接。`definition` 描述场景及初始基线，`document` 是当前实例快照。

保存的场景引用精确包版本并保留配置，不复制包代码、执行结果、对话或授权。把场景文件发给另一台终端时，对方仍需安装相应包。

## 3. 建立自己的源码目录

复制数值缩放示例到同级新目录，保持相对类型导入可解析：

```powershell
Copy-Item -LiteralPath examples/scene-packs/number-scale -Destination examples/scene-packs/my-scale -Recurse
rg -n 'number-scale|example-number-scale' examples/scene-packs/my-scale
```

```text
my-scale/
  scene-pack.json         manifest：身份；authoring：公开组件；可选 execution
  entry.ts                同步 activate，装配其余模块
  plugins/scale.ts        能力、类型、端口声明与 executeLocal
  runtime.ts              业务 validate、运行编排、取消及 dispose
  views.ts                包内按钮、设置或完整节点视图
  styles.css              本包样式，可以为空
  sample.s2-workspace.json 可导入的示例场景，包含精确包引用
```

先改身份，再改业务。将 `manifest.id` 改为 `my-scale`；将自有插件 ID `example-number-scale` 改为 `my-scale-tools`，同步修改 `authoring.implementation`、视图/help 的能力键，以及示例配置中的能力引用。源码的 `isScaleNode` 等判断继续使用同一常量，避免声明改了、执行器仍认旧 ID。示例工作区的外层 `interactionPack` 也要引用新包。共享能力如 `structured-view` 不改名。

包 ID 定位安装包；插件 ID + 插件版本 + 能力 ID 定位真实实现；`componentId` 是公开搭建类型；节点 `id` 是画布上的一次实例。修改显示标签不会改变这些身份。

`scene-pack.json` 是本仓库示例构建工具的源码约定，不是安装格式，也不是应用直接执行的文件。源码移到其他层级时调整类型导入；运行时依赖必须留在包目录内并编入单文件产物。

## 4. 定义字段、端口和业务含义

对每种组件先回答：用户能改什么？接收什么？输出什么？默认值是什么？哪些值和连接不合法？然后写两层声明。

**真实能力契约。** 在 `plugins/*.ts` 中写 `S2PluginManifest`：精确版本、依赖、语义数据类型、能力输入输出及执行约定。每个端口声明类型、`required` 和 `multiple`；自定义类型使用有界 schema，限制字符串长度、集合大小及对象字段。相同 JSON 形状不表示语义类型兼容，转换通过显式能力完成。

自定义数据类型 ID 必须以所属**插件 ID**加点号开头，例如插件 `my-scale-tools` 声明 `my-scale-tools.value`；不是包 ID 或公开 componentId 的命名空间。输入/输出类型引用也必须使用同一个精确 ID 和版本，否则激活验包会拒绝。

新增纯本地处理能力使用 `kind: 'transform'` 或 `'validator'`、`effect: 'pure'`、`permissions: []`。渲染一个自绘节点不需要把能力种类改成 renderer；能否执行由包级 execution 决定。

**公开搭建目录。** 在 `authoring.components` 中选择允许用户和 Agent 使用的参数和端口。以下是缩放组件的公开声明片段，对应真实插件必须已定义：

```json
{
  "id": "scale", "label": "数值缩放",
  "purpose": "将非负数乘以正倍数，输出数值与文字。",
  "group": {"id": "processing", "label": "处理"},
  "implementation": {
    "kind": "capability", "pluginId": "my-scale-tools",
    "pluginVersion": "1.0.0", "capabilityId": "scale"
  },
  "parameters": ["amount", "factor", "label"],
  "inputs": ["amount", "factor", "label"],
  "outputs": ["product", "text"],
  "defaults": {"amount": 4, "factor": 2.5}
}
```

`parameters` 表示允许写入实例 `values` 的字面量参数；`inputs/outputs` 表示允许接线的真实端口。两者可使用同一个输入 ID，但开放接线不会自动开放改值。`defaults` 可包含内部固定参数，未列入 `parameters` 的默认参数不因此变成可编辑项。参数类型和限制从真实能力契约读取，不在公开目录重复维护 schema。

公开之后，用户和 Agent 就能用同一种配置搭建。下面对应复制后的缩放包：

```json
{
  "version": 1,
  "nodes": [
    {"id":"caption", "componentId":"caption", "position":{"x":0,"y":0}, "values":{"content":"结果"}},
    {"id":"scale", "componentId":"scale", "position":{"x":350,"y":0}, "values":{"amount":4,"factor":2.5}},
    {"id":"show", "componentId":"result", "position":{"x":700,"y":0}}
  ],
  "connections": [
    {"source":{"nodeId":"caption","portId":"content"},"target":{"nodeId":"scale","portId":"label"}},
    {"source":{"nodeId":"scale","portId":"text"},"target":{"nodeId":"show","portId":"text"}}
  ]
}
```

这里的 componentId、参数和端口必须来自公开目录。它是 `S2PublicCanvas`，用于公开搭建/编译接口；画布“工作区导入”使用带 format、definition 和包引用的完整工作区文件，直接沿用并修改示例的 `sample.s2-workspace.json`，不要把两种格式混用。

只需通用文字编辑时，使用 `implementation.kind: 'content'` 和实际字段定义。需要专用形状或双击交互时，像事故树一样使用能力组件。当前完整节点视图入口面向能力节点，普通内容块使用底座内容字段视图。

### 4.1 事故树怎样表达，而不依赖屏幕符号

事件组件公开 `eventType` 和 `content`；逻辑门公开 `gateType`，默认 `AND`。枚举取值和文字长度属于字段/schema 约束，图标是这些业务值的本地呈现。

```text
A.event ──→ gate.left
B.event ──→ gate.right      gate.condition ──→ C.condition
D.event ──→ gate.left
```

事件输出使用事件语义类型，门输出使用组合条件类型。`left/right` 都允许多来源，包将两处输入合并为一个集合，业务规则要求 2 至 32 个不同事件。AND 表达“所有下级事件发生时 C 发生”，OR 表示至少一个发生。它不代表现实事件已经发生，也不需要运行来证明连线已保存。

端口在上边还是下边由视图决定，数据方向始终是 `source → target`。包定义业务组合规则和端口位置，不能取消底座的类型、基数、公开范围和 DAG 校验。实现见[事故树能力](../examples/scene-packs/fault-tree/plugins/index.ts)和[业务模型校验](../examples/scene-packs/fault-tree/model.ts)。

## 5. 决定是否执行，再实现业务逻辑

在 `activate` 返回的包对象顶层声明 `execution`，示例构建元数据也可使用同名顶层字段。它不属于 manifest，不由场景或 Agent 改写。

元数据中声明 execution 时，入口应返回同值；构建工具不会替你补业务入口或运行逻辑。

- `none`：仅编辑/建模。无需执行按钮，编辑和保存直接生效。参考[事故树运行器](../examples/scene-packs/fault-tree/runtime.ts)，保留接口要求的方法，明确拒绝 run/cancel。
- `on-demand`：明确请求时执行。提供“计算/测试”等业务入口、结果和必要的停止交互。省略时保持旧包的按需执行行为，新包建议显式声明。

`requiredServices: ['execution']` 是依赖声明，不等于每次编辑都要运行，也不等于授权。两类包的 `validate`、`createRuntime` 和 `executeLocal` 仍是必需接口，不能删掉函数或留下未实现的 TODO。

本地计算按以下顺序完成：

1. `validate(config)` 检查业务配置，返回 `{path, message}[]`。执行前底座检查该列表；普通编辑和保存允许未完成草稿。仅编辑包如需即时提示，在本地视图读取业务校验结果显示。
2. `createRuntime(config, host)` 返回 `updateConfig / dispatch / run / dispose`。每次 run 使用 `host.readConfig()` 读取最新配置，检查后委托 `host.run`，不闭包持有首轮旧值。
3. `executeLocal(call, inputs, signal)` 执行一次纯本地能力。`inputs` 是按端口 ID 索引的值数组，`call.inputs` 是产物 ID；不要混用。检查动态输入、处理取消，返回完整 `S2PluginOutcome`。
4. 成功 artifact 包含唯一 ID、精确类型、`complete`、本次 call 的 scene/run/node/revision/invocation 来源和真实 payload。失败不伪造成功产物。参考[缩放能力的完整实现](../examples/scene-packs/number-scale/plugins/scale.ts)。
5. 只取消本运行器启动的任务；`dispose()` 可重复调用并释放监听和临时工作。终端退出或切换场景自动清理，不要求用户先“结束试验”。

正式画布不向运行器提供整图写入回调，不能依赖 `host.applyConfig` 做编辑。编辑走下一节的视图回调；`updateConfig` 只在提供了写入回调的嵌入入口中使用。`dispatch` 是包的本地 API，写进说明不会使它成为 Agent 可调用的任意方法。

模型能力必须符合 `model-session@1`，通过宿主桥调用，不自行获取密钥或请求模型。文件、图片和项目资料使用宿主的本局资源控件；固定包资源用 v2 materials。当前动态包不能新增任意网络、文件写入、系统执行器或新的执行类 renderer/human；完整自绘节点与新增执行种类是两个概念。详见接口参考第 6、7 节。

## 6. 实现画布外观、编辑和业务入口

在 `createViews(services)` 中使用 `services.ui.react`，返回按 `插件ID/能力ID` 索引的 views，再由 entry 装配。不要打包第二份 React。先用 createElement 跑通；JSX 和 Hooks 需要正确的构建转接，已有转接文件不等于完整 React SDK。

每项独立遵循“有效自定义优先，未定义部分用默认实现”：

- `node(context)`：完整能力节点主体，包含业务形状和控件。未提供时保留默认卡片及 inline；settings 是设置区，inline 是默认卡片内附加区域。
- `onDoubleClick(context)`：本地非输入区域的双击处理，与完整视图独立。逻辑门在这里切换参数，普通内容的双击编辑使用 `canvas.contentEditing`。
- `policy.inputAnchors/outputAnchors`：按真实端口 ID 配置 side 和可选 offset。只改变几何位置，真实连接点由底座生成。
- `genericSettings / showStatus / showResult`：控制通用编辑和普通反馈，避免重复呈现。必要错误、等待和过期反馈仍保留。

具体装配见[事故树 views.ts](../examples/scene-packs/fault-tree/views.ts)。下面片段放入实际逻辑门视图项；services 来自 activate，gateType 必须先声明并公开：

```ts
onDoubleClick(context) {
  context.guard();
  if (!context.active || context.editable === false) return;
  const binding = context.node.bindings.gateType;
  if (binding?.kind !== 'literal' || !['AND', 'OR'].includes(String(binding.value)))
    throw new Error('门类型必须是 AND 或 OR 字面量');
  const source = services.editor.parameterSource(context.document, context.node.id, 'gateType');
  context.onInputChange('gateType', {
    kind: 'literal', value: binding.value === 'AND' ? 'OR' : 'AND'
  }, source.key);
}
```

修改单个能力参数用 `onInputChange(portId, binding, sourceKey)`，结构修改用 `onDocumentChange(document)`，均经过校验和历史记录。sourceKey 从当前输入来源取得，用于拒绝陈旧修改，不硬编码。控件尊重 active/editable，提交前 guard；异步返回后重新检查生命周期，不用旧闭包覆盖新场景。

输入框和按钮使用 `nodrag / nopan / nowheel` 等标记，防止编辑误拖画布；自管双击停止冒泡，避免一次手势切换两次。连接点由底座生成，不用 SVG 线条冒充数据连接。

主动执行入口在点击回调中先 guard，再调用 `context.execution?.run(targetNodeIds)`，按 enabled/running/status/error 呈现反馈及停止；不要在渲染或 effect 中执行。结果由独立展示块承接时，包的编排应包含所需结果节点，确保用户按钮和 Agent 明确执行都能看到结果。参考[提示词运行器](../src/interaction-packs/prompt-lab/runtime.ts)或[缩放视图](../examples/scene-packs/number-scale/views.ts)。底座没有通用运行面板兜底。

底座已有保存、返回清理、选中删除、撤销重做和导入导出，包无需另建按钮。资源选择优先嵌入收到的 resourceInput；临时状态用 context.state，不随场景保存。样式写入包内 CSS；加载器检查并隔离作用域。非法自定义有明确诊断，不等于未定义时的默认回退。

## 7. 装配入口，让 Agent 正确使用

entry.ts 只做装配。以复制后的缩放包为例，在已有 activate 返回对象中显式加入执行策略：

```ts
return {
  manifest: structuredClone(metadata.manifest),
  authoring: structuredClone(metadata.authoring),
  execution: 'on-demand',
  capabilities: [structuredClone(scalePlugin)],
  validate, createRuntime, executeLocal,
  views: createViews(services), help: structuredClone(scaleHelp)
};
```

这是装配片段，类型转换和 import 参照[可编译入口](../examples/scene-packs/number-scale/entry.ts)。activate 必须同步返回；模块导入和 activate 不能运行图、读取用户资料或调用模型。

新包始终声明 authoring。`components: []` 明确表示没有公开组件；省略整个目录才走旧兼容协议，不能利用省略字段开放内部实现。可以省略 describe，构建器会生成最小 agent.json；需要业务建议时再补完整说明，与真实声明同源维护。

让 Agent 会用的关键是：purpose 解释用途，字段/schema 写清取值和限制，端口说明写清数据含义，必要时 describe 补业务组合约束。比如解释事故树的输入集合和 AND/OR 语义，不让 Agent 根据图标猜类型。

底座按任务提供公开索引、字段规则、端口和必要正文，并校验 `addNode / setValues / removeNode / connect / disconnect / run / cancel` 动作。开发者无需另写 Agent 传输协议或第二套修改器。用户消息触发助手；自动响应由场景显式配置触发规则。普通编辑不自动请求模型，用户无需额外说“不运行”。样式、端口位置及双击代码留在本地包。

## 8. 核对兼容性，再构建和安装

不能只比较一个版本号，应分别核对：

1. **包格式**：v1 manifest 恰好七个字段；v2 另有 materials。execution、views、authoring 不塞进 manifest。
2. **S2 接口**：当前 `paradigm: 'S2'`、`paradigmApiVersion: 1`。本包协议尚未接入 S1/S4。
3. **包/能力/类型版本**：包版本为 `1.0.0` 形式的精确版本；能力插件和语义类型有各自版本。没有 latest、范围匹配或自动迁移。
4. **宿主服务和扩展**：requiredServices 当前只接受 execution/model/resources，不授予本局权限，尚无完整可选依赖及声明式降级协商。新增可选视图字段不保证老宿主识别，需在目标宿主实际加载验证。
5. **运行依赖和范围**：main.js 是单文件浏览器 ESM，不保留 Node、宿主源码或外部模块运行时 import。场景绑定一个主业务包并使用允许的共享能力，不任意拼装其他业务包。

修改后执行以下命令，路径应与实际 manifest 身份一致：

```powershell
node scripts/build-scene-pack-example.mjs --source examples/scene-packs/my-scale --out output/scene-pack-examples
npm run validate:scene-pack -- --dir output/scene-pack-examples/my-scale/1.0.0
npm run package:scene-pack -- output/scene-pack-examples/my-scale/1.0.0 output/my-scale-1.0.0.zip
```

版本目录必须有 manifest.json、main.js、styles.css、agent.json，CSS 可为空；构建器可能另加可选 package.json，v2 还需物料。共同交付限额按 manifest 8 KiB、main.js 512 KiB、CSS 64 KiB、桌面 agent.json 256 KiB 检查。验包会激活可信代码检查接口，但不执行场景；验包通过不等于业务正确运行。当前没有不可信包沙箱。

应用“导入 / 更新”安装新版本后，新场景可直接选择，无需重启。版本并存，旧场景引用旧版本。同版同内容可重复导入，同版不同内容不覆盖；发布修改升级包版本，能力契约变化还需升级能力版本。只重新构建不改变已安装副本。

手工复制安装目录或显式使用 replace:scene-pack 是开发维护路径，替换同版后需重启，不代替用户版本更新。构建和安装使用普通目录，不用符号链接或目录联接绕过文件边界检查。

## 9. 怎样判断已经开发完成

先检查代码与契约，再在完整应用逐项验收：

1. **加载搭建**：能选择包，菜单只公开预期类型，默认参数正确；新增、删除、改值、接线及历史可用。非法端口、类型和只读修改有明确错误。
2. **本地交互**：形状、双击及端口位置正确，输入不误拖节点，未自定义部分仍可使用默认实现。字段真正写入配置，不只改 DOM。
3. **执行策略**：仅编辑包无强制运行；按需执行包的自有入口能执行并展示结果。普通编辑不执行；重复点击、停止、失败及迟到回包行为正确。模型采用当前输入，失败不自动重试。
4. **Agent**：能解释实际配置，按对话添加/修改/接线，遵守字段规则，普通编辑不追加 run。明确执行时结果可见，未配置的事件不触发助手。
5. **保存复用**：工具栏“保存场景”后退出，重启完整应用，从“复用已有场景”打开。核对精确包引用、参数、内容、布局及连线；结果和授权不恢复。临时文件/图片重新选择，普通文本配置保留。
6. **版本清理**：新版不改变已保存旧版场景；缺少精确版本时保留原配置并报错。退出自动取消旧工作，无“先关闭助手/结束试验”前置流程。

本地逻辑可参考 check:scene-pack-example 或 check:scene-pack-fault-tree；自定义节点回归用 check:scene-s2-node-views、check:scene-s2-node-views-browser；Agent 边界用 check:scene-s2-interaction。这些是底座及已有示例的检查，不会自动替你的新包验证业务，仍需针对新包输入、输出和错误设计必要验证。

真实模型验收应明确测试资料和执行命令，记录调用、结果和限制；合成响应应标明合成，浏览器夹具不等于完整桌面应用。仓库提示词包真实模型命令为 `npm run check:scene-pack-prompt-live -- --execute`，会消耗当前配置模型的调用额度。

## 10. 遇到问题先查哪一层

- **安装后列表没有包**：确认安装成功、精确 id/version、普通目录，以及是否只改了构建副本。先看加载诊断，不删除整个安装目录。
- **加载后不能添加**：检查 authoring 和实际 implementation；只修改 describe 或菜单不开放组件。
- **字段显示但不能修改**：检查 parameters、schema、只读和 sourceKey。读取正文不等于取得字段规则。
- **连线没有数据**：检查真实端口、类型和基数；语义关联线与 SVG 线条不传类型化数据。
- **双击未保存**：检查提交回调、guard/sourceKey 和重复冒泡；不直接修改 context.node。
- **按钮没有结果**：检查执行策略、目标依赖、validate、模型/资源会话及结果节点；不增加通用运行面板掩盖缺失入口。
- **重开缺资料或旧结果**：按新会话重新选择/测试；若参数或连线丢失，再查保存的真实配置。
- **旧宿主拒绝字段**：核对实际支持的接口；当前没有自动降级，不改成忽略未知字段。

签名从[公共包类型](../src/types/sceneInteractionPack.ts)、[能力/产物类型](../src/types/sceneS2Plugin.ts)、[公开搭建格式](../src/services/scene/sceneS2PublicAuthoring.ts)查起；合法性见[包读取器](../src/services/scene/sceneInteractionPackProtocol.ts)和[公开目录读取器](../src/services/scene/scenePackAuthoringCatalog.ts)，详细约束见[接口参考](scene-s2-plugin-api-reference.md)。代码和读取器是可执行契约，指南片段不替代完整实现。

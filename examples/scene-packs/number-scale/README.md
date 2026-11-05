# 独立 S2 交互包示例：数值缩放

这个包将数值乘以正倍数，输出真正的 `core.number` 结果和可直接展示的 `core.text`。示例场景是 `4 × 2.5 → 结果：10`；通用内容块提供可编辑名称。没有提示词实验依赖、模型调用或文件读取。

首次开发请先按[开发指南](../../../docs/scene-s2-plugin-developer-guide.md)跑通本例，再按步骤复制并修改自己的包；本文件解释示例实现，完整字段和兼容规则见[接口参考](../../../docs/scene-s2-plugin-api-reference.md)。

## 源码约定

```text
number-scale/
  scene-pack.json              包清单 + 机器公开组件目录（无 Agent 手册）
  entry.ts                     仅组装并导出 activate
  plugins/scale.ts             能力声明、端口/类型、实际计算、产物返回
  runtime.ts                   业务配置校验、运行调度、dispatch、取消/关闭
  views.ts                     可选画布视图和显示名称/帮助元数据
  styles.css                   本包可视化样式
  sample.s2-workspace.json      使用本包的独立场景配置
```

- `scene-pack.json` 是身份和机器公开目录的单一来源：`manifest` 严格使用现有七个字段；`authoring` 使用接口版本1，显式公开 caption、scale、result 三种搭建类型。端口和参数直接映射本地已注册契约，不再重复写 schema。
- `entry.ts` 导出同步 `activate(services)`，装配同一 JSON 中的 `manifest/authoring` 和其余模块。本例省略 `describe()`：纯手动包无需先编写 builder、assistant、operations 手册，终端与构建工具生成最小归一化说明。
- `plugins/scale.ts` 声明本包插件的精确版本、输入输出和执行规则，实现 `executeLocal`。输入业务范围判断也在这里定义，由运行校验复用，避免两个入口的数值范围漂移。
- `runtime.ts` 实现业务 `validate`，通过注入的 Host 调度器运行实际图，管理本实例任务的取消和关闭。
- `views.ts` 实现 `settings` 视图和节点内“计算/停止”入口，以及端口显示名称和帮助文字。用户点击“计算”后通过公开 context 执行服务运行当前节点及已连接下游；显示视图不会执行或授权。
- `styles.css` 是包自己的样式。即使无需样式，也保留一个空文件。
- `sample.s2-workspace.json` 是可实际导入的场景配置，保留精确的包引用；它不是安装包入口。

这些模块只导入底座的公开 TypeScript 类型，不导入任何底座实现。源码按职责拆开，发布时仍构建为一个 `main.js`。

`activate` 只创建描述、处理函数和视图，不能自动运行、读取资料或请求模型。示例视图直接使用 `services.ui.react.createElement`，不导入或打包第二份 React。本示例不提供 JSX/Hooks 构建桥；需要这些能力时仍必须复用宿主 React，并自行适配。

## 如何映射到 S2 画布

1. 用户添加菜单与搭建 Agent 读取同一个 `authoring.components` 公开目录；公开类型为 caption、scale、result。纯手动搭建不要求先调用 Agent。
2. 用户或 Agent 使用公共配置中的 componentId、实例 ID、values 和 connections，选择组件、修改公开参数、连接公开端口；不用生成 pluginId/version/capabilityId。
3. 本地编译器把 caption 映射为 note/content 原生内容块，把 scale 映射为完整本地缩放能力，把 result 映射为共享文字展示能力；真实端口类型与 schema 从本地注册表读取。
4. 编译后的原生图仍使用 `bindings.label` 接 caption.content、amount/factor 为数字字面量、scale.text 连接 show.text；这些是本地实现和运行格式，不是另一套开放权限。
5. `runtime.run` 读取并校验最新配置，委托宿主按真实依赖运行；`executeLocal` 接收完整输入，产生数值 product 和文本 text 产物。编辑本身不运行。
6. 同一个本地修改校验覆盖用户、Agent、包视图及工作区导入；未公开参数或端口不能靠直接写 native JSON 来绕过。若开发者提供 authoring.internal，内部实际实例即使用相同组件类型也不能修改。

公开目录 `components: []` 表示没有可修改的公开块；不能回退全部 capabilities。旧包省略 authoring 才走明确的旧协议适配。完整公共配置例子与字段约定见[开发指南](../../../docs/scene-s2-plugin-developer-guide.md)。

本例使用 v1，固定文字或 JSON 常量可以内嵌代码。需要独立文件时参考 [material-study](../material-study/README.md)，使用 v2 materials 声明和包作用域读取，不向 v1 清单追加物料字段。

## 构建与验证

在仓库根目录、已安装开发依赖的环境执行：

```powershell
node scripts/build-scene-pack-example.mjs --source examples/scene-packs/number-scale --out output/scene-pack-examples
node scripts/run-tsx-safe.cjs --no-scene-pack-bootstrap scripts/check-scene-pack-example.ts
```

构建脚本也接受其他遵守相同源码约定的目录，导出 API 为 `buildScenePack({ sourceDir, outputRoot })`。省略 CLI 参数时构建本目录。产物为：

```text
output/scene-pack-examples/number-scale/1.0.0/
  manifest.json
  main.js
  agent.json
  styles.css
  package.json
```

脚本只读取纯 JSON 中的 manifest/authoring 生成 manifest.json 及最小归一化 agent.json；仍支持旧 manifest/description 约定。不会通过导入 entry.ts 获取元数据，不执行包的业务代码。工具进程把底座的纯协议读取器临时构建到内存，复用 `readSceneInteractionPackManifest` 和 `readScenePackDescription`，不另写一套协议规则，也不把这些读取器打入安装包。

构建检查清单/说明协议、单文件 ESM 的 `activate` 导出、文件限额，并拒绝将包目录之外的运行代码或依赖打入产物；公开类型导入会被擦除。构建通过不等于入口一定能够激活，仍须独立执行验包命令，检查真实加载、能力/schema、视图、业务校验和实际产物链路。

示例产物默认放在独立的 `output/scene-pack-examples/`，不进入正式终端的默认 seed/release 资源。推荐执行 `npm run package:scene-pack -- output/scene-pack-examples/number-scale/1.0.0 output/number-scale-1.0.0.zip`（输出 ZIP 必须是新文件），然后在桌面“S2 交互包 → 导入 / 更新”确认来源可信后导入，即可选择使用，无需重启。新版本必须使用新包版本号，旧场景保持原精确版本，运行中调用不会热换实现；没有版本范围匹配或自动迁移。开发时也可将整个 `number-scale/1.0.0/` 复制到目标终端数据根目录的 `scene-interaction-packs/` 下，再重启发现；不要覆盖其他包或已发布同版内容，能力契约变化还须升级能力版本。

在正式应用选择此已安装包，进入 S2 后导入 `sample.s2-workspace.json`，检查配置，直接点击缩放节点内的“计算”执行当前节点与已连接的展示节点；运行期间可点击“停止”。底座不提供通用运行面板或“开始试验”前置按钮。修改“结果名称”内容或数值参数后再次计算，会使用新的当前配置。工作区只保存配置和包引用，不携带安装代码、执行记录、预算或授权。

## 业务校验和运行

底座负责字段格式、类型、DAG、产物来源和只读内容约束。包的业务规则是 `amount ∈ [0,1000000]`、`factor ∈ (0,100]`、名称最多 80 字。

终端的交互包运行入口在排队前自动调用 `validate`；画布编辑和保存没有将它作为全局阻断钩子。本示例的 `createRuntime` 和每次 `run` 也显式自检，保证被其他嵌入宿主直接使用时仍遵守业务规则。运行前通过 `host.readConfig()` 读取最新配置，不保留第一次运行的旧快照。上游动态值还会在 `executeLocal` 中重新检查。结构合法但倍数为 0 的草稿可以被通用画布表示，终端运行入口以 `PACK_CONFIG_INVALID` 拒绝；直接调用本包运行实例时则以 `INVALID_CONFIG` 拒绝。

`executeLocal(call, inputs, signal)` 的 `inputs` 是已解析的端口值数组；`call.inputs` 仍是产物 ID。成功输出完整 artifact，使用新 ID、精确数据类型和本次调用的来源，失败输出空对象。示例只使用 inline 数据，不提供大文件句柄创建接口。

运行实例只允许取消自己尚未完成的任务，关闭后不可再运行，`dispose()` 可重复调用。当前正式画布通过视图的 `onDocumentChange/onInputChange` 编辑配置；正式运行入口没有 `applyConfig` 回调，示例保留的 `updateConfig` 仅供明确提供该回调的嵌入宿主使用。

## 当前边界

`operations` 是包 API 说明，不能让聊天 Agent 自动调用任意 `dispatch`；Agent 仍通过底座现有的修改提案和执行请求工作。简单说明视图不新增权限，也不自动运行。

清单声明 `requiredServices` 不等于授权。此包只新增纯本地处理能力，不能自行新增用户文件、网络或外部业务执行器。开发者内嵌数据、v2 包物料与用户会话文件资源分别处理。包是可信本地 JavaScript，不是安全沙箱。

验收脚本使用独立临时目录中的生产 Electron 存储实现、生产加载器和真实 S2 执行宿主，并检查业务拒绝、最新配置、保存重开和取消关闭。React 仅做静态渲染检查；不打开窗口，不联网，也不把它当作实际打包客户端跨设备验收。

# 带物料的最小场景包

这是独立开发者示例。默认终端和正式分发不安装它；构建产物只进入 `output/scene-pack-examples`。

## 哪个部分写什么

```text
material-study/
  scene-pack.json             清单、物料元数据、给 Agent 的用途/搭配/调用说明
  entry.ts                    仅组装 activate，不读取物料或运行场景
  plugins/study.ts            能力/端口声明、executeLocal、业务数据格式校验
  runtime.ts                  最新场景配置校验、调度、取消、实例释放
  views.ts                    宿主 React 视图、物料展示、URL lease 清理
  styles.css                  本包视图样式
  materials/scores.json       固定成绩数据
  materials/guide.txt         学习材料说明
  materials/legend.png        确定性 PNG 示例图例
  sample.s2-workspace.json    可保存、恢复的真实画布配置
```

源码约定仍为 `scene-pack.json = { manifest, description }`。构建器从这份 JSON 同源生成 `manifest.json` 和 `agent.json`，不导入或执行开发者入口。分发代码为一个浏览器 ESM `main.js`，只从公开类型导入类型，React 由宿主注入。

v1 的七个清单字段保持兼容；有独立物料时使用 `protocolVersion: 2`，在相同七字段之外增加 `materials`。每项只能声明 `id`、`label`、`path`、`mediaType`、`bytes`、`sha256`，本例声明 `scores`、`guide`、`legend`。路径必须在 `materials/` 下。允许 1–16 项，每项至多 1 MiB、合计至多 8 MiB；支持有效 UTF-8 `text/plain`、`application/json` 及 PNG/JPEG/WebP，完整大小、媒体签名和 SHA-256 均由统一协议校验。

修改物料后，在可信开发环境使用 SHA-256 工具更新清单的实际字节数和哈希。构建器只校验，不代替开发者静默改写源清单。

## 如何映射到画布

1. Agent 阅读 `description`，识别 `example-material-study@1.0.0/summarize` 的用途和真实端口。
2. 场景 JSON 声明这个能力与共享 `structured-view/text`，为 `factor` 配置数值 literal 或真实 `core.number` 上游。
3. 终端按外层 `interactionPack: {id, version}` 加载对应包，校验其完整物料后提供仅接受本包物料 ID 的服务。
4. 用户点击包视图中的“计算均分”后，终端调用业务 `validate`；运行程序读取最新配置，通过宿主调度当前节点及其已连接下游。运行期间包提供“停止”，错误在包视图反馈，不依赖底座通用运行面板。
5. 插件通过第四参数 `context?.materials?.read('scores')` 和 `read('guide')` 读取完整字节，自行解析本包业务数据，返回来源完整的数值与文本产物。
6. 视图通过 `props.materials.read` 读取数据并画图，通过 `openUrl('legend')` 获取图片 URL lease；卸载、作用域变化或异步读取取消时释放 lease。宿主负责 scope 生命周期，视图只释放自己的 lease。
7. `report → structured-view/text.text` 显示结果。场景保存只包含配置、数值、连线和包 ID/版本，不包含磁盘绝对路径、物料字节或临时 URL。

显示物料本身不会新增通用画布输入或用户资源。共享插件只能接收执行图显式传递的产物。包可以主动输出物料内容，因此 ID 作用域不是对可信包代码实施的内容保密沙箱。用户上传的本局资源仍走原有资源接口，不能拿包物料 ID 当作资源 ID。

## 构建与验收

在仓库根目录运行：

```powershell
node scripts/build-scene-pack-example.mjs --source examples/scene-packs/material-study --out output/scene-pack-examples
node scripts/run-tsx-safe.cjs --no-scene-pack-bootstrap scripts/validate-scene-pack.ts --dir output/scene-pack-examples/material-study/1.0.0
node scripts/run-tsx-safe.cjs --no-scene-pack-bootstrap scripts/check-scene-pack-material-example.ts
```

产物包括四个固定文件 `manifest.json`、`agent.json`、`main.js`、`styles.css`，本例另含用于 Node 工具识别 ESM 的 `package.json` 与 `materials/` 声明的三个文件。构建和验包都先检查路径、字节数、媒体格式及哈希；独立验包还会导入并激活可信入口以核对接口、Agent 说明与能力契约，**不会创建运行实例或执行场景**，也不会改写输入目录。它不是运行任意不可信代码的沙箱。

验收脚本使用隔离目录中的真实 Electron store 实现、生产 loader 和 S2 host，不打开可见窗口、不联网、不调用模型。它检查两个包相同物料 ID 读取不同数据、跨包 ID 拒绝、画布结果、保存恢复，以及无 DOM 的视图静态渲染和 URL lease 生命周期。验收临时文件位于工作区 `output/scene-pack-material-example-checks`，完成后安全清理。

推荐将完整 `material-study/1.0.0` 目录（包括声明的物料）用 `npm run package:scene-pack -- <版本目录> <新输出.zip>` 打包，通过桌面“S2 交互包 → 导入 / 更新”确认可信后导入，无需重启，再导入 `sample.s2-workspace.json`。手工复制整个版本目录到终端数据目录 `scene-interaction-packs/` 下是开发备选方式，需重启发现。更新采用新版本并存，不覆盖运行中旧版；恢复场景需要原精确版本，缺包时保留场景配置。

`operations` 仅说明包 API，不会自动给聊天 Agent 注册任意 `dispatch` 工具。编辑与保存允许存在业务草稿问题，运行前的业务校验和插件对已解析输入的检查各有职责。

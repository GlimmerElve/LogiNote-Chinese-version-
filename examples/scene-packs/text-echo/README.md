# 从零开发的最小 S2 包：文字回显

包身份为 `text-echo-demo@1.0.0`，只有一个公开组件 `echo`。用户添加“文字回显”，编辑最多2000字符的文字，点击“回显”，节点下方显示完整原文。空格、换行和标点不改写。包使用纯本地能力，没有模型、网络或资料依赖。

这是按[开发指南](../../../docs/scene-s2-plugin-developer-guide.md)从新目录编写的包。完整桌面验收使用现有 LogiNote.exe，没有重建或修改底座，没有替换 IPC、存储或安装对话框。

## 文件各自做什么

```text
text-echo/
  scene-pack.json        七字段 manifest、on-demand 策略、一个公开组件
  entry.ts               同步 activate，只装配
  plugins/echo.ts        一个受限文字类型、echo 能力及 executeLocal
  runtime.ts             当前配置校验、host.run、所属任务取消和 dispose
  views.ts               用宿主 React 绘制输入框和回显按钮
  styles.css             输入区的简单布局
  sample.public-canvas.json  一个节点的公开搭建配置
  sample.s2-workspace.json   可在画布“更多”中导入的工作区
  sample.pack-config.json   供验包工具 --scene 使用的本地配置
```

自有能力插件 ID 是 `text-echo-demo-logic`，因此自定义类型必须命名为 `text-echo-demo-logic.text`。只用包 ID 命名会在激活验包时得到 `PACK_CONTRACT_CAPABILITY`。这条在从零开发时发现的指南缺项已补入主指南及接口参考。

`authoring.parameters` 公开文字参数，`inputs: []` 表示本最小组件没有公开接线输入；两者互不代替。能力仍有真实输入契约，由宿主解析字面量后交给 executeLocal。输出使用共享 `core.text`，直接复用底座的节点结果展示。

视图通过 guard、当前来源 key 和 onInputChange 保存文字；“回显”按钮调用本节点的 execution.run。普通编辑不执行，运行器每次读 host.readConfig 获取当前文字。成功输出含本次调用来源的完整 artifact，取消和非法输入没有成功产物。

仅类型导入指向公开底座类型，运行时代码全部在包目录内。构建产物为单文件浏览器 ESM，React 使用宿主注入实例；agent.json 由公开目录生成，无需另写 Agent 手册。

## 按指南构建、验包、打包

在仓库根目录运行：

```powershell
node scripts/build-scene-pack-example.mjs --source examples/scene-packs/text-echo --out output/text-echo-acceptance/packages
node scripts/run-tsx-safe.cjs --no-scene-pack-bootstrap scripts/check-scene-pack-text-echo.ts
npx tsc --noEmit -p scripts/tsconfig.scene-text-echo.json
npm run validate:scene-pack -- --dir output/text-echo-acceptance/packages/text-echo-demo/1.0.0 --scene examples/scene-packs/text-echo/sample.pack-config.json
npm run package:scene-pack -- output/text-echo-acceptance/packages/text-echo-demo/1.0.0 output/text-echo-acceptance/text-echo-demo-1.0.0.zip
```

打包不覆盖已有 ZIP；再次运行时换输出文件名。发布修改时升级包版本，不覆盖已安装的同版文件。本地检查会从真实构建产物生成两个示例原生配置，并验证默认值、最新值、完整原文、保存重开、非法长度和取消；不读用户资料，不联网。

## 安装和使用

1. 打开完整桌面应用，进入“学习 → 场景模拟”，填写场景名并选“通用画布（试验）”。
2. 在“S2 交互包 → 导入 / 更新”选择生成的 ZIP，核对名称“文字回显示例”和版本，信任并安装。无需重启即可在下拉框选择。
3. 选择“自定义场景”进入空白画布，点击“添加 → 文字回显”。本次实际验收从空白画布添加，没有导入预制场景。
4. 编辑文字，点击“回显”，在同一节点下方阅读原文。
5. 点击工具栏“保存场景”，返回并关闭应用。重开后从“复用已有场景”选择保存项；文字保留，旧结果为空。再点回显即产生本局结果，仍可继续编辑。

## 已完成的真实验收

2026-10-28 已通过原生 ZIP 选择与信任确认完成安装，实际安装四文件与构建产物逐个哈希一致。从空白画布添加一个节点后，输入并回显多行文字，保存至真实场景库；重启完整应用，再从场景库选中该场景，核对参数保留、旧结果不恢复、再次执行和继续编辑均成功。

安装包已留在当前应用中，场景库保留“从零验收-文字回显-1028”。只新增这一个验收场景，原有场景文件内容不变；验收前后完整应用 app.asar 哈希一致。

报告和六张操作截图在 `output/text-echo-acceptance/`，`logic-report.json` 为离线逻辑检查，`desktop-report.json` 为完整应用验收。桌面自动化入口是 `node scripts/run-text-echo-desktop.mjs --execute`，使用真实 Electron 页面、原生安装对话框和现有应用数据；它是首次安装验收，要求此前未安装该精确版本，且会新增上述验收场景。已安装后的正常使用无需再运行该脚本。

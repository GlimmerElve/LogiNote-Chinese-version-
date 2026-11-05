# S2 包内物料协议 v2

实现核对：2026-10-26。本协议在原有 S2 画布和交互包接口上增加独立文件物料；画布范式接口仍为 paradigmApiVersion 1。没有物料的旧 v1 包继续按原七字段加载，不需要迁移提示词实验。

## 职责与文件组织

物料是单独的资源部分，不放入 Agent 说明或运行程序中冒充代码。参考 [material-study](../examples/scene-packs/material-study/README.md)：

```text
material-study/
  scene-pack.json         manifest：身份和物料声明；description：Agent 使用说明
  entry.ts                装配入口
  plugins/study.ts        能力声明、数据业务解释及 executeLocal
  runtime.ts              场景业务校验、调度与会话生命周期
  views.ts                物料的图表、说明和图片展示
  materials/              随包迁移的固定文件
  sample.s2-workspace.json 场景配置与精确包引用
```

终端负责文件定位、精确版本范围、完整性校验、读取作用域及展示引用释放。包负责文件的业务意义、解析、计算和可视化。S2 不新增“成绩”“截图”“数学物料”等专用块；现有节点视图槽位和类型化执行端口足以承载这些业务。

Agent 读取 describe 返回的用途、物料 ID 用法、组件组合及配置示例。开发者应在说明中明确哪些插件使用哪些固定物料。Agent 生成场景配置，不生成文件读取代码、磁盘路径或 Blob URL；本轮没有给聊天 Agent 新增任意物料读取工具。

## 清单与兼容性

v2 必须且只能含原七字段及 materials：protocolVersion、id、version、name、paradigm、paradigmApiVersion、requiredServices、materials。其中 protocolVersion 为 2，paradigm 为 S2，paradigmApiVersion 仍为 1。完整清单 UTF-8 不超过 8192 字节。

materials 是 1–16 项的数组，每项恰好包含：

- id：本包内的小写字母开头标识，允许数字和连字符，最多 64 字符。
- label：供展示的非空名称，最多 80 字符。
- path：相对当前精确版本目录、位于 materials/ 下的 ASCII 文件路径。
- mediaType：text/plain、application/json、image/png、image/jpeg 或 image/webp。
- bytes：实际完整字节数，1–1048576；全部物料合计不超过 8388608 字节。
- sha256：实际内容的 64 位十六进制 SHA-256，大小写等值。

ID 不重复；路径不区分大小写去重。路径拒绝绝对路径、点段、父目录、反斜杠、编码、查询、片段、尾随点及 Windows 设备保留名称。扩展名中的普通点可以使用。

完整有效示例见 [scene-pack.json](../examples/scene-packs/material-study/scene-pack.json)。修改文件后由开发者更新实际 bytes 和 sha256；构建器校验并拒绝不一致，不静默改写源声明。Windows 开发环境可使用 Get-Item 的 Length 和 Get-FileHash -Algorithm SHA256 取得真实值。

本轮支持文本、JSON 与三种静态图片，不支持 HTML、脚本、SVG、PDF、字体、任意 URL 或大文件句柄。文件内容校验包含大小、摘要、UTF-8/JSON 语法及图片签名；它不验证业务数据意义，也不替代浏览器的完整图像解码。

新终端同时识别 v1/v2。旧终端对 protocolVersion 2 清楚拒绝，不会把新字段当作 v1 可忽略字段。v2 缺物料服务或任何声明文件无效时拒绝加载，不静默回退；可选依赖和声明式降级仍不属于本轮协议。

## 统一读取接口

ScenePackMaterialScope 只有当前包的物料 ID，没有另一个包的 ID/version 参数：

```ts
list(): ScenePackMaterialDescriptor[];
read(id: string, signal?: AbortSignal): Promise<{
  id: string;
  mediaType: ScenePackMaterialMediaType;
  data: Uint8Array;
}>;
openUrl(id: string, signal?: AbortSignal): Promise<{
  url: string;
  release(): void;
}>;
dispose(): void;
```

read 返回完整、独立的字节数组；包自行解释文本、JSON 或业务数据。openUrl 返回有界的本局展示引用，不能保存进场景配置或当作可迁移物料 ID。

接口出现在三个明确位置：

1. executeLocal(call, inputs, signal, context?) 的第四参数 context.materials：一次节点调用的物料作用域。
2. createRuntime(config, host) 的 host.materials：运行实例作用域。
3. 视图 props.materials：当前画布场景、阶段、节点和视图槽位的作用域；materialScopeKey 是宿主生命周期标识。

v1 的旧三参数 executeLocal 保持原调用方式，这些新增字段均为可选类型。v2 开发者应显式检查服务存在，再按说明使用固定 ID；缺服务应给出错误，不尝试自行读取路径。activate 不读取物料、不运行场景，只装配声明和实现。

```ts
if (!context?.materials) throw new Error('物料服务不可用');
const file = await context.materials.read('scores', signal);
const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.data));
// 再执行本包的数据格式和业务范围校验，返回正常的 S2 产物。
```

## 生命周期

节点调用的作用域在完成、失败或取消时自动释放。运行实例作用域随宿主关闭而释放，即使包自身 dispose 忘记调用 host.close，底座仍会收回服务。

视图作用域由宿主创建，随场景/阶段或槽位变化、关闭和卸载释放。React StrictMode 重放不会复用已关闭作用域。包视图只释放自己 openUrl 得到的 lease，不主动 dispose 宿主管理的共享作用域。

release 和 dispose 均幂等。取消或关闭后，尚未完成的读取立即拒绝；底层 IPC 可能仍完成文件读取，但迟到结果不会交给已关闭调用，也不会创建新 URL。包被目录发现标记为不可用时，已有作用域和 URL 会被收回；异步预校验不能重新发布已撤回的包。

## 如何进入画布

加载顺序为：清单与文件校验 → 激活并校验包接口 → 注册能力/物料服务/视图 → 根据场景配置显示节点。物料预校验不会自动执行图。

material-study 的视图读取 JSON 和说明，在通用节点视图内绘制柱状图，以 openUrl 显示 PNG 图例。用户请求运行时，summarize 能力从同一固定 JSON 计算均分，返回 core.number 和 core.text；执行图将 text 连接到共享 structured-view/text 展示。业务计算、图表和物料含义均由示例包实现。

保存或导出只保留原有工作区版本、节点配置和精确包引用，不复制物料字节、绝对路径、Blob URL、运行记录或授权。转移到另一终端时，同时复制完整的包版本目录和场景配置。缺包时保留配置并提示安装相同版本。

物料 ID 不是用户本局选择的资源 ID，也不自动注册成所有包可用的画布输入。读取服务绑定所属包；包若主动将内容写入普通节点或产物，之后按通用数据规则处理。当前包运行于可信 JavaScript 环境，作用域接口不是恶意代码隔离或内容保密 ACL。

## 开发与验收

```powershell
npm run build:scene-pack-material-example
npm run validate:scene-pack -- --dir output/scene-pack-examples/material-study/1.0.0
npm run check:scene-pack-materials
npm run check:scene-pack-material-browser
```

构建器复制且仅复制声明物料，包内运行代码仍合成单文件 ESM。CLI 和底座复用相同的纯协议读取器及完整性规则，输入目录不被改写。示例产物在独立开发目录，不进入默认种子或正式包清单。

代码入口：[公开类型](../src/types/sceneInteractionPack.ts)、[纯物料协议](../src/services/scene/sceneInteractionPackMaterialProtocol.ts)、[宿主作用域](../src/services/scene/sceneInteractionPackMaterials.ts)。业务开发者参考示例，不能把宿主内部文件系统、provider 注册表或调度实现打入自己的包。

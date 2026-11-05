# LogiNote 多端协同：开源与成熟项目参考

核查日期：2026-10-30。仅引用项目官方文档、官方代码仓库与许可文件。本文件是技术选型依据，没有集成下列项目的运行时代码，也不表示 LogiNote 已实现云同步、端到端加密或移动 App 发布。

## 结论与推荐组合

推荐先保留 LogiNote 的 Electron、React、TypeScript 与本地 Markdown 资料库，新增独立移动 UI，并把可共享的业务规则抽成核心模块。移动端候选采用 **React + Capacitor**；同步采用 **本地保存、增量拉取、操作队列上行、服务端版本校验** 的模型。产品分工仍由 LogiNote 的需求决定，不照搬参考项目的长文编辑器。

这套组合分别借鉴：

- **Notesnook**：多平台共享业务与加密内核，各端有独立客户端。
- **Joplin**：本地优先、同步器与传输目标分层、明确保留冲突版本。
- **RxDB**：带检查点的批量 pull、带已知服务端基线的 push、断线重连与冲突处理。
- **SiYuan**：结构化知识库使用应用层同步，避免把运行中的完整数据目录交给普通网盘同步。
- **Capacitor**：复用 Web 技术与 React 资产，通过原生适配层接录音、键盘、存储等能力。

上述是基于现有工程的设计判断。具体是否引入 RxDB，需先完成下文的同步技术验证；不能把阅读了协议等同于依赖已选定或同步问题已解决。

## 1. Joplin：同步分层与冲突保全

### 已验证的实践

Joplin 明确采用 offline-first：先保存本地，再上传或下载笔记、标签、资源及删除。同步器与同步目标、文件 API 驱动分离；官方源码说明列出 `Synchronizer.ts`、`SyncTarget*.ts` 和 `file-api-driver-*`，适合参考其责任划分。[同步规范](https://joplinapp.org/help/dev/spec/sync/)

当两处修改产生冲突时，Joplin 会保留本地内容的冲突副本，供用户比较和恢复。[冲突处理](https://joplinapp.org/help/apps/conflict/)

### LogiNote 借鉴方式

- 把 `PrivateSyncEngine`、`PrivateSyncTransport`、`DesktopVaultAdapter`、`MobileCacheAdapter` 分开；同步器不直接操作 React 状态或 Markdown 文件。
- 先落本地并标记“待上传”，收到服务器回执后再显示“云端已接收”；桌面应用事件后另有“桌面已归档”回执。
- 对计划基线冲突保留双方草案及来源版本，提示用户复核；移动端不执行长文正文覆盖，从产品边界减少冲突。
- 初版仅实现一个私有同步后端，不同时提供 WebDAV、S3、网盘等多种驱动。保留传输抽象，不复制 Joplin 的全部兼容成本。

### 许可与采用边界

Joplin 根目录默认为 **AGPL-3.0-or-later**，子目录有独立许可时以子目录为准。[根许可](https://github.com/laurent22/joplin/blob/dev/LICENSE)

**Joplin Server 是独立的个人使用许可**，文本限制商业用途，不能仅因客户端开源就将其当作可直接用于 LogiNote 商业服务的通用后端。此阶段仅借鉴架构；如将来要复制源码或部署服务，需核对具体版本与对应许可。[Server 许可](https://github.com/laurent22/joplin/blob/dev/packages/server/LICENSE.md)

## 2. Notesnook：共享核心、多端 UI 与隐私设计

### 已验证的实践

官方仓库明确划分 `apps/web`、`apps/desktop`、`apps/mobile`，其中移动端覆盖 Android/iOS，另有跨平台共享的 `packages/core` 与 `packages/crypto`。客户端仓库为 **GPL-3.0**。[仓库与包结构](https://github.com/streetwriters/notesnook)

Notesnook 的同步说明将本地优先与上传前加密结合：服务端搬运密文，各端本地解密。[同步与加密说明](https://notesnook.com/help/sync/how-sync-works)

其同步服务端为 **AGPLv3**，基于 .NET，Docker 部署还包含 MongoDB、对象存储及多个服务。官方仓库仍标示 self-hosting alpha，并说明自托管暂无支持。[服务端仓库与部署](https://github.com/streetwriters/notesnook-sync-server)

### LogiNote 借鉴方式

- 后续建议抽取 `packages/learning-core`、`packages/private-sync-contracts`、`packages/community-client`；桌面与移动端各自消费，不让手机加载桌面 `App.tsx`。
- 共享的是来源 ID、简测协议、计划规则、数据校验、同步契约；桌面富文本、场景运行与本机 Python 语音识别不直接进入移动包。
- 账号/资料库/设备范围必须进入本地缓存和队列键；切换账号不得继承上一账号的未提交请求。
- 私人认知、复述、学习证据和社交公开资料分属不同数据域，分享必须是明确的用户动作。

### 暂缓项

不整体移植 Notesnook 客户端与服务端：现有数据模型和运行栈不兼容，许可也不能默认视同本仓库的 MIT。E2EE 需要设备授权、密钥恢复、附件加密、索引位置和多端一致性一起设计；“HTTPS + 服务端加密存储”不能称为 E2EE。

若启用严格 E2EE，云端无法直接对私人明文运行语义推荐或 AI 评测。优先在设备上读取/检索，或将一次性模型处理作为用户明确授权的独立操作，不把同步授权等同于向模型发送内容。

## 3. SiYuan：应用同步优于目录镜像

### 已验证的实践

SiYuan 是本地优先知识工作区，提供 Android/iOS 客户端和独立数据仓库组件；主仓库为 **AGPL-3.0**。官方 FAQ 明确不支持直接通过第三方同步盘同步工作数据，否则可能损坏数据；与连接第三方云存储的应用功能不同。[官方仓库、架构与 FAQ](https://github.com/siyuan-note/siyuan)

### LogiNote 借鉴方式

- 不把 `vault/`、`user-state/`、`rag-index/` 的目录镜像当成在线多端协同。
- 保留 Markdown 为桌面资料来源；由桌面存储服务生成有版本的移动可读投影，不把索引文件、模型密钥或绝对路径发送到手机。
- 手机回传复述、答题及计划操作，由桌面现有写入服务归档；同步器不得绕开本地文件锁和保存基线。
- 数据导出、备份和同步是三种能力：备份可恢复历史，同步负责设备收敛，两者不能互相替代。

不移植 SiYuan 的块编辑器、数据格式或 Go 内核；LogiNote 本阶段的移动端重点是阅读与短输入。

## 4. Capacitor：现有 React 工程的移动原生壳候选

### 已验证的实践

Capacitor 支持使用 Web 技术构建 iOS、Android 和 PWA，可加入已有 Web 应用，通过插件或原生代码接平台能力；核心仓库为 **MIT**。[官方介绍](https://capacitorjs.com/)、[许可](https://github.com/ionic-team/capacitor/blob/main/LICENSE)

### LogiNote 借鉴方式

- 先完成不依赖 Electron 的独立 React 移动入口，验证信息架构，再加入 Capacitor 原生工程。
- 平台适配层统一提供录音、系统权限、键盘、安全区、文件存储和安全凭据；不把桌面 Python STT 的 localhost 地址带到手机。
- Android 与 iOS 各自验收返回手势/返回键、键盘遮挡、麦克风授权、离线恢复及后台暂停后的队列恢复。
- 选 Capacitor 是因为现有 React/TypeScript 资产与移动端轻交互需求，属于工程取舍。它不会自动提供数据同步、推送、E2EE、原生级性能或商店审核通过保证。

具体运行时版本、系统最低版本与插件组合留待技术验证后锁定；本次不安装依赖，也不声称产生 APK/IPA。

## 5. RxDB：最值得做小范围验证的同步库

### 已验证的实践

RxDB 的复制协议允许后端使用自有 HTTP/GraphQL 服务，包含基于 checkpoint 的拉取、携带 `assumedMasterState` 与 `newForkState` 的上行、冲突状态返回及断线恢复。删除采用可传递的删除标记；不能直接硬删除而让离线设备失去删除事件。[复制协议](https://rxdb.info/replication.html)

核心为 **Apache-2.0**，但 SQLite/OPFS 等存储及生产加密、全文检索等功能存在商业插件档位，不能将“核心开源”推广成“全部生产能力免费”。具体插件与版本需逐项核对。[官方仓库](https://github.com/pubkey/rxdb)、[插件与许可档位](https://rxdb.info/premium/)

### 两条可行路径

**优先验证 RxDB 核心 + 自有私有同步 API**：先用免费存储完成浏览器原型级技术验证；原生端再评估存储适配、加密、包体与商业插件成本。仅同步移动阅读投影和独立活动集合，不迁移桌面全部持久化。

**备选为窄范围自有同步器**：客户端使用 IndexedDB/SQLite 存阅读缓存、outbox 与 cursor，服务端提供批量 changes/operations API；协议借鉴 RxDB 的检查点与基线冲突模型。适合数据类型少、写入边界窄的第一版，但所有重试、重复投递、跨端竞态与迁移仍须自己测试。

二者共用 LogiNote 的领域命令，不能让同步库决定“答过即掌握”“完成一个任务就重排所有计划”等业务含义。采用任一路径前，需用同一组用例比较复杂度与正确性，不凭演示决定。

### 进入正式开发前的验证门槛

1. 两台设备离线，各自新增复述，恢复后均保留且不重复；稳定事件 ID 的重放结果一致。
2. 服务器已提交但响应丢失，客户端重试不创建第二条活动。
3. 手机基于旧计划改期，服务端返回冲突而非覆盖新计划；用户可重新预览。
4. 桌面删除来源后，离线手机上行活动不复活来源，活动本身可保留为待关联记录。
5. 分页拉取中断、并发更新、删除墓碑、游标过期均不漏数据；旧游标转完整重建时保留未回执 outbox。
6. 切换账号、撤销设备、服务端拒绝、空间不足与本地保存失败，均保持明确的状态边界。
7. 模拟一万条移动投影的首轮同步和本地搜索，记录设备、数据体积、耗时、内存及失败恢复结果。性能目标需根据真机结果再制定。

## 6. PowerSync：服务端复制路线备选

PowerSync 客户端 SDK 为 **Apache-2.0**；服务端与 CLI 使用 **FSL**，官方将其称为 source-available。自托管 Open Edition 与商业版本的范围不同，不应统一标成完全开源或默认永久免费。[官方许可总览](https://powersync.com/legal/licensing-terms)、[开源与源码可用包](https://powersync.com/open-source)

其客户端有上传队列，但上行仍须由开发者后端实现；后端负责幂等和冲突裁决。最简接法可能形成最后写入胜出，不能直接用于 LogiNote 计划版本、学习证据与认知记录。[官方写入冲突说明](https://github.com/powersync-ja/powersync-docs/blob/main/handling-writes/handling-update-conflicts.mdx)

当私有云数据已成为稳定的关系型数据源、需要按用户选择性下发大量结构化记录，并愿意承担额外服务、运维与许可边界时，可以再评估 PowerSync。当前桌面 Markdown 为主、领域写入尚需整理，不建议第一阶段直接引入整套数据库复制服务。

## 7. Yjs：保留给未来共同编辑

Yjs 是 MIT 的 CRDT 框架，提供共享类型和编辑器集成，网络传输与持久化可以分别接入。[官方仓库](https://github.com/yjs/yjs)、[官方文档](https://docs.yjs.dev/)

LogiNote 当前移动范围不要求多人同时改同一篇长文，主要写入是新增活动和明确的计划命令，因此暂不引入整库 CRDT。未来只有确认“多人同时编辑同一文档/白板”场景后，再针对该对象引入 Yjs，并另设权限、历史、附件与版本迁移边界。自动合并文本不等于自动合并计划语义、题目评价或个人认知。

## 本阶段落实边界

本阶段产物是产品方案、同步架构与隔离演示原型；以上是正式实现的参考清单。

- 可以立即落实：独立移动 UI、共享契约设计、操作回执状态、离线/冲突交互、模拟数据上的流程验收。
- 下一阶段先做：RxDB 与窄自有同步器的同用例验证、私有账号/资料库权限、桌面投影、事件幂等落库。
- 后续再做：Capacitor 真机工程、原生录音、凭据安全存储、E2EE 密钥方案、通知和应用商店交付。
- 引入第三方代码前固定版本与许可证；架构参考、调用独立服务、复制代码、分发衍生客户端是不同采用方式，不在本文件中混为一个许可结论。

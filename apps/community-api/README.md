# 社区服务 · 阶段 2

独立的 Node.js／TypeScript／PostgreSQL 服务，API 前缀 `/api/community/v1`。它与本地学习资料、旧展示站账号及社区合成人物保持独立，不自动读取或迁移它们。

2026-10-24，用户确定改用 **CloudBase 托管账号认证**。本机上海环境已通过真实发码、验证码验证、注册和社区会话建立，用户自行完成验证与密码输入；独立密码登录、重置、刷新和 CAPTCHA 联调仍待外部验收。社区业务仍通过本服务和 PostgreSQL 管理，正式部署继续采用阿里云 ECS。见 [CloudBase 接入记录](../../docs/artifacts/community/phase-2/cloudbase/README.md)。

## 启动

需要 Node.js 22.18+、PostgreSQL 18。使用专属社区数据库；数据库不应对公网开放。不要把旧展示站或私人笔记数据库填到这里。

在本目录安装依赖，将 `.env.example` 复制为本机 `.env`，配置 `COMMUNITY_DATABASE_URL`、32 字节随机 `COMMUNITY_ENCRYPTION_KEY`、网站 Origin，以及 `COMMUNITY_CLOUDBASE_ENV_ID`。密钥仅填本地配置，勿写入仓库或聊天；需要单独安全备份，丢失会影响管理员 MFA、服务端托管登录凭据和待上传授权。

`COMMUNITY_AUTH_PROVIDER` 默认 `cloudbase`；`COMMUNITY_CLOUDBASE_REGION` 默认 `ap-shanghai`，需与实际环境一致。当前公共认证 REST 只需要环境 ID 与地域，不需要发布密钥、腾讯云 SecretId／SecretKey，也不在浏览器引入 CloudBase SDK。尚未提供环境 ID 时，账号服务明确返回未配置，不自动切换本地账号服务，也不重用旧展示站配置。

认证采用官方公共 HTTP API：上海、广州使用 `https://{env}.api.tcloudbasegateway.com`，新加坡使用 `https://{env}.api.intl.tcloudbasegateway.com`；未知地域明确拒绝。邮箱发码只提交 `email` 与 `target`，不混入 SDK 的 `usage` 参数。注册 ANY，找回与条件登录验证 USER；用途约束仍由 BFF 的独立挑战记录校验。

```powershell
npm ci
npm run migrate
npm run dev
```

默认 API 只监听 `127.0.0.1:5180`。另启动 `apps/community-web`，在网站专用 `.env.local` 中显式设置 `VITE_COMMUNITY_API_URL=http://127.0.0.1:5180/api/community/v1` 后重新启动 Vite。未设置时继续使用独立的交互原型，不会把演示人物当作真实账号。

当前机器已创建专用开发数据库集群 `.ui-preview/community-local/pgdata`（仅 `127.0.0.1:55433`），社区业务库为 `loginote_community`，使用独立非超级用户 `community_app`；不使用既有 Windows 数据库服务或阶段 2 合成测试库。真实配置保存在 ignored `apps/community-api/.env` 与 `apps/community-web/.env.local`，不保存用户提供的匿名访问令牌。双击根目录“启动社区网站.bat”或从根运行 `node --require ./scripts/node-os-userinfo-fallback.cjs scripts/start-community-local.mjs` 可启动本机数据库、API 与网页。API／网页日志位于 ignored `.ui-preview/community-local`；这不是正式阿里云部署。

网站入口：`#/account` 为注册、验证、登录、退出、找回、管理员验证；`#/feedback` 为反馈及工单；`#/admin` 为真实治理后台。显式启用服务模式后，全站不读取合成记录；公共动态、资源市场、个人数据、私信、共学群及资讯使用真实服务。

```powershell
npm run check
npm run build
npm start
```

构建会把 SQL 迁移一并复制到 `dist/migrations`。开发和生产启动都校验迁移校验和；修改已经应用的 SQL 会拒绝启动，应新增迁移。

## 真实内容与个人关系（2026-10-24）

正文与关系分开存储：community_entries 关联 protected_objects 的作者、范围及治理状态；account_bookmarks、account_learning_resources、account_follows 分别保存账号自己的关系；account_content_drafts 保存本人草稿及发布范围。community_comments 继承原帖访问范围，稳定序号保证同一时间的回应仍按提交顺序显示。学习人数是关系聚合值，个人收藏及加入状态只返回给对应账号。

- GET /entries：公共／关注／本人／参与／收藏／学习列表；关键词、话题、作者、资源形式先于分页，默认每页 3 条。
- POST /entries，GET／PUT／DELETE /entries/:id，以及 POST /entries/:id/restore：发布、读取、本人编辑、撤回及恢复。
- GET／POST /entries/:id/comments：原帖回应和互相回复；不能跨帖回复，失去原帖权限后不能读取评论。
- PUT /entries/:id/bookmark 或 learning：修改当前账号的私人关系，不能指定目标账号。
- GET /people、GET /people/:id、PUT /people/:id/follow：公开字段、找同好和当前账号关注；following=true 只返回本人的关注集合。
- GET／PUT /me/drafts/post 或 resource：私人草稿；发布事务只清除发布者对应草稿。

所有内容写入沿用 Cookie、Origin、CSRF、写入能力和幂等验证。作者与个人关系的 account_id 来自服务端会话；不接受前端 ownerId／角色。搜索、评论和个人保存列表复用访问范围与治理限制，成员离群后收藏不授予继续读取权限。所有响应 no-store。网站退出或切换账号时卸载旧账号视图，中止旧读取；草稿写入额外核对预期账号，避免迟到保存写给新账号。

本机 API 自动应用迁移，无内容时返回空集合。上述为最初数据归属接入的契约；后续已接入群、私信、资讯、头像和正文图片／附件传输，以及桌面接收与导入，分别见阶段 3—6 的验收记录。部署环境仍须显式配置上传和下载额度。接口与浏览器验收见 [数据归属接入记录](../../docs/artifacts/community/phase-2/data-ownership/README.md)。

## 资讯投稿与人工审核（2026-10-25）

迁移 020 接入真实稿件、固定审核版本及正文插图。`GET /news` 提供资讯／官方／本人／待审列表；`POST /news/drafts` 与 `PUT /news/:id/draft` 保存私人草稿，`POST /news/:id/submit` 提交，`POST /news/:id/withdraw` 撤回。`GET /news/:id` 只返回已审核公开版；作者读取 `/draft`，平台管理员经 MFA 后读取和操作 `/review`。审核操作校验版本及幂等键，通用动态和文件入口不能绕过发布审核。公开版本继续复用评论、收藏和治理范围。

网站入口 `#/news`、`#/news/write`、`#/news/mine`、`#/news/queue`；投稿、官方文章和公告共用富文本编辑器，可排版、插图和粘贴截图。来源收录仅抓取固定允许的 RSS，不按用户提供的 URL 抓取网站；AI 摘要与日报保持关闭。详细操作、权限和隔离验证见 [阶段 6 记录](../../docs/artifacts/community/phase-6/README.md)。

### RSS 来源与调度

平台管理员通过本次 MFA 后，在资讯审核管理进入「资讯来源」`#/news/sources`。迁移 022 预置 8 个来源，全部默认关闭；前 6 个为首批建议来源，开源中国和 IT之家为备选。启用或修改间隔需要当前版本；手动收录显示本次结果，刷新后仍可查看最近执行结果。来源启用时记录授权管理员，后台每轮重新确认其当前数据库角色，降权后不继续采集。

采集复用 API 进程，启动及以后每小时检查到期来源，每轮最多两个来源，每源最多新增 10 条候选。默认间隔 360 分钟，最短 60 分钟；`nextCheckAt` 表示最早可执行时间，实际等待下一轮检查。失败退避、暂停、并发租约及重启均不产生重复公开内容。缓存批次先排空再请求原站，避免条件请求返回 304 时丢失未处理条目。

只保存原站标题、有限摘要、原文链接与原文日期，不转载全文、不抓正文或远程图片。候选进入私密待审队列，人工核对并通过才进入公开资讯；来源收录快照不能伪装为作者投稿修改。原文 URL 跨来源去重，来源内 GUID 单独去重；否决或下架的记录保留去重标记。来源失败不影响人工投稿及编辑。

每日预算为 UTC 日 60 次外部 HTTP 请求、32 MiB 响应体；单个订阅响应不超过 2 MiB，15 秒超时，只允许预设主机内最多两次跳转。预算在请求前原子预留，重定向与可选 HTTPS DNS 请求均计入。达到阈值停止新增请求；这只计响应体，不包含 TLS／HTTP 头部等开销，不能当作云账单或永久免费承诺。不启用付费模型调用。

`COMMUNITY_RSS_DNS=system` 为默认值。若所在机器的代理 DNS 把原站解析为私网或 198.18.0.0/15 等保留地址，服务会拒绝访问。可显式设为 `alidns`，仅为固定 RSS 域名使用无账号参数的 AliDNS HTTPS 查询，保留 TLS、公共地址验证与预算；不改变系统 DNS、代理或其他业务访问。本机因上述 DNS 情况启用了此选项；正式服务器应独立验证网络与供应方政策，不默认沿用本机结果。

### 治理、工单和专注联动

迁移 023—027 补齐可选举报分类、建议结果、群容量配置、桌面专注租约、群整体限制和工单分级排期。举报类别不触发自动处罚；版权、骚扰、知识分歧和严重风险均由受理管理员核实。建议使用已采纳／待评估／重复／暂不采纳及说明，可关联版本，不调用账号处罚。只有当前受理、通过 MFA 的真实平台管理员可以读取私密证据和更改排期。

新工单默认反馈目标为举报第 2 个、建议第 5 个周一至周五的北京时间 18:00，从次日计数，不计算节假日或调休；这是运营目标，不是自动执行或服务承诺。严重风险默认优先核查，受理人可按当前版本调整优先级和未来目标时间，保留审计。结果在原工单主动查看，不新增催办提醒或红点。

`GET/PUT /admin/group-limits` 调整每群人数、每人创建和参与上限，默认 50／3／10；降低限制保留现有成员。群头举报目标为整个群，消息举报目标为该消息；整群限制同步切断房间、任务、资源、管理写入及旧文件授权，原工单恢复后保留成员与历史。评论菜单可举报该评论，作者删除使用 `DELETE /comments/:id`，保留证据及他人回复。

桌面专注通过已绑定设备的 `PUT /desktop/focus` 传递，不公开学习活动。每个设备只控制自身 2 分钟租约，任一有效绑定设备专注或账号手动专注时抑制普通提醒；复用现有设备同步节拍，不增后台进程。撤销绑定或租约到期立即不再影响账号，退出专注不补发被抑制事件。更新过的 Electron 主进程需重新启动终端后生效；手机原生推送仍未配置，真机联动属于后续阶段。

## CloudBase 账号认证

真实个人主页使用 `GET /me/profile` 和 `PUT /me/profile`。只操作当前登录社区账号，更新昵称、一句介绍及可选兴趣；不接受角色、邮箱或目标账号字段。写入要求 CSRF、Origin、幂等键和写入能力，数据保存在社区 PostgreSQL，迁移 009 新增资料表。CloudBase 只承担身份认证，不覆盖社区昵称。迁移 010 接入动态、资源及个人关系；后续迁移已接入头像与共学群业务。不能复用本机演示数据冒充真实记录。

`GET /identity/provider` 返回认证方式、可用状态和密码／发码约束。网站先读取此配置，再展示对应流程。CloudBase 模式注册只需邮箱、密码（新密码 12—64 个字符）；昵称折叠为可选。点击发送成功后才出现六位邮箱验证码，提交后完成验证、注册及社区登录。找回密码同样使用邮箱验证码；已有账号只有在服务端返回 `email_verification_required` 时才增加邮箱验证步骤，不给所有登录者增加字段。

`POST /identity/email-code` 接收邮箱与用途（`register`、`reset_password`、`login`）。浏览器仅持有当前步骤的 `verificationId`，验证码交换出的上游验证令牌由 BFF 使用。邮件未配置或发码失败时不显示“已发送”，不启动成功倒计时，保留邮箱和密码输入；修改邮箱使旧验证步骤失效。验证码与密码只在当前交互内存中使用，不写入浏览器持久化存储或应用日志。真实发信与过期、重发、重复提交等结果仍须在用户指定环境验收。

CloudBase 访问令牌和刷新令牌通过 AES-256-GCM 加密保存在服务端，绑定社区会话；不会返回到网站或放进 localStorage。社区账号关联键包含认证提供方、环境与稳定用户标识。相同邮箱不自动认领已有社区账号，CloudBase `sub` 也不作为社区 UUID 或管理员角色。账号、角色、群权限、封禁、工单和审计继续由社区数据库维护，外部用户资料不能授予管理员权限。

找回密码后的社区会话撤销和管理员 MFA 继续由 BFF 执行。第三方要求 CAPTCHA 时当前如实提示，尚未接入解题 UI；不会重试绕过或假定验证通过。需在正式联调中补齐这一条件流程后再通过外部验收。

会话采用 HttpOnly Cookie，生产要求 HTTPS、Secure 和 `__Host-` Cookie。写请求同时验证网站 Origin 与 `X-CSRF-Token`；CORS 只允许明确配置的 Origin。角色、所有者、接收者权限由服务端会话和数据库判断，客户端身份字段不作为授权依据。部署时建议同域反向代理 `/api/community/v1`，不开放宽泛跨站 Cookie。

### 旧本地认证模式

只有显式设置 `COMMUNITY_AUTH_PROVIDER=local` 才启用原 SMTP 链接认证，供旧流程与隔离测试复现。其注册、验证链接及找回契约保留（新密码 12—128 个字符）；SMTP 未配置仍明确未发送。该模式不是 CloudBase 配置缺失时的降级路线，也不能以旧 SMTP 测试代替当前托管认证验收。CloudBase 模式不需要配置本服务的 `COMMUNITY_SMTP_*`。

## 管理与工单

先正常注册并验证一个真实社区账号，由有数据库运维权限的人在本机赋予管理角色：

```powershell
npm run operator -- grant-admin --account-id 00000000-0000-4000-8000-000000000001
```

示例 UUID 必须替换为目标账号真实的社区 `account.accountId`（来自 `GET /me/session`，或经授权运维查询 `accounts.id`），不能填 CloudBase `sub`、邮箱或旧展示站 ID。操作写入 `operator_audit` 并撤销该账号的旧会话。重新登录，在账号页绑定验证器并输入六位 TOTP；管理验证有效期 10 分钟，成功验证码不能重放。没有公开的“创建管理员”接口。降权命令为 `revoke-admin`，同样使用 `--account-id` 并撤销旧会话。

工单需要关联真实账号或真实受保护对象；演示 ID 不能提交为真实资源。用户提交后可主动查看受理、处置依据、期限、申诉和复核结果。被限制的账号仍可提交反馈与申诉。后台接手工单后才能读取对应证据、处置和复核；证据阅读单独审计，普通列表不暴露私密正文。限制和恢复实际影响对象读取／账号写入能力，恢复只撤销对应案件的限制，不覆盖其他案件。

后台配置只展示脱敏的通道状态、限额和默认静默策略。敏感配置通过部署环境维护，浏览器不能改 CloudBase 认证环境、旧 SMTP、数据库或加密密钥。

## 文件、限额和任务

### 场景插件与 H5P 分发包（2026-10-27）

市场「添加主资源」支持 S2 ZIP 与 `.h5p`，服务端使用与终端共用的有界 ZIP／清单／物料检查器，读取信息并核对完整性，不加载运行入口。仅草稿作者可通过 `GET /resource-stages/:id/files/:fileId/inspection` 读取检查结果，已删除、已发布或他人草稿不能访问；发布事务再次验证实际文件。包信息保存在资源版本的 `preview.scenePackage`，原包仍保存在私有附件存储。迁移 028 增加从主资源推导的 `scene` 分类，普通 ZIP 保留资料分类。

详情展示 S2 的包 ID／版本／接口／服务要求，或 H5P 的主库／依赖／缺失项，技术信息默认折叠。原文件下载沿用认证、权限、限额和短时授权，下载返回原文件名与原字节；网页不执行包代码，也不把它交给正文渲染器或资料索引。包的 delivery 为 `package`，主动桌面接收返回 `package_download_only`，用户下载后从终端既有场景入口导入。S2 上限 16 MiB；H5P 市场仍受 100 MiB 单文件上限约束，终端本地 128 MiB 上限不变。

检查器验证路径、条目数、展开上限、CRC 和 S2 v2 物料 SHA-256；不是代码安全审计。H5P 缺失依赖可下载但明确暂不能播放，终端不会自动联网补装。上传仅分发作者主动选择的原包，不读取或附加现有场景的私人进度、文件或模型凭据。操作及隔离验收见 [场景资源共享](../../docs/artifacts/community/scene-resources/README.md)。

文件适配器只把随机 UUID 路径写到专用 `COMMUNITY_DATA_DIRECTORY/attachments`，不提供公开静态目录。上传申请、实际提交、申请下载、实际下载均重新检查权限；上传授权与下载授权短时有效，数据库仅保存令牌哈希。下载强制 attachment／octet-stream／nosniff，富文本预览由后续资源适配器负责。

单文件上限 100 MiB、每人累计 1 GiB；全站存储额度和 UTC 月下载字节额度必须显式配置。两项默认均为 0，分别关闭新增上传和文件分发。下载在发送响应前原子扣减完整文件大小，中断按完整大小保守计量；这不是云账单，不能替代正式费用核算。权限撤销后，已签发的短时下载令牌也不能继续访问。

迁移 `018_larger_file_uploads.sql` 将文件和额度预留的数据库约束提升至 100 MiB；已有迁移和附件不变。二进制传输允许 15 分钟，桌面大文件接收的任务授权窗口计入文件传输时间。正式反向代理也须允许相应请求体大小及传输时限。

发文、求助和评论使用私有上传草稿附加正文图片，并在发布事务内迁移到对应内容对象。仅 PNG／JPEG／WebP 图片可绑定，不能引用其他内容的文件或接管他人草稿；评论图片下载额外检查原帖权限及可见状态。浏览器接受 10 MiB 原图后压缩，服务端继续校验真实文件内容及访问范围。头像保持服务端小型 WebP 存储，10 MiB 仅指可选择的头像原图。

写操作使用持久化幂等键；同键同内容只执行一次，同键不同内容返回冲突。限流／配额在数据库原子检查，不依赖浏览器禁用按钮。任务队列支持去重、租约、失败重试和重启认领；服务内维护 worker 只执行注册过的任务，不接受浏览器命令。

提醒偏好与专注状态保存在账号下，默认关闭普通提醒、系统推送、声音和振动，不提供红点、未读数字或专注结束补发。领域服务必须经 `AttentionService` 记录和派发事件；其入口不直接暴露给任意接收者请求。真实推送通道仍未配置。

## 备份、恢复与回滚

设置 `COMMUNITY_PG_BIN` 到 PostgreSQL 工具目录（例如本机独立测试使用 `D:/postgreSQL/bin`）。数据库备份会写入专用数据目录 `backups`，文件名随机且不覆盖已有备份：

```powershell
npm run backup
```

这是数据库备份。需要暂停上传写入，并另行保存同一时点的私有 `attachments` 目录；加密密钥通过独立受保护配置保存。备份、附件和密钥均不得上传到代码仓库。正式环境还需配置异地备份、保留周期和恢复演练。

恢复只接受单独配置的、没有任何业务表的隔离数据库，脚本不删除已有表：先创建空恢复库，再设置 `COMMUNITY_RESTORE_DATABASE_URL`，执行 `npm run restore -- <custom-dump-file>`。恢复使用单事务；验证账号、工单、权限、审计和附件完整性后再切换服务。不要把源库地址作为恢复目标。

应用回滚时保留数据库、附件与密钥，不通过删库回退。007 将本地邮箱唯一约束限定为本地账号，并为外部账号单独保存认证关联；已有本地账号保持原身份，不按邮箱迁入 CloudBase。008 新增加密托管会话与邮箱验证请求。不能直接删除这两项迁移或降级旧账号代码来回退。

## 测试

`npm test` 必须指向专用测试数据库。设置 `COMMUNITY_TEST_DATABASE_URL`（可另设测试专用加密密钥），或者使用当前工作区 ignored `.ui-preview/community-phase2/runtime.json` 的独立本机集群。不会读取通用 `DATABASE_URL` 或真实 `.env`。

每组测试创建随机 schema，结束只清理自己的 schema；恢复测试另建随机空库，验证后清理该恢复库。恢复演练默认只允许命名为 `community_phase2` 的隔离库，其他测试环境需显式设置 `COMMUNITY_TEST_ALLOW_RECOVERY=true`。本机服务重启演练必须在所有其他测试退出后进行，且仅操作专用集群。

`npm test` 按文件串行执行，避免 PostgreSQL 18 的备份目录扫描与其他测试删除临时 schema／序列并发发生；备份／恢复测试期间也不要同时启动浏览器数据库测试。

原本地基础验收证据见 `docs/artifacts/community/phase-2`，当前 CloudBase 认证接入见其 `cloudbase` 子目录。CloudBase 网站可用 `node --require ./scripts/node-os-userinfo-fallback.cjs scripts/check-community-cloudbase-browser.mjs` 从仓库根复现本地协议夹具：5 组浏览器检查、375／1536 两种宽度，未访问 CloudBase、未发真实邮件。真实本地数据库、托管协议夹具和正式外部服务分别记录，不互相替代。

另运行 `scripts/check-community-cloudbase-service-browser.mjs` 完成 5 组真实 BFF 浏览器集成，使用真实随机 PostgreSQL schema 和合成上游提供方，覆盖 Cookie、刷新、反馈持久化与重置后另一设备旧会话失效。该脚本需要 API 的 tsx 加载器，完整命令和证据见 CloudBase 接入记录；同样不请求真实 CloudBase 或发邮件。

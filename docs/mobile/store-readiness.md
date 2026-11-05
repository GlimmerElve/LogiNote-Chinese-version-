# LogiNote 移动端上架准备

查证日期：**2026-10-30**。来源为 Apple 与 Google 官方页面。本文把官方要求转成 LogiNote 的设计和交付检查项；“项目决定”是本项目的实现建议，不是商店原文。规则、适用地区和账户协议会变化，正式提交前应重新核对；完成本文不保证审核通过。

范围：iOS/iPadOS App Store 与 Android Google Play，并在第 14 节列出中国大陆发行的额外核对项。其他 Android 商店仍需按其官方开发者协议单独验证，不应把 Google Play 合规等同于全部 Android 渠道合规。

## 1. 独立移动价值与最低功能

Apple 4.2 要求超越重新包装的网站；Google Play 也拒绝功能过少、损坏或没有实际用途的应用。[Apple 4.2 Minimum Functionality](https://developer.apple.com/app-store/review/guidelines/#minimum-functionality)、[Google 功能、内容和用户体验](https://support.google.com/googleplay/android-developer/answer/9898783?hl=en)。

项目决定：

- 使用独立移动壳层与五入口，提供手机上的阅读进度、离线短记录、简测草稿与恢复、消息和计划确认。跨平台技术或 WebView 本身不自动导致拒绝，也不自动满足最低功能。
- 手机核心操作直接访问自己的缓存与受权限约束的服务，不依赖电脑持续开机、屏幕镜像或远程操控桌面。桌面是资料来源之一，不是手机每次记录和查阅的运行宿主。
- 手机首次使用允许独立创建短记录和计划；连接桌面后增量获得选定资料。尚无桌面数据时仍有可用功能，清楚说明可连接的下一步。
- 资讯不做链接集合或网页外壳；保留来源、搜索和用户自己的学习闭环。
- 第一阶段可操作原型是设计验证产物。正式提审须补齐真实业务和后端，移除仅供开发的成功模拟与占位操作。

## 2. 交互按平台习惯实现

HIG 强调清晰层次、系统习惯、适配布局与无障碍；Android 提供核心应用质量验证标准。[Apple 设计原则](https://developer.apple.com/design/human-interface-guidelines/design-principles)、[Apple 布局](https://developer.apple.com/design/human-interface-guidelines/layout)、[Apple 无障碍](https://developer.apple.com/design/human-interface-guidelines/accessibility)、[Android Core app quality](https://developer.android.com/docs/quality-guidelines/core-app-quality)。

项目决定：

- 遵守安全区，底部五入口保留文字；处理 Android 系统返回、iOS 返回手势、弹层焦点与未保存草稿。
- 为主要触控操作采用至少约 44 pt 的 iOS 点击区域；Android 按平台组件和触控规范实现。保留足够间距，不让小图标成为唯一操作目标。
- 支持系统字体缩放、VoiceOver/TalkBack、深色模式、减少动态效果；增大字体后可换行，内容和按钮不重叠。
- 不模拟系统授权弹窗或使用诱导按钮。业务中的“同意向 AI 发送资料”与系统麦克风/通知权限是两套不同的授权。

## 3. 隐私政策与商店数据申报

App Privacy 与 Data safety 必须反映实际数据处理及第三方 SDK 行为；不能仅按产品宣传填写。[Apple App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)、[Google Data safety](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en)。Google 另要求可访问的隐私政策。[Google User Data：Privacy Policy](https://support.google.com/googleplay/android-developer/answer/10144311?hl=en#privacy-policy)。

项目决定：

- 在头像设置和登录前页面提供隐私政策；正式版本使用有效、公开可访问的网页，显示 LogiNote/运营主体、联系方式、更新日期。Google 提交链接不使用 PDF、登录墙或地理封锁。
- 按真实实现盘点：账号邮箱与标识、私人笔记/复述、计划、答题与学习活动、聊天及附件、录音/转写、设备与诊断数据、购买记录。逐项记录用途、是否必需、接收者、关联身份、保存期限及删除方式。
- 云同步、第三方 AI、语音转写、推送、崩溃分析分别登记。只在手机本地处理与离开设备处理的情况要区分，不笼统宣称“完全本地”或“绝不收集”。
- 生成一次出站请求与 SDK 数据流审计，再据此填写两店申报。更换供应商、启用日志或新增 SDK 时同步更新政策、申报和必要的同意。
- 本机演示缓存只用于原型验收；不能拿原型的数据声明代替正式版本申报。

## 4. 第三方 AI：先明确披露，再取得同意

Apple 5.1.2(i) 明确要求披露向第三方（包括第三方 AI）分享个人数据并事先取得明确许可。Google 的用户数据规则也覆盖第三方 AI。[Apple 5.1.2 Data Use and Sharing](https://developer.apple.com/app-store/review/guidelines/#data-use-and-sharing)、[Google User Data](https://support.google.com/googleplay/android-developer/answer/10144311?hl=en)。

项目决定：

- 第一次向第三方 AI 发送私人内容前，在对应操作中展示接收方/供应商、目的、将发送的资料范围和可确认的保存/训练规则；提供“同意并继续”和“暂不发送”。不能只藏在用户协议，也不能以预勾选、继续浏览或定时消失视为同意。
- 示例范围可为“你当前输入的复述及选中的两段资料”，不得用含糊“用于改善体验”代替。发送前能查看或取消关联资料。
- 拒绝后仍可阅读、检索已下载资料、手动记录和查看计划；只暂停需要该次远端 AI 处理的动作。
- 记录供应商、目的、数据类别、政策版本和同意时间；更换接收方或扩大用途/范围时重新确认。设置提供查看和撤回后续授权的入口，不许诺撤回能自动消除第三方已合法保存的数据。
- 不在客户端内置服务端供应商密钥；服务端限制资料范围，日志避免保留完整私人正文。用户自己输入模型密钥也不免除披露与最小化要求。

AI 输出还需应用内举报能力与内容防护。[Google AI-Generated Content](https://support.google.com/googleplay/android-developer/answer/13985936?hl=en)。项目提供“举报此 AI 输出”，覆盖有害、侵权、隐私和错误内容，带回所需最小上下文并进入运营处理。AI 建议、事实引用和用户认知分别标识；计划建议先预览再确认，简测不以模型口头夸奖更新正式掌握度。

## 5. 社交与 UGC：举报、拉黑及持续运营

UGC 需要持续治理，私信也有相应保护要求。[Apple 1.2 User-Generated Content](https://developer.apple.com/app-store/review/guidelines/#user-generated-content)、[Google User Generated Content](https://support.google.com/googleplay/android-developer/answer/9876937?hl=en)。

项目决定：

- 用户发布或上传前接受适用的用户协议/社区规范，规范说明禁止的内容和行为。
- 帖子、评论、资源、资讯投稿及个人页面提供适用的举报入口；会话和用户页提供拉黑。拉黑应在服务端生效，不只是隐藏本机列表。
- 私聊与群聊沿用现有社区权限，明确陌生会话请求；不将真人聊天与 AI 助手混为同一种会话，不做随机匿名配对。
- 举报提交需要真实回执；运营有分派、取证、处理、申诉与记录机制，并公布联系方式。不能只做一个“举报成功”的原型按钮就宣称治理完成。
- 基于发行范围确定年龄分级、目标受众和未成年人保护；教育用途不自动等于儿童专用类别，也不免除 UGC 义务。
- 原型举报/拉黑只演示状态，正式提审前逐项用两个真实测试账号验证。

## 6. 删除账号与数据

支持创建账号时，Apple 要求应用内可发起删除；Google 要求应用内路径和外部网页请求入口。停用不能代替删除。[Apple 账号删除说明](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion/)、[Google 账号删除要求](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en-en)。

项目决定：

- 路径为“头像 → 账号与安全 → 删除账号”，说明会影响哪些云端资料、社交资料和设备，提供身份验证、确认及可查回执。
- 对 Google Play 提供实际可访问的网页删除请求入口，关联 LogiNote/运营主体，并在 Play Console 对应字段登记；不能只链接下载 App 或普通首页。
- 实现服务端删除与设备令牌撤销；停止旧设备写入，处理本机缓存、上传队列、附件和备份生命周期。删除不是仅调用退出登录。
- 依法或为合理安全目的需要保留的数据，明确类别、依据和期限；不以含糊“可能永久保留”替代说明。
- 删除前提醒订阅管理与必要导出，但不能强迫联系客服或完成营销问卷。对 Apple 登录按官方要求处理相关令牌；订阅状态与账号删除单独核对。
- 原型只能展示说明和确认流程，必须明确“演示，不会删除真实账号”。正式服务实现后才允许宣称删除已完成。

## 7. 录音、通知和最小权限

按用户操作上下文请求权限，并在拒绝后保留可用路径。[Apple HIG Privacy](https://developer.apple.com/design/human-interface-guidelines/privacy/)、[Android 请求运行时权限](https://developer.android.com/training/permissions/requesting)、[Android 通知权限](https://developer.android.com/develop/ui/compose/notifications/notification-permission)。

项目决定：

- 点击录音时才申请麦克风，说明“将语音转为你确认后保存的复述”。显示录音状态、时长、停止与取消，不后台秘密录音。拒绝后保留文字输入。
- 云端转写另说明音频将交给谁处理，并按第四节获取相应数据分享许可。麦克风权限不等于允许上传整份资料库。
- 只有用户启用计划/消息提醒时请求通知。Android 13+ 非豁免通知适用 `POST_NOTIFICATIONS`；拒绝后仍可在应用内查看计划与消息。
- 选择图片和文档优先系统选择器；没有直接用途就不申请通讯录、位置、短信、广泛存储或后台定位权限。
- 两个平台的系统授权前说明页面按各自规范实现；不把 iOS 与 Android 的权限教育页面机械统一。

## 8. 登录方式与 Apple 4.8 适用范围

Apple 4.8 对用于主要账号的第三方/社交登录有等效登录选项要求，并列有例外。[Apple 4.8 Login Services](https://developer.apple.com/app-store/review/guidelines/#login-services)。

项目决定：

- 首版若仅使用 LogiNote 自有邮箱/密码等自有账号系统，不仅因为存在登录就强制增加第三方登录。
- 若加入微信、Google 等第三方登录作为主要账号登录，需要评估 4.8；可采用符合其隐私条件的等效选项，通常可用 Sign in with Apple 实现。
- 教育/企业既有账号、专用第三方服务客户端等例外按实际产品核对，不能因为“学习 App”就自动套用教育账号例外。
- 不要求访问本机不必要的身份信息；账号合并、Apple 隐藏邮箱及删除流程均需验收。

## 9. 数字服务与支付：按商店和地区决定

数字功能/内容的应用内交易一般适用商店支付规则，同时存在地区及计划条件。[Apple 3.1 Payments](https://developer.apple.com/app-store/review/guidelines/#payments)、[Google Payments](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en)。

项目决定：

- AI 额度、云同步容量、订阅和高级简测等如收费，先明确商品、购买平台、权益恢复和跨端使用方式；不能直接把网页支付链接作为全球统一方案。
- iOS 的现有订阅访问、多平台服务或免费配套应用等可能涉及 3.1.3 的具体条件，不因为“电脑买过”就默认豁免所有手机内购要求。
- 美国 storefront 与其他地区的外链规则有差异；EU 及其他适用地区涉及协议、资格、entitlement、API、披露和交易报告。提交前按目标 storefront 核对。[Apple EU 最新业务条款](https://developer.apple.com/support/apps-in-the-eu)、[Apple External Purchase](https://developer.apple.com/documentation/storekit/external-purchase)。
- Google 的替代结算或外部引导取决于符合资格的地区与加入的项目，不能以某地区许可推断全球允许。条款和资格未确认前，不在相应发行版显示外部付款入口。
- 第一阶段原型不收款；正式收费版本验证价格、周期、试用、恢复购买、退款/撤销后的权限和订阅管理，向审核提供完整购买路径。

## 10. 工具链、签名、SDK 与提交时复查

本次实际打开官网核实的时间性要求：

- Google Play：自 **2026-08-31** 起，一般手机新应用及更新应 target **Android 16 / API 36 或更高**。其他设备类别有不同标准；`targetSdk` 不等于 `minSdk`。不能照搬 2025 年 API 35 的新提交基线。[Google target API requirements](https://developer.android.com/google/play/requirements/target-sdk)。
- Apple：自 **2026-04-28** 起上传应用使用 **Xcode 26 或更新版本、iOS/iPadOS 26 SDK 或更新版本**；自 **2026-09-09** 起 iOS/iPadOS 上传要求部署目标 **iOS 13 或更高**。SDK 与最低运行版本是不同配置。[Apple Upcoming Requirements](https://developer.apple.com/news/upcoming-requirements/)。

项目决定：

- 原型仓库尚不代表原生工程已满足以上要求。建立可复现的签名构建，核对 Bundle ID/package name、版本、证书、entitlements 和生产配置；密钥不入库。
- Android AAB 使用上传密钥及 Play App Signing 流程。[Android App Signing](https://developer.android.com/studio/publish/app-signing)。如果引入 NDK/本机 SDK，检查 16 KB page size 兼容性及传递依赖。[Android 16 KB page sizes](https://developer.android.com/guide/practices/page-sizes)。
- Apple 第三方 SDK（包括可能采用的跨平台壳）核对清单中的隐私清单、二进制签名，以及使用需说明理由 API 的申报；不能只检查自己写的代码。[Apple Third-party SDK requirements](https://developer.apple.com/support/third-party-SDK-requirements/)。
- 每次正式提交前重新打开上述页面并检查控制台提示、当前协议和地区要求。延期申请不作为长期工程基线。

## 11. 内容版权、RSS、开源许可与代码更新

内容和第三方服务使用必须有权利依据；RSS 可读取不代表允许全文再分发或商业化。[Apple 5.2 Intellectual Property](https://developer.apple.com/app-store/review/guidelines/#intellectual-property)、[Google Intellectual property](https://support.google.com/googleplay/android-developer/answer/9888072?hl=en-GB)。

项目决定：资讯优先授权来源、简短摘要与原文链接，保存来源条款、许可范围和撤回机制；用户导入不自动授予公开分发权限。商店截图、字体、图标、题库和演示资料也保留权属记录。发布包中附适用的开源许可证/NOTICE，审核实际依赖与商用约束，不以“npm 可安装”视为无需遵守许可。

Apple 2.5.2 限制下载执行改变功能的代码；Google 对自更新、外部可执行代码及解释器内容分别设定规则。[Apple 2.5 Software Requirements](https://developer.apple.com/app-store/review/guidelines/#software-requirements)、[Google Device and Network Abuse](https://support.google.com/googleplay/android-developer/answer/16559646?hl=en)。

项目决定：手机只同步资料、消息、计划和受限声明式数据；不加载桌面场景插件、任意脚本、远程本机模块或通过“热更新”添加未审核能力。功能更新走商店发布。WebView/JavaScript 的特定规则不能被解释为无限下载执行代码的许可；若未来做运行时内容平台，先单独评估完整规则与沙箱边界。

## 12. 审核可访问性、协议与真机验收

提交需完整、可审查的信息与访问路径。[Apple Complete Review](https://developer.apple.com/help/app-review/before-submitting-for-review/complete-review/)、[Apple App Review](https://developer.apple.com/app-store/review/)。协议以开发者账户实际接受的版本为准。[Apple Agreements and Guidelines](https://developer.apple.com/support/terms/)、[Google Developer Distribution Agreement](https://play.google/developer-distribution-agreement.html)。

项目验收：

- 提供可持续使用的审核账号、预置的非敏感样例资料、必要验证信息及操作步骤。后端在审核期间真实运行，可从审核所在地访问；不要求审核员拥有开发者的电脑或等待人工配对。
- 说明 AI/云同步/社交服务、地区差异、付费项目以及重要配置。应用说明、截图和年龄分级对应实际发行版本，支持和隐私链接均有效。
- 若采用审核演示模式，按官方适用条件处理且覆盖完整功能；当前本地原型不直接充当正式审核版本。不得通过审核专用开关隐藏实际能力或违规路径。
- 在真实 Android 和 iPhone 上验证：冷启动、登录/退出/删除账号、账号切换、离线保存、重试与冲突、数据不串库、应用被杀后恢复、键盘与返回、安全区、大字体、读屏、权限拒绝、录音中断、推送点击与缓存清理。按选择的最低支持版本和最新系统安排设备矩阵。
- 真机模拟网络差、服务超时、令牌过期；确认“已同步”“已发送”“已删除”都由真实回执驱动。购买启用后另测商店沙箱和权益撤销。
- 双人测试举报与拉黑，验证运营后台确有处置能力；审计依赖、内容权利、隐私申报和现有协议后再提交。[Android Core app quality 验证依据](https://developer.android.com/docs/quality-guidelines/core-app-quality)。

## 13. 第一阶段原型应预留的入口

以下是产品决定，基于上述官方规则落地；演示与真实操作必须分别标识：

- 头像 → **隐私与 AI 数据使用**：查看分享范围、演示同意/拒绝及后续撤回；拒绝不阻断手动记录。
- 头像 → **账号与安全 → 删除账号**：说明影响、确认、演示回执；预留正式外部删除请求链接的配置，不捏造已上线网址。
- 消息/用户/内容菜单 → **举报、拉黑**；AI 结果 → **举报此 AI 输出**。原型提示“仅本机演示，未提交运营”。
- 头像 → **隐私政策、用户协议、社区规范、帮助与联系、开源许可**。正式政策由真实服务、供应商与运营主体信息编写，原型文案不能冒充已生效协议。
- 录音和提醒入口 → 权限用途说明与拒绝后的替代状态。第一阶段不请求无实际用途的系统权限。

这些入口仅证明交互可审查；真实同意校验、服务端删除、内容治理和原生系统能力在后续阶段逐项交付，不因原型可点就计为已完成上架要求。

## 14. 中国大陆发行的额外前置条件

若首发包含中国大陆，需单独落实主体、业务范围及备案材料。工信部《移动互联网应用程序备案工作的通知》要求相关 APP 互联网信息服务履行备案手续；Apple 的中国大陆可用性说明也列明备案号与 App 元数据的一致性要求。[工信部 APP 备案通知](https://www.miit.gov.cn/zwgk/zcwj/wjfb/tz/art/2023/art_920db564162e4312916a01bed6540ad8.html)、[Apple App 信息：中国大陆可用性](https://developer.apple.com/cn/help/app-store-connect/reference/app-information/app-information)。

项目决定：

- 在正式分发前核对 APP 主办者、域名/网络资源、包标识、签名与备案资料；已有网站备案不能直接视为完成全部 APP 备案要求。
- 把“最新资讯”的实际内容、来源、加工与分发模式列为上线前的业务核对项。Apple 官方页面对新闻等特定内容列有额外许可要求，不能仅将栏目命名为“学习资讯”就认定豁免；未确认业务范围与资质前，不开启相关地区的受限内容服务。
- 生成式 AI、社交与未成年人服务按实际提供方式、运营地区和接收方核对适用义务；本次仅确认商店设计边界，没有替项目完成备案、许可或法律适用认定。
- 若选择国内 Android 应用商店，逐一查证该渠道的最新官方协议、主体材料、隐私/SDK 检测与分发要求。项目尚未选定具体国内 Android 渠道，不把 Google Play 的支付、推送和账号方案直接当作国内渠道方案。

# LogiNote 移动端 · 第一阶段交付

最近更新：2026-11-07。范围：产品方案、同步架构、官方规则与开源参考、可操作原型，以及 Android 首版调试安装包。真实私人同步、AI 服务和商店发布尚未完成。

## Android 首版

[Android 工程与构建说明](../../apps/android/README.md)。安装包位于 `apps/android/android/app/build/outputs/apk/debug/app-debug.apk`。

Android 使用本机入口，已接入原生课堂录音、通知控制、系统拍照/选图和真实音频回听；首页增加「今日任务」，支持查看、手动完成与确认改期。手机与平板共用响应式布局。当前任务与发现内容仍为样例，账号、桌面数据同步、语音转文字和学习助手 Agent 尚未连接。

下文的浏览器演示保留独立预览。Android 原生录音不使用浏览器演示计时器；网页交互检查也不能替代设备录音与锁屏验收。

## 查看原型

已启动的本机地址：[LogiNote 移动端原型](http://127.0.0.1:5182/design/mobile-prototype/index.html)。该服务只监听本机，不是手机可直接访问的公网服务；浏览器可以调整窄屏查看移动布局。

在项目根目录重新构建和启动：

```powershell
node node_modules/vite/bin/vite.js build --config scripts/vite-mobile-prototype.config.ts
node node_modules/vite/bin/vite.js preview --config scripts/vite-mobile-prototype.config.ts
```

第一条命令生成独立产物 `output/mobile-prototype/`；第二条命令启动本机 5182 端口。该配置不启动桌面 App、资料库迁移、社区账号或 AI 服务，未修改原有应用入口和构建配置。

## 当前交互范围

前端已按确认概念图更新为「首页、发现、消息、记录、我的」。概念图总览：[/design/mobile-concepts/index.html](http://127.0.0.1:5182/design/mobile-concepts/index.html)。

- **登录**：测试邮箱、测试密码、说明勾选及注册/找回入口；明确为演示，不创建真实账号，不保存密码。
- **首页**：48px 录音/拍照入口、今日任务与独立的学习助手入口，顶部不再重复放「我的」。具体助手对话为子页面，手机隐藏底部导航，平板左侧显示历史与标签。助手支持独立消息/草稿、名称与标签编辑；图片和课堂引用收进输入栏「＋」。从资料或任务问助手后，可返回原处继续。
- **照片**：文件选择器在支持的手机上可调起系统相机，图片存入本机 IndexedDB；课堂内照片带时间锚点，独立照片生成记录。
- **发现**：推荐卡片的按钮/键盘/滑动切换、全文搜索、文件夹浏览、阅读、收藏、关联来源的复述与助手提问。复述保存来源 ID 与名称快照，记录列表/详情显示关联资料；可回到原文并返回原复述，资料阅读页也能查看针对它的复述。跨资料续写草稿仍绑定原资料；来源切换保存失败不打开新弹窗。
- **消息**：群/私聊列表、搜索、独立会话草稿、本机发送演示、照片附件、选择资料分享、附件打开、屏蔽/解除、举报演示；照片与分享统一收进输入栏「＋」，为文字输入留出空间。
- **记录**：日期分组、搜索、详情、时间定位、播放进度与倍速演示、转写样例、轻量文字/照片编辑、取消保护、确认删除及分享。
- **语音手势**：复述和聊天输入支持长按演示、松开结束、上滑取消；文字输入由系统键盘管理。语音与课堂计时都不实际录音，不调用识别；转写样例明确标为演示。
- **我的**：基础账号、仅展示已收藏资料的收藏入口、同步说明与隐私入口。收藏阅读返回原收藏列表。该页视觉稿仍待进一步确认。
- **平板**：左侧全局导航，记录/消息列表和详情分栏；手机聊天与记录详情进入全屏，返回列表。软键盘改变可视高度时收起手机导航。

元数据使用 `loginote.interactions.v2`，照片使用 `loginote-interaction-media` IndexedDB；旧版 `loginote.mobile-prototype.v1` 不覆盖。元数据异常原串在首次覆盖前备份至新键前缀 `.recovery.*`。保存失败保留输入和课堂状态，允许重试。会话登录标志仅存在 sessionStorage。原先单个 `assistant` 消息数组和助手草稿会迁移成一条历史对话；新会话使用 `assistantThreads` 与 `activeAssistantId`，保留旧数据。

浏览器原型中的录音、回听进度、转写、Agent 及云同步均为明确标识的前端演示，不进行麦克风采集或后台持续录音。Android 原生实现见上方说明。照片与本机草稿保存是真实浏览器存储；清理浏览器会影响这些本地数据。

2026-11-07 界面复核修正首页/助手分离、导航去重、附件菜单、任务返回与收藏筛选；共享检查 14＋10＋12 组通过。截图与验证记录位于 `docs/artifacts/mobile/ui-review-2026-11-07/`。

## 方案与依据

- [移动交互资料与 skill](./mobile-interaction-reference.md)：原生手势、输入焦点、长按取消及精简界面的设计依据。
- [产品方案](./product-plan.md)：设备分工、五入口、用户闭环、异常状态、复用点及分期。
- [多端协同架构](./multi-device-architecture.md)：私人同步域、白名单投影、事件队列、版本冲突、设备撤销、接口和验收。
- [开源与成熟项目参考](./open-source-reference.md)：Joplin、Notesnook、SiYuan、Capacitor、RxDB、PowerSync、Yjs，以及许可与部署边界。
- [官方上架准备](./store-readiness.md)：Apple/Google 官方要求、隐私与 AI、UGC、账号删除、权限、内购、工具链和中国大陆发行前置项。每节附官方来源，正式提审前重新核对。

建议路线：保留桌面本地 Markdown 与既有学习规则，采用独立移动 UI 和共享业务核心；以 React + Capacitor 为原生候选。同步先比较 RxDB 与受限操作的自有同步器，使用同一组断网、重试、冲突、删除和账号隔离用例验证，再锁定依赖。参考架构并未引入这些项目的运行时代码。

## 验证结果与复现

当前入口使用 `InteractiveApp.tsx`；既有 `MobilePrototype.tsx` 和旧交互组件保留，旧检查脚本只对应早期方案。

```powershell
$env:LOGINOTE_BROWSER_MODULES='实际已有的 node_modules 绝对路径'
node scripts/run-tsx-safe.cjs scripts/check-mobile-interactions.ts
node scripts/run-tsx-safe.cjs scripts/check-recap-assistant-links.ts
```

先构建，再运行浏览器检查。检查复用已有 Playwright 和 Chrome，使用临时本机端口、独立浏览器上下文及合成数据，不读取真实资料库或调用外部服务。验收结果与截图位于 `docs/artifacts/mobile/interactions/`。

验证覆盖登录、五项导航、紧凑按钮、语音长按生命周期、课堂暂停/归档、照片恢复、转写标识、记录编辑、助手上下文、资料阅读及复述来源、会话草稿、存储失败安全重试、分享、跨导航编辑保护、损坏缓存备份，以及 320/390/768/1194/1440px 下的布局。来源/助手专项检查另覆盖原文往返、名称快照、旧记录兼容、多会话迁移、标签与名称搜索、独立草稿、发送失败恢复和新建不覆盖旧内容。

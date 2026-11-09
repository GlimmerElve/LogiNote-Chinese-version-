# LogiNote Android

Android 首版工程，复用已确认的手机与平板界面。应用 ID 为 `app.loginote.mobile`，版本 `0.1.0`，最低 Android 7 / API 24，需 Android System WebView / Chrome 100+，编译与目标 API 36。Capacitor、Android 运行时及 CLI 固定为 8.6.0；依赖使用独立 lockfile，不更改桌面端依赖。

## 当前范围

- 本机使用入口，无虚构的服务器登录；记录、图片、助手对话与草稿保存在当前设备。
- 课堂录音接 Android `MediaRecorder` 与麦克风前台服务，支持暂停、继续、停止，通知提供控制入口。录音由用户在应用前台启动，锁屏或切换应用后由服务继续维护。
- 音频为应用私有目录中的 AAC/M4A 文件，附原生原子写入的状态索引。重新打开应用恢复活动状态和已结束录音；同一 ID 不重复归档。确认删除先保存删除意图，再删除私有文件，失败可幂等重试。
- 原生系统相机/照片选择器，图片归入当前课堂并附时间位置；处理相机 Activity 恢复。现有文件选择器保留为网页预览回退。
- 真实本机音频回听、定位与倍速；无音频的网页样例仍明确标识为进度演示。
- 首页「今日任务」进入日期/计划筛选、详情、改期确认和手动进度记录；任务目前为独立样例，不读取或修改桌面真实计划。
- 首页与具体助手对话分开；照片与课堂引用收进输入栏「＋」。任务阅读和问助手返回保留原任务及筛选；「我的收藏」只显示已收藏资料。阅读、复述来源绑定、助手历史与标签、群/私聊交互沿用共享界面。Android 返回键优先返回页面/关闭弹层；首页返回最小化应用，不主动杀死录音服务。
- 账号、云同步、语音识别和学习助手 Agent 仍未接入。界面中的样例与演示回复保留明确标识，不以计时或固定文本冒充真实录音/识别。

## 构建

项目根目录先安装已有 Web 工程依赖，再安装独立移动包。需要 Node.js 22+。

```powershell
cd apps/android
npm ci --ignore-scripts --cache ../../.local/npm-cache
npm run check
npm run sync
```

`sync` 将 Web 资源打包到本包 `dist/`，并复制到已生成的 `android/` 工程；生产包不使用开发服务器 URL。CLI 显式加载本项目已有 Windows 用户信息兼容脚本。

本机工具链由项目根目录的 `scripts/android-toolchain.ps1` 管理。工具和缓存只写入 `.local/android-tools`，不修改系统 PATH。现有 Android Studio/JDK/SDK 也可通过 `-JdkHome` 和 `-SdkRoot` 指定。

```powershell
# 项目根目录
powershell -NoProfile -File scripts/android-toolchain.ps1 -Action Probe

# 仅准备开源 JDK，不下载 SDK
powershell -NoProfile -File scripts/android-toolchain.ps1 -Action Bootstrap -JdkOnly

# 阅读并同意 Google SDK 许可后，才执行下一条下载命令
powershell -NoProfile -File scripts/android-toolchain.ps1 -Action Bootstrap -AcceptAndroidSdkLicense
# 按安装提示审阅并确认所需的标准 SDK 许可
powershell -NoProfile -File scripts/android-toolchain.ps1 -Action InstallSdk

# 在 apps/android 执行：资源同步 + 调试 APK
npm run build:debug
```

SDK 许可由执行者明确确认；脚本不伪造许可哈希或静默回答许可提示。官方下载包使用 SHA256 校验，Gradle wrapper 同样固定官方分发校验值。Gradle 和 Android 用户目录也位于工作区，避免把开发缓存和调试签名写入系统用户目录。

调试 APK 输出：`apps/android/android/app/build/outputs/apk/debug/app-debug.apk`。正式发布需要另行配置发布签名、确认最终应用 ID 和版本号，使用 `bundleRelease` 生成 AAB。

## 验证与边界

2026-11-07 已重新完成原生调试构建、APK 签名与 zipalign 验证，包名、版本及 SDK 声明符合当前工程配置。APK 内 107 个 Web 资源与同步目录逐个 SHA256 比对一致；TypeScript 检查与共享交互检查通过，共 14＋10＋12 组，其中 Android 模拟桥接覆盖 12 组。当前没有真机验收结论。

```powershell
# 项目根目录，复用已有 Playwright + Chrome
$env:LOGINOTE_BROWSER_MODULES='包含 playwright 的 node_modules 绝对路径'
node scripts/run-tsx-safe.cjs scripts/check-android-mobile.ts
node scripts/run-tsx-safe.cjs scripts/check-mobile-interactions.ts
node scripts/run-tsx-safe.cjs scripts/check-recap-assistant-links.ts
```

原生桥接检查通过测试页面注入 fake adapter；不向生产入口增加后门，也不请求真实麦克风权限。它能验证共享 UI 的保存、恢复、失败重试、返回、键盘和布局，不能代替 Java 编译或手机硬件验证。

真机仍需验证：麦克风拒绝/撤回权限、通知控制、锁屏与长课堂录音、来电/其他应用抢占麦克风、相机期间 Activity 重建、存储不足、强杀和升级恢复，以及不同 Android WebView/手机/平板尺寸。系统强杀时 M4A 容器可能未封口；工程保留原始文件并标识中断，不承诺音频一定可修复。卸载应用会删除其私有数据；目前没有真实云备份。

## 官方依据

- [Capacitor Android 支持范围](https://capacitorjs.com/docs/android)
- [Capacitor 8 环境要求](https://capacitorjs.com/docs/getting-started/environment-setup)
- [Android 麦克风前台服务规则](https://developer.android.com/develop/background-work/services/fgs/service-types#microphone)
- [Android 后台启动限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- [Capacitor Camera 与 Activity 恢复](https://capacitorjs.com/docs/apis/camera)
- [Google SDK 许可与官方下载](https://developer.android.com/studio#command-line-tools-only)

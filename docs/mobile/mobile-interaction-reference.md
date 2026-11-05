# 移动输入交互依据

查证：2026-10-30。用于修正第一阶段原型：**长按按钮说话；点击编辑框打字；语音结束后可编辑、再保存。** 下文区分官方原则、成熟组件实践与 LogiNote 的产品选择；不表示已经接入手机录音或识别服务。

## 1. 资料与采用方式

- [Apple HIG：Gestures](https://developer.apple.com/design/human-interface-guidelines/gestures)：熟悉的手势应保留预期含义，操作中提供及时反馈，核心任务保留替代输入。它没有规定语音按钮必须长按多少毫秒，也没有规定上滑一定代表取消。
- [Android：Touch gestures](https://developer.android.com/develop/ui/views/touch-and-input/gestures)：遵循平台手势习惯，不让基础行为只能依靠触摸手势。卡片左右切换保留可点按钮；语音之外保留直接打字。
- [Stream 官方语音组件](https://getstream.io/chat/docs/sdk/flutter/stream-chat-flutter/stream-voice-recording/)：展示按住录音、松手加入输入区、滑动取消、预览后发送等成熟流程。其锁定与取消方向不等于 LogiNote 的方向选择；只借鉴状态与反馈，不引入聊天 SDK。
- [W3C Pointer Events 3](https://www.w3.org/TR/pointerevents3/#the-pointercancel-event)：覆盖指针取消和捕获生命周期。原型应处理取消、捕获丢失和多点干扰，而非仅依赖一次 `pointerup`。录音按钮的手势范围不能抢占整页滚动或系统返回。
- [Android：输入法显示](https://developer.android.com/develop/ui/views/touch-and-input/keyboard-input/visibility)及 [Apple：becomeFirstResponder](https://developer.apple.com/documentation/uikit/uiresponder/becomefirstresponder())：编辑控件取得输入焦点后由系统管理键盘；外接键盘、窗口焦点和平台状态会影响软键盘显示。点击真正的编辑框即可输入，不另做“打字”按钮或网页键盘。

## 2. 本次查找的 skill

已安装并实际查询：

- `ui-ux-pro-max`：其 `web` 域实际为移动 App 交互规则，包含触控目标、手势冲突、输入标签、反馈和非手势替代操作；`swiftui` 指引包含输入焦点管理。可指导交互，但不能代替手机录音接口或审核规则。
- `ui-styling`：用于可访问控件、弹层焦点、响应式布局和输入样式。其主体是 Web UI，不能单凭使用这个 skill 就宣称已完成原生交互。

外部已查阅：

- [Callstack react-native-best-practices](https://github.com/callstackincubator/agent-skills/blob/main/skills/react-native-best-practices/SKILL.md)，[MIT 许可](https://github.com/callstackincubator/agent-skills/blob/main/LICENSE)：主要针对 React Native 性能、动画及渲染测量，不是按住说话的交互规范；不因此把现有 React Web 原型迁移为 React Native。
- [Expo 官方 skills 仓库 README](https://github.com/expo/skills#skills-included)：已核对当前名称 `expo-animation`（动画与手势）、`expo-native-ui`（原生界面）、`expo-design-system`、`expo-web-to-native`。旧 `building-native-ui` 文件链接已失效，使用当前名称，不猜测文件路径。仅查阅，未安装；这些 skill 面向 Expo/React Native，不因此改变现有 React Web 原型技术栈。

本次使用现有移动规则并查阅原始官方文档，没有自动安装外部 skill、SDK 或更改项目技术栈。

## 3. LogiNote 的输入状态

这是项目决定，不是把聊天产品的全部复杂功能搬过来：

1. 打开极简复述气泡，只显示**编辑框、“按住说话”、保存和关闭图标**。不显示标题、来源、模式切换、字数与说明提示；来源身份在内部保留。不主动聚焦编辑框，避免刚进入语音场景就弹键盘。
2. **点编辑框**：获得焦点，使用系统默认输入法；可以编辑已有文字。没有单独的“打字模式”按钮。
3. **按住说话**：超过 **280 ms** 后进入长按状态；未达到阈值的轻点只提示“按住说话”，不产生录音或空记录。
4. 长按中显示持续时间及“松手结束，上滑取消”。向上移动 **64 CSS px** 进入取消候选，返回区域可恢复；取消使用文字与图形反馈，不只变色。
5. 松手结束本次语音，进入识别/可编辑状态；**不自动保存或发给他人**。原生识别结果追加到本次草稿，用户校对后点击保存。
6. 上滑后松手、手势取消、失去捕获、切到后台、窗口失焦或关闭气泡：结束本次会话，保留原有文字，不把取消或中断当作成功。

280 ms 与 64 px 是当前原型的可调参数，需通过 Android/iPhone 真机、单手操作与无障碍测试再定；不能称为 Apple/Google 强制值。读屏/键盘操作应保留可访问的开始/结束替代方式，长按不是唯一输入途径。

## 4. 语音能力与权限边界

系统键盘的听写按钮由输入法管理，不能把网页中的任意长按按钮等同于唤起该按钮。正式“按住说话”需原生录音/识别适配层，或单独设计的 Web 采音方案；这与编辑框里的键盘听写是两条能力。

[Android SpeechRecognizer](https://developer.android.com/reference/android/speech/SpeechRecognizer)要求录音权限，部分实现可能将音频送往远端；[Apple Speech 授权](https://developer.apple.com/documentation/speech/sfspeechrecognizer/requestauthorization(_:))也有专门授权。不能笼统宣称系统识别一定离线、免费或不出设备。

权限在用户首次使用语音时请求，拒绝后仍可直接点击编辑框打字，不反复催促授权。[Android 权限原则](https://developer.android.com/training/permissions/requesting)明确要求上下文申请和拒绝后的可用退路。第三方转写涉及的资料披露与同意，仍按本项目上架准备文档处理。

权限/启动回执可能晚于松手：以本次会话标识和手指仍在按压的状态校验，失效会话不得迟到启动。识别结束、取消或离开页面后停止录音并释放资源，旧结果不写入新草稿。[Stream 官方仓库的异步长按问题](https://github.com/GetStream/stream-chat-flutter/issues/2536)可作为这类竞态的回归参考，而不是平台规范。

## 5. 第一阶段验证范围

原型只演示长按、时间反馈、松手与取消状态，明确标注未采音、未接入原生识别；不申请真实麦克风、不上传音频、不用固定文字冒充识别结果。用户可直接输入文字完成保存闭环。PC 浏览器只验证焦点与手势逻辑，不证明手机软键盘、麦克风权限或语音识别已验收。

正式版另测：权限首次允许/拒绝、按压中来电或后台、识别无结果/超时、快速按下松开、多点操作、长按与卡片滑动冲突、键盘遮挡、外接键盘、读屏替代操作，以及取消后无音频/文字误写。

# Android 课堂录音原生桥接

将本目录的三个 `.java` 文件复制到生成工程的 `android/app/src/main/java/app/loginote/mobile/`。将 `AndroidManifest.fragment.xml` 中权限合并到 `<manifest>`，服务声明合并到 `<application>`。

`MainActivity` 在 `super.onCreate()` 前注册插件：

```java
package app.loginote.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ClassroomRecorderPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
```

前端通过 `registerPlugin('ClassroomRecorder')` 调用：

- `start({ id, title })`：从前台用户动作触发；按需申请麦克风及 Android 13+ 通知权限，再进入 microphone 前台服务。
- `pause()`、`resume()`、`stop()`：操作当前录音，返回最新状态。`start()` 对相同进行中的 ID 幂等；不同进行中 ID 返回 `RECORDING_BUSY`，旧文件 ID 返回 `RECORDING_EXISTS`，不覆盖文件。
- `getStatus()`：返回当前录音，或最近一条持久状态。
- `listRecordings()`：返回 `{ recordings: [...] }`，供 WebView 重建后恢复未归档文件。
- `deleteRecording({ id })`：仅在用户确认删除后调用；只接受安全 ID，删除该 ID 在私有目录中的音频和索引，不接受路径，正在录制/暂停中的条目不可删除。重复删除已不存在的 ID 幂等。

状态字段：`id?`、`title?`、`state`（idle / recording / paused / stopped / interrupted）、`durationMs`、`fileUri?`、`error?`。原生还保留数值毫秒 `createdAt` 和 `updatedAt`，便于恢复排序。`fileUri` 为私有 `file:///` URI，可经 `Capacitor.convertFileSrc()` 在本机播放；不可直接将该路径作为跨设备附件 URL。

音频使用 AAC / MPEG-4 单声道，位于应用私有 `files/classroom-recordings/<id>.m4a`，每条对应独立 JSON 索引，以 AtomicFile 写入。录音期间每 5 秒存一次时长，暂停时长不计入音频。持续通知提供打开应用、暂停/继续及结束操作。没有开机接收器，不会在进程重启后自动开麦；服务使用 START_NOT_STICKY。

应用重启时，遗留 recording / paused 索引标为 interrupted，原始文件保留。若索引无法读取，但音频存在，会以恢复条目显示，不覆写损坏索引。系统强杀可能使最后一个 m4a 未完整封口；不能把“文件保留”解释为音频一定完整可播放。前端应展示 interrupted/error，允许用户确认恢复结果。只有显式 `deleteRecording({id})` 会删除私有录音文件；前端还应保存已删除 ID，避免先前异步扫描结果将已删除记录重新显示。

仅声明录音所需权限，不申请通讯录、位置、全盘存储或忽略电池优化。Android 13+ 拒绝通知权限不会授权隐藏通知：服务仍创建前台通知，系统按用户设置决定通知栏/活动应用中的呈现。没有麦克风权限则不开始录音。

需真机验证：权限拒绝与永久拒绝、切后台/锁屏一节课、暂停恢复、拍照 Activity 往返、系统中断/强杀、超短录音结束、低存储、手机来电及厂商电池策略。当前代码不调用 ASR 或网络服务。

官方依据：

- [Android 前台服务类型与麦克风要求](https://developer.android.com/about/versions/14/changes/fgs-types-required)
- [前台服务启动限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- [通知运行时权限](https://developer.android.com/develop/ui/views/notifications/notification-permission)
- [MediaRecorder 的暂停、恢复与停止错误语义](https://developer.android.com/reference/android/media/MediaRecorder)
- [Capacitor Android 插件与权限回调](https://capacitorjs.com/docs/plugins/android)

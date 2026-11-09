package app.loginote.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;

import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/** User-started microphone foreground service. Capture survives Activity/WebView suspension. */
public final class ClassroomRecorderService extends Service {
    static final String START = "app.loginote.mobile.recorder.START";
    static final String PAUSE = "app.loginote.mobile.recorder.PAUSE";
    static final String RESUME = "app.loginote.mobile.recorder.RESUME";
    static final String STOP = "app.loginote.mobile.recorder.STOP";
    private static final String CHANNEL = "loginote_classroom_recording";
    private static final int NOTIFICATION_ID = 7301;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final Map<String, Result> PENDING = new HashMap<>();
    private static ClassroomRecorderService instance;

    interface Result { void resolve(JSONObject value); void reject(String code, String message); }

    private RecorderStore store;
    private MediaRecorder recorder;
    private JSONObject status = RecorderStore.idle();
    private long accumulatedMs;
    private long intervalStart;
    private boolean foreground;

    private final Runnable checkpoint = new Runnable() {
        @Override public void run() {
            if (recorder == null) return;
            try { saveStatus(); } catch (Exception error) { interrupt("录音索引保存失败，已结束采集并保留音频。"); return; }
            MAIN.postDelayed(this, 5000);
        }
    };

    static void command(Context context, String action, String id, String title, Result result) {
        MAIN.post(() -> {
            if (!START.equals(action)) {
                if (instance == null) {
                    RecorderStore store = new RecorderStore(context);
                    store.recoverInterrupted();
                    if (STOP.equals(action)) result.resolve(store.last());
                    else result.reject("NO_ACTIVE_RECORDING", "没有正在运行的课堂录音。");
                    return;
                }
                instance.perform(action, result);
                return;
            }
            if (!RecorderStore.validId(id)) { result.reject("INVALID_RECORDING_ID", "录音编号无效。"); return; }
            if (instance != null && instance.recorder != null) {
                if (id.equals(instance.status.optString("id"))) result.resolve(instance.snapshot());
                else result.reject("RECORDING_BUSY", "已有课堂录音，请先结束当前录音。");
                return;
            }
            String request = UUID.randomUUID().toString();
            PENDING.put(request, result);
            Intent intent = new Intent(context, ClassroomRecorderService.class).setAction(START)
                .putExtra("request", request).putExtra("id", id).putExtra("title", title);
            try { ContextCompat.startForegroundService(context, intent); }
            catch (RuntimeException error) { PENDING.remove(request); result.reject("START_NOT_ALLOWED", "无法开始录音，请在应用前台重试并检查麦克风权限。"); return; }
            MAIN.postDelayed(() -> {
                Result pending = PENDING.remove(request);
                if (pending == null) return;
                if (instance != null) instance.interrupt("录音服务启动超时。");
                else context.stopService(new Intent(context, ClassroomRecorderService.class));
                pending.reject("START_TIMEOUT", "录音服务启动超时，未继续采集，请重试。");
            }, 15000);
        });
    }

    static void getStatus(Context context, Result result) {
        MAIN.post(() -> {
            if (instance != null && instance.recorder != null) result.resolve(instance.snapshot());
            else { RecorderStore store = new RecorderStore(context); store.recoverInterrupted(); result.resolve(store.last()); }
        });
    }

    static void list(Context context, java.util.function.Consumer<JSONArray> result) {
        MAIN.post(() -> {
            RecorderStore store = new RecorderStore(context);
            if (instance == null) store.recoverInterrupted();
            JSONArray all = store.list();
            if (instance != null && instance.recorder != null) {
                JSONObject live = instance.snapshot();
                for (int i = 0; i < all.length(); i++) if (live.optString("id").equals(all.optJSONObject(i).optString("id"))) {
                    try { all.put(i, live); } catch (org.json.JSONException ignored) { }
                }
            }
            result.accept(all);
        });
    }

    static void deleteRecording(Context context, String id, Result result) {
        MAIN.post(() -> {
            if (!RecorderStore.validId(id)) { result.reject("INVALID_RECORDING_ID", "录音编号无效。"); return; }
            if (instance != null && instance.recorder != null && id.equals(instance.status.optString("id"))) {
                result.reject("RECORDING_BUSY", "请先结束这条录音，再删除记录。"); return;
            }
            try { new RecorderStore(context).delete(id); result.resolve(new JSONObject()); }
            catch (Exception error) { result.reject("DELETE_FAILED", "录音文件未能全部删除，请稍后重试。"); }
        });
    }

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        store = new RecorderStore(this);
        store.recoverInterrupted();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "课堂录音", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("在锁屏或切换应用时保持用户启动的课堂录音。");
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        String action = intent.getAction();
        Result result = PENDING.remove(intent.getStringExtra("request"));
        if (result == null) result = new Result() {
            @Override public void resolve(JSONObject value) { }
            @Override public void reject(String code, String message) { }
        };
        if (START.equals(action)) startRecording(intent.getStringExtra("id"), intent.getStringExtra("title"), result);
        else perform(action, result);
        return START_NOT_STICKY; // Never restart microphone automatically after process death.
    }

    private void startRecording(String id, String title, Result result) {
        if (recorder != null) {
            if (id != null && id.equals(status.optString("id"))) result.resolve(snapshot());
            else result.reject("RECORDING_BUSY", "已有课堂录音。");
            return;
        }
        try {
            if (!RecorderStore.validId(id)) throw new IllegalArgumentException("Invalid id");
            if (store.exists(id)) { result.reject("RECORDING_EXISTS", "该录音编号已有文件，请先恢复已有录音。"); stopSelf(); return; }
            File output = store.audioFile(id);
            status = RecorderStore.idle();
            RecorderStore.put(status, "id", id);
            RecorderStore.put(status, "title", title == null || title.trim().isEmpty() ? "课堂录音" : title.substring(0, Math.min(title.length(), 120)));
            RecorderStore.put(status, "state", "recording");
            RecorderStore.put(status, "createdAt", System.currentTimeMillis());
            enterForeground(); // Meet the foreground deadline before MediaRecorder.prepare().
            recorder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? new MediaRecorder(this) : new MediaRecorder();
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioEncodingBitRate(96000);
            recorder.setAudioSamplingRate(44100);
            recorder.setAudioChannels(1);
            recorder.setOutputFile(output.getAbsolutePath());
            recorder.setOnErrorListener((value, what, extra) -> MAIN.post(() -> interrupt("录音设备发生异常，已保留原始文件。")));
            recorder.prepare();
            accumulatedMs = 0;
            recorder.start();
            intervalStart = SystemClock.elapsedRealtime();
            saveStatus();
            MAIN.postDelayed(checkpoint, 5000);
            result.resolve(snapshot());
        } catch (Exception error) {
            interrupt("录音未能正常开始，请检查权限、存储空间和麦克风占用。");
            result.reject("RECORDING_START_FAILED", "录音未能正常开始，请检查权限、存储空间和麦克风占用。");
        }
    }

    private void perform(String action, Result result) {
        if (recorder == null) {
            if (STOP.equals(action)) result.resolve(store.last());
            else result.reject("NO_ACTIVE_RECORDING", "没有正在运行的课堂录音。");
            if (!foreground) stopSelf();
            return;
        }
        try {
            String current = status.optString("state");
            if (PAUSE.equals(action) && "recording".equals(current)) {
                long total = duration();
                recorder.pause(); accumulatedMs = total; intervalStart = 0;
                RecorderStore.put(status, "state", "paused");
                saveStatus(); updateNotification();
            } else if (RESUME.equals(action) && "paused".equals(current)) {
                recorder.resume(); intervalStart = SystemClock.elapsedRealtime();
                RecorderStore.put(status, "state", "recording");
                saveStatus(); updateNotification();
            } else if (STOP.equals(action)) {
                finish(false, null);
            } else if (!PAUSE.equals(action) && !RESUME.equals(action)) {
                result.reject("UNKNOWN_ACTION", "无法识别录音操作。"); return;
            }
            result.resolve(snapshot());
        } catch (Exception error) {
            interrupt("录音操作失败，已结束采集并保留文件。");
            result.reject("RECORDING_OPERATION_FAILED", "录音操作失败，已结束采集并保留文件，请检查录音记录。");
        }
    }

    private long duration() {
        return accumulatedMs + ("recording".equals(status.optString("state")) && intervalStart > 0 ? Math.max(0, SystemClock.elapsedRealtime() - intervalStart) : 0);
    }

    private JSONObject snapshot() {
        JSONObject value = RecorderStore.copy(status);
        RecorderStore.put(value, "durationMs", duration());
        return store.normalized(value);
    }

    private void saveStatus() throws java.io.IOException {
        RecorderStore.put(status, "durationMs", duration());
        RecorderStore.put(status, "updatedAt", System.currentTimeMillis());
        store.save(status);
    }

    private void interrupt(String message) { finish(true, message); }

    private void finish(boolean interrupted, String message) {
        MAIN.removeCallbacks(checkpoint);
        accumulatedMs = duration(); intervalStart = 0;
        if (recorder != null) {
            try { recorder.stop(); }
            catch (RuntimeException error) { interrupted = true; message = "录音未完整封口，原始文件已保留，可能无法播放。"; }
            try { recorder.reset(); } catch (RuntimeException ignored) { }
            try { recorder.release(); }
            catch (RuntimeException error) { interrupted = true; message = "录音设备释放异常，原始文件已保留。"; }
            recorder = null;
        }
        RecorderStore.put(status, "state", interrupted ? "interrupted" : "stopped");
        if (message != null) RecorderStore.put(status, "error", message);
        if (RecorderStore.validId(status.optString("id"))) {
            try { saveStatus(); } catch (Exception error) { RecorderStore.put(status, "error", "录音已结束，但索引保存失败；音频文件已保留。"); }
        }
        leaveForeground(); stopSelf();
    }

    private PendingIntent serviceIntent(String action, int request) {
        return PendingIntent.getService(this, request, new Intent(this, ClassroomRecorderService.class).setAction(action), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification notification() {
        boolean paused = "paused".equals(status.optString("state"));
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) launch = new Intent();
        launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent open = PendingIntent.getActivity(this, 7300, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return builder.setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(paused ? "课堂录音已暂停" : "正在录制课堂")
            .setContentText(status.optString("title", "课堂录音"))
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_SERVICE)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .addAction(new Notification.Action.Builder(paused ? android.R.drawable.ic_media_play : android.R.drawable.ic_media_pause, paused ? "继续" : "暂停", serviceIntent(paused ? RESUME : PAUSE, 7302)).build())
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "结束", serviceIntent(STOP, 7303)).build())
            .build();
    }

    private void enterForeground() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        else startForeground(NOTIFICATION_ID, notification());
        foreground = true;
    }

    private void updateNotification() {
        try { getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification()); }
        catch (SecurityException ignored) { /* Notification denial must not turn a valid pause/resume into data loss. */ }
    }

    private void leaveForeground() { if (foreground) { stopForeground(STOP_FOREGROUND_REMOVE); foreground = false; } }

    @Override public void onDestroy() {
        if (recorder != null) finish(true, "录音服务被系统结束，原始文件已保留。");
        MAIN.removeCallbacks(checkpoint);
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}

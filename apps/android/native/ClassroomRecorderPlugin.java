package app.loginote.mobile;

import android.Manifest;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

/** Register in MainActivity before super.onCreate(). Permissions are requested only by start(). */
@CapacitorPlugin(name = "ClassroomRecorder", permissions = {
    @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public final class ClassroomRecorderPlugin extends Plugin {
    private ClassroomRecorderService.Result result(PluginCall call) {
        return new ClassroomRecorderService.Result() {
            @Override public void resolve(JSONObject value) {
                try { call.resolve(new JSObject(value.toString())); }
                catch (org.json.JSONException error) { call.reject("无法读取录音状态。", "STATUS_PARSE_FAILED"); }
            }
            @Override public void reject(String code, String message) { call.reject(message, code); }
        };
    }

    @PluginMethod public void start(PluginCall call) {
        if (!RecorderStore.validId(call.getString("id"))) { call.reject("录音编号无效。", "INVALID_RECORDING_ID"); return; }
        if (getActivity() == null || getActivity().isFinishing()) { call.reject("请在应用前台开始录音。", "ACTIVITY_REQUIRED"); return; }
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphoneResult");
            return;
        }
        requestNotificationsThenStart(call);
    }

    @PermissionCallback private void microphoneResult(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) { call.reject("需要麦克风权限才能录制课堂。", "MICROPHONE_DENIED"); return; }
        requestNotificationsThenStart(call);
    }

    private void requestNotificationsThenStart(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationResult");
        } else begin(call);
    }

    @PermissionCallback private void notificationResult(PluginCall call) {
        // Android permits an FGS after notification denial, but still requires its notification.
        begin(call);
    }

    private void begin(PluginCall call) {
        if (getActivity() == null || getActivity().isFinishing()) { call.reject("请在应用前台重试。", "ACTIVITY_REQUIRED"); return; }
        ClassroomRecorderService.command(getContext(), ClassroomRecorderService.START, call.getString("id"), call.getString("title", "课堂录音"), result(call));
    }

    @PluginMethod public void pause(PluginCall call) { ClassroomRecorderService.command(getContext(), ClassroomRecorderService.PAUSE, null, null, result(call)); }
    @PluginMethod public void resume(PluginCall call) { ClassroomRecorderService.command(getContext(), ClassroomRecorderService.RESUME, null, null, result(call)); }
    @PluginMethod public void stop(PluginCall call) { ClassroomRecorderService.command(getContext(), ClassroomRecorderService.STOP, null, null, result(call)); }
    @PluginMethod public void getStatus(PluginCall call) { ClassroomRecorderService.getStatus(getContext(), result(call)); }
    @PluginMethod public void listRecordings(PluginCall call) {
        ClassroomRecorderService.list(getContext(), values -> {
            JSObject result = new JSObject(); result.put("recordings", values); call.resolve(result);
        });
    }
    @PluginMethod public void deleteRecording(PluginCall call) {
        ClassroomRecorderService.deleteRecording(getContext(), call.getString("id"), result(call));
    }
}

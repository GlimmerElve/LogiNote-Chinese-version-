package app.loginote.mobile;

import android.content.Context;
import android.util.AtomicFile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Small native metadata index. Audio is never stored in WebView localStorage. */
final class RecorderStore {
    private static final String PREFS = "loginote_classroom_recorder";
    private static final String AUDIO_UNAVAILABLE = "录音文件不存在或为空，未生成可播放音频。";
    private final Context context;
    private final File directory;

    RecorderStore(Context context) {
        this.context = context.getApplicationContext();
        this.directory = new File(this.context.getFilesDir(), "classroom-recordings");
    }

    static boolean validId(String id) {
        return id != null && id.matches("[A-Za-z0-9_-]{1,80}");
    }

    File audioFile(String id) throws IOException {
        if (!validId(id)) throw new IOException("Invalid recording id");
        if (!directory.exists() && !directory.mkdirs()) throw new IOException("Cannot create recording directory");
        return new File(directory, id + ".m4a");
    }

    boolean exists(String id) throws IOException {
        return audioFile(id).exists() || new File(directory, id + ".json").exists();
    }

    void delete(String id) throws IOException {
        if (!validId(id)) throw new IOException("Invalid recording id");
        // Never accept a caller-supplied path. Every target is an exact child of our private directory.
        for (String suffix : new String[] { ".m4a", ".json", ".json.bak", ".json.new" }) {
            File target = new File(directory, id + suffix);
            if (target.exists() && !target.delete()) throw new IOException("Cannot delete private recording file");
        }
        if (id.equals(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("lastId", ""))) {
            if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("lastId").commit()) {
                throw new IOException("Recording deleted, but last-recording pointer could not be cleared");
            }
        }
    }

    void save(JSONObject status) throws IOException {
        String id = status.optString("id", "");
        audioFile(id); // Validate the identifier and ensure the private directory exists.
        JSONObject persisted = normalized(status);
        AtomicFile file = new AtomicFile(new File(directory, id + ".json"));
        FileOutputStream stream = null;
        try {
            stream = file.startWrite();
            stream.write(persisted.toString().getBytes(StandardCharsets.UTF_8));
            file.finishWrite(stream);
        } catch (IOException error) {
            if (stream != null) file.failWrite(stream);
            throw error;
        }
        if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("lastId", id).commit()) {
            throw new IOException("Cannot persist recording pointer");
        }
    }

    JSONObject load(String id) {
        if (!validId(id)) return null;
        AtomicFile file = new AtomicFile(new File(directory, id + ".json"));
        try (FileInputStream input = file.openRead()) {
            byte[] bytes = new byte[(int) Math.min(input.getChannel().size(), 1024 * 1024)];
            int offset = 0, size;
            while (offset < bytes.length && (size = input.read(bytes, offset, bytes.length - offset)) != -1) offset += size;
            JSONObject data = new JSONObject(new String(bytes, 0, offset, StandardCharsets.UTF_8));
            return id.equals(data.optString("id")) ? normalized(data) : null;
        } catch (IOException | JSONException error) {
            return null; // Preserve unreadable metadata; do not replace the original file.
        }
    }

    JSONObject last() {
        JSONObject last = load(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("lastId", ""));
        if (last != null) return last;
        JSONArray all = list();
        return all.length() > 0 ? all.optJSONObject(0) : idle();
    }

    JSONArray list() {
        List<JSONObject> records = new ArrayList<>();
        Set<String> indexed = new HashSet<>();
        File[] files = directory.listFiles();
        if (files != null) {
            for (File file : files) {
                if (!file.getName().endsWith(".json")) continue;
                String id = file.getName().substring(0, file.getName().length() - 5);
                JSONObject record = load(id);
                if (record != null) { records.add(record); indexed.add(id); }
            }
            for (File file : files) {
                if (!file.getName().endsWith(".m4a")) continue;
                String id = file.getName().substring(0, file.getName().length() - 4);
                if (!validId(id) || indexed.contains(id)) continue;
                JSONObject recovered = new JSONObject();
                put(recovered, "id", id);
                put(recovered, "title", "恢复的录音");
                put(recovered, "state", "interrupted");
                put(recovered, "durationMs", 0);
                put(recovered, "fileUri", android.net.Uri.fromFile(file).toString());
                put(recovered, "updatedAt", file.lastModified());
                put(recovered, "error", "录音索引不可用，原始音频已保留，请检查播放。");
                records.add(normalized(recovered));
            }
        }
        records.sort(Comparator.comparingLong((JSONObject value) -> value.optLong("updatedAt")).reversed());
        JSONArray array = new JSONArray();
        for (JSONObject record : records) array.put(record);
        return array;
    }

    /** Called only when this process has no recorder service. Never restart capture here. */
    void recoverInterrupted() {
        JSONArray all = list();
        for (int i = 0; i < all.length(); i++) {
            JSONObject value = all.optJSONObject(i);
            if (value == null) continue;
            String state = value.optString("state");
            if (!"recording".equals(state) && !"paused".equals(state)) continue;
            put(value, "state", "interrupted");
            put(value, "error", "录音进程曾被系统中断，原始文件已保留，音频完整性需检查。");
            put(value, "updatedAt", System.currentTimeMillis());
            try { save(value); } catch (IOException ignored) { /* Never delete audio when metadata recovery fails. */ }
        }
    }

    static JSONObject idle() {
        JSONObject value = new JSONObject();
        put(value, "state", "idle");
        put(value, "durationMs", 0);
        return value;
    }

    /** Publish a URI only for a nonempty file owned by this recording ID. */
    JSONObject normalized(JSONObject original) {
        JSONObject value = copy(original);
        String id = value.optString("id", "");
        if (!validId(id)) { value.remove("fileUri"); return value; }
        File audio = new File(directory, id + ".m4a");
        if (audio.isFile() && audio.length() > 0) {
            put(value, "fileUri", android.net.Uri.fromFile(audio).toString());
            if (AUDIO_UNAVAILABLE.equals(value.optString("error"))) value.remove("error");
        } else {
            value.remove("fileUri");
            String state = value.optString("state", "");
            if ("stopped".equals(state) || "interrupted".equals(state)) {
                if (value.optString("error", "").isEmpty()) put(value, "error", AUDIO_UNAVAILABLE);
            } else if (AUDIO_UNAVAILABLE.equals(value.optString("error"))) {
                value.remove("error"); // A newly started encoder may not have flushed bytes yet.
            }
        }
        return value;
    }

    static JSONObject copy(JSONObject value) {
        try { return new JSONObject(value.toString()); } catch (JSONException error) { return idle(); }
    }

    static void put(JSONObject value, String key, Object item) {
        try { value.put(key, item); } catch (JSONException error) { throw new IllegalArgumentException(error); }
    }
}

package app.loginote.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ClassroomRecorderPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

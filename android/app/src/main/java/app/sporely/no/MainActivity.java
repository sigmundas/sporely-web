package app.sporely.no;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativePhotoPickerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

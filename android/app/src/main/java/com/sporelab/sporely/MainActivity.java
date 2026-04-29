package com.sporelab.sporely;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativePhotoPickerPlugin.class);
        registerPlugin(NativeCameraPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

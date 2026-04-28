package com.sporelab.sporely;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativePhotoPickerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

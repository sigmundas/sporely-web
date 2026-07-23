package com.sporelab.sporely;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int LOCATION_PERMISSION_REQUEST_CODE = 4711;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativePhotoPickerPlugin.class);
        registerPlugin(NativeCameraPlugin.class);
        registerPlugin(UploadSyncServicePlugin.class);
        registerPlugin(LocationSettingsPlugin.class);
        super.onCreate(savedInstanceState);

        maybeRequestLocationPermission();
    }

    private void maybeRequestLocationPermission() {
        boolean fineGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
        boolean coarseGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
        if (fineGranted || coarseGranted) return;

        ActivityCompat.requestPermissions(
                this,
                new String[]{
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION,
                },
                LOCATION_PERMISSION_REQUEST_CODE
        );
    }
}

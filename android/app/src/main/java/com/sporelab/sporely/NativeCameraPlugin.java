package com.sporelab.sporely;

import android.app.Activity;
import android.content.Intent;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;

@CapacitorPlugin(name = "NativeCamera")
public class NativeCameraPlugin extends Plugin {

    @PluginMethod
    public void capturePhotos(PluginCall call) {
        Intent intent = new Intent(getActivity(), NativeCameraActivity.class);
        JSObject gps = call.getObject("gps");
        if (gps != null) {
            intent.putExtra(NativeCameraActivity.EXTRA_GPS_JSON, gps.toString());
        }
        startActivityForResult(call, intent, "handleNativeCameraResult");
    }

    @ActivityCallback
    private void handleNativeCameraResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK) {
            call.reject("User cancelled", "CANCELLED");
            return;
        }

        try {
            Intent data = result.getData();
            String photosJson = data != null ? data.getStringExtra(NativeCameraActivity.EXTRA_PHOTOS_JSON) : null;
            JSONArray photos = photosJson != null ? new JSONArray(photosJson) : new JSONArray();

            JSObject ret = new JSObject();
            ret.put("photos", photos);
            call.resolve(ret);
        } catch (Exception ex) {
            call.reject("Sporely camera result failed", ex);
        }
    }
}

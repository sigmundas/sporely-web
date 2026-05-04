package com.sporelab.sporely;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.MediaStore;
import androidx.core.content.FileProvider;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import java.io.File;

@CapacitorPlugin(name = "NativeCamera")
public class NativeCameraPlugin extends Plugin {

    private String systemCameraFilePath;

    @PluginMethod
    public void capturePhotos(PluginCall call) {
        Intent intent = new Intent(getActivity(), NativeCameraActivity.class);
        
        Boolean useHdr = call.getBoolean("useHdr", false);
        intent.putExtra("useHdr", useHdr != null ? useHdr : false);

        Integer jpegQuality = call.getInt("jpegQuality", 95);
        intent.putExtra("jpegQuality", jpegQuality != null ? jpegQuality : 95);

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

    @PluginMethod
    public void openSystemCamera(PluginCall call) {
        Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        if (intent.resolveActivity(getContext().getPackageManager()) != null) {
            try {
                File photoFile = File.createTempFile("system_cam_", ".jpg", getContext().getCacheDir());
                systemCameraFilePath = photoFile.getAbsolutePath();
                Uri photoURI = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", photoFile);
                intent.putExtra(MediaStore.EXTRA_OUTPUT, photoURI);
                startActivityForResult(call, intent, "handleSystemCameraResult");
            } catch (Exception ex) {
                call.reject("Could not create temp file for system camera", ex);
            }
        } else {
            call.reject("No system camera app found");
        }
    }

    @ActivityCallback
    private void handleSystemCameraResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK) {
            call.reject("User cancelled", "CANCELLED");
            return;
        }
        try {
            JSObject photo = new JSObject();
            photo.put("path", systemCameraFilePath);
            photo.put("originalPath", systemCameraFilePath);
            photo.put("mimeType", "image/jpeg");
            photo.put("format", "jpeg");
            
            JSONArray photos = new JSONArray();
            photos.put(photo);
            
            JSObject ret = new JSObject();
            ret.put("photos", photos);
            call.resolve(ret);
        } catch (Exception ex) {
            call.reject("System camera result failed", ex);
        }
    }
}

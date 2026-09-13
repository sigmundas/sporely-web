package com.sporelab.sporely;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.MediaStore;
import androidx.core.content.FileProvider;
import androidx.exifinterface.media.ExifInterface;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import java.io.File;
import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(name = "NativeCamera")
public class NativeCameraPlugin extends Plugin {

    private String systemCameraFilePath;

    @PluginMethod
    public void capturePhotos(PluginCall call) {
        Intent intent = new Intent(getActivity(), NativeCameraActivity.class);

        Integer jpegQuality = call.getInt("jpegQuality", 75);
        intent.putExtra("jpegQuality", jpegQuality != null ? jpegQuality : 75);

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

    // ── Capture storage lifecycle (called by JS only after durable enqueue) ──

    /**
     * Copies a Sporely Cam capture (original bytes, EXIF/GPS intact) into the photo library
     * under Pictures/Sporely via MediaStore. Only files inside cache/native-camera with the
     * sporely-native-* name are accepted.
     */
    @PluginMethod
    public void exportCaptureToGallery(PluginCall call) {
        String path = call.getString("path");
        try {
            Uri uri = NativeCaptureStorage.exportCaptureToGallery(getContext(), path);
            JSObject ret = new JSObject();
            ret.put("uri", uri.toString());
            call.resolve(ret);
        } catch (UnsupportedOperationException ex) {
            call.reject(ex.getMessage(), "UNSUPPORTED");
        } catch (Exception ex) {
            call.reject("Could not save original to the phone: " + ex.getMessage(), "EXPORT_FAILED", ex);
        }
    }

    /** Deletes one Sporely Cam capture from cache/native-camera. Refuses any other path. */
    @PluginMethod
    public void deleteCapture(PluginCall call) {
        String path = call.getString("path");
        try {
            boolean deleted = NativeCaptureStorage.deleteCapture(getContext(), path);
            JSObject ret = new JSObject();
            ret.put("deleted", deleted);
            call.resolve(ret);
        } catch (Exception ex) {
            call.reject("Could not delete capture: " + ex.getMessage(), "DELETE_FAILED", ex);
        }
    }

    /**
     * Best-effort removal of stranded captures older than maxAgeMs (default 48h). Only
     * sporely-native-* files in cache/native-camera are considered. Captures listed in
     * protectedPaths (still referenced by a persisted review draft) are kept regardless of
     * age; every protected entry is re-validated natively. Never rejects on per-file
     * failures; counters are returned for debugging.
     */
    @PluginMethod
    public void pruneStaleCaptures(PluginCall call) {
        Double maxAgeMsValue = call.getDouble("maxAgeMs");
        long maxAgeMs = maxAgeMsValue != null && maxAgeMsValue >= 0
            ? maxAgeMsValue.longValue()
            : NativeCaptureStorage.DEFAULT_STALE_AFTER_MS;
        List<String> protectedPaths = new ArrayList<>();
        JSArray protectedArray = call.getArray("protectedPaths");
        if (protectedArray != null) {
            for (int i = 0; i < protectedArray.length(); i++) {
                String value = protectedArray.optString(i, null);
                if (value != null) protectedPaths.add(value);
            }
        }
        NativeCaptureStorage.PruneResult result = NativeCaptureStorage.pruneStaleCaptures(getContext(), maxAgeMs, protectedPaths);
        JSObject ret = new JSObject();
        ret.put("scanned", result.scanned);
        ret.put("deleted", result.deleted);
        ret.put("retained", result.retained);
        ret.put("protectedRetained", result.protectedRetained);
        ret.put("protectedIgnored", result.protectedIgnored);
        ret.put("skipped", result.skipped);
        ret.put("failed", result.failed);
        call.resolve(ret);
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
            File photoFile = systemCameraFilePath != null ? new File(systemCameraFilePath) : null;
            JSObject exif = new JSObject();
            if (photoFile != null && photoFile.exists()) {
                try {
                    ExifInterface fileExif = new ExifInterface(photoFile.getAbsolutePath());
                    exif.put("Orientation", fileExif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL));
                } catch (Exception ignored) {}
            }

            JSObject photo = new JSObject();
            photo.put("path", systemCameraFilePath);
            photo.put("originalPath", systemCameraFilePath);
            photo.put("name", photoFile != null ? photoFile.getName() : "system-camera.jpg");
            photo.put("mimeType", "image/jpeg");
            photo.put("originalMimeType", "image/jpeg");
            photo.put("format", "jpeg");
            photo.put("originalFormat", "jpeg");
            photo.put("converted", false);
            photo.put("exif", exif);
            
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

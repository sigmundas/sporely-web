package com.sporelab.sporely;

import android.Manifest;
import android.content.Intent;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/**
 * JS-facing controls for {@link UploadSyncService}. The sync queue starts the
 * service when it begins draining and stops it when the queue is empty, so
 * uploads keep running if the user backgrounds the app or the screen turns off.
 *
 * The "notifications" permission alias only affects whether the progress
 * notification is visible on Android 13+; the service runs either way.
 */
@CapacitorPlugin(
    name = "UploadSyncService",
    permissions = @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
)
public class UploadSyncServicePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        try {
            ContextCompat.startForegroundService(getContext(), buildServiceIntent(call));
            call.resolve();
        } catch (Exception e) {
            // Android 12+ refuses foreground-service starts while the app is in
            // the background; the queue falls back to foreground-only syncing.
            call.reject("Foreground service start not allowed", "START_NOT_ALLOWED", e);
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        try {
            // Plain startService: the service is already in the foreground, so
            // this just delivers the new notification text via onStartCommand.
            getContext().startService(buildServiceIntent(call));
            call.resolve();
        } catch (Exception e) {
            call.reject("Foreground service update failed", "UPDATE_FAILED", e);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), UploadSyncService.class));
            call.resolve();
        } catch (Exception e) {
            call.reject("Foreground service stop failed", "STOP_FAILED", e);
        }
    }

    private Intent buildServiceIntent(PluginCall call) {
        Intent intent = new Intent(getContext(), UploadSyncService.class);
        intent.putExtra(UploadSyncService.EXTRA_TITLE, call.getString("title"));
        intent.putExtra(UploadSyncService.EXTRA_TEXT, call.getString("text"));
        return intent;
    }
}

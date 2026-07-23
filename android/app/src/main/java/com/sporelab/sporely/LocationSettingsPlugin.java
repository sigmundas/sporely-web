package com.sporelab.sporely;

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Opens the Android settings screens the user needs to turn location back on.
 *
 * openLocationSettings() tries the system Location toggle screen first (that
 * is where the toggle they flipped lives), then falls back to this app's
 * details page (where the location permission for Sporely lives). If both
 * intents fail to resolve, resolves with { opened: "none" } so the JS side
 * can degrade to instructions.
 */
@CapacitorPlugin(name = "LocationSettings")
public class LocationSettingsPlugin extends Plugin {

    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        String opened = tryStart(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS))
                ? "system"
                : (tryStart(appDetailsIntent()) ? "app" : "none");
        JSObject result = new JSObject();
        result.put("opened", opened);
        call.resolve(result);
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        JSObject result = new JSObject();
        result.put("opened", tryStart(appDetailsIntent()) ? "app" : "none");
        call.resolve(result);
    }

    private Intent appDetailsIntent() {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
        return intent;
    }

    private boolean tryStart(Intent intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            if (intent.resolveActivity(getContext().getPackageManager()) == null) return false;
            getContext().startActivity(intent);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }
}

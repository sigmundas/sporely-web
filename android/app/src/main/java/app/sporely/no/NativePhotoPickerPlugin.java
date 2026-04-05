package app.sporely.no;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import androidx.exifinterface.media.ExifInterface;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(name = "NativePhotoPicker")
public class NativePhotoPickerPlugin extends Plugin {

    @PluginMethod
    public void pickImages(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "handlePickedImages");
    }

    @ActivityCallback
    private void handlePickedImages(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK) {
            call.reject("User cancelled", "CANCELLED");
            return;
        }

        Intent data = result.getData();
        List<Uri> uris = collectUris(data);
        JSArray photos = new JSArray();
        for (Uri uri : uris) {
            JSObject photo = buildPhotoObject(uri);
            if (photo != null) photos.put(photo);
        }

        JSObject ret = new JSObject();
        ret.put("photos", photos);
        call.resolve(ret);
    }

    private List<Uri> collectUris(Intent data) {
        List<Uri> uris = new ArrayList<>();
        if (data == null) return uris;

        if (data.getClipData() != null) {
            for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                Uri uri = data.getClipData().getItemAt(i).getUri();
                if (uri != null) uris.add(uri);
            }
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        return uris;
    }

    private JSObject buildPhotoObject(Uri uri) {
        try {
            ContentResolver resolver = getContext().getContentResolver();
            try {
                resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {}

            String mimeType = resolver.getType(uri);
            String displayName = queryDisplayName(uri);
            String format = inferFormat(displayName, mimeType);

            JSObject exifJson = new JSObject();
            try (InputStream stream = resolver.openInputStream(uri)) {
                if (stream != null) {
                    ExifInterface exif = new ExifInterface(stream);
                    float[] latLong = new float[2];
                    if (exif.getLatLong(latLong)) {
                        exifJson.put("latitude", latLong[0]);
                        exifJson.put("longitude", latLong[1]);
                    }

                    String dateTimeOriginal = exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL);
                    String dateTime = exif.getAttribute(ExifInterface.TAG_DATETIME);
                    if (dateTimeOriginal != null) exifJson.put("DateTimeOriginal", dateTimeOriginal);
                    if (dateTime != null) exifJson.put("CreateDate", dateTime);

                    double altitude = exif.getAltitude(Double.NaN);
                    if (!Double.isNaN(altitude)) exifJson.put("GPSAltitude", altitude);
                }
            }

            JSObject photo = new JSObject();
            photo.put("path", uri.toString());
            photo.put("name", displayName);
            photo.put("mimeType", mimeType);
            photo.put("format", format);
            photo.put("exif", exifJson);
            return photo;
        } catch (Exception ex) {
            return null;
        }
    }

    private String queryDisplayName(Uri uri) {
        Cursor cursor = null;
        try {
            cursor = getContext().getContentResolver().query(
                uri,
                new String[] { OpenableColumns.DISPLAY_NAME },
                null,
                null,
                null
            );
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) return cursor.getString(idx);
            }
        } catch (Exception ignored) {
        } finally {
            if (cursor != null) cursor.close();
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : "imported-image";
    }

    private String inferFormat(String displayName, String mimeType) {
        if (mimeType != null) {
            if ("image/heic".equalsIgnoreCase(mimeType)) return "heic";
            if ("image/heif".equalsIgnoreCase(mimeType)) return "heif";
            if ("image/jpeg".equalsIgnoreCase(mimeType)) return "jpeg";
            if ("image/png".equalsIgnoreCase(mimeType)) return "png";
            if ("image/webp".equalsIgnoreCase(mimeType)) return "webp";
        }
        if (displayName != null) {
            String lower = displayName.toLowerCase();
            int dot = lower.lastIndexOf('.');
            if (dot >= 0 && dot < lower.length() - 1) return lower.substring(dot + 1);
        }
        return "jpeg";
    }
}

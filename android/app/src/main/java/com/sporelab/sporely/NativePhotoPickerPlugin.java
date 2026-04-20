package com.sporelab.sporely;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
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
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(name = "NativePhotoPicker")
public class NativePhotoPickerPlugin extends Plugin {

    // Max edge length for decoded bitmap. 4000px covers 12 MP at full res;
    // 50 MP phones are downsampled 2x via inSampleSize before this cap.
    private static final int MAX_EDGE_PX = 4000;

    @PluginMethod
    public void pickImages(PluginCall call) {
        Intent intent;
        // Use the document/content picker instead of Android's newer Photo Picker.
        // Photo Picker URIs can expose redacted EXIF GPS on Android 13+, while
        // ACTION_OPEN_DOCUMENT gives us a normal readable URI for metadata import.
        intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
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
            persistReadPermission(data, uri);
            JSObject photo = buildPhotoObject(uri);
            if (photo != null) photos.put(photo);
        }

        JSObject ret = new JSObject();
        ret.put("photos", photos);
        call.resolve(ret);
    }

    private void persistReadPermission(Intent data, Uri uri) {
        if (data == null || uri == null) return;
        int flags = data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION;
        if (flags == 0) return;
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, flags);
        } catch (SecurityException ignored) {
            // Some providers grant temporary read access only; immediate cache import still works.
        }
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
            String mimeType = resolver.getType(uri);
            String displayName = queryDisplayName(uri);
            String format = inferFormat(displayName, mimeType);

            // Read EXIF metadata (GPS, timestamps, orientation). On Android 10+,
            // GPS can be redacted unless the original media URI is explicitly requested.
            JSObject exifJson = new JSObject();
            int exifOrientation = ExifInterface.ORIENTATION_NORMAL;
            try (InputStream stream = openExifInputStream(uri, resolver)) {
                if (stream != null) {
                    ExifInterface exif = new ExifInterface(stream);
                    float[] latLong = new float[2];
                    if (exif.getLatLong(latLong)) {
                        if (isUsableCoordinate(latLong[0], latLong[1])) {
                            exifJson.put("latitude", latLong[0]);
                            exifJson.put("longitude", latLong[1]);
                        }
                    }
                    String dateTimeOriginal = exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL);
                    String dateTime = exif.getAttribute(ExifInterface.TAG_DATETIME);
                    if (dateTimeOriginal != null) exifJson.put("DateTimeOriginal", dateTimeOriginal);
                    if (dateTime != null) exifJson.put("CreateDate", dateTime);
                    double altitude = exif.getAltitude(Double.NaN);
                    if (!Double.isNaN(altitude)) exifJson.put("GPSAltitude", altitude);
                    exifOrientation = exif.getAttributeInt(
                        ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
                }
            } catch (Exception ignored) {}

            // Convert HEIC/HEIF to JPEG on the Java side (hardware-accelerated).
            // This avoids the slow pure-JS heic2any decoder entirely.
            boolean isHeic = "image/heic".equalsIgnoreCase(mimeType)
                || "image/heif".equalsIgnoreCase(mimeType)
                || "heic".equalsIgnoreCase(format)
                || "heif".equalsIgnoreCase(format);

            String returnPath = uri.toString();
            String returnMime = mimeType;
            String returnFormat = format;

            if (isHeic) {
                try {
                    File jpegFile = decodeAndConvertToJpeg(uri, resolver, exifOrientation);
                    returnPath = jpegFile.getAbsolutePath();
                    returnMime = "image/jpeg";
                    returnFormat = "jpeg";
                } catch (Exception ex) {
                    // Conversion failed — fall through to original URI; browser will attempt to handle it
                }
            }

            JSObject photo = new JSObject();
            photo.put("path", returnPath);
            photo.put("originalPath", uri.toString());
            photo.put("name", displayName);
            photo.put("mimeType", returnMime);
            photo.put("originalMimeType", mimeType);
            photo.put("format", returnFormat);
            photo.put("originalFormat", format);
            photo.put("converted", isHeic && "image/jpeg".equals(returnMime));
            photo.put("exif", exifJson);
            return photo;
        } catch (Exception ex) {
            return null;
        }
    }

    private static boolean isUsableCoordinate(double latitude, double longitude) {
        if (Double.isNaN(latitude) || Double.isNaN(longitude)) return false;
        if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return false;
        return !(Math.abs(latitude) < 0.000001 && Math.abs(longitude) < 0.000001);
    }

    private InputStream openExifInputStream(Uri uri, ContentResolver resolver) throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                return resolver.openInputStream(MediaStore.setRequireOriginal(uri));
            } catch (SecurityException | UnsupportedOperationException ignored) {
                // Fall back to the normal URI; it may be location-redacted.
            }
        }
        return resolver.openInputStream(uri);
    }

    /**
     * Decode an image URI to a Bitmap, apply EXIF rotation, and write a JPEG
     * to the app cache directory. Returns the cache File.
     */
    private File decodeAndConvertToJpeg(Uri uri, ContentResolver resolver, int orientation)
            throws IOException {
        // First pass: get dimensions so we can choose an inSampleSize
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inJustDecodeBounds = true;
        try (InputStream probe = resolver.openInputStream(uri)) {
            if (probe != null) BitmapFactory.decodeStream(probe, null, opts);
        }

        // Compute inSampleSize so decoded size is close to but not below MAX_EDGE_PX
        int rawMax = Math.max(opts.outWidth, opts.outHeight);
        opts.inJustDecodeBounds = false;
        opts.inSampleSize = 1;
        while (rawMax / (opts.inSampleSize * 2) >= MAX_EDGE_PX) {
            opts.inSampleSize *= 2;
        }

        Bitmap bitmap;
        try (InputStream stream = resolver.openInputStream(uri)) {
            if (stream == null) throw new IOException("Could not open stream for " + uri);
            bitmap = BitmapFactory.decodeStream(stream, null, opts);
        }
        if (bitmap == null) throw new IOException("BitmapFactory returned null for " + uri);

        // Apply EXIF rotation so the image is correctly oriented
        int degrees = exifOrientationToDegrees(orientation);
        if (degrees != 0) {
            Matrix matrix = new Matrix();
            matrix.postRotate(degrees);
            Bitmap rotated = Bitmap.createBitmap(
                bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
            bitmap.recycle();
            bitmap = rotated;
        }

        File cacheFile = File.createTempFile("sporely_pick_", ".jpg", getContext().getCacheDir());
        try (FileOutputStream fos = new FileOutputStream(cacheFile)) {
            bitmap.compress(Bitmap.CompressFormat.JPEG, 90, fos);
        }
        bitmap.recycle();
        return cacheFile;
    }

    private static int exifOrientationToDegrees(int orientation) {
        switch (orientation) {
            case ExifInterface.ORIENTATION_ROTATE_90:  return 90;
            case ExifInterface.ORIENTATION_ROTATE_180: return 180;
            case ExifInterface.ORIENTATION_ROTATE_270: return 270;
            default: return 0;
        }
    }

    private String queryDisplayName(Uri uri) {
        Cursor cursor = null;
        try {
            cursor = getContext().getContentResolver().query(
                uri,
                new String[] { OpenableColumns.DISPLAY_NAME },
                null, null, null
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

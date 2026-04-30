package com.sporelab.sporely;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.location.Location;
import android.os.Build;
import android.os.Bundle;
import android.util.SizeF;
import android.view.Gravity;
import android.view.Surface;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.camera2.interop.Camera2CameraInfo;
import androidx.camera.camera2.interop.Camera2Interop;
import androidx.camera.core.CameraInfo;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.exifinterface.media.ExifInterface;
import com.google.common.util.concurrent.ListenableFuture;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

@SuppressWarnings("deprecation")
public class NativeCameraActivity extends AppCompatActivity {
    public static final String EXTRA_GPS_JSON = "com.sporelab.sporely.NativeCamera.GPS";
    public static final String EXTRA_PHOTOS_JSON = "com.sporelab.sporely.NativeCamera.PHOTOS";

    private static final int REQUEST_CAMERA_PERMISSION = 41;
    private static final double FULL_FRAME_DIAGONAL_MM = 43.2666153;
    private static final int SPORELY_GREEN = Color.rgb(88, 155, 82);
    private static final int SPORELY_GREEN_DARK = Color.rgb(38, 72, 43);
    private static final int CONTROLS_BOTTOM_PADDING_DP = 112;
    private static final int BATCH_STACK_BOTTOM_MARGIN_DP = 210;
    private static final int ACTION_BUTTON_HEIGHT_DP = 44;

    private PreviewView previewView;
    private FrameLayout batchStack;
    private TextView countBadge;
    private ProcessCameraProvider cameraProvider;
    private ImageCapture imageCapture;
    private Location captureLocation;
    private boolean canceled = false;
    private final ArrayList<File> capturedFiles = new ArrayList<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        captureLocation = parseLocation(getIntent().getStringExtra(EXTRA_GPS_JSON));
        buildLayout();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                finishCanceled();
            }
        });

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startCamera();
        } else {
            ActivityCompat.requestPermissions(this, new String[] { Manifest.permission.CAMERA }, REQUEST_CAMERA_PERMISSION);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_CAMERA_PERMISSION
            && grantResults.length > 0
            && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            startCamera();
            return;
        }
        finishCanceled();
    }

    private void buildLayout() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        previewView = new PreviewView(this);
        previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        root.addView(previewView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        LinearLayout controls = new LinearLayout(this);
        controls.setOrientation(LinearLayout.HORIZONTAL);
        controls.setGravity(Gravity.CENTER);
        controls.setPadding(dp(22), dp(10), dp(22), dp(CONTROLS_BOTTOM_PADDING_DP));

        TextView cancel = makeActionButton("Cancel", false);
        TextView shutter = makeShutterButton();
        TextView done = makeActionButton("Done", true);
        batchStack = makeBatchStack();
        batchStack.setVisibility(FrameLayout.GONE);

        cancel.setOnClickListener(v -> {
            finishCanceled();
        });
        shutter.setOnClickListener(v -> capturePhoto());
        done.setOnClickListener(v -> finishWithPhotos());

        LinearLayout shutterStack = new LinearLayout(this);
        shutterStack.setOrientation(LinearLayout.VERTICAL);
        shutterStack.setGravity(Gravity.CENTER);
        shutterStack.addView(shutter, new LinearLayout.LayoutParams(dp(82), dp(82)));

        controls.addView(cancel, actionButtonParams());
        controls.addView(shutterStack, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.1f));
        controls.addView(done, actionButtonParams());

        FrameLayout.LayoutParams controlParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM
        );
        root.addView(controls, controlParams);
        FrameLayout.LayoutParams batchParams = new FrameLayout.LayoutParams(dp(54), dp(54), Gravity.BOTTOM | Gravity.END);
        batchParams.setMargins(0, 0, dp(28), dp(BATCH_STACK_BOTTOM_MARGIN_DP));
        root.addView(batchStack, batchParams);
        setContentView(root);
    }

    private FrameLayout makeBatchStack() {
        FrameLayout stack = new FrameLayout(this);
        stack.addView(makeMushroomTile(-4f), makeTileParams(6, 0));
        stack.addView(makeMushroomTile(-1f), makeTileParams(3, 4));

        countBadge = new TextView(this);
        countBadge.setTextColor(Color.rgb(13, 17, 9));
        countBadge.setGravity(Gravity.CENTER);
        countBadge.setText("0");
        countBadge.setTextSize(11);
        countBadge.setTypeface(Typeface.DEFAULT_BOLD);
        countBadge.setBackground(makeRoundedBackground(SPORELY_GREEN, 10, 0, Color.TRANSPARENT));
        FrameLayout.LayoutParams badgeParams = new FrameLayout.LayoutParams(dp(20), dp(20), Gravity.END | Gravity.BOTTOM);
        stack.addView(countBadge, badgeParams);
        return stack;
    }

    private FrameLayout.LayoutParams makeTileParams(float left, float top) {
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(dp(36), dp(36));
        params.setMargins(dp(left), dp(top), 0, 0);
        return params;
    }

    private TextView makeMushroomTile(float rotation) {
        TextView tile = new TextView(this);
        tile.setText("\uD83C\uDF44");
        tile.setTextSize(16);
        tile.setGravity(Gravity.CENTER);
        tile.setRotation(rotation);
        tile.setBackground(makeRoundedBackground(Color.rgb(32, 40, 28), 8, 2, Color.argb(40, 255, 255, 255)));
        return tile;
    }

    private TextView makeActionButton(String label, boolean primary) {
        TextView button = new TextView(this);
        button.setText(label);
        button.setGravity(Gravity.CENTER);
        button.setTextSize(15);
        button.setTypeface(Typeface.DEFAULT_BOLD);
        button.setMinHeight(dp(ACTION_BUTTON_HEIGHT_DP));
        button.setPadding(dp(16), 0, dp(16), 0);
        if (primary) {
            button.setTextColor(Color.WHITE);
            button.setBackground(makeRoundedBackground(SPORELY_GREEN_DARK, ACTION_BUTTON_HEIGHT_DP / 2f, 1, SPORELY_GREEN));
        } else {
            button.setTextColor(Color.argb(235, 255, 255, 255));
            button.setBackground(makeRoundedBackground(Color.argb(110, 0, 0, 0), ACTION_BUTTON_HEIGHT_DP / 2f, 1, Color.argb(80, 255, 255, 255)));
        }
        return button;
    }

    private TextView makeShutterButton() {
        TextView shutter = new TextView(this);
        shutter.setGravity(Gravity.CENTER);
        shutter.setBackground(makeRoundedBackground(Color.WHITE, 41, 5, Color.argb(225, 255, 255, 255)));
        return shutter;
    }

    private LinearLayout.LayoutParams actionButtonParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(ACTION_BUTTON_HEIGHT_DP), 1f);
        params.setMargins(dp(4), dp(82 - ACTION_BUTTON_HEIGHT_DP), dp(4), 0);
        return params;
    }

    private GradientDrawable makeRoundedBackground(int fillColor, float radiusDp, int strokeDp, int strokeColor) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setShape(GradientDrawable.RECTANGLE);
        drawable.setColor(fillColor);
        drawable.setCornerRadius(dp(radiusDp));
        if (strokeDp > 0) drawable.setStroke(dp(strokeDp), strokeColor);
        return drawable;
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void startCamera() {
        ListenableFuture<ProcessCameraProvider> providerFuture = ProcessCameraProvider.getInstance(this);
        providerFuture.addListener(() -> {
            try {
                cameraProvider = providerFuture.get();
                bindCamera();
            } catch (Exception ex) {
                Toast.makeText(this, "Native camera failed: " + ex.getMessage(), Toast.LENGTH_LONG).show();
                finishCanceled();
            }
        }, ContextCompat.getMainExecutor(this));
    }

    @SuppressWarnings("UnsafeOptInUsageError")
    private void bindCamera() {
        if (cameraProvider == null) return;
        cameraProvider.unbindAll();

        SelectedCamera selected = selectBackMainCamera(cameraProvider);

        Preview.Builder previewBuilder = new Preview.Builder()
            .setTargetRotation(getDisplayRotation());
        ImageCapture.Builder captureBuilder = new ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
            .setJpegQuality(95)
            .setTargetRotation(getDisplayRotation());

        if (selected.physicalCameraId != null) {
            new Camera2Interop.Extender<>(previewBuilder).setPhysicalCameraId(selected.physicalCameraId);
            new Camera2Interop.Extender<>(captureBuilder).setPhysicalCameraId(selected.physicalCameraId);
        }

        Preview preview = previewBuilder.build();
        imageCapture = captureBuilder.build();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());
        cameraProvider.bindToLifecycle(this, selected.selector, preview, imageCapture);
    }

    @SuppressWarnings("deprecation")
    private int getDisplayRotation() {
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            return getDisplay() != null ? getDisplay().getRotation() : Surface.ROTATION_0;
        }
        return getWindowManager().getDefaultDisplay().getRotation();
    }

    private SelectedCamera selectBackMainCamera(ProcessCameraProvider provider) {
        List<CameraInfo> backInfos = new ArrayList<>();
        for (CameraInfo info : provider.getAvailableCameraInfos()) {
            try {
                Integer lensFacing = Camera2CameraInfo.from(info)
                    .getCameraCharacteristic(CameraCharacteristics.LENS_FACING);
                if (lensFacing != null && lensFacing == CameraCharacteristics.LENS_FACING_BACK) {
                    backInfos.add(info);
                }
            } catch (Exception ignored) {}
        }

        CameraInfo selectedInfo = backInfos.isEmpty()
            ? provider.getAvailableCameraInfos().get(0)
            : backInfos.get(0);
        String physicalCameraId = choosePhysicalMainCameraId(selectedInfo);

        CameraSelector selector = new CameraSelector.Builder()
            .addCameraFilter(cameraInfos -> Collections.singletonList(selectedInfo))
            .build();
        return new SelectedCamera(selector, physicalCameraId);
    }

    private String choosePhysicalMainCameraId(CameraInfo cameraInfo) {
        try {
            Camera2CameraInfo camera2Info = Camera2CameraInfo.from(cameraInfo);
            String logicalId = camera2Info.getCameraId();
            CameraManager manager = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
            CameraCharacteristics logicalChars = manager.getCameraCharacteristics(logicalId);

            List<LensCandidate> candidates = new ArrayList<>();
            addLensCandidate(candidates, manager, logicalId, logicalId);
            Set<String> physicalIds = logicalChars.getPhysicalCameraIds();
            for (String physicalId : physicalIds) {
                addLensCandidate(candidates, manager, logicalId, physicalId);
            }

            if (candidates.isEmpty()) return null;
            candidates.sort(Comparator.comparingDouble(candidate -> candidate.score));
            LensCandidate best = candidates.get(0);
            return best.cameraId.equals(logicalId) ? null : best.cameraId;
        } catch (Exception ex) {
            return null;
        }
    }

    private void addLensCandidate(List<LensCandidate> candidates, CameraManager manager, String logicalId, String cameraId) {
        try {
            CameraCharacteristics chars = manager.getCameraCharacteristics(cameraId);
            Integer facing = chars.get(CameraCharacteristics.LENS_FACING);
            if (facing != null && facing != CameraCharacteristics.LENS_FACING_BACK) return;

            Boolean flashAvailable = chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
            float[] focalLengths = chars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
            SizeF sensorSize = chars.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
            double equivalentMm = equivalentFocalLength(focalLengths, sensorSize);
            candidates.add(new LensCandidate(cameraId, logicalId, Boolean.TRUE.equals(flashAvailable), equivalentMm));
        } catch (Exception ignored) {}
    }

    private double equivalentFocalLength(float[] focalLengths, SizeF sensorSize) {
        if (focalLengths == null || focalLengths.length == 0 || sensorSize == null) return Double.NaN;
        double diagonal = Math.hypot(sensorSize.getWidth(), sensorSize.getHeight());
        if (diagonal <= 0) return Double.NaN;
        return focalLengths[0] * FULL_FRAME_DIAGONAL_MM / diagonal;
    }

    private void capturePhoto() {
        if (imageCapture == null) return;

        File dir = new File(getCacheDir(), "native-camera");
        if (!dir.exists() && !dir.mkdirs()) {
            Toast.makeText(this, "Could not create camera cache", Toast.LENGTH_LONG).show();
            return;
        }

        File file = new File(dir, "sporely-native-" + System.currentTimeMillis() + ".jpg");
        long capturedAtMillis = System.currentTimeMillis();
        ImageCapture.Metadata metadata = new ImageCapture.Metadata();
        if (captureLocation != null) metadata.setLocation(captureLocation);

        ImageCapture.OutputFileOptions options = new ImageCapture.OutputFileOptions.Builder(file)
            .setMetadata(metadata)
            .build();

        imageCapture.takePicture(options, ContextCompat.getMainExecutor(this), new ImageCapture.OnImageSavedCallback() {
            @Override
            public void onImageSaved(@NonNull ImageCapture.OutputFileResults outputFileResults) {
                if (canceled) {
                    if (file.exists() && !file.delete()) file.deleteOnExit();
                    return;
                }
                try {
                    normalizeOrientation(file, capturedAtMillis);
                    writeCaptureExif(file, capturedAtMillis);
                } catch (Exception ex) {
                    Toast.makeText(NativeCameraActivity.this, "Metadata write failed: " + ex.getMessage(), Toast.LENGTH_SHORT).show();
                }
                capturedFiles.add(file);
                countBadge.setText(String.valueOf(capturedFiles.size()));
                batchStack.setVisibility(FrameLayout.VISIBLE);
            }

            @Override
            public void onError(@NonNull ImageCaptureException exception) {
                Toast.makeText(NativeCameraActivity.this, "Capture failed: " + exception.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
    }

    private void finishCanceled() {
        canceled = true;
        setResult(Activity.RESULT_CANCELED);
        deleteCapturedFiles();
        finish();
    }

    private void deleteCapturedFiles() {
        for (File file : capturedFiles) {
            if (file != null && file.exists() && !file.delete()) {
                file.deleteOnExit();
            }
        }
        capturedFiles.clear();
        if (countBadge != null) countBadge.setText("0");
        if (batchStack != null) batchStack.setVisibility(FrameLayout.GONE);
    }

    private void finishWithPhotos() {
        if (capturedFiles.isEmpty()) {
            finishCanceled();
            return;
        }

        try {
            canceled = false;
            JSONArray photos = new JSONArray();
            for (File file : capturedFiles) {
                photos.put(buildPhotoJson(file));
            }
            Intent data = new Intent();
            data.putExtra(EXTRA_PHOTOS_JSON, photos.toString());
            setResult(Activity.RESULT_OK, data);
            finish();
        } catch (Exception ex) {
            Toast.makeText(this, "Could not return captures: " + ex.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private JSONObject buildPhotoJson(File file) throws Exception {
        JSONObject exif = new JSONObject();
        ExifInterface fileExif = new ExifInterface(file.getAbsolutePath());
        putExifString(exif, "Make", fileExif.getAttribute(ExifInterface.TAG_MAKE));
        putExifString(exif, "Model", fileExif.getAttribute(ExifInterface.TAG_MODEL));
        putExifString(exif, "DateTimeOriginal", fileExif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL));
        putExifString(exif, "CreateDate", fileExif.getAttribute(ExifInterface.TAG_DATETIME_DIGITIZED));
        putExifString(exif, "ExposureTime", fileExif.getAttribute(ExifInterface.TAG_EXPOSURE_TIME));
        putExifString(exif, "FNumber", fileExif.getAttribute(ExifInterface.TAG_F_NUMBER));
        putExifString(exif, "ISOSpeedRatings", fileExif.getAttribute(ExifInterface.TAG_ISO_SPEED_RATINGS));
        putExifString(exif, "PhotographicSensitivity", fileExif.getAttribute(ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY));
        if (captureLocation != null) {
            exif.put("latitude", captureLocation.getLatitude());
            exif.put("longitude", captureLocation.getLongitude());
            if (captureLocation.hasAltitude()) exif.put("GPSAltitude", captureLocation.getAltitude());
            if (captureLocation.hasAccuracy()) exif.put("GPSHPositioningError", captureLocation.getAccuracy());
        }

        JSONObject photo = new JSONObject();
        photo.put("path", file.getAbsolutePath());
        photo.put("originalPath", file.getAbsolutePath());
        photo.put("name", file.getName());
        photo.put("mimeType", "image/jpeg");
        photo.put("originalMimeType", "image/jpeg");
        photo.put("format", "jpeg");
        photo.put("originalFormat", "jpeg");
        photo.put("converted", false);
        photo.put("exif", exif);
        return photo;
    }

    private void putExifString(JSONObject object, String key, String value) throws Exception {
        if (value != null && !value.trim().isEmpty()) object.put(key, value);
    }

    private Location parseLocation(String gpsJson) {
        if (gpsJson == null || gpsJson.isEmpty()) return null;
        try {
            JSONObject gps = new JSONObject(gpsJson);
            if (!gps.has("latitude") || !gps.has("longitude")) return null;
            Location location = new Location("sporely");
            location.setLatitude(gps.getDouble("latitude"));
            location.setLongitude(gps.getDouble("longitude"));
            if (!gps.isNull("altitude")) location.setAltitude(gps.getDouble("altitude"));
            if (!gps.isNull("accuracy")) location.setAccuracy((float) gps.getDouble("accuracy"));
            return location;
        } catch (Exception ex) {
            return null;
        }
    }

    private void writeCaptureExif(File file, long capturedAtMillis) throws IOException {
        ExifInterface exif = new ExifInterface(file.getAbsolutePath());
        applyCameraFallbackExif(exif);
        applyTimestampExif(exif, capturedAtMillis);
        if (captureLocation != null) {
            exif.setLatLong(captureLocation.getLatitude(), captureLocation.getLongitude());
            if (captureLocation.hasAltitude()) {
                exif.setAltitude(captureLocation.getAltitude());
            }
        }
        exif.saveAttributes();
    }

    private void normalizeOrientation(File file, long capturedAtMillis) throws IOException {
        ExifInterface exif = new ExifInterface(file.getAbsolutePath());
        Map<String, String> preservedExif = readPreservedExif(exif);
        int orientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        int degrees = exifOrientationToDegrees(orientation);
        if (degrees == 0) {
            restorePreservedExif(exif, preservedExif);
            applyCameraFallbackExif(exif);
            applyTimestampExif(exif, capturedAtMillis);
            exif.setAttribute(ExifInterface.TAG_ORIENTATION, String.valueOf(ExifInterface.ORIENTATION_NORMAL));
            exif.saveAttributes();
            return;
        }

        Bitmap bitmap = BitmapFactory.decodeFile(file.getAbsolutePath());
        if (bitmap == null) return;
        Matrix matrix = new Matrix();
        matrix.postRotate(degrees);
        Bitmap rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
        if (rotated != bitmap) bitmap.recycle();

        try (FileOutputStream out = new FileOutputStream(file, false)) {
            rotated.compress(Bitmap.CompressFormat.JPEG, 95, out);
        } finally {
            rotated.recycle();
        }

        ExifInterface nextExif = new ExifInterface(file.getAbsolutePath());
        restorePreservedExif(nextExif, preservedExif);
        applyCameraFallbackExif(nextExif);
        applyTimestampExif(nextExif, capturedAtMillis);
        nextExif.setAttribute(ExifInterface.TAG_ORIENTATION, String.valueOf(ExifInterface.ORIENTATION_NORMAL));
        nextExif.saveAttributes();
    }

    private Map<String, String> readPreservedExif(ExifInterface exif) {
        Map<String, String> values = new LinkedHashMap<>();
        String[] tags = new String[] {
            ExifInterface.TAG_MAKE,
            ExifInterface.TAG_MODEL,
            ExifInterface.TAG_SOFTWARE,
            ExifInterface.TAG_DATETIME,
            ExifInterface.TAG_DATETIME_ORIGINAL,
            ExifInterface.TAG_DATETIME_DIGITIZED,
            ExifInterface.TAG_OFFSET_TIME,
            ExifInterface.TAG_OFFSET_TIME_ORIGINAL,
            ExifInterface.TAG_OFFSET_TIME_DIGITIZED,
            ExifInterface.TAG_EXPOSURE_TIME,
            ExifInterface.TAG_F_NUMBER,
            ExifInterface.TAG_EXPOSURE_PROGRAM,
            ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY,
            ExifInterface.TAG_ISO_SPEED_RATINGS,
            ExifInterface.TAG_SHUTTER_SPEED_VALUE,
            ExifInterface.TAG_APERTURE_VALUE,
            ExifInterface.TAG_BRIGHTNESS_VALUE,
            ExifInterface.TAG_EXPOSURE_BIAS_VALUE,
            ExifInterface.TAG_MAX_APERTURE_VALUE,
            ExifInterface.TAG_METERING_MODE,
            ExifInterface.TAG_FLASH,
            ExifInterface.TAG_FOCAL_LENGTH,
            ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM,
            ExifInterface.TAG_EXPOSURE_MODE,
            ExifInterface.TAG_WHITE_BALANCE,
            ExifInterface.TAG_DIGITAL_ZOOM_RATIO,
        };
        for (String tag : tags) {
            String value = exif.getAttribute(tag);
            if (value != null && !value.trim().isEmpty()) values.put(tag, value);
        }
        return values;
    }

    private void restorePreservedExif(ExifInterface exif, Map<String, String> values) {
        for (Map.Entry<String, String> entry : values.entrySet()) {
            exif.setAttribute(entry.getKey(), entry.getValue());
        }
    }

    private void applyCameraFallbackExif(ExifInterface exif) {
        if (isBlank(exif.getAttribute(ExifInterface.TAG_MAKE))) {
            exif.setAttribute(ExifInterface.TAG_MAKE, Build.MANUFACTURER);
        }
        if (isBlank(exif.getAttribute(ExifInterface.TAG_MODEL))) {
            exif.setAttribute(ExifInterface.TAG_MODEL, Build.MODEL);
        }
    }

    private void applyTimestampExif(ExifInterface exif, long capturedAtMillis) {
        String timestamp = new SimpleDateFormat("yyyy:MM:dd HH:mm:ss", Locale.US)
            .format(new Date(capturedAtMillis));
        String offset = new SimpleDateFormat("XXX", Locale.US)
            .format(new Date(capturedAtMillis));
        if (isBlank(exif.getAttribute(ExifInterface.TAG_DATETIME))) {
            exif.setAttribute(ExifInterface.TAG_DATETIME, timestamp);
        }
        if (isBlank(exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL))) {
            exif.setAttribute(ExifInterface.TAG_DATETIME_ORIGINAL, timestamp);
        }
        if (isBlank(exif.getAttribute(ExifInterface.TAG_DATETIME_DIGITIZED))) {
            exif.setAttribute(ExifInterface.TAG_DATETIME_DIGITIZED, timestamp);
        }
        exif.setAttribute(ExifInterface.TAG_OFFSET_TIME, offset);
        exif.setAttribute(ExifInterface.TAG_OFFSET_TIME_ORIGINAL, offset);
        exif.setAttribute(ExifInterface.TAG_OFFSET_TIME_DIGITIZED, offset);
    }

    private boolean isBlank(String value) {
        return value == null || value.trim().isEmpty();
    }

    private int exifOrientationToDegrees(int orientation) {
        if (orientation == ExifInterface.ORIENTATION_ROTATE_90) return 90;
        if (orientation == ExifInterface.ORIENTATION_ROTATE_180) return 180;
        if (orientation == ExifInterface.ORIENTATION_ROTATE_270) return 270;
        return 0;
    }

    private static class SelectedCamera {
        final CameraSelector selector;
        final String physicalCameraId;

        SelectedCamera(CameraSelector selector, String physicalCameraId) {
            this.selector = selector;
            this.physicalCameraId = physicalCameraId;
        }
    }

    private static class LensCandidate {
        final String cameraId;
        final double score;

        LensCandidate(String cameraId, String logicalId, boolean flashAvailable, double equivalentMm) {
            this.cameraId = cameraId;
            double score = flashAvailable ? 0 : 100;
            if (Double.isNaN(equivalentMm)) {
                score += 40;
            } else if (equivalentMm >= 20 && equivalentMm <= 35) {
                score += Math.abs(equivalentMm - 24);
            } else if (equivalentMm < 20) {
                score += 50 + (20 - equivalentMm);
            } else {
                score += 30 + Math.abs(equivalentMm - 24);
            }
            if (cameraId.equals(logicalId)) score += 5;
            this.score = score;
        }
    }
}

package com.sporelab.sporely;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;

import androidx.exifinterface.media.ExifInterface;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Collection;
import java.util.Date;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Storage lifecycle helpers for Sporely Cam (NativeCameraActivity) captures.
 *
 * Captures live in private app cache: {@code getCacheDir()/native-camera/sporely-native-<ts>_<id>.jpg}.
 * They are temporary working storage. JavaScript calls back into these helpers only AFTER the
 * observation image bytes are durably persisted in the sync queue:
 * <ol>
 *   <li>optionally copy the original JPEG (bytes + EXIF/GPS intact) to MediaStore Pictures/Sporely;</li>
 *   <li>delete the private cache source.</li>
 * </ol>
 * Every method that touches a file first verifies the file is a Sporely native-camera capture
 * inside the native-camera cache directory. Nothing else is ever deleted or exported.
 */
final class NativeCaptureStorage {
    private static final String TAG = "SporelyCaptureStorage";
    static final String CAPTURE_DIR_NAME = "native-camera";
    static final String CAPTURE_FILE_PREFIX = "sporely-native-";
    static final String GALLERY_RELATIVE_DIR = Environment.DIRECTORY_PICTURES + "/Sporely";
    static final long DEFAULT_STALE_AFTER_MS = 48L * 60L * 60L * 1000L;
    private static final Pattern CAPTURE_FILE_NAME = Pattern.compile("^sporely-native-\\d+_[A-Za-z0-9-]+\\.jpe?g$", Pattern.CASE_INSENSITIVE);

    private NativeCaptureStorage() {}

    static File captureDir(Context context) {
        return new File(context.getCacheDir(), CAPTURE_DIR_NAME);
    }

    static boolean isCaptureFileName(String name) {
        return name != null && CAPTURE_FILE_NAME.matcher(name).matches();
    }

    /**
     * Resolves {@code rawPath} to a File that is provably a Sporely native-camera capture inside
     * the capture directory, or throws. Accepts an optional {@code file://} prefix.
     */
    static File resolveCaptureFile(Context context, String rawPath) throws IOException {
        return resolveCaptureFile(captureDir(context), rawPath);
    }

    static File resolveCaptureFile(File captureDir, String rawPath) throws IOException {
        if (rawPath == null || rawPath.trim().isEmpty()) throw new IOException("Missing capture path");
        String path = rawPath.trim();
        if (path.startsWith("file://")) path = path.substring("file://".length());
        File candidate = new File(path);
        if (!isCaptureFileName(candidate.getName())) {
            throw new IOException("Not a Sporely native-camera capture: " + candidate.getName());
        }
        String dirCanonical = captureDir.getCanonicalPath() + File.separator;
        String fileCanonical = candidate.getCanonicalPath();
        if (!fileCanonical.startsWith(dirCanonical)) {
            throw new IOException("Capture path is outside the native-camera cache directory");
        }
        return new File(fileCanonical);
    }

    /** Deletes one capture. Returns true if the file no longer exists afterwards. */
    static boolean deleteCapture(Context context, String rawPath) throws IOException {
        return deleteCapture(captureDir(context), rawPath);
    }

    static boolean deleteCapture(File captureDir, String rawPath) throws IOException {
        File file = resolveCaptureFile(captureDir, rawPath);
        if (!file.exists()) return true;
        if (!file.isFile()) throw new IOException("Capture path is not a regular file");
        if (file.delete()) return true;
        file.deleteOnExit();
        return !file.exists();
    }

    /**
     * Copies the original capture JPEG byte-for-byte into the user's photo library under
     * Pictures/Sporely via modern MediaStore (API 29+). EXIF/GPS travel with the bytes.
     * Returns the MediaStore content URI. Throws when the copy could not be completed; any
     * partially written MediaStore entry is removed first.
     */
    static Uri exportCaptureToGallery(Context context, String rawPath) throws IOException {
        File source = resolveCaptureFile(context, rawPath);
        if (!source.isFile()) throw new IOException("Capture source no longer exists");
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // Pre-Android 10 would need legacy WRITE_EXTERNAL_STORAGE at runtime; deliberately unsupported.
            throw new UnsupportedOperationException("Saving originals to the phone requires Android 10 or newer");
        }

        ContentResolver resolver = context.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, buildGalleryDisplayName(source));
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        values.put(MediaStore.Images.Media.RELATIVE_PATH, GALLERY_RELATIVE_DIR);
        values.put(MediaStore.Images.Media.IS_PENDING, 1);
        Long takenAt = readDateTakenMillis(source);
        if (takenAt != null) values.put(MediaStore.Images.Media.DATE_TAKEN, takenAt);

        Uri collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        Uri target = resolver.insert(collection, values);
        if (target == null) throw new IOException("MediaStore refused the new image");

        try {
            try (InputStream in = new FileInputStream(source);
                 OutputStream out = resolver.openOutputStream(target)) {
                if (out == null) throw new IOException("MediaStore output stream unavailable");
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
                out.flush();
            }
            ContentValues publish = new ContentValues();
            publish.put(MediaStore.Images.Media.IS_PENDING, 0);
            resolver.update(target, publish, null, null);
            return target;
        } catch (IOException | RuntimeException ex) {
            try {
                resolver.delete(target, null, null);
            } catch (RuntimeException cleanupEx) {
                Log.w(TAG, "Could not remove partial gallery entry", cleanupEx);
            }
            throw ex;
        }
    }

    /** Result of a prune pass; all counters are best-effort. */
    static final class PruneResult {
        int scanned;
        int deleted;
        int retained;
        int skipped;
        int failed;
        /** Stale-by-age captures kept because a live draft still references them. */
        int protectedRetained;
        /** Protected entries ignored because they were not valid captures inside the capture dir. */
        int protectedIgnored;
    }

    /**
     * Deletes native-camera capture files older than {@code maxAgeMs}, except those named in
     * {@code protectedPaths} (captures a persisted review draft still references). Only files
     * whose name matches the Sporely capture pattern are considered; directories and unrelated
     * files are left alone. Never throws.
     */
    static PruneResult pruneStaleCaptures(Context context, long maxAgeMs, Collection<String> protectedPaths) {
        return pruneStaleCaptures(captureDir(context), maxAgeMs, System.currentTimeMillis(), protectedPaths);
    }

    /**
     * Resolves caller-supplied protected paths (captures still referenced by a persisted
     * review draft) to file names. Each entry is validated exactly like a delete target: it
     * must be a Sporely capture name inside {@code dir}. Anything else is ignored, so a
     * malformed or foreign path can neither exempt nor affect any file.
     */
    static Set<String> resolveProtectedNames(File dir, Collection<String> protectedPaths, PruneResult result) {
        Set<String> names = new HashSet<>();
        if (protectedPaths == null) return names;
        for (String raw : protectedPaths) {
            try {
                names.add(resolveCaptureFile(dir, raw).getName());
            } catch (IOException | RuntimeException ex) {
                if (result != null) result.protectedIgnored += 1;
            }
        }
        return names;
    }

    static PruneResult pruneStaleCaptures(File dir, long maxAgeMs, long nowMs, Collection<String> protectedPaths) {
        PruneResult result = new PruneResult();
        long cutoff = nowMs - Math.max(0L, maxAgeMs);
        try {
            if (dir == null || !dir.isDirectory()) return result;
            Set<String> protectedNames = resolveProtectedNames(dir, protectedPaths, result);
            File[] entries = dir.listFiles();
            if (entries == null) return result;
            for (File entry : entries) {
                result.scanned += 1;
                if (!entry.isFile() || !isCaptureFileName(entry.getName())) {
                    result.skipped += 1;
                    continue;
                }
                long modified = entry.lastModified();
                if (modified <= 0 || modified >= cutoff) {
                    result.retained += 1;
                    continue;
                }
                if (protectedNames.contains(entry.getName())) {
                    result.protectedRetained += 1;
                    continue;
                }
                if (entry.delete()) {
                    result.deleted += 1;
                } else {
                    result.failed += 1;
                    Log.w(TAG, "Could not delete stale capture " + entry.getName());
                }
            }
        } catch (RuntimeException ex) {
            result.failed += 1;
            Log.w(TAG, "Stale capture prune failed", ex);
        }
        return result;
    }

    private static String buildGalleryDisplayName(File source) {
        Long takenAt = readDateTakenMillis(source);
        long stamp = takenAt != null ? takenAt : source.lastModified();
        if (stamp <= 0) stamp = System.currentTimeMillis();
        String formatted = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date(stamp));
        String name = source.getName();
        String stem = name.substring(0, name.lastIndexOf('.'));
        int idSeparator = stem.lastIndexOf('_');
        String suffix = idSeparator >= 0 ? stem.substring(idSeparator + 1) : "";
        return "Sporely_" + formatted + (suffix.isEmpty() ? "" : "_" + suffix) + ".jpg";
    }

    private static Long readDateTakenMillis(File source) {
        try {
            ExifInterface exif = new ExifInterface(source.getAbsolutePath());
            Long original = exif.getDateTimeOriginal();
            if (original != null && original > 0) return original;
            Long digitized = exif.getDateTimeDigitized();
            if (digitized != null && digitized > 0) return digitized;
        } catch (IOException | RuntimeException ignored) {}
        return null;
    }
}

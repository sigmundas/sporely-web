package com.sporelab.sporely;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Collections;

import org.junit.Before;
import org.junit.Test;

/** Pure-JVM tests for the guarded native-camera cache lifecycle helpers. */
public class NativeCaptureStorageTest {
    private static final long HOUR = 60L * 60L * 1000L;
    private File cacheRoot;
    private File captureDir;

    @Before
    public void setUp() throws IOException {
        cacheRoot = Files.createTempDirectory("sporely-cache").toFile();
        captureDir = new File(cacheRoot, NativeCaptureStorage.CAPTURE_DIR_NAME);
        assertTrue(captureDir.mkdirs());
    }

    private File writeFile(File dir, String name, long ageMs) throws IOException {
        File file = new File(dir, name);
        Files.write(file.toPath(), new byte[] { (byte) 0xFF, (byte) 0xD8, 0, 1, 2 });
        assertTrue(file.setLastModified(System.currentTimeMillis() - ageMs));
        return file;
    }

    @Test
    public void pruneKeepsRecentAndRemovesStaleCaptures() throws IOException {
        File recent = writeFile(captureDir, "sporely-native-1700000000000_ab12cd.jpg", 1 * HOUR);
        File stale = writeFile(captureDir, "sporely-native-1600000000000_ef34ab.jpg", 49 * HOUR);
        File unrelatedOld = writeFile(captureDir, "notes.txt", 200 * HOUR);
        File systemCam = writeFile(cacheRoot, "system_cam_123.jpg", 200 * HOUR);
        File nested = new File(captureDir, "subdir");
        assertTrue(nested.mkdirs());
        File nestedOld = writeFile(nested, "sporely-native-1500000000000_zz99zz.jpg", 200 * HOUR);

        NativeCaptureStorage.PruneResult result = NativeCaptureStorage.pruneStaleCaptures(
            captureDir, NativeCaptureStorage.DEFAULT_STALE_AFTER_MS, System.currentTimeMillis(), Collections.emptyList());

        assertTrue(recent.exists());
        assertFalse(stale.exists());
        assertTrue(unrelatedOld.exists());
        assertTrue(systemCam.exists());
        assertTrue(nested.isDirectory());
        assertTrue(nestedOld.exists());
        assertEquals(1, result.deleted);
        assertEquals(1, result.retained);
        assertEquals(2, result.skipped);
        assertEquals(0, result.failed);
    }

    @Test
    public void pruneMissingDirectoryIsNoop() {
        NativeCaptureStorage.PruneResult result = NativeCaptureStorage.pruneStaleCaptures(
            new File(cacheRoot, "does-not-exist"), NativeCaptureStorage.DEFAULT_STALE_AFTER_MS, System.currentTimeMillis(), null);
        assertEquals(0, result.scanned);
        assertEquals(0, result.deleted);
        assertEquals(0, result.failed);
    }

    @Test
    public void pruneKeepsStaleCapturesReferencedByADraft() throws IOException {
        File referenced = writeFile(captureDir, "sporely-native-1600000000000_dr4ft1.jpg", 72 * HOUR);
        File referencedFileUri = writeFile(captureDir, "sporely-native-1600000000001_dr4ft2.jpg", 72 * HOUR);
        File orphan = writeFile(captureDir, "sporely-native-1600000000002_orph4n.jpg", 72 * HOUR);
        File recent = writeFile(captureDir, "sporely-native-1700000000000_rec3nt.jpg", 1 * HOUR);

        NativeCaptureStorage.PruneResult result = NativeCaptureStorage.pruneStaleCaptures(
            captureDir, NativeCaptureStorage.DEFAULT_STALE_AFTER_MS, System.currentTimeMillis(),
            Arrays.asList(referenced.getAbsolutePath(), "file://" + referencedFileUri.getAbsolutePath()));

        assertTrue(referenced.exists());
        assertTrue(referencedFileUri.exists());
        assertFalse(orphan.exists());
        assertTrue(recent.exists());
        assertEquals(2, result.protectedRetained);
        assertEquals(1, result.deleted);
        assertEquals(1, result.retained);
        assertEquals(0, result.protectedIgnored);
    }

    @Test
    public void malformedProtectedPathsCannotExemptOrDeleteArbitraryFiles() throws IOException {
        File stale = writeFile(captureDir, "sporely-native-1600000000000_st4le1.jpg", 72 * HOUR);
        File outsideLookalike = writeFile(cacheRoot, "sporely-native-1600000000000_st4le1.jpg", 72 * HOUR);
        File systemCam = writeFile(cacheRoot, "system_cam_9.jpg", 72 * HOUR);

        NativeCaptureStorage.PruneResult result = NativeCaptureStorage.pruneStaleCaptures(
            captureDir, NativeCaptureStorage.DEFAULT_STALE_AFTER_MS, System.currentTimeMillis(),
            Arrays.asList(
                outsideLookalike.getAbsolutePath(),              // same name, outside the capture dir
                new File(captureDir, "../system_cam_9.jpg").getPath(), // traversal
                "/etc/passwd",
                "",
                null));

        // A protected entry outside the capture dir does not exempt the same-named stale
        // capture inside it, and nothing outside the directory is touched either way.
        assertFalse(stale.exists());
        assertTrue(outsideLookalike.exists());
        assertTrue(systemCam.exists());
        assertEquals(5, result.protectedIgnored);
        assertEquals(1, result.deleted);
        assertEquals(0, result.failed);
    }

    @Test
    public void deleteCaptureRemovesOnlyCaptureFilesInsideCaptureDir() throws IOException {
        File capture = writeFile(captureDir, "sporely-native-1700000000000_ab12cd.jpg", 0);
        assertTrue(NativeCaptureStorage.deleteCapture(captureDir, "file://" + capture.getAbsolutePath()));
        assertFalse(capture.exists());
        // Deleting an already-gone capture is idempotent.
        assertTrue(NativeCaptureStorage.deleteCapture(captureDir, capture.getAbsolutePath()));

        File systemCam = writeFile(cacheRoot, "system_cam_123.jpg", 0);
        try {
            NativeCaptureStorage.deleteCapture(captureDir, systemCam.getAbsolutePath());
            fail("system camera temp file must be refused");
        } catch (IOException expected) {}
        assertTrue(systemCam.exists());

        File lookalikeOutside = writeFile(cacheRoot, "sporely-native-1700000000000_ab12cd.jpg", 0);
        try {
            NativeCaptureStorage.deleteCapture(captureDir, lookalikeOutside.getAbsolutePath());
            fail("capture-named file outside the capture dir must be refused");
        } catch (IOException expected) {}
        assertTrue(lookalikeOutside.exists());

        File traversal = new File(captureDir, "../sporely-native-1700000000000_ab12cd.jpg");
        try {
            NativeCaptureStorage.deleteCapture(captureDir, traversal.getPath());
            fail("path traversal must be refused");
        } catch (IOException expected) {}
        assertTrue(lookalikeOutside.exists());

        File unrelatedInside = writeFile(captureDir, "other.jpg", 0);
        try {
            NativeCaptureStorage.deleteCapture(captureDir, unrelatedInside.getAbsolutePath());
            fail("non-capture file inside the dir must be refused");
        } catch (IOException expected) {}
        assertTrue(unrelatedInside.exists());
    }

    @Test
    public void captureFileNamePattern() {
        assertTrue(NativeCaptureStorage.isCaptureFileName("sporely-native-1757600000000_a1b2c3.jpg"));
        assertTrue(NativeCaptureStorage.isCaptureFileName("sporely-native-1757600000000_a1b2c3.JPEG"));
        assertFalse(NativeCaptureStorage.isCaptureFileName("system_cam_1.jpg"));
        assertFalse(NativeCaptureStorage.isCaptureFileName("sporely-native-.jpg"));
        assertFalse(NativeCaptureStorage.isCaptureFileName("sporely-native-1_a.png"));
        assertFalse(NativeCaptureStorage.isCaptureFileName(null));
    }
}

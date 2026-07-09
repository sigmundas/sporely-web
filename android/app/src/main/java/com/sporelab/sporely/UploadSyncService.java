package com.sporelab.sporely;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/**
 * Foreground service that keeps the app process (and its WebView) alive while
 * the JS sync queue drains. The whole upload sequence — observation insert,
 * image encoding, storage PUTs, metadata rows — runs in JS, so with the screen
 * off Android would otherwise freeze the process mid-sync. The service itself
 * does no work; it only pins the process and shows upload progress.
 */
public class UploadSyncService extends Service {

    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_TEXT = "text";

    private static final String CHANNEL_ID = "upload_sync";
    private static final int NOTIFICATION_ID = 7401;
    // Safety cap in case JS never asks the service to stop (e.g. WebView crash).
    private static final long WAKELOCK_TIMEOUT_MS = 10 * 60 * 1000;

    private PowerManager.WakeLock wakeLock;
    private boolean startedForeground = false;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;
        Notification notification = buildNotification(title, text);

        if (!startedForeground) {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            );
            startedForeground = true;
        } else {
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.notify(NOTIFICATION_ID, notification);
            }
        }

        acquireWakeLock();
        return START_NOT_STICKY;
    }

    @Override
    public void onTimeout(int startId) {
        // Android 15+ enforces a daily runtime budget for dataSync services.
        stopSelf();
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        startedForeground = false;
        super.onDestroy();
    }

    private Notification buildNotification(String title, String text) {
        ensureChannel();

        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(title != null && !title.isEmpty() ? title : "Sporely")
            .setContentText(text != null && !text.isEmpty() ? text : "Uploading observations…")
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Upload sync",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Shows progress while observations upload in the background");
        manager.createNotificationChannel(channel);
    }

    private void acquireWakeLock() {
        // A dataSync foreground service prevents the process from being frozen,
        // but the CPU can still nap with the screen off; a partial wakelock keeps
        // the JS upload loop running. Re-acquiring re-arms the timeout.
        if (wakeLock == null) {
            PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (powerManager == null) return;
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sporely:upload-sync");
            wakeLock.setReferenceCounted(false);
        }
        wakeLock.acquire(WAKELOCK_TIMEOUT_MS);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
    }
}

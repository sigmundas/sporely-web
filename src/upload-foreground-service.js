import { registerPlugin } from '@capacitor/core'
import { isAndroidApp } from './platform.js'

// Android-only foreground service (see UploadSyncService.java) that keeps the
// app process alive while the sync queue drains, so uploads and their Supabase
// DB writes survive the screen turning off. No-op on web and iOS — iOS gets a
// short grace window via @capawesome/capacitor-background-task instead.
const UploadSyncService = registerPlugin('UploadSyncService')

const NOTIFICATION_TITLE = 'Sporely'

let _permissionRequested = false
let _running = false

async function _ensureNotificationPermission() {
  if (_permissionRequested) return
  _permissionRequested = true
  try {
    const status = await UploadSyncService.checkPermissions()
    const state = status?.notifications
    if (state === 'prompt' || state === 'prompt-with-rationale') {
      await UploadSyncService.requestPermissions({ permissions: ['notifications'] })
    }
  } catch (error) {
    // Permission only affects notification visibility; the service runs regardless.
    console.warn('Upload notification permission request failed:', error)
  }
}

export async function startUploadForegroundService(text) {
  if (!isAndroidApp()) return
  await _ensureNotificationPermission()
  try {
    await UploadSyncService.start({ title: NOTIFICATION_TITLE, text })
    _running = true
  } catch (error) {
    // Expected when sync is triggered while the app is already backgrounded:
    // Android 12+ blocks foreground-service starts from the background. The
    // queue still syncs for as long as the OS lets the process run.
    console.warn('Upload foreground service start failed:', error)
  }
}

export async function updateUploadForegroundService(text) {
  if (!_running) return
  try {
    await UploadSyncService.update({ title: NOTIFICATION_TITLE, text })
  } catch (error) {
    console.warn('Upload foreground service update failed:', error)
  }
}

export async function stopUploadForegroundService() {
  if (!_running) return
  _running = false
  try {
    await UploadSyncService.stop()
  } catch (error) {
    console.warn('Upload foreground service stop failed:', error)
  }
}

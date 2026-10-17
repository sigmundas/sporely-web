// G5 I2 regression: under Android 11+ package visibility, the IMAGE_CAPTURE
// pre-check in NativeCameraPlugin.openSystemCamera() needs a <queries> entry.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const manifest = fs.readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8')
const plugin = fs.readFileSync(new URL('../android/app/src/main/java/com/sporelab/sporely/NativeCameraPlugin.java', import.meta.url), 'utf8')

test('manifest declares an IMAGE_CAPTURE query for the system camera pre-check', () => {
  assert.match(plugin, /resolveActivity\(/)
  const queries = manifest.match(/<queries>([\s\S]*?)<\/queries>/)
  assert.ok(queries, 'manifest has a <queries> element')
  assert.match(queries[1], /<action android:name="android\.media\.action\.IMAGE_CAPTURE"\s*\/>/)
  assert.ok(manifest.indexOf('<queries>') < manifest.indexOf('<application'), '<queries> is a direct child of <manifest>')
})

test('openSystemCamera asks for CAMERA before launching IMAGE_CAPTURE', () => {
  // A declared-but-ungranted CAMERA permission makes the IMAGE_CAPTURE launch
  // throw SecurityException ("with revoked permission android.permission.CAMERA").
  assert.match(plugin, /@Permission\(strings = \{ Manifest\.permission\.CAMERA \}, alias = "camera"\)/)
  const open = plugin.slice(plugin.indexOf('public void openSystemCamera'), plugin.indexOf('private void launchSystemCamera'))
  assert.match(open, /getPermissionState\("camera"\) != PermissionState\.GRANTED[\s\S]*requestPermissionForAlias\("camera", call, "systemCameraPermissionCallback"\)/)
  assert.match(open, /@PermissionCallback\s+private void systemCameraPermissionCallback[\s\S]*launchSystemCamera\(call\)[\s\S]*reject\("Camera permission denied"\)/)
})

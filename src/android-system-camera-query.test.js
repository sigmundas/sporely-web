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

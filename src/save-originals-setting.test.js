import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// The Settings screen lives in main.js/index.html, which cannot be imported
// under node. These source-level checks pin the wiring of the Android-only
// "Save originals to phone" toggle: it renders in the Camera section, is
// hidden off-Android, reflects the persisted setting, and writes it back.

const mainSource = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8')
const indexSource = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const i18nSource = fs.readFileSync(new URL('./i18n.js', import.meta.url), 'utf8')

test('Settings markup places the toggle with the Android camera settings', () => {
  const cameraLabel = indexSource.indexOf('id="settings-camera-label"')
  const cameraAppHint = indexSource.indexOf('id="settings-camera-app-hint"')
  const toggleRow = indexSource.indexOf('id="settings-save-originals-row"')
  const toggle = indexSource.indexOf('id="settings-save-originals-toggle"')
  const hint = indexSource.indexOf('id="settings-save-originals-hint"')
  const nextSection = indexSource.indexOf('id="settings-default-visibility-label"')
  assert.ok(cameraLabel > 0 && cameraAppHint > cameraLabel)
  assert.ok(toggleRow > cameraAppHint, 'toggle row follows the Camera App row')
  assert.ok(toggle > toggleRow && hint > toggle)
  assert.ok(hint < nextSection, 'toggle stays inside the Camera section')
  assert.match(indexSource, /<input type="checkbox" id="settings-save-originals-toggle">/)
})

test('Settings UI is Android-only, reflects the persisted value, and persists changes', () => {
  assert.match(mainSource, /saveOriginalsRow\.style\.display = showSaveOriginals \? 'flex' : 'none'/)
  assert.match(mainSource, /const showSaveOriginals = isAndroidApp\(\)/)
  assert.match(mainSource, /saveOriginalsToggle\.checked = getSaveOriginalsToPhone\(\)/)
  assert.match(mainSource, /setSaveOriginalsToPhone\(!!event\.currentTarget\.checked\)/)
  // Startup orphan prune is Android-only, deferred, and never awaited.
  assert.match(mainSource, /if \(isAndroidApp\(\)\) \{\s*setTimeout\(\(\) => \{ void pruneStaleNativeCaptures\(\) \}/)
})

test('new strings exist in every supported locale and are wired to the markup', () => {
  const locales = ['en', 'nb_NO', 'sv_SE', 'de_DE']
  const keys = ['settings.saveOriginalsToPhone', 'settings.saveOriginalsToPhoneHint', 'review.originalNotSavedToPhone']
  const starts = locales.map(locale => i18nSource.indexOf(`\n  ${locale}: {`))
  starts.forEach(start => assert.ok(start > 0))
  for (let i = 0; i < locales.length; i++) {
    const block = i18nSource.slice(starts[i], starts[i + 1] ?? i18nSource.length)
    for (const key of keys) {
      assert.ok(block.includes(`'${key}':`), `${locales[i]} is missing ${key}`)
    }
    assert.doesNotMatch(block, /'settings\.saveOriginalsToPhone': '[^']*[Bb]ackup/, 'the setting is a gallery copy, not "Backup photos"')
  }
  assert.match(i18nSource, /setText\('#settings-save-originals-label', 'settings\.saveOriginalsToPhone'\)/)
  assert.match(i18nSource, /setText\('#settings-save-originals-hint', 'settings\.saveOriginalsToPhoneHint'\)/)
})

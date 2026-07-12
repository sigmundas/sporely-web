import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { isTinyCameraCaptureDimensions } from './capture.js'

test('tiny camera capture dimensions reject degraded iOS fallback frames', () => {
  assert.equal(isTinyCameraCaptureDimensions(144, 192), true)
  assert.equal(isTinyCameraCaptureDimensions(3024, 4032), false)
  assert.equal(isTinyCameraCaptureDimensions(800, 999), true)
  assert.equal(isTinyCameraCaptureDimensions(1000, 800), false)
})

test('capture and review expose a shared gps status pill', () => {
  const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const geoSource = fs.readFileSync(new URL('../geo.js', import.meta.url), 'utf8')
  const i18nSource = fs.readFileSync(new URL('../i18n.js', import.meta.url), 'utf8')

  assert.match(html, /capture-gps-pill/)
  assert.match(html, /id="gps-display"/)
  assert.match(html, /review-gps-pill/)
  assert.match(html, /id="review-gps-display"/)
  assert.doesNotMatch(html, /Creates one observation in Sporely Cloud/)

  assert.match(geoSource, /querySelectorAll\('\.gps-display'\)/)
  assert.match(geoSource, /capture\.gpsUnavailable/)
  assert.match(geoSource, /dataset\.gpsState/)

  assert.match(i18nSource, /setText\('#review-gps-display', 'common\.noGpsCaptured'\)/)
})

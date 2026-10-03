import test from 'node:test'
import assert from 'node:assert/strict'

import { formatScaleBarLabel, pickScaleBar, umPerLoadedPixel } from './scale-bar.js'

test('scale bar picks a nice micrometre length near a fifth of the visible width', () => {
  // 0.1 µm/px over 400 px: 40 µm visible, target 8 µm → 10 µm (100 px) is
  // in the 60-100 px band; 5 µm (50 px) is below it.
  assert.deepEqual(pickScaleBar(0.1, 400), { microns: 10, px: 100 })
  // 1 µm/px over 1000 px: 200 µm lands exactly on target.
  assert.deepEqual(pickScaleBar(1, 1000), { microns: 200, px: 200 })
})

test('scale bar follows zoom: zooming in shortens the value, not the position', () => {
  const fit = pickScaleBar(0.5, 1000)
  const zoomed = pickScaleBar(0.5 / 4, 1000)
  assert.equal(fit.microns, 100)
  assert.equal(zoomed.microns, 20)
  for (const choice of [fit, zoomed]) {
    assert.ok(choice.px >= 150 && choice.px <= 250, String(choice.px))
  }
})

test('scale bar falls back to the largest fitting length and hides when illegible', () => {
  // At high magnification the smallest nice length still works.
  assert.deepEqual(pickScaleBar(0.01, 220), { microns: 0.5, px: 50 })
  // Even 0.5 µm overshoots 25 % of the width.
  assert.equal(pickScaleBar(0.001, 400), null)
  // A tiny frame cannot carry a legible bar.
  assert.equal(pickScaleBar(1, 60), null)
  for (const bad of [0, -1, NaN, null, undefined]) {
    assert.equal(pickScaleBar(bad, 400), null)
    assert.equal(pickScaleBar(0.1, bad), null)
  }
})

test('calibration follows the loaded variant, not the calibrated source size', () => {
  assert.equal(umPerLoadedPixel({ umPerSourcePx: 0.1, sourceWidthPx: 4000, loadedWidthPx: 1000 }), 0.4)
  assert.equal(umPerLoadedPixel({ umPerSourcePx: 0.1, sourceWidthPx: null, loadedWidthPx: 1000 }), 0.1)
  assert.equal(umPerLoadedPixel({ umPerSourcePx: null, sourceWidthPx: 4000, loadedWidthPx: 1000 }), null)
  assert.equal(umPerLoadedPixel({ umPerSourcePx: 0.1, sourceWidthPx: 4000, loadedWidthPx: 0 }), null)
})

test('scale bar labels switch to millimetres from 1000 µm', () => {
  assert.equal(formatScaleBarLabel(0.5), '0.5 µm')
  assert.equal(formatScaleBarLabel(50), '50 µm')
  assert.equal(formatScaleBarLabel(2000), '2 mm')
  assert.equal(formatScaleBarLabel(0), '')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  _extractAltitudeFromRawGps,
  _extractAltitudeRefFromRawGps,
  _extractLatLonFromRawGps,
  isHeicBlobContent,
  isHeicLikeFile,
  processFile,
} from './import-helpers.js'

test('raw GPS altitude parsing handles common EXIF shapes', () => {
  assert.equal(_extractAltitudeFromRawGps({
    GPSAltitude: { numerator: 157, denominator: 1 },
    GPSAltitudeRef: 0,
  }), 157)

  assert.equal(_extractAltitudeFromRawGps({
    'GPS Altitude': ['157'],
    'GPS Altitude Ref': 'Below Sea Level',
  }), -157)

  assert.equal(_extractAltitudeFromRawGps({
    gps_altitude: [{ num: 314, den: 2 }],
    gpsAltitudeRef: 'Above Sea Level',
  }), 157)

  assert.equal(_extractAltitudeFromRawGps({
    GPSAltitude: '157 m Above Sea Level',
    GPSAltitudeRef: 0,
  }), 157)
})

test('raw GPS altitude ref parsing handles numeric and string variants', () => {
  assert.equal(_extractAltitudeRefFromRawGps({ GPSAltitudeRef: 0 }), 0)
  assert.equal(_extractAltitudeRefFromRawGps({ GpsAltitudeRef: '1' }), 1)
  assert.equal(_extractAltitudeRefFromRawGps({ 'GPS Altitude Ref': 'above sea level' }), 0)
  assert.equal(_extractAltitudeRefFromRawGps({ gps_altitude_ref: 'below' }), 1)
})

test('raw GPS coordinate parsing preserves finite coordinates and ignores missing values', () => {
  assert.deepEqual(_extractLatLonFromRawGps({
    GPSLatitude: [{ numerator: 59, denominator: 1 }],
    GPSLatitudeRef: 'N',
    GPSLongitude: [{ numerator: 10, denominator: 1 }],
    GPSLongitudeRef: 'E',
  }), { lat: 59, lon: 10 })

  assert.deepEqual(_extractLatLonFromRawGps({
    latitude: 0,
    longitude: 0,
  }), { lat: null, lon: null })

  assert.deepEqual(_extractLatLonFromRawGps({
    latitude: 61.9042,
    longitude: 5.9953,
  }), { lat: 61.9042, lon: 5.9953 })

  assert.deepEqual(_extractLatLonFromRawGps({
    GPSLatitude: [42, 14, 6],
    GPSLatitudeRef: 'N',
    GPSLongitude: [123, 3, 24.98],
    GPSLongitudeRef: 'W',
  }), {
    lat: 42.235,
    lon: -(123 + (3 / 60) + (24.98 / 3600)),
  })
})

test('HEIC detection covers extensions, MIME types, and BMFF signatures', async () => {
  const box = brand => new Blob([
    new Uint8Array([0, 0, 0, 24]),
    'ftyp',
    brand,
    new Uint8Array([0, 0, 0, 0]),
    brand,
  ], { type: 'image/jpeg' })

  assert.equal(isHeicLikeFile({ name: 'photo.HEIC', type: '' }), true)
  assert.equal(isHeicLikeFile({ name: 'photo', type: 'image/heif' }), true)
  assert.equal(await isHeicBlobContent(box('heic')), true)
  assert.equal(await isHeicBlobContent(box('heix')), true)
  assert.equal(await isHeicBlobContent(box('avif')), false)
  assert.equal(await isHeicBlobContent(new Blob(['not-an-image'], { type: 'image/heic' })), false)
})

test('browser HEIC processing retains the lazy JPEG conversion path', () => {
  const source = fs.readFileSync(new URL('./import-helpers.js', import.meta.url), 'utf8')
  assert.match(source, /import\('heic2any'\)/)
  assert.match(source, /const blob = options\.forceJpeg \|\| _isHeicLike\(file\)[\s\S]*?_canvasToJpegBlob\(img, w, h, 0\.88\)/)
  assert.match(source, /resolve\(\{ blob, aiBlob, metaSource: blob \}\)/)
})

test('Android picker JPEG keeps the native fast path when its filename is HEIC', async () => {
  const previousWindow = globalThis.window
  const previousImage = globalThis.Image
  globalThis.window = {
    Capacitor: {
      getPlatform: () => 'android',
      isNativePlatform: () => true,
    },
  }
  globalThis.Image = class UnexpectedImageDecode {
    constructor() {
      throw new Error('native JPEG should not be decoded in the browser import path')
    }
  }

  try {
    const file = new File(['native-jpeg'], 'converted.HEIC', { type: 'image/jpeg' })
    const result = await processFile(file, {
      nativePhoto: {
        name: 'converted.HEIC',
        mimeType: 'image/jpeg',
        originalMimeType: 'image/heic',
        format: 'jpeg',
        originalFormat: 'heic',
        converted: true,
      },
    })

    assert.equal(result.blob, file)
    assert.equal(result.aiBlob, file)
    assert.deepEqual(result.meta, {
      aiCropRect: null,
      aiCropSourceW: null,
      aiCropSourceH: null,
      aiCropIsCustom: false,
    })
  } finally {
    globalThis.window = previousWindow
    globalThis.Image = previousImage
  }
})

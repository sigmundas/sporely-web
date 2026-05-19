import test from 'node:test'
import assert from 'node:assert/strict'

import {
  _extractAltitudeFromRawGps,
  _extractAltitudeRefFromRawGps,
  _extractLatLonFromRawGps,
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
})

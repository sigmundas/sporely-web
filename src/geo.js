import { t } from './i18n.js'
import { state } from './state.js'

function _syncGpsDisplays(text, gpsState) {
  document.querySelectorAll('.gps-display').forEach(el => {
    el.textContent = text
    const pill = el.closest('.gps-pill')
    if (pill) pill.dataset.gpsState = gpsState
  })
}

export function startGeo() {
  if (!navigator.geolocation) {
    _syncGpsDisplays(t('capture.gpsUnavailable') || 'GPS unavailable', 'unavailable')
    return
  }

  navigator.geolocation.watchPosition(
    pos => {
      state.gps = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        altitude: pos.coords.altitude,
      }

      const lat = pos.coords.latitude.toFixed(5)
      const lon = pos.coords.longitude.toFixed(5)

      _syncGpsDisplays(`${lat}° N, ${lon}° E`, 'fix')

      window.dispatchEvent(new CustomEvent('sporely:gps-updated', { detail: state.gps }))

      if (state.reviewContext?.source !== 'import') {
        const reviewCoords = document.getElementById('review-coords-text')
        if (reviewCoords)
          reviewCoords.textContent = `${parseFloat(lat).toFixed(4)}° N, ${parseFloat(lon).toFixed(4)}° E`

        const metaAccuracy = document.getElementById('meta-accuracy')
        if (metaAccuracy)
          metaAccuracy.textContent = `± ${Math.round(pos.coords.accuracy)} m`

        if (pos.coords.altitude) {
          const metaAlt = document.getElementById('meta-altitude')
          if (metaAlt) metaAlt.textContent = `${Math.round(pos.coords.altitude)} m ASL`
        }
      }
    },
    () => {
      if (state.gps && Number.isFinite(state.gps.lat) && Number.isFinite(state.gps.lon)) {
        const lat = state.gps.lat.toFixed(5)
        const lon = state.gps.lon.toFixed(5)
        _syncGpsDisplays(`${lat}° N, ${lon}° E`, 'fix')
        return
      }
      _syncGpsDisplays(t('capture.gpsUnavailable') || 'GPS unavailable', 'unavailable')
    },
    { enableHighAccuracy: true }
  )
}

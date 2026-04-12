import { state } from './state.js'

export function startGeo() {
  if (!navigator.geolocation) return

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

      const gpsDisplay = document.getElementById('gps-display')
      if (gpsDisplay) gpsDisplay.textContent = `${lat}° N, ${lon}° E`

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
      const gpsDisplay = document.getElementById('gps-display')
      if (gpsDisplay) gpsDisplay.textContent = 'GPS unavailable'
    },
    { enableHighAccuracy: true }
  )
}

// Scale-bar overlay for calibrated microscope images and the spore mosaic.
// Same nice-number policy as sporely-landing's scaleBar.ts: prefer a bar of
// 15-25 % of the visible width, closest to 20 %, else the largest one that
// still fits under 25 %.

const NICE_MICRONS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000]
const TARGET_FRACTION = 0.2
const MIN_BAND = 0.15
const MAX_BAND = 0.25
const MIN_LEGIBLE_PX = 24

function _positive(value) {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null
}

/**
 * µm per pixel of the image actually loaded. The calibration is per pixel of
 * the calibrated source (`source_width` px wide for a microscope image, the
 * atlas width for a mosaic); a downscaled variant covers the same field with
 * fewer pixels. Without a known source width the loaded image is assumed to
 * be the calibrated one.
 */
export function umPerLoadedPixel({ umPerSourcePx, sourceWidthPx, loadedWidthPx }) {
  const scale = _positive(umPerSourcePx)
  const loaded = _positive(loadedWidthPx)
  if (!scale || !loaded) return null
  const source = _positive(sourceWidthPx)
  return source ? scale * source / loaded : scale
}

export function pickScaleBar(umPerDisplayPx, visibleWidthPx) {
  const umPerPx = _positive(umPerDisplayPx)
  const width = _positive(visibleWidthPx)
  if (!umPerPx || !width) return null
  const target = width * TARGET_FRACTION
  let inBand = null
  let fallback = null
  for (const microns of NICE_MICRONS) {
    const px = microns / umPerPx
    if (px > width * MAX_BAND) break
    fallback = { microns, px }
    if (px >= width * MIN_BAND && (!inBand || Math.abs(px - target) < Math.abs(inBand.px - target))) {
      inBand = { microns, px }
    }
  }
  const chosen = inBand || fallback
  return chosen && chosen.px >= MIN_LEGIBLE_PX ? chosen : null
}

export function formatScaleBarLabel(microns) {
  const value = _positive(microns)
  if (!value) return ''
  return value >= 1000 ? `${value / 1000} mm` : `${value} µm`
}

export function createScaleBarElement(extraClass = '') {
  const el = document.createElement('div')
  el.className = `scale-bar${extraClass ? ` ${extraClass}` : ''}`
  el.setAttribute('aria-hidden', 'true')
  el.style.display = 'none'
  const label = document.createElement('span')
  label.className = 'scale-bar-label'
  const line = document.createElement('span')
  line.className = 'scale-bar-line'
  el.append(label, line)
  return el
}

export function renderScaleBar(el, choice) {
  if (!el) return
  if (!choice) {
    el.style.display = 'none'
    return
  }
  el.querySelector('.scale-bar-label').textContent = formatScaleBarLabel(choice.microns)
  el.querySelector('.scale-bar-line').style.width = `${Math.round(choice.px)}px`
  el.style.display = ''
}

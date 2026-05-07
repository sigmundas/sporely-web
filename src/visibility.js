export const VISIBILITY_PRIVATE = 'private'
export const VISIBILITY_FRIENDS = 'friends'
export const VISIBILITY_PUBLIC = 'public'
export const CLOUD_VISIBILITY_DRAFT = 'draft'

const UI_VALUES = new Set([VISIBILITY_PRIVATE, VISIBILITY_FRIENDS, VISIBILITY_PUBLIC])
const CAPTURE_VALUES = new Set([VISIBILITY_PRIVATE, VISIBILITY_FRIENDS, VISIBILITY_PUBLIC])

export function normalizeVisibility(value, fallback = VISIBILITY_PRIVATE) {
  const raw = String(value || '').trim().toLowerCase()
  if (raw === CLOUD_VISIBILITY_DRAFT) return VISIBILITY_PRIVATE
  if (UI_VALUES.has(raw)) return raw

  const fallbackRaw = String(fallback || '').trim().toLowerCase()
  if (fallbackRaw === CLOUD_VISIBILITY_DRAFT) return VISIBILITY_PRIVATE
  return UI_VALUES.has(fallbackRaw) ? fallbackRaw : VISIBILITY_PRIVATE
}

export function normalizeCaptureVisibility(value, fallback = VISIBILITY_PRIVATE) {
  const normalized = normalizeVisibility(value, fallback)
  if (CAPTURE_VALUES.has(normalized)) return normalized
  const fallbackNormalized = normalizeVisibility(fallback, VISIBILITY_PRIVATE)
  return CAPTURE_VALUES.has(fallbackNormalized) ? fallbackNormalized : VISIBILITY_PRIVATE
}

export function toCloudVisibility(value, fallback = VISIBILITY_PRIVATE) {
  return normalizeVisibility(value, fallback)
}

export function fromCloudVisibility(value, fallback = VISIBILITY_PRIVATE) {
  return normalizeVisibility(value, fallback)
}

export function normalizeObservationVisibility(value, fallback = VISIBILITY_PRIVATE) {
  return fromCloudVisibility(value, fallback)
}

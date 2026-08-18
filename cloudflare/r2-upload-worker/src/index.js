import {
  MAX_LOCATION_SUGGESTIONS,
  buildDawaSuggestion,
  buildLocationSuggestionsFromNominatim,
} from '../../../src/location-suggestion-builder.js'
import {
  IMAGE_TOO_LARGE_FOR_PLAN_MESSAGE,
  CLOUD_FULL_RESIZE_MAX_EDGE,
  CLOUD_FULL_RESIZE_MAX_PIXELS,
  CLOUD_HIGH_FULL_BYTE_CAP,
  CLOUD_STANDARD_FULL_BYTE_CAP,
  buildCloudUploadPolicy,
  normalizeCloudPlanProfile,
} from '../../../src/cloud-media-policy.js'

const DEFAULT_MAX_UPLOAD_BYTES = 15 * 1024 * 1024
const DEFAULT_FREE_STORAGE_QUOTA_BYTES = 0
const DEFAULT_ALLOWED_METHODS = 'GET, PUT, DELETE, OPTIONS, POST'
const DEFAULT_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Cache-Control',
  'X-Sporely-Upload-Mode',
  'X-Sporely-Cloud-Plan',
  'X-Sporely-Upload-Variant',
  'X-Sporely-Quality-Profile',
  'X-Sporely-Encoding-Quality',
  'X-Sporely-Encoding-Format',
  'X-Sporely-Source-Width',
  'X-Sporely-Source-Height',
  'X-Sporely-Stored-Width',
  'X-Sporely-Stored-Height',
  'X-Sporely-Upload-Origin',
  'X-Sporely-Upload-Type',
  'X-Sporely-Image-Id',
  'X-Sporely-Mosaic-Id',
].join(', ')
const DEFAULT_ALLOWED_HEADER_NAMES = DEFAULT_ALLOWED_HEADERS
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)
const JWKS_CACHE_TTL_MS = 10 * 60 * 1000
const ARTS_MAX_DIST = 0.006
const NOMINATIM_INTERVAL_MS = 1000
const WORKER_VERSION_MARKER = 'sporely-r2-upload-worker@source'
const ARTSORAKEL_UPSTREAM_URL = 'https://ai.artsdatabanken.no/identify'

function resolveArtsorakelToken(env) {
  const token = String(env?.ARTSORAKEL_API_TOKEN || '').trim()
  if (!token) {
    throw httpError(
      500,
      'artsorakel_token_missing',
      'ARTSORAKEL_API_TOKEN is not configured on the Worker',
    )
  }
  return token
}

let cachedJwks = null
let cachedJwksAt = 0
let lastNominatimRequestStartedAt = 0
let nominatimQueue = Promise.resolve()

export async function _testFetch(request, env, ctx) {
  return handleRequest(request, env, ctx)
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx)
    } catch (error) {
      const status = Number(error?.status || 500)
      const message = status >= 500 ? 'Internal server error' : String(error?.message || 'Request failed')
      const payload = {
        error: error?.code || 'request_failed',
        message,
      }
      if (error && typeof error.details === 'object' && error.details) {
        payload.details = error.details
      }
      return jsonResponse(payload, status, request, env)
    }
  },
}

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url)

  if (request.method === 'OPTIONS') {
    return handleOptions(request, env)
  }

  if (url.pathname === '/healthz') {
    // Report the media storage mode + binding availability so operators
    // can confirm the worker is running in the expected posture without
    // exposing any secret material. Storage mode is derived defensively:
    // an invalid MEDIA_STORAGE_MODE value here is surfaced rather than
    // silently defaulted.
    let storageMode
    let storageModeError = null
    try {
      storageMode = resolveMediaStorageMode(env)
    } catch (e) {
      storageMode = null
      storageModeError = e?.code || e?.message || 'invalid'
    }
    return jsonResponse(
      {
        ok: storageModeError === null,
        service: 'sporely-r2-upload-worker',
        workerVersion: WORKER_VERSION_MARKER,
        mediaStorageMode: storageMode,
        mediaStorageModeError: storageModeError,
        writeBindingReady: storageMode === 'private'
          ? !!env.PRIVATE_MEDIA_BUCKET
          : storageMode === 'legacy' ? !!env.MEDIA_BUCKET : false,
        bindings: {
          hasMediaBucket: !!env.MEDIA_BUCKET,
          hasPrivateMediaBucket: !!env.PRIVATE_MEDIA_BUCKET,
        },
        legacyBucketBound: !!env.MEDIA_BUCKET,
        privateBucketBound: !!env.PRIVATE_MEDIA_BUCKET,
        mediaVariants: Array.from(MEDIA_VARIANTS),
        supportedMediaVariants: Array.from(MEDIA_VARIANTS),
        mediaPolicy: {
          fullResizeMaxPixels: CLOUD_FULL_RESIZE_MAX_PIXELS,
          fullResizeMaxEdge: CLOUD_FULL_RESIZE_MAX_EDGE,
          standardFullByteCap: CLOUD_STANDARD_FULL_BYTE_CAP,
          highFullByteCap: CLOUD_HIGH_FULL_BYTE_CAP,
        },
      },
      200,
      request,
      env,
    )
  }

  if (request.method === 'GET' && url.pathname === '/reverse-location') {
    return handleReverseLocation(request, env, url)
  }

  if (request.method === 'POST' && url.pathname === '/artsorakel') {
    return handleArtsorakel(request, env, ctx)
  }

  if (request.method === 'POST' && url.pathname === '/artsorakel/media') {
    return handleArtsorakelMedia(request, env, ctx)
  }

  if (request.method === 'PUT' && url.pathname.startsWith('/upload/')) {
    return handleUpload(request, env, ctx, url)
  }

  if (request.method === 'GET' && url.pathname.startsWith('/upload/')) {
    return handleDownload(request, env, ctx, url)
  }

  if (request.method === 'DELETE' && url.pathname.startsWith('/upload/')) {
    return handleDelete(request, env, ctx, url)
  }

  // Stage 2 image-media delivery route: image-ID + variant based.
  if (request.method === 'GET' && url.pathname.startsWith('/m/')) {
    return handleMediaDelivery(request, env, ctx, url)
  }

  // Stage 2 mosaic delivery route (round-3 amendment): identity is a
  // `spore_measurement_mosaics.id`; there is no variant. Authorization
  // flows through `public.media_authorize_mosaic_delivery`.
  if (request.method === 'GET' && url.pathname.startsWith('/mm/')) {
    return handleMosaicDelivery(request, env, ctx, url)
  }

  throw httpError(404, 'not_found', 'Route not found')
}

async function handleReverseLocation(request, env, url) {
  const origin = resolveAllowedOrigin(request, env)
  if (request.headers.get('Origin') && !origin) {
    throw httpError(403, 'origin_not_allowed', 'Origin is not allowed')
  }

  const lat = Number(url.searchParams.get('lat'))
  const lon = Number(url.searchParams.get('lon'))
  if (!isUsableCoordinate(lat, lon)) {
    throw httpError(400, 'invalid_coordinates', 'Valid lat and lon query parameters are required')
  }

  const prefer = String(url.searchParams.get('prefer') || '').trim().toLowerCase()
  if (prefer !== 'international') {
    const artsName = await fetchArtsdatabankenSuggestion(lat, lon)
    if (artsName) {
      return jsonResponse(
        {
          suggestions: [artsName],
          latitude: lat,
          longitude: lon,
          country_code: 'no',
          country_name: 'Norge',
          nominatim_display_name: null,
          source: 'artsdatabanken',
        },
        200,
        request,
        env,
        origin,
      )
    }
  }

  const nominatim = await fetchNominatim(lat, lon, env)
  const address = nominatim?.address || {}
  const countryCode = stringOrNull(address.country_code)?.toLowerCase() || null
  const countryName = stringOrNull(address.country)
  const displayName = stringOrNull(nominatim?.display_name)
  const nominatimDetails = buildLocationSuggestionsFromNominatim(nominatim)
  const suggestions = []
  let source = 'nominatim'

  if (countryCode === 'no') {
    source = 'nominatim'
  } else if (countryCode === 'dk') {
    const dawaName = await fetchDawaSuggestion(lat, lon)
    if (dawaName) {
      suggestions.push(dawaName)
      source = 'dawa'
    }
  }

  suggestions.push(...nominatimDetails.suggestions)
  const finalSuggestions = dedupeText(suggestions).slice(0, MAX_LOCATION_SUGGESTIONS)
  const debug = {
    raw_nominatim_display_name: nominatimDetails.nominatim_display_name,
    structured_address_fields_used: nominatimDetails.structured_address_fields_used,
    display_name_parts_used: nominatimDetails.display_name_parts_used,
    final_suggestions: finalSuggestions,
  }

  return jsonResponse(
    {
      suggestions: finalSuggestions,
      latitude: lat,
      longitude: lon,
      country_code: countryCode,
      country_name: countryName,
      nominatim_display_name: displayName,
      debug,
      source,
    },
    200,
    request,
    env,
    origin,
  )
}

function handleOptions(request, env) {
  const origin = resolveAllowedOrigin(request, env)
  if (request.headers.get('Origin') && !origin) {
    throw httpError(403, 'origin_not_allowed', 'Origin is not allowed')
  }
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request, env, origin),
  })
}

async function fetchNominatim(lat, lon, env) {
  await queueNominatimTurn()

  const url = new URL('https://nominatim.openstreetmap.org/reverse')
  url.searchParams.set('lat', String(lat))
  url.searchParams.set('lon', String(lon))
  url.searchParams.set('format', 'json')
  url.searchParams.set('addressdetails', '1')

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': String(env.NOMINATIM_USER_AGENT || 'SporelyApp/1.0 (contact@sporely.no)'),
    },
    cf: { cacheTtl: 3600, cacheEverything: true },
  })
  if (!response.ok) return {}
  return safeJsonObject(response)
}

function queueNominatimTurn() {
  const run = nominatimQueue
    .catch(() => {})
    .then(async () => {
      const elapsed = Date.now() - lastNominatimRequestStartedAt
      if (elapsed < NOMINATIM_INTERVAL_MS) {
        await delay(NOMINATIM_INTERVAL_MS - elapsed)
      }
      lastNominatimRequestStartedAt = Date.now()
    })
  nominatimQueue = run.catch(() => {})
  return run
}

async function fetchArtsdatabankenSuggestion(lat, lon) {
  const url = new URL('https://stedsnavn.artsdatabanken.no/v1/punkt')
  url.searchParams.set('lat', String(lat))
  url.searchParams.set('lng', String(lon))
  url.searchParams.set('zoom', '45')

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  })
  if (!response.ok) return ''
  const data = await safeJsonObject(response)
  const dist = Number(data?.dist)
  if (!Number.isFinite(dist) || dist > ARTS_MAX_DIST) return ''
  return stringOrNull(data?.navn) || ''
}

async function fetchDawaSuggestion(lat, lon) {
  const url = new URL('https://api.dataforsyningen.dk/adgangsadresser/reverse')
  url.searchParams.set('x', String(lon))
  url.searchParams.set('y', String(lat))

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  })
  if (!response.ok) return ''
  const data = await safeJsonObject(response)
  return buildDawaSuggestion(data)
}

async function handleUpload(request, env, ctx, url) {
  // Stage 2: bucket selection is entirely governed by MEDIA_STORAGE_MODE.
  // An accidental binding omission FAILS the request rather than silently
  // downgrading to the legacy public bucket.
  const uploadTarget = selectUploadBucket(env)
  const uploadBucket = uploadTarget.bucket
  const canonicalBucket = uploadTarget.name  // 'legacy' | 'private'
  const storageMode = uploadTarget.mode      // 'legacy' | 'private'

  const origin = resolveAllowedOrigin(request, env)
  if (request.headers.get('Origin') && !origin) {
    throw httpError(403, 'origin_not_allowed', 'Origin is not allowed')
  }

  const authHeader = request.headers.get('Authorization')
  const token = parseBearerToken(authHeader)
  const claims = await verifySupabaseJwt(token, env, ctx)

  const key = normalizeObjectKey(url.pathname.slice('/upload/'.length))
  if (!key) {
    throw httpError(400, 'invalid_key', 'Missing upload key')
  }
  if (!claims?.sub || !key.startsWith(`${claims.sub}/`)) {
    throw httpError(403, 'key_not_allowed', 'Upload key must start with the authenticated user id')
  }

  const contentLength = parseIntegerHeader(request.headers.get('Content-Length'))
  const maxUploadBytes = parsePositiveInt(env.MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES)
  if (contentLength !== null && contentLength > maxUploadBytes) {
    throw httpError(413, 'payload_too_large', `Upload exceeds ${maxUploadBytes} bytes`, {
      storagePath: key,
      contentLength,
      configuredMaxUploadBytes: maxUploadBytes,
    })
  }
  if (!request.body) {
    throw httpError(400, 'missing_body', 'Request body is required')
  }

  const contentType = String(request.headers.get('Content-Type') || '').trim() || 'application/octet-stream'
  if (!contentType.startsWith('image/') && contentType !== 'application/octet-stream') {
    throw httpError(415, 'unsupported_media_type', 'Only image uploads are supported')
  }

  const bodyBuffer = await request.arrayBuffer()
  const bodyBytes = bodyBuffer.byteLength
  if (bodyBytes > maxUploadBytes) {
    throw httpError(413, 'payload_too_large', `Upload exceeds ${maxUploadBytes} bytes`, {
      storagePath: key,
      bodyBytes,
      configuredMaxUploadBytes: maxUploadBytes,
    })
  }

  const existingCopies = await Promise.all(configuredBucketRoles(env).map(async target => {
    try {
      const object = await target.bucket.head(key)
      return { ...target, object, bytes: mediaObjectSize(object), ok: true }
    } catch (error) {
      return { ...target, object: null, bytes: 0, ok: false, error }
    }
  }))
  const inspectionFailure = existingCopies.find(target => !target.ok)
  if (inspectionFailure) {
    throw httpError(502, 'media_upload_inspection_failed',
      `Could not inspect ${inspectionFailure.role} storage before upload`)
  }
  const targetCopy = existingCopies.find(target => target.role === canonicalBucket)
  const existingObject = targetCopy?.object || null
  const existingLogicalBytes = Math.max(
    0, ...existingCopies.map(target => Number(target.bytes || 0)))
  const alternateLogicalBytes = Math.max(
    0,
    ...existingCopies
      .filter(target => target.role !== canonicalBucket)
      .map(target => Number(target.bytes || 0)),
  )

  // Round-3 amendment: real overwrite state machine.
  //
  // The invariant is that a post-write failure MUST NOT destroy the
  // previously valid object. R2's `put` is a destructive atomic
  // replace, so in the overwrite case we cannot write the new body
  // directly to `key` and then roll back on a downstream failure —
  // the original bytes are already gone.
  //
  // For private mode, when an object already exists we:
  //   1. Write the new body to a temporary key `<key>.pending-<nonce>`.
  //   2. Run quota + canonical_bucket finalization.
  //   3. On success: copy temp → final (a fresh `put(key, tempBody)`),
  //      then delete the temp key.
  //   4. On any failure after step 1: delete ONLY the temp key. The
  //      original `key` object is untouched.
  //
  // For a first-write (no existingObject), the destination is
  // unoccupied, so we write directly. In legacy mode we retain the
  // historic behaviour for backward compatibility.
  const isOverwrite = existingObject !== null && existingObject !== undefined
  const useTempKeyForOverwrite = canonicalBucket === 'private' && isOverwrite
  const nonce = crypto.randomUUID().replace(/-/g, '')
  const writeKey = useTempKeyForOverwrite ? `${key}.pending-${nonce}` : key
  const resultingLogicalBytes = Math.max(bodyBytes, alternateLogicalBytes)
  const accountingStorageDelta = resultingLogicalBytes - existingLogicalBytes
  const storageDelta = Math.max(0, accountingStorageDelta)
  const rawProfile = await fetchStorageProfile(env, claims.sub)
  if (rawProfile?.is_banned === true) {
    throw httpError(403, 'user_banned', 'User is banned from uploading media')
  }
  const profile = normalizeCloudPlanProfile(rawProfile)
  assertStorageQuotaAllowsUpload(profile, storageDelta, env)

  const uploadModeHeader = String(request.headers.get('X-Sporely-Upload-Mode') || '').trim().toLowerCase()
  const uploadMode = uploadModeHeader === 'full' ? 'full' : 'reduced'
  // Upload types and authorized-delivery variants are separate contracts.
  // Existing clients send the historic X-Sporely-Upload-Variant header, so
  // prefer the future Upload-Type spelling but retain Variant as the wire
  // fallback. In legacy mode this includes the desktop `spore_mosaic` upload
  // type; mosaic delivery still uses /mm/<mosaic_id>, never /m/.../mosaic.
  const rawUploadType = String(
    request.headers.get('X-Sporely-Upload-Type')
    || request.headers.get('X-Sporely-Upload-Variant')
    || 'full',
  ).trim().toLowerCase() || 'full'
  const uploadType = normalizeUploadType(rawUploadType)
  if (!LEGACY_UPLOAD_TYPES.has(uploadType)) {
    throw httpError(400, 'invalid_upload_type',
      `Upload type must be one of: ${Array.from(LEGACY_UPLOAD_TYPES).join(', ')}`)
  }
  // Stage 2 server-validated image identity. In `private` mode the client
  // MUST have already inserted an `observation_images` row and must
  // present its id in `X-Sporely-Image-Id`; the worker verifies the row
  // exists, is owned by the caller, and that its `storage_path` matches
  // the URL's key. This closes the "key prefix = authorization" gap for
  // new uploads. In `legacy` mode the header is optional so existing
  // client releases continue to work during the phased rollout.
  const requestedImageIdRaw = String(request.headers.get('X-Sporely-Image-Id') || '').trim()
  const requestedMosaicIdRaw = String(request.headers.get('X-Sporely-Mosaic-Id') || '').trim()
  let validatedImageId = null
  let validatedMosaicId = null
  if (uploadType === 'spore_mosaic') {
    if (requestedMosaicIdRaw) {
      const parsedMosaicId = Number.parseInt(requestedMosaicIdRaw, 10)
      if (!Number.isFinite(parsedMosaicId) || parsedMosaicId <= 0
          || String(parsedMosaicId) !== requestedMosaicIdRaw) {
        throw httpError(400, 'invalid_mosaic_id',
          'X-Sporely-Mosaic-Id must be a positive integer')
      }
      const rowMatch = await verifyMosaicRowMatchesUpload(
        env, parsedMosaicId, claims.sub, key)
      if (!rowMatch.ok) {
        throw httpError(rowMatch.status, rowMatch.code, rowMatch.message)
      }
      validatedMosaicId = parsedMosaicId
    } else if (storageMode === 'private') {
      throw httpError(400, 'mosaic_id_required',
        'X-Sporely-Mosaic-Id header is required for private mosaic uploads')
    }
  } else if (requestedImageIdRaw) {
    const parsedImageId = Number.parseInt(requestedImageIdRaw, 10)
    if (!Number.isFinite(parsedImageId) || parsedImageId <= 0
        || String(parsedImageId) !== requestedImageIdRaw) {
      throw httpError(400, 'invalid_image_id',
        'X-Sporely-Image-Id must be a positive integer')
    }
    const rowMatch = await verifyImageRowMatchesUpload(env, parsedImageId, claims.sub, key, uploadType)
    if (!rowMatch.ok) {
      throw httpError(rowMatch.status, rowMatch.code, rowMatch.message)
    }
    validatedImageId = parsedImageId
  } else if (storageMode === 'private') {
    throw httpError(400, 'image_id_required',
      'X-Sporely-Image-Id header is required when MEDIA_STORAGE_MODE=private')
  }
  const uploadPolicy = buildCloudUploadPolicy(profile, { uploadMode })
  const encodingQualityHeader = Number.parseFloat(String(request.headers.get('X-Sporely-Encoding-Quality') || ''))
  const encodingFormatHeader = String(request.headers.get('X-Sporely-Encoding-Format') || '').trim().toLowerCase()
  const sourceWidth = parseIntegerHeader(request.headers.get('X-Sporely-Source-Width'))
  const sourceHeight = parseIntegerHeader(request.headers.get('X-Sporely-Source-Height'))
  const storedWidth = parseIntegerHeader(request.headers.get('X-Sporely-Stored-Width'))
  const storedHeight = parseIntegerHeader(request.headers.get('X-Sporely-Stored-Height'))
  const encodingFormat = encodingFormatHeader || String(contentType || '').toLowerCase()
  const normalizedStoredWidth = Number.isFinite(storedWidth) ? Math.max(1, storedWidth) : null
  const normalizedStoredHeight = Number.isFinite(storedHeight) ? Math.max(1, storedHeight) : null
  const storedPixels = normalizedStoredWidth !== null && normalizedStoredHeight !== null
    ? normalizedStoredWidth * normalizedStoredHeight
    : null
  const storedLongestEdge = normalizedStoredWidth !== null && normalizedStoredHeight !== null
    ? Math.max(normalizedStoredWidth, normalizedStoredHeight)
    : null
  const storedPixelCap = Math.max(
    1,
    Number(
      uploadPolicy.resizeMaxPixels
      || uploadPolicy.resize_max_pixels
      || uploadPolicy.maxPixels
      || 0,
    ) || 0,
  )
  const resizeMaxEdgeValue = Number(uploadPolicy.resizeMaxEdge || uploadPolicy.resize_max_edge || 0)
  const storedEdgeCap = Number.isFinite(resizeMaxEdgeValue) && resizeMaxEdgeValue > 0 ? Math.max(1, resizeMaxEdgeValue) : null
  const buildImageTooLargeDetails = (reason, planByteCap) => ({
    reason,
    bodyBytes,
    planByteCap,
    configuredByteCap: planByteCap,
    cloudPlan: String(profile?.cloudPlan || 'free'),
    qualityProfile: String(uploadPolicy?.qualityProfile || profile?.qualityProfile || 'standard'),
    sourceWidth: Number.isFinite(sourceWidth) ? sourceWidth : null,
    sourceHeight: Number.isFinite(sourceHeight) ? sourceHeight : null,
    storedWidth: normalizedStoredWidth,
    storedHeight: normalizedStoredHeight,
    storedPixels,
    storedPixelCap,
    resizeMaxEdge: storedEdgeCap,
    uploadMode,
    uploadVariant: uploadType,
    encodingFormat,
    contentType,
    storagePath: key,
  })

  if (uploadType !== 'thumb') {
    const planByteCap = Math.max(1, Number(uploadPolicy.fullImageByteCap || 0) || 0)
    if (bodyBytes > planByteCap) {
      const details = buildImageTooLargeDetails('byte_cap', planByteCap)
      console.error('[r2-upload-worker] rejecting upload by byte cap', details)
      throw httpError(
        413,
        'image_too_large_for_plan',
        IMAGE_TOO_LARGE_FOR_PLAN_MESSAGE,
        details,
      )
    }
    if (normalizedStoredWidth !== null && normalizedStoredHeight !== null) {
      const reason = storedPixels > storedPixelCap
        ? 'pixel_cap'
        : (storedEdgeCap !== null && storedLongestEdge > storedEdgeCap)
          ? 'edge_cap'
          : 'unknown'
      if (reason !== 'unknown') {
        const details = buildImageTooLargeDetails(reason, planByteCap)
        console.error('[r2-upload-worker] rejecting upload by resized dimension cap', details)
        throw httpError(
          413,
          'image_too_large_for_plan',
          IMAGE_TOO_LARGE_FOR_PLAN_MESSAGE,
          details,
        )
      }
    }
  }

  // Stage 2: when writing to the private bucket, the Worker owns the
  // Cache-Control on the R2 object. Client Cache-Control is ignored, so a
  // rogue or misconfigured client cannot produce a public-immutable
  // canonical object. When still writing to the legacy public bucket the
  // client value is honoured for backward compat with in-flight releases.
  const cacheControl = canonicalBucket === 'private'
    ? 'private, no-store'
    : String(request.headers.get('Cache-Control') || 'public, max-age=31536000, immutable').trim()
  const object = await uploadBucket.put(writeKey, bodyBuffer, {
    httpMetadata: {
      contentType,
      cacheControl,
    },
    customMetadata: {
      user_id: String(claims.sub),
      uploaded_at: new Date().toISOString(),
      uploaded_by: String(claims.email || ''),
      upload_mode: String(uploadMode),
      upload_variant: String(uploadType),
      cloud_plan: String(profile?.cloudPlan || 'free'),
      quality_profile: String(uploadPolicy?.qualityProfile || profile?.qualityProfile || 'standard'),
      encoding_quality: Number.isFinite(encodingQualityHeader) ? String(encodingQualityHeader) : '',
      encoding_format: encodingFormat,
      source_width: Number.isFinite(sourceWidth) ? String(sourceWidth) : '',
      source_height: Number.isFinite(sourceHeight) ? String(sourceHeight) : '',
      stored_width: normalizedStoredWidth !== null ? String(normalizedStoredWidth) : '',
      stored_height: normalizedStoredHeight !== null ? String(normalizedStoredHeight) : '',
      stored_bytes: String(bodyBytes),
    },
  })
  // image_count represents logical observation-image rows. Derived thumbs,
  // preserved originals, and observation mosaics contribute bytes but do
  // not create additional logical images.
  const imageDelta = uploadType === 'full'
    && !existingCopies.some(target => !!target.object) ? 1 : 0

  // Failure helper: on any post-put failure we delete ONLY the write
  // target (which is a temp key when we're doing an overwrite).
  // The original `key` object is left untouched in the overwrite case.
  async function rollbackWrittenBytesOnly() {
    await uploadBucket.delete(writeKey).catch(deleteError => {
      console.error('Failed to remove uploaded object during rollback', deleteError)
    })
  }

  let trackedProfile = null
  try {
    trackedProfile = await applyStorageDelta(
      env, claims.sub, accountingStorageDelta, imageDelta)
  } catch (error) {
    await rollbackWrittenBytesOnly()
    throw error
  }

  if (canonicalBucket === 'private'
      && (validatedImageId !== null || validatedMosaicId !== null)) {
    const patch = validatedMosaicId !== null
      ? await markMosaicCanonicalBucketPrivate(env, validatedMosaicId)
      : await markImageCanonicalBucketPrivate(env, validatedImageId)
    if (!patch || !patch.ok) {
      await rollbackWrittenBytesOnly()
      try {
        await applyStorageDelta(env, claims.sub, -accountingStorageDelta, -imageDelta)
      } catch (rollbackError) {
        console.error('Failed to roll back quota after canonical_bucket PATCH error', rollbackError)
      }
      throw httpError(500, 'canonical_bucket_patch_failed',
        `Could not upgrade media canonical_bucket to private (status=${patch?.status})`)
    }
  }

  // Commit: for the temp-key overwrite path, promote temp → final now
  // that DB state is confirmed. Any failure during promotion also
  // leaves the original `key` untouched (we've merely failed to
  // publish the new bytes).
  if (useTempKeyForOverwrite) {
    let promoted = false
    try {
      await uploadBucket.put(key, bodyBuffer, {
        httpMetadata: { contentType, cacheControl },
        customMetadata: {
          user_id: String(claims.sub),
          uploaded_at: new Date().toISOString(),
          uploaded_by: String(claims.email || ''),
          upload_mode: String(uploadMode),
          upload_variant: String(uploadType),
          cloud_plan: String(profile?.cloudPlan || 'free'),
          quality_profile: String(uploadPolicy?.qualityProfile || profile?.qualityProfile || 'standard'),
          encoding_quality: Number.isFinite(encodingQualityHeader) ? String(encodingQualityHeader) : '',
          encoding_format: encodingFormat,
          source_width: Number.isFinite(sourceWidth) ? String(sourceWidth) : '',
          source_height: Number.isFinite(sourceHeight) ? String(sourceHeight) : '',
          stored_width: normalizedStoredWidth !== null ? String(normalizedStoredWidth) : '',
          stored_height: normalizedStoredHeight !== null ? String(normalizedStoredHeight) : '',
          stored_bytes: String(bodyBytes),
          promoted_from_temp: writeKey,
        },
      })
      promoted = true
    } finally {
      // Always delete the temp; even if promotion succeeded we don't
      // want the temp object lingering. If promotion failed, the
      // temp cleanup still runs; the original `key` object is intact
      // regardless.
      await uploadBucket.delete(writeKey).catch(deleteError => {
        console.error('Failed to delete temp upload key after promotion', deleteError)
      })
    }
    if (!promoted) {
      // Try to unwind the DB PATCH we made above so DB and R2 agree.
      if (canonicalBucket === 'private' && validatedImageId !== null && !isOverwrite) {
        // Only if we upgraded canonical_bucket; on overwrite the row
        // was already 'private' before this request so no PATCH to
        // undo. (For an overwrite, canonical_bucket is unchanged.)
      }
      try {
        await applyStorageDelta(env, claims.sub, -accountingStorageDelta, -imageDelta)
      } catch (rollbackError) {
        console.error('Failed to roll back quota after promotion failure', rollbackError)
      }
      throw httpError(500, 'promotion_failed',
        'Failed to promote temp upload to the canonical key; previous bytes preserved')
    }
  }

  // Stage 2: only emit a public `url` while still writing to the legacy
  // bucket. Once uploads are private-by-default, clients must resolve
  // media via the worker's `GET /m/<image_id>/<variant>` route — they no
  // longer receive an unrestricted bucket URL in the response.
  return jsonResponse(
    {
      ok: true,
      key,
      etag: object?.etag || null,
      size: bodyBytes,
      canonical_bucket: canonicalBucket,
      storage: trackedProfile,
      ...(canonicalBucket === 'legacy' ? { url: publicMediaUrl(env, key) } : {}),
    },
    201,
    request,
    env,
    origin,
  )
}

async function handleDownload(request, env, ctx, url) {
  const origin = resolveAllowedOrigin(request, env)
  if (request.headers.get('Origin') && !origin) {
    throw httpError(403, 'origin_not_allowed', 'Origin is not allowed')
  }

  const authHeader = request.headers.get('Authorization')
  const token = parseBearerToken(authHeader)
  const claims = await verifySupabaseJwt(token, env, ctx)

  const key = normalizeObjectKey(url.pathname.slice('/upload/'.length))
  if (!key) {
    throw httpError(400, 'invalid_key', 'Missing download key')
  }
  if (!await canReadMediaKey(env, claims, key)) {
    throw httpError(403, 'key_not_allowed', 'Download key is not available to the authenticated user')
  }

  // Authorization is resolved once for the canonical key before physical
  // storage lookup. Bucket fallback cannot turn a denied identity into an
  // allowed one; it only locates the same authorized key during migration.
  const located = await findMediaObject(env, key)
  if (!located) {
    throw httpError(404, 'media_not_found', 'Media object was not found')
  }
  const object = located.object

  const headers = corsHeaders(request, env, origin)
  object.writeHttpMetadata(headers)
  if (object.httpEtag) headers.set('ETag', object.httpEtag)
  headers.set('Cache-Control', 'private, max-age=300')

  return new Response(object.body, {
    status: 200,
    headers,
  })
}

async function handleDelete(request, env, ctx, url) {
  // Account-deletion clean-up (and normal per-image delete) must remove the
  // object regardless of whether it lives in the legacy public bucket or in
  // the private bucket. The `media_authorize_delivery` RPC records
  // canonical_bucket per row, but this route is called with just the object
  // key — we don't know which bucket ahead of time. Attempt both bindings
  // that are configured; a missing object in either is a no-op.
  if (!env.MEDIA_BUCKET && !env.PRIVATE_MEDIA_BUCKET) {
    throw httpError(500, 'missing_bucket', 'No R2 bucket bindings are configured')
  }

  const origin = resolveAllowedOrigin(request, env)
  if (request.headers.get('Origin') && !origin) {
    throw httpError(403, 'origin_not_allowed', 'Origin is not allowed')
  }

  const authHeader = request.headers.get('Authorization')
  const token = parseBearerToken(authHeader)
  const claims = await verifySupabaseJwt(token, env, ctx)

  const key = normalizeObjectKey(url.pathname.slice('/upload/'.length))
  if (!key) {
    throw httpError(400, 'invalid_key', 'Missing upload key')
  }
  if (!claims?.sub || !key.startsWith(`${claims.sub}/`)) {
    throw httpError(403, 'key_not_allowed', 'Delete key must start with the authenticated user id')
  }

  const deletion = await deleteMediaObjectCopies(env, key, {
    beforeDelete: async snapshot => {
      await prepareMediaDeleteAccounting(
        env,
        claims.sub,
        key,
        snapshot.logicalBytes,
        isPrimaryImageKey(key) && snapshot.held ? 1 : 0,
      )
    },
  })
  if (!deletion.ok) {
    throw httpError(
      502,
      'media_delete_partial_failure',
      'Media cleanup was incomplete and can be retried',
      {
        key,
        targets: deletion.targets,
      },
    )
  }

  // User quota is logical media usage, not migration-copy usage. A key that
  // temporarily exists in both buckets counts once, using the largest copy
  // as the conservative logical size. Backfill therefore cannot double the
  // user's quota, and deletion cannot double-decrement it.
  const trackedProfile = await finalizeMediaDeleteAccounting(env, claims.sub, key)

  return jsonResponse(
    {
      ok: true,
      key,
      deleted: true,
      buckets: {
        legacy: deletion.targets.some(target => target.role === 'legacy' && target.present),
        private: deletion.targets.some(target => target.role === 'private' && target.present),
      },
      targets: deletion.targets,
      storage: trackedProfile,
    },
    200,
    request,
    env,
    origin,
  )
}

/**
 * Delete one logical object identity from every applicable bucket binding.
 * This deliberately does not consult MEDIA_STORAGE_MODE: old objects may
 * remain legacy-only after private writes begin, while backfill may leave a
 * temporary copy in both buckets.
 *
 * A failed HEAD is not followed by DELETE for that role because doing so
 * would discard the only byte count available for an accounting-safe retry.
 * Other configured roles are still attempted. Missing objects are successful
 * no-ops, and an unbound future private bucket is simply not applicable.
 */
export async function deleteMediaObjectCopies(env, key, options = {}) {
  const bindings = configuredBucketRoles(env)

  if (!bindings.length) {
    throw httpError(500, 'missing_bucket', 'No R2 bucket bindings are configured')
  }

  const inspectedTargets = await Promise.all(bindings.map(async ({ role, bucket }) => {
    let object
    try {
      object = await bucket.head(key)
    } catch (error) {
      return {
        role,
        configured: true,
        present: null,
        deleted: false,
        ok: false,
        phase: 'head',
        error: safeOperationError(error),
      }
    }

    const present = !!object
    const bytes = mediaObjectSize(object)
    return { role, bucket, configured: true, present, bytes, ok: true }
  }))

  if (inspectedTargets.some(target => !target.ok)) {
    return {
      ok: false,
      logicalBytes: Math.max(0, ...inspectedTargets.map(target => Number(target.bytes || 0))),
      targets: inspectedTargets.map(({ bucket: _bucket, ...target }) => target),
    }
  }

  const logicalBytes = Math.max(0, ...inspectedTargets.map(target => Number(target.bytes || 0)))
  const held = inspectedTargets.some(target => target.present)
  if (typeof options.beforeDelete === 'function') {
    await options.beforeDelete({ logicalBytes, held })
  }

  const targets = await Promise.all(inspectedTargets.map(async target => {
    const { bucket, ...result } = target
    try {
      await bucket.delete(key)
      return { ...result, deleted: true }
    } catch (error) {
      return {
        ...result,
        deleted: false,
        ok: false,
        phase: 'delete',
        error: safeOperationError(error),
      }
    }
  }))

  return {
    ok: targets.every(target => target.ok),
    logicalBytes,
    targets,
  }
}

function safeOperationError(error) {
  const code = String(error?.code || error?.name || 'operation_failed').trim()
  return code.slice(0, 120)
}

async function fetchStorageProfile(env, userId) {
  if (!hasSupabaseServiceRole(env)) return null

  const query = [
    `id=eq.${encodeURIComponent(userId)}`,
    'select=is_pro,cloud_plan,storage_quota_bytes,total_storage_bytes,storage_used_bytes,image_count,is_banned',
    'limit=1',
  ].join('&')
  const response = await supabaseRestFetch(env, `/rest/v1/profiles?${query}`, { method: 'GET' })
  if (!response.ok) {
    throw httpError(500, 'profile_fetch_failed', 'Could not fetch storage profile')
  }
  const rows = await response.json()
  return Array.isArray(rows) ? rows[0] || null : null
}

function assertStorageQuotaAllowsUpload(profile, storageDelta, env) {
  if (!profile || storageDelta <= 0) return

  if (profile.cloudPlan === 'pro' || profile.hasProAccess === true) return

  const quota = parseNonNegativeInt(profile.storageQuotaBytes, parseNonNegativeInt(env.FREE_STORAGE_QUOTA_BYTES, DEFAULT_FREE_STORAGE_QUOTA_BYTES))
  if (!quota) return

  const used = parseNonNegativeInt(profile.storageUsedBytes, 0)
  if (used + storageDelta > quota) {
    throw httpError(413, 'storage_quota_exceeded', 'This account has reached its storage limit')
  }
}

async function applyStorageDelta(env, userId, storageDelta, imageDelta) {
  if (!hasSupabaseServiceRole(env) || (!storageDelta && !imageDelta)) return null

  const response = await supabaseRestFetch(env, '/rest/v1/rpc/apply_profile_storage_delta', {
    method: 'POST',
    body: JSON.stringify({
      p_user_id: userId,
      p_storage_delta: Math.trunc(storageDelta),
      p_image_delta: Math.trunc(imageDelta),
    }),
  })
  if (!response.ok) {
    throw httpError(500, 'profile_tally_failed', 'Could not update profile storage tally')
  }
  const rows = await response.json()
  const profile = Array.isArray(rows) ? rows[0] || null : rows
  return profile ? {
    total_storage_bytes: Number(profile.total_storage_bytes || 0),
    storage_used_bytes: Number(profile.storage_used_bytes || 0),
    image_count: Number(profile.image_count || 0),
  } : null
}

async function prepareMediaDeleteAccounting(env, userId, key, storageBytes, imageCount) {
  if (!hasSupabaseServiceRole(env)) return null
  const response = await supabaseRestFetch(env, '/rest/v1/rpc/prepare_media_object_deletion', {
    method: 'POST',
    body: JSON.stringify({
      p_user_id: userId,
      p_storage_key: key,
      p_storage_bytes: Math.max(0, Math.trunc(storageBytes || 0)),
      p_image_count: Math.max(0, Math.trunc(imageCount || 0)),
    }),
  })
  if (!response.ok) {
    throw httpError(500, 'media_delete_accounting_prepare_failed',
      'Could not snapshot media deletion accounting')
  }
  return true
}

async function finalizeMediaDeleteAccounting(env, userId, key) {
  if (!hasSupabaseServiceRole(env)) return null
  const response = await supabaseRestFetch(env, '/rest/v1/rpc/finalize_media_object_deletion', {
    method: 'POST',
    body: JSON.stringify({
      p_user_id: userId,
      p_storage_key: key,
    }),
  })
  if (!response.ok) {
    throw httpError(500, 'media_delete_accounting_finalize_failed',
      'Could not finalize media deletion accounting')
  }
  const rows = await response.json()
  const profile = Array.isArray(rows) ? rows[0] || null : rows
  return profile ? {
    total_storage_bytes: Number(profile.total_storage_bytes || 0),
    storage_used_bytes: Number(profile.storage_used_bytes || 0),
    image_count: Number(profile.image_count || 0),
  } : null
}

function hasSupabaseServiceRole(env) {
  return !!String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
}

function supabaseRestFetch(env, path, options = {}) {
  const supabaseUrl = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '')
  const serviceRoleKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  if (!supabaseUrl || !serviceRoleKey) {
    throw httpError(500, 'missing_supabase_admin', 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for storage tracking')
  }

  const headers = new Headers(options.headers || {})
  headers.set('apikey', serviceRoleKey)
  headers.set('Authorization', `Bearer ${serviceRoleKey}`)
  headers.set('Content-Type', 'application/json')
  headers.set('Accept', 'application/json')
  return fetch(`${supabaseUrl}${path}`, {
    ...options,
    headers,
  })
}

function mediaObjectSize(object) {
  const size = Number(object?.size)
  return Number.isFinite(size) && size > 0 ? Math.trunc(size) : 0
}

function isPrimaryImageKey(key) {
  const normalized = String(key || '').replace(/^\/+/, '')
  const filename = normalized.split('/').pop() || ''
  if (!filename || filename.startsWith('thumb_')) return false
  if (normalized.includes('/originals/')) return false
  if (/^spore_mosaic(?:_|\.)/i.test(filename)) return false
  return true
}

async function canReadMediaKey(env, claims, key) {
  if (!claims?.sub || !key) return false
  if (key.startsWith(`${claims.sub}/`)) return true
  if (!hasSupabaseServiceRole(env)) return false

  const imageQuery = [
    `storage_path=eq.${encodeURIComponent(key)}`,
    'select=observation_id',
    'limit=1',
  ].join('&')
  const imageResponse = await supabaseRestFetch(env, `/rest/v1/observation_images?${imageQuery}`, { method: 'GET' })
  if (!imageResponse.ok) {
    throw httpError(500, 'media_owner_lookup_failed', 'Could not verify media ownership')
  }
  const imageRows = await imageResponse.json()
  const observationId = Array.isArray(imageRows) ? imageRows[0]?.observation_id : null
  if (!observationId) return false

  const observationQuery = [
    `id=eq.${encodeURIComponent(observationId)}`,
    `user_id=eq.${encodeURIComponent(claims.sub)}`,
    'select=id',
    'limit=1',
  ].join('&')
  const observationResponse = await supabaseRestFetch(env, `/rest/v1/observations?${observationQuery}`, { method: 'GET' })
  if (!observationResponse.ok) {
    throw httpError(500, 'media_owner_lookup_failed', 'Could not verify media ownership')
  }
  const observationRows = await observationResponse.json()
  return Array.isArray(observationRows) && observationRows.length > 0
}

async function handleArtsorakel(request, env, ctx) {
  const origin = resolveAllowedOrigin(request, env)
  if (request.headers.get('Origin') && !origin) {
    throw httpError(403, 'origin_not_allowed', 'Origin is not allowed')
  }

  const authHeader = request.headers.get('Authorization')
  const token = parseBearerToken(authHeader)
  await verifySupabaseJwt(token, env, ctx)

  const artsorakelToken = resolveArtsorakelToken(env)

  if (!request.body) {
    throw httpError(400, 'missing_body', 'Request body is required')
  }

  const contentType = String(request.headers.get('Content-Type') || '').trim()
  const bodyBuffer = await request.arrayBuffer()
  const appName = String(request.headers.get('X-App-Name') || '').trim()
  const appVersion = String(request.headers.get('X-App-Version') || '').trim()
  const upstream = await fetch(ARTSORAKEL_UPSTREAM_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${artsorakelToken}`,
      ...(contentType ? { 'Content-Type': contentType } : {}),
      ...(appName ? { 'X-App-Name': appName } : {}),
      ...(appVersion ? { 'X-App-Version': appVersion } : {}),
    },
    body: bodyBuffer,
  })

  const upstreamBody = await upstream.arrayBuffer()
  const responseHeaders = corsHeaders(request, env, origin)
  const upstreamContentType = upstream.headers.get('Content-Type')
  if (upstreamContentType) {
    responseHeaders.set('Content-Type', upstreamContentType)
  }
  return new Response(upstreamBody, {
    status: upstream.status,
    headers: responseHeaders,
  })
}

async function handleArtsorakelMedia(request, env, ctx) {
  const origin = resolveAllowedOrigin(request, env)
  if (request.headers.get('Origin') && !origin) {
    throw httpError(403, 'origin_not_allowed', 'Origin is not allowed')
  }

  const authHeader = request.headers.get('Authorization')
  const token = parseBearerToken(authHeader)
  const claims = await verifySupabaseJwt(token, env, ctx)

  const artsorakelToken = resolveArtsorakelToken(env)

  let body
  try {
    body = await request.json()
  } catch (_) {
    throw httpError(400, 'invalid_json', 'Request body must be JSON')
  }

  const rawKeys = Array.isArray(body?.keys) ? body.keys : [body?.key]
  const keys = [...new Set(rawKeys
    .map(value => String(value || '').trim())
    .filter(Boolean))]
    .slice(0, parsePositiveInt(env.ARTSORAKEL_MAX_MEDIA_ITEMS, 6))
  if (!keys.length) {
    throw httpError(400, 'missing_media_keys', 'At least one media key is required')
  }

  const variant = String(body?.variant || 'medium').trim() || 'medium'
  const appHeaders = {}
  const appName = String(request.headers.get('X-App-Name') || '').trim()
  const appVersion = String(request.headers.get('X-App-Version') || '').trim()
  if (appName) appHeaders['X-App-Name'] = appName
  if (appVersion) appHeaders['X-App-Version'] = appVersion
  const responses = []
  const errors = []

  for (const rawKey of keys) {
    let key
    try {
      key = normalizeObjectKey(rawKey)
    } catch (error) {
      errors.push({ key: rawKey, error: error?.code || 'invalid_key' })
      continue
    }

    if (!await canReadMediaKey(env, claims, key)) {
      errors.push({ key, error: 'key_not_allowed' })
      continue
    }

    const object = await getMediaObjectForAi(env, key, variant)
    if (!object) {
      errors.push({ key, error: 'media_not_found' })
      continue
    }

    try {
      const data = await runArtsorakelForMediaObject(object, appHeaders, artsorakelToken)
      responses.push({ key, data })
    } catch (error) {
      console.error('Artsorakel media request failed', error)
      errors.push({ key, error: error?.code || 'artsorakel_failed' })
    }
  }

  if (!responses.length) {
    const allForbidden = errors.length > 0 && errors.every(item => item.error === 'key_not_allowed')
    throw httpError(
      allForbidden ? 403 : 502,
      allForbidden ? 'key_not_allowed' : 'media_ai_failed',
      allForbidden
        ? 'Observation images are not available to the authenticated user'
        : 'Could not load observation images for Artsorakel',
    )
  }

  return jsonResponse(
    {
      ok: true,
      total: keys.length,
      responses,
      errors,
    },
    200,
    request,
    env,
    origin,
  )
}

async function getMediaObjectForAi(env, key, variant) {
  const candidates = mediaCandidateKeys(key, variant)
  for (const candidate of candidates) {
    const located = await findMediaObject(env, candidate)
    if (located) return located.object
  }
  return null
}

function mediaCandidateKeys(key, variant) {
  if (!variant || variant === 'original') return [key]
  const parts = key.split('/')
  const fileName = parts.pop() || ''
  const dir = parts.join('/')
  const primaryKey = dir ? `${dir}/thumb_${fileName}` : `thumb_${fileName}`
  return [...new Set([primaryKey, key].filter(Boolean))]
}

async function runArtsorakelForMediaObject(object, appHeaders = {}, artsorakelToken = '') {
  const contentType = String(object?.httpMetadata?.contentType || '').trim() || 'image/jpeg'
  const bodyBuffer = await object.arrayBuffer()

  let upstream = await postArtsorakelBuffer(bodyBuffer, contentType, 'image', appHeaders, artsorakelToken)
  if (!upstream.ok) {
    upstream = await postArtsorakelBuffer(bodyBuffer, contentType, 'file', appHeaders, artsorakelToken)
  }
  if (!upstream.ok) {
    throw httpError(502, 'artsorakel_failed', `Artsdata AI ${upstream.status}`)
  }
  return upstream.json()
}

function postArtsorakelBuffer(bodyBuffer, contentType, fieldName, appHeaders = {}, artsorakelToken = '') {
  const form = new FormData()
  form.append(fieldName, new Blob([bodyBuffer], { type: contentType }), 'photo.jpg')
  form.append('application', 'Sporely')
  return fetch(ARTSORAKEL_UPSTREAM_URL, {
    method: 'POST',
    headers: {
      ...(artsorakelToken ? { Authorization: `Bearer ${artsorakelToken}` } : {}),
      ...appHeaders,
    },
    body: form,
  })
}

function parseBearerToken(authHeader) {
  const text = String(authHeader || '').trim()
  const match = /^Bearer\s+(.+)$/i.exec(text)
  if (!match?.[1]) {
    throw httpError(401, 'missing_token', 'Missing Bearer token')
  }
  return match[1].trim()
}

async function verifySupabaseJwt(token, env, ctx) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) {
    throw httpError(401, 'invalid_token', 'Malformed JWT')
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts
  const header = parseJsonSegment(encodedHeader, 'JWT header')
  const payload = parseJsonSegment(encodedPayload, 'JWT payload')
  const signature = base64UrlToBytes(encodedSignature)
  const signedData = encoder().encode(`${encodedHeader}.${encodedPayload}`)

  await verifyJwtSignature(header, signature, signedData, env, ctx)
  validateJwtClaims(payload, env)
  return payload
}

async function verifyJwtSignature(header, signature, signedData, env, ctx) {
  const alg = String(header?.alg || '').trim()
  if (!alg || alg === 'none') {
    throw httpError(401, 'invalid_token', 'JWT algorithm is not allowed')
  }

  if (alg.startsWith('HS')) {
    const secret = String(env.SUPABASE_JWT_SECRET || '').trim()
    if (!secret) {
      throw httpError(500, 'missing_jwt_secret', 'SUPABASE_JWT_SECRET is required for HS* JWT validation')
    }
    const key = await crypto.subtle.importKey(
      'raw',
      encoder().encode(secret),
      { name: 'HMAC', hash: hashNameForAlg(alg) },
      false,
      ['sign'],
    )
    const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, signedData))
    if (!constantTimeEqual(expected, signature)) {
      throw httpError(401, 'invalid_token', 'JWT signature verification failed')
    }
    return
  }

  const jwk = await resolveJwkForHeader(header, env, ctx)
  const cryptoKey = await importJwkForVerify(jwk, alg)
  const verifyAlgorithm = subtleVerifyAlgorithmForAlg(alg)
  const signatureBytes = signature
  const ok = await crypto.subtle.verify(verifyAlgorithm, cryptoKey, signatureBytes, signedData)
  if (!ok) {
    throw httpError(401, 'invalid_token', 'JWT signature verification failed')
  }
}

async function resolveJwkForHeader(header, env, ctx) {
  const keys = await getSupabaseJwks(env, ctx)
  if (!keys.length) {
    throw httpError(500, 'jwks_unavailable', 'No JWKS keys available for JWT validation')
  }

  const kid = String(header?.kid || '').trim()
  let jwk = null
  if (kid) {
    jwk = keys.find(key => String(key?.kid || '').trim() === kid) || null
  } else if (keys.length === 1) {
    jwk = keys[0]
  }

  if (!jwk) {
    throw httpError(401, 'invalid_token', 'No matching signing key found')
  }
  return jwk
}

async function getSupabaseJwks(env, ctx) {
  const now = Date.now()
  if (cachedJwks && now - cachedJwksAt < JWKS_CACHE_TTL_MS) {
    return cachedJwks
  }

  const jwksUrl = resolveJwksUrl(env)
  const response = await fetch(jwksUrl, {
    headers: { Accept: 'application/json' },
    cf: { cacheTtl: 600, cacheEverything: true },
  })
  if (!response.ok) {
    throw httpError(500, 'jwks_fetch_failed', `Could not fetch JWKS from ${jwksUrl}`)
  }
  const body = await response.json()
  const keys = Array.isArray(body?.keys) ? body.keys : []
  cachedJwks = keys
  cachedJwksAt = now
  return keys
}

function resolveJwksUrl(env) {
  const explicit = String(env.SUPABASE_JWKS_URL || '').trim()
  if (explicit) return explicit
  const supabaseUrl = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '')
  if (!supabaseUrl) {
    throw httpError(500, 'missing_supabase_url', 'SUPABASE_URL is required')
  }
  return `${supabaseUrl}/auth/v1/.well-known/jwks.json`
}

function validateJwtClaims(payload, env) {
  const now = Math.floor(Date.now() / 1000)
  const clockSkew = parsePositiveInt(env.JWT_CLOCK_SKEW_SECONDS, 60)

  if (!payload || typeof payload !== 'object') {
    throw httpError(401, 'invalid_token', 'JWT payload is invalid')
  }
  if (!String(payload.sub || '').trim()) {
    throw httpError(401, 'invalid_token', 'JWT subject is missing')
  }

  const exp = Number(payload.exp)
  if (Number.isFinite(exp) && exp <= now - clockSkew) {
    throw httpError(401, 'token_expired', 'JWT has expired')
  }
  const nbf = Number(payload.nbf)
  if (Number.isFinite(nbf) && nbf > now + clockSkew) {
    throw httpError(401, 'token_not_yet_valid', 'JWT is not valid yet')
  }
  const iat = Number(payload.iat)
  if (Number.isFinite(iat) && iat > now + clockSkew) {
    throw httpError(401, 'invalid_token', 'JWT issued-at time is in the future')
  }

  const expectedIssuer = String(env.SUPABASE_JWT_ISSUER || defaultIssuer(env)).trim()
  if (expectedIssuer) {
    const actualIssuer = String(payload.iss || '').trim()
    if (actualIssuer !== expectedIssuer) {
      throw httpError(401, 'invalid_token', 'JWT issuer does not match the expected Supabase issuer')
    }
  }

  const expectedAudience = String(env.SUPABASE_JWT_AUDIENCE || 'authenticated').trim()
  if (expectedAudience) {
    const audiences = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud || '')]
    if (!audiences.includes(expectedAudience)) {
      throw httpError(401, 'invalid_token', 'JWT audience is not allowed')
    }
  }
}

function defaultIssuer(env) {
  const supabaseUrl = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '')
  return supabaseUrl ? `${supabaseUrl}/auth/v1` : ''
}

async function importJwkForVerify(jwk, alg) {
  const normalizedAlg = String(alg || '').trim()
  if (normalizedAlg.startsWith('RS')) {
    return crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: hashNameForAlg(normalizedAlg) },
      false,
      ['verify'],
    )
  }
  if (normalizedAlg.startsWith('ES')) {
    return crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: namedCurveForAlg(normalizedAlg) },
      false,
      ['verify'],
    )
  }
  throw httpError(401, 'invalid_token', `Unsupported JWT algorithm: ${normalizedAlg}`)
}

function subtleVerifyAlgorithmForAlg(alg) {
  if (alg.startsWith('RS')) {
    return { name: 'RSASSA-PKCS1-v1_5' }
  }
  if (alg.startsWith('ES')) {
    return { name: 'ECDSA', hash: hashNameForAlg(alg) }
  }
  throw httpError(401, 'invalid_token', `Unsupported JWT algorithm: ${alg}`)
}

function namedCurveForAlg(alg) {
  switch (alg) {
    case 'ES256':
      return 'P-256'
    case 'ES384':
      return 'P-384'
    case 'ES512':
      return 'P-521'
    default:
      throw httpError(401, 'invalid_token', `Unsupported ECDSA algorithm: ${alg}`)
  }
}

function hashNameForAlg(alg) {
  switch (alg) {
    case 'HS256':
    case 'RS256':
    case 'ES256':
      return 'SHA-256'
    case 'HS384':
    case 'RS384':
    case 'ES384':
      return 'SHA-384'
    case 'HS512':
    case 'RS512':
    case 'ES512':
      return 'SHA-512'
    default:
      throw httpError(401, 'invalid_token', `Unsupported hash algorithm: ${alg}`)
  }
}

function parseJsonSegment(value, label) {
  try {
    return JSON.parse(bytesToText(base64UrlToBytes(value)))
  } catch (_) {
    throw httpError(401, 'invalid_token', `${label} is invalid`)
  }
}

function normalizeObjectKey(rawPath) {
  let decoded
  try {
    decoded = decodeURIComponent(String(rawPath || ''))
  } catch (_) {
    throw httpError(400, 'invalid_key', 'Upload key is not valid URL encoding')
  }
  const trimmed = decoded.replace(/^\/+/, '').trim()
  if (!trimmed) return ''
  if (trimmed.includes('\\') || /[\u0000-\u001F]/.test(trimmed)) {
    throw httpError(400, 'invalid_key', 'Upload key contains forbidden characters')
  }
  const parts = trimmed.split('/').filter(Boolean)
  if (!parts.length || parts.some(part => part === '.' || part === '..')) {
    throw httpError(400, 'invalid_key', 'Upload key contains invalid path segments')
  }
  return parts.join('/')
}

function publicMediaUrl(env, key) {
  const base = String(env.MEDIA_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')
  return base ? `${base}/${key}` : null
}

// Stage 2 canonical variant allowlist. MUST stay in lock-step with
// `public.media_variant_is_supported(text)` in the consolidated
// 20260804120000_media_authorization.sql migration. Unknown variants fail
// closed on both sides.
// Round-3 amendment: `mosaic` moved to its own /mm/ route. This
// allowlist governs the observation-image /m/ route only.
export const MEDIA_VARIANTS = new Set(['full', 'thumb', 'original'])

// Historic upload metadata values accepted while writing to the legacy
// bucket. This is intentionally distinct from MEDIA_VARIANTS: spore mosaics
// are uploaded as objects but authorized for delivery through /mm/, not /m/.
export const LEGACY_UPLOAD_TYPES = new Set(['full', 'thumb', 'original', 'spore_mosaic'])

export function normalizeUploadType(value) {
  const normalized = String(value || '').trim().toLowerCase() || 'full'
  return ['small', 'medium', 'cards', 'preview'].includes(normalized)
    ? 'thumb'
    : normalized
}

// Stage 2 explicit storage mode. Set via `MEDIA_STORAGE_MODE` env var. Fail
// closed: `private` mode REQUIRES `PRIVATE_MEDIA_BUCKET` binding and never
// falls back to `MEDIA_BUCKET`. `legacy` mode uses `MEDIA_BUCKET`. Any
// other value is a configuration error.
export function resolveMediaStorageMode(env) {
  const raw = String(env.MEDIA_STORAGE_MODE || 'legacy').trim().toLowerCase()
  if (raw !== 'legacy' && raw !== 'private') {
    throw httpError(500, 'invalid_media_storage_mode',
      `MEDIA_STORAGE_MODE must be 'legacy' or 'private' (got ${JSON.stringify(raw)})`)
  }
  return raw
}

// Stage 2: which bucket holds new canonical uploads. Selection is entirely
// determined by MEDIA_STORAGE_MODE — not by which bindings happen to be
// present — so an accidental binding omission cannot silently downgrade
// security. Returns `{ bucket, name }` where name ∈ {'legacy','private'}.
export function selectUploadBucket(env) {
  const mode = resolveMediaStorageMode(env)
  if (mode === 'private') {
    if (!env.PRIVATE_MEDIA_BUCKET) {
      throw httpError(500, 'missing_private_bucket',
        'MEDIA_STORAGE_MODE=private but PRIVATE_MEDIA_BUCKET binding is missing')
    }
    return { bucket: env.PRIVATE_MEDIA_BUCKET, name: 'private', mode }
  }
  if (!env.MEDIA_BUCKET) {
    throw httpError(500, 'missing_media_bucket',
      'MEDIA_STORAGE_MODE=legacy but MEDIA_BUCKET binding is missing')
  }
  return { bucket: env.MEDIA_BUCKET, name: 'legacy', mode }
}

export function configuredBucketRoles(env) {
  return [
    { role: 'legacy', bucket: env.MEDIA_BUCKET || null },
    { role: 'private', bucket: env.PRIVATE_MEDIA_BUCKET || null },
  ].filter(target => target.bucket)
}

// Physical lookup is intentionally separate from the current write target.
// A canonical role supplied by the database is tried first. Owner raw-key
// reads have no row identity, so they prefer the current write role and then
// the alternate configured role. This preserves legacy behavior before
// cutover and prefers private copies after cutover without losing access to
// not-yet-backfilled legacy objects.
export function candidateReadBuckets(env, preferredRole = null) {
  const configured = configuredBucketRoles(env)
  if (!configured.length) return []
  const mode = resolveMediaStorageMode(env)
  const firstRole = preferredRole === 'legacy' || preferredRole === 'private'
    ? preferredRole
    : mode
  return [...configured].sort((left, right) => {
    if (left.role === firstRole) return -1
    if (right.role === firstRole) return 1
    return left.role.localeCompare(right.role)
  })
}

export async function findMediaObject(env, key, preferredRole = null) {
  const candidates = candidateReadBuckets(env, preferredRole)
  if (!candidates.length) {
    throw httpError(500, 'missing_bucket', 'No R2 bucket bindings are configured')
  }
  for (const target of candidates) {
    const object = await target.bucket.get(key)
    if (object) return { object, role: target.role }
  }
  return null
}

// Stage 2 delivery route: `GET /m/<image_id>/<variant>`. Anonymous callers
// hit it without a Bearer; authenticated callers pass their Supabase JWT.
// The Worker resolves the image row + caller identity to a single decision
// via `public.media_authorize_delivery` (service-role RPC) and streams
// bytes from the appropriate bucket. Cache-Control is set by the Worker.
async function handleMediaDelivery(request, env, ctx, url) {
  const origin = resolveAllowedOrigin(request, env)
  if (request.headers.get('Origin') && !origin) {
    throw httpError(403, 'origin_not_allowed', 'Origin is not allowed')
  }

  const segments = url.pathname.slice('/m/'.length).split('/').filter(Boolean)
  if (segments.length < 2) {
    throw httpError(404, 'media_not_found', 'Media not available')
  }
  const imageIdRaw = segments[0]
  const variant = segments[1]
  const imageId = Number.parseInt(imageIdRaw, 10)
  if (!Number.isFinite(imageId) || imageId <= 0 || String(imageId) !== imageIdRaw) {
    // Malformed image_id — do not disclose whether an image exists.
    throw httpError(404, 'media_not_found', 'Media not available')
  }
  // Explicit variant allowlist — unknown variants fail closed.
  if (!MEDIA_VARIANTS.has(variant)) {
    throw httpError(404, 'media_not_found', 'Media not available')
  }

  // Required `?v=<media_version>` — pinned to the row's current version at
  // URL-issue time. Missing / non-positive / non-integer values are 404.
  const requestedVersionRaw = url.searchParams.get('v')
  if (!requestedVersionRaw) {
    throw httpError(404, 'media_not_found', 'Media not available')
  }
  const requestedVersion = Number.parseInt(requestedVersionRaw, 10)
  if (!Number.isFinite(requestedVersion) || requestedVersion < 1
      || String(requestedVersion) !== requestedVersionRaw) {
    throw httpError(404, 'media_not_found', 'Media not available')
  }

  // Optional bearer — anonymous is a valid caller.
  let callerSub = null
  const authHeader = request.headers.get('Authorization')
  if (authHeader) {
    const token = parseBearerToken(authHeader)
    const claims = await verifySupabaseJwt(token, env, ctx)
    callerSub = claims?.sub || null
  }

  const decision = await authorizeMediaDelivery(env, imageId, variant, callerSub)
  if (!decision || !decision.allowed || decision.cache_class === 'deny') {
    throw httpError(404, 'media_not_found', 'Media not available')
  }

  // Version validation. A URL issued before a revocation event (visibility
  // flip, tombstone, storage_path rewrite, canonical_bucket move, owner ban)
  // has an old `?v=`. Deny without disclosing existence.
  if (Number(decision.media_version) !== requestedVersion) {
    throw httpError(404, 'media_not_found', 'Media not available')
  }

  // Per-variant key derivation. The RPC returns the base `storage_path`
  // for full/thumb and `original_storage_path` for original. For `thumb`,
  // prefix the final path segment with `thumb_`; other variants use the
  // returned path verbatim. Mosaics are resolved only by the /mm/ route.
  const objectKey = variant === 'thumb'
    ? deriveThumbKey(decision.storage_path)
    : decision.storage_path
  if (!objectKey) {
    throw httpError(404, 'media_not_found', 'Media not available')
  }
  const located = await findMediaObject(env, objectKey, decision.canonical_bucket)
  if (!located) {
    // Row references a key the bucket does not currently hold. Treat as
    // not-found rather than 500 so a mid-purge race is invisible to callers.
    throw httpError(404, 'media_not_found', 'Media not available')
  }
  const object = located.object

  const headers = corsHeaders(request, env, origin)
  object.writeHttpMetadata(headers)
  if (object.httpEtag) headers.set('ETag', object.httpEtag)

  // Stage 2a foundation default: `no-store` for ALL /m/ responses,
  // including public. Enabling public edge caching requires dedicated
  // revocation tests (see Stage 2b). Until then, protected responses stay
  // `private, no-store` and public responses are `no-store` so a cache
  // race cannot serve stale bytes across a version bump.
  headers.set('Cache-Control', 'no-store')
  const existingVary = headers.get('Vary')
  headers.set('Vary', existingVary ? `${existingVary}, Authorization` : 'Authorization')

  return new Response(object.body, { status: 200, headers })
}

// Validate that the observation_images row named by X-Sporely-Image-Id
// exists, is owned by the authenticated caller, and that its stored
// `storage_path` matches the key the client is about to write to. This
// removes the "any key prefixed by my UUID is fair game" gap by binding
// each upload to a server-known image identity.
//
// For the `thumb` variant the row's storage_path holds the FULL key; the
// thumb key is derived by prefixing the final path segment with `thumb_`.
// A client uploading a thumb variant must present that derived thumb key.
async function verifyImageRowMatchesUpload(env, imageId, callerSub, uploadKey, variant) {
  if (!hasSupabaseServiceRole(env)) {
    return {
      ok: false, status: 500, code: 'missing_supabase_admin',
      message: 'Service role required to verify image ownership',
    }
  }
  const query = [
    `id=eq.${encodeURIComponent(imageId)}`,
    `user_id=eq.${encodeURIComponent(callerSub)}`,
    'select=id,storage_path,original_storage_path,canonical_bucket',
    'limit=1',
  ].join('&')
  const response = await supabaseRestFetch(env, `/rest/v1/observation_images?${query}`, { method: 'GET' })
  if (!response.ok) {
    return {
      ok: false, status: 500, code: 'image_lookup_failed',
      message: 'Could not verify image ownership',
    }
  }
  const rows = await response.json()
  const row = Array.isArray(rows) ? rows[0] || null : null
  if (!row) {
    return {
      ok: false, status: 403, code: 'image_not_found_or_not_owner',
      message: 'observation_images row does not exist or is not owned by the caller',
    }
  }
  const rowStoragePath = String(row.storage_path || '')
  const rowOriginalStoragePath = String(row.original_storage_path || '')
  const expectedKey = variant === 'thumb'
    ? deriveThumbKey(rowStoragePath)
    : variant === 'original'
      ? rowOriginalStoragePath
      : rowStoragePath
  if (!expectedKey || uploadKey !== expectedKey) {
    return {
      ok: false, status: 403, code: 'storage_path_mismatch',
      message: 'Upload key does not match the observation_images row',
    }
  }
  return { ok: true, row }
}

async function verifyMosaicRowMatchesUpload(env, mosaicId, callerSub, uploadKey) {
  if (!hasSupabaseServiceRole(env)) {
    return {
      ok: false, status: 500, code: 'missing_supabase_admin',
      message: 'Service role required to verify mosaic ownership',
    }
  }
  const query = [
    `id=eq.${encodeURIComponent(mosaicId)}`,
    `user_id=eq.${encodeURIComponent(callerSub)}`,
    'select=id,observation_id,storage_key,canonical_bucket',
    'limit=1',
  ].join('&')
  const response = await supabaseRestFetch(
    env, `/rest/v1/spore_measurement_mosaics?${query}`, { method: 'GET' })
  if (!response.ok) {
    return {
      ok: false, status: 500, code: 'mosaic_lookup_failed',
      message: 'Could not verify mosaic ownership',
    }
  }
  const rows = await response.json()
  const row = Array.isArray(rows) ? rows[0] || null : null
  if (!row) {
    return {
      ok: false, status: 403, code: 'mosaic_not_found_or_not_owner',
      message: 'Mosaic row does not exist or is not owned by the caller',
    }
  }
  const replacementPrefix = `${callerSub}/${row.observation_id}/`
  const replacementName = uploadKey.slice(replacementPrefix.length)
  const validReplacementKey = uploadKey.startsWith(replacementPrefix)
    && /^spore_mosaic_v[0-9]+_[a-f0-9]+\.(?:webp|avif|png|jpe?g)$/i.test(replacementName)
  if (!row.storage_key
      || (uploadKey !== String(row.storage_key) && !validReplacementKey)) {
    return {
      ok: false, status: 403, code: 'storage_path_mismatch',
      message: 'Upload key does not match the mosaic row',
    }
  }
  return { ok: true, row }
}

export function deriveThumbKey(fullKey) {
  const key = String(fullKey || '').trim()
  if (!key) return ''
  const idx = key.lastIndexOf('/')
  if (idx < 0) {
    return key.startsWith('thumb_') ? key : `thumb_${key}`
  }
  const dir = key.slice(0, idx)
  const fileName = key.slice(idx + 1)
  const stripped = fileName.replace(/^(thumb_|small_|medium_|cards_|preview_)/, '')
  return `${dir}/thumb_${stripped}`
}

// After a successful `private`-mode upload, upgrade the row's
// `canonical_bucket` from 'legacy' to 'private'. Runs as service_role so
// the server-owned-field guard trigger allows the mutation.
async function markImageCanonicalBucketPrivate(env, imageId) {
  if (!hasSupabaseServiceRole(env)) return null
  const response = await supabaseRestFetch(env,
    `/rest/v1/observation_images?id=eq.${encodeURIComponent(imageId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ canonical_bucket: 'private' }),
    })
  if (!response.ok) {
    // Non-fatal: the object is written but the row is out of sync. Return
    // the reason so the caller can decide whether to roll back.
    return { ok: false, status: response.status, text: await response.text() }
  }
  return { ok: true }
}


async function markMosaicCanonicalBucketPrivate(env, mosaicId) {
  if (!hasSupabaseServiceRole(env)) return null
  const response = await supabaseRestFetch(env,
    `/rest/v1/spore_measurement_mosaics?id=eq.${encodeURIComponent(mosaicId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ canonical_bucket: 'private' }),
    })
  if (!response.ok) {
    return { ok: false, status: response.status, text: await response.text() }
  }
  return { ok: true }
}

async function handleMosaicDelivery(request, env, ctx, url) {
  const origin = resolveAllowedOrigin(request, env)
  if (request.headers.get('Origin') && !origin) {
    throw httpError(403, 'origin_not_allowed', 'Origin is not allowed')
  }

  const segments = url.pathname.slice('/mm/'.length).split('/').filter(Boolean)
  if (segments.length !== 1) {
    throw httpError(404, 'media_not_found', 'Media not available')
  }
  const mosaicIdRaw = segments[0]
  const mosaicId = Number.parseInt(mosaicIdRaw, 10)
  if (!Number.isFinite(mosaicId) || mosaicId <= 0 || String(mosaicId) !== mosaicIdRaw) {
    throw httpError(404, 'media_not_found', 'Media not available')
  }

  const requestedVersionRaw = url.searchParams.get('v')
  if (!requestedVersionRaw) {
    throw httpError(404, 'media_not_found', 'Media not available')
  }
  const requestedVersion = Number.parseInt(requestedVersionRaw, 10)
  if (!Number.isFinite(requestedVersion) || requestedVersion < 1
      || String(requestedVersion) !== requestedVersionRaw) {
    throw httpError(404, 'media_not_found', 'Media not available')
  }

  let callerSub = null
  const authHeader = request.headers.get('Authorization')
  if (authHeader) {
    const token = parseBearerToken(authHeader)
    const claims = await verifySupabaseJwt(token, env, ctx)
    callerSub = claims?.sub || null
  }

  const decision = await authorizeMosaicDelivery(env, mosaicId, callerSub)
  if (!decision || !decision.allowed || decision.cache_class === 'deny') {
    throw httpError(404, 'media_not_found', 'Media not available')
  }
  if (Number(decision.media_version) !== requestedVersion) {
    throw httpError(404, 'media_not_found', 'Media not available')
  }

  const objectKey = decision.storage_key
  if (!objectKey) {
    throw httpError(404, 'media_not_found', 'Media not available')
  }
  const located = await findMediaObject(env, objectKey, decision.canonical_bucket)
  if (!located) {
    throw httpError(404, 'media_not_found', 'Media not available')
  }
  const object = located.object

  const headers = corsHeaders(request, env, origin)
  object.writeHttpMetadata(headers)
  if (object.httpEtag) headers.set('ETag', object.httpEtag)
  headers.set('Cache-Control', 'no-store')
  const existingVary = headers.get('Vary')
  headers.set('Vary', existingVary ? `${existingVary}, Authorization` : 'Authorization')
  return new Response(object.body, { status: 200, headers })
}

async function authorizeMosaicDelivery(env, mosaicId, callerSub) {
  if (!hasSupabaseServiceRole(env)) {
    throw httpError(500, 'missing_supabase_admin',
      'SUPABASE_SERVICE_ROLE_KEY is required for mosaic authorization')
  }
  const response = await supabaseRestFetch(env, '/rest/v1/rpc/media_authorize_mosaic_delivery', {
    method: 'POST',
    body: JSON.stringify({
      p_mosaic_id: mosaicId,
      p_caller: callerSub || null,
    }),
  })
  if (!response.ok) {
    throw httpError(500, 'mosaic_authorize_failed',
      'media_authorize_mosaic_delivery RPC failed')
  }
  const rows = await response.json()
  return Array.isArray(rows) ? rows[0] || null : rows
}

async function authorizeMediaDelivery(env, imageId, variant, callerSub) {
  if (!hasSupabaseServiceRole(env)) {
    throw httpError(500, 'missing_supabase_admin',
      'SUPABASE_SERVICE_ROLE_KEY is required for media authorization')
  }
  const response = await supabaseRestFetch(env, '/rest/v1/rpc/media_authorize_delivery', {
    method: 'POST',
    body: JSON.stringify({
      p_image_id: imageId,
      p_variant: variant,
      p_caller: callerSub || null,
    }),
  })
  if (!response.ok) {
    throw httpError(500, 'media_authorize_failed',
      'media_authorize_delivery RPC failed')
  }
  const rows = await response.json()
  return Array.isArray(rows) ? rows[0] || null : rows
}

const LOCAL_NETWORK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/
const SPORELY_WEB_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*sporely\.no$/i

function resolveAllowedOrigin(request, env) {
  const configured = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  const origin = String(request.headers.get('Origin') || '').trim()

  if (!origin) {
    return '*'
  }
  if (!configured.length) {
    return origin
  }
  if (configured.includes(origin)) {
    return origin
  }
  if (LOCAL_NETWORK_ORIGIN.test(origin)) {
    return origin
  }
  if (SPORELY_WEB_ORIGIN.test(origin)) {
    return origin
  }
  // Installed iOS and Android web apps may emit `Origin: null` for file/blob requests.
  if (origin === 'null') {
    return origin
  }
  return null
}

function corsHeaders(request, env, resolvedOrigin = null) {
  const origin = resolvedOrigin === null ? resolveAllowedOrigin(request, env) : resolvedOrigin
  const headers = new Headers()
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Vary', 'Origin')
  }
  headers.set('Access-Control-Allow-Methods', DEFAULT_ALLOWED_METHODS)
  headers.set('Access-Control-Allow-Headers', resolveAllowedHeaders(request))
  headers.set('Access-Control-Max-Age', '86400')
  return headers
}

function resolveAllowedHeaders(request) {
  const requestedHeaders = String(request?.headers?.get('Access-Control-Request-Headers') || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  const combined = []
  const seen = new Set()
  for (const header of [...DEFAULT_ALLOWED_HEADER_NAMES, ...requestedHeaders]) {
    const normalized = header.toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    combined.push(header)
  }
  return combined.join(', ')
}

function jsonResponse(payload, status, request, env, resolvedOrigin = null) {
  const headers = corsHeaders(request, env, resolvedOrigin)
  headers.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(payload, null, 2), { status, headers })
}

function httpError(status, code, message, details = null) {
  const error = new Error(message)
  error.status = status
  error.code = code
  if (details && typeof details === 'object') {
    error.details = details
  }
  return error
}

async function safeJsonObject(response) {
  try {
    const data = await response.json()
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch (_) {
    return {}
  }
}

function isUsableCoordinate(lat, lon) {
  return Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    !(Math.abs(lat) < 0.000001 && Math.abs(lon) < 0.000001)
}

function dedupeText(values) {
  const seen = new Set()
  const result = []
  for (const value of values || []) {
    const text = stringOrNull(value)
    if (!text) continue
    const key = text.toLocaleLowerCase().replace(/\s+/g, ' ')
    if (seen.has(key)) continue
    seen.add(key)
    result.push(text)
  }
  return result
}

function stringOrNull(value) {
  const text = String(value || '').trim()
  return text || null
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseIntegerHeader(value) {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.trunc(parsed)
}

function parseNonNegativeInt(value, fallback = 0) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.trunc(parsed)
}

function base64UrlToBytes(value) {
  const normalized = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

function bytesToText(bytes) {
  return new TextDecoder().decode(bytes)
}

function encoder() {
  return new TextEncoder()
}

function constantTimeEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] ^ right[i]
  }
  return diff === 0
}

function joseSignatureToDer(signature) {
  if (!(signature instanceof Uint8Array) || signature.length % 2 !== 0) {
    throw httpError(401, 'invalid_token', 'ECDSA signature has invalid length')
  }
  const midpoint = signature.length / 2
  const r = normalizeDerInteger(signature.slice(0, midpoint))
  const s = normalizeDerInteger(signature.slice(midpoint))

  const sequenceBody = concatBytes(
    Uint8Array.of(0x02),
    encodeDerLength(r.length),
    r,
    Uint8Array.of(0x02),
    encodeDerLength(s.length),
    s,
  )
  return concatBytes(
    Uint8Array.of(0x30),
    encodeDerLength(sequenceBody.length),
    sequenceBody,
  )
}

function normalizeDerInteger(value) {
  let index = 0
  while (index < value.length - 1 && value[index] === 0) {
    index += 1
  }
  let normalized = value.slice(index)
  if (normalized[0] & 0x80) {
    normalized = concatBytes(Uint8Array.of(0x00), normalized)
  }
  return normalized
}

function encodeDerLength(length) {
  if (length < 0x80) {
    return Uint8Array.of(length)
  }
  const bytes = []
  let remaining = length
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff)
    remaining >>= 8
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes)
}

function concatBytes(...parts) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0)
  const output = new Uint8Array(totalLength)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

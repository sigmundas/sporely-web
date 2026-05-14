import { supabase } from '../supabase.js'
import { formatDate, formatTime, getTaxonomyLanguage, t } from '../i18n.js'
import { state } from '../state.js'
import { navigate, goBack } from '../router.js'
import { showToast } from '../toast.js'
import { searchTaxa, formatDisplayName } from '../artsorakel.js'
import { getIdentifyButtonLabel, getIdentifyBusyLabel, getIdentifyNoMatchMessage, getIdentifyUnavailableMessage, formatIdentifyScore, runIdentifyForBlobs, runIdentifyForMediaKeys, ID_SERVICE_ARTSORAKEL, ID_SERVICE_INATURALIST } from '../identify.js'
import { fetchCommentAuthorMap, getCommentAuthor } from '../comments.js'
import { deleteObservationMedia, downloadObservationImageBlob, resolveMediaSources, updateObservationImageCrop, prepareImageVariants, uploadPreparedObservationImageVariants, insertObservationImage, syncObservationMediaKeys, imageExtensionForBlob } from '../images.js'
import { loadFinds, openFinds } from './finds.js'
import { openPhotoViewer } from '../photo-viewer.js'
import { openAiCropEditor } from '../ai-crop-editor.js'
import { createImageCropMeta, normalizeAiCropRect } from '../image_crop.js'
import { esc as _esc } from '../esc.js'
import { getArtsorakelMaxEdge, getDefaultVisibility, setLastSyncAt, getUseSystemCamera, NATIVE_CAMERA_JPEG_QUALITY } from '../settings.js'
import { normalizeVisibility, toCloudVisibility } from '../visibility.js'
import { Preferences } from '@capacitor/preferences'
import { refreshHome } from './home.js'
import { buildGpsMetaHtml } from './review.js'
import { lookupCoordinateKey, lookupReverseLocation } from '../location-lookup.js'
import { fetchCloudPlanProfile } from '../cloud-plan.js'
import { isAndroidNativeApp } from '../camera-actions.js'
import { NativeCamera, isPickerCancel, pickImagesWithNativePhotoPicker, nativePickedPhotoToFile, captureNativePhotoExif, createNativeMetadataHydrationPromise, captureExif, processFile } from './import-helpers.js'
import { setCaptureCompleteHandler } from './capture.js'
import { getBlobImageDimensions } from '../image_crop.js'

let currentObs    = null
let selectedTaxon = null
let currentObsIsOwner = false
let returnScreenOverride = null
let hideCancelOverride = false
let detailLocationSuggestions = []
let detailLocationLookupKey = ''
let detailLocationAutoApplied = ''
let detailImageRows = []
let detailImageSources = []
let detailAiSources = []
let detailAuthorProfile = null
let detailFriendship = null
let detailFollowState = { user: false, observation: false, taxon: false, genus: false }
let detailPrivacySlotCount = null

const DETAIL_SELECT = 'id, user_id, date, captured_at, genus, species, common_name, location, habitat, notes, uncertain, gps_latitude, gps_longitude, gps_altitude, gps_accuracy, visibility, is_draft, location_precision'
const DETAIL_SELECT_LEGACY = 'id, user_id, date, captured_at, genus, species, common_name, location, habitat, notes, uncertain, gps_latitude, gps_longitude, gps_altitude, gps_accuracy, visibility'
const DETAIL_VIEW_SELECT = 'id, user_id, date, genus, species, common_name, location, habitat, notes, uncertain, gps_latitude, gps_longitude, visibility, is_draft, location_precision'
const DETAIL_VIEW_SELECT_LEGACY = 'id, user_id, date, genus, species, common_name, location, habitat, notes, uncertain, gps_latitude, gps_longitude, visibility'

function _isPhase7ColumnError(error) {
  const message = String(error?.message || '').toLowerCase()
  return !!error && (message.includes('is_draft') || message.includes('location_precision'))
}

async function _withPhase7Fallback(makeQuery, columns, legacyColumns) {
  const result = await makeQuery(columns)
  if (_isPhase7ColumnError(result.error)) return makeQuery(legacyColumns)
  return result
}

export function initFindDetail() {
  const backBtn = document.getElementById('detail-back')
  backBtn.addEventListener('click', _goBack)
  document.getElementById('detail-cancel-btn').addEventListener('click', _goBack)
  document.getElementById('detail-save-btn').addEventListener('click', _save)
  document.getElementById('detail-delete-btn').addEventListener('click', _delete)

  const input    = document.getElementById('detail-taxon-input')
  const dropdown = document.getElementById('detail-taxon-dropdown')
  let debounce

  input.addEventListener('input', () => {
    selectedTaxon = null
    _setDetailHeader({
      fallbackName: input.value.trim() || t('detail.unknownSpecies'),
      uncertain: document.getElementById('detail-uncertain')?.checked,
    })
    clearTimeout(debounce)
    debounce = setTimeout(() => _searchTaxon(input.value.trim(), dropdown), 280)
  })
  input.addEventListener('blur', () => {
    setTimeout(() => { dropdown.style.display = 'none' }, 200)
  })

  const locationInput = document.getElementById('detail-location')
  if (locationInput) {
    locationInput.addEventListener('focus', () => _renderDetailLocationDropdown(true))
    locationInput.addEventListener('click', () => _renderDetailLocationDropdown(true))
    locationInput.addEventListener('input', () => {
      _renderDetailLocationDropdown(document.activeElement === locationInput)
    })
    locationInput.addEventListener('blur', () => {
      setTimeout(() => _renderDetailLocationDropdown(false), 160)
    })
  }

  document.getElementById('detail-inat-btn').addEventListener('click', () => _runAI(ID_SERVICE_INATURALIST))
  document.getElementById('detail-arts-btn').addEventListener('click', () => _runAI(ID_SERVICE_ARTSORAKEL))
  document.getElementById('detail-author')?.addEventListener('click', _openAuthorFinds)
  document.getElementById('detail-friend-btn')?.addEventListener('click', _sendFriendRequestFromDetail)
  document.querySelectorAll('input[name="detail-vis"], input[name="detail-location-precision"], #detail-draft').forEach(input => {
    input.addEventListener('change', event => {
      if (input.name === 'detail-vis' && input.checked) {
        const group = input.closest('.scope-tabs')
        if (group) {
          group.querySelectorAll('.scope-tab').forEach(tab => tab.classList.remove('active'))
          input.closest('.scope-tab').classList.add('active')
        }
      }
      _renderPrivacySlotNote()
    })
  })
  const obscuredInput = document.getElementById('detail-obscured')
  if (obscuredInput) obscuredInput.addEventListener('change', _renderPrivacySlotNote)
  document.getElementById('detail-uncertain').addEventListener('change', () => {
    if (!currentObs) return
    const value = document.getElementById('detail-taxon-input').value.trim()
    _setDetailHeader({
      commonName: selectedTaxon?.vernacularName || currentObs.common_name || '',
      genus: selectedTaxon?.genus || currentObs.genus || '',
      species: selectedTaxon?.specificEpithet || currentObs.species || '',
      fallbackName: value || t('detail.unknownSpecies'),
      uncertain: document.getElementById('detail-uncertain')?.checked,
    })
  })

  const commentInput = document.getElementById('comment-input')
  document.getElementById('comment-send-btn').addEventListener('click', _sendComment)
  commentInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') _sendComment()
  })
  _initMentions(commentInput)
}

export async function openFindDetail(obsId, options = {}) {
  currentObs    = null
  selectedTaxon = null
  currentObsIsOwner = false
  returnScreenOverride = options.returnScreen || null
  hideCancelOverride = !!options.hideCancel

  // Update back button label — state.currentScreen is still the previous screen at this point
  const prevLabel = {
    home: t('detail.backHome'),
    finds: t('detail.backFinds'),
    map: t('detail.backMap'),
  }[returnScreenOverride || state.currentScreen] || t('detail.backGeneric')
  const backLabel = document.getElementById('detail-back-label')
  if (backLabel) backLabel.textContent = prevLabel

  _resetForm()
  const cancelBtn = document.getElementById('detail-cancel-btn')
  if (cancelBtn) cancelBtn.style.display = hideCancelOverride ? 'none' : ''
  navigate('find-detail')

  let { data: obs, error } = await _withPhase7Fallback(
    columns => supabase
      .from('observations')
      .select(columns)
      .eq('id', obsId)
      .single(),
    DETAIL_SELECT,
    DETAIL_SELECT_LEGACY,
  )

  if (error || !obs) {
    const communityRes = await _withPhase7Fallback(
      columns => supabase
        .from('observations_community_view')
        .select(columns)
        .eq('id', obsId)
        .single(),
      DETAIL_VIEW_SELECT,
      DETAIL_VIEW_SELECT_LEGACY,
    )
    obs = communityRes.data || null
    error = communityRes.error
  }

  if (error || !obs) {
    showToast(t('detail.couldNotLoadObservation'))
    navigate('finds')
    return
  }

  currentObs = obs
  currentObsIsOwner = obs.user_id === state.user?.id
  await _loadDetailAuthorAndSocial()
  _applyOwnershipMode(currentObsIsOwner)
  _renderDetailAuthorAndSocial()

  const displayName = formatDisplayName(obs.genus || '', obs.species || '', obs.common_name)
  _setDetailHeader({
    commonName: obs.common_name || '',
    genus: obs.genus || '',
    species: obs.species || '',
    fallbackName: displayName.trim() || t('detail.unknownSpecies'),
    uncertain: !!obs.uncertain,
  })
  document.getElementById('detail-taxon-input').value = displayName.trim()

  document.getElementById('detail-location').value = obs.location || ''
  _startDetailLocationLookup(obs)

  document.getElementById('detail-habitat').value     = obs.habitat   || ''
  document.getElementById('detail-notes').value       = obs.notes     || ''
  document.getElementById('detail-uncertain').checked = !!obs.uncertain

  document.getElementById('detail-date').textContent = obs.date
    ? formatDate(obs.date, { day: 'numeric', month: 'short', year: 'numeric' })
    : '—'

  // Show capture time from EXIF if available
  const timeEl  = document.getElementById('detail-time')
  const timeVal = document.getElementById('detail-time-val')
  if (obs.captured_at) {
    const t = new Date(obs.captured_at)
    timeVal.textContent = formatTime(t, { hour: '2-digit', minute: '2-digit' })
    timeEl.style.display = 'inline'
  } else {
    timeEl.style.display = 'none'
  }

  const coordsEl = document.getElementById('detail-coords');
  if (coordsEl) {
    coordsEl.innerHTML = buildGpsMetaHtml({
      lat: obs.gps_latitude,
      lon: obs.gps_longitude,
      altitude: obs.gps_altitude,
      accuracy: obs.gps_accuracy,
    })
    coordsEl.style.display = obs.gps_latitude ? 'block' : 'none'
  }

  // Set visibility radio
  const vis = normalizeVisibility(obs.visibility, 'public')
  const visRadio = document.querySelector(`input[name="detail-vis"][value="${vis}"]`)
  if (visRadio) {
    visRadio.checked = true
    document.querySelectorAll('input[name="detail-vis"]').forEach(r => {
      r.closest('.scope-tab').classList.toggle('active', r.checked)
    })
  }
  const draftInput = document.getElementById('detail-draft')
  if (draftInput) draftInput.checked = obs.is_draft !== false
  const obscuredInput = document.getElementById('detail-obscured')
  if (obscuredInput) obscuredInput.checked = obs.location_precision === 'fuzzed'
  detailPrivacySlotCount = null
  _renderPrivacySlotNote()
  _loadPrivacySlotCount()

  // Try to load with crop columns; fall back if the migration hasn't been applied yet
  let imgData = null
  const { data: imgWithCrop, error: imgErr } = await supabase
    .from('observation_images')
    .select('id, storage_path, sort_order, image_type, ai_crop_x1, ai_crop_y1, ai_crop_x2, ai_crop_y2')
    .eq('observation_id', obsId)
    .order('sort_order', { ascending: true })
  if (imgErr) {
    const { data: imgBase } = await supabase
      .from('observation_images')
      .select('id, storage_path, sort_order')
      .eq('observation_id', obsId)
      .order('sort_order', { ascending: true })
    imgData = (imgBase || []).map(r => ({ ...r, image_type: 'field', ai_crop_x1: null, ai_crop_y1: null, ai_crop_x2: null, ai_crop_y2: null }))
  } else {
    imgData = imgWithCrop || []
  }

  const gallery = document.getElementById('detail-gallery')
  gallery.innerHTML = ''
  detailImageRows = []
  detailImageSources = []
  detailAiSources = []
  detailAuthorProfile = null
  detailFriendship = null
  detailFollowState = { user: false, observation: false, taxon: false, genus: false }

  let topRow = document.getElementById('detail-top-row');
  let introEl = document.querySelector('.detail-intro');
  if (!topRow && introEl) {
    topRow = document.createElement('div');
    topRow.id = 'detail-top-row';
    topRow.className = 'detail-top-row';
    introEl.parentNode.insertBefore(topRow, introEl);
  }

  let actionBar = document.getElementById('detail-action-bar');
  if (!actionBar) {
    actionBar = document.createElement('div');
    actionBar.id = 'detail-action-bar';
    actionBar.className = 'detail-action-bar';
    const gallery = document.getElementById('detail-gallery');
    if (gallery && gallery.parentNode) {
      gallery.parentNode.insertBefore(actionBar, gallery);
    }
  }

  let bannerEl = document.getElementById('detail-status-banner');
  if (!bannerEl) {
    bannerEl = document.createElement('div');
    bannerEl.id = 'detail-status-banner';
  }
  if (bannerEl.parentNode) {
    bannerEl.parentNode.removeChild(bannerEl);
  }

  bannerEl.innerHTML = '';
  let showBanner = false;

  if (obs.is_draft) {
    const tag = document.createElement('span');
    tag.className = 'detail-status-tag tag-draft';
    tag.textContent = t('detail.draft') || 'Draft';
    bannerEl.appendChild(tag);
    showBanner = true;
  }
  if (obs.location_precision === 'fuzzed') {
    const tag = document.createElement('span');
    tag.className = 'detail-status-tag tag-obscured';
    tag.textContent = t('locationPrecision.fuzzed') || 'Obscured';
    bannerEl.appendChild(tag);
    showBanner = true;
  }
  if (normalizeVisibility(obs.visibility, 'public') === 'private') {
    const tag = document.createElement('span');
    tag.className = 'detail-status-tag tag-private';
    tag.textContent = t('visibility.private') || 'Private';
    bannerEl.appendChild(tag);
    showBanner = true;
  }

  bannerEl.style.display = showBanner ? 'flex' : 'none';
  if (topRow && bannerEl.parentNode !== topRow) {
    topRow.appendChild(bannerEl);
  }

  if (imgData?.length) {
    const originalSources = await resolveMediaSources(imgData.map(i => i.storage_path), { variant: 'original' })
    const displaySources = await resolveMediaSources(imgData.map(i => i.storage_path), { variant: 'medium' })
    const aiSources = displaySources
    detailImageRows = [...imgData]
    detailImageSources = [...originalSources]
    detailAiSources = [...aiSources]

    displaySources.forEach((source, index) => {
      _appendDetailGalleryImage(imgData[index], source, aiSources[index] || null, {
        index,
        originalSource: originalSources[index] || null,
      })
    })
  }

  if (currentObsIsOwner) {
    const addCardContainer = document.createElement('div')
    addCardContainer.className = 'detail-gallery-item-wrap'
    addCardContainer.innerHTML = `
      <div class="gallery-add-placeholder">
        <div class="gallery-add-title">${t('import.addImage') || 'Add Image'}</div>
        <div class="gallery-add-btn-wrap">
          <button class="gallery-add-btn gallery-add-btn-cam" type="button" aria-label="Add from camera">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6h3l1.6-2h4.8L16 6h3a2 2 0 0 1 2 2v9a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="3.5"/></svg>
            <span>${t('import.camera') || 'Camera'}</span>
          </button>
          <button class="gallery-add-btn gallery-add-btn-file" type="button" aria-label="Add from file">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <span>${t('import.upload') || 'Upload'}</span>
          </button>
        </div>
      </div>
    `
    gallery.appendChild(addCardContainer)
    addCardContainer.querySelector('.gallery-add-btn-cam').addEventListener('click', () => _openCameraForDetail())
    addCardContainer.querySelector('.gallery-add-btn-file').addEventListener('click', () => _openPickerForDetail())
  }

  // Load comments async (don't await)
  _loadComments(obsId)
}

function _mediaSourceUrl(source) {
  return source?.primaryUrl || source?.fallbackUrl || ''
}

function _appendDetailGalleryImage(row, source, aiSource, options = {}) {
  const originalSource = options.originalSource || source
  const displayUrl = _mediaSourceUrl(source) || _mediaSourceUrl(originalSource)
  if (!row || !displayUrl) return null
  const gallery = document.getElementById('detail-gallery')
  if (!gallery) return null

  const index = Number.isInteger(options.index) ? options.index : detailImageRows.length
  const isMicroscope = (row?.image_type || 'field') === 'microscope'
  const container = document.createElement('div')
  container.className = 'detail-gallery-item-wrap'
  container.dataset.imageId = row.id || ''

  const img = document.createElement('img')
  img.className = 'detail-gallery-img'
  img.src = displayUrl
  img.loading = 'lazy'
  img.alt = ''
  img.dataset.storagePath = row.storage_path || ''
  img.dataset.fullSrc = _mediaSourceUrl(originalSource) || displayUrl
  img.dataset.aiSrc = _mediaSourceUrl(aiSource) || displayUrl
  img.dataset.aiFallback = _mediaSourceUrl(originalSource) || _mediaSourceUrl(source) || displayUrl
  if (source.fallbackUrl && source.fallbackUrl !== source.primaryUrl) {
    img.addEventListener('error', () => {
      if (img.dataset.fallbackApplied === 'true') return
      img.dataset.fallbackApplied = 'true'
      img.src = source.fallbackUrl
    }, { once: true })
  }

  img.style.cursor = 'pointer'
  img.addEventListener('click', () => {
    const galleryImgs = Array.from(gallery.querySelectorAll('.detail-gallery-img'))
    const currentIndex = galleryImgs.indexOf(img)
    openPhotoViewer(galleryImgs.map(i => ({
      src: i.dataset.fullSrc || i.src,
      fallbackSrc: i.src
    })), Math.max(0, currentIndex))
  })
  container.appendChild(img)

  if (currentObsIsOwner) {
    if (!isMicroscope) {
      const cropBtn = document.createElement('button')
      cropBtn.className = 'detail-overlay-btn detail-overlay-crop'
      cropBtn.textContent = 'AI crop'
      cropBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        const startIndex = detailImageRows.findIndex(r => String(r.id) === String(row.id))
        openAiCropEditor({
          title: t('crop.editorTitle'),
          startIndex: Math.max(0, startIndex),
          images: detailImageRows.map((r, i) => ({
            url: _mediaSourceUrl(detailImageSources[i]) || _mediaSourceUrl(detailAiSources[i]) || '',
            aiCropRect: normalizeAiCropRect({
              x1: r.ai_crop_x1, y1: r.ai_crop_y1,
              x2: r.ai_crop_x2, y2: r.ai_crop_y2,
            }),
          })),
          onChange: (idx, meta) => {
            const r = detailImageRows[idx]
            if (!r) return
            r.ai_crop_x1 = meta.aiCropRect?.x1 ?? null
            r.ai_crop_y1 = meta.aiCropRect?.y1 ?? null
            r.ai_crop_x2 = meta.aiCropRect?.x2 ?? null
            r.ai_crop_y2 = meta.aiCropRect?.y2 ?? null
            updateObservationImageCrop(r.id, meta)
          },
        })
      })
      container.appendChild(cropBtn)
    }

    const delBtn = document.createElement('button')
    delBtn.className = 'detail-overlay-btn detail-overlay-delete'
    delBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/></svg>'
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!confirm(t('detail.confirmDeleteImage') || 'Delete this image?')) return

      delBtn.disabled = true
      try {
        await deleteObservationMedia([row.storage_path])
        await supabase.from('observation_images').delete().eq('id', row.id)
        const rowIndex = detailImageRows.findIndex(r => String(r.id) === String(row.id))
        if (rowIndex >= 0) {
          detailImageRows.splice(rowIndex, 1)
          detailImageSources.splice(rowIndex, 1)
          detailAiSources.splice(rowIndex, 1)
        }

        const { data: remaining } = await supabase
          .from('observation_images')
          .select('storage_path')
          .eq('observation_id', currentObs.id)
          .order('sort_order', { ascending: true })
          .limit(1)
        if (remaining && remaining.length > 0) {
          await syncObservationMediaKeys(currentObs.id, remaining[0].storage_path, { sortOrder: 0 })
        } else {
          await supabase.from('observations').update({ image_key: null, thumb_key: null }).eq('id', currentObs.id)
        }
        container.remove()
      } catch (err) {
        console.error('Failed to delete image:', err)
        showToast(err.message)
        delBtn.disabled = false
      }
    })
    container.appendChild(delBtn)
  }

  const addCard = gallery.querySelector('.gallery-add-placeholder')?.closest('.detail-gallery-item-wrap')
  if (addCard && !options.appendAfterAddCard) gallery.insertBefore(container, addCard)
  else gallery.appendChild(container)

  if (!options.skipStateInsert && !detailImageRows.some(r => String(r.id) === String(row.id))) {
    detailImageRows.splice(index, 0, row)
    detailImageSources.splice(index, 0, originalSource)
    detailAiSources.splice(index, 0, aiSource)
  }
  return container
}

function _storagePathExtension(storagePath) {
  const value = String(storagePath || '').trim()
  const name = value.split('/').pop() || value
  const idx = name.lastIndexOf('.')
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : ''
}

async function _describeDetailBlob(blob) {
  if (!(blob instanceof Blob)) {
    return { blobType: '', blobSize: 0, width: null, height: null }
  }
  try {
    const dims = await getBlobImageDimensions(blob)
    return {
      blobType: blob.type || '',
      blobSize: blob.size || 0,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
    }
  } catch (_) {
    return {
      blobType: blob.type || '',
      blobSize: blob.size || 0,
      width: null,
      height: null,
    }
  }
}

async function _loadDetailIdentifyBlob(img, variant = 'medium') {
  const storagePath = img?.dataset?.storagePath || ''
  const fallbackUrls = [
    img?.dataset?.aiFallback || '',
    img?.dataset?.aiSrc || '',
    img?.src || '',
  ].filter(Boolean)

  try {
    const blob = await downloadObservationImageBlob(storagePath, { variant })
    return {
      blob,
      usedFallbackUrl: false,
      sourceMode: 'blob',
      storagePathExtension: _storagePathExtension(storagePath),
      requestedVariant: variant,
    }
  } catch (storageError) {
    let lastError = storageError
    for (const url of fallbackUrls) {
      try {
        const resp = await fetch(url)
        if (!resp.ok) throw new Error(`Image fetch failed: ${resp.status}`)
        const blob = await resp.blob()
        return {
          blob,
          usedFallbackUrl: true,
          sourceMode: 'fallback-url',
          storagePathExtension: _storagePathExtension(storagePath),
          requestedVariant: variant,
        }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError || storageError || new Error('Image fetch failed')
  }
}

function _isArtsorakelBlobFallbackError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return message.includes('artsdata ai 500')
    || (message.includes('artsdata ai') && message.includes('500'))
    || (message.includes('endpoint') && message.includes('status=500'))
    || (message.includes('status 500') && message.includes('artsorakel'))
}

export async function prepareDetailIdentifyInputs(galleryImgs, variant = 'medium') {
  return await Promise.all((galleryImgs || []).map(async img => {
    try {
      const result = await _loadDetailIdentifyBlob(img, variant)
      if (!(result.blob instanceof Blob)) return null
      return {
        ...result,
        debug: await _describeDetailBlob(result.blob),
      }
    } catch (error) {
      return {
        blob: null,
        error,
        usedFallbackUrl: false,
        sourceMode: 'failed',
        storagePathExtension: _storagePathExtension(img?.dataset?.storagePath || ''),
        requestedVariant: variant,
        debug: { blobType: '', blobSize: 0, width: null, height: null },
      }
    }
  }))
}

export async function runDetailIdentify(service, galleryImgs, options = {}) {
  const identifyInputs = await prepareDetailIdentifyInputs(galleryImgs, options.variant || 'medium')
  const blobs = identifyInputs
    .filter(item => item?.blob instanceof Blob)
    .map(item => item.blob)
  const mediaKeys = (galleryImgs || [])
    .map(img => img?.dataset?.storagePath || '')
    .filter(Boolean)

  identifyInputs.forEach(item => {
    if (!item) return
    console.debug('[detail-ai] identify input', {
      service,
      storagePathExtension: item.storagePathExtension,
      requestedVariant: item.requestedVariant,
      blobType: item.debug?.blobType || '',
      blobSize: item.debug?.blobSize || 0,
      width: item.debug?.width ?? null,
      height: item.debug?.height ?? null,
      usedFallbackUrl: item.usedFallbackUrl,
      mediaKeysCount: mediaKeys.length,
      sourceMode: item.sourceMode,
      pathMode: 'blob',
    })
  })

  const language = options.language || getTaxonomyLanguage()
  const identifyBlobs = options.identifyBlobs || runIdentifyForBlobs
  const identifyMediaKeys = options.identifyMediaKeys || runIdentifyForMediaKeys

  if (blobs.length) {
    try {
      const identifyOptions = service === ID_SERVICE_ARTSORAKEL
        ? { tolerateFailures: true, maxEdge: Math.min(getArtsorakelMaxEdge(), 1024) }
        : { tolerateFailures: true }
      return await identifyBlobs(blobs, service, language, identifyOptions)
    } catch (error) {
      if (service === ID_SERVICE_ARTSORAKEL && mediaKeys.length && _isArtsorakelBlobFallbackError(error)) {
        console.debug('[detail-ai] falling back to media keys', {
          service,
          mediaKeysCount: mediaKeys.length,
          pathMode: 'media-keys',
          reason: String(error?.message || error || ''),
        })
        return identifyMediaKeys(mediaKeys, service, language, { variant: options.variant || 'medium' })
      }
      throw error
    }
  }

  if (mediaKeys.length && service === ID_SERVICE_ARTSORAKEL) {
    console.debug('[detail-ai] using media-key identify', {
      service,
      mediaKeysCount: mediaKeys.length,
      pathMode: 'media-keys',
    })
    return identifyMediaKeys(mediaKeys, service, language, { variant: options.variant || 'medium' })
  }

  if (service === ID_SERVICE_ARTSORAKEL) {
    throw new Error('Could not load observation images for Artsorakel')
  }
  throw new Error('Could not load observation images for iNaturalist')
}

async function _runAI(service) {
  const btn       = document.getElementById(service === ID_SERVICE_INATURALIST ? 'detail-inat-btn' : 'detail-arts-btn')
  const buttons = [
    document.getElementById('detail-inat-btn'),
    document.getElementById('detail-arts-btn'),
  ].filter(Boolean)
  const resultsEl = document.getElementById('detail-ai-results')
  const galleryImgs = Array.from(document.querySelectorAll('#detail-gallery img'))
  if (!galleryImgs.length) { showToast(t('detail.noPhotoToIdentify')); return }

  buttons.forEach(actionBtn => { actionBtn.disabled = true })
  btn.innerHTML = `<div class="ai-dot"></div> ${getIdentifyBusyLabel(service)}`
  resultsEl.style.display = 'none'

  try {
    const predictions = await runDetailIdentify(service, galleryImgs, { variant: 'medium' })

    if (!predictions?.length) {
      showToast(getIdentifyNoMatchMessage(service))
      return
    }

    resultsEl.innerHTML = predictions.map((p, i) =>
      `<div class="ai-result" data-idx="${i}">
        <span class="ai-prob">${formatIdentifyScore(service, p.probability)}</span>
        <span class="ai-name">${_esc(p.displayName)}</span>
      </div>`
    ).join('')
    resultsEl.style.display = 'block'
    resultsEl._predictions = predictions

    resultsEl.querySelectorAll('.ai-result').forEach((el, i) => {
      el.addEventListener('click', () => {
        const p = predictions[i]
        const parts = (p.scientificName || '').trim().split(' ')
        selectedTaxon = {
          genus:           parts[0] || null,
          specificEpithet: parts[1] || null,
          vernacularName:  p.vernacularName || null,
          displayName:     p.displayName,
        }
        document.getElementById('detail-taxon-input').value = p.displayName
        _setDetailHeader({
          commonName: selectedTaxon.vernacularName || '',
          genus: selectedTaxon.genus || '',
          species: selectedTaxon.specificEpithet || '',
          fallbackName: p.displayName || t('detail.unknownSpecies'),
          uncertain: document.getElementById('detail-uncertain')?.checked,
        })
        resultsEl.style.display = 'none'
      })
    })
  } catch (err) {
    const message = String(err?.message || 'Unknown error')
    if (message.includes('CORS') || message.toLowerCase().includes('failed to fetch')) {
      showToast(getIdentifyUnavailableMessage(service))
    } else if (service === ID_SERVICE_INATURALIST && message.toLowerCase().includes('missing inaturalist api token')) {
      showToast(t('settings.inaturalistLoginMissing'))
    } else {
      showToast(service === ID_SERVICE_INATURALIST
        ? t('common.errorPrefix', { message })
        : t('common.artsorakelError', { message }))
    }
    console.warn('Identification detail error:', err)
  } finally {
    buttons.forEach(actionBtn => {
      actionBtn.disabled = false
      const actionService = actionBtn.id === 'detail-inat-btn'
        ? ID_SERVICE_INATURALIST
        : ID_SERVICE_ARTSORAKEL
      actionBtn.innerHTML = `<div class="ai-dot"></div> ${getIdentifyButtonLabel(actionService)}`
    })
  }
}

function _goBack(event) {
  if (event) event.preventDefault()
  if (returnScreenOverride) {
    const target = returnScreenOverride
    returnScreenOverride = null
    if (target === 'finds') {
      openFinds('mine', { resetSearch: true })
      return
    }
    navigate(target)
    return
  }
  const prev = goBack()
  if (prev === 'finds') loadFinds()
}

function _resetForm() {
  currentObsIsOwner = false
  document.getElementById('detail-taxon-input').value = ''
  document.getElementById('detail-taxon-dropdown').style.display = 'none'
  document.getElementById('detail-location').value    = ''
  detailLocationSuggestions = []
  detailLocationLookupKey = ''
  detailLocationAutoApplied = ''
  _renderDetailLocationDropdown(false)
  document.getElementById('detail-habitat').value     = ''
  const coordsEl = document.getElementById('detail-coords')
  if (coordsEl) { coordsEl.innerHTML = ''; coordsEl.style.display = 'none' }
  document.getElementById('detail-notes').value       = ''
  document.getElementById('detail-uncertain').checked = false
  _setDetailHeader({ fallbackName: t('detail.unknownSpecies') })
  detailAuthorProfile = null
  detailFriendship = null
  detailFollowState = { user: false, observation: false, taxon: false, genus: false }
  detailPrivacySlotCount = null
  _renderDetailAuthorAndSocial()
  document.getElementById('detail-date').textContent  = '—'
  const timeEl = document.getElementById('detail-time')
  const timeVal = document.getElementById('detail-time-val')
  if (timeEl) timeEl.style.display = 'none'
  if (timeVal) timeVal.textContent = ''
  document.getElementById('detail-gallery').innerHTML = ''
  const aiResults = document.getElementById('detail-ai-results')
  if (aiResults) { aiResults.style.display = 'none'; aiResults.innerHTML = '' }
  const cancelBtn = document.getElementById('detail-cancel-btn')
  if (cancelBtn) cancelBtn.style.display = ''

  // Reset visibility to default
  const r = document.querySelector(`input[name="detail-vis"][value="${normalizeVisibility(getDefaultVisibility(), 'public')}"]`)
  if (r) {
    r.checked = true
    document.querySelectorAll('input[name="detail-vis"]').forEach(radio => {
      radio.closest('.scope-tab').classList.toggle('active', radio.checked)
    })
  }
  const draftInput = document.getElementById('detail-draft')
  if (draftInput) draftInput.checked = true
  const obscuredInput = document.getElementById('detail-obscured')
  if (obscuredInput) obscuredInput.checked = false
  _renderPrivacySlotNote()

  // Clear comments
  const commentsList = document.getElementById('comments-list')
  if (commentsList) commentsList.innerHTML = ''
  const commentInput = document.getElementById('comment-input')
  if (commentInput) commentInput.value = ''
  _applyOwnershipMode(true)
}

function _startDetailLocationLookup(obs) {
  const lat = Number(obs?.gps_latitude)
  const lon = Number(obs?.gps_longitude)
  const lookupKey = lookupCoordinateKey(lat, lon)
  detailLocationSuggestions = []
  detailLocationLookupKey = lookupKey
  detailLocationAutoApplied = ''
  _renderDetailLocationDropdown(false)
  if (!lookupKey) return

  lookupReverseLocation(lat, lon, {
    onUpdate: updated => _applyDetailLocationLookup(lookupKey, updated),
  })
    .then(result => _applyDetailLocationLookup(lookupKey, result))
    .catch(() => {})
}

function _applyDetailLocationLookup(lookupKey, result) {
  if (lookupKey !== detailLocationLookupKey) return
  detailLocationSuggestions = result?.suggestions || []
  const first = detailLocationSuggestions[0] || ''
  const input = document.getElementById('detail-location')
  if (input && first && (!input.value.trim() || input.value.trim() === detailLocationAutoApplied)) {
    input.value = first
    detailLocationAutoApplied = first
  }
  _renderDetailLocationDropdown(document.activeElement === input)
}

function _renderDetailLocationDropdown(show) {
  const dropdown = document.getElementById('detail-location-dropdown')
  const input = document.getElementById('detail-location')
  if (!dropdown || !input) return
  if (!show || !currentObsIsOwner || !detailLocationSuggestions.length) {
    dropdown.style.display = 'none'
    dropdown.innerHTML = ''
    return
  }

  dropdown.innerHTML = detailLocationSuggestions
    .map((name, index) => `<li data-index="${index}">${_esc(name)}</li>`)
    .join('')
  dropdown.style.display = 'block'
  dropdown.querySelectorAll('li').forEach((item, index) => {
    const handleSelect = event => {
      event.preventDefault()
      event.stopPropagation()
      const name = detailLocationSuggestions[index] || ''
      input.value = name
      detailLocationAutoApplied = name
      dropdown.style.display = 'none'
    }
    item.addEventListener('mousedown', handleSelect)
    item.addEventListener('touchstart', handleSelect, { passive: false })
  })
}

function _currentDetailUsesPrivacySlot() {
  const visibility = document.querySelector('input[name="detail-vis"]:checked')?.value || 'public'
  const precision = document.getElementById('detail-obscured')?.checked ? 'fuzzed' : 'exact'
  return visibility !== 'public' || precision === 'fuzzed'
}

function _renderPrivacySlotNote() {
  const note = document.getElementById('detail-privacy-slot-note')
  if (!note) return

  const draftPill = document.getElementById('detail-draft-pill')
  const isDraft = document.getElementById('detail-draft')?.checked !== false
  if (draftPill) draftPill.textContent = isDraft ? t('detail.draft') : t('detail.ready')

  const isPro = state.cloudPlan?.cloudPlan === 'pro' || !!state.cloudPlan?.fullResStorageEnabled
  const currentText = _currentDetailUsesPrivacySlot()
    ? t('privacySlots.currentUses')
    : t('privacySlots.currentFree')

  if (isPro) {
    note.textContent = `${t('privacySlots.pro')} ${currentText}`
    return
  }

  const usageText = Number.isFinite(detailPrivacySlotCount)
    ? t('privacySlots.used', { used: detailPrivacySlotCount, limit: 20 })
    : t('privacySlots.usedUnknown')
  note.textContent = `${usageText} ${currentText}`
}

async function _loadPrivacySlotCount() {
  if (!state.user?.id) return
  const { data, error } = await supabase.rpc('non_public_observation_count', {
    profile_id: state.user.id,
  })
  if (error) {
    detailPrivacySlotCount = null
    _renderPrivacySlotNote()
    return
  }
  const count = Number(data)
  detailPrivacySlotCount = Number.isFinite(count) ? count : null
  _renderPrivacySlotNote()
}

function _profileLabel(profile, fallback = t('common.unknown')) {
  if (profile?.username) return `@${profile.username}`
  if (profile?.display_name) return profile.display_name
  return fallback
}

function _profileInitial(profile, fallback = '?') {
  const source = profile?.username || profile?.display_name || fallback
  return String(source).replace(/^@/, '').trim().charAt(0).toUpperCase() || '?'
}

async function _loadDetailAuthorAndSocial() {
  detailAuthorProfile = null
  detailFriendship = null
  detailFollowState = { user: false, observation: false, taxon: false, genus: false }
  if (!currentObs?.user_id) return

  const isOwner = currentObs.user_id === state.user?.id
  const profilePromise = supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .eq('id', currentObs.user_id)
    .maybeSingle()

  const friendshipPromise = isOwner ? Promise.resolve({ data: [] }) : supabase
    .from('friendships')
    .select('id, requester_id, addressee_id, status')
    .or(`and(requester_id.eq.${state.user.id},addressee_id.eq.${currentObs.user_id}),and(requester_id.eq.${currentObs.user_id},addressee_id.eq.${state.user.id})`)
    .limit(1)

  const taxonFollow = _taxonFollowTarget(currentObs)
  const followTargets = [currentObs.user_id, currentObs.id, taxonFollow?.targetId, currentObs.genus].filter(Boolean)
  const followsPromise = isOwner ? Promise.resolve({ data: [] }) : supabase
    .from('follows')
    .select('target_type, target_id')
    .eq('user_id', state.user.id)
    .in('target_type', ['user', 'observation', 'species', 'genus'])
    .in('target_id', followTargets)

  const [profileRes, friendshipRes, followsRes] = await Promise.all([profilePromise, friendshipPromise, followsPromise])
  if (!profileRes.error) detailAuthorProfile = profileRes.data || null
  if (!friendshipRes.error) detailFriendship = friendshipRes.data?.[0] || null
  if (!followsRes.error) {
    for (const row of followsRes.data || []) {
      if (row.target_type === 'user' && String(row.target_id) === String(currentObs.user_id)) detailFollowState.user = true
      if (row.target_type === 'observation' && String(row.target_id) === String(currentObs.id)) detailFollowState.observation = true
      if (taxonFollow && row.target_type === taxonFollow.targetType && String(row.target_id).toLowerCase() === String(taxonFollow.targetId).toLowerCase()) detailFollowState.taxon = true
      if (row.target_type === 'genus' && String(row.target_id).toLowerCase() === String(currentObs.genus || '').toLowerCase()) detailFollowState.genus = true
    }
  }
}

function _renderDetailAuthorAndSocial() {
  const authorBtn = document.getElementById('detail-author')
  const authorName = document.getElementById('detail-author-name')
  const authorAvatar = document.getElementById('detail-author-avatar')
  const socialRow = document.getElementById('detail-social-row')
  const isOwner = currentObs?.user_id === state.user?.id
  const taxonFollow = _taxonFollowTarget(currentObs)
  const topRow = document.getElementById('detail-top-row')

  if (authorBtn && currentObs?.user_id) {
    const handle = isOwner ? t('common.you') : `@${detailAuthorProfile?.username || ''}`
    const fullName = isOwner ? '' : (detailAuthorProfile?.display_name || '')
    const showName = fullName && fullName !== detailAuthorProfile?.username
    authorBtn.style.display = 'flex'
    if (authorName) {
      authorName.innerHTML = `<span class="author-handle">${_esc(handle)}</span>${showName ? `<span class="author-role">${_esc(fullName)}</span>` : ''}`
    }
    if (authorAvatar) {
      const avatarUrl = detailAuthorProfile?.avatar_url || ''
      authorAvatar.innerHTML = avatarUrl
        ? `<img src="${_esc(avatarUrl)}" alt="" loading="lazy" decoding="async">`
        : _esc(_profileInitial(detailAuthorProfile, handle))
    }
    if (topRow && authorBtn.parentNode !== topRow) {
      topRow.insertBefore(authorBtn, topRow.firstChild)
    }
  } else if (authorBtn) {
    authorBtn.style.display = 'none'
  }

  let actionBar = document.getElementById('detail-action-bar');
  if (actionBar) {
    if (isOwner || !currentObs?.user_id) {
      actionBar.style.display = 'none';
    } else {
      actionBar.style.display = 'flex';
      
      const status = detailFriendship?.status || ''
      const accepted = status === 'accepted'
      const pending = status === 'pending'
      
      let friendText = accepted ? 'Friends' : (pending ? 'Pending' : 'Add Friend');
      let friendIconClass = accepted ? 'friend-btn-icon active' : 'friend-btn-icon';
      
      let followText = '';
      let followAction = '';
      let isFollowActive = false;
      
      if (detailFollowState.taxon && taxonFollow && taxonFollow.targetType === 'species') {
         followText = 'Following Species';
         followAction = 'taxon';
         isFollowActive = true;
      } else if (detailFollowState.genus || (detailFollowState.taxon && taxonFollow && taxonFollow.targetType === 'genus')) {
         followText = 'Following Genus';
         followAction = 'genus';
         isFollowActive = true;
      }
      
      let followHtml = '';
      if (isFollowActive) {
        followHtml = `
          <button id="new-follow-btn" class="action-btn active" data-action="${followAction}">
            <svg class="follow-btn-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
            <span>${followText}</span>
          </button>
        `;
      } else {
        followHtml = `
          <div class="follow-dropdown-wrap" id="follow-dropdown-wrap">
            <button id="new-follow-btn" class="action-btn follow-inactive">
              <svg class="follow-btn-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon></svg>
              <span>Follow</span>
              <svg class="follow-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </button>
            <div class="follow-menu" id="follow-menu" style="display: none;">
              ${taxonFollow && taxonFollow.targetType === 'species' ? `
              <button class="follow-menu-item" data-action="taxon">
                <span class="follow-menu-title">Follow Species</span>
                <span class="follow-menu-sub">${_esc(taxonFollow.targetId)}</span>
              </button>
              ${currentObs.genus ? '<div class="follow-menu-div"></div>' : ''}
              ` : ''}
              ${currentObs.genus ? `
              <button class="follow-menu-item" data-action="genus">
                <span class="follow-menu-title">Follow Genus</span>
                <span class="follow-menu-sub">${_esc(currentObs.genus)}</span>
              </button>
              ` : ''}
            </div>
          </div>
        `;
      }

      actionBar.innerHTML = `
        <button id="new-friend-btn" class="action-btn" ${accepted || pending ? 'disabled' : ''}>
          <svg class="friend-btn-icon ${accepted ? 'is-friend' : ''}" width="20" height="20" viewBox="0 0 24 24" fill="${accepted ? 'var(--red)' : 'none'}" stroke="${accepted ? 'var(--red)' : 'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
          <span>${friendText}</span>
        </button>
        ${followHtml}
      `;
      
      document.getElementById('new-friend-btn').addEventListener('click', _sendFriendRequestFromDetail);
      
      const followBtn = document.getElementById('new-follow-btn');
      
      if (isFollowActive) {
        followBtn.addEventListener('click', (e) => {
          _toggleFollowSpecific(followBtn.dataset.action);
        });
      } else {
        const followWrap = document.getElementById('follow-dropdown-wrap');
        const followMenu = document.getElementById('follow-menu');
        
        followBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const isOpening = followMenu.style.display === 'none';
          followMenu.style.display = isOpening ? 'block' : 'none';
          followBtn.classList.toggle('menu-open', isOpening);
          
          if (isOpening) {
            const closeMenu = (ev) => {
              if (!followWrap.contains(ev.target)) {
                followMenu.style.display = 'none';
                followBtn.classList.remove('menu-open');
                document.removeEventListener('click', closeMenu);
              }
            };
            setTimeout(() => document.addEventListener('click', closeMenu), 0);
          }
        });
        
        followMenu.querySelectorAll('.follow-menu-item').forEach(item => {
          item.addEventListener('click', (e) => {
            e.stopPropagation();
            followMenu.style.display = 'none';
            followBtn.classList.remove('menu-open');
            const action = item.dataset.action;
            _toggleFollowSpecific(action);
          });
        });
      }
    }
  }
}

function _taxonFollowTarget(obs) {
  const genus = String(obs?.genus || '').trim()
  const species = String(obs?.species || '').trim()
  if (genus && species) return { targetType: 'species', targetId: `${genus} ${species}` }
  if (genus) return { targetType: 'genus', targetId: genus }
  return null
}

function _openAuthorFinds() {
  if (!currentObs?.user_id || currentObs.user_id === state.user?.id) return
  openFinds('user', {
    userId: currentObs.user_id,
    username: _profileLabel(detailAuthorProfile),
    avatarUrl: detailAuthorProfile?.avatar_url || '',
    resetSearch: true,
    resetFilters: true,
  })
}

async function _sendFriendRequestFromDetail() {
  if (!currentObs?.user_id || currentObs.user_id === state.user?.id) return
  const btn = document.getElementById('new-friend-btn') || document.getElementById('detail-friend-btn')
  if (btn) btn.disabled = true
  const { data, error } = await supabase
    .from('friendships')
    .insert({ requester_id: state.user.id, addressee_id: currentObs.user_id, status: 'pending' })
    .select('id, requester_id, addressee_id, status')
    .single()

  if (error && error.code !== '23505') {
    showToast(t('social.friendFailed'))
    if (btn) btn.disabled = false
    return
  }

  showToast(t('social.friendRequestSent') || 'Friend request sent')
  detailFriendship = data || { status: 'pending' }
  _renderDetailAuthorAndSocial()
}

async function _toggleFollowSpecific(kind) {
  if (!currentObs || currentObs.user_id === state.user?.id) return
  let targetType, targetId, key;
  
  if (kind === 'genus') {
    targetType = 'genus';
    targetId = currentObs.genus;
    key = 'genus';
  } else if (kind === 'taxon') {
    const tf = _taxonFollowTarget(currentObs);
    if (!tf) return;
    targetType = tf.targetType;
    targetId = tf.targetId;
    key = 'taxon';
  } else if (kind === 'user') {
    targetType = 'user';
    targetId = currentObs.user_id;
    key = 'user';
  } else if (kind === 'observation') {
    targetType = 'observation';
    targetId = currentObs.id;
    key = 'observation';
  } else {
    return;
  }
  
  if (!targetId) return;

  const currentlyFollowing = !!detailFollowState[key];
  const btn = document.getElementById('new-follow-btn');
  if (btn) btn.disabled = true

  const result = currentlyFollowing
    ? await supabase.from('follows').delete().eq('user_id', state.user.id).eq('target_type', targetType).eq('target_id', targetId)
    : await supabase.from('follows').insert({ user_id: state.user.id, target_type: targetType, target_id: targetId })

  if (result.error && result.error.code !== '23505') {
    showToast(t('social.followFailed'))
    if (btn) btn.disabled = false
    return
  }

  detailFollowState[key] = !currentlyFollowing
  if (btn) btn.disabled = false
  _renderDetailAuthorAndSocial()
}

function _applyOwnershipMode(isOwner) {
  const readonlyNote = document.getElementById('detail-readonly-note')
  const saveBtn = document.getElementById('detail-save-btn')
  const deleteBtn = document.getElementById('detail-delete-btn')
  const aiBtns = [
    document.getElementById('detail-inat-btn'),
    document.getElementById('detail-arts-btn'),
  ]
  const taxonInput = document.getElementById('detail-taxon-input')
  const locationInput = document.getElementById('detail-location')
  const habitatInput = document.getElementById('detail-habitat')
  const notesInput = document.getElementById('detail-notes')
  const uncertainInput = document.getElementById('detail-uncertain')

  if (readonlyNote) {
    readonlyNote.style.display = 'none'
  }
  if (saveBtn) saveBtn.style.display = isOwner ? '' : 'none'
  if (deleteBtn) deleteBtn.style.display = isOwner ? '' : 'none'
  aiBtns.forEach(btn => {
    if (btn) btn.disabled = !isOwner
  })
  if (taxonInput) taxonInput.disabled = !isOwner
  if (locationInput) locationInput.readOnly = !isOwner
  if (habitatInput) habitatInput.readOnly = !isOwner
  if (notesInput) notesInput.readOnly = !isOwner
  if (uncertainInput) uncertainInput.disabled = !isOwner
  const draftInput = document.getElementById('detail-draft')
  if (draftInput) draftInput.disabled = !isOwner

  const currentLocationBtn = document.getElementById('detail-current-location-btn')
  if (currentLocationBtn) currentLocationBtn.style.display = 'none'

  document.querySelectorAll('input[name="detail-vis"]').forEach(radio => {
    radio.disabled = !isOwner
    const sharingField = radio.closest('.detail-field')
    if (sharingField) sharingField.style.display = isOwner ? '' : 'none'
  })
  const obscuredInput = document.getElementById('detail-obscured')
  if (obscuredInput) obscuredInput.disabled = !isOwner
  _renderPrivacySlotNote()

  let modContainer = document.getElementById('detail-mod-container')
  if (!isOwner) {
    if (!modContainer) {
      modContainer = document.createElement('div')
      modContainer.id = 'detail-mod-container'
      modContainer.style.marginTop = '24px'
      modContainer.style.paddingTop = '16px'
      modContainer.style.borderTop = '1px solid var(--border-dim)'
      modContainer.style.display = 'flex'
      modContainer.style.gap = '10px'
      
      const blockBtn = document.createElement('button')
      blockBtn.id = 'detail-block-btn'
      blockBtn.className = 'btn-secondary btn-sm'
      blockBtn.style.flex = '1'
      blockBtn.style.color = 'var(--red)'
      blockBtn.textContent = t('detail.blockUser') || 'Block user'
      blockBtn.addEventListener('click', _blockObservationAuthor)
      
      const reportBtn = document.createElement('button')
      reportBtn.id = 'detail-report-btn'
      reportBtn.className = 'btn-secondary btn-sm'
      reportBtn.style.flex = '1'
      reportBtn.style.color = 'var(--amber)'
      reportBtn.textContent = t('detail.reportPost') || 'Report post'
      reportBtn.addEventListener('click', _reportObservation)
      
      modContainer.appendChild(reportBtn)
      modContainer.appendChild(blockBtn)
      
      const body = document.querySelector('#screen-find-detail .review-body')
      if (body) body.appendChild(modContainer)
    }
    modContainer.style.display = 'flex'
  } else {
    if (modContainer) modContainer.style.display = 'none'
  }
}

async function _searchTaxon(q, dropdown) {
  if (q.length < 2) { dropdown.style.display = 'none'; return }

  const results = await searchTaxa(q, getTaxonomyLanguage())
  if (!results.length) { dropdown.style.display = 'none'; return }

  dropdown.innerHTML = results.map(r =>
    `<li data-taxon='${JSON.stringify(r).replace(/'/g, '&#39;')}'>
      ${r.displayName}
      <span class="taxon-family">${r.family || ''}</span>
    </li>`
  ).join('')
  dropdown.style.display = 'block'

  dropdown.querySelectorAll('li').forEach(li => {
    li.addEventListener('mousedown', () => {
      selectedTaxon = JSON.parse(li.dataset.taxon)
      document.getElementById('detail-taxon-input').value = selectedTaxon.displayName
      _setDetailHeader({
        commonName: selectedTaxon.vernacularName || '',
        genus: selectedTaxon.genus || '',
        species: selectedTaxon.specificEpithet || '',
        fallbackName: selectedTaxon.displayName || t('detail.unknownSpecies'),
        uncertain: document.getElementById('detail-uncertain')?.checked,
      })
      dropdown.style.display = 'none'
    })
  })
}

function _setDetailHeader({ commonName = '', genus = '', species = '', fallbackName = t('detail.unknownSpecies'), uncertain = false }) {
  const commonEl = document.getElementById('detail-title-common')
  const latinEl = document.getElementById('detail-title-latin')
  if (!commonEl || !latinEl) return

  const latinName = [genus, species].filter(Boolean).join(' ').trim()
  const primaryName = String(commonName || '').trim() || String(fallbackName || '').trim() || t('detail.unknownSpecies')
  const markedPrimary = uncertain ? `? ${primaryName.replace(/^\?\s*/, '')}` : primaryName.replace(/^\?\s*/, '')
  const markedLatin = uncertain ? `? ${latinName.replace(/^\?\s*/, '')}` : latinName.replace(/^\?\s*/, '')

  commonEl.innerHTML = _esc(markedPrimary)
  const draftBadgeEl = document.getElementById('detail-draft-badge')
  if (draftBadgeEl) {
    draftBadgeEl.style.display = 'none'
  }
  if (latinName && latinName.toLowerCase() !== primaryName.toLowerCase()) {
    latinEl.textContent = markedLatin
    latinEl.style.display = 'block'
  } else {
    latinEl.textContent = ''
    latinEl.style.display = 'none'
  }
}

async function _save() {
  if (!currentObs) return
  if (!currentObsIsOwner) {
    showToast(t('detail.onlyOwnerEdit'))
    return
  }

  const btn = document.getElementById('detail-save-btn')
  btn.disabled = true

  const patch = {
    location:   document.getElementById('detail-location').value.trim()  || null,
    habitat:    document.getElementById('detail-habitat').value.trim()   || null,
    notes:      document.getElementById('detail-notes').value.trim()     || null,
    uncertain:  document.getElementById('detail-uncertain').checked,
    visibility: toCloudVisibility(document.querySelector('input[name="detail-vis"]:checked')?.value || 'public'),
    is_draft: document.getElementById('detail-draft')?.checked !== false,
    location_precision: document.getElementById('detail-obscured')?.checked ? 'fuzzed' : 'exact',
  }

  const taxonInputValue = document.getElementById('detail-taxon-input').value.trim()
  const currentDisplayName = formatDisplayName(
    currentObs.genus || '',
    currentObs.species || '',
    currentObs.common_name || '',
  ).trim()

  if (selectedTaxon) {
    patch.genus       = selectedTaxon.genus            || null
    patch.species     = selectedTaxon.specificEpithet  || null
    patch.common_name = selectedTaxon.vernacularName   || null
  } else if (taxonInputValue !== currentDisplayName) {
    patch.genus       = null
    patch.species     = taxonInputValue || null
    patch.common_name = null
  }

  let { error } = await supabase
    .from('observations')
    .update(patch)
    .eq('id', currentObs.id)
    .eq('user_id', state.user.id)

  if (_isPhase7ColumnError(error)) {
    const { is_draft: _isDraft, location_precision: _locationPrecision, ...legacyPatch } = patch
    ;({ error } = await supabase
      .from('observations')
      .update(legacyPatch)
      .eq('id', currentObs.id)
      .eq('user_id', state.user.id))
  }

  btn.disabled = false

  if (error) {
    showToast(t('detail.saveFailed', { message: error.message }))
    return
  }

  setLastSyncAt()
  showToast(t('detail.saved'))
  _loadPrivacySlotCount()
  _goBack()
}

async function _delete() {
  if (!currentObs) return
  if (!currentObsIsOwner) {
    showToast(t('detail.onlyOwnerDelete'))
    return
  }
  if (!confirm(t('detail.deleteConfirm'))) return

  const btn = document.getElementById('detail-delete-btn')
  btn.disabled = true

  try {
    // Delete storage images first
    const { data: imgData } = await supabase
      .from('observation_images')
      .select('storage_path')
      .eq('observation_id', currentObs.id)

    if (imgData?.length) {
      await deleteObservationMedia(imgData.map(i => i.storage_path))
    }

    const { error } = await supabase
      .from('observations')
      .delete()
      .eq('id', currentObs.id)
      .eq('user_id', state.user.id)

    if (error) { showToast(t('detail.deleteFailed', { message: error.message })); return }

    setLastSyncAt()
    showToast(t('detail.deleted'))
    _goBack()
  } catch (error) {
    showToast(t('detail.deleteFailed', { message: error.message }))
  } finally {
    btn.disabled = false
  }
}

async function _blockObservationAuthor() {
  if (!currentObs || !state.user) return
  if (!confirm(t('detail.blockUserConfirm') || 'Block this user? You will no longer see their posts and comments.')) return
  
  const btn = document.getElementById('detail-block-btn')
  if (btn) btn.disabled = true
  
  const { error } = await supabase.from('user_blocks').insert({
    blocker_id: state.user.id,
    blocked_id: currentObs.user_id
  })
  
  if (error && error.code !== '23505') {
    showToast((t('detail.blockFailed') || 'Failed to block user: ') + error.message)
    if (btn) btn.disabled = false
    return
  }
  
  showToast(t('detail.userBlocked') || 'User blocked.')
  await loadFinds()
  await refreshHome()
  _goBack()
}

async function _reportObservation() {
  if (!currentObs || !state.user) return
  const reason = prompt(t('detail.reportReason') || 'Why are you reporting this post? (e.g. spam, inappropriate)')
  if (!reason) return
  
  const btn = document.getElementById('detail-report-btn')
  if (btn) btn.disabled = true
  
  const { error } = await supabase.from('reports').insert({
    reporter_id: state.user.id,
    reported_user_id: currentObs.user_id,
    observation_id: currentObs.id,
    reason: reason.trim(),
    status: 'pending'
  })
  
  if (error) {
    showToast((t('detail.reportFailed') || 'Failed to report: ') + error.message)
    if (btn) btn.disabled = false
    return
  }
  
  showToast(t('detail.postReported') || 'Post reported to admins.')
  _goBack()
}

async function _loadComments(obsId) {
  const list = document.getElementById('comments-list')
  if (!list) return
  list.innerHTML = `<div style="color:var(--text-dim);font-size:12px;padding:8px 0">${t('common.loading')}</div>`

  const [{ data, error }, { data: blocks }] = await Promise.all([
    supabase.from('comments').select('id, body, created_at, user_id').eq('observation_id', obsId).order('created_at', { ascending: true }),
    supabase.from('user_blocks').select('blocked_id').eq('blocker_id', state.user?.id)
  ])

  if (error) {
    console.warn('Comment load failed:', error.message)
    list.innerHTML = `<div style="color:var(--text-dim);font-size:12px;padding:8px 0">${t('comments.couldNotLoad')}</div>`
    return
  }

  const blockedIds = new Set((blocks || []).map(b => b.blocked_id))
  const visibleComments = (data || []).filter(c => !blockedIds.has(c.user_id))

  if (!visibleComments?.length) {
    list.innerHTML = `<div style="color:var(--text-dim);font-size:12px;padding:8px 0">${t('comments.none')}</div>`
    return
  }

  const authorMap = await fetchCommentAuthorMap(visibleComments, state.user)

  list.innerHTML = visibleComments.map(c => {
    const { name, initial } = getCommentAuthor(authorMap[c.user_id])
    const date = formatDate(c.created_at, { day: 'numeric', month: 'short' })
    const isMe = c.user_id === state.user?.id
    const modHtml = !isMe ? `
      <div style="margin-left:auto; display:flex; gap:8px;">
        <button class="comment-report-btn" data-uid="${c.user_id}" data-cid="${c.id}" style="background:none; border:none; color:var(--amber); font-size:11px; cursor:pointer;">Report</button>
        <button class="comment-block-btn" data-uid="${c.user_id}" style="background:none; border:none; color:var(--red); font-size:11px; cursor:pointer;">Block</button>
      </div>
    ` : ''

    return `<div class="comment-row">
      <div class="comment-avatar">${_esc(initial)}</div>
      <div class="comment-body-wrap">
        <div class="comment-meta">
          <span class="comment-author">${_esc(name)}</span>
          <span class="comment-date">${date}</span>
          ${modHtml}
        </div>
        <div class="comment-text">${_esc(c.body)}</div>
      </div>
    </div>`
  }).join('')

  list.querySelectorAll('.comment-report-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const reason = prompt(t('comments.reportReason') || 'Why are you reporting this comment?')
      if (!reason) return
      const uid = btn.dataset.uid
      const cid = btn.dataset.cid
      const { error } = await supabase.from('reports').insert({
        reporter_id: state.user.id,
        reported_user_id: uid,
        comment_id: cid,
        observation_id: obsId,
        reason: reason.trim(),
        status: 'pending'
      })
      if (error) {
        showToast((t('comments.reportFailed') || 'Failed to report: ') + error.message)
        return
      }
      showToast(t('comments.commentReported') || 'Comment reported.')
    })
  })

  list.querySelectorAll('.comment-block-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(t('comments.blockConfirm') || 'Block this user?')) return
      const uid = btn.dataset.uid
      const { error } = await supabase.from('user_blocks').insert({
        blocker_id: state.user.id,
        blocked_id: uid
      })
      if (error && error.code !== '23505') {
        showToast((t('comments.blockFailed') || 'Failed to block: ') + error.message)
        return
      }
      showToast(t('comments.userBlocked') || 'User blocked.')
      _loadComments(obsId)
      loadFinds()
      refreshHome()
    })
  })
}

function _initMentions(input) {
  const container = input.parentElement
  const dropdown = document.createElement('ul')
  dropdown.className = 'mention-dropdown'
  dropdown.style.display = 'none'
  container.style.position = 'relative'
  container.appendChild(dropdown)

  let mentionStart = -1
  let mentionDebounce = null

  input.addEventListener('input', () => {
    const val = input.value
    const caret = input.selectionStart
    const textBefore = val.slice(0, caret)
    const match = textBefore.match(/@(\w*)$/)
    if (match) {
      mentionStart = textBefore.lastIndexOf('@')
      const query = match[1]
      clearTimeout(mentionDebounce)
      mentionDebounce = setTimeout(() => _searchMentions(query, dropdown, input, mentionStart), 200)
    } else {
      mentionStart = -1
      dropdown.style.display = 'none'
      dropdown.innerHTML = ''
    }
  })

  input.addEventListener('blur', () => {
    setTimeout(() => { dropdown.style.display = 'none' }, 200)
  })
}

async function _searchMentions(query, dropdown, input, mentionStart) {
  if (query.length < 1) { dropdown.style.display = 'none'; return }
  const { data } = await supabase
    .from('profiles')
    .select('id, username, full_name')
    .ilike('username', `${query}%`)
    .limit(5)
  if (!data?.length) { dropdown.style.display = 'none'; return }

  dropdown.innerHTML = data.map((u, i) =>
    `<li data-idx="${i}" data-username="${u.username}">@${u.username}${u.full_name ? ` · ${u.full_name}` : ''}</li>`
  ).join('')
  dropdown.style.display = 'block'
  dropdown._users = data

  dropdown.querySelectorAll('li').forEach(li => {
    li.addEventListener('mousedown', e => {
      e.preventDefault()
      const username = li.dataset.username
      const before = input.value.slice(0, mentionStart)
      const after = input.value.slice(input.selectionStart)
      input.value = before + '@' + username + ' ' + after
      dropdown.style.display = 'none'
      input.focus()
    })
  })
}

async function _sendComment() {
  const input = document.getElementById('comment-input')
  const body = input.value.trim()
  if (!body || !currentObs) return
  const btn = document.getElementById('comment-send-btn')
  btn.disabled = true

  // Extract @mentions and look up user IDs
  const mentionedUsernames = [...body.matchAll(/@(\w+)/g)].map(m => m[1])
  let mentionedUserIds = []
  if (mentionedUsernames.length) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, username')
      .in('username', mentionedUsernames)
    mentionedUserIds = (profiles || []).map(p => p.id)
  }

  let { error } = await supabase.from('comments').insert({
    observation_id: currentObs.id,
    user_id: state.user.id,
    body,
    mentioned_user_ids: mentionedUserIds.length ? mentionedUserIds : null,
  })
  // Fallback: column may not exist yet — retry without it
  if (error?.message?.includes('mentioned_user_ids')) {
    ;({ error } = await supabase.from('comments').insert({
      observation_id: currentObs.id,
      user_id: state.user.id,
      body,
    }))
  }
  btn.disabled = false
  if (error) { showToast(t('comments.postFailed', { message: error.message })); return }
  input.value = ''
  showToast(t('comments.posted'))
  _loadComments(currentObs.id)

}

async function _openCameraForDetail() {
  if (isAndroidNativeApp()) {
    try {
      if (getUseSystemCamera()) {
        const result = await NativeCamera.openSystemCamera()
        const photos = Array.isArray(result?.photos) ? result.photos : []
        if (!photos.length) return

        _setProgress(0, photos.length, t('import.readingFiles'))
        const files = []
        for (let i = 0; i < photos.length; i++) {
          _setProgress(i, photos.length, t('import.importingFile', { current: i + 1, total: photos.length }))
          files.push(await nativePickedPhotoToFile(photos[i], i))
        }
        await _addPhotosToObservation(files)
        return
      }

      const { value: useHdrStr } = await Preferences.get({ key: 'useHdr' })
      const useHdr = useHdrStr !== 'false'
      const gps = state.gps && Number.isFinite(state.gps.lat) && Number.isFinite(state.gps.lon)
        ? { latitude: state.gps.lat, longitude: state.gps.lon, altitude: state.gps.altitude, accuracy: state.gps.accuracy }
        : null
      const options = { useHdr, jpegQuality: NATIVE_CAMERA_JPEG_QUALITY }
      if (gps) options.gps = gps
      const result = await NativeCamera.capturePhotos(options)
      const photos = Array.isArray(result?.photos) ? result.photos : []
      if (!photos.length) return

      _setProgress(0, photos.length, t('import.readingFiles'))
      const files = []
      for (let i = 0; i < photos.length; i++) {
        _setProgress(i, photos.length, t('import.importingFile', { current: i + 1, total: photos.length }))
        files.push(await nativePickedPhotoToFile(photos[i], i))
      }
      await _addPhotosToObservation(files)
    } catch (err) {
      if (isPickerCancel(err)) return
      showToast(`Sporely Cam: ${err?.message || err}`)
      _hideProgress()
    }
  } else {
    setCaptureCompleteHandler(async photos => {
      const files = []
      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i]
        const blob = photo?.blob || await photo?.blobPromise
        if (!blob) continue
        files.push(new File(
          [blob],
          `sporely-capture-${i + 1}.${imageExtensionForBlob(blob)}`,
          { type: blob.type || 'image/jpeg', lastModified: photo?.ts?.getTime?.() || Date.now() }
        ))
      }
      if (!files.length) {
        if (currentObs?.id) await openFindDetail(currentObs.id)
        return
      }
      await _addPhotosToObservation(files)
    })
    navigate('capture')
  }
}

async function _openPickerForDetail() {
  if (isAndroidNativeApp()) {
    try {
      const result = await pickImagesWithNativePhotoPicker()
      const photos = Array.isArray(result?.photos) ? result.photos : []
      if (!photos.length) return
      _setProgress(0, photos.length, t('import.readingFiles'))
      const files = []
      for (let i = 0; i < photos.length; i++) {
        _setProgress(i, photos.length, t('import.importingFile', { current: i + 1, total: photos.length }))
        files.push(await nativePickedPhotoToFile(photos[i], i))
      }
      await _addPhotosToObservation(files)
      return
    } catch (err) {
      if (isPickerCancel(err)) return
      _hideProgress()
    }
  }

  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = 'image/*'
  if (/android/i.test(navigator.userAgent)) {
    input.accept = '.jpg,.jpeg,.png,.webp,.avif,.heic,.heif,image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif'
  }
  input.onchange = async (e) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    await _addPhotosToObservation(files)
  }
  input.click()
}

async function _addPhotosToObservation(files) {
  if (!currentObs || !files.length) return

  const obsId = currentObs.id
  const userId = currentObs.user_id

  _setProgress(0, files.length, `Adding ${files.length} photo(s)...`)
  const saveBtn = document.getElementById('detail-save-btn')
  if (saveBtn) saveBtn.disabled = true

  try {
    const { data: existingImages } = await supabase
      .from('observation_images')
      .select('sort_order')
      .eq('observation_id', obsId)
      .order('sort_order', { ascending: false })
      .limit(1)

    let nextSortOrder = 0
    if (existingImages?.length) {
      nextSortOrder = (existingImages[0].sort_order || 0) + 1
    }

    const uploadPolicy = await fetchCloudPlanProfile(userId)

    for (let i = 0; i < files.length; i++) {
      _setProgress(i, files.length, `Uploading ${i + 1} of ${files.length}...`)
      const file = files[i]
      const sortOrder = nextSortOrder + i

      const preparedImage = await prepareImageVariants(file, uploadPolicy)
      const storagePath = `${userId}/${obsId}/${sortOrder}_${Date.now()}.${imageExtensionForBlob(preparedImage.uploadBlob)}`
      await uploadPreparedObservationImageVariants(preparedImage, storagePath, { uploadPolicy })
      
      try {
        const cropMeta = await createImageCropMeta(preparedImage.uploadBlob, { preseed: true })
        await insertObservationImage({
          observation_id: obsId,
          user_id: userId,
          storage_path: storagePath,
          image_type: 'field',
          sort_order: sortOrder,
          ...preparedImage.uploadMeta,
          ...cropMeta,
        })
      } catch (err) {
        await deleteObservationMedia([storagePath]).catch(() => {})
        throw err
      }

      if (sortOrder === 0) {
        await syncObservationMediaKeys(obsId, storagePath, { sortOrder: 0 })
      }

      const { data: insertedRows } = await supabase
        .from('observation_images')
        .select('id, storage_path, sort_order, image_type, ai_crop_x1, ai_crop_y1, ai_crop_x2, ai_crop_y2')
        .eq('observation_id', obsId)
        .eq('sort_order', sortOrder)
        .order('id', { ascending: false })
        .limit(1)
      const insertedRow = insertedRows?.[0] || {
        id: `new-${sortOrder}-${Date.now()}`,
        storage_path: storagePath,
        sort_order: sortOrder,
        image_type: 'field',
        ai_crop_x1: cropMeta.aiCropRect?.x1 ?? null,
        ai_crop_y1: cropMeta.aiCropRect?.y1 ?? null,
        ai_crop_x2: cropMeta.aiCropRect?.x2 ?? null,
        ai_crop_y2: cropMeta.aiCropRect?.y2 ?? null,
      }
      const [originalSource] = await resolveMediaSources([storagePath], { variant: 'original' })
      const [displaySource] = await resolveMediaSources([storagePath], { variant: 'medium' })
      _appendDetailGalleryImage(insertedRow, displaySource, displaySource, { originalSource })
    }

    showToast(`${files.length} photo(s) added.`)
  } catch (err) {
    console.error('Failed to add photos to observation:', err)
    showToast(`Error adding photos: ${err.message}`)
  } finally {
    _hideProgress()
    if (saveBtn) saveBtn.disabled = false
  }
}

function _setProgress(done, total, label) {
  const overlay = document.getElementById('import-progress')
  if (!overlay) return
  overlay.style.display = 'flex'
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  document.getElementById('import-progress-fill').style.width = pct + '%'
  document.getElementById('import-progress-label').textContent = label || t('import.processing')
}

function _hideProgress() {
  const overlay = document.getElementById('import-progress')
  if (overlay) overlay.style.display = 'none'
}

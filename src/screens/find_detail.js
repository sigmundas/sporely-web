import { supabase } from '../supabase.js'
import { formatDate, formatTime, getTaxonomyLanguage, t } from '../i18n.js'
import { state } from '../state.js'
import { navigate, goBack } from '../router.js'
import { showToast } from '../toast.js'
import { searchTaxa, formatDisplayName, runArtsorakelForBlobs, runArtsorakelForMediaKeys, isArtsorakelNetworkError } from '../artsorakel.js'
import { fetchCommentAuthorMap, getCommentAuthor } from '../comments.js'
import { deleteObservationMedia, downloadObservationImageBlob, resolveMediaSources, updateObservationImageCrop } from '../images.js'
import { loadFinds, openFinds } from './finds.js'
import { openPhotoViewer } from '../photo-viewer.js'
import { openAiCropEditor } from '../ai-crop-editor.js'
import { normalizeAiCropRect } from '../image_crop.js'
import { esc as _esc } from '../esc.js'
import { getDefaultVisibility, setLastSyncAt } from '../settings.js'
import { refreshHome } from './home.js'
import { buildGpsMetaHtml } from './review.js'
import { lookupCoordinateKey, lookupReverseLocation } from '../location-lookup.js'

let currentObs    = null
let selectedTaxon = null
let currentObsIsOwner = false
let returnScreenOverride = null
let hideCancelOverride = false
let detailLocationSuggestions = []
let detailLocationLookupKey = ''
let detailLocationAutoApplied = ''

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

  document.getElementById('detail-ai-btn').addEventListener('click', _runAI)
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

  const { data: obs, error } = await supabase
    .from('observations')
    .select('id, user_id, date, captured_at, genus, species, common_name, location, habitat, notes, uncertain, gps_latitude, gps_longitude, gps_altitude, gps_accuracy, visibility')
    .eq('id', obsId)
    .single()

  if (error || !obs) {
    showToast(t('detail.couldNotLoadObservation'))
    navigate('finds')
    return
  }

  currentObs = obs
  currentObsIsOwner = obs.user_id === state.user?.id
  _applyOwnershipMode(currentObsIsOwner)

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
  const vis = obs.visibility || 'friends'
  const visRadio = document.querySelector(`input[name="detail-vis"][value="${vis}"]`)
  if (visRadio) visRadio.checked = true

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

  if (imgData?.length) {
    const sources = await resolveMediaSources(imgData.map(i => i.storage_path), { variant: 'original' })
    const aiSources = await resolveMediaSources(imgData.map(i => i.storage_path), { variant: 'medium' })

    sources.forEach((source, index) => {
      if (!source?.primaryUrl && !source?.fallbackUrl) return
      
      const row = imgData[index]
      const isMicroscope = (row?.image_type || 'field') === 'microscope'

      const container = document.createElement('div')
      container.className = 'detail-gallery-item-wrap'
      
      const img = document.createElement('img')
      const aiSource = aiSources[index] || null
      img.className = 'detail-gallery-img'
      img.src       = source.primaryUrl || source.fallbackUrl
      img.loading   = 'lazy'
      img.alt       = ''
      img.dataset.storagePath = row.storage_path || ''
      img.dataset.aiSrc = aiSource?.primaryUrl || aiSource?.fallbackUrl || img.src
      img.dataset.aiFallback = source.fallbackUrl || source.primaryUrl || img.src
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
        openPhotoViewer(galleryImgs.map(i => i.src), index)
      })

      container.appendChild(img)

      if (currentObsIsOwner) {
        if (!isMicroscope) {
          const cropBtn = document.createElement('button')
          cropBtn.className = 'detail-overlay-btn detail-overlay-crop'
          cropBtn.textContent = 'AI crop'
          cropBtn.addEventListener('click', (e) => {
            e.stopPropagation()
            openAiCropEditor({
              title: t('crop.editorTitle'),
              startIndex: index,
              images: imgData.map((r, i) => ({
                url: sources[i]?.primaryUrl || sources[i]?.fallbackUrl || '',
                aiCropRect: normalizeAiCropRect({
                  x1: r.ai_crop_x1, y1: r.ai_crop_y1,
                  x2: r.ai_crop_x2, y2: r.ai_crop_y2,
                }),
              })),
              onChange: (idx, meta) => {
                const r = imgData[idx]
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
            openFindDetail(currentObs.id)
          } catch (err) {
            console.error('Failed to delete image:', err)
            showToast(err.message)
            delBtn.disabled = false
          }
        })
        container.appendChild(delBtn)
      }

      gallery.appendChild(container)
    })
  }

  // Load comments async (don't await)
  _loadComments(obsId)
}

async function _runAI() {
  const btn       = document.getElementById('detail-ai-btn')
  const resultsEl = document.getElementById('detail-ai-results')
  const galleryImgs = Array.from(document.querySelectorAll('#detail-gallery img'))
  if (!galleryImgs.length) { showToast(t('detail.noPhotoToIdentify')); return }

  btn.disabled = true
  btn.innerHTML = `<div class="ai-dot"></div> ${t('review.identifying')}`
  resultsEl.style.display = 'none'

  try {
    async function fetchAiBlobForImage(img) {
      try {
        return await downloadObservationImageBlob(img.dataset.storagePath, { variant: 'medium' })
      } catch (storageError) {
        const urls = [
          img.dataset.aiFallback || '',
          img.dataset.aiSrc || '',
          img.src || '',
        ].filter(Boolean)

        let lastError = storageError
        for (const url of urls) {
          try {
            const resp = await fetch(url)
            if (!resp.ok) throw new Error(`Image fetch failed: ${resp.status}`)
            return await resp.blob()
          } catch (error) {
            lastError = error
          }
        }
        throw lastError || new Error('Image fetch failed')
      }
    }

    const blobResults = await Promise.allSettled(
      galleryImgs.map(fetchAiBlobForImage)
    )
    const blobs = blobResults
      .filter(result => result.status === 'fulfilled' && result.value instanceof Blob)
      .map(result => result.value)
    const mediaKeys = galleryImgs
      .map(img => img.dataset.storagePath || '')
      .filter(Boolean)

    let predictions = null
    if (blobs.length) {
      predictions = await runArtsorakelForBlobs(blobs, getTaxonomyLanguage(), { tolerateFailures: true })
    } else if (mediaKeys.length) {
      console.warn('Artsorakel image download failed for existing observation:', blobResults)
      predictions = await runArtsorakelForMediaKeys(mediaKeys, getTaxonomyLanguage(), { variant: 'medium' })
    } else {
      throw new Error('Could not load observation images for Artsorakel')
    }

    if (!predictions?.length) {
      showToast(t('review.noMatch'))
      return
    }

    resultsEl.innerHTML = predictions.map((p, i) =>
      `<div class="ai-result" data-idx="${i}">
        <span class="ai-prob">${Math.round(p.probability * 100)}%</span>
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
    if (isArtsorakelNetworkError(err) || message.includes('CORS')) {
      showToast(t('review.aiUnavailable'))
    } else {
      showToast(t('common.artsorakelError', { message }))
    }
    console.warn('Artsorakel detail error:', err)
  } finally {
    btn.disabled = false
    btn.innerHTML = `<div class="ai-dot"></div> ${t('detail.identifyAI')}`
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
  const r = document.querySelector(`input[name="detail-vis"][value="${getDefaultVisibility()}"]`)
  if (r) r.checked = true

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
    item.addEventListener('mousedown', event => {
      event.preventDefault()
      const name = detailLocationSuggestions[index] || ''
      input.value = name
      detailLocationAutoApplied = name
      dropdown.style.display = 'none'
    })
  })
}

function _applyOwnershipMode(isOwner) {
  const readonlyNote = document.getElementById('detail-readonly-note')
  const saveBtn = document.getElementById('detail-save-btn')
  const deleteBtn = document.getElementById('detail-delete-btn')
  const aiBtn = document.getElementById('detail-ai-btn')
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
  if (aiBtn) aiBtn.disabled = !isOwner
  if (taxonInput) taxonInput.disabled = !isOwner
  if (locationInput) locationInput.readOnly = !isOwner
  if (habitatInput) habitatInput.readOnly = !isOwner
  if (notesInput) notesInput.readOnly = !isOwner
  if (uncertainInput) uncertainInput.disabled = !isOwner

  const currentLocationBtn = document.getElementById('detail-current-location-btn')
  if (currentLocationBtn) currentLocationBtn.style.display = 'none'

  document.querySelectorAll('input[name="detail-vis"]').forEach(radio => {
    radio.disabled = !isOwner
  })

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

  commonEl.textContent = markedPrimary
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
    visibility: document.querySelector('input[name="detail-vis"]:checked')?.value || 'friends',
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

  const { error } = await supabase
    .from('observations')
    .update(patch)
    .eq('id', currentObs.id)
    .eq('user_id', state.user.id)

  btn.disabled = false

  if (error) {
    showToast(t('detail.saveFailed', { message: error.message }))
    return
  }

  setLastSyncAt()
  showToast(t('detail.saved'))
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

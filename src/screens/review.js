import { supabase } from '../supabase.js'
import { state } from '../state.js'
import { navigate } from '../router.js'
import { showToast } from '../toast.js'
import { searchTaxa, runArtsorakel, formatDisplayName } from '../artsorakel.js'
import { initLocationField, startLocationLookup, getLocationName, resetLocationState } from '../location.js'
import { refreshHome } from './home.js'

export function initReview() {
  document.getElementById('review-close')
    .addEventListener('click', () => navigate('home'))
  document.getElementById('add-photo-btn').addEventListener('click', () => navigate('capture'))
  document.getElementById('save-draft-btn').addEventListener('click', saveDraft)
  document.getElementById('finish-sync-btn').addEventListener('click', finishAndSync)
  initLocationField()
}

// ── Grid build ────────────────────────────────────────────────────────────────

export function buildReviewGrid() {
  const photos = state.capturedPhotos
  const count  = photos.length

  // title stays "New observation" — count shown via card carousel

  if (state.sessionStart) {
    const fmt = t => t.toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' })
    document.getElementById('review-time').textContent =
      `Captured ${fmt(state.sessionStart)} — ${fmt(new Date())}`
  }

  if (state.gps) {
    document.getElementById('review-coords-text').textContent =
      `${state.gps.lat.toFixed(4)}° N, ${state.gps.lon.toFixed(4)}° E`
    document.getElementById('meta-accuracy').textContent =
      `± ${Math.round(state.gps.accuracy)} m`
    if (state.gps.altitude)
      document.getElementById('meta-altitude').textContent =
        `${Math.round(state.gps.altitude)} m ASL`
    document.getElementById('review-location').textContent =
      `${state.gps.lat.toFixed(3)}° N, ${state.gps.lon.toFixed(3)}° E`
    startLocationLookup(state.gps.lat, state.gps.lon)
  }

  const grid = document.getElementById('specimen-grid')
  let html = ''

  if (count === 0) {
    html = `<div class="specimen-card" style="opacity:0.4;pointer-events:none">
      <div class="specimen-photo" style="aspect-ratio:1;display:flex;align-items:center;justify-content:center;font-size:32px">📷</div>
      <div class="specimen-info"><div class="specimen-name" style="font-style:normal;font-size:12px;color:var(--text-dim)">No captures yet</div></div>
    </div>`
  } else {
    photos.forEach((p, i) => {
      const t   = p.ts ? p.ts.toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' }) : '—'
      const gps = p.gps ? `${p.gps.lat.toFixed(3)}° N` : 'No GPS'
      const hasBlob = p.blobPromise || (p.blob instanceof Blob)
      const displayName = p.taxon
        ? formatDisplayName(p.taxon.genus, p.taxon.specificEpithet, p.taxon.vernacularName)
        : ''

      html += `<div class="specimen-card" data-idx="${i}">
        <div class="specimen-photo" id="specimen-photo-${i}">
          <div class="specimen-precision"></div>
          <span class="specimen-emoji" style="font-size:36px">${p.emoji || '🍄'}</span>
        </div>
        <div class="specimen-info">
          <div class="taxon-field-wrap">
            <input
              class="taxon-input"
              type="text"
              placeholder="Unknown species"
              value="${displayName}"
              data-idx="${i}"
              autocomplete="off"
              spellcheck="false"
            />
            <ul class="taxon-dropdown" data-idx="${i}" style="display:none"></ul>
          </div>
          ${hasBlob ? `<button class="artsorakel-btn" data-idx="${i}">Artsorakel</button>` : ''}
          <div class="artsorakel-results" data-idx="${i}" style="display:none"></div>
          <div class="specimen-meta">${t} · ${gps}</div>
        </div>
      </div>`
    })
  }

  grid.innerHTML = html

  wireCardEvents()
  loadThumbnails(photos)
}

function loadThumbnails(photos) {
  photos.forEach(async (p, i) => {
    const container = document.getElementById(`specimen-photo-${i}`)
    if (!container) return

    let blob = p.blob instanceof Blob ? p.blob : null
    if (!blob && p.blobPromise) blob = await p.blobPromise

    if (!(blob instanceof Blob)) return

    const url = URL.createObjectURL(blob)
    const img = document.createElement('img')
    img.src = url
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;inset:0;border-radius:8px 8px 0 0'
    img.onload = () => {
      const emoji = container.querySelector('.specimen-emoji')
      if (emoji) emoji.style.display = 'none'
      container.appendChild(img)
    }
  })
}

// ── Per-card event wiring ─────────────────────────────────────────────────────

function wireCardEvents() {
  // Artsorakel buttons
  document.querySelectorAll('.artsorakel-btn').forEach(btn => {
    btn.addEventListener('click', () => handleArtsorakelBtn(Number(btn.dataset.idx)))
  })

  // Taxon autocomplete inputs
  document.querySelectorAll('.taxon-input').forEach(input => {
    let debounce
    input.addEventListener('input', () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => handleTaxonInput(input), 280)
    })
    input.addEventListener('blur', () => {
      // Delay hide so click on dropdown item registers
      setTimeout(() => hideDropdown(Number(input.dataset.idx)), 200)
    })
  })
}

async function handleTaxonInput(input) {
  const i   = Number(input.dataset.idx)
  const q   = input.value.trim()
  const ul  = document.querySelector(`.taxon-dropdown[data-idx="${i}"]`)
  if (!ul) return

  if (q.length < 2) { ul.style.display = 'none'; return }

  const results = await searchTaxa(q, 'no')
  if (!results.length) { ul.style.display = 'none'; return }

  ul.innerHTML = results.map(r =>
    `<li data-idx="${i}" data-taxon='${JSON.stringify(r).replace(/'/g, '&#39;')}'>
      ${r.displayName}
      <span class="taxon-family">${r.family || ''}</span>
    </li>`
  ).join('')
  ul.style.display = 'block'

  ul.querySelectorAll('li').forEach(li => {
    li.addEventListener('mousedown', () => {
      const taxon = JSON.parse(li.dataset.taxon)
      applyTaxon(i, taxon)
    })
  })
}

function hideDropdown(i) {
  const ul = document.querySelector(`.taxon-dropdown[data-idx="${i}"]`)
  if (ul) ul.style.display = 'none'
}

function applyTaxon(i, taxon) {
  state.capturedPhotos[i].taxon = taxon
  const input = document.querySelector(`.taxon-input[data-idx="${i}"]`)
  if (input) input.value = taxon.displayName
  hideDropdown(i)
}

// ── Artsorakel AI ─────────────────────────────────────────────────────────────

async function resolveBlob(photo) {
  if (photo.blob instanceof Blob) return photo.blob
  if (photo.blobPromise) return photo.blobPromise
  return null
}

async function handleArtsorakelBtn(i) {
  const btn = document.querySelector(`.artsorakel-btn[data-idx="${i}"]`)
  const resultsEl = document.querySelector(`.artsorakel-results[data-idx="${i}"]`)
  if (!btn || !resultsEl) return

  btn.disabled = true
  btn.textContent = 'Identifying…'
  resultsEl.style.display = 'none'

  try {
    const blob = await resolveBlob(state.capturedPhotos[i])
    const predictions = await runArtsorakel(blob, 'no')

    if (!predictions || predictions.length === 0) {
      showToast('No match found')
      return
    }

    resultsEl.innerHTML = predictions.map((p, pi) =>
      `<div class="ai-result" data-pi="${pi}" data-idx="${i}" data-taxon='${JSON.stringify(p).replace(/'/g, '&#39;')}'>
        <span class="ai-prob">${Math.round(p.probability * 100)}%</span>
        <span class="ai-name">${p.displayName}</span>
      </div>`
    ).join('')
    resultsEl.style.display = 'block'

    resultsEl.querySelectorAll('.ai-result').forEach(el => {
      el.addEventListener('click', () => {
        const pred = JSON.parse(el.dataset.taxon)
        // Map AI result to a taxon-shaped object
        const parts = (pred.scientificName || '').split(/\s+/)
        const taxon = {
          genus:           parts[0] || '',
          specificEpithet: parts[1] || '',
          vernacularName:  pred.vernacularName || null,
          scientificName:  pred.scientificName || null,
          displayName:     pred.displayName,
        }
        applyTaxon(i, taxon)
        resultsEl.style.display = 'none'
      })
    })
  } catch (err) {
    if (err.message.includes('CORS') || err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
      showToast('Artsorakel unavailable — CORS blocked. Needs a proxy.')
    } else {
      showToast(`Artsorakel: ${err.message}`)
    }
    console.warn('Artsorakel error:', err)
  } finally {
    btn.disabled = false
    btn.textContent = 'Artsorakel'
  }
}

async function runAllArtsorakel() {
  const count = state.capturedPhotos.length
  if (!count) { showToast('No photos to identify'); return }
  showToast(`Running Artsorakel on ${count} photo${count !== 1 ? 's' : ''}…`)
  for (let i = 0; i < count; i++) {
    await handleArtsorakelBtn(i)
  }
}

// ── Draft / sync ──────────────────────────────────────────────────────────────

async function saveDraft() {
  showToast('Draft saved locally')
}

async function uploadBlob(blob, storagePath) {
  const { error } = await supabase.storage
    .from('observation-images')
    .upload(storagePath, blob, { contentType: 'image/jpeg', upsert: true })
  if (error) throw new Error(`Storage upload failed: ${error.message}`)
}

async function finishAndSync() {
  if (!state.user) { showToast('Not signed in'); return }
  if (!state.capturedPhotos.length) { showToast('No photos to sync'); return }

  const btn = document.getElementById('finish-sync-btn')
  btn.disabled = true
  showToast('Syncing to Sporely Cloud…')

  try {
    const photos = await Promise.all(
      state.capturedPhotos.map(async p => ({
        ...p,
        blob: p.blobPromise ? await p.blobPromise : (p.blob ?? null),
      }))
    )

    const visibility = document.querySelector('input[name="review-vis"]:checked')?.value || 'friends'

    for (const [i, photo] of photos.entries()) {
      const taxon = photo.taxon || {}
      const obsPayload = {
        user_id:       state.user.id,
        date:          (photo.ts || new Date()).toISOString().slice(0, 10),
        gps_latitude:  photo.gps?.lat  ?? null,
        gps_longitude: photo.gps?.lon  ?? null,
        location:      getLocationName() || null,
        source_type:   'personal',
        genus:         taxon.genus          || null,
        species:       taxon.specificEpithet|| null,
        common_name:   taxon.vernacularName || null,
        visibility,
      }

      const { data: obsData, error: obsError } = await supabase
        .from('observations')
        .insert(obsPayload)
        .select('id')
        .single()

      if (obsError) throw new Error(`Observation insert failed: ${obsError.message}`)
      const obsId = obsData.id

      if (photo.blob instanceof Blob) {
        const storagePath = `${state.user.id}/${obsId}/${i}_${Date.now()}.jpg`
        await uploadBlob(photo.blob, storagePath)

        const { error: imgError } = await supabase
          .from('observation_images')
          .insert({
            observation_id: obsId,
            user_id:        state.user.id,
            storage_path:   storagePath,
            image_type:     'field',
            sort_order:     0,
          })
        if (imgError) console.warn('Image metadata insert failed:', imgError.message)
      }
    }

    showToast(`Synced ${photos.length} observation${photos.length !== 1 ? 's' : ''} ✓`)
    state.capturedPhotos = []
    state.batchCount = 0
    resetLocationState()
    await refreshHome()
    setTimeout(() => navigate('home'), 800)
  } catch (err) {
    showToast(`Sync failed: ${err.message}`)
    console.error('Sync error:', err)
  } finally {
    btn.disabled = false
  }
}

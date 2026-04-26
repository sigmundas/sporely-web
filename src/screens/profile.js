import { supabase } from '../supabase.js'
import { formatDate, formatTime, t } from '../i18n.js'
import { state } from '../state.js'
import { showToast } from '../toast.js'
import { showAuthOverlay, switchToLogin } from './auth.js'
import { navigate } from '../router.js'
import { fetchCloudPlanProfile, formatStorageBytes } from '../cloud-plan.js'
import { getLastSyncAt } from '../settings.js'
import { Capacitor } from '@capacitor/core'
import { FilePicker } from '@capawesome/capacitor-file-picker'

// ── Init (once at boot) ───────────────────────────────────────────────────────

function _isNativeApp() {
  return !!window.Capacitor?.isNativePlatform?.() || ['android', 'ios'].includes(window.Capacitor?.getPlatform?.());
}

export function initProfile() {
  document.getElementById('profile-avatar-img').addEventListener('error', _showInitialsAvatar)
  document.getElementById('sign-out-btn').addEventListener('click', async () => {
    const btn = document.getElementById('sign-out-btn')
    const originalLabel = btn.textContent
    btn.disabled = true
    btn.textContent = t('common.pleaseWait')
    try { await supabase.auth.signOut() } catch (e) { console.warn('Sign out error:', e) }
    state.user = null
    showAuthOverlay()
    switchToLogin()
    navigate('home')
    btn.disabled = false
    btn.textContent = originalLabel
  })
  document.getElementById('delete-account-btn').addEventListener('click', _deleteAccount)
  document.getElementById('friend-search-btn').addEventListener('click', _searchFriend)
  document.getElementById('friend-search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') _searchFriend()
  })
  document.getElementById('profile-save-btn').addEventListener('click', _saveProfile)
  document.getElementById('profile-avatar-btn').addEventListener('click', _openAvatarSourcePicker)
  document.getElementById('profile-avatar-circle').addEventListener('click', _openAvatarSourcePicker)
  document.getElementById('avatar-source-overlay').addEventListener('click', e => {
    if (e.target?.id === 'avatar-source-overlay') _closeAvatarSourcePicker()
  })
  document.getElementById('avatar-source-library').addEventListener('click', () => {
    _closeAvatarSourcePicker()
    void _openAvatarLibraryPicker()
  })
  document.getElementById('avatar-source-selfie').addEventListener('click', () => {
    _closeAvatarSourcePicker()
    _openAvatarCameraPicker()
  })
  document.getElementById('avatar-source-cancel').addEventListener('click', _closeAvatarSourcePicker)
  document.getElementById('profile-avatar-input').addEventListener('change', e => {
    const file = e.target.files?.[0]
    if (file) void _showCrop(file)
    e.target.value = ''
  })
  document.getElementById('profile-avatar-camera-input').addEventListener('change', e => {
    const file = e.target.files?.[0]
    if (file) void _showCrop(file)
    e.target.value = ''
  })
  _initCropEvents()

  document.getElementById('profile-tos-btn')?.addEventListener('click', () => {
    window.open('https://sporely.no/terms', '_blank')
  })
}

// ── Load (called on navigate to profile) ─────────────────────────────────────

export async function loadProfile() {
  await Promise.all([_loadProfileData(), _loadFriends(), _loadPending()])
}

export async function refreshHeaderProfileButtons(profile = null) {
  const uid = state.user?.id
  if (!uid) return

  let summary = profile
  if (!summary) {
    const { data } = await supabase
      .from('profiles')
      .select('username, display_name, avatar_url')
      .eq('id', uid)
      .single()
    summary = data || {}
  }

  const initials = _initials(summary?.username || state.user?.email || '')
  const avatarUrl = summary?.avatar_url || ''
  const targets = [
    ['home-profile-img', 'home-profile-initials'],
    ['finds-profile-img', 'finds-profile-initials'],
    ['map-profile-img', 'map-profile-initials'],
    ['people-profile-img', 'people-profile-initials'],
  ]

  for (const [imgId, initialsId] of targets) {
    const img = document.getElementById(imgId)
    const label = document.getElementById(initialsId)
    if (!img || !label) continue

    label.textContent = initials
    if (avatarUrl && await _canLoadImage(avatarUrl)) {
      img.src = avatarUrl
      img.style.display = 'block'
      label.style.display = 'none'
    } else {
      img.style.display = 'none'
      img.removeAttribute('src')
      label.style.display = ''
    }
  }
}


// ── Profile data (username, full_name, avatar) ────────────────────────────────

async function _loadProfileData() {
  const uid = state.user?.id
  if (!uid) return
  const { data } = await supabase
    .from('profiles')
    .select('username, display_name, bio, avatar_url')
    .eq('id', uid)
    .single()
  state.cloudPlan = await fetchCloudPlanProfile(uid)
  if (!data) {
    _renderCloudPlan(state.cloudPlan)
    return
  }


  document.getElementById('profile-username').value  = data.username     || ''
  document.getElementById('profile-fullname').value  = data.display_name || ''
  document.getElementById('profile-bio').value = data.bio || ''
  document.getElementById('profile-email-display').textContent = state.user?.email || ''
  const initials = _initials(data.username || state.user?.email || '')
  document.getElementById('profile-avatar-initials').textContent = initials
  await refreshHeaderProfileButtons(data)
  if (data.avatar_url) {
    const shown = await _setProfileAvatarSource({ uid, preferredUrl: data.avatar_url })
    if (shown) {
      _renderCloudPlan(state.cloudPlan)
      return
    }
  }
  _showInitialsAvatar()
  _renderCloudPlan(state.cloudPlan)
}

async function _saveProfile() {
  const btn = document.getElementById('profile-save-btn')
  btn.disabled = true
  const username     = document.getElementById('profile-username').value.trim().replace(/^@/, '') || null
  const display_name = document.getElementById('profile-fullname').value.trim() || null
  const bio = document.getElementById('profile-bio').value.trim() || null
  const { error } = await supabase.from('profiles').update({ username, display_name, bio }).eq('id', state.user.id)
  btn.disabled = false
  if (error) {
    showToast(error.code === '23505' ? t('profile.usernameTaken') : t('common.errorPrefix', { message: error.message }))
    return
  }
  await refreshHeaderProfileButtons({ username, display_name, avatar_url: document.getElementById('profile-avatar-img')?.getAttribute('src') || '' })
  showToast(t('profile.saved'))
}

// ── Avatar crop ────────────────────────────────────────────────────────────────

const CROP_OUTPUT = 400
let _cropScale = 1, _cropX = 0, _cropY = 0
let _cropBaseScale = 1, _cropViewSize = 0
let _pointers = new Map(), _lastPinchDist = 0, _lastPinchScale = 1
let _dragStartX = 0, _dragStartY = 0, _dragStartCropX = 0, _dragStartCropY = 0
let _cropShowing = false

function _openAvatarSourcePicker() {
  document.getElementById('avatar-source-overlay').style.display = 'flex'
}

function _closeAvatarSourcePicker() {
  document.getElementById('avatar-source-overlay').style.display = 'none'
}

async function _openAvatarLibraryPicker() {
  if (_isNativeApp()) {
    try {
      await FilePicker.requestPermissions()
      const result = await FilePicker.pickImages({ multiple: false, readData: false })
      const photo = result?.files?.[0]
      if (!photo) return

      let path = photo.path
      let mimeType = photo.mimeType || 'image/jpeg'
      if (mimeType === 'image/heic' || mimeType === 'image/heif' || photo.format === 'heic' || photo.format === 'heif') {
        try {
          if (window.Capacitor?.Plugins?.FilePicker?.convertHeicToJpeg) {
            const converted = await FilePicker.convertHeicToJpeg({ path })
            path = converted.path
            mimeType = 'image/jpeg'
          }
        } catch (error) {
          console.warn('Native HEIC conversion failed:', error)
        }
      }

      const response = await fetch(Capacitor.convertFileSrc(path))
      const blob = await response.blob()
      await _showCrop(new File([blob], photo.name || 'avatar.jpg', { type: mimeType }))
      return
    } catch (error) {
      console.warn('Native avatar picker failed, falling back to browser input:', error)
    }
  }

  document.getElementById('profile-avatar-input').click()
}

function _openAvatarCameraPicker() {
  document.getElementById('profile-avatar-camera-input').click()
}

async function _showCrop(file) {
  const img = document.getElementById('avatar-crop-img')
  const confirmBtn = document.getElementById('avatar-crop-confirm')
  _resetCropPreview()
  _cropShowing = true
  document.getElementById('avatar-crop-overlay').style.display = 'flex'
  confirmBtn.disabled = true
  img.style.width = img.style.height = img.style.left = img.style.top = ''

  try {
    const dataUrl = await _readFileAsDataUrl(file)
    await new Promise((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('avatar-preview-load-failed'))
      img.src = dataUrl
    })
  } catch (error) {
    console.warn('Avatar crop load failed:', error)
    _closeCropOverlay()
    showToast(t('avatar.loadFailed'))
    return
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const vp = document.getElementById('avatar-crop-viewport')
      _cropViewSize = vp.offsetWidth || Math.min(window.innerWidth * 0.92, 380)
      const { naturalWidth: nw, naturalHeight: nh } = img
      _cropBaseScale = _cropViewSize / Math.min(nw, nh)
      _cropScale = 1
      _cropX = 0
      _cropY = 0
      _applyCrop()
      confirmBtn.disabled = false
    })
  })
}

function _applyCrop() {
  const img = document.getElementById('avatar-crop-img')
  const { naturalWidth: nw, naturalHeight: nh } = img
  const eff = _cropBaseScale * _cropScale
  const dw = nw * eff, dh = nh * eff
  const vs = _cropViewSize
  const maxX = Math.max(0, dw / 2 - vs / 2)
  const maxY = Math.max(0, dh / 2 - vs / 2)
  _cropX = Math.max(-maxX, Math.min(maxX, _cropX))
  _cropY = Math.max(-maxY, Math.min(maxY, _cropY))
  img.style.width  = dw + 'px'
  img.style.height = dh + 'px'
  img.style.left   = (vs / 2 + _cropX - dw / 2) + 'px'
  img.style.top    = (vs / 2 + _cropY - dh / 2) + 'px'
}

function _initCropEvents() {
  const vp = document.getElementById('avatar-crop-viewport')

  vp.addEventListener('pointerdown', e => {
    e.preventDefault()
    vp.setPointerCapture(e.pointerId)
    _pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (_pointers.size === 1) {
      _dragStartX = e.clientX; _dragStartY = e.clientY
      _dragStartCropX = _cropX; _dragStartCropY = _cropY
    }
    if (_pointers.size === 2) {
      const pts = [..._pointers.values()]
      _lastPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
      _lastPinchScale = _cropScale
    }
  })

  vp.addEventListener('pointermove', e => {
    if (!_pointers.has(e.pointerId)) return
    _pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const pts = [..._pointers.values()]
    if (pts.length === 1) {
      _cropX = _dragStartCropX + (e.clientX - _dragStartX)
      _cropY = _dragStartCropY + (e.clientY - _dragStartY)
    } else if (pts.length === 2) {
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
      _cropScale = Math.max(1, _lastPinchScale * (dist / _lastPinchDist))
    }
    _applyCrop()
  })

  const _end = e => { _pointers.delete(e.pointerId) }
  vp.addEventListener('pointerup', _end)
  vp.addEventListener('pointercancel', _end)

  // Mouse wheel zoom
  vp.addEventListener('wheel', e => {
    e.preventDefault()
    _cropScale = Math.max(1, _cropScale * (e.deltaY < 0 ? 1.1 : 0.91))
    _applyCrop()
  }, { passive: false })

  document.getElementById('avatar-crop-overlay').addEventListener('click', e => {
    if (e.target?.id === 'avatar-crop-overlay') _closeCropOverlay()
  })

  document.getElementById('avatar-crop-cancel').addEventListener('click', _closeCropOverlay)
  document.getElementById('avatar-crop-confirm').addEventListener('click', () => { void _confirmCrop() })
}

async function _confirmCrop() {
  const domImg = document.getElementById('avatar-crop-img')
  const confirmBtn = document.getElementById('avatar-crop-confirm')
  if (!_cropShowing || !domImg.naturalWidth || !domImg.naturalHeight) {
    showToast(t('avatar.loadFailed'))
    return
  }

  confirmBtn.disabled = true
  const { naturalWidth: nw, naturalHeight: nh } = domImg
  const eff = _cropBaseScale * _cropScale
  const vs  = _cropViewSize
  const dw  = nw * eff, dh = nh * eff
  const imgLeft = vs / 2 + _cropX - dw / 2
  const imgTop  = vs / 2 + _cropY - dh / 2
  const sx = -imgLeft / eff
  const sy = -imgTop  / eff
  const sw = vs / eff
  const sh = vs / eff

  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = CROP_OUTPUT
  canvas.getContext('2d').drawImage(domImg, sx, sy, sw, sh, 0, 0, CROP_OUTPUT, CROP_OUTPUT)

  const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
  const profileImg = document.getElementById('profile-avatar-img')
  profileImg.src = dataUrl
  profileImg.style.display = 'block'
  document.getElementById('profile-avatar-initials').style.display = 'none'

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92))
  _closeCropOverlay()
  if (!blob) {
    confirmBtn.disabled = false
    showToast(t('avatar.loadFailed'))
    return
  }

  await _uploadAvatar(blob)
  confirmBtn.disabled = false
}

async function _uploadAvatar(blob) {
  const uid  = state.user.id
  const path = `${uid}/avatar.jpg`
  const { error: upErr } = await supabase.storage
    .from('avatars')
    .upload(path, blob, { contentType: 'image/jpeg', upsert: true })
  if (upErr) { showToast(t('profile.uploadFailed', { message: upErr.message })); return }
  const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path)
  const { error: dbErr } = await supabase.from('profiles').update({ avatar_url: publicUrl }).eq('id', uid)
  if (dbErr) { showToast(t('common.errorPrefix', { message: dbErr.message })); return }
  await _setProfileAvatarSource({
    uid,
    preferredUrl: publicUrl,
    cacheBust: true,
    keepCurrentOnFailure: true,
  })
  await refreshHeaderProfileButtons({ username: document.getElementById('profile-username')?.value.trim(), avatar_url: publicUrl })
  showToast(t('profile.photoUpdated'))
}

function _initials(str) {
  return str.split(/[\s@.]/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('') || '?'
}

function _showInitialsAvatar() {
  const img = document.getElementById('profile-avatar-img')
  img.style.display = 'none'
  img.removeAttribute('src')
  document.getElementById('profile-avatar-initials').style.display = ''
}

function _closeCropOverlay() {
  _cropShowing = false
  document.getElementById('avatar-crop-overlay').style.display = 'none'
  document.getElementById('avatar-crop-confirm').disabled = false
  _resetCropPreview()
}

function _resetCropPreview() {
  const img = document.getElementById('avatar-crop-img')
  img.onload = null
  img.onerror = null
  img.removeAttribute('src')
  img.style.width = ''
  img.style.height = ''
  img.style.left = ''
  img.style.top = ''
  _cropScale = 1
  _cropX = 0
  _cropY = 0
  _cropBaseScale = 1
  _cropViewSize = 0
  _pointers.clear()
}

function _readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error || new Error('avatar-file-read-failed'))
    reader.readAsDataURL(file)
  })
}

async function _setProfileAvatarSource({ uid, preferredUrl = '', cacheBust = false, keepCurrentOnFailure = false }) {
  const img = document.getElementById('profile-avatar-img')
  const currentSrc = img.getAttribute('src') || ''
  const candidates = []

  const addCandidate = url => {
    if (url && !candidates.includes(url)) candidates.push(url)
  }

  addCandidate(_withCacheBust(preferredUrl, cacheBust))
  addCandidate(await _getSignedAvatarUrl(uid, cacheBust))

  for (const candidate of candidates) {
    if (await _canLoadImage(candidate)) {
      img.src = candidate
      img.style.display = 'block'
      document.getElementById('profile-avatar-initials').style.display = 'none'
      return true
    }
  }

  if (keepCurrentOnFailure && currentSrc) {
    img.src = currentSrc
    img.style.display = 'block'
    document.getElementById('profile-avatar-initials').style.display = 'none'
    return false
  }

  return false
}

async function _getSignedAvatarUrl(uid, cacheBust) {
  const { data, error } = await supabase.storage
    .from('avatars')
    .createSignedUrl(`${uid}/avatar.jpg`, 60 * 60)

  if (error || !data?.signedUrl) return ''
  return _withCacheBust(data.signedUrl, cacheBust)
}

function _canLoadImage(url) {
  return new Promise(resolve => {
    if (!url) { resolve(false); return }
    const probe = new Image()
    probe.onload = () => resolve(true)
    probe.onerror = () => resolve(false)
    probe.src = url
  })
}

function _withCacheBust(url, enabled) {
  if (!url) return ''
  if (!enabled) return url
  return `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`
}

function _renderCloudPlan(cloudPlan) {
  const normalized = cloudPlan || state.cloudPlan || {
    cloudPlan: 'free',
    fullResStorageEnabled: false,
    storageQuotaBytes: null,
    storageUsedBytes: 0,
    uploadMode: 'reduced',
  }
  const isMaxResolution = normalized.uploadMode === 'full'

  const uploadEl = document.getElementById('profile-cloud-upload-mode')
  const usageEl = document.getElementById('profile-cloud-usage')
  const storageEl = document.getElementById('profile-storage-usage')
  const imageCountEl = document.getElementById('profile-image-count')

  if (uploadEl) {
    uploadEl.textContent = t(isMaxResolution ? 'profile.imageResolutionPro' : 'profile.imageResolutionDefault')
  }
  if (usageEl) {
    usageEl.textContent = _formatSyncHistory(getLastSyncAt())
  }
  if (storageEl) {
    if (normalized.storageQuotaBytes) {
      storageEl.textContent = t('profile.storageUsedOfQuota', {
        used: formatStorageBytes(normalized.storageUsedBytes),
        total: formatStorageBytes(normalized.storageQuotaBytes),
      })
    } else {
      storageEl.textContent = t('profile.storageUsedOnly', {
        used: formatStorageBytes(normalized.storageUsedBytes),
      })
    }
  }
  if (imageCountEl) {
    imageCountEl.textContent = t(
      normalized.imageCount === 1 ? 'profile.imageCountValue.one' : 'profile.imageCountValue.other',
      { count: normalized.imageCount || 0 },
    )
  }
}

function _formatSyncHistory(date) {
  if (!date) return t('profile.syncNever')
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  const time = formatTime(date, { hour: '2-digit', minute: '2-digit', hour12: false })
  if (sameDay) return t('profile.syncTodayAt', { time })
  return t('profile.syncAt', {
    date: formatDate(date, { day: 'numeric', month: 'short' }),
    time,
  })
}

// ── Friends list ──────────────────────────────────────────────────────────────

async function _loadFriends() {
  const uid = state.user?.id
  if (!uid) return

  const { data: friendships } = await supabase
    .from('friendships')
    .select('id, requester_id, addressee_id')
    .eq('status', 'accepted')
    .or(`requester_id.eq.${uid},addressee_id.eq.${uid}`)

  const list = document.getElementById('friends-list')

  if (!friendships?.length) {
    list.innerHTML = `<div style="color:var(--text-dim);font-size:13px">${t('profile.noFriends')}</div>`
    return
  }

  const friendIds = friendships.map(f => f.requester_id === uid ? f.addressee_id : f.requester_id)
  const { data: profiles } = await supabase
    .from('profiles').select('id, username, display_name').in('id', friendIds)

  list.innerHTML = (profiles || []).map(p => {
    const label = p.username ? `@${p.username}` : (p.display_name || p.id)
    const initial = label.replace('@', '')[0]?.toUpperCase() || '?'
    return `<div class="friend-row">
      <div class="friend-avatar">${initial}</div>
      <div class="friend-email">${_esc(label)}</div>
      <button class="friend-remove-btn" data-id="${p.id}">${t('profile.remove')}</button>
    </div>`
  }).join('')

  list.querySelectorAll('.friend-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => _removeFriend(btn.dataset.id))
  })
}

// ── Pending requests ──────────────────────────────────────────────────────────

async function _loadPending() {
  const uid = state.user?.id
  if (!uid) return

  const { data: pending } = await supabase
    .from('friendships')
    .select('id, requester_id')
    .eq('addressee_id', uid)
    .eq('status', 'pending')

  const section = document.getElementById('pending-section')
  const list    = document.getElementById('pending-list')

  if (!pending?.length) { section.style.display = 'none'; return }
  section.style.display = 'block'

  const { data: profiles } = await supabase
    .from('profiles').select('id, username, display_name').in('id', pending.map(p => p.requester_id))
  const pm = Object.fromEntries((profiles || []).map(p => [p.id, p]))

  list.innerHTML = pending.map(req => {
    const p = pm[req.requester_id]
    const label = p?.username ? `@${p.username}` : (p?.display_name || req.requester_id)
    return `<div class="friend-row">
      <div class="friend-avatar">${label.replace('@', '')[0]?.toUpperCase() || '?'}</div>
      <div class="friend-email">${_esc(label)}</div>
      <button class="btn-primary friend-accept-btn" data-id="${req.id}" style="padding:5px 10px;font-size:12px;flex-shrink:0">${t('profile.accept')}</button>
      <button class="friend-decline-btn" data-id="${req.id}" style="font-size:12px;padding:5px 10px;background:transparent;border:1px solid var(--border);border-radius:6px;color:var(--text-dim);cursor:pointer;flex-shrink:0">${t('profile.decline')}</button>
    </div>`
  }).join('')

  list.querySelectorAll('.friend-accept-btn').forEach(b =>
    b.addEventListener('click', () => _acceptRequest(b.dataset.id)))
  list.querySelectorAll('.friend-decline-btn').forEach(b =>
    b.addEventListener('click', () => _declineRequest(b.dataset.id)))
}

// ── Friend search ─────────────────────────────────────────────────────────────

async function _searchFriend() {
  const input   = document.getElementById('friend-search-input')
  const results = document.getElementById('friend-search-results')
  const q = input.value.trim()
  if (!q) return

  results.innerHTML = `<div style="color:var(--text-dim);font-size:12px;padding:8px 0">${t('profile.searching')}</div>`

  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name')
    .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
    .neq('id', state.user.id)
    .limit(5)

  if (error || !data?.length) {
    results.innerHTML = `<div style="color:var(--text-dim);font-size:12px;padding:8px 0">${t('profile.noUsersFound')}</div>`
    return
  }

  const searchIds = data.map(p => p.id)
  const { data: existingFriendships, error: friendshipError } = await supabase
    .from('friendships')
    .select('requester_id, addressee_id, status')
    .or(`requester_id.eq.${state.user.id},addressee_id.eq.${state.user.id}`)
  if (friendshipError) {
    console.warn('Friend relationship lookup failed:', friendshipError.message)
  }

  const relationshipByUserId = new Map()
  ;(existingFriendships || []).forEach(friendship => {
    const otherId = friendship.requester_id === state.user.id ? friendship.addressee_id : friendship.requester_id
    if (searchIds.includes(otherId)) relationshipByUserId.set(otherId, friendship.status)
  })

  results.innerHTML = data.map(p => {
    const name    = p.display_name || p.username || '?'
    const handle  = p.username ? `@${p.username}` : (p.email || '')
    const initial = name[0]?.toUpperCase() || '?'
    const relationshipStatus = relationshipByUserId.get(p.id)
    const disabledAttr = relationshipStatus ? ' disabled' : ''
    const buttonLabel = relationshipStatus === 'accepted'
      ? t('profile.friends')
      : relationshipStatus === 'pending'
        ? t('profile.sent')
        : t('profile.add')
    return `
    <div class="friend-row">
      <div class="friend-avatar">${initial}</div>
      <div class="friend-info">
        <div class="friend-name">${_esc(name)}</div>
        ${handle ? `<div class="friend-handle">${_esc(handle)}</div>` : ''}
      </div>
      <button class="btn-primary send-request-btn" data-id="${p.id}" style="padding:5px 10px;font-size:12px;flex-shrink:0"${disabledAttr} aria-disabled="${relationshipStatus ? 'true' : 'false'}">${buttonLabel}</button>
    </div>`
  }).join('')

  results.querySelectorAll('.send-request-btn').forEach(btn => {
    btn.addEventListener('click', () => _sendRequest(btn.dataset.id, btn))
  })
}

async function _sendRequest(friendId, btn) {
  btn.disabled = true
  const { error } = await supabase
    .from('friendships')
    .insert({ requester_id: state.user.id, addressee_id: friendId, status: 'pending' })

  if (error) {
    showToast(error.code === '23505' ? t('profile.requestAlreadySent') : t('common.errorPrefix', { message: error.message }))
    btn.disabled = false
  } else {
    showToast(t('profile.requestSent'))
    btn.textContent = t('profile.sent')
  }
}

async function _acceptRequest(friendshipId) {
  const { error } = await supabase
    .from('friendships').update({ status: 'accepted' }).eq('id', friendshipId)
  if (error) { showToast(t('common.errorPrefix', { message: error.message })); return }
  showToast(t('profile.friendAccepted'))
  loadProfile()
}

async function _declineRequest(friendshipId) {
  await supabase.from('friendships').delete().eq('id', friendshipId)
  loadProfile()
}

async function _removeFriend(friendUserId) {
  const uid = state.user.id
  await supabase.from('friendships').delete()
    .or(`and(requester_id.eq.${uid},addressee_id.eq.${friendUserId}),and(requester_id.eq.${friendUserId},addressee_id.eq.${uid})`)
  showToast(t('profile.friendRemoved'))
  loadProfile()
}

async function _deleteAccount() {
  const email = state.user?.email || 'this account'
  const confirmed = window.confirm(t('profile.deleteConfirm', { email }))
  if (!confirmed) return

  const btn = document.getElementById('delete-account-btn')
  btn.disabled = true
  const originalLabel = btn.textContent
  btn.textContent = t('profile.deleting')

  const { error } = await supabase.functions.invoke('delete-account', {
    body: {},
  })

  if (error) {
    btn.disabled = false
    btn.textContent = originalLabel
    if (String(error.message || '').toLowerCase().includes('failed to send')) {
      showToast(t('profile.deleteFunctionMissing'))
    } else {
      showToast(t('profile.deleteFailed', { message: error.message }))
    }
    return
  }

  try { await supabase.auth.signOut() } catch (e) { console.warn('Sign out error:', e) }
  state.user = null
  showAuthOverlay()
  switchToLogin()
  navigate('home')
  btn.disabled = false
  btn.textContent = originalLabel
  showToast(t('profile.accountDeleted'))
}

function _esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

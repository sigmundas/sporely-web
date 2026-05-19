import { loadInaturalistSession, loadInatPendingState } from './inaturalist.js'
import { clearDebugNamespace, ensureDebugNamespace, isDebugDashboardEnabled, revokeDebugObjectUrl } from './debug-activity.js'

export { isDebugDashboardEnabled } from './debug-activity.js'

const DASH_ID = 'sporely-debug-dash'
const LAUNCHER_ID = 'sporely-debug-dash-launcher'
const STYLE_ID = 'sporely-debug-dash-style'
const REFRESH_MS = 2000
const MONITOR_MS = 1000

let _refreshTimer = null
let _monitorTimer = null
let _dashboardRoot = null
let _launcherRoot = null
let _dashboardVisible = false
let _rendering = false
let _rerenderRequested = false

function _isEnabled() {
  return isDebugDashboardEnabled()
}

function _teardownDashboardUi() {
  _dashboardRoot?.remove()
  _dashboardRoot = null
  _launcherRoot?.remove()
  _launcherRoot = null
  _dashboardVisible = false
}

function _ensureNamespace() {
  return ensureDebugNamespace()
}

function _ensureStyles() {
  if (document.getElementById(STYLE_ID)) return

  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    #${DASH_ID} {
      position: fixed;
      top: 16px;
      left: 16px;
      width: 420px;
      height: 72vh;
      min-width: 300px;
      min-height: 260px;
      max-width: calc(100vw - 24px);
      max-height: calc(100vh - 24px);
      z-index: 10000;
      background: rgba(4, 7, 10, 0.95);
      color: #dbffe1;
      border: 1px solid rgba(73, 255, 138, 0.55);
      border-radius: 14px;
      box-shadow: 0 18px 44px rgba(0, 0, 0, 0.45);
      overflow: hidden;
      resize: both;
      display: flex;
      flex-direction: column;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    #${DASH_ID}[hidden] {
      display: none !important;
    }
    #${DASH_ID} * {
      box-sizing: border-box;
    }
    #${DASH_ID} .dbg-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid rgba(73, 255, 138, 0.18);
      background: linear-gradient(180deg, rgba(11, 20, 16, 0.98), rgba(6, 11, 9, 0.98));
    }
    #${DASH_ID} .dbg-drag {
      flex: 1;
      min-width: 0;
      cursor: move;
      user-select: none;
      touch-action: none;
    }
    #${DASH_ID} .dbg-title {
      color: #f2fff5;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    #${DASH_ID} .dbg-subtitle {
      color: rgba(219, 255, 225, 0.72);
      margin-top: 2px;
      font-size: 11px;
    }
    #${DASH_ID} .dbg-actions {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      flex-shrink: 0;
    }
    #${DASH_ID} .dbg-btn {
      appearance: none;
      border: 1px solid rgba(73, 255, 138, 0.28);
      background: rgba(14, 24, 19, 0.94);
      color: #dcffe3;
      border-radius: 8px;
      padding: 6px 8px;
      font: inherit;
      line-height: 1;
      cursor: pointer;
    }
    #${DASH_ID} .dbg-btn:hover {
      border-color: rgba(73, 255, 138, 0.58);
      background: rgba(20, 34, 27, 0.98);
    }
    #${DASH_ID} .dbg-btn.danger {
      color: #ff9d9d;
      border-color: rgba(255, 125, 125, 0.38);
    }
    #${DASH_ID} .dbg-body {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 10px 12px 12px;
      background:
        radial-gradient(circle at top left, rgba(73, 255, 138, 0.08), transparent 42%),
        linear-gradient(180deg, rgba(6, 10, 9, 0.98), rgba(2, 5, 6, 0.99));
    }
    #${DASH_ID} .dbg-block {
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 10px;
      margin-bottom: 10px;
      background: rgba(255, 255, 255, 0.03);
    }
    #${DASH_ID} .dbg-block-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
      color: #f6fff8;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    #${DASH_ID} .dbg-kv {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 6px 8px;
      margin-bottom: 8px;
    }
    #${DASH_ID} .dbg-k {
      color: rgba(219, 255, 225, 0.68);
    }
    #${DASH_ID} .dbg-v {
      color: #f4fff7;
      word-break: break-word;
    }
    #${DASH_ID} .dbg-v.good {
      color: #90ffb4;
    }
    #${DASH_ID} .dbg-v.warn {
      color: #ffd57d;
    }
    #${DASH_ID} .dbg-v.bad {
      color: #ff9d9d;
    }
    #${DASH_ID} .dbg-note {
      color: rgba(219, 255, 225, 0.68);
      font-size: 11px;
      margin-top: 4px;
    }
    #${DASH_ID} .dbg-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
      gap: 8px;
    }
    #${DASH_ID} .dbg-card {
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      overflow: hidden;
      background: rgba(255, 255, 255, 0.03);
    }
    #${DASH_ID} .dbg-card button {
      appearance: none;
      display: block;
      width: 100%;
      padding: 0;
      border: 0;
      background: transparent;
      cursor: pointer;
    }
    #${DASH_ID} .dbg-thumb {
      display: block;
      width: 100%;
      aspect-ratio: 1 / 1;
      object-fit: cover;
      background: rgba(255, 255, 255, 0.04);
    }
    #${DASH_ID} .dbg-card-meta {
      padding: 7px 8px 8px;
      font-size: 9px;
      line-height: 1.3;
      color: rgba(233, 255, 237, 0.9);
    }
    #${DASH_ID} .dbg-card-meta pre {
      margin: 4px 0 0;
      white-space: pre-wrap;
      word-break: break-word;
      font: inherit;
      color: rgba(208, 255, 221, 0.72);
    }
    #${DASH_ID} .dbg-empty {
      color: rgba(219, 255, 225, 0.42);
      font-size: 11px;
      padding: 6px 2px 2px;
    }
    #${DASH_ID} .dbg-footer {
      margin-top: 8px;
      color: rgba(219, 255, 225, 0.6);
      font-size: 10px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 8px;
    }
    #${LAUNCHER_ID} {
      position: fixed;
      right: 14px;
      bottom: 14px;
      z-index: 10001;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 56px;
      height: 56px;
      padding: 0 14px;
      border: 1px solid rgba(73, 255, 138, 0.55);
      border-radius: 999px;
      background: rgba(4, 7, 10, 0.94);
      color: #dbffe1;
      box-shadow: 0 14px 30px rgba(0, 0, 0, 0.35);
      font: 700 12px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      cursor: pointer;
      user-select: none;
    }
    #${LAUNCHER_ID} .dbg-dot {
      width: 10px;
      height: 10px;
      margin-right: 8px;
      border-radius: 999px;
      background: #90ffb4;
      box-shadow: 0 0 12px rgba(144, 255, 180, 0.8);
    }
  `
  document.head.appendChild(style)
}

function _maskToken(token) {
  const value = String(token || '').trim()
  if (!value) return 'MISSING'
  if (value.length <= 12) return value
  return `${value.slice(0, 8)}…${value.slice(-4)}`
}

function _formatDate(value) {
  if (!value) return 'unset'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

function _formatRelative(timestamp) {
  if (!timestamp) return 'unset'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return String(timestamp)
  const diff = date.getTime() - Date.now()
  const future = diff >= 0
  const abs = Math.abs(diff)
  const minutes = Math.round(abs / 60000)
  const hours = Math.round(abs / 3600000)
  const days = Math.round(abs / 86400000)
  let label = `${minutes}m`
  if (minutes >= 60) label = `${hours}h`
  if (hours >= 48) label = `${days}d`
  return future ? `in ${label}` : `${label} ago`
}

function _snapshotMetaText(snapshot) {
  try {
    const metadata = snapshot?.metadata && typeof snapshot.metadata === 'object'
      ? snapshot.metadata
      : (snapshot?.images?.[0] || {})
    const compact = { ...metadata }
    delete compact.objectUrl
    delete compact.imageSrc
    delete compact.debugPreviewUrl
    delete compact.previewUrl
    delete compact.sourceUrl
    return JSON.stringify(compact, null, 2)
  } catch (_) {
    return '{}'
  }
}

function _snapshotImageUrl(snapshot) {
  const debugPreviewUrl = String(snapshot?.debugPreviewUrl || snapshot?.previewUrl || snapshot?.sourceUrl || '').trim()
  if (debugPreviewUrl) return debugPreviewUrl
  const imageSrc = String(snapshot?.imageSrc || '').trim()
  if (imageSrc) return imageSrc
  const imagePreviewUrl = String(snapshot?.images?.[0]?.debugPreviewUrl || snapshot?.images?.[0]?.previewUrl || snapshot?.images?.[0]?.sourceUrl || '').trim()
  if (imagePreviewUrl) return imagePreviewUrl
  const objectUrl = String(snapshot?.images?.[0]?.objectUrl || '').trim()
  if (objectUrl) return objectUrl
  return ''
}

function _shortJson(value, limit = 2400) {
  try {
    const text = typeof value === 'string'
      ? value
      : JSON.stringify(value, null, 2)
    if (!text) return ''
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
  } catch (_) {
    return ''
  }
}

function _makeKvRow(label, value, tone = '') {
  const key = document.createElement('div')
  key.className = 'dbg-k'
  key.textContent = label

  const val = document.createElement('div')
  val.className = `dbg-v ${tone}`.trim()
  val.textContent = value

  return [key, val]
}

function _appendKvs(container, rows) {
  const grid = document.createElement('div')
  grid.className = 'dbg-kv'
  for (const [label, value, tone] of rows) {
    const [key, val] = _makeKvRow(label, value, tone)
    grid.append(key, val)
  }
  container.appendChild(grid)
}

function _makeSnapshotCard(snapshot, serviceLabel) {
  const card = document.createElement('article')
  card.className = 'dbg-card'

  const imageUrl = _snapshotImageUrl(snapshot)

  const preview = document.createElement('button')
  preview.type = 'button'
  preview.title = imageUrl ? 'Open full image' : 'No image URL available'

  const img = document.createElement('img')
  img.className = 'dbg-thumb'
  img.alt = `${serviceLabel} snapshot`
  img.loading = 'lazy'
  img.decoding = 'async'
  img.style.display = imageUrl ? 'block' : 'none'
  if (imageUrl) img.src = imageUrl

  const placeholder = document.createElement('div')
  placeholder.className = 'dbg-empty'
  placeholder.style.margin = '0'
  placeholder.style.minHeight = '112px'
  placeholder.style.display = imageUrl ? 'none' : 'flex'
  placeholder.style.alignItems = 'center'
  placeholder.style.justifyContent = 'center'
  placeholder.style.textAlign = 'center'
  placeholder.textContent = imageUrl ? '' : 'No image URL'

  const meta = document.createElement('div')
  meta.className = 'dbg-card-meta'

  const timeLine = document.createElement('div')
  timeLine.textContent = _formatDate(snapshot.timestamp)

  const sizeLine = document.createElement('div')
  sizeLine.textContent = 'Image: loading...'

  const metaText = document.createElement('pre')
  metaText.textContent = _snapshotMetaText(snapshot)

  if (imageUrl) {
    img.addEventListener('load', () => {
      img.style.display = 'block'
      placeholder.style.display = 'none'
      sizeLine.textContent = `Image: ${img.naturalWidth} x ${img.naturalHeight}px`
    })
    img.addEventListener('error', () => {
      img.style.display = 'none'
      placeholder.style.display = 'flex'
      placeholder.textContent = 'Image failed to load'
      sizeLine.textContent = 'Image: failed to load'
    })
  } else {
    sizeLine.textContent = 'Image: unavailable'
  }

  preview.append(img, placeholder)

  preview.addEventListener('click', () => {
    if (!imageUrl) return
    globalThis.open?.(imageUrl, '_blank', 'noopener')
  })

  meta.append(timeLine, sizeLine, metaText)
  card.append(preview, meta)
  return card
}

function _makeSnapshotSection(title, snapshots, emptyMessage) {
  const block = document.createElement('section')
  block.className = 'dbg-block'

  const head = document.createElement('div')
  head.className = 'dbg-block-title'

  const label = document.createElement('span')
  label.textContent = title

  const count = document.createElement('span')
  count.textContent = `${snapshots.length}`
  count.style.color = 'rgba(219, 255, 225, 0.65)'

  head.append(label, count)
  block.appendChild(head)

  if (!snapshots.length) {
    const empty = document.createElement('div')
    empty.className = 'dbg-empty'
    empty.textContent = emptyMessage
    block.appendChild(empty)
    return block
  }

  const grid = document.createElement('div')
  grid.className = 'dbg-grid'
  for (const snapshot of snapshots.slice(0, 20)) {
    grid.appendChild(_makeSnapshotCard(snapshot, title))
  }
  block.appendChild(grid)
  return block
}

function _makeTextEntryCard(entry, label, bodyText, tone = '') {
  const card = document.createElement('article')
  card.className = 'dbg-card'

  const meta = document.createElement('div')
  meta.className = 'dbg-card-meta'

  const timeLine = document.createElement('div')
  timeLine.textContent = _formatDate(entry.timestamp)

  const labelLine = document.createElement('div')
  labelLine.style.fontWeight = '700'
  labelLine.style.color = tone === 'warn'
    ? 'rgba(255, 213, 125, 0.96)'
    : tone === 'bad'
      ? 'rgba(255, 157, 157, 0.96)'
      : 'rgba(233, 255, 237, 0.96)'
  labelLine.textContent = label

  const pre = document.createElement('pre')
  pre.textContent = bodyText || ''

  meta.append(timeLine, labelLine, pre)
  card.append(meta)
  return card
}

function _makeLogSection(title, entries, emptyMessage, entryToCard) {
  const block = document.createElement('section')
  block.className = 'dbg-block'

  const head = document.createElement('div')
  head.className = 'dbg-block-title'

  const label = document.createElement('span')
  label.textContent = title

  const count = document.createElement('span')
  count.textContent = `${entries.length}`
  count.style.color = 'rgba(219, 255, 225, 0.65)'

  head.append(label, count)
  block.appendChild(head)

  if (!entries.length) {
    const empty = document.createElement('div')
    empty.className = 'dbg-empty'
    empty.textContent = emptyMessage
    block.appendChild(empty)
    return block
  }

  const grid = document.createElement('div')
  grid.className = 'dbg-grid'
  for (const entry of entries.slice(0, 20)) {
    grid.appendChild(entryToCard(entry))
  }
  block.appendChild(grid)
  return block
}

function _clearStoreEntries(store) {
  if (!Array.isArray(store)) return
  for (const snapshot of store) {
    try {
      revokeDebugObjectUrl(snapshot?.imageSrc || snapshot?.debugPreviewUrl || snapshot?.previewUrl || snapshot?.sourceUrl || '')
      revokeDebugObjectUrl(snapshot?.images?.[0]?.objectUrl || snapshot?.images?.[0]?.debugPreviewUrl || '')
      for (const image of snapshot?.images || []) {
        revokeDebugObjectUrl(image?.objectUrl || image?.debugPreviewUrl || '')
      }
    } catch (_) {}
  }
  store.length = 0
}

function _ensureLauncher() {
  if (_launcherRoot?.isConnected) return _launcherRoot

  const launcher = document.createElement('button')
  launcher.id = LAUNCHER_ID
  launcher.type = 'button'
  launcher.setAttribute('aria-label', 'Open Sporely debug dashboard')

  const dot = document.createElement('span')
  dot.className = 'dbg-dot'

  const label = document.createElement('span')
  label.textContent = 'DBG'

  launcher.append(dot, label)
  launcher.addEventListener('click', () => {
    if (_dashboardVisible) {
      hideDebugDashboard()
    } else {
      showDebugDashboard()
    }
  })

  document.body.appendChild(launcher)
  _launcherRoot = launcher
  return launcher
}

function _ensureTimers() {
  if (_monitorTimer === null) {
    _monitorTimer = window.setInterval(() => {
      if (_isEnabled()) {
        if (!_launcherRoot?.isConnected || !_dashboardRoot?.isConnected) {
          initDebugDashboard()
        }
      } else if (_launcherRoot?.isConnected || _dashboardRoot?.isConnected) {
        _teardownDashboardUi()
      }
    }, MONITOR_MS)
  }
  if (_refreshTimer === null) {
    _refreshTimer = window.setInterval(() => {
      if (!_dashboardVisible || !_dashboardRoot?.isConnected || !_isEnabled()) return
      void _renderInto(_dashboardRoot)
    }, REFRESH_MS)
  }
}

function _installDrag(root, handle) {
  let pointerId = null
  let startX = 0
  let startY = 0
  let startLeft = 0
  let startTop = 0

  const onMove = event => {
    if (event.pointerId !== pointerId) return
    event.preventDefault()
    const dx = event.clientX - startX
    const dy = event.clientY - startY
    root.style.left = `${Math.max(0, startLeft + dx)}px`
    root.style.top = `${Math.max(0, startTop + dy)}px`
    root.style.right = 'auto'
    root.style.bottom = 'auto'
  }

  const onUp = event => {
    if (event.pointerId !== pointerId) return
    try {
      handle.releasePointerCapture?.(pointerId)
    } catch (_) {}
    pointerId = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }

  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    if (event.target.closest?.('button')) return
    pointerId = event.pointerId
    const rect = root.getBoundingClientRect()
    startX = event.clientX
    startY = event.clientY
    startLeft = rect.left
    startTop = rect.top
    root.style.right = 'auto'
    root.style.bottom = 'auto'
    try {
      handle.setPointerCapture?.(pointerId)
    } catch (_) {}
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  })
}

async function _renderInto(root) {
  if (_rendering) {
    _rerenderRequested = true
    return
  }

  _rendering = true
  try {
    const previousScrollTop = root.querySelector('.dbg-body')?.scrollTop ?? 0
    const previousScrollLeft = root.querySelector('.dbg-body')?.scrollLeft ?? 0
    const [session, pendingState] = await Promise.all([
      loadInaturalistSession().catch(() => null),
      loadInatPendingState().catch(() => null),
    ])
    if (!root.isConnected) return

    const debug = _ensureNamespace()
    const inatSnapshots = Array.isArray(debug.inat) ? debug.inat : []
    const artsSnapshots = Array.isArray(debug.artsorakel) ? debug.artsorakel : []
    const imageEvents = Array.isArray(debug.images) ? debug.images : []
    const jsonResponses = Array.isArray(debug.jsonResponses) ? debug.jsonResponses : []
    const now = Date.now()

    const hasApiToken = !!String(session?.api_token || session?.apiToken || '').trim()
    const apiExpiresAt = Number(session?.api_token_expires_at || session?.apiTokenExpiresAt || 0) || 0
    const tokenTone = !apiExpiresAt
      ? 'warn'
      : (apiExpiresAt <= now ? 'bad' : (apiExpiresAt - now < 10 * 60 * 1000 ? 'warn' : 'good'))

    root.replaceChildren()

    const head = document.createElement('div')
    head.className = 'dbg-head'

    const drag = document.createElement('div')
    drag.className = 'dbg-drag'
    drag.innerHTML = `
      <div class="dbg-title">Sporely Debug Dash</div>
      <div class="dbg-subtitle">Verify crop, resize, request payloads, and token state.</div>
    `

    const actions = document.createElement('div')
    actions.className = 'dbg-actions'

    const refreshBtn = document.createElement('button')
    refreshBtn.type = 'button'
    refreshBtn.className = 'dbg-btn'
    refreshBtn.textContent = 'Refresh'

    const clearBtn = document.createElement('button')
    clearBtn.type = 'button'
    clearBtn.className = 'dbg-btn danger'
    clearBtn.textContent = 'Clear'

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'dbg-btn'
    closeBtn.textContent = 'X'

    actions.append(refreshBtn, clearBtn, closeBtn)
    head.append(drag, actions)

    const body = document.createElement('div')
    body.className = 'dbg-body'

    const tokenBlock = document.createElement('section')
    tokenBlock.className = 'dbg-block'

    const tokenHead = document.createElement('div')
    tokenHead.className = 'dbg-block-title'
    tokenHead.innerHTML = '<span>iNaturalist Session</span><span>token status</span>'
    tokenBlock.appendChild(tokenHead)

    _appendKvs(tokenBlock, [
      ['Debug flag', _isEnabled() ? 'on' : 'off', _isEnabled() ? 'good' : 'warn'],
      ['Username', session?.username || 'not saved', session?.username ? 'good' : 'warn'],
      ['API token', _maskToken(session?.api_token || session?.apiToken), hasApiToken ? 'good' : 'bad'],
      ['API expiry', _formatDate(session?.api_token_expires_at || session?.apiTokenExpiresAt), tokenTone],
      ['OAuth handoff', pendingState ? 'pending' : 'idle', pendingState ? 'warn' : 'good'],
    ])

    const note = document.createElement('div')
    note.className = 'dbg-note'
    note.textContent = hasApiToken
      ? `API token expires ${_formatRelative(session?.api_token_expires_at || session?.apiTokenExpiresAt)}.`
      : 'No API token is stored yet. Log in again and retry the request.'
    tokenBlock.appendChild(note)

    const pendingNote = document.createElement('div')
    pendingNote.className = 'dbg-note'
    pendingNote.textContent = pendingState
      ? 'OAuth handoff means an auth login was started and the app is waiting for the redirect callback to finish it.'
      : 'No pending auth handoff is stored. This is normal unless a login is currently in progress.'
    tokenBlock.appendChild(pendingNote)

    body.append(
      tokenBlock,
      _makeLogSection(
        'Image pipeline events',
        imageEvents,
        'No image pipeline events yet.',
        entry => _makeTextEntryCard(entry, entry.message || 'image event', _shortJson(entry.details)),
      ),
      _makeLogSection(
        'Latest JSON responses',
        jsonResponses,
        'No JSON responses yet.',
        entry => _makeTextEntryCard(
          entry,
          `${entry.label || entry.endpoint || 'json response'}${Number.isFinite(Number(entry.status)) ? ` • ${entry.status}` : ''}`,
          _shortJson(entry.body || entry.responseBody || entry.payload || entry.data),
          entry.ok === false ? 'bad' : '',
        ),
      ),
      _makeSnapshotSection('Latest iNat snapshots', inatSnapshots, 'No iNat snapshots yet.'),
      _makeSnapshotSection('Latest Artsorakel snapshots', artsSnapshots, 'No Artsorakel snapshots yet.'),
    )

    const footer = document.createElement('div')
    footer.className = 'dbg-footer'
    footer.textContent = 'Tap a thumbnail to open the full blob URL and verify crop/resize output.'
    body.appendChild(footer)

    root.append(head, body)
    body.scrollTop = previousScrollTop
    body.scrollLeft = previousScrollLeft

    refreshBtn.addEventListener('click', () => void _renderInto(root))
    clearBtn.addEventListener('click', () => {
      clearDebugNamespace()
      void _renderInto(root)
    })
    closeBtn.addEventListener('click', () => hideDebugDashboard())

    _installDrag(root, drag)
  } finally {
    _rendering = false
    if (_rerenderRequested) {
      _rerenderRequested = false
      if (_dashboardVisible && _dashboardRoot?.isConnected) {
        void _renderInto(_dashboardRoot)
      }
    }
  }
}

export function showDebugDashboard() {
  if (!_isEnabled()) return null
  _ensureNamespace()
  _ensureStyles()
  _ensureLauncher()
  _ensureTimers()

  if (!_dashboardRoot?.isConnected) {
    const root = document.createElement('div')
    root.id = DASH_ID
    root.setAttribute('aria-label', 'Sporely debug dashboard')
    root.hidden = true
    document.body.appendChild(root)
    _dashboardRoot = root
  }

  _dashboardVisible = true
  _dashboardRoot.hidden = false
  void _renderInto(_dashboardRoot)
  return _dashboardRoot
}

export function hideDebugDashboard() {
  _dashboardVisible = false
  if (_dashboardRoot) {
    _dashboardRoot.hidden = true
  }
}

export function destroyDebugDashboard() {
  if (_refreshTimer !== null) {
    clearInterval(_refreshTimer)
    _refreshTimer = null
  }
  if (_monitorTimer !== null) {
    clearInterval(_monitorTimer)
    _monitorTimer = null
  }
  _teardownDashboardUi()
}

export function initDebugDashboard() {
  _ensureTimers()

  if (!_isEnabled()) {
    _teardownDashboardUi()
    return null
  }

  _ensureNamespace()
  _ensureStyles()
  _ensureLauncher()

  if (!_dashboardRoot?.isConnected) {
    const root = document.createElement('div')
    root.id = DASH_ID
    root.setAttribute('aria-label', 'Sporely debug dashboard')
    root.hidden = true
    document.body.appendChild(root)
    _dashboardRoot = root
  }

  _dashboardRoot.hidden = !_dashboardVisible
  if (_dashboardVisible) {
    void _renderInto(_dashboardRoot)
  }

  return _dashboardRoot
}

globalThis.createDebugDashboard = showDebugDashboard
globalThis.toggleDebugDashboard = () => (_dashboardVisible ? hideDebugDashboard() : showDebugDashboard())

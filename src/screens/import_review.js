import { state } from '../state.js';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import { showToast } from '../toast.js';
import { searchTaxa, formatDisplayName, runArtsorakel } from '../artsorakel.js';
import { loadFinds } from './finds.js';
import { openFindDetail } from './find_detail.js';
import { parse as parseExif, gps as parseGps } from 'exifr';
import { saveImportSessions, clearImportSessions } from '../import-store.js';

let sessions = [];

function sessionById(sid) {
  return sessions.find(s => s.id === sid);
}

export function initImportReview() {
  document.getElementById('import-back').addEventListener('click', _cancelImport);
  document.getElementById('import-cancel-btn').addEventListener('click', _cancelImport);
  document.getElementById('import-save-btn').addEventListener('click', saveAll);
  document.getElementById('import-file-input').addEventListener('change', handleFileSelect);
}

function _cancelImport() {
  clearImportSessions();
  sessions = [];
  navigate('home');
}

// Restore a previously-saved import session (app was killed mid-review)
export function restoreImportSessions(savedSessions) {
  sessions = savedSessions;
  navigate('import-review');
  renderSessions();
}

export function openImportPicker() {
  document.getElementById('import-file-input').click();
}

export async function handleFileSelect(event) {
  const files = Array.from(event.target.files);
  event.target.value = '';
  if (!files.length) return;

  _setProgress(0, files.length, 'Reading timestamps…');

  // Read EXIF capture time + GPS for each file.
  // Android/iOS often set file.lastModified to sync date, not shutter time.
  const withTimes = await Promise.all(files.map(async f => {
    const { time, lat, lon } = await _captureExif(f);
    return { file: f, captureTime: time, lat, lon };
  }));

  // Sort by actual capture time
  withTimes.sort((a, b) => a.captureTime - b.captureTime);

  // Group by user-configured time gap (default 1 min)
  const gapMs = (parseInt(localStorage.getItem('sporely-photo-gap')) || 1) * 60_000;
  const grouped = [[withTimes[0]]];
  for (let i = 1; i < withTimes.length; i++) {
    const prev = grouped[grouped.length - 1];
    const gap = withTimes[i].captureTime - prev[prev.length - 1].captureTime;
    if (gap <= gapMs) {
      prev.push(withTimes[i]);
    } else {
      grouped.push([withTimes[i]]);
    }
  }

  // Convert to JPEG sequentially — avoids exhausting mobile memory with parallel decodes.
  sessions = [];
  let doneCount = 0;
  for (let idx = 0; idx < grouped.length; idx++) {
    const grp = grouped[idx];
    const processed = [];
    for (const { file } of grp) {
      _setProgress(doneCount, files.length, `Converting ${doneCount + 1} of ${files.length}…`);
      processed.push(await _processFile(file));
      doneCount++;
    }
    // Use GPS from the first photo in the group that has EXIF GPS.
    // Do NOT fall back to state.gps — gallery photos have their own location.
    const exifGps = grp.find(f => f.lat !== null);
    const gpsLat = exifGps?.lat ?? null;
    const gpsLon = exifGps?.lon ?? null;

    const ts = new Date(grp[0].captureTime);
    sessions.push({
      id: 's' + idx,
      files: processed.map(p => p.blob),
      blobUrls: processed.map(p => p.url),
      ts,
      gpsLat,
      gpsLon,
      locationName: '',
      taxon: null,
      visibility: 'friends',
    });
  }

  _hideProgress();

  // Single group → skip review screen, save immediately and open edit dialog
  if (sessions.length === 1) {
    const obsId = await _saveSingleAndOpen(sessions[0]);
    if (obsId) {
      sessions = [];
      openFindDetail(obsId);
    }
    return;
  }

  // Persist to IndexedDB so state survives app suspension
  saveImportSessions(sessions);  // fire-and-forget

  navigate('import-review');
  renderSessions();

  // Reverse geocode each session's GPS position (EXIF or live) to pre-fill location name.
  // Run in parallel — each resolves independently and re-renders when done.
  sessions.forEach(async session => {
    if (session.gpsLat === null) return;
    const name = await _reverseGeocode(session.gpsLat, session.gpsLon);
    if (name && !session.locationName) {
      session.locationName = name;
      // Update just this card's location input without full re-render
      const input = document.querySelector(`.import-loc-input[data-sid="${session.id}"]`);
      const locEl = document.querySelector(`.import-card[data-sid="${session.id}"] .import-card-loc`);
      if (input) input.value = name;
      if (locEl) locEl.textContent = name;
    }
    saveImportSessions(sessions);
  });
}

// ── Progress overlay ─────────────────────────────────────────────────────────
function _setProgress(done, total, label) {
  const overlay = document.getElementById('import-progress');
  if (!overlay) return;
  overlay.style.display = 'flex';
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  document.getElementById('import-progress-fill').style.width = pct + '%';
  document.getElementById('import-progress-label').textContent = label || 'Processing…';
}

function _hideProgress() {
  const overlay = document.getElementById('import-progress');
  if (overlay) overlay.style.display = 'none';
}

// ── EXIF / capture time + GPS ─────────────────────────────────────────────────
// Read DateTimeOriginal and GPS separately.
// exifr.gps() is specifically designed to reliably return {latitude, longitude}
// across JPEG, HEIC/HEIF and other formats — more robust than parse() + gps:true.
async function _captureExif(file) {
  let time = file.lastModified;
  let lat  = null;
  let lon  = null;

  // Read the full file into an ArrayBuffer before passing to exifr.
  // exifr uses chunked reads in the browser and can miss GPS data in HEIC files
  // if the GPS box falls outside the initial chunk window.
  let buf;
  try { buf = await file.arrayBuffer() } catch (_) { return { time, lat, lon } }

  try {
    const exif = await parseExif(buf, { pick: ['DateTimeOriginal'] });
    if (exif?.DateTimeOriginal instanceof Date) time = exif.DateTimeOriginal.getTime();
  } catch (_) {}

  try {
    const gps = await parseGps(buf);
    if (gps?.latitude  != null) lat = gps.latitude;
    if (gps?.longitude != null) lon = gps.longitude;
  } catch (_) {}

  return { time, lat, lon };
}

async function _reverseGeocode(lat, lon) {
  try {
    const res = await fetch(
      `https://stedsnavn.artsdatabanken.no/v1/punkt?lat=${lat}&lng=${lon}&zoom=55`
    );
    if (res.ok) {
      const data = await res.json();
      return data?.navn ?? null;
    }
  } catch (_) {}
  return null;
}

// Convert file to a displayable JPEG blob.
// Strategy: try fast canvas decode first (works for JPEG/PNG/WebP and HEIC on iOS Safari).
// If that fails (Android Chrome / desktop browsers can't decode HEIC), fall back to
// heic2any — a pure-JS HEIC/HEIF decoder that works everywhere.
// heic2any is loaded dynamically so it only downloads when actually needed.
async function _processFile(file) {
  // 1. Canvas path (fast — works for JPEG/PNG/WebP; also HEIC on iOS/macOS Safari)
  try {
    const blob = await _toJpeg(file);
    const url = URL.createObjectURL(blob);
    return { blob, url };
  } catch (_) {}

  // 2. heic2any path (slower ~1-2s, handles HEIC/HEIF on Android Chrome etc.)
  try {
    const heic2any = (await import('heic2any')).default;
    let result = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.88 });
    if (Array.isArray(result)) result = result[0];
    const url = URL.createObjectURL(result);
    return { blob: result, url };
  } catch (_) {}

  // 3. Final fallback — original file (will show blank if browser can't decode it)
  return { blob: file, url: URL.createObjectURL(file) };
}

// Save a single session immediately and return the new observation ID.
async function _saveSingleAndOpen(session) {
  try {
    const obsPayload = {
      user_id: state.user.id,
      date: _localDate(session.ts),
      captured_at: session.ts.toISOString(),
      gps_latitude: session.gpsLat ?? null,
      gps_longitude: session.gpsLon ?? null,
      location: session.locationName || null,
      source_type: 'personal',
      visibility: session.visibility || 'friends',
    };

    let { data: obsData, error } = await supabase
      .from('observations').insert(obsPayload).select('id').single();

    // Fallback: if captured_at column doesn't exist yet, retry without it
    if (error?.message?.includes('captured_at')) {
      const { captured_at: _, ...payloadWithout } = obsPayload;
      ({ data: obsData, error } = await supabase
        .from('observations').insert(payloadWithout).select('id').single());
    }

    if (error) throw error;

    const obsId = obsData.id;
    for (let i = 0; i < session.files.length; i++) {
      const path = `${state.user.id}/${obsId}/${i}_${Date.now()}.jpg`;
      const { error: upErr } = await supabase.storage
        .from('observation-images')
        .upload(path, session.files[i], { contentType: 'image/jpeg' });
      if (upErr) { console.error('upload error', upErr); continue; }
      await supabase.from('observation_images').insert({
        observation_id: obsId,
        user_id: state.user.id,
        storage_path: path,
        image_type: 'field',
        sort_order: i,
      });
    }

    session.blobUrls.forEach(url => URL.revokeObjectURL(url));

    // Reverse-geocode and patch location in the background (doesn't block opening)
    if (session.gpsLat !== null) {
      _reverseGeocode(session.gpsLat, session.gpsLon).then(name => {
        if (name) {
          supabase.from('observations').update({ location: name }).eq('id', obsId).then(() => {});
        }
      });
    }

    return obsId;
  } catch (err) {
    console.error('Single import failed:', err);
    showToast('Import failed');
    session.blobUrls.forEach(url => URL.revokeObjectURL(url));
    return null;
  }
}

export function renderSessions() {
  const list = document.getElementById('import-session-list');
  const countEl = document.getElementById('import-session-count');

  const n = sessions.length;
  countEl.textContent = `${n} group${n !== 1 ? 's' : ''}`;

  list.innerHTML = sessions.map(session => buildCardHTML(session)).join('');

  list.querySelectorAll('.import-card-main[data-sid]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.import-card-delete')) return;
      const sid = el.dataset.sid;
      const card = el.closest('.import-card');
      const expanded = card.querySelector('.import-card-expanded');
      const isOpen = expanded.style.display !== 'none';
      if (isOpen) {
        expanded.style.display = 'none';
      } else {
        expanded.style.display = 'block';
        _wireCard(sid);
      }
    });
  });

  list.querySelectorAll('.import-card-delete[data-sid]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const sid = btn.dataset.sid;
      const session = sessionById(sid);
      if (session) {
        session.blobUrls.forEach(url => URL.revokeObjectURL(url));
        sessions = sessions.filter(s => s.id !== sid);
        renderSessions();
      }
    });
  });

  list.querySelectorAll('.import-strip-delete[data-sid]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const sid = btn.dataset.sid;
      const idx = parseInt(btn.dataset.idx, 10);
      const session = sessionById(sid);
      if (!session) return;
      URL.revokeObjectURL(session.blobUrls[idx]);
      session.files.splice(idx, 1);
      session.blobUrls.splice(idx, 1);
      if (session.files.length === 0) {
        sessions = sessions.filter(s => s.id !== sid);
      }
      renderSessions();
    });
  });

  list.querySelectorAll('.import-loc-input[data-sid]').forEach(input => {
    input.addEventListener('input', () => {
      const session = sessionById(input.dataset.sid);
      if (session) session.locationName = input.value;
    });
  });

  list.querySelectorAll('.import-vis-radio[data-sid]').forEach(input => {
    input.addEventListener('change', () => {
      const s = sessionById(input.dataset.sid);
      if (s) s.visibility = input.value;
    });
  });
}

function buildCardHTML(session) {
  const sid = session.id;
  const dateStr = session.ts.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const timeStr = session.ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const photoCount = session.files.length;
  const speciesText = session.taxon
    ? escHtml(session.taxon.displayName)
    : '<span style="opacity:0.45">Unknown species</span>';

  const stackImgs = session.blobUrls.slice(0, 3);
  const polaroids = stackImgs.map((url, i) =>
    `<div class="polaroid-print polaroid-p${i}"><img src="${escHtml(url)}"></div>`
  ).join('');

  const stripItems = session.blobUrls.map((url, i) =>
    `<div class="import-strip-item" data-sid="${sid}" data-idx="${i}">
      <img src="${escHtml(url)}" class="import-strip-thumb" loading="lazy">
      <button class="import-strip-delete" data-sid="${sid}" data-idx="${i}">×</button>
    </div>`
  ).join('');

  const taxonVal = session.taxon ? escHtml(session.taxon.displayName) : '';
  const locVal = escHtml(session.locationName);
  const visChecked = v => session.visibility === v ? 'checked' : '';

  return `<div class="import-card" data-sid="${sid}">
  <div class="import-card-main" data-sid="${sid}">
    <div class="polaroid-stack">
      ${polaroids}
    </div>
    <div class="import-card-info">
      <div class="import-card-datetime"><span>${dateStr}</span><span>${timeStr} · ${photoCount} photo${photoCount !== 1 ? 's' : ''}</span></div>
      <div class="import-card-loc">${session.locationName ? escHtml(session.locationName) : '—'}</div>
      <div class="import-card-species">${speciesText}</div>
    </div>
    <button class="import-card-delete" data-sid="${sid}" aria-label="Delete group">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
    </button>
  </div>
  <div class="import-card-expanded" data-sid="${sid}" style="display:none">
    <div class="import-photo-strip">
      ${stripItems}
    </div>
    <div class="detail-field" style="margin-top:12px">
      <div class="detail-field-label">Species</div>
      <div class="taxon-field-wrap">
        <input class="taxon-input import-taxon-input" type="text" placeholder="Unknown species"
          data-sid="${sid}" autocomplete="off" spellcheck="false"
          value="${taxonVal}">
        <ul class="taxon-dropdown import-taxon-dropdown" data-sid="${sid}" style="display:none"></ul>
      </div>
      <button class="ai-id-btn-import" data-sid="${sid}">
        <div class="ai-dot"></div> Artsorakel AI
      </button>
      <div class="ai-results-import" data-sid="${sid}" style="display:none"></div>
    </div>
    <div class="detail-field" style="margin-top:4px">
      <div class="detail-field-label">Location</div>
      <input class="detail-text-input import-loc-input" type="text"
        data-sid="${sid}" placeholder="—"
        value="${locVal}">
    </div>
    <div class="detail-field" style="margin-top:4px">
      <div class="detail-field-label">Sharing</div>
      <div class="vis-radio-group">
        <label class="vis-option"><input type="radio" class="import-vis-radio" name="vis-${sid}" data-sid="${sid}" value="private" ${visChecked('private')}> <span>Private</span></label>
        <label class="vis-option"><input type="radio" class="import-vis-radio" name="vis-${sid}" data-sid="${sid}" value="friends" ${visChecked('friends')}> <span>Friends</span></label>
        <label class="vis-option"><input type="radio" class="import-vis-radio" name="vis-${sid}" data-sid="${sid}" value="public" ${visChecked('public')}> <span>Public</span></label>
      </div>
    </div>
  </div>
</div>`;
}

function _wireCard(sid) {
  const card = document.querySelector(`.import-card[data-sid="${sid}"]`);
  if (!card) return;
  const input = card.querySelector(`.import-taxon-input[data-sid="${sid}"]`);
  const dropdown = card.querySelector(`.import-taxon-dropdown[data-sid="${sid}"]`);
  if (!input || !dropdown || input._wired) return;
  input._wired = true;

  let debounceTimer = null;

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (!q) { dropdown.style.display = 'none'; dropdown.innerHTML = ''; return; }
    debounceTimer = setTimeout(async () => {
      try {
        const results = await searchTaxa(q, 'nb');
        if (!results?.length) { dropdown.style.display = 'none'; dropdown.innerHTML = ''; return; }
        dropdown.innerHTML = results.map((r, i) => {
          const display = formatDisplayName(r.genus, r.specificEpithet, r.vernacularName);
          return `<li data-idx="${i}">${escHtml(display)}</li>`;
        }).join('');
        dropdown.style.display = 'block';
        dropdown.querySelectorAll('li').forEach((li, i) => {
          li.addEventListener('mousedown', e => {
            e.preventDefault();
            const r = results[i];
            const display = formatDisplayName(r.genus, r.specificEpithet, r.vernacularName);
            const session = sessionById(sid);
            if (session) {
              session.taxon = {
                genus: r.genus || null,
                specificEpithet: r.specificEpithet || null,
                vernacularName: r.vernacularName || null,
                displayName: display,
              };
            }
            input.value = display;
            dropdown.style.display = 'none';
            dropdown.innerHTML = '';
          });
        });
      } catch (_) { dropdown.style.display = 'none'; }
    }, 280);
  });

  input.addEventListener('blur', () => {
    setTimeout(() => { dropdown.style.display = 'none'; }, 200);
  });

  const aiBtn = card.querySelector(`.ai-id-btn-import[data-sid="${sid}"]`)
  const aiResults = card.querySelector(`.ai-results-import[data-sid="${sid}"]`)
  if (aiBtn && aiResults && !aiBtn._wired) {
    aiBtn._wired = true
    aiBtn.addEventListener('click', async () => {
      const session = sessionById(sid)
      if (!session?.files?.length) return
      aiBtn.disabled = true
      aiBtn.textContent = 'Identifying…'
      try {
        const predictions = await runArtsorakel(session.files[0], 'nb')
        if (!predictions?.length) {
          aiResults.style.display = 'none'
          aiBtn.disabled = false
          aiBtn.innerHTML = '<div class="ai-dot"></div> Artsorakel AI'
          return
        }
        aiResults.innerHTML = predictions.map((p, i) =>
          `<div class="ai-result-item" data-idx="${i}">
            <span class="ai-result-name">${escHtml(p.displayName)}</span>
            <span class="ai-result-pct">${Math.round(p.probability * 100)}%</span>
          </div>`
        ).join('')
        aiResults.style.display = 'block'
        aiResults._predictions = predictions
        aiResults.querySelectorAll('.ai-result-item').forEach((el, i) => {
          el.addEventListener('click', () => {
            const p = predictions[i]
            const session = sessionById(sid)
            if (!session) return
            const parts = (p.scientificName || '').trim().split(' ')
            session.taxon = {
              genus: parts[0] || null,
              specificEpithet: parts[1] || null,
              vernacularName: p.vernacularName || null,
              displayName: p.displayName,
            }
            input.value = p.displayName
            aiResults.style.display = 'none'
          })
        })
      } catch (err) {
        console.error('Artsorakel AI error:', err)
      }
      aiBtn.disabled = false
      aiBtn.innerHTML = '<div class="ai-dot"></div> Artsorakel AI'
    })
  }
}

async function saveAll() {
  const saveBtn = document.getElementById('import-save-btn');
  saveBtn.disabled = true;

  const activeSessions = sessions.filter(s => s.files.length > 0);
  if (!activeSessions.length) { saveBtn.disabled = false; navigate('finds'); return; }

  const allBlobUrls = sessions.flatMap(s => s.blobUrls);
  let savedCount = 0;

  for (const session of activeSessions) {
    try {
      const obsPayload = {
        user_id: state.user.id,
        date: _localDate(session.ts),
        captured_at: session.ts.toISOString(),
        gps_latitude: session.gpsLat ?? null,
        gps_longitude: session.gpsLon ?? null,
        location: session.locationName || null,
        source_type: 'personal',
        genus: session.taxon?.genus || null,
        species: session.taxon?.specificEpithet || null,
        common_name: session.taxon?.vernacularName || null,
        visibility: session.visibility || 'friends',
      };

      const { data: obsData, error: obsError } = await supabase
        .from('observations').insert(obsPayload).select('id').single();
      if (obsError) throw obsError;

      const obsId = obsData.id;
      for (let i = 0; i < session.files.length; i++) {
        const path = `${state.user.id}/${obsId}/${i}_${Date.now()}.jpg`;
        // Files are already JPEG blobs (converted in _processFile)
        const { error: uploadError } = await supabase.storage
          .from('observation-images')
          .upload(path, session.files[i], { contentType: 'image/jpeg' });
        if (uploadError) { console.error('Image upload error:', uploadError); continue; }
        await supabase.from('observation_images').insert({
          observation_id: obsId, user_id: state.user.id,
          storage_path: path, image_type: 'field', sort_order: i,
        });
      }
      savedCount++;
    } catch (err) {
      console.error('Failed to save session', session.id, err);
      showToast('Failed to save one group. Others may have saved.');
    }
  }

  allBlobUrls.forEach(url => URL.revokeObjectURL(url));
  sessions = [];
  clearImportSessions();
  if (savedCount > 0) showToast(`Saved ${savedCount} observation${savedCount !== 1 ? 's' : ''}`);
  saveBtn.disabled = false;
  navigate('finds');
  loadFinds();
}

// Convert any image file to a JPEG Blob via Canvas.
// Works for JPEG, PNG, WebP, and HEIC on platforms that can decode it (iOS/macOS Safari).
function _toJpeg(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) {
        URL.revokeObjectURL(url);
        reject(new Error('zero dimensions — format not supported by this browser'));
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        blob => (blob ? resolve(blob) : reject(new Error('toBlob failed'))),
        'image/jpeg', 0.88
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('load failed')); };
    img.src = url;
  });
}

// Use local date string to avoid UTC midnight shift
function _localDate(ts) {
  return `${ts.getFullYear()}-${String(ts.getMonth()+1).padStart(2,'0')}-${String(ts.getDate()).padStart(2,'0')}`;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

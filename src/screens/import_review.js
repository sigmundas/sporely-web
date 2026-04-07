import { state } from '../state.js';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import { showToast } from '../toast.js';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Filesystem } from '@capacitor/filesystem';
import { FilePicker } from '@capawesome/capacitor-file-picker';
import { searchTaxa, formatDisplayName, runArtsorakelForBlobs } from '../artsorakel.js';
import { uploadObservationImageVariants } from '../images.js';
import { loadFinds } from './finds.js';
import { openFindDetail } from './find_detail.js';
import { saveImportSessions, clearImportSessions } from '../import-store.js';

let sessions = [];
let exifrModulePromise = null;
const EXIF_DATETIME_PICK = ['DateTimeOriginal', 'CreateDate', 'ModifyDate'];
const RAW_GPS_PICK = ['GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef', 'latitude', 'longitude'];

function sessionById(sid) {
  return sessions.find(s => s.id === sid);
}

function _isNativeApp() {
  return !!window.Capacitor?.isNativePlatform?.() || ['android', 'ios'].includes(window.Capacitor?.getPlatform?.());
}

export function initImportReview() {
  document.getElementById('import-back').addEventListener('click', _cancelImport);
  document.getElementById('import-cancel-btn').addEventListener('click', _cancelImport);
  document.getElementById('import-save-btn').addEventListener('click', saveAll);
  document.getElementById('import-photo-input').addEventListener('change', handleFileSelect);
  document.getElementById('import-browse-input').addEventListener('change', handleFileSelect);
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

export async function openPhotoImportPicker() {
  if (_isNativeApp()) {
    try {
      // Request permissions first to ensure ACCESS_MEDIA_LOCATION is handled
      await FilePicker.requestPermissions();

      const result = await FilePicker.pickImages({ multiple: true, readData: false });
      const photos = Array.isArray(result?.files) ? result.files : [];
      if (!photos.length) return;

      _setProgress(0, photos.length, 'Reading files…');

      const files = [];
      for (let i = 0; i < photos.length; i++) {
        _setProgress(i, photos.length, `Importing ${i + 1} of ${photos.length}…`);
        files.push(await _nativePickedPhotoToFile(photos[i], i));
      }
      await handleSelectedFiles(files, { nativePhotos: photos });
      return;
    } catch (err) {
      if (_isPickerCancel(err)) return;
      console.warn('Native photo picker failed, falling back to browser input:', err);
      _hideProgress();
    }
  }

  document.getElementById('import-photo-input').click();
}

export async function openFileImportPicker() {
  if (window.showOpenFilePicker) {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        excludeAcceptAllOption: false,
        types: [{
          description: 'Photos',
          accept: {
            'image/jpeg': ['.jpg', '.jpeg'],
            'image/png': ['.png'],
            'image/webp': ['.webp'],
            'image/heic': ['.heic'],
            'image/heif': ['.heif'],
          },
        }],
      });
      const files = await Promise.all(handles.map(handle => handle.getFile()));
      await handleSelectedFiles(files);
      return;
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.warn('showOpenFilePicker failed, falling back to input:', err);
      } else {
        return;
      }
    }
  }

  document.getElementById('import-browse-input').click();
}

export async function handleFileSelect(event) {
  const files = Array.from(event.target.files || []);
  if (event.target) event.target.value = '';
  await handleSelectedFiles(files);
}

async function handleSelectedFiles(files, options = {}) {
  if (!files.length) return;
  const nativePhotos = Array.isArray(options.nativePhotos) ? options.nativePhotos : [];

  _setProgress(0, files.length, 'Reading timestamps…');

  // Read EXIF capture time + GPS for each file.
  // Android/iOS often set file.lastModified to sync date, not shutter time.
  const withTimes = await Promise.all(files.map(async (f, idx) => {
    const nativePhoto = nativePhotos[idx];
    if (nativePhoto) {
      const { time, lat, lon, dbg } = await _captureNativePhotoExif(nativePhoto, f);
      return { file: f, captureTime: time, lat, lon, dbg };
    }
    const { time, lat, lon, dbg } = await _captureExif(f);
    return { file: f, captureTime: time, lat, lon, dbg };
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
    // Collect debug info from all photos in group for diagnostics
    const exifDebug = grp.map(f => f.dbg).filter(Boolean);

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
      exifDebug,
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
function _isHeicLike(file) {
  return /\.(heic|heif)$/i.test(file?.name || '') || /heic|heif/i.test(file?.type || '');
}

function _isPickerCancel(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return err?.name === 'AbortError' || err?.code === 'CANCELLED' || message.includes('cancel');
}

function _coerceExifDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.includes(':') && value.includes(' ')
      ? value.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')
      : value;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

async function _getExifr() {
  if (!exifrModulePromise) {
    exifrModulePromise = import('exifr/dist/full.esm.mjs').then(module => module.default);
  }
  return exifrModulePromise;
}

async function _nativePickedPhotoToFile(photo, index) {
  let mimeType = _normalizeNativeMimeType(photo?.mimeType, photo?.format);
  let path = photo.path;

  // Use the plugin's native convertHeicToJpeg (High Speed) if the format is HEIC
  if (mimeType === 'image/heic' || mimeType === 'image/heif' || photo?.format === 'heic' || photo?.format === 'heif') {
    try {
      if (window.Capacitor?.Plugins?.FilePicker?.convertHeicToJpeg) {
        const converted = await FilePicker.convertHeicToJpeg({ path });
        path = converted.path;
        mimeType = 'image/jpeg';
      }
    } catch (e) {
      console.warn('Native HEIC conversion failed:', e);
    }
  }

  // Fast native file read using Capacitor protocol (avoids blocking base64 encode)
  const url = Capacitor.convertFileSrc(path);
  const res = await fetch(url);
  const blob = await res.blob();

  const fileName = _guessNativeFileName(photo, index, mimeType);
  return new File([blob], fileName, {
    type: mimeType,
    lastModified: Date.now(),
  });
}

function _normalizeNativeMimeType(mimeType, format) {
  const normalizedMime = String(mimeType || '').trim().toLowerCase();
  if (normalizedMime) return normalizedMime;
  const normalizedFormat = String(format || '').trim().toLowerCase();
  if (normalizedFormat === 'jpg') return 'image/jpeg';
  if (normalizedFormat) return `image/${normalizedFormat}`;
  return 'image/jpeg';
}

function _guessNativeFileName(photo, index, mimeType) {
  const fromName = String(photo?.name || '').trim();
  if (fromName) return fromName;
  const ext = mimeType === 'image/heic' ? '.heic'
    : mimeType === 'image/heif' ? '.heif'
    : mimeType === 'image/png' ? '.png'
    : '.jpg';
  return `native-import-${index + 1}${ext}`;
}

function _filesystemReadResultToBlob(data, mimeType) {
  if (data instanceof Blob) return data;
  if (typeof data !== 'string') throw new Error('Unexpected Filesystem.readFile result');
  const base64 = data.includes(',') ? data.split(',').pop() : data;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

function _coerceExifNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  if (value && typeof value === 'object') {
    if (Number.isFinite(value.numerator) && Number.isFinite(value.denominator) && value.denominator) {
      return value.numerator / value.denominator;
    }
    if (Number.isFinite(value.num) && Number.isFinite(value.den) && value.den) {
      return value.num / value.den;
    }
  }
  return null;
}

function _toDecimalDegrees(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    const parts = value.map(_coerceExifNumber).filter(part => part !== null);
    if (!parts.length) return null;
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return parts[0] + (parts[1] / 60);
    return parts[0] + (parts[1] / 60) + (parts[2] / 3600);
  }
  return _coerceExifNumber(value);
}

function _withHemisphere(value, ref, negativeRef) {
  if (value === null) return null;
  const normalized = String(ref || '').trim().toUpperCase();
  if (normalized === negativeRef) return -Math.abs(value);
  return Math.abs(value);
}

function _extractLatLonFromRawGps(rawGps) {
  if (!rawGps || typeof rawGps !== 'object') return { lat: null, lon: null };

  let lat = rawGps.latitude;
  let lon = rawGps.longitude;

  if (lat == null) lat = _withHemisphere(_toDecimalDegrees(rawGps.GPSLatitude), rawGps.GPSLatitudeRef, 'S');
  if (lon == null) lon = _withHemisphere(_toDecimalDegrees(rawGps.GPSLongitude), rawGps.GPSLongitudeRef, 'W');

  lat = _coerceExifNumber(lat);
  lon = _coerceExifNumber(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { lat: null, lon: null };
  return { lat, lon };
}

async function _captureNativePhotoExif(photo, file) {
  let time = file.lastModified || Date.now();
  let lat = null;
  let lon = null;
  const dbg = {
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    nativePath: photo?.path || null,
    nativeMimeType: photo?.mimeType || null,
  };

  try {
    // FAST PATH: Extract EXIF natively without loading the file into JS memory
    const exif = window.Capacitor?.Plugins?.FilePicker?.getExif ? await FilePicker.getExif({ path: photo.path }) : null;
    if (exif) {
      dbg.nativeExif = JSON.stringify(exif);
      const rawNativeGps = _extractLatLonFromRawGps(exif);
      if (rawNativeGps.lat !== null) lat = rawNativeGps.lat;
      if (rawNativeGps.lon !== null) lon = rawNativeGps.lon;

      const dt = _coerceExifDate(exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate || photo.capturedAt);
      if (dt) time = dt.getTime();

      // If native extraction found the coordinates, return immediately! (Lightning fast)
      if (lat !== null && lon !== null) {
        return { time, lat, lon, dbg };
      }
    }
  } catch (err) {
    console.warn('Native EXIF extraction failed, trying JS fallback:', err);
  }

  // SLOW PATH: Only run the JS fallback if native EXIF failed or lacked GPS
  try {
    const jsExif = await _captureExif(file);
    if (jsExif.lat !== null) lat = jsExif.lat;
    if (jsExif.lon !== null) lon = jsExif.lon;
    if (jsExif.time) time = jsExif.time;
    dbg.jsFallback = true;
  } catch (err) {
    console.warn('JS EXIF extraction fallback failed:', err);
  }

  return { time, lat, lon, dbg };
}

async function _captureExif(file) {
  const exifr = await _getExifr();
  let time = file.lastModified;
  let lat  = null;
  let lon  = null;
  let dbg  = { fileName: file.name, fileSize: file.size, fileType: file.type, bufSize: 0, gpsResult: null, gpsError: null, exifError: null };
  const fullRead = _isHeicLike(file) ? { chunked: false } : {};

  const setGps = (res) => {
    if (res && typeof res.latitude === 'number' && !Number.isNaN(res.latitude)) lat = res.latitude;
    if (res && typeof res.longitude === 'number' && !Number.isNaN(res.longitude)) lon = res.longitude;
  };

  // Read the full file into an ArrayBuffer before passing to exifr.
  // exifr uses chunked reads in the browser and can miss GPS data in HEIC files
  // if the GPS box falls outside the initial chunk window.
  // Optimization: Read only the first 2MB instead of the entire 10MB+ file
  let buf;
  try {
    buf = await file.slice(0, 2 * 1024 * 1024).arrayBuffer();
    dbg.bufSize = buf.byteLength;
  } catch (e) {
    dbg.bufError = String(e);
    console.warn('[EXIF] arrayBuffer() failed:', e);
    return { time, lat, lon, dbg };
  }

  // Try the original File first. exifr officially supports HEIC/HEIF blobs/files,
  // and this path lets it follow container pointers itself instead of depending on
  // our manual buffer strategy.
  try {
    const exif = await exifr.parse(file, { pick: EXIF_DATETIME_PICK, ...fullRead });
    const dt = exif?.DateTimeOriginal || exif?.CreateDate || exif?.ModifyDate;
    if (dt instanceof Date) time = dt.getTime();
    dbg.exifFile = exif ? JSON.stringify(exif) : 'null';
  } catch (e) {
    dbg.exifFileError = String(e);
    console.warn('[EXIF] parseExif(file) failed:', e);
  }

  try {
    const exif = await exifr.parse(buf, { pick: EXIF_DATETIME_PICK });
    const dt = exif?.DateTimeOriginal || exif?.CreateDate || exif?.ModifyDate;
    if (dt instanceof Date) time = dt.getTime();
  } catch (e) {
    dbg.exifError = String(e);
    console.warn('[EXIF] parseExif(buffer) failed:', e);
  }

  // Try parseGps() first; fall back to parse({gps:true}) for formats where gps() alone may fail
  try {
    const gpsResult = await exifr.gps(file, fullRead);
    dbg.gpsResult = gpsResult ? JSON.stringify(gpsResult) : 'null';
    setGps(gpsResult);
  } catch (e) {
    dbg.gpsError = String(e);
    console.warn('[EXIF] parseGps(file) failed:', e);
  }

  if (lat === null) {
    try {
      const gpsResult = await exifr.gps(buf);
      dbg.gpsBufferResult = gpsResult ? JSON.stringify(gpsResult) : 'null';
      setGps(gpsResult);
    } catch (e) {
      dbg.gpsBufferError = String(e);
      console.warn('[EXIF] parseGps(buffer) failed:', e);
    }
  }

  // Second attempt using parse({gps:true}) if parseGps returned nothing
  if (lat === null) {
    try {
      const fallback = await exifr.parse(file, { gps: true, tiff: true, xmp: true, ...fullRead });
      dbg.gpsFallback = fallback ? JSON.stringify(fallback) : 'null';
      setGps(fallback);
    } catch (e) {
      dbg.gpsFallbackError = String(e);
      console.warn('[EXIF] parse(file, {gps:true}) fallback failed:', e);
    }
  }

  if (lat === null) {
    try {
      const fallback = await exifr.parse(buf, { gps: true, tiff: true, xmp: true });
      dbg.gpsBufferFallback = fallback ? JSON.stringify(fallback) : 'null';
      setGps(fallback);
    } catch (e) {
      dbg.gpsBufferFallbackError = String(e);
      console.warn('[EXIF] parse(buffer, {gps:true}) fallback failed:', e);
    }
  }

  // Last attempt: read raw GPS tags and convert them ourselves, mirroring the
  // Python app's HEIC path where we decode GPS IFD data and then derive decimal coords.
  if (lat === null) {
    try {
      const rawGps = await exifr.parse(file, {
        pick: RAW_GPS_PICK,
        gps: true,
        tiff: true,
        reviveValues: false,
        translateValues: false,
        ...fullRead,
      });
      dbg.rawGpsFile = rawGps ? JSON.stringify(rawGps) : 'null';
      const extracted = _extractLatLonFromRawGps(rawGps);
      setGps({ latitude: extracted.lat, longitude: extracted.lon });
    } catch (e) {
      dbg.rawGpsFileError = String(e);
      console.warn('[EXIF] raw GPS file parse failed:', e);
    }
  }

  if (lat === null) {
    try {
      const rawGps = await exifr.parse(buf, {
        pick: RAW_GPS_PICK,
        gps: true,
        tiff: true,
        reviveValues: false,
        translateValues: false,
      });
      dbg.rawGpsBuffer = rawGps ? JSON.stringify(rawGps) : 'null';
      const extracted = _extractLatLonFromRawGps(rawGps);
      setGps({ latitude: extracted.lat, longitude: extracted.lon });
    } catch (e) {
      dbg.rawGpsBufferError = String(e);
      console.warn('[EXIF] raw GPS buffer parse failed:', e);
    }
  }

  return { time, lat, lon, dbg };
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

  // 2. heic2any path (handles HEIC/HEIF on Android Chrome since native conversion is iOS only)
  if (_isHeicLike(file)) {
    try {
      const heic2any = (await import('heic2any')).default;
      let result = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.88 });
      if (Array.isArray(result)) result = result[0];
      const url = URL.createObjectURL(result);
      return { blob: result, url };
    } catch (err) {
      console.warn('heic2any failed:', err);
    }
  }

  // 3. Final fallback — original file (will show blank if browser can't decode it)
  return { blob: file, url: URL.createObjectURL(file) };
}

// Save a single session immediately and return the new observation ID.
async function _saveSingleAndOpen(session) {
  try {
    if (!session.locationName && session.gpsLat !== null && session.gpsLon !== null) {
      session.locationName = await _reverseGeocode(session.gpsLat, session.gpsLon)
        || `${session.gpsLat.toFixed(4)}° N, ${session.gpsLon.toFixed(4)}° E`;
    }

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
      try {
        await uploadObservationImageVariants(session.files[i], path);
      } catch (upErr) {
        console.error('upload error', upErr);
        continue;
      }
      await supabase.from('observation_images').insert({
        observation_id: obsId,
        user_id: state.user.id,
        storage_path: path,
        image_type: 'field',
        sort_order: i,
      });
    }

    session.blobUrls.forEach(url => URL.revokeObjectURL(url));

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

  list.querySelectorAll('.import-current-location-btn[data-sid]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sid = btn.dataset.sid;
      const session = sessionById(sid);
      if (!session) return;
      if (!state.gps) {
        showToast('Current GPS unavailable');
        return;
      }
      if (session.locationName) {
        const confirmed = window.confirm('Current location will overwrite the EXIF location. Continue?');
        if (!confirmed) return;
      }
      const name = await _reverseGeocode(state.gps.lat, state.gps.lon);
      session.gpsLat = state.gps.lat;
      session.gpsLon = state.gps.lon;
      session.locationName = name || `${state.gps.lat.toFixed(4)}° N, ${state.gps.lon.toFixed(4)}° E`;
      saveImportSessions(sessions);
      renderSessions();
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
  const heicWithoutGps = session.gpsLat === null && (session.exifDebug || []).some(d =>
    /\.(heic|heif)$/i.test(d?.fileName || '') || /heic|heif/i.test(d?.fileType || '')
  );
  const missingGpsHint = heicWithoutGps
    ? `<div class="import-location-hint">No photo GPS found in this HEIC. On some iPhone web uploads, location metadata is not exposed to the browser.</div>`
    : '';

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
        data-sid="${sid}" placeholder="—" readonly
        value="${locVal}">
      ${missingGpsHint}
      <button class="ai-id-btn import-current-location-btn" data-sid="${sid}" style="margin-top:8px">Set from GPS</button>
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
  <input type="hidden" class="import-lat-input" data-sid="${sid}" value="${session.gpsLat ?? ''}">
  <input type="hidden" class="import-lon-input" data-sid="${sid}" value="${session.gpsLon ?? ''}">
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
        const predictions = await runArtsorakelForBlobs(session.files, 'nb')
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
        try {
          await uploadObservationImageVariants(session.files[i], path);
        } catch (uploadError) {
          console.error('Image upload error:', uploadError);
          continue;
        }
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

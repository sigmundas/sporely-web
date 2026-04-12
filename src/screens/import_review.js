import { state } from '../state.js';
import { formatDate, formatTime, getTaxonomyLanguage, t, tp, translateVisibility } from '../i18n.js';
import { navigate } from '../router.js';
import { showToast } from '../toast.js';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Filesystem } from '@capacitor/filesystem';
import { FilePicker } from '@capawesome/capacitor-file-picker';
import { searchTaxa, formatDisplayName, runArtsorakelForBlobs } from '../artsorakel.js';
import { enqueueObservation } from '../sync-queue.js';
import { openFinds } from './finds.js';
import { openImportedReview } from './review.js';
import { saveImportSessions, clearImportSessions } from '../import-store.js';
import { openAiCropEditor } from '../ai-crop-editor.js';
import { createImageCropMeta, hasAiCropRect } from '../image_crop.js';

let sessions = [];
let expandedSessionIds = new Set();
let sourceItems = [];
let exifrModulePromise = null;
const EXIF_DATETIME_PICK = ['DateTimeOriginal', 'CreateDate', 'ModifyDate'];
const RAW_GPS_PICK = ['GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef', 'latitude', 'longitude'];
const IMPORT_AI_MAX_EDGE = 1920;

function _persistSessions() {
  saveImportSessions(sessions);
}

function _getPhotoGapMinutes() {
  return Math.max(1, Math.min(120, parseInt(localStorage.getItem('sporely-photo-gap')) || 1));
}

function _disposeSessionBlobUrls(items = sessions) {
  (items || []).forEach(session => {
    (session?.blobUrls || []).forEach(url => URL.revokeObjectURL(url));
  });
}

function _groupSourceItems(items, gapMs) {
  if (!items.length) return [];
  const grouped = [[items[0]]];
  for (let i = 1; i < items.length; i++) {
    const prev = grouped[grouped.length - 1];
    const gap = items[i].captureTime - prev[prev.length - 1].captureTime;
    if (gap <= gapMs) prev.push(items[i]);
    else grouped.push([items[i]]);
  }
  return grouped;
}

function _groupKey(items) {
  return (items || []).map(item => item.id).join('|');
}

function _buildSessionsFromSourceItems() {
  const previousByKey = new Map(
    sessions.map(session => [_groupKey((session.sourceItemIds || []).map(id => ({ id }))), session])
  );
  const gapMs = _getPhotoGapMinutes() * 60_000;
  const grouped = _groupSourceItems(sourceItems, gapMs);

  _disposeSessionBlobUrls(sessions);

  sessions = grouped.map((group, idx) => {
    const key = _groupKey(group);
    const previous = previousByKey.get(key);
    const exifGps = group.find(item => item.lat !== null && item.lon !== null);
    return {
      id: previous?.id || `s${idx}`,
      sourceItemIds: group.map(item => item.id),
      files: group.map(item => item.blob),
      aiFiles: group.map(item => item.aiBlob || item.blob),
      blobUrls: group.map(item => URL.createObjectURL(item.blob)),
      imageMeta: group.map(item => item.meta),
      photoTimes: group.map(item => item.captureTime),
      photoGps: group.map(item => ({ lat: item.lat, lon: item.lon })),
      photoDebug: group.map(item => item.dbg || null),
      ts: new Date(group[0].captureTime),
      gpsLat: exifGps?.lat ?? null,
      gpsLon: exifGps?.lon ?? null,
      locationName: previous?.locationName || '',
      taxon: previous?.taxon || null,
      visibility: previous?.visibility || 'friends',
      exifDebug: group.map(item => item.dbg).filter(Boolean),
    };
  });
}

function _flattenSourceItemsFromSessions(savedSessions) {
  let fallbackCounter = 0;
  return (savedSessions || []).flatMap(session =>
    (session.files || []).map((blob, index) => ({
      id: session.sourceItemIds?.[index] || `restored-${fallbackCounter++}`,
      blob,
      aiBlob: session.aiFiles?.[index] instanceof Blob ? session.aiFiles[index] : blob,
      meta: session.imageMeta?.[index] || {
        aiCropRect: null,
        aiCropSourceW: null,
        aiCropSourceH: null,
      },
      captureTime: session.photoTimes?.[index] || session.ts?.getTime?.() || Date.now(),
      lat: session.photoGps?.[index]?.lat ?? null,
      lon: session.photoGps?.[index]?.lon ?? null,
      dbg: session.photoDebug?.[index] || null,
    }))
  );
}

function _ensureSessionImageMeta(session) {
  if (!session) return [];
  if (!Array.isArray(session.imageMeta)) session.imageMeta = [];
  while (session.imageMeta.length < session.files.length) {
    session.imageMeta.push({
      aiCropRect: null,
      aiCropSourceW: null,
      aiCropSourceH: null,
    });
  }
  return session.imageMeta;
}

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
  const gapInput = document.getElementById('import-gap-input');
  if (gapInput) {
    gapInput.addEventListener('change', () => {
      const value = Math.max(1, Math.min(120, parseInt(gapInput.value) || 1));
      gapInput.value = value;
      localStorage.setItem('sporely-photo-gap', String(value));
      const settingsGapInput = document.getElementById('settings-gap-input');
      if (settingsGapInput) settingsGapInput.value = value;
      if (!sourceItems.length) return;
      expandedSessionIds = new Set();
      _buildSessionsFromSourceItems();
      if (sessions.length === 1) {
        const session = sessions[0];
        session.blobUrls.forEach(url => URL.revokeObjectURL(url));
        sessions = [];
        expandedSessionIds = new Set();
        sourceItems = [];
        clearImportSessions();
        openImportedReview(session);
        return;
      }
      if (!sessions.length) {
        clearImportSessions();
        navigate('home');
        return;
      }
      _persistSessions();
      renderSessions();
      _prefillSessionLocations();
    });
  }
}

function _cancelImport() {
  _disposeSessionBlobUrls();
  clearImportSessions();
  sessions = [];
  expandedSessionIds = new Set();
  sourceItems = [];
  navigate('home');
}

// Restore a previously-saved import session (app was killed mid-review)
export function restoreImportSessions(savedSessions) {
  sessions = savedSessions;
  sourceItems = _flattenSourceItemsFromSessions(savedSessions);
  expandedSessionIds = new Set(savedSessions.map(session => session.id));
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

      _setProgress(0, photos.length, t('import.readingFiles'));

      const files = [];
      for (let i = 0; i < photos.length; i++) {
        _setProgress(i, photos.length, t('import.importingFile', { current: i + 1, total: photos.length }));
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

  _setProgress(0, files.length, t('import.readingTimestamps'));

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

  // Convert to JPEG sequentially — avoids exhausting mobile memory with parallel decodes.
  _disposeSessionBlobUrls();
  sessions = [];
  expandedSessionIds = new Set();
  sourceItems = [];
  let doneCount = 0;
  for (let idx = 0; idx < withTimes.length; idx++) {
    const item = withTimes[idx];
    _setProgress(doneCount, files.length, t('import.convertingFile', { current: doneCount + 1, total: files.length }));
    const processed = await _processFile(item.file);
    sourceItems.push({
      id: `i${idx}`,
      blob: processed.blob,
      aiBlob: processed.aiBlob || processed.blob,
      meta: processed.meta,
      captureTime: item.captureTime,
      lat: item.lat ?? null,
      lon: item.lon ?? null,
      dbg: item.dbg || null,
    });
    doneCount++;
  }

  _buildSessionsFromSourceItems();

  _hideProgress();

  // Single group → open the same Review screen as camera capture.
  if (sessions.length === 1) {
    const session = sessions[0];
    session.blobUrls.forEach(url => URL.revokeObjectURL(url));
    sessions = [];
    expandedSessionIds = new Set();
    sourceItems = [];
    openImportedReview(session);
    return;
  }

  // Persist to IndexedDB so state survives app suspension
  _persistSessions()

  navigate('import-review');
  renderSessions();
  _prefillSessionLocations();
}

// ── Progress overlay ─────────────────────────────────────────────────────────
function _setProgress(done, total, label) {
  const overlay = document.getElementById('import-progress');
  if (!overlay) return;
  overlay.style.display = 'flex';
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  document.getElementById('import-progress-fill').style.width = pct + '%';
  document.getElementById('import-progress-label').textContent = label || t('import.processing');
}

function _hideProgress() {
  const overlay = document.getElementById('import-progress');
  if (overlay) overlay.style.display = 'none';
}

function _prefillSessionLocations() {
  sessions.forEach(async session => {
    if (session.gpsLat === null || session.locationName) return;
    const name = await _reverseGeocode(session.gpsLat, session.gpsLon);
    if (name && !session.locationName) {
      session.locationName = name;
      const input = document.querySelector(`.import-loc-input[data-sid="${session.id}"]`);
      const locEl = document.querySelector(`.import-card[data-sid="${session.id}"] .import-card-loc`);
      if (input) input.value = name;
      if (locEl) locEl.textContent = name;
      _persistSessions();
    }
  });
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
// If that fails (e.g. Android Chrome / desktop browsers can't decode HEIC),
// we fall back to the original file. The native plugin now handles HEIC-to-JPEG conversion
// during import on Android/iOS.
async function _processFile(file) {
  // 1. Canvas path (fast — works for JPEG/PNG/WebP; also HEIC on iOS/macOS Safari)
  try {
    const { blob, aiBlob } = await _toJpeg(file);
    const url = URL.createObjectURL(blob);
    const meta = await createImageCropMeta(blob, { preseed: true });
    return { blob, aiBlob, url, meta };
  } catch (_) {}

  // 2. Final fallback — original file (will show blank if browser can't decode it)
  const meta = await createImageCropMeta(file, { preseed: true }).catch(() => ({
    aiCropRect: null,
    aiCropSourceW: null,
    aiCropSourceH: null,
  }));
  return { blob: file, aiBlob: file, url: URL.createObjectURL(file), meta };
}

export function renderSessions() {
  const list = document.getElementById('import-session-list');
  const countEl = document.getElementById('import-session-count');
  const groupingControls = document.getElementById('import-grouping-controls');
  const gapInput = document.getElementById('import-gap-input');
  const gapLabel = document.getElementById('import-gap-label');
  const gapUnit = document.getElementById('import-gap-unit');

  const n = sessions.length;
  countEl.textContent = tp('counts.group', n);
  if (gapLabel) gapLabel.textContent = t('settings.newObservationAfter');
  if (gapUnit) gapUnit.textContent = document.querySelector('#settings-sheet .settings-gap-unit')?.textContent || 'min';
  if (gapInput) gapInput.value = _getPhotoGapMinutes();
  if (groupingControls) groupingControls.style.display = n > 1 ? 'block' : 'none';

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
        expandedSessionIds.delete(sid);
      } else {
        expanded.style.display = 'block';
        expandedSessionIds.add(sid);
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
        const removeIds = new Set(session.sourceItemIds || []);
        sourceItems = sourceItems.filter(item => !removeIds.has(item.id));
        expandedSessionIds.delete(sid);
        _buildSessionsFromSourceItems();
        if (!sessions.length) clearImportSessions();
        else _persistSessions();
        renderSessions();
        _prefillSessionLocations();
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
      const removeId = session.sourceItemIds?.[idx];
      if (removeId) {
        sourceItems = sourceItems.filter(item => item.id !== removeId);
      }
      if (session.files.length <= 1) expandedSessionIds.delete(sid);
      _buildSessionsFromSourceItems();
      if (!sessions.length) clearImportSessions();
      else _persistSessions();
      renderSessions();
      _prefillSessionLocations();
    });
  });

  list.querySelectorAll('.import-vis-radio[data-sid]').forEach(input => {
    input.addEventListener('change', () => {
      const s = sessionById(input.dataset.sid);
      if (s) s.visibility = input.value;
      _persistSessions();
    });
  });

  list.querySelectorAll('.import-card-expanded[data-sid]').forEach(expanded => {
    const sid = expanded.dataset.sid;
    const isOpen = expandedSessionIds.has(sid);
    expanded.style.display = isOpen ? 'block' : 'none';
    if (isOpen) _wireCard(sid);
  });
}

function buildCardHTML(session) {
  const sid = session.id;
  const dateStr = formatDate(session.ts, { month: 'short', day: 'numeric' });
  const timeStr = formatTime(session.ts, { hour: '2-digit', minute: '2-digit' });
  const photoCount = session.files.length;
  const imageMeta = _ensureSessionImageMeta(session);
  const croppedCount = imageMeta.filter(meta => hasAiCropRect(meta?.aiCropRect)).length;
  const speciesText = session.taxon
    ? escHtml(session.taxon.displayName)
    : `<span style="opacity:0.45">${t('detail.unknownSpecies')}</span>`;

  const stackImgs = session.blobUrls.slice(0, 3);
  const polaroids = stackImgs.map((url, i) =>
    `<div class="polaroid-print polaroid-p${i}"><img src="${escHtml(url)}"></div>`
  ).join('');

  const stripItems = session.blobUrls.map((url, i) =>
    `<div class="import-strip-item" data-sid="${sid}" data-idx="${i}">
      <img src="${escHtml(url)}" class="import-strip-thumb" loading="lazy">
      ${hasAiCropRect(imageMeta[i]?.aiCropRect) ? '<div class="ai-crop-thumb-badge">AI crop</div>' : ''}
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
    ? `<div class="import-location-hint">${t('import.noHeicGps')}</div>`
    : '';

  return `<div class="import-card" data-sid="${sid}">
  <div class="import-card-main" data-sid="${sid}">
    <div class="polaroid-stack">
      ${polaroids}
    </div>
    <div class="import-card-info">
      <div class="import-card-datetime"><span>${dateStr}</span><span>${timeStr} · ${tp('counts.photo', photoCount)}</span></div>
      <div class="import-card-loc">${session.locationName ? escHtml(session.locationName) : '—'}</div>
      <div class="import-card-species">${speciesText}</div>
      <div class="import-card-crop-status">${croppedCount ? t('crop.statusSome', { cropped: croppedCount, total: photoCount }) : t('crop.noCropHint')}</div>
    </div>
    <button class="import-card-delete" data-sid="${sid}" aria-label="${t('common.delete')}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
    </button>
  </div>
  <div class="import-card-expanded" data-sid="${sid}" style="display:none">
    <div class="import-photo-strip">
      ${stripItems}
    </div>
    <div class="detail-field" style="margin-top:12px">
      <div class="detail-field-label">${t('detail.species')}</div>
      <div class="taxon-field-wrap">
        <input class="taxon-input import-taxon-input" type="text" placeholder="${t('detail.unknownSpecies')}"
          data-sid="${sid}" autocomplete="off" spellcheck="false"
          value="${taxonVal}">
        <ul class="taxon-dropdown import-taxon-dropdown" data-sid="${sid}" style="display:none"></ul>
      </div>
      <button class="ai-id-btn-import" data-sid="${sid}">
        <div class="ai-dot"></div> ${t('detail.identifyAI')}
      </button>
      <div class="ai-results-import" data-sid="${sid}" style="display:none"></div>
    </div>
    <div class="detail-field" style="margin-top:4px">
      <div class="detail-field-label">${t('detail.location')}</div>
      <input class="detail-text-input import-loc-input" type="text"
        data-sid="${sid}" placeholder="—" readonly
        value="${locVal}">
      ${missingGpsHint}
    </div>
    <div class="detail-field" style="margin-top:4px">
      <div class="detail-field-label">${t('detail.sharing')}</div>
      <div class="vis-radio-group">
        <label class="vis-option"><input type="radio" class="import-vis-radio" name="vis-${sid}" data-sid="${sid}" value="private" ${visChecked('private')}> <span>${translateVisibility('private')}</span></label>
        <label class="vis-option"><input type="radio" class="import-vis-radio" name="vis-${sid}" data-sid="${sid}" value="friends" ${visChecked('friends')}> <span>${translateVisibility('friends')}</span></label>
        <label class="vis-option"><input type="radio" class="import-vis-radio" name="vis-${sid}" data-sid="${sid}" value="public" ${visChecked('public')}> <span>${translateVisibility('public')}</span></label>
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
  _ensureSessionImageMeta(sessionById(sid));

  let debounceTimer = null;

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (!q) { dropdown.style.display = 'none'; dropdown.innerHTML = ''; return; }
    debounceTimer = setTimeout(async () => {
      try {
        const results = await searchTaxa(q, getTaxonomyLanguage());
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
              _persistSessions();
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
  card.querySelectorAll(`.import-strip-item[data-sid="${sid}"]`).forEach(item => {
    if (item._wired) return
    item._wired = true
    item.addEventListener('click', event => {
      if (event.target.closest('.import-strip-delete')) return
      const session = sessionById(sid)
      if (!session) return
      const startIndex = parseInt(item.dataset.idx, 10) || 0
      _openSessionCropEditor(session, startIndex)
    })
  })
  if (aiBtn && aiResults && !aiBtn._wired) {
    aiBtn._wired = true
    aiBtn.addEventListener('click', async () => {
      const session = sessionById(sid)
      if (!session?.files?.length) return
      aiBtn.disabled = true
      aiBtn.textContent = t('import.identifying')
      try {
        const predictions = await runArtsorakelForBlobs(
          session.files.map((blob, index) => ({
            blob: session.aiFiles?.[index] instanceof Blob ? session.aiFiles[index] : blob,
            cropRect: session.imageMeta?.[index]?.aiCropRect || null,
          })),
          getTaxonomyLanguage(),
        )
        if (!predictions?.length) {
          aiResults.style.display = 'none'
          showToast(t('review.noMatch'))
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
            _persistSessions()
            input.value = p.displayName
            aiResults.style.display = 'none'
          })
        })
      } catch (err) {
        console.error('Artsorakel AI error:', err)
        if (String(err?.message || '').includes('CORS') || String(err?.message || '').includes('Failed to fetch') || String(err?.message || '').includes('NetworkError')) {
          showToast(t('review.aiUnavailable'))
        } else {
          showToast(t('common.artsorakelError', { message: err.message }))
        }
      } finally {
        aiBtn.disabled = false
        aiBtn.innerHTML = `<div class="ai-dot"></div> ${t('detail.identifyAI')}`
      }
    })
  }
}

function _openSessionCropEditor(session, startIndex = 0) {
  const imageMeta = _ensureSessionImageMeta(session)
  openAiCropEditor({
    title: t('crop.editorTitle'),
    startIndex,
    images: session.blobUrls.map((url, index) => ({
      url,
      aiCropRect: imageMeta[index]?.aiCropRect || null,
    })),
    onChange: (index, nextMeta) => {
      imageMeta[index] = {
        ...imageMeta[index],
        ...nextMeta,
      }
    },
    onClose: committed => {
      if (committed) {
        _persistSessions()
        renderSessions()
      }
    },
  })
}

async function saveAll() {
  const saveBtn = document.getElementById('import-save-btn');
  saveBtn.disabled = true;

  const activeSessions = sessions.filter(s => s.files.length > 0);
  if (!activeSessions.length) {
    saveBtn.disabled = false;
    await openFinds('mine', { resetSearch: true });
    return;
  }

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

      _ensureSessionImageMeta(session);
      await enqueueObservation(obsPayload, session.files.map((blob, index) => ({
        blob,
        aiCropRect: session.imageMeta[index]?.aiCropRect || null,
        aiCropSourceW: session.imageMeta[index]?.aiCropSourceW ?? null,
        aiCropSourceH: session.imageMeta[index]?.aiCropSourceH ?? null,
      })));
      savedCount++;
    } catch (err) {
      console.error('Failed to save session', session.id, err);
      showToast(t('import.failedOneGroup'));
    }
  }

  allBlobUrls.forEach(url => URL.revokeObjectURL(url));
  sessions = [];
  expandedSessionIds = new Set();
  sourceItems = [];
  clearImportSessions();
  if (savedCount > 0) showToast(t('import.saved', { count: tp('counts.observation', savedCount) }));
  saveBtn.disabled = false;
  await openFinds('mine', { resetSearch: true });
}

function _getScaledSize(width, height, maxEdge) {
  if (!width || !height || !maxEdge) return { width, height };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function _canvasToJpegBlob(img, width, height, quality = 0.88) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('Canvas context unavailable'));
      return;
    }

    ctx.drawImage(img, 0, 0, width, height);
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      quality,
    );
  });
}

// Convert any image file to JPEG blobs via Canvas.
// Returns both the full-resolution upload blob and an AI-safe preview blob.
// Works for JPEG, PNG, WebP, and HEIC on platforms that can decode it (iOS/macOS Safari).
function _toJpeg(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = async () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) {
          reject(new Error('zero dimensions — format not supported by this browser'));
          return;
        }

        const aiSize = _getScaledSize(w, h, IMPORT_AI_MAX_EDGE);
        const aiBlob = await _canvasToJpegBlob(img, aiSize.width, aiSize.height, 0.88);
        if (aiSize.width === w && aiSize.height === h) {
          resolve({ blob: aiBlob, aiBlob });
          return;
        }

        const blob = await _canvasToJpegBlob(img, w, h, 0.88);
        resolve({ blob, aiBlob });
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(url);
      }
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

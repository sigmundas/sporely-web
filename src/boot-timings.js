// Startup-instrumentation for Stage A of the cold-start / offline work.
//
// This module is intentionally tiny and synchronous:
//
//   - It captures a `t0` at module load with `performance.now()`. Every mark
//     is stored as an offset from `t0` so timings are monotonic even if the
//     wall clock jumps mid-boot.
//   - `mark(name)` records the elapsed time for a named phase. If the same
//     name is marked more than once the module keeps every occurrence so
//     callers can measure repeat phases (for example header-profile refresh)
//     without silently overwriting each other.
//   - `measure(from, to)` returns the delta between the last occurrence of
//     `from` and the last occurrence of `to`. Returns `null` if either mark
//     is missing.
//   - `snapshot()` returns a plain data blob: `{ t0Ms, marks, measures }`.
//     Consumers (debug dashboard, `window.__sporelyBoot`) copy the data —
//     the internal store is never handed out by reference.
//
// The module deliberately performs NO async I/O, no network calls, no
// storage writes and no user-identifying data collection. The only things it
// records are phase names, monotonic timestamps, and optional numeric extras
// (for example a chunk-size hint).

const _t0 = _now()
const _marks = []
const _measures = []

function _now() {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now()
    }
  } catch (_) { /* ignore */ }
  return Date.now()
}

function _relative() {
  return _now() - _t0
}

export function mark(name, extra) {
  if (!name) return null
  const at = _relative()
  const entry = {
    name: String(name),
    at,
  }
  if (extra !== undefined && extra !== null) {
    // Only accept plain-data extras so we cannot capture DOM nodes / promises.
    if (typeof extra === 'number' || typeof extra === 'string' || typeof extra === 'boolean') {
      entry.extra = extra
    } else if (typeof extra === 'object') {
      try {
        entry.extra = JSON.parse(JSON.stringify(extra))
      } catch (_) { /* ignore un-serializable extras */ }
    }
  }
  _marks.push(entry)
  return entry
}

function _findLast(name) {
  for (let i = _marks.length - 1; i >= 0; i -= 1) {
    if (_marks[i].name === name) return _marks[i]
  }
  return null
}

export function measure(from, to) {
  const fromMark = _findLast(from)
  const toMark = _findLast(to)
  if (!fromMark || !toMark) return null
  const delta = toMark.at - fromMark.at
  const measurement = { name: `${from}→${to}`, from, to, delta }
  _measures.push(measurement)
  return measurement
}

export function snapshot() {
  return {
    t0Ms: _t0,
    marks: _marks.map(entry => ({ ...entry })),
    measures: _measures.map(entry => ({ ...entry })),
  }
}

// Convenience: expose the live snapshot on window for dev inspection. This is
// a getter so callers always see the current view without keeping a stale
// reference. The property is safe on any platform because `snapshot()` is
// synchronous and returns copies.
try {
  if (typeof globalThis !== 'undefined') {
    Object.defineProperty(globalThis, '__sporelyBoot', {
      configurable: true,
      enumerable: false,
      get() {
        return snapshot()
      },
    })
  }
} catch (_) { /* ignore — read-only globals on some hosts */ }

// Reset hook for tests only. Not exported from any user-facing entry point.
export function _resetForTests() {
  _marks.length = 0
  _measures.length = 0
}

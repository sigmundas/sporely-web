// Lightweight camera-startup timing for DevTools. Cheap when disabled: only
// records into a bounded in-memory array; console/performance-timeline
// output is gated by localStorage.
//
// DevTools usage:
//   localStorage.setItem('sporely-debug-camera-timing', '1')  // enable
//   // click a camera-launch button, then in the console:
//   __sporelyCameraTiming.last()       // console.table of the last run
//   __sporelyCameraTiming.runs         // all recorded runs
//   __sporelyCameraTiming.clear()      // wipe
//   __sporelyCameraTiming.disable()    // stop future runs
//
// The performance.mark/measure calls are ALSO always emitted (they cost
// microseconds), so they show up in the DevTools Performance tab even
// when console logging is off. Filter for "camera:*" in the timeline.

const STORAGE_KEY = 'sporely-debug-camera-timing'
const MAX_RUNS = 32
const MAX_STEPS_PER_RUN = 128

const runs = []
let activeRun = null

function _consoleEnabled() {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === '1'
      || globalThis.sessionStorage?.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function _now() {
  const perf = globalThis.performance
  return typeof perf?.now === 'function' ? perf.now() : Date.now()
}

function _perfMark(name) {
  try {
    globalThis.performance?.mark?.(name)
  } catch {}
}

function _perfMeasure(name, startMark, endMark) {
  try {
    globalThis.performance?.measure?.(name, startMark, endMark)
  } catch {}
}

/** Start a new camera-startup timing run. Any prior open run is closed. */
export function startCameraTimingRun(source, details = {}) {
  if (activeRun) endCameraTimingRun('interrupted')
  const startedAt = _now()
  activeRun = {
    id: `run-${runs.length + 1}`,
    source: String(source || 'unknown'),
    details: { ...details },
    startedAt,
    endedAt: null,
    ended: false,
    steps: [],
  }
  const mark = `camera:${activeRun.source}:start`
  _perfMark(mark)
  markCameraStep('start', { source: activeRun.source, ...details })
  runs.push(activeRun)
  while (runs.length > MAX_RUNS) runs.shift()
  if (_consoleEnabled()) {
    console.log(`[camera-timing] ▶ ${activeRun.source}`, details)
  }
  return activeRun
}

/** Add a step to the current run (no-op if none is open). */
export function markCameraStep(label, details = {}) {
  if (!activeRun) return
  if (activeRun.steps.length >= MAX_STEPS_PER_RUN) return
  const now = _now()
  const prev = activeRun.steps[activeRun.steps.length - 1]
  const step = {
    label: String(label || 'step'),
    at: now,
    sinceStart: +(now - activeRun.startedAt).toFixed(1),
    delta: +(now - (prev ? prev.at : activeRun.startedAt)).toFixed(1),
    details,
  }
  activeRun.steps.push(step)
  const markName = `camera:${activeRun.source}:${step.label}`
  _perfMark(markName)
  if (activeRun.steps.length > 1) {
    const prevMark = `camera:${activeRun.source}:${prev.label}`
    _perfMeasure(`camera:${activeRun.source}:${prev.label}→${step.label}`, prevMark, markName)
  }
  if (_consoleEnabled()) {
    const pad = String(step.sinceStart).padStart(7)
    const delta = String(step.delta).padStart(6)
    console.log(`[camera-timing] +${pad}ms (Δ${delta}ms) ${step.label}`, details)
  }
}

/** Close the current run and (if console logging is on) print a table. */
export function endCameraTimingRun(reason = 'done', details = {}) {
  if (!activeRun) return null
  const finishedAt = _now()
  markCameraStep(`end:${reason}`, details)
  activeRun.endedAt = finishedAt
  activeRun.ended = true
  activeRun.totalMs = +(finishedAt - activeRun.startedAt).toFixed(1)
  const run = activeRun
  activeRun = null
  const startMark = `camera:${run.source}:start`
  const endMark = `camera:${run.source}:end:${reason}`
  _perfMeasure(`camera:${run.source}:total`, startMark, endMark)
  if (_consoleEnabled()) {
    console.log(`[camera-timing] ■ ${run.source} total=${run.totalMs}ms (${reason})`)
    _printRunTable(run)
  }
  return run
}

function _printRunTable(run) {
  if (!run) return
  const rows = run.steps.map(step => ({
    label: step.label,
    'ms since start': step.sinceStart,
    'Δ ms': step.delta,
    details: Object.keys(step.details || {}).length ? step.details : '',
  }))
  try {
    console.table(rows)
  } catch {
    console.log(rows)
  }
}

const controller = {
  runs,
  get active() {
    return activeRun
  },
  enable() {
    try { globalThis.localStorage?.setItem(STORAGE_KEY, '1') } catch {}
    return 'camera timing console output ENABLED'
  },
  disable() {
    try { globalThis.localStorage?.removeItem(STORAGE_KEY) } catch {}
    return 'camera timing console output disabled (marks still recorded)'
  },
  last() {
    const run = runs[runs.length - 1]
    if (!run) {
      console.log('[camera-timing] no runs recorded')
      return null
    }
    console.log(`[camera-timing] ${run.source} total=${run.totalMs ?? '(in flight)'}ms`)
    _printRunTable(run)
    return run
  },
  clear() {
    runs.length = 0
    activeRun = null
    return 'cleared'
  },
}

try {
  if (typeof globalThis !== 'undefined') {
    globalThis.__sporelyCameraTiming = controller
  }
} catch {}

export default controller

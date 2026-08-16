import test from 'node:test'
import assert from 'node:assert/strict'

import { mark, measure, snapshot, _resetForTests } from './boot-timings.js'

test.beforeEach(() => {
  _resetForTests()
})

test('mark records monotonic offsets from module load', () => {
  const first = mark('phase-a')
  const second = mark('phase-b')
  assert.ok(first.at >= 0)
  assert.ok(second.at >= first.at, 'second mark must not go backwards')
  const snap = snapshot()
  assert.equal(snap.marks.length, 2)
  assert.equal(snap.marks[0].name, 'phase-a')
  assert.equal(snap.marks[1].name, 'phase-b')
})

test('mark accepts plain-data extras but silently drops non-plain data', () => {
  mark('with-number', 42)
  mark('with-string', 'ok')
  mark('with-boolean', true)
  mark('with-object', { size: 12, note: 'x' })
  mark('with-fn', () => {})
  const snap = snapshot()
  const byName = Object.fromEntries(snap.marks.map(entry => [entry.name, entry]))
  assert.equal(byName['with-number'].extra, 42)
  assert.equal(byName['with-string'].extra, 'ok')
  assert.equal(byName['with-boolean'].extra, true)
  assert.deepEqual(byName['with-object'].extra, { size: 12, note: 'x' })
  assert.equal('extra' in byName['with-fn'], false)
})

test('measure returns the delta between the last occurrence of each mark', () => {
  mark('start')
  mark('middle')
  mark('start') // second occurrence — measure must anchor on this one
  mark('end')
  const m = measure('start', 'end')
  assert.ok(m, 'measure must return a value when both marks exist')
  assert.equal(m.from, 'start')
  assert.equal(m.to, 'end')
  assert.ok(m.delta >= 0, 'measure delta must be non-negative in this ordering')
  const snap = snapshot()
  assert.equal(snap.measures.length, 1)
})

test('measure returns null when a mark is missing', () => {
  mark('only')
  assert.equal(measure('only', 'nope'), null)
  assert.equal(measure('nope', 'only'), null)
})

test('snapshot returns copies so callers cannot mutate internal state', () => {
  mark('phase-a')
  const first = snapshot()
  first.marks.push({ name: 'sneaky', at: 999 })
  first.marks[0].at = -1
  const second = snapshot()
  assert.equal(second.marks.length, 1)
  assert.equal(second.marks[0].name, 'phase-a')
  assert.notEqual(second.marks[0].at, -1)
})

test('window.__sporelyBoot exposes the live snapshot', () => {
  mark('boot-a')
  const view = globalThis.__sporelyBoot
  assert.ok(view)
  assert.ok(Array.isArray(view.marks))
  assert.ok(view.marks.some(entry => entry.name === 'boot-a'))
})

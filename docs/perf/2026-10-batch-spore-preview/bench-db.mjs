// Database-side work: EXPLAIN (ANALYZE, BUFFERS) for
//   (a) one get_public_observation_spore_previews(ids) call, and
//   (b) one get_public_observation(id) call per id, summed,
// at 30 and 60 ids, as the anon role. LOCAL DATABASE ONLY (seed.sql first).
//
//   node docs/perf/2026-10-batch-spore-preview/bench-db.mjs <db-container> [reps]
//
// With BASELINE_SQL=<file>, every session first runs that file inside a
// transaction that is rolled back at the end (used to measure (b) with the
// pre-20261012100000 get_public_observation definitions).
//
// Each repetition opens a fresh psql backend per case and runs the case twice:
// "cold" is the first run in that backend (function plan caches empty),
// "warm" the second (what a reused PostgREST pool connection sees). Shared
// buffers are warm in both. Buffer counts on the top plan node include every
// nested function call made while that node executes.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const container = process.argv[2]
const reps = Number(process.argv[3] ?? 10)
if (!container) throw new Error('usage: bench-db.mjs <db-container> [reps]')

function psql(sql) {
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

const ids = JSON.parse(psql('SELECT json_agg(observation_id ORDER BY ordinal) FROM perf_bsp.ids;'))
const baseline = process.env.BASELINE_SQL ? readFileSync(process.env.BASELINE_SQL, 'utf8') : null

const explain = (call) => `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM ${call};`
const batchSql = (list) => explain(`public.get_public_observation_spore_previews('{${list.join(',')}}'::bigint[])`)
const singleSql = (id) => explain(`public.get_public_observation(${id})`)

function metrics(doc) {
  const plan = doc.Plan
  return {
    planning: doc['Planning Time'],
    execution: doc['Execution Time'],
    hit: plan['Shared Hit Blocks'] + (doc.Planning?.['Shared Hit Blocks'] ?? 0),
    read: plan['Shared Read Blocks'] + (doc.Planning?.['Shared Read Blocks'] ?? 0),
    rows: plan['Actual Rows'],
  }
}
const sum = (ms) => ms.reduce((acc, m) => ({
  planning: acc.planning + m.planning,
  execution: acc.execution + m.execution,
  hit: acc.hit + m.hit,
  read: acc.read + m.read,
  rows: acc.rows + m.rows,
}), { planning: 0, execution: 0, hit: 0, read: 0, rows: 0 })

// One backend; statements = [...] per run; returns [coldRun, warmRun] metrics.
function runCase(statements) {
  const body = ['SET ROLE anon;', ...statements, ...statements]
  const out = psql((baseline ? ['BEGIN;', baseline, ...body, 'ROLLBACK;'] : body).join('\n'))
  const docs = out.trim().split(/\n(?=\[)/).map((chunk) => JSON.parse(chunk)[0])
  if (docs.length !== statements.length * 2) throw new Error(`expected ${statements.length * 2} plans, got ${docs.length}`)
  const per = docs.map(metrics)
  return [sum(per.slice(0, statements.length)), sum(per.slice(statements.length))]
}

const results = []
for (let rep = 1; rep <= reps; rep++) {
  for (const n of [30, 60]) {
    const list = ids.slice(0, n)
    if (list.length !== n) throw new Error(`need ${n} ids, have ${list.length}`)
    const cases = [
      ['a', [batchSql(list)]],
      ['b', list.map(singleSql)],
    ]
    if (rep % 2 === 0) cases.reverse()
    for (const [label, statements] of cases) {
      const [cold, warm] = runCase(statements)
      results.push({ rep, n, case: label, statements: statements.length, cold, warm })
    }
  }
}

const median = (xs) => {
  const s = [...xs].sort((x, y) => x - y)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const fmt = (x) => x.toFixed(2)

console.log('raw: rep n case statements | cold planning execution hit read rows | warm planning execution hit read rows')
for (const r of results) {
  const c = r.cold
  const w = r.warm
  console.log(`${r.rep} ${r.n} ${r.case} ${r.statements} | ${fmt(c.planning)} ${fmt(c.execution)} ${c.hit} ${c.read} ${c.rows} | ${fmt(w.planning)} ${fmt(w.execution)} ${w.hit} ${w.read} ${w.rows}`)
}
console.log('\nsummary (median / max over reps; times ms, buffers = 8 kB pages)')
console.log('n case run   | planning med/max | execution med/max | shared hit med/max | shared read med/max | rows')
for (const n of [30, 60]) {
  for (const label of ['a', 'b']) {
    for (const run of ['cold', 'warm']) {
      const rs = results.filter((r) => r.n === n && r.case === label).map((r) => r[run])
      const col = (k) => `${fmt(median(rs.map((r) => r[k])))} / ${fmt(Math.max(...rs.map((r) => r[k])))}`
      console.log(`${n} ${label} ${run.padEnd(5)} | ${col('planning')} | ${col('execution')} | ${col('hit')} | ${col('read')} | ${rs[0].rows}`)
    }
  }
}

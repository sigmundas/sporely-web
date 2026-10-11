// Wall-clock time through the local API gateway and PostgREST, as anon:
//   (a)  one POST /rest/v1/rpc/get_public_observation_spore_previews
//   (b)  one POST /rest/v1/rpc/get_public_observation per id, at concurrency
//        6 (OBSERVATION_DETAIL_CONCURRENCY) and 2, the way sporely-landing's
//        Cards view does today (rpcCall: POST, JSON body).
// at 30 and 60 ids. LOCAL ONLY; seed.sql first.
//
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=<local publishable key> \
//     node docs/perf/2026-10-batch-spore-preview/bench-http.mjs '<json id array>' [reps]
//
// With TODAY_RPC=<name> (a renamed copy of the pre-20261011120000
// get_public_observation, see baseline-today.sh), (b) also runs against it as
// "b6t"/"b2t": the single calls exactly as deployed today.
//
// One unrecorded warm-up round runs first. Case order rotates each round.
// A second section repeats (a) and (b) at concurrency 6 with 4 and 8
// simultaneous visitors.
const base = process.env.SUPABASE_URL
const key = process.env.SUPABASE_ANON_KEY
const ids = JSON.parse(process.argv[2] ?? 'null')
const reps = Number(process.argv[3] ?? 15)
if (!base || !key || !Array.isArray(ids)) throw new Error('usage: see header')

async function rpc(name, body) {
  const t0 = performance.now()
  const res = await fetch(`${base}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const rows = await res.json()
  const ms = performance.now() - t0
  if (!res.ok) throw new Error(`${name} ${res.status}: ${JSON.stringify(rows)}`)
  return { ms, rows }
}

async function batch(list) {
  const t0 = performance.now()
  const { rows } = await rpc('get_public_observation_spore_previews', { p_observation_ids: list })
  if (rows.length !== list.length) throw new Error(`batch returned ${rows.length} rows for ${list.length} ids`)
  return { total: performance.now() - t0, perCall: [] }
}

async function singles(list, concurrency, name = 'get_public_observation') {
  const t0 = performance.now()
  const queue = [...list]
  const perCall = []
  let found = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const id = queue.shift()
      const { ms, rows } = await rpc(name, { p_observation_id: id })
      perCall.push(ms)
      found += rows.length
    }
  }))
  if (found !== list.length) throw new Error(`singles returned ${found} rows for ${list.length} ids`)
  return { total: performance.now() - t0, perCall }
}

const cases = []
for (const n of [30, 60]) {
  const list = ids.slice(0, n)
  cases.push({ label: `a  n=${n}`, run: () => batch(list) })
  cases.push({ label: `b6 n=${n}`, run: () => singles(list, 6) })
  cases.push({ label: `b2 n=${n}`, run: () => singles(list, 2) })
  if (process.env.TODAY_RPC) {
    cases.push({ label: `b6t n=${n}`, run: () => singles(list, 6, process.env.TODAY_RPC) })
    cases.push({ label: `b2t n=${n}`, run: () => singles(list, 2, process.env.TODAY_RPC) })
  }
}

for (const c of cases) await c.run() // warm-up, not recorded
const results = new Map(cases.map((c) => [c.label, []]))
for (let rep = 0; rep < reps; rep++) {
  const order = cases.map((_, i) => cases[(i + rep) % cases.length])
  for (const c of order) results.get(c.label).push(await c.run())
}

const median = (xs) => {
  const s = [...xs].sort((x, y) => x - y)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const fmt = (x) => x.toFixed(1)
console.log(`reps=${reps} (after 1 warm-up round); times in ms`)
console.log('case     | requests | total median | total max | per-request median | per-request max | raw totals')
for (const [label, rs] of results) {
  const totals = rs.map((r) => r.total)
  const per = rs.flatMap((r) => r.perCall)
  const requests = label.startsWith('a ') ? 1 : Number(label.split('n=')[1])
  console.log(`${label} | ${String(requests).padStart(8)} | ${fmt(median(totals)).padStart(12)} | ${fmt(Math.max(...totals)).padStart(9)} | ${(per.length ? fmt(median(per)) : fmt(median(totals))).padStart(18)} | ${(per.length ? fmt(Math.max(...per)) : fmt(Math.max(...totals))).padStart(15)} | ${totals.map(fmt).join(' ')}`)
}

// Load: V visitors load the Cards view at the same moment (each runs the case
// once, all V in parallel). Reports each visitor's own wall-clock time.
const visitorCases = cases.filter((c) => !c.label.startsWith('b2'))
console.log('\nload: V simultaneous visitors, per-visitor wall-clock (ms)')
console.log('V  case     | median | max   | client requests in flight at most (not a DB measurement)')
for (const visitors of [4, 8]) {
  const loads = new Map(visitorCases.map((c) => [c.label, []]))
  for (let rep = 0; rep < reps; rep++) {
    const order = visitorCases.map((_, i) => visitorCases[(i + rep) % visitorCases.length])
    for (const c of order) {
      const rs = await Promise.all(Array.from({ length: visitors }, () => c.run()))
      loads.get(c.label).push(...rs.map((r) => r.total))
    }
  }
  for (const [label, totals] of loads) {
    const inFlight = label.startsWith('a ') ? visitors : visitors * 6
    console.log(`${String(visitors).padEnd(2)} ${label} | ${fmt(median(totals)).padStart(6)} | ${fmt(Math.max(...totals)).padStart(5)} | ${inFlight}`)
  }
}

# W2C sparse-registry comparison

## Verdict

Phase A is accepted as a non-exhaustive experimental preload v1. Phase B is
complete. The recommended architecture is **S2: sparse persistent registry plus
a compact replaceable global-macrofungi cache**.

The experiment ran only in disposable local schema
`w2c_sparse_experiment`. It did not create or apply a production migration,
change a client, activate taxonomy-v2, or modify observation rows.

Phase-A input:

```text
desktop revision:       be14e6e28fb00b79a0d05265ef8d6b7008b669bc
release:                tax-2026.08.01-01
scope manifest SHA-256: 72758b2c574e8aea27432b6b55c62dfb6ad87f3fadc11ad1c892a61abf23ac4e
cache concepts:         52,881
```

`review`, `exclude`, and `not_evaluated` mean “not in this cache”, not
“unregisterable”. The preload is not claimed to exhaust global macrofungi.

## Logical model

S1 stores persistent registry concepts, compact source/release rows, completely
namespaced external mappings, names required for registered concepts, and
durable identification snapshots. External mapping uniqueness covers the full
`(source_system, namespace, external_id)` tuple.

Identification snapshots support resolved identity, unresolved external
selection, manual unresolved name, historical unresolved legacy value, and no
identity evidence. Later exact resolution attaches a Sporely ID while leaving
the original selected result, names, rank, raw external ID, and response
provenance unchanged.

S2 adds release-slotted `cache_concept` and `cache_search_name` relations. The
cache stores canonical display/search fields, aliases, selected vernaculars,
minimal classification, COL resolver identity, and scope reason. It does not
own Sporely identity. A measured two-slot replacement left registry concepts,
mappings, and snapshots unchanged.

## Historical-state fixture

The prototype represents the Phase-A audit without name-based resolution:

| State | Rows |
|---|---:|
| Existing resolved stable identities | 0 in historical input |
| Unresolved legacy identity | 227 |
| Manual unresolved identity | 87 |
| No identity evidence | 23 |

Additional registration fixtures prove resolved identity and later trusted
resolution. Historical reconciliation remains a separate required stage before
W3.

## Registration correctness

The experiment proved:

* an exact existing iNaturalist mapping reuses the same Sporely ID;
* equal scientific names with different exact source identities remain two
  concepts;
* the same raw ID in different namespaces remains distinct;
* an unmapped Artsorakel result remains `unresolved_external` with raw
  provenance;
* manual and historical unresolved values remain lossless;
* later exact resolution preserves the complete original snapshot;
* review-state `Trichoderma` (`63W3K`, Sporely ID `86820`) is registered on
  demand but remains absent from the cache;
* scientific-name equality never creates identity.

## S1 storage and growth

Current fixtures contain 7 persistent concepts, 8 mappings, 9 registered names,
and 348 snapshots.

| Scenario | Heap bytes | Index bytes | Total relation bytes |
|---|---:|---:|---:|
| Current historical/flow fixture | 98,304 | 212,992 | 376,832 |
| 337 concepts | 196,608 | 319,488 | 655,360 |
| 10,000 concepts | 3,612,672 | 3,645,440 | 7,397,376 |
| 50,000 concepts | 17,719,296 | 17,571,840 | 35,430,400 |
| 100,000 concepts | 35,348,480 | 34,996,224 | 70,483,968 |

These are measured table/index results, not a linear extrapolation.

## S2 storage and publication peaks

| Component/state | Heap bytes | Index bytes | Total relation bytes |
|---|---:|---:|---:|
| Persistent registry | 98,304 | 212,992 | 376,832 |
| One replaceable cache slot | 9,543,680 | 12,525,568 | 22,142,976 |
| Combined final state | 9,641,984 | 12,738,560 | 22,519,808 |
| Two cache slots | 18,710,528 | 27,222,016 | 46,022,656 |
| Combined measured replacement peak | 18,808,832 | 27,435,008 | 46,399,488 |

Using the independently established 103,304,339-byte production baseline:

| Projection | Bytes |
|---|---:|
| S1 production total | 103,681,171 |
| S2 production total / first publication peak | 125,824,147 |
| S2 future replacement peak | 149,703,827 |
| S2 post-legacy-retirement total | 125,742,227 |
| S2 post-legacy replacement peak | 149,621,907 |
| S2 headroom below 500 MiB | 398,463,853 |
| Replacement-peak headroom below 500 MiB | 374,584,173 |

All formal capacity gates pass. No `VACUUM FULL` or immediate storage-reclaim
assumption is part of the design.

## Cache contents

| Content | Rows |
|---|---:|
| Accepted/include concepts | 52,881 |
| Scientific aliases | 4,888 |
| Vernacular names | 3,923 |
| Minimal COL resolver mappings | 52,881 |
| Review-state concepts | 0 |
| Plants | 0 |
| Selectable non-Fungi | 0 |

## Search performance

Every probe used ten database-side `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`
executions. The evidence JSON retains min/p50/p95/max planning/execution time,
blocks, rows scanned/returned, temporary blocks, and index names.

| Probe | Execution p50 ms | p95 ms | Result rows |
|---|---:|---:|---:|
| Registered canonical exact | 0.061 | 0.076 | 1 |
| Registered canonical prefix | 0.060 | 0.072 | 1 |
| Cache canonical exact | 0.110 | 0.170 | 1 |
| Cache canonical prefix | 0.304 | 0.414 | 20 |
| Scientific alias exact | 0.112 | 0.132 | 1 |
| Scientific alias prefix | 0.108 | 0.136 | 1 |
| Vernacular exact | 0.113 | 0.141 | 1 |
| Vernacular prefix | 0.112 | 0.123 | 1 |
| Broad two-character prefix | 2.139 | 2.240 | 20 |
| No result | 0.094 | 0.162 | 0 |
| Exact COL resolution | 0.037 | 0.044 | 1 |
| Exact NorTaxa fixture | 0.025 | 0.041 | 1 |
| iNaturalist fixture | 0.025 | 0.034 | 1 |
| Artsorakel fixture | 0.024 | 0.029 | 1 |

Cache searches use ordinary expression B-tree prefix indexes. Literal `%`, `_`,
and backslash escaping, the two-character minimum, result limit clamping,
language distinctions, one-result-per-concept behavior, and same-name concept
separation are tested. No trigram index is used.

## S1 versus S2

| Dimension | S1 | S2 |
|---|---|---|
| Cloud footprint | Smallest | 22.5 MiB measured final prototype |
| Unregistered discovery | External only | Cache first, external out-of-cache |
| External outage | Registered taxa/snapshots remain usable | Registered taxa plus global preload remain searchable |
| Autocomplete | Registered concepts only | Fast 52,881-concept macrofungi search |
| Identity | Sparse registry owns identity | Same sparse registry; cache owns no identity |
| Publication | No bulk cache | Replaceable versioned cache slots |
| Maintenance | Provider integration dominant | Provider integration plus versioned preload maintenance |

S2 is recommended because it retains sparse identity/materialization while the
measured cache and two-slot peak are far below the capacity gates. External
providers remain necessary for review-state, excluded, not-evaluated, and future
taxa.

## Failure behavior

Registered concepts and historical snapshots remain usable during provider
outages, rate limits, offline use, changed provider names, disagreement, or
future cache removal. Unmapped results retain raw provenance and remain
unresolved. Manual entry remains possible. No identity is invented from name
equality.

Production writes performed: false. Production migrations applied: false.
Observation rows modified: false. W3 authorized: false.

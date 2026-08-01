# W2C compact cloud schema decision

Decision: **Compact Supabase candidate approved for W2D**. W3 remains blocked.

The W2A representation is 754,417,664 bytes (719.469 MiB). Its largest costs are external IDs (234,766,336 bytes), taxa (232,382,464), scientific names (212,164,608), and concepts (57,671,680). The audit proves that every one of 634,894 preferred scientific-name rows repeats its taxon's canonical name and every one of 634,894 authoritative external-ID rows repeats the taxon's canonical source/ID. Only 27,755 scientific rows are true aliases. No W1 row or identity is changed.

| Candidate | Runtime relations | Final production | Future publication peak | Search p50 | Result |
|---|---:|---:|---:|---:|---|
| A: optimized W2A | 674,430,976 | 777,735,315 | 1,452,166,291 | ~0.05 ms | capacity fail |
| B: compact slot/W2A decomposition | 455,032,832 | 558,337,171 | 1,013,370,003 | ~0.06 ms | capacity fail |
| C: purpose-built compact | 141,606,912 | 244,911,251 | 406,391,955 | 0.027–0.059 ms | pass |

Candidate C stores immutable release metadata and hashes, one atomic active-slot pointer, compact dictionary tables, a current taxon display/resolver table, only true scientific aliases, vernacular names with distinct language codes, authoritative external-ID exceptions, and compact Red List enrichment. The present release needs zero exception mappings because all mappings equal the canonical fields. Namespace-lost legacy integers remain in immutable W1 evidence/offline audit only and never resolve.

Literal escaped `lower(value) LIKE escaped_query || '%'` predicates use selective `text_pattern_ops` indexes. Ten executions per probe used the expected canonical, alias, vernacular, or resolver index. Candidate C p50 was 0.027–0.059 ms versus roughly 597–711 ms for W2A's non-indexable formulation. Named searches, same-name concepts, aliases, language behavior, wildcard literals, short inputs, limits, and resolvers matched the contract.

The production baseline was independently reproduced in a read-only transaction at 103,304,339 bytes on PostgreSQL 17.6. Candidate C's final projection is 244,911,251 bytes (233.565 MiB). Its measured two-slot relations are 303,087,616 bytes, producing a future peak projection of 406,391,955 bytes (387.566 MiB). After eventual legacy retirement, the projections are 175,983,763 and 337,464,467 bytes respectively.

The publication experiment showed that `DELETE` plus ordinary `VACUUM` does not reclaim an inactive slot. W2D must therefore implement separately truncatable/list-partitioned slots: load and index the inactive slot, validate it, atomically change the pointer, retain the old slot for the rollback window, then truncate or detach/drop only the inactive retired partition. `VACUUM FULL` is not part of publication.

Stable Sporely IDs remain authoritative. Active taxa carry current identities; immutable artifacts and release metadata retain reproducibility; a small registry retains only referenced or disappeared identities; future W3 observation snapshots preserve displayed name, source/ID, release, and Sporely ID. Full retired search datasets are not required for historical display under that policy.

Red List Norge/Svalbard separation is retained, but production publication remains independently blocked until provenance/licensing is resolved. No production writes or activation occurred.

W2D must convert the prototype into a reviewed additive migration, production-grade streaming transformer, RLS-denied runtime tables, controlled `SECURITY DEFINER` RPCs, partition publication tests, and renewed capacity evidence. W3 is not authorized by this decision.

// Tracks which user owns the on-device IndexedDB stores (`pending_import` and
// `review_draft`). Neither store is per-user namespaced, so on cold start we
// need an out-of-band marker to detect account-switch scenarios that the
// SIGNED_OUT handler could not clean up — process kills, uninstall-reinstall
// of the token, externally revoked sessions, and so on.
//
// FAIL-CLOSED CONTRACT:
//   * The marker is moved to a new user ONLY after the purge succeeds.
//   * A failed purge returns `purge_failed`; the caller must skip restoration
//     so the previous user's drafts are never revealed.
//   * The next boot sees the old (or empty) marker and retries the purge.
//   * Boot code MUST NOT restore drafts on `purge_failed` or `legacy_purge_failed`.
//
// LEGACY ROLLOUT:
//   * On the first boot after upgrade, the marker is absent but data may
//     exist from before we tracked ownership. If the caller reports
//     `hasLegacyData: true` we purge before assigning. This discards one
//     pre-upgrade draft in favor of account isolation — documented trade-off.

const OWNER_KEY = 'sporely-local-data-owner-id'

export function getLocalDataOwner(storage = _defaultStorage()) {
  try { return storage?.getItem(OWNER_KEY) || null } catch { return null }
}

export function setLocalDataOwner(userId, storage = _defaultStorage()) {
  if (!userId) return
  try { storage?.setItem(OWNER_KEY, String(userId)) } catch { /* localStorage unavailable */ }
}

export function clearLocalDataOwner(storage = _defaultStorage()) {
  try { storage?.removeItem(OWNER_KEY) } catch { /* ignore */ }
}

// Resolves ownership at boot. Returns `{ outcome }` where `outcome` is one of:
//   - 'match'              — owner matches current user; restore normally.
//   - 'assigned'           — no prior owner and no legacy data; associate to
//                            this user; there is nothing to restore.
//   - 'purged'             — owner mismatch (or legacy data) was purged and
//                            the marker was reassigned; skip restoration.
//   - 'purge_failed'       — mismatch detected but the purge threw; marker
//                            NOT moved; caller MUST skip restoration.
//   - 'legacy_purge_failed'— legacy pre-marker data detected but the purge
//                            threw; marker NOT set; caller MUST skip restoration.
//
// `purgeFn` must throw on failure. `hasLegacyData` (optional) is called only
// when there is no marker and returns a boolean.
export async function resolveLocalDataOwner(userId, purgeFn, { storage = _defaultStorage(), hasLegacyData = null } = {}) {
  if (!userId) return { outcome: 'assigned' }
  const owner = getLocalDataOwner(storage)

  if (!owner) {
    // Legacy rollout guard: unnamespaced stores that predate the marker.
    let legacy = false
    if (typeof hasLegacyData === 'function') {
      try { legacy = !!(await hasLegacyData()) } catch { legacy = false }
    }
    if (legacy) {
      try {
        if (typeof purgeFn === 'function') await purgeFn()
      } catch (err) {
        console.warn('Legacy pre-marker purge failed; keeping marker unset for retry:', err)
        return { outcome: 'legacy_purge_failed' }
      }
      setLocalDataOwner(userId, storage)
      return { outcome: 'purged' }
    }
    setLocalDataOwner(userId, storage)
    return { outcome: 'assigned' }
  }

  if (owner === userId) return { outcome: 'match' }

  // Owner mismatch — purge first. Only reassign the marker if the purge
  // actually succeeded, so the next boot retries on failure.
  try {
    if (typeof purgeFn === 'function') await purgeFn()
  } catch (err) {
    console.warn('Draft purge on owner mismatch failed; preserving old marker for retry:', err)
    return { outcome: 'purge_failed' }
  }
  setLocalDataOwner(userId, storage)
  return { outcome: 'purged' }
}

function _defaultStorage() {
  try { return globalThis.localStorage } catch { return null }
}

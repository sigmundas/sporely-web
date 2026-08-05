// Decides whether a Supabase `profiles` row represents a fully set-up user.
//
// Completeness is driven by the persisted `profile_completed_at` column,
// written only by the Profile setup save. `handle_new_user()` inserts a
// profile with `profile_completed_at = null`, so a trigger-seeded row is
// always incomplete regardless of what its auto-seeded `username` and
// `display_name` contain.

import { supabase } from './supabase.js'

const PROFILE_COMPLETION_COLUMNS = 'id, username, display_name, avatar_url, bio, profile_completed_at'

export function isProfileComplete(profile) {
  if (!profile) return false
  if (!_nonEmpty(profile.username)) return false
  if (!_nonEmpty(profile.display_name)) return false
  if (!profile.profile_completed_at) return false
  return true
}

export async function fetchProfileForCompletion(userId) {
  if (!userId) return { profile: null, error: null }
  const { data, error } = await supabase
    .from('profiles')
    .select(PROFILE_COMPLETION_COLUMNS)
    .eq('id', userId)
    .maybeSingle()
  return { profile: data || null, error: error || null }
}

// Retry ONLY when the row is legitimately missing (the `handle_new_user()`
// trigger has not committed yet). Authorization, network, and any other
// Supabase error is surfaced immediately so we do not misinterpret them as
// trigger latency.
export async function fetchProfileWithSignupRetry(userId, { attempts = 4, delayMs = 400 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const { profile, error } = await fetchProfileForCompletion(userId)
    if (error) return { profile: null, error }
    if (profile) return { profile, error: null }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs))
  }
  return { profile: null, error: null }
}

export const PROFILE_COMPLETION_SELECT = PROFILE_COMPLETION_COLUMNS

// Persists the Profile setup submission: writes the editable fields AND
// `profile_completed_at` together, and returns the persisted row so the
// caller can decide the next auth state from the truth-on-server, not from
// local form values.
export async function saveProfileSetup(client, userId, fields, { now = () => new Date().toISOString() } = {}) {
  if (!userId) return { persisted: null, error: new Error('missing user id') }
  const update = {
    username: fields.username ?? null,
    display_name: fields.display_name ?? null,
    bio: fields.bio ?? null,
    profile_completed_at: now(),
  }
  const { data, error } = await client
    .from('profiles')
    .update(update)
    .eq('id', userId)
    .select(PROFILE_COMPLETION_COLUMNS)
    .single()
  return { persisted: data || null, error: error || null }
}

// Persists an ordinary post-onboarding profile edit. Does NOT touch
// `profile_completed_at`.
export async function saveProfileEdit(client, userId, fields) {
  if (!userId) return { persisted: null, error: new Error('missing user id') }
  const update = {
    username: fields.username ?? null,
    display_name: fields.display_name ?? null,
    bio: fields.bio ?? null,
  }
  const { data, error } = await client
    .from('profiles')
    .update(update)
    .eq('id', userId)
    .select(PROFILE_COMPLETION_COLUMNS)
    .single()
  return { persisted: data || null, error: error || null }
}

function _nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

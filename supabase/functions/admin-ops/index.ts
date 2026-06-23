/// <reference lib="dom" />
/// <reference lib="deno.ns" />

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from 'npm:@supabase/supabase-js/cors'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const STORAGE_USER_LIMIT = 50
const TOMBSTONED_IMAGE_LIMIT = 100
const MEDIA_ISSUE_LIMIT = 100
const MEDIA_ISSUE_CANDIDATE_LIMIT = 500
const REPORT_LIMIT = 50
const PROFILE_CHUNK_SIZE = 100
const AUTH_LIST_PAGE_SIZE = 1000
const AUTH_LIST_PAGE_LIMIT = 10

Deno.serve(async req => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  try {
    if (!supabaseUrl || !supabaseAnonKey) {
      return json({ error: 'Missing Supabase configuration' }, 500)
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return json({ error: 'Missing Authorization header' }, 401)
    }

    const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    })

    const {
      data: { user },
      error: userError,
    } = await callerClient.auth.getUser()

    if (userError || !user) {
      return json({ error: 'Unauthorized' }, 401)
    }

    const { data: profile, error: profileError } = await callerClient
      .from('profiles')
      .select('id, is_admin')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError) {
      return json({ error: `Failed to verify admin profile: ${profileError.message}` }, 500)
    }

    if (!profile?.is_admin) {
      return json({ error: 'Access denied' }, 403)
    }

    const adminClient = getAdminClient()
    const warnings: string[] = []

    const [counts, topStorageUsers, tombstonedImages, mediaIssueRows, recentReports, databaseHealth] = await Promise.all([
      buildCounts(adminClient, warnings),
      buildTopStorageUsers(adminClient, warnings),
      buildTombstonedImages(adminClient, warnings),
      buildMediaIssueRows(adminClient, warnings),
      buildRecentReports(adminClient, warnings),
      buildDatabaseHealth(adminClient, warnings),
    ])

    const userIds = collectUserIds([
      topStorageUsers,
      tombstonedImages,
      mediaIssueRows,
      recentReports,
    ])

    const [profilesById, emailsById] = await Promise.all([
      fetchProfilesByIds(adminClient, userIds, warnings),
      fetchEmailsByIds(adminClient, userIds, warnings),
    ])

    const enrichedTopStorageUsers = topStorageUsers.map(row =>
      enrichStorageUserRow(row, emailsById),
    )
    const enrichedTombstonedImages = tombstonedImages.map(row =>
      enrichImageRow(row, profilesById, emailsById, true),
    )
    const enrichedMediaIssueRows = mediaIssueRows.map(row =>
      enrichImageRow(row, profilesById, emailsById, false),
    )
    const enrichedReports = recentReports.map(row =>
      enrichReportRow(row, profilesById, emailsById),
    )
    const mediaIssueSummary = await buildMediaIssueSummary(adminClient, counts, warnings)

    return json({
      generated_at: new Date().toISOString(),
      actor_user_id: user.id,
      counts,
      media_health: {
        rows_missing_storage_path: counts.rows_missing_storage_path,
        rows_missing_thumb_key: enrichedMediaIssueRows.filter(row => !row.derived_thumb_path).length,
        tombstones_not_purged: counts.tombstoned_observation_images,
        tombstones_expired_if_restore_until_exists: null,
        purge_errors_if_column_exists: null,
        media_issue_total: mediaIssueSummary.total,
        media_issue_critical: mediaIssueSummary.critical,
        media_issue_warning: mediaIssueSummary.warning,
        media_issue_info: mediaIssueSummary.info,
      },
      top_storage_users: enrichedTopStorageUsers,
      storage_by_user: enrichedTopStorageUsers,
      tombstoned_images: enrichedTombstonedImages,
      recent_deleted_images: enrichedTombstonedImages,
      media_issue_rows: enrichedMediaIssueRows,
      recent_reports: enrichedReports,
      database_health: databaseHealth,
      warnings: [
        'observation_images has no thumb_key column in the current schema; derived thumb paths are computed from storage_path.',
        ...warnings,
      ],
    })
  } catch (error) {
    console.error('admin-ops failed:', error)
    return json({ error: error instanceof Error ? error.message : 'Unexpected error' }, 500)
  }
})

function getAdminClient() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase service role configuration')
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

async function buildCounts(adminClient, warnings) {
  const results = await Promise.all([
    countExact(adminClient, 'profiles', null, warnings, 'profiles'),
    countExact(adminClient, 'observations', null, warnings, 'observations'),
    countExact(adminClient, 'observation_images', null, warnings, 'observation_images'),
    countExact(adminClient, 'observation_images', query => query.is('deleted_at', null), warnings, 'active_observation_images'),
    countExact(adminClient, 'observation_images', query => query.not('deleted_at', 'is', null), warnings, 'tombstoned_observation_images'),
    countExact(adminClient, 'reports', query => query.eq('status', 'pending'), warnings, 'reports_open'),
    countExact(adminClient, 'profiles', query => query.eq('is_banned', true), warnings, 'banned_profiles'),
    countExact(adminClient, 'profiles', query => query.eq('is_admin', true), warnings, 'admin_profiles'),
    countExact(adminClient, 'observation_images', query => query.is('deleted_at', null).is('storage_path', null), warnings, 'rows_missing_storage_path'),
  ])

  const [
    profiles,
    observations,
    observationImages,
    activeObservationImages,
    tombstonedObservationImages,
    reportsOpen,
    bannedProfiles,
    adminProfiles,
    rowsMissingStoragePath,
  ] = results

  return {
    profiles,
    observations,
    observation_images: observationImages,
    active_observation_images: activeObservationImages,
    tombstoned_observation_images: tombstonedObservationImages,
    reports_open: reportsOpen,
    banned_profiles: bannedProfiles,
    admin_profiles: adminProfiles,
    rows_missing_storage_path: rowsMissingStoragePath,
  }
}

async function buildTopStorageUsers(adminClient, warnings) {
  const { data, error } = await adminClient
    .from('profiles')
    .select(
      'id, username, display_name, cloud_plan, is_pro, is_admin, is_banned, total_storage_bytes, storage_used_bytes, image_count',
    )
    .order('storage_used_bytes', { ascending: false })
    .limit(STORAGE_USER_LIMIT)

  if (error) {
    warnings.push(`top_storage_users: ${error.message}`)
    return []
  }

  return (data ?? []).map(row => ({
    id: row.id,
    email: null,
    username: row.username ?? null,
    display_name: row.display_name ?? null,
    user_label: buildUserLabel(row.id, row.username, row.display_name, null),
    cloud_plan: row.cloud_plan ?? null,
    is_pro: row.is_pro ?? null,
    is_admin: row.is_admin ?? null,
    is_banned: row.is_banned ?? null,
    total_storage_bytes: row.total_storage_bytes ?? null,
    storage_used_bytes: row.storage_used_bytes ?? null,
    image_count: row.image_count ?? null,
  }))
}

async function buildMediaIssueSummary(adminClient, counts, warnings) {
  const [warningActiveRows, infoRows] = await Promise.all([
    countExact(
      adminClient,
      'observation_images',
      query =>
        query
          .is('deleted_at', null)
          .not('storage_path', 'is', null)
          .or(
            'source_width.is.null,source_height.is.null,stored_width.is.null,stored_height.is.null,stored_bytes.is.null',
          ),
      warnings,
      'media_issue_warning_active',
    ),
    countExact(
      adminClient,
      'observation_images',
      query =>
        query
          .is('deleted_at', null)
          .not('storage_path', 'is', null)
          .is('original_storage_path', null)
          .not('source_width', 'is', null)
          .not('source_height', 'is', null)
          .not('stored_width', 'is', null)
          .not('stored_height', 'is', null)
          .not('stored_bytes', 'is', null),
      warnings,
      'media_issue_info',
    ),
  ])

  const critical = counts.rows_missing_storage_path ?? null
  const warning = sumNullableCounts(counts.tombstoned_observation_images, warningActiveRows)
  const total = sumNullableCounts(critical, warning, infoRows)

  return {
    total,
    critical,
    warning,
    info: infoRows,
  }
}

async function buildTombstonedImages(adminClient, warnings) {
  const { data, error } = await adminClient
    .from('observation_images')
    .select(
      'id, observation_id, user_id, storage_path, original_storage_path, original_filename, deleted_at, created_at, source_width, source_height, stored_width, stored_height, stored_bytes, image_type, upload_mode, sort_order',
    )
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false })
    .limit(TOMBSTONED_IMAGE_LIMIT)

  if (error) {
    warnings.push(`tombstoned_images: ${error.message}`)
    return []
  }

  return (data ?? []).map(row => {
    const issueFlags = buildImageIssueFlags(row, true)

    return {
      id: row.id,
      observation_id: row.observation_id ?? null,
      user_id: row.user_id ?? null,
      storage_path: row.storage_path ?? null,
      original_storage_path: row.original_storage_path ?? null,
      original_filename: row.original_filename ?? null,
      deleted_at: row.deleted_at ?? null,
      created_at: row.created_at ?? null,
      source_width: row.source_width ?? null,
      source_height: row.source_height ?? null,
      stored_width: row.stored_width ?? null,
      stored_height: row.stored_height ?? null,
      stored_bytes: row.stored_bytes ?? null,
      image_type: row.image_type ?? null,
      upload_mode: row.upload_mode ?? null,
      sort_order: row.sort_order ?? null,
      image_status: 'deleted',
      issue_flags: issueFlags,
      issue_summary: buildIssueSummary(issueFlags),
      issue_severity: buildMediaIssueSeverity(row, true),
      derived_thumb_path: deriveThumbPath(row.storage_path ?? row.original_storage_path),
    }
  })
}

async function buildMediaIssueRows(adminClient, warnings) {
  const { data, error } = await adminClient
    .from('observation_images')
    .select(
      'id, observation_id, user_id, storage_path, original_storage_path, original_filename, deleted_at, created_at, source_width, source_height, stored_width, stored_height, stored_bytes, image_type, upload_mode, sort_order',
    )
    .order('created_at', { ascending: false })
    .limit(MEDIA_ISSUE_CANDIDATE_LIMIT)

  if (error) {
    warnings.push(`media_issue_rows: ${error.message}`)
    return []
  }

  const issueRows = (data ?? [])
    .map(row => {
      const issueFlags = buildImageIssueFlags(row, false)

      return {
        id: row.id,
        observation_id: row.observation_id ?? null,
        user_id: row.user_id ?? null,
        storage_path: row.storage_path ?? null,
        original_storage_path: row.original_storage_path ?? null,
        original_filename: row.original_filename ?? null,
        deleted_at: row.deleted_at ?? null,
        created_at: row.created_at ?? null,
        source_width: row.source_width ?? null,
        source_height: row.source_height ?? null,
        stored_width: row.stored_width ?? null,
        stored_height: row.stored_height ?? null,
        stored_bytes: row.stored_bytes ?? null,
        image_type: row.image_type ?? null,
        upload_mode: row.upload_mode ?? null,
        sort_order: row.sort_order ?? null,
        image_status: row.deleted_at ? 'deleted' : 'active',
        issue_flags: issueFlags,
        issue_summary: buildIssueSummary(issueFlags),
        issue_severity: buildMediaIssueSeverity(row, false),
        derived_thumb_path: deriveThumbPath(row.storage_path ?? row.original_storage_path),
      }
    })
    .filter(row => row.issue_flags.length > 0)
    .sort((left, right) => compareImageIssueRows(left, right))
    .slice(0, MEDIA_ISSUE_LIMIT)

  return issueRows
}

async function buildRecentReports(adminClient, warnings) {
  const { data, error } = await adminClient
    .from('reports')
    .select('id, reporter_id, reported_user_id, observation_id, comment_id, reason, status, created_at')
    .order('created_at', { ascending: false })
    .limit(REPORT_LIMIT)

  if (error) {
    warnings.push(`recent_reports: ${error.message}`)
    return []
  }

  return (data ?? []).map(row => ({
    id: row.id,
    reporter_id: row.reporter_id ?? null,
    reporter_email: null,
    reporter_username: null,
    reporter_display_name: null,
    reporter_label: buildUserLabel(row.reporter_id, null, null, null),
    reported_user_id: row.reported_user_id ?? null,
    reported_user_email: null,
    reported_user_username: null,
    reported_user_display_name: null,
    reported_user_label: buildUserLabel(row.reported_user_id, null, null, null),
    observation_id: row.observation_id ?? null,
    comment_id: row.comment_id ?? null,
    reason: row.reason ?? null,
    status: row.status ?? null,
    created_at: row.created_at ?? null,
  }))
}

async function buildDatabaseHealth(adminClient, warnings) {
  try {
    const { data, error } = await adminClient.rpc('admin_database_health')

    if (error) {
      console.error('database_health rpc failed:', error)
      warnings.push('database_health unavailable')
      return null
    }

    return coerceDatabaseHealthPayload(data)
  } catch (error) {
    console.error('database_health rpc failed:', error)
    warnings.push('database_health unavailable')
    return null
  }
}

function coerceDatabaseHealthPayload(data) {
  const payload = Array.isArray(data) ? data[0] : data
  if (!payload || typeof payload !== 'object') {
    return null
  }

  return payload
}

function enrichStorageUserRow(row, emailsById) {
  const email = emailsById.get(String(row.id)) ?? null
  return {
    ...row,
    email,
    user_label: buildUserLabel(row.id, row.username, row.display_name, email),
  }
}

function enrichImageRow(row, profilesById, emailsById, forceDeleted) {
  const userId = String(row.user_id ?? '').trim()
  const profile = profilesById.get(userId) ?? null
  const email = emailsById.get(userId) ?? null
  const issueFlags = buildImageIssueFlags(row, forceDeleted)

  return {
    ...row,
    user_email: email,
    user_username: profile?.username ?? null,
    user_display_name: profile?.display_name ?? null,
    user_label: buildUserLabel(userId, profile?.username ?? null, profile?.display_name ?? null, email),
    image_status: forceDeleted ? 'deleted' : row.deleted_at ? 'deleted' : 'active',
    issue_flags: issueFlags,
    issue_summary: buildIssueSummary(issueFlags),
    issue_severity: buildMediaIssueSeverity(row, forceDeleted),
    derived_thumb_path: deriveThumbPath(row.storage_path ?? row.original_storage_path),
  }
}

function enrichReportRow(row, profilesById, emailsById) {
  const reporterId = String(row.reporter_id ?? '').trim()
  const reportedUserId = String(row.reported_user_id ?? '').trim()
  const reporterProfile = profilesById.get(reporterId) ?? null
  const reportedProfile = profilesById.get(reportedUserId) ?? null
  const reporterEmail = emailsById.get(reporterId) ?? null
  const reportedEmail = emailsById.get(reportedUserId) ?? null

  return {
    ...row,
    reporter_email: reporterEmail,
    reporter_username: reporterProfile?.username ?? null,
    reporter_display_name: reporterProfile?.display_name ?? null,
    reporter_label: buildUserLabel(reporterId, reporterProfile?.username ?? null, reporterProfile?.display_name ?? null, reporterEmail),
    reported_user_email: reportedEmail,
    reported_user_username: reportedProfile?.username ?? null,
    reported_user_display_name: reportedProfile?.display_name ?? null,
    reported_user_label: buildUserLabel(reportedUserId, reportedProfile?.username ?? null, reportedProfile?.display_name ?? null, reportedEmail),
  }
}

async function fetchProfilesByIds(adminClient, ids, warnings) {
  const profiles = new Map()
  const uniqueIds = uniqueIdsFromValues(ids)

  for (const chunk of chunkArray(uniqueIds, PROFILE_CHUNK_SIZE)) {
    const { data, error } = await adminClient
      .from('profiles')
      .select('id, username, display_name')
      .in('id', chunk)

    if (error) {
      warnings.push(`profiles lookup: ${error.message}`)
      continue
    }

    for (const row of data ?? []) {
      profiles.set(String(row.id), {
        username: row.username ?? null,
        display_name: row.display_name ?? null,
      })
    }
  }

  return profiles
}

async function fetchEmailsByIds(adminClient, ids, warnings) {
  const emails = new Map()
  const remaining = new Set(uniqueIdsFromValues(ids))
  let page = 1

  while (remaining.size > 0 && page <= AUTH_LIST_PAGE_LIMIT) {
    const { data, error } = await adminClient.auth.admin.listUsers({
      page,
      perPage: AUTH_LIST_PAGE_SIZE,
    })

    if (error) {
      warnings.push(`auth email lookup page ${page}: ${error.message}`)
      break
    }

    for (const user of data?.users ?? []) {
      const id = String(user.id ?? '').trim()
      if (!id || !remaining.has(id)) continue
      remaining.delete(id)
      emails.set(id, String(user.email ?? '').trim() || null)
    }

    const nextPage = Number.isInteger(data?.nextPage) ? data.nextPage : null
    if (!nextPage || nextPage === page) {
      break
    }

    page = nextPage
  }

  if (remaining.size > 0) {
    warnings.push(`auth email lookup missing ${remaining.size} user ids after paging`)
  }

  return emails
}

function collectUserIds(groups) {
  const ids = new Set()

  for (const group of groups) {
    for (const row of group ?? []) {
      for (const value of rowUserIds(row)) {
        const id = String(value ?? '').trim()
        if (id) {
          ids.add(id)
        }
      }
    }
  }

  return [...ids]
}

function rowUserIds(row) {
  const ids = []

  if ('cloud_plan' in (row ?? {}) || 'storage_used_bytes' in (row ?? {}) || 'image_count' in (row ?? {})) {
    ids.push(row?.id)
  }

  if ('user_id' in (row ?? {})) {
    ids.push(row?.user_id)
  }

  if ('reporter_id' in (row ?? {})) {
    ids.push(row?.reporter_id)
  }

  if ('reported_user_id' in (row ?? {})) {
    ids.push(row?.reported_user_id)
  }

  return ids
}

function buildImageIssueFlags(row, forceDeleted) {
  const flags = []

  if (forceDeleted || row?.deleted_at) {
    flags.push('deleted')
  }

  if (isBlank(row?.storage_path)) {
    flags.push('missing_storage_path')
  }

  if (isBlank(row?.original_storage_path)) {
    flags.push('missing_original_storage_path')
  }

  if (isBlank(row?.source_width) || isBlank(row?.source_height)) {
    flags.push('missing_source_dimensions')
  }

  if (isBlank(row?.stored_width) || isBlank(row?.stored_height)) {
    flags.push('missing_stored_dimensions')
  }

  if (isBlank(row?.stored_bytes)) {
    flags.push('missing_stored_bytes')
  }

  return [...new Set(flags)]
}

function buildMediaIssueSeverity(row, forceDeleted) {
  if (forceDeleted || row?.deleted_at) {
    return 'warning'
  }

  if (isBlank(row?.storage_path)) {
    return 'critical'
  }

  if (
    isBlank(row?.source_width) ||
    isBlank(row?.source_height) ||
    isBlank(row?.stored_width) ||
    isBlank(row?.stored_height) ||
    isBlank(row?.stored_bytes)
  ) {
    return 'warning'
  }

  if (isBlank(row?.original_storage_path)) {
    return 'info'
  }

  return null
}

function buildIssueSummary(flags) {
  if (!flags.length) return '—'

  return flags
    .map(flag => {
      switch (flag) {
        case 'deleted':
          return 'tombstoned'
        case 'missing_storage_path':
          return 'missing storage path'
        case 'missing_original_storage_path':
          return 'missing original storage path'
        case 'missing_source_dimensions':
          return 'missing source dimensions'
        case 'missing_stored_dimensions':
          return 'missing stored dimensions'
        case 'missing_stored_bytes':
          return 'missing stored bytes'
        default:
          return flag.replaceAll('_', ' ')
      }
    })
    .join(', ')
}

function compareImageIssueRows(left, right) {
  const leftSeverity = issueSeverityRank(left.issue_severity)
  const rightSeverity = issueSeverityRank(right.issue_severity)
  if (leftSeverity !== rightSeverity) return leftSeverity - rightSeverity

  const leftTime = toTimestamp(left.deleted_at ?? left.created_at)
  const rightTime = toTimestamp(right.deleted_at ?? right.created_at)
  if (leftTime !== rightTime) return rightTime - leftTime

  const leftId = String(left.id ?? '')
  const rightId = String(right.id ?? '')
  return leftId.localeCompare(rightId)
}

function issueSeverityRank(severity) {
  switch (severity) {
    case 'critical':
      return 0
    case 'warning':
      return 1
    case 'info':
      return 2
    default:
      return 3
  }
}

function buildUserLabel(id, username, displayName, email) {
  const handle = normalizeText(username)
  const display = normalizeText(displayName)
  const mail = normalizeText(email)
  const identifier = normalizeText(id)

  if (display && handle) return `${display} @${handle}`
  if (display) return display
  if (handle) return handle
  if (mail) return mail
  return identifier || '—'
}

function deriveThumbPath(storagePath) {
  const normalized = normalizeStoragePath(storagePath)
  if (!normalized) return null

  const segments = normalized.split('/').filter(Boolean)
  const fileName = segments.pop()
  if (!fileName) return normalized

  const thumbName = fileName.startsWith('thumb_') ? fileName : `thumb_${fileName}`
  return [...segments, thumbName].join('/')
}

function sumNullableCounts(...counts) {
  if (counts.some(count => count === null || count === undefined)) {
    return null
  }

  return counts.reduce((total, count) => total + count, 0)
}

function normalizeStoragePath(storagePath) {
  return normalizeText(storagePath).replace(/^\/+/, '')
}

function normalizeText(value) {
  return String(value ?? '').trim()
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === ''
}

function uniqueIdsFromValues(values) {
  return [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))]
}

function chunkArray(values, size) {
  const chunks = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

function toTimestamp(value) {
  const date = new Date(value ?? '')
  const time = date.getTime()
  return Number.isFinite(time) ? time : 0
}

async function countExact(adminClient, table, applyFilter, warnings, label) {
  let query = adminClient.from(table).select('id', { count: 'exact', head: true })
  if (applyFilter) {
    query = applyFilter(query)
  }

  const { count, error } = await query
  if (error) {
    warnings.push(`${label}: ${error.message}`)
    return null
  }

  return count ?? 0
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  })
}

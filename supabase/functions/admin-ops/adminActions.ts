import { DeleteObjectCommand, DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { parsePrivateBucketSetting } from '../_shared/r2Buckets.ts'

const DEFAULT_TOMBSTONE_RESTORE_WINDOW_DAYS = 30
const PURGE_CANDIDATE_LIMIT = 500
const R2_BUCKET_NAME = 'sporely-media'
const R2_REGION = 'auto'

type AdminActionContext = {
  adminClient: any
  adminUser: {
    id: string
    email: string | null
  }
  authHeader: string
  requestBody: Record<string, unknown> | null
  env: Record<string, string | undefined>
}

type AdminActionResponse = {
  status: number
  body: Record<string, unknown>
}

type ActionFailure = {
  status: number
  code: string
  message: string
  details?: Record<string, unknown> | null
}

export async function handleAdminAction(context: AdminActionContext): Promise<AdminActionResponse> {
  const action = normalizeText(context.requestBody?.action)
  if (!action) {
    return actionFailureResponse(400, 'missing_action', 'Missing action')
  }

  switch (action) {
    case 'preview_purge_tombstoned_images':
      return previewPurgeTombstonedImages(context)
    case 'purge_expired_tombstoned_images':
      return purgeExpiredTombstonedImages(context)
    case 'sweep_retired_media_keys':
      return sweepRetiredMediaKeys(context)
    case 'sweep_orphan_media_prefixes':
      return sweepOrphanMediaPrefixes(context)
    case 'dismiss_report':
      return updateReportStatus(context, 'dismissed')
    case 'resolve_report':
      return updateReportStatus(context, 'resolved')
    case 'hide_reported_comment':
      return hideReportedComment(context)
    case 'hide_reported_observation':
      return hideReportedObservation(context)
    case 'ban_profile':
      return setProfileBanState(context, true)
    case 'unban_profile':
      return setProfileBanState(context, false)
    case 'recalculate_profile_storage_usage':
      return recalculateProfileStorageUsage(context)
    default:
      return actionFailureResponse(400, 'unknown_action', `Unknown admin action: ${action}`)
  }
}

export async function getTombstonePurgeStats(adminClient: any, env: Record<string, string | undefined>) {
  const restoreWindowDays = getRestoreWindowDays(env)
  const cutoffAt = getPurgeCutoffAt(restoreWindowDays)
  const tombstonedRows = await safeCountRows(adminClient, 'observation_images', query => query.not('deleted_at', 'is', null))
  const purgedRows = await safeCountRows(
    adminClient,
    'observation_images',
    query =>
      query
        .not('deleted_at', 'is', null)
        .not('purged_at', 'is', null),
  )
  const readyToPurge = await safeCountRows(
    adminClient,
    'observation_images',
    query =>
      query
        .not('deleted_at', 'is', null)
        .is('purged_at', null)
        .lte('deleted_at', cutoffAt.toISOString()),
  )
  const purgeErrors = await safeCountRows(
    adminClient,
    'observation_images',
    query =>
      query
        .not('deleted_at', 'is', null)
        .is('purged_at', null)
        .not('purge_error', 'is', null),
  )

  return {
    restore_window_days: restoreWindowDays,
    restore_cutoff_at: cutoffAt.toISOString(),
    tombstones_not_purged:
      tombstonedRows === null || purgedRows === null ? null : Math.max(0, tombstonedRows - purgedRows),
    tombstones_expired_if_restore_until_exists: readyToPurge,
    purge_errors_if_column_exists: purgeErrors,
  }
}

async function previewPurgeTombstonedImages(context: AdminActionContext): Promise<AdminActionResponse> {
  const selection = await loadTombstoneSelection(context.adminClient, context.requestBody, context.env)
  const preview = selection.rows.map(row =>
    buildTombstonePreviewRow(row, selection.restoreWindowDays, getMediaPublicBaseUrl(context.env)),
  )
  const counts = summarizeTombstoneRows(preview)

  return {
    status: 200,
    body: {
      ok: true,
      action: 'preview_purge_tombstoned_images',
      restore_window_days: selection.restoreWindowDays,
      restore_cutoff_at: selection.restoreCutoffAt,
      selection: { label: selection.scope, user_id: selection.scopeUserId },
      counts,
      rows: preview,
      truncated: selection.truncated,
    },
  }
}

async function purgeExpiredTombstonedImages(context: AdminActionContext): Promise<AdminActionResponse> {
  // Step 0 (media-key retirement plan): backend-enforced purge disable. Checked
  // here before the R2 preflight, and again per row in purgeSingleTombstoneRow.
  if (!isTombstonePurgeEnabled(context.env)) {
    return actionFailureResponse(409, TOMBSTONE_PURGE_DISABLED, 'Tombstone purge is disabled on the server')
  }
  const selection = await loadTombstoneSelection(context.adminClient, context.requestBody, context.env)
  const previewRows = selection.rows.map(row =>
    buildTombstonePreviewRow(row, selection.restoreWindowDays, getMediaPublicBaseUrl(context.env)),
  )
  const eligibleRows = previewRows.filter(row => row.status === 'eligible')
  const warnings: string[] = []

  const beforeSnapshot = {
    restore_window_days: selection.restoreWindowDays,
    restore_cutoff_at: selection.restoreCutoffAt,
    selection: { label: selection.scope, user_id: selection.scopeUserId },
    counts: summarizeTombstoneRows(previewRows),
    rows: previewRows,
    truncated: selection.truncated,
  }

  const reason = requireNonEmptyText(context.requestBody?.reason, 'Reason is required')
  if (!reason.ok) {
    return actionFailureResponse(400, reason.code, reason.message)
  }

  if (!eligibleRows.length) {
    return await withAdminActionLog({
      adminClient: context.adminClient,
      adminUser: context.adminUser,
      action: 'purge_expired_tombstoned_images',
      targetType: 'observation_image_batch',
      targetId: selection.scope,
      reason: reason.value,
      requestPayload: context.requestBody,
      beforeSnapshot,
      run: async () => ({
        counts: summarizeTombstoneRows(previewRows),
        rows: previewRows,
        truncated: selection.truncated,
        warnings,
      }),
    })
  }

  const preflightTarget = eligibleRows
    .flatMap(row => Array.isArray(row.delete_targets) ? row.delete_targets : [])
    .map(value => normalizeMediaKey(value))
    .find(Boolean)
  if (!preflightTarget) {
    return actionFailureResponse(500, 'missing_recorded_storage_paths', 'Eligible rows have no recorded storage paths')
  }
  const r2ClientResult = await prepareR2PurgeClient(context.env, preflightTarget)
  if (!r2ClientResult.ok) {
    return actionFailureResponse(
      r2ClientResult.failure.status,
      r2ClientResult.failure.code,
      r2ClientResult.failure.message,
      r2ClientResult.failure.details ?? null,
    )
  }

  return await withAdminActionLog({
    adminClient: context.adminClient,
    adminUser: context.adminUser,
    action: 'purge_expired_tombstoned_images',
    targetType: 'observation_image_batch',
    targetId: selection.scope,
    reason: reason.value,
    requestPayload: context.requestBody,
    beforeSnapshot,
    run: async () => {
      const rowResults: Array<Record<string, unknown>> = []
      for (const row of eligibleRows) {
        const result = await purgeSingleTombstoneRow(context, row, r2ClientResult.client)
        rowResults.push(result)
      }

      const resultCounts = summarizeTombstoneRows([
        ...previewRows.filter(row => row.status !== 'eligible'),
        ...rowResults,
      ])

      return {
        counts: resultCounts,
        rows: rowResults,
        truncated: selection.truncated,
        warnings,
      }
    },
  })
}

async function updateReportStatus(context: AdminActionContext, targetStatus: 'resolved' | 'dismissed'): Promise<AdminActionResponse> {
  const reportId = requireNonEmptyText(context.requestBody?.report_id, 'report_id is required')
  if (!reportId.ok) {
    return actionFailureResponse(400, reportId.code, reportId.message)
  }

  const reason = requireNonEmptyText(context.requestBody?.reason, 'Reason is required')
  if (!reason.ok) {
    return actionFailureResponse(400, reason.code, reason.message)
  }

  const resolution = normalizeText(context.requestBody?.resolution)
  if (targetStatus === 'resolved' && !resolution) {
    return actionFailureResponse(400, 'missing_resolution', 'Resolution is required')
  }

  const report = await loadSingleRow(context.adminClient, 'reports', 'id', reportId.value, [
    'id',
    'status',
    'resolution',
    'resolved_at',
    'resolved_by',
    'dismissed_at',
    'dismissed_by',
    'reporter_id',
    'reported_user_id',
    'observation_id',
    'comment_id',
    'reason',
    'created_at',
  ])

  if (!report.ok) {
    return report.response
  }

  const beforeSnapshot = report.row
  const targetId = String(report.row.id)
  const alreadyMatching = normalizeText(report.row.status) === targetStatus
  return await withAdminActionLog({
    adminClient: context.adminClient,
    adminUser: context.adminUser,
    action: targetStatus === 'resolved' ? 'resolve_report' : 'dismiss_report',
    targetType: 'report',
    targetId,
    reason: reason.value,
    requestPayload: context.requestBody,
    beforeSnapshot,
    run: async () => {
      if (alreadyMatching) {
        return {
          report: beforeSnapshot,
          skipped: true,
        }
      }

      const payload: Record<string, unknown> = {
        status: targetStatus,
        resolved_at: targetStatus === 'resolved' ? new Date().toISOString() : null,
        resolved_by: targetStatus === 'resolved' ? context.adminUser.id : null,
        dismissed_at: targetStatus === 'dismissed' ? new Date().toISOString() : null,
        dismissed_by: targetStatus === 'dismissed' ? context.adminUser.id : null,
        resolution: targetStatus === 'resolved' ? resolution : null,
      }

      const { data, error } = await context.adminClient
        .from('reports')
        .update(payload)
        .eq('id', report.row.id)
        .select('id, status, resolution, resolved_at, resolved_by, dismissed_at, dismissed_by')
        .maybeSingle()

      if (error) {
        throw actionError(500, 'report_update_failed', `Failed to update report: ${error.message}`)
      }

      return {
        report: data ?? payload,
      }
    },
  })
}

async function hideReportedComment(context: AdminActionContext): Promise<AdminActionResponse> {
  const commentId = requireNonEmptyText(context.requestBody?.comment_id, 'comment_id is required')
  if (!commentId.ok) {
    return actionFailureResponse(400, commentId.code, commentId.message)
  }

  const reason = requireNonEmptyText(context.requestBody?.reason, 'Reason is required')
  if (!reason.ok) {
    return actionFailureResponse(400, reason.code, reason.message)
  }

  const comment = await loadSingleRow(context.adminClient, 'comments', 'id', commentId.value, [
    'id',
    'observation_id',
    'user_id',
    'created_at',
  ])
  if (!comment.ok) {
    return comment.response
  }

  const moderation = await loadSingleRow(context.adminClient, 'comment_moderation', 'comment_id', commentId.value, [
    'comment_id',
    'report_id',
    'hidden_at',
    'hidden_by',
    'hidden_reason',
    'created_at',
  ])

  if (moderation.ok && moderation.row?.hidden_at) {
    return await withAdminActionLog({
      adminClient: context.adminClient,
      adminUser: context.adminUser,
      action: 'hide_reported_comment',
      targetType: 'comment',
      targetId: commentId.value,
      reason: reason.value,
      requestPayload: context.requestBody,
      beforeSnapshot: {
        comment: comment.row,
        moderation: moderation.row,
      },
      run: async () => ({
        comment: comment.row,
        moderation: moderation.row,
        skipped: true,
      }),
    })
  }

  return await withAdminActionLog({
    adminClient: context.adminClient,
    adminUser: context.adminUser,
    action: 'hide_reported_comment',
    targetType: 'comment',
    targetId: commentId.value,
    reason: reason.value,
    requestPayload: context.requestBody,
    beforeSnapshot: {
      comment: comment.row,
      moderation: moderation.ok ? moderation.row : null,
    },
    run: async () => {
      const payload = {
        comment_id: comment.row.id,
        report_id: normalizeText(context.requestBody?.report_id) || null,
        hidden_at: new Date().toISOString(),
        hidden_by: context.adminUser.id,
        hidden_reason: reason.value,
      }

      const { data, error } = moderation.ok
        ? await context.adminClient
            .from('comment_moderation')
            .update({
              report_id: payload.report_id,
              hidden_at: payload.hidden_at,
              hidden_by: payload.hidden_by,
              hidden_reason: payload.hidden_reason,
            })
            .eq('comment_id', comment.row.id)
            .select('comment_id, report_id, hidden_at, hidden_by, hidden_reason, created_at')
            .maybeSingle()
        : await context.adminClient
            .from('comment_moderation')
            .insert(payload)
            .select('comment_id, report_id, hidden_at, hidden_by, hidden_reason, created_at')
            .maybeSingle()

      if (error) {
        throw actionError(500, 'comment_hide_failed', `Failed to hide comment: ${error.message}`)
      }

      return {
        comment: comment.row,
        moderation: data ?? payload,
      }
    },
  })
}

async function hideReportedObservation(context: AdminActionContext): Promise<AdminActionResponse> {
  const observationId = requireNonEmptyText(context.requestBody?.observation_id, 'observation_id is required')
  if (!observationId.ok) {
    return actionFailureResponse(400, observationId.code, observationId.message)
  }

  const reason = requireNonEmptyText(context.requestBody?.reason, 'Reason is required')
  if (!reason.ok) {
    return actionFailureResponse(400, reason.code, reason.message)
  }

  const observation = await loadSingleRow(context.adminClient, 'observations', 'id', observationId.value, [
    'id',
    'user_id',
    'visibility',
    'spore_data_visibility',
    'is_draft',
    'created_at',
    'updated_at',
  ])
  if (!observation.ok) {
    return observation.response
  }

  const beforeSnapshot = observation.row
  const alreadyHidden =
    normalizeText(observation.row.visibility) === 'private' &&
    normalizeText(observation.row.spore_data_visibility) === 'private'

  return await withAdminActionLog({
    adminClient: context.adminClient,
    adminUser: context.adminUser,
    action: 'hide_reported_observation',
    targetType: 'observation',
    targetId: observationId.value,
    reason: reason.value,
    requestPayload: context.requestBody,
    beforeSnapshot,
    run: async () => {
      if (alreadyHidden) {
        return {
          observation: beforeSnapshot,
          skipped: true,
        }
      }

      const payload = {
        visibility: 'private',
        spore_data_visibility: 'private',
      }

      const { data, error } = await context.adminClient
        .from('observations')
        .update(payload)
        .eq('id', observation.row.id)
        .select('id, user_id, visibility, spore_data_visibility, is_draft, created_at, updated_at')
        .maybeSingle()

      if (error) {
        throw actionError(500, 'observation_hide_failed', `Failed to hide observation: ${error.message}`)
      }

      return {
        observation: data ?? { ...beforeSnapshot, ...payload },
      }
    },
  })
}

async function setProfileBanState(context: AdminActionContext, isBanned: boolean): Promise<AdminActionResponse> {
  const profileId = resolveProfileId(context.requestBody)
  if (!profileId.ok) {
    return actionFailureResponse(400, profileId.code, profileId.message)
  }

  const reason = requireNonEmptyText(context.requestBody?.reason, 'Reason is required')
  if (!reason.ok) {
    return actionFailureResponse(400, reason.code, reason.message)
  }

  const profile = await loadSingleRow(context.adminClient, 'profiles', 'id', profileId.value, [
    'id',
    'username',
    'display_name',
    'cloud_plan',
    'is_pro',
    'is_admin',
    'is_banned',
    'total_storage_bytes',
    'storage_used_bytes',
    'image_count',
  ])
  if (!profile.ok) {
    return profile.response
  }

  const beforeSnapshot = profile.row
  const alreadyMatching = Boolean(profile.row.is_banned) === isBanned

  return await withAdminActionLog({
    adminClient: context.adminClient,
    adminUser: context.adminUser,
    action: isBanned ? 'ban_profile' : 'unban_profile',
    targetType: 'profile',
    targetId: profileId.value,
    reason: reason.value,
    requestPayload: context.requestBody,
    beforeSnapshot,
    run: async () => {
      if (alreadyMatching) {
        return {
          profile: beforeSnapshot,
          skipped: true,
        }
      }

      const { data, error } = await context.adminClient
        .from('profiles')
        .update({ is_banned: isBanned })
        .eq('id', profile.row.id)
        .select('id, username, display_name, cloud_plan, is_pro, is_admin, is_banned, total_storage_bytes, storage_used_bytes, image_count')
        .maybeSingle()

      if (error) {
        throw actionError(500, 'profile_ban_failed', `Failed to update profile: ${error.message}`)
      }

      return {
        profile: data ?? { ...beforeSnapshot, is_banned: isBanned },
      }
    },
  })
}

async function recalculateProfileStorageUsage(context: AdminActionContext): Promise<AdminActionResponse> {
  const profileId = resolveProfileId(context.requestBody)
  if (!profileId.ok) {
    return actionFailureResponse(400, profileId.code, profileId.message)
  }

  // reason: only required for commit (not dry-run); parse early, validate after dry-run check
  const reason = requireNonEmptyText(context.requestBody?.reason, 'Reason is required')

  const profile = await loadSingleRow(context.adminClient, 'profiles', 'id', profileId.value, [
    'id',
    'username',
    'display_name',
    'cloud_plan',
    'is_pro',
    'is_admin',
    'is_banned',
    'total_storage_bytes',
    'storage_used_bytes',
    'image_count',
  ])
  if (!profile.ok) {
    return profile.response
  }

  const storageRows = await loadProfileStorageRows(context.adminClient, profileId.value)
  if (!storageRows.ok) {
    return storageRows.response
  }

  const beforeSnapshot = {
    profile: profile.row,
    inventory: {
      observation_image_rows: storageRows.rows.filter(row => row.media_kind === 'image').length,
      mosaic_rows: storageRows.rows.filter(row => row.media_kind === 'mosaic').length,
    },
  }
  const recalculated = await calculateProfileStorageUsage(context.env, storageRows.rows)
  const currentTotalStorageBytes = Number(profile.row.total_storage_bytes ?? 0)
  const currentStorageUsedBytes = Number(profile.row.storage_used_bytes ?? 0)
  const currentImageCount = Number(profile.row.image_count ?? 0)
  const delta = {
    storage_used_bytes: recalculated.storage_used_bytes - currentStorageUsedBytes,
    image_count: recalculated.image_count - currentImageCount,
  }
  const result = {
    profile_id: profile.row.id,
    recalculated,
    delta,
    current: {
      total_storage_bytes: currentTotalStorageBytes,
      storage_used_bytes: currentStorageUsedBytes,
      image_count: currentImageCount,
    },
  }

  if (context.requestBody?.dry_run === true) {
    return {
      status: 200,
      body: {
        ok: true,
        action: 'recalculate_profile_storage_usage',
        dry_run: true,
        result,
      },
    }
  }

  if (!reason.ok) {
    return actionFailureResponse(400, reason.code, reason.message)
  }

  const { data, error } = await context.adminClient.rpc('reconcile_profile_storage_usage', {
    p_user_id: profile.row.id,
    p_expected_total_storage_bytes: currentTotalStorageBytes,
    p_expected_storage_used_bytes: currentStorageUsedBytes,
    p_expected_image_count: currentImageCount,
    p_storage_used_bytes: recalculated.storage_used_bytes,
    p_image_count: recalculated.image_count,
    p_reason: reason.value,
    p_admin_user_id: context.adminUser.id,
    p_admin_email: context.adminUser.email,
    p_request_payload: cleanJson(context.requestBody),
    p_before_snapshot: cleanJson(beforeSnapshot),
    p_recalculated: cleanJson(recalculated),
  })

  if (error) {
    const concurrent = error.code === 'PT409'
    return actionFailureResponse(
      concurrent ? 409 : 500,
      concurrent ? 'profile_storage_changed' : 'profile_storage_recalculate_failed',
      concurrent
        ? 'Profile accounting changed during recalculation; run a fresh dry-run and retry'
        : `Failed to update profile storage totals: ${error.message}`,
    )
  }

  const updated = Array.isArray(data) ? data[0] ?? null : data
  return {
    status: 200,
    body: {
      ok: true,
      action: 'recalculate_profile_storage_usage',
      action_log_id: updated?.action_log_id ?? null,
      result: {
        ...result,
        profile: {
          id: profile.row.id,
          total_storage_bytes: Number(updated?.total_storage_bytes ?? recalculated.storage_used_bytes),
          storage_used_bytes: Number(updated?.storage_used_bytes ?? recalculated.storage_used_bytes),
          image_count: Number(updated?.image_count ?? recalculated.image_count),
        },
      },
    },
  }
}

async function withAdminActionLog(options: {
  adminClient: any
  adminUser: { id: string; email: string | null }
  action: string
  targetType: string
  targetId: string
  reason: string
  requestPayload: Record<string, unknown> | null
  beforeSnapshot: unknown
  run: () => Promise<Record<string, unknown>>
}): Promise<AdminActionResponse> {
  const actionLog = await insertAdminActionLog({
    adminClient: options.adminClient,
    adminUser: options.adminUser,
    action: options.action,
    targetType: options.targetType,
    targetId: options.targetId,
    reason: options.reason,
    requestPayload: options.requestPayload,
    beforeSnapshot: options.beforeSnapshot,
  })

  if (!actionLog.ok) {
    return actionLog.response
  }

  try {
    const result = await options.run()
    const updated = await updateAdminActionLog(options.adminClient, actionLog.id, result)
    const body: Record<string, unknown> = {
      ok: true,
      action: options.action,
      action_log_id: actionLog.id,
      result,
    }
    if (!updated.ok) {
      body.warnings = ['audit_log_result_update_failed']
    }
    return { status: 200, body }
  } catch (error) {
    const failure = normalizeActionFailure(error)
    const updated = await updateAdminActionLog(options.adminClient, actionLog.id, {
      ok: false,
      error: failure,
    })
    const body: Record<string, unknown> = {
      ok: false,
      action: options.action,
      action_log_id: actionLog.id,
      error: failure,
    }
    if (!updated.ok) {
      body.warnings = ['audit_log_result_update_failed']
    }
    return { status: failure.status, body }
  }
}

async function insertAdminActionLog(options: {
  adminClient: any
  adminUser: { id: string; email: string | null }
  action: string
  targetType: string
  targetId: string
  reason: string
  requestPayload: Record<string, unknown> | null
  beforeSnapshot: unknown
}): Promise<{ ok: true; id: number } | { ok: false; response: AdminActionResponse }> {
  const payload = {
    admin_user_id: options.adminUser.id,
    admin_email: options.adminUser.email,
    action: options.action,
    target_type: options.targetType,
    target_id: options.targetId,
    reason: options.reason,
    request_payload: cleanJson(options.requestPayload),
    before_snapshot: cleanJson(options.beforeSnapshot),
  }

  const { data, error } = await options.adminClient
    .from('admin_action_log')
    .insert(payload)
    .select('id')
    .maybeSingle()

  if (error) {
    return {
      ok: false,
      response: actionFailureResponse(500, 'audit_log_write_failed', `Failed to write admin audit log: ${error.message}`),
    }
  }

  const id = Number(data?.id)
  if (!Number.isFinite(id)) {
    return {
      ok: false,
      response: actionFailureResponse(500, 'audit_log_write_failed', 'Failed to create admin audit log'),
    }
  }

  return { ok: true, id }
}

async function updateAdminActionLog(adminClient: any, logId: number, resultSnapshot: unknown): Promise<{ ok: true } | { ok: false }> {
  const { error } = await adminClient
    .from('admin_action_log')
    .update({
      result_snapshot: cleanJson(resultSnapshot),
    })
    .eq('id', logId)

  if (error) {
    console.error('Failed to update admin_action_log row:', error)
    return { ok: false }
  }

  return { ok: true }
}

async function loadTombstoneSelection(
  adminClient: any,
  requestBody: Record<string, unknown> | null,
  env: Record<string, string | undefined>,
) {
  const restoreWindowDays = getRestoreWindowDays(env)
  const restoreCutoffAt = getPurgeCutoffAt(restoreWindowDays)
  const limit = resolveTombstoneLimit(requestBody)
  const userId = normalizeText(requestBody?.user_id)
  const observationId = normalizeText(requestBody?.observation_id)
  const storagePath = normalizeText(requestBody?.storage_path)
  const queryText = normalizeText(requestBody?.query)

  if (userId && !isValidTombstoneUuid(userId)) {
    throw actionError(400, 'invalid_user_id', 'user_id must be a valid UUID')
  }

  if (observationId && !isValidTombstoneUuid(observationId)) {
    throw actionError(400, 'invalid_observation_id', 'observation_id must be a valid UUID')
  }

  let query = adminClient
    .from('observation_images')
    .select(
      'id, observation_id, user_id, storage_path, original_storage_path, original_filename, deleted_at, purged_at, purge_attempted_at, purge_error, purge_accounting_bytes, created_at, source_width, source_height, stored_width, stored_height, stored_bytes, image_type, micro_category, upload_mode, sort_order, observation:observations!observation_images_observation_id_fkey(id, date, genus, species, common_name, species_guess, author, ai_selected_scientific_name, ai_selected_taxon_id, ai_selected_probability, created_at), owner:profiles!observation_images_user_id_fkey(id, username, display_name)',
    )
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: true })
    .limit(limit)

  if (userId) {
    query = query.eq('user_id', userId)
  }

  if (observationId) {
    query = query.eq('observation_id', observationId)
  }

  const { data, error } = await query
  if (error) {
    throw actionError(500, 'tombstone_preview_failed', `Failed to load tombstoned images: ${error.message}`)
  }

  const filteredRows = (Array.isArray(data) ? data : []).filter(row => {
    if (storagePath) {
      return buildTombstoneSearchText(row).includes(storagePath.toLowerCase())
    }

    if (queryText) {
      return buildTombstoneSearchText(row).includes(queryText.toLowerCase())
    }

    return true
  })

  const scopeLabel = buildTombstoneScopeLabel({ userId, observationId, storagePath, queryText })
  return {
    rows: filteredRows,
    restoreWindowDays,
    restoreCutoffAt: restoreCutoffAt.toISOString(),
    scope: scopeLabel,
    scopeUserId: userId || null,
    truncated: Array.isArray(data) ? data.length >= limit : false,
  }
}

async function loadProfileStorageRows(adminClient: any, profileId: string) {
  const [images, mosaics] = await Promise.all([
    loadAllStoragePages(() => adminClient
      .from('observation_images')
      .select('id, storage_path, original_storage_path, deleted_at, purged_at, original_filename')
      .eq('user_id', profileId)
      .is('purged_at', null)
      .order('id', { ascending: true })),
    loadAllStoragePages(() => adminClient
      .from('spore_measurement_mosaics')
      .select('id, storage_key, observation_id, version')
      .eq('user_id', profileId)
      .order('id', { ascending: true })),
  ])

  if (images.error || mosaics.error) {
    const message = images.error?.message || mosaics.error?.message || 'unknown error'
    return {
      ok: false as const,
      response: actionFailureResponse(500, 'profile_storage_rows_failed', `Failed to load profile storage inventory: ${message}`),
    }
  }

  return {
    ok: true as const,
    rows: [
      ...(Array.isArray(images.data) ? images.data.map((row: any) => ({ ...row, media_kind: 'image' })) : []),
      ...(Array.isArray(mosaics.data) ? mosaics.data.map((row: any) => ({ ...row, media_kind: 'mosaic' })) : []),
    ],
  }
}

async function loadAllStoragePages(buildQuery: () => any) {
  const rows: any[] = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const result = await buildQuery().range(offset, offset + pageSize - 1)
    if (result.error) return result
    const page = Array.isArray(result.data) ? result.data : []
    rows.push(...page)
    if (page.length < pageSize) return { data: rows, error: null }
  }
}

async function calculateProfileStorageUsage(
  env: Record<string, string | undefined>,
  rows: Array<Record<string, unknown>>,
) {
  return calculateProfileStorageUsageWithClient(rows, createR2Client(env))
}

export async function calculateProfileStorageUsageWithClient(
  rows: Array<Record<string, unknown>>,
  client: { headObject: (key: string) => Promise<any> },
) {
  const logicalObjects = new Map<string, string>()
  const rowSummaries: Array<Record<string, unknown>> = []
  let storageUsedBytes = 0
  let imageCount = 0
  let missingObjects = 0
  const warnings: string[] = []
  const classes: Record<string, { bytes: number; objects: number; missing: number }> = {
    full: { bytes: 0, objects: 0, missing: 0 },
    thumb: { bytes: 0, objects: 0, missing: 0 },
    original: { bytes: 0, objects: 0, missing: 0 },
    mosaic: { bytes: 0, objects: 0, missing: 0 },
  }

  for (const row of rows) {
    if (row.media_kind !== 'mosaic' && row.purged_at) continue
    for (const entry of buildProfileStorageEntries(row)) {
      if (!logicalObjects.has(entry.key)) logicalObjects.set(entry.key, entry.kind)
    }
  }

  const headResults = new Map<string, any>()
  const objectEntries = [...logicalObjects]
  const objectHeads = await mapWithConcurrency(objectEntries, 32, async ([key]) =>
    await client.headObject(key))
  for (let index = 0; index < objectEntries.length; index += 1) {
    const [key, kind] = objectEntries[index]
    const head = objectHeads[index]
    headResults.set(key, head)
    if (head.ok) {
      const bytes = Number(head.size || 0)
      storageUsedBytes += bytes
      classes[kind].bytes += bytes
      classes[kind].objects += 1
      if (kind === 'full') imageCount += 1
    } else if (head.status === 404) {
      missingObjects += 1
      classes[kind].missing += 1
    } else {
      warnings.push(`${key}: ${head.error}`)
    }
  }

  for (const row of rows) {
    if (row.media_kind !== 'mosaic' && row.purged_at) continue
    const entries = buildProfileStorageEntries(row)
    let rowBytes = 0
    const missingKeys: string[] = []
    const rowErrors: string[] = []

    for (const { key } of entries) {
      const head = headResults.get(key)
      if (head.ok) {
        rowBytes += Number(head.size || 0)
        continue
      }

      if (head.status === 404) {
        missingKeys.push(key)
        continue
      }

      rowErrors.push(`${key}: ${head.error}`)
    }

    rowSummaries.push({
      id: row.id ?? null,
      original_filename: row.original_filename ?? null,
      storage_path: row.storage_path ?? null,
      original_storage_path: row.original_storage_path ?? null,
      storage_key: row.storage_key ?? null,
      media_kind: row.media_kind ?? 'image',
      bytes: rowBytes,
      has_primary_object: entries.some(entry =>
        entry.kind === 'full' && headResults.get(entry.key)?.ok),
      missing_keys: missingKeys,
      errors: rowErrors,
    })
  }

  return {
    storage_used_bytes: storageUsedBytes,
    image_count: imageCount,
    checked_objects: logicalObjects.size,
    missing_objects: missingObjects,
    classes,
    warnings,
    rows: rowSummaries,
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
) {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++
      results[index] = await mapper(values[index])
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, limit), values.length) },
    () => worker(),
  ))
  return results
}

function buildProfileStorageEntries(row: Record<string, unknown>) {
  if (row.media_kind === 'mosaic') {
    const key = normalizeMediaKey(row.storage_key)
    return key ? [{ key, kind: 'mosaic' }] : []
  }
  const entries: Array<{ key: string; kind: string }> = []
  const fullPath = normalizeMediaKey(row.storage_path)
  if (fullPath) {
    entries.push({ key: fullPath, kind: 'full' })
    for (const key of legacyDerivedVariantPaths(fullPath)) {
      entries.push({ key, kind: 'thumb' })
    }
  }
  const originalPath = normalizeMediaKey(row.original_storage_path)
  if (originalPath) entries.push({ key: originalPath, kind: 'original' })
  return entries
}

function buildTombstonePreviewRow(row: any, restoreWindowDays: number, mediaPublicBaseUrl: string | null) {
  const deletedAt = toDate(row?.deleted_at)
  const purgedAt = toDate(row?.purged_at)
  const purgeAttemptedAt = toDate(row?.purge_attempted_at)
  const storagePath = normalizeMediaKey(row?.storage_path)
  const originalStoragePath = normalizeMediaKey(row?.original_storage_path)
  const deleteTargets = buildTombstoneDeleteTargets(storagePath, originalStoragePath)
  const restoreCutoffAt = getPurgeCutoffAt(restoreWindowDays)
  const enriched = buildMediaRowContext(row, {
    forceDeleted: true,
    mediaPublicBaseUrl,
    observation: row?.observation ?? row?.observations ?? null,
    ownerProfile: row?.owner ?? row?.profiles ?? row?.profile ?? null,
  })

  if (purgedAt) {
    return {
      ...enriched,
      storage_path: storagePath || null,
      original_storage_path: originalStoragePath || null,
      deleted_at: row?.deleted_at ?? null,
      purged_at: row?.purged_at ?? null,
      purge_attempted_at: row?.purge_attempted_at ?? null,
      purge_error: row?.purge_error ?? null,
      delete_targets: deleteTargets,
      status: 'skipped',
      skip_reason: 'already_purged',
      eligible: false,
      restore_cutoff_at: restoreCutoffAt.toISOString(),
    }
  }

  if (!deletedAt) {
    return {
      ...enriched,
      storage_path: storagePath || null,
      original_storage_path: originalStoragePath || null,
      deleted_at: row?.deleted_at ?? null,
      purged_at: row?.purged_at ?? null,
      purge_attempted_at: row?.purge_attempted_at ?? null,
      purge_error: row?.purge_error ?? null,
      delete_targets: deleteTargets,
      status: 'skipped',
      skip_reason: 'not_tombstoned',
      eligible: false,
      restore_cutoff_at: restoreCutoffAt.toISOString(),
    }
  }

  if (deletedAt.getTime() > restoreCutoffAt.getTime()) {
    return {
      ...enriched,
      storage_path: storagePath || null,
      original_storage_path: originalStoragePath || null,
      deleted_at: row?.deleted_at ?? null,
      purged_at: row?.purged_at ?? null,
      purge_attempted_at: row?.purge_attempted_at ?? null,
      purge_error: row?.purge_error ?? null,
      delete_targets: deleteTargets,
      status: 'skipped',
      skip_reason: 'restore_window_not_elapsed',
      eligible: false,
      restore_cutoff_at: restoreCutoffAt.toISOString(),
    }
  }

  if (!deleteTargets.length) {
    return {
      ...enriched,
      storage_path: storagePath || null,
      original_storage_path: originalStoragePath || null,
      deleted_at: row?.deleted_at ?? null,
      purged_at: row?.purged_at ?? null,
      purge_attempted_at: row?.purge_attempted_at ?? null,
      purge_error: row?.purge_error ?? null,
      delete_targets: deleteTargets,
      status: 'error',
      error: 'missing_recorded_storage_paths',
      eligible: true,
      restore_cutoff_at: restoreCutoffAt.toISOString(),
    }
  }

  return {
    ...enriched,
    storage_path: storagePath || null,
    original_storage_path: originalStoragePath || null,
    deleted_at: row?.deleted_at ?? null,
    purged_at: row?.purged_at ?? null,
    purge_attempted_at: row?.purge_attempted_at ?? null,
    purge_error: row?.purge_error ?? null,
    delete_targets: deleteTargets,
    status: 'eligible',
    eligible: true,
    restore_cutoff_at: restoreCutoffAt.toISOString(),
  }
}

function summarizeTombstoneRows(rows: Array<Record<string, unknown>>) {
  const counts = {
    eligible: 0,
    purged: 0,
    skipped: 0,
    errors: 0,
  }

  for (const row of rows) {
    const status = normalizeText(row.status)
    if (status === 'eligible') counts.eligible += 1
    else if (status === 'purged') counts.purged += 1
    else if (status === 'error') counts.errors += 1
    else counts.skipped += 1
  }

  return counts
}

export async function purgeSingleTombstoneRow(
  context: Pick<AdminActionContext, 'adminClient' | 'env'>,
  row: Record<string, unknown>,
  r2Client: Pick<R2MultiBucketClient, 'deleteObjects'>,
) {
  const now = new Date().toISOString()
  const rowId = row.id

  // Re-checked for every row, before any R2 call or row write: the batch loop
  // iterates preselected rows and would otherwise never see the disable.
  if (!isTombstonePurgeEnabled(context.env)) {
    return {
      ...row,
      status: 'skipped',
      error: TOMBSTONE_PURGE_DISABLED,
    }
  }
  const deleteTargets = Array.isArray(row.delete_targets) ? row.delete_targets.map(value => normalizeMediaKey(value)) : []

  if (!deleteTargets.length) {
    await updateTombstonePurgeMetadata(context.adminClient, rowId, {
      purge_attempted_at: now,
      purge_error: 'missing_recorded_storage_paths',
    })
    return {
      ...row,
      status: 'error',
      error: 'missing_recorded_storage_paths',
      purge_attempted_at: now,
      purge_error: 'missing_recorded_storage_paths',
    }
  }

  // Stage 0a: claim the tombstone and retire its key family in one database
  // transaction BEFORE any R2 call, and delete only the keys the claim
  // returns (never the client-side buildTombstoneDeleteTargets list). One
  // claim UUID per row attempt; it is returned in the row result, which the
  // action log keeps.
  const claimId = crypto.randomUUID()
  const claim = await callRpcWithRetry(context.adminClient, 'claim_tombstoned_image_purge', {
    p_claim_id: claimId,
    p_image_id: rowId,
    p_restore_window_days: getRestoreWindowDays(context.env),
  })
  const claimResult: Record<string, any> = normalizeRecord(claim.data) ?? {}
  const claimStatus = claim.error ? 'claim_failed' : normalizeText(claimResult.status)
  if (claimStatus === 'already_claimed') {
    // An earlier attempt claimed the row; its record's stored keys are
    // deleted (and the row finalized) by sweep_retired_media_keys.
    return {
      ...row,
      status: 'skipped',
      skip_reason: 'already_claimed',
      claim_id: claimId,
      retirement_id: claimResult.retirement_id ?? null,
      message: 'Already claimed; run sweep_retired_media_keys to finish it',
    }
  }
  if (claimStatus !== 'claimed') {
    const purgeError = claim.error
      ? `purge_claim_failed: ${claim.error.message || claim.error.code || 'unknown'}`.slice(0, 500)
      : (claimStatus || 'purge_claim_failed')
    await updateTombstonePurgeMetadata(context.adminClient, rowId, {
      purge_attempted_at: now,
      purge_error: purgeError,
    })
    return {
      ...row,
      status: 'error',
      error: purgeError,
      claim_id: claimId,
      purge_attempted_at: now,
      purge_error: purgeError,
    }
  }
  // The claim's keys are passed to R2 as stored. A key the R2 client would
  // normalize into another object (whitespace, a leading slash) is refused
  // and nothing is deleted for this row.
  const { keys: claimedKeys, rejected: rejectedClaimKeys } = canonicalDeleteKeys(claimResult.delete_keys)
  if (rejectedClaimKeys > 0) {
    const purgeError = 'noncanonical_delete_key'
    await updateTombstonePurgeMetadata(context.adminClient, rowId, {
      purge_attempted_at: now,
      purge_error: purgeError,
    })
    return {
      ...row,
      status: 'error',
      error: purgeError,
      claim_id: claimId,
      retirement_id: claimResult.retirement_id ?? null,
      purge_attempted_at: now,
      purge_error: purgeError,
    }
  }

  // The quota is debited per key through the deletion ledger (see
  // mediaDeleteLedger); finalize_observation_image_purge only marks the row.
  const ownerId = normalizeText(row.user_id)
  if (claimedKeys.length && !isValidTombstoneUuid(ownerId)) {
    const purgeError = 'purge_owner_missing'
    await updateTombstonePurgeMetadata(context.adminClient, rowId, {
      purge_attempted_at: now,
      purge_error: purgeError,
    })
    return {
      ...row,
      status: 'error',
      error: purgeError,
      claim_id: claimId,
      retirement_id: claimResult.retirement_id ?? null,
      purge_attempted_at: now,
      purge_error: purgeError,
    }
  }
  let deletion
  try {
    if (claimedKeys.length) {
      const ledger = mediaDeleteLedger(context.adminClient, ownerId, claimedKeys)
      deletion = await r2Client.deleteObjects(ledger.keys, ledger.hooks)
    } else {
      deletion = { logicalBytes: 0, targets: [] }
    }
  } catch (error) {
    const failure = normalizeActionFailure(error)
    // Only sizes measured in R2 count: stored_bytes is client-written.
    const retryAccountingBytes = Math.max(
      0,
      Number(row.purge_accounting_bytes || 0),
      Number(failure.details?.logicalBytes || 0),
    )
    await updateTombstonePurgeMetadata(context.adminClient, rowId, {
      purge_attempted_at: now,
      purge_error: failure.message,
      purge_accounting_bytes: retryAccountingBytes,
    })
    return {
      ...row,
      status: 'error',
      error: failure.message,
      claim_id: claimId,
      delete_targets: claimedKeys,
      purge_attempted_at: now,
      purge_error: failure.message,
    }
  }

  const accountingBytes = Math.max(
    0,
    Number(deletion.logicalBytes || 0),
    Number(row.purge_accounting_bytes || 0),
  )
  const snapshotResult = await updateTombstonePurgeMetadata(context.adminClient, rowId, {
    purge_attempted_at: now,
    purge_accounting_bytes: accountingBytes,
  })
  if (!snapshotResult.ok) {
    return {
      ...row,
      status: 'error',
      error: 'purge_accounting_snapshot_failed',
      purge_attempted_at: now,
      purge_error: 'purge_accounting_snapshot_failed',
    }
  }

  const { error: finalizeError } = await callRpcWithRetry(context.adminClient, 'finalize_observation_image_purge', {
    p_image_id: rowId,
    p_purged_at: now,
    p_storage_bytes: accountingBytes,
  })
  if (finalizeError) {
    await updateTombstonePurgeMetadata(context.adminClient, rowId, {
      purge_attempted_at: now,
      purge_error: `purge_finalize_failed: ${finalizeError.message}`.slice(0, 500),
    })
    return {
      ...row,
      status: 'error',
      error: 'purge_finalize_failed',
      purge_attempted_at: now,
      purge_error: 'purge_finalize_failed',
    }
  }

  const purgedRow = {
    ...row,
    status: 'purged',
    purged_at: now,
    purge_attempted_at: now,
    purge_error: null,
    error: null,
    message: 'Purged successfully',
    logical_bytes_deleted: accountingBytes,
    bucket_results: deletion.targets,
    claim_id: claimId,
    retirement_id: claimResult.retirement_id ?? null,
    delete_targets: claimedKeys,
  }
  const issueFlags = buildImageIssueFlags(purgedRow, false)

  return {
    ...purgedRow,
    image_status: 'purged',
    issue_flags: issueFlags,
    issue_severity: buildMediaIssueSeverity(purgedRow, false),
    issue_summary: buildIssueSummary(issueFlags),
  }
}

// Plan §L retry policy for every RPC caller: SQLSTATE 40P01 (deadlock),
// 40001 (serialization failure) and 55P03 (lock not available), at most 3
// attempts with 100-400 ms random jitter. The claim, sweep and finalize RPCs
// are idempotent, so a retry after an abort is safe.
export const RETRYABLE_RPC_SQLSTATES = new Set(['40P01', '40001', '55P03'])

export async function callRpcWithRetry(
  adminClient: any,
  fn: string,
  args: Record<string, unknown>,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ data: any; error: any; attempts: number }> {
  const attempts = options.attempts ?? 3
  const sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  let last: { data: any; error: any } = { data: null, error: null }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await adminClient.rpc(fn, args)
    const code = normalizeText(last?.error?.code)
    if (!last?.error || !RETRYABLE_RPC_SQLSTATES.has(code) || attempt === attempts) {
      return { data: last?.data ?? null, error: last?.error ?? null, attempts: attempt }
    }
    await sleep(100 + Math.floor(Math.random() * 301))
  }
  return { data: last.data, error: last.error, attempts }
}

const SWEEP_BATCH_LIMIT_DEFAULT = 50
const SWEEP_BATCH_LIMIT_MAX = 500
const SWEEP_MAX_BATCHES = 10

// Repeatable sweep of retired media keys (Stage 0a item 6/8): claim a batch
// of retirement records (the database re-checks references under the key
// locks and moves every handed-out record to the back of the queue through
// last_attempted_at), delete exactly their stored delete_keys, finalize
// interrupted purges, then record the finished ones. Never computes keys.
async function sweepRetiredMediaKeys(context: AdminActionContext): Promise<AdminActionResponse> {
  if (!isTombstonePurgeEnabled(context.env)) {
    return actionFailureResponse(409, TOMBSTONE_PURGE_DISABLED, 'Tombstone purge (and the retired-key sweep) is disabled on the server')
  }
  const reason = requireNonEmptyText(context.requestBody?.reason, 'Reason is required')
  if (!reason.ok) {
    return actionFailureResponse(400, reason.code, reason.message)
  }
  const limit = Math.min(SWEEP_BATCH_LIMIT_MAX, normalizePositiveInteger(context.requestBody?.limit, SWEEP_BATCH_LIMIT_DEFAULT))
  const batches = Math.min(SWEEP_MAX_BATCHES, normalizePositiveInteger(context.requestBody?.batches, 1))

  return await withAdminActionLog({
    adminClient: context.adminClient,
    adminUser: context.adminUser,
    action: 'sweep_retired_media_keys',
    targetType: 'media_key_retirement_batch',
    targetId: `limit:${limit}:batches:${batches}`,
    reason: reason.value,
    requestPayload: context.requestBody,
    beforeSnapshot: { limit, batches },
    run: async () => runRetiredKeySweep(context, { limit, batches }),
  })
}

export async function runRetiredKeySweep(
  context: Pick<AdminActionContext, 'adminClient' | 'env'>,
  options: { limit: number; batches: number },
  r2ClientFactory: (preflightKey: string) => Promise<{ ok: true; client: Pick<R2MultiBucketClient, 'deleteObjects'> } | { ok: false; failure: ActionFailure }> =
    key => prepareR2PurgeClient(context.env, key),
) {
  const rows: Array<Record<string, unknown>> = []
  const counts = { swept: 0, guard_failed: 0, errors: 0, finalized: 0 }
  let r2Client: Pick<R2MultiBucketClient, 'deleteObjects'> | null = null

  for (let batch = 0; batch < options.batches; batch += 1) {
    if (!isTombstonePurgeEnabled(context.env)) break
    const claimed = await callRpcWithRetry(context.adminClient, 'claim_retired_key_sweep', { p_limit: options.limit })
    if (claimed.error) {
      throw actionError(500, 'sweep_claim_failed', `claim_retired_key_sweep failed: ${claimed.error.message || claimed.error.code}`)
    }
    const records = Array.isArray(claimed.data) ? claimed.data : []
    if (!records.length) break
    const recordedIds: number[] = []

    for (const record of records) {
      const retirementId = Number(record.retirement_id)
      const { keys, rejected: rejectedKeys } = canonicalDeleteKeys(record.delete_keys)
      if (record.status !== 'ok' || rejectedKeys > 0) {
        counts.guard_failed += 1
        const blocking = record.status !== 'ok'
          ? (record.blocking_references ?? null)
          : [{ reason: 'noncanonical_delete_key', count: rejectedKeys }]
        rows.push({ retirement_id: retirementId, image_id: record.image_id, reason: record.reason, status: 'guard_failed', blocking_references: blocking })
        recordedIds.push(retirementId) // rotate it to the back of the queue; it is reported, never deleted
        continue
      }
      if (!isTombstonePurgeEnabled(context.env)) break
      // Every key is debited through the Worker's per-key deletion ledger,
      // which the desktop's and web's own Worker DELETEs of the same keys
      // share, so the bytes and the image are debited once whichever deletes
      // first, for a release and a purge alike. The purge finalizer only
      // marks the row purged.
      try {
        let logicalBytes = 0
        if (keys.length) {
          const userId = normalizeText(record.user_id)
          if (!isValidTombstoneUuid(userId)) throw actionError(500, 'sweep_record_user_missing', 'Retirement record has no owner id')
          if (!r2Client) {
            const prepared = await r2ClientFactory(keys[0])
            if (!prepared.ok) throw actionError(prepared.failure.status, prepared.failure.code, prepared.failure.message)
            r2Client = prepared.client
          }
          const ledger = mediaDeleteLedger(context.adminClient, userId, keys)
          const deletion = await r2Client.deleteObjects(ledger.keys, ledger.hooks)
          logicalBytes = Number(deletion?.logicalBytes || 0)
        }
        // Finalize only a purge whose image row still exists and is not yet
        // purged. A row removed by account deletion or an observation hard
        // delete (ON DELETE CASCADE), or one already purged, needs no
        // finalize: its keys are deleted and the record counts as done.
        if (record.reason === 'purge' && record.image_exists !== false && !record.image_purged_at) {
          const finalized = await callRpcWithRetry(context.adminClient, 'finalize_observation_image_purge', {
            p_image_id: record.image_id,
            p_purged_at: new Date().toISOString(),
            p_storage_bytes: logicalBytes,
          })
          if (finalized.error) throw actionError(500, 'purge_finalize_failed', finalized.error.message || 'finalize failed')
          const finalizedRow = Array.isArray(finalized.data) ? finalized.data[0] : finalized.data
          if (finalizedRow?.quota_changed) counts.finalized += 1
        }
        counts.swept += 1
        recordedIds.push(retirementId)
        rows.push({ retirement_id: retirementId, image_id: record.image_id, reason: record.reason, status: 'swept', delete_targets: keys })
      } catch (error) {
        const failure = normalizeActionFailure(error)
        counts.errors += 1
        rows.push({ retirement_id: retirementId, image_id: record.image_id, reason: record.reason, status: 'error', error: failure.message })
      }
    }

    if (recordedIds.length) {
      const recorded = await callRpcWithRetry(context.adminClient, 'record_retired_key_sweep', { p_retirement_ids: recordedIds })
      if (recorded.error) {
        throw actionError(500, 'sweep_record_failed', `record_retired_key_sweep failed: ${recorded.error.message || recorded.error.code}`)
      }
    }
    if (records.length < options.limit) break
  }

  return { counts, rows }
}

// ── Orphan prefix sweep ──────────────────────────────────────────────
//
// Deletes the media left under '<user_id>/' after an account is gone: a late
// upload that landed after delete-account's last sweep (the Worker's
// post-write profile check fails open on a lookup or delete error), or a
// deletion run that got past delete_profile and was never retried.
// public.media_prefix_owner_status (20261126130000) decides which prefixes
// may be swept; nothing else is deleted. A prefix that another owner's row
// still references (media_prefix_foreign_references) is left for review.
// Per prefix: list the objects, check the owner again, then delete exactly
// the listed objects, so an object written after the listing is never
// touched and an owner that changed in between stops the delete; list again
// afterwards and report 'incomplete' if anything is left.
//
// Dry run by default. A real run also needs the tombstone purge switch and
// `expected_sweepable` equal to the number of sweepable prefixes (take it
// from a dry run), and is refused when no prefix belongs to a live account:
// both catch a database and an R2 bucket of different environments (local
// functions with production R2 keys would classify every production prefix
// as sweepable). No quota accounting: the profile is gone.

const ORPHAN_SWEEP_PREFIX_LIMIT_DEFAULT = 20
const ORPHAN_SWEEP_PREFIX_LIMIT_MAX = 200
const ORPHAN_SWEEP_OBJECT_BUDGET = 50_000
const OWNER_STATUS_BATCH = 500
const FOREIGN_REFERENCE_BATCH = 1000

export type OrphanSweepObject = { bucket: string; key: string; size: number }

export type OrphanSweepR2Client = {
  buckets: string[]
  listTopLevelPrefixes: () => Promise<string[]>
  listObjects: (prefix: string) => Promise<OrphanSweepObject[]>
  deleteObjects: (objects: OrphanSweepObject[]) => Promise<void>
}

type OwnerStatus = {
  user_id: string
  has_profile: boolean
  has_auth_user: boolean
  deletion_marked: boolean
  sweepable: boolean
}

async function sweepOrphanMediaPrefixes(context: AdminActionContext): Promise<AdminActionResponse> {
  const reason = requireNonEmptyText(context.requestBody?.reason, 'Reason is required')
  if (!reason.ok) {
    return actionFailureResponse(400, reason.code, reason.message)
  }
  const dryRun = context.requestBody?.dry_run !== false
  if (!dryRun && !isTombstonePurgeEnabled(context.env)) {
    return actionFailureResponse(409, TOMBSTONE_PURGE_DISABLED, 'Tombstone purge (and the orphan prefix sweep) is disabled on the server; a dry run is still allowed')
  }
  const expectedRaw = context.requestBody?.expected_sweepable
  const expectedSweepable = Number.isInteger(expectedRaw) && Number(expectedRaw) >= 0 ? Number(expectedRaw) : null
  if (!dryRun && expectedSweepable === null) {
    return actionFailureResponse(400, 'expected_sweepable_required', 'A real run needs expected_sweepable: the sweepable count from a dry run')
  }
  const limit = Math.min(ORPHAN_SWEEP_PREFIX_LIMIT_MAX, normalizePositiveInteger(context.requestBody?.limit, ORPHAN_SWEEP_PREFIX_LIMIT_DEFAULT))

  return await withAdminActionLog({
    adminClient: context.adminClient,
    adminUser: context.adminUser,
    action: 'sweep_orphan_media_prefixes',
    targetType: 'media_prefix_batch',
    targetId: `limit:${limit}:dry_run:${dryRun}`,
    reason: reason.value,
    requestPayload: context.requestBody,
    beforeSnapshot: { limit, dry_run: dryRun, expected_sweepable: expectedSweepable },
    run: async () => runOrphanPrefixSweep(context, { limit, dryRun, expectedSweepable }),
  })
}

async function loadOwnerStatuses(adminClient: any, userIds: string[]): Promise<Map<string, OwnerStatus>> {
  const statuses = new Map<string, OwnerStatus>()
  for (let i = 0; i < userIds.length; i += OWNER_STATUS_BATCH) {
    const batch = userIds.slice(i, i + OWNER_STATUS_BATCH)
    const { data, error } = await callRpcWithRetry(adminClient, 'media_prefix_owner_status', { p_user_ids: batch })
    if (error) {
      throw actionError(500, 'owner_status_failed', `media_prefix_owner_status failed: ${error.message || error.code}`)
    }
    for (const row of Array.isArray(data) ? data : []) {
      const id = normalizeText(row?.user_id).toLowerCase()
      if (id) statuses.set(id, row as OwnerStatus)
    }
  }
  return statuses
}

async function countForeignReferences(adminClient: any, userId: string, keys: string[]): Promise<number> {
  let total = 0
  for (let i = 0; i < keys.length; i += FOREIGN_REFERENCE_BATCH) {
    const { data, error } = await callRpcWithRetry(adminClient, 'media_prefix_foreign_references', {
      p_user_id: userId,
      p_keys: keys.slice(i, i + FOREIGN_REFERENCE_BATCH),
    })
    if (error) {
      throw actionError(500, 'foreign_reference_check_failed', `media_prefix_foreign_references failed: ${error.message || error.code}`)
    }
    const count = Number(data)
    if (!Number.isFinite(count)) throw actionError(500, 'foreign_reference_check_failed', 'media_prefix_foreign_references returned no count')
    total += count
  }
  return total
}

function ownerState(status: OwnerStatus | undefined): 'live' | 'sweepable' | 'needs_review' {
  if (!status) return 'needs_review' // not classified: never deleted
  if (status.has_profile) return 'live'
  return status.sweepable === true ? 'sweepable' : 'needs_review'
}

export async function runOrphanPrefixSweep(
  context: Pick<AdminActionContext, 'adminClient' | 'env'>,
  options: { limit: number; dryRun: boolean; expectedSweepable?: number | null },
  clientFactory: (env: Record<string, string | undefined>) => OrphanSweepR2Client = createOrphanSweepR2Client,
) {
  const client = clientFactory(context.env)
  const counts = {
    prefixes_scanned: 0,
    non_uuid_skipped: 0,
    live: 0,
    needs_review: 0,
    sweepable: 0,
    foreign_referenced: 0,
    would_delete: 0,
    swept: 0,
    partial: 0,
    incomplete: 0,
    owner_changed: 0,
    errors: 0,
    objects_deleted: 0,
    bytes_deleted: 0,
  }
  const rows: Array<Record<string, unknown>> = []

  const names = [...new Set(await client.listTopLevelPrefixes())]
  counts.prefixes_scanned = names.length
  // Only canonical lowercase user ids: other names (legacy folders, an id in
  // another case) are not keys the app writes under '<user_id>/', so they are
  // counted and left alone.
  const canonical = names.filter(name => isValidTombstoneUuid(name) && name === name.toLowerCase())
  counts.non_uuid_skipped = names.length - canonical.length

  const statuses = await loadOwnerStatuses(context.adminClient, canonical)
  const candidates: string[] = []
  for (const userId of canonical) {
    const state = ownerState(statuses.get(userId))
    if (state === 'live') counts.live += 1
    else if (state === 'needs_review') {
      counts.needs_review += 1
      const status = statuses.get(userId)
      rows.push({
        user_id: userId,
        status: 'needs_review',
        has_auth_user: status?.has_auth_user ?? null,
        deletion_marked: status?.deletion_marked ?? null,
      })
    } else candidates.push(userId)
  }
  counts.sweepable = candidates.length

  if (!options.dryRun) {
    if (canonical.length > 0 && counts.live === 0) {
      throw actionError(409, 'no_live_prefixes', 'No media prefix belongs to a live account; the database and the R2 buckets may be of different environments', { counts })
    }
    if (options.expectedSweepable !== counts.sweepable) {
      throw actionError(409, 'sweepable_count_mismatch', `expected_sweepable is ${options.expectedSweepable ?? 'missing'}, the sweep found ${counts.sweepable}; run a dry run first`, { counts })
    }
  }

  let objectBudget = ORPHAN_SWEEP_OBJECT_BUDGET
  for (const userId of candidates.slice(0, options.limit)) {
    if (!options.dryRun && objectBudget <= 0) break
    const prefix = `${userId}/`
    try {
      const listed = (await client.listObjects(prefix)).filter(object => object.key.startsWith(prefix))
      const foreign = await countForeignReferences(context.adminClient, userId, [...new Set(listed.map(object => object.key))])
      if (foreign > 0) {
        counts.foreign_referenced += 1
        rows.push({ user_id: userId, status: 'needs_review', foreign_references: foreign, objects: listed.length })
        continue
      }
      const bytesOf = (list: OrphanSweepObject[]) => list.reduce((sum, object) => sum + Math.max(0, Number(object.size) || 0), 0)
      if (options.dryRun) {
        counts.would_delete += 1
        rows.push({ user_id: userId, status: 'would_delete', objects: listed.length, bytes: bytesOf(listed), buckets: [...new Set(listed.map(o => o.bucket))] })
        continue
      }
      // Re-check after listing: only objects listed while the account was
      // still gone are deleted.
      const recheck = ownerState((await loadOwnerStatuses(context.adminClient, [userId])).get(userId))
      if (recheck !== 'sweepable') {
        counts.owner_changed += 1
        rows.push({ user_id: userId, status: 'owner_changed', owner: recheck })
        continue
      }
      // A prefix over the remaining budget is deleted in part; the next run
      // continues it. The budget is charged before the delete, so a failed
      // delete still counts against it.
      const batch = listed.slice(0, objectBudget)
      objectBudget -= batch.length
      await client.deleteObjects(batch)
      counts.objects_deleted += batch.length
      counts.bytes_deleted += bytesOf(batch)
      const left = (await client.listObjects(prefix)).filter(object => object.key.startsWith(prefix)).length
      let status = 'swept'
      if (batch.length < listed.length) status = 'partial'
      else if (left > 0) status = 'incomplete'
      if (status === 'swept') counts.swept += 1
      else if (status === 'partial') counts.partial += 1
      else counts.incomplete += 1
      rows.push({ user_id: userId, status, objects: batch.length, bytes: bytesOf(batch), objects_left: left })
    } catch (error) {
      const failure = normalizeActionFailure(error)
      counts.errors += 1
      rows.push({ user_id: userId, status: 'error', error: failure.message })
    }
  }

  // complete: every sweepable prefix was handled in this run and nothing is
  // left behind or failed. Otherwise run the sweep again.
  const complete = !options.dryRun
    && counts.errors === 0 && counts.partial === 0 && counts.incomplete === 0
    && counts.swept + counts.owner_changed + counts.foreign_referenced >= counts.sweepable
  return { dry_run: options.dryRun, complete, buckets: client.buckets, counts, rows }
}

// S3-compatible listing client for the orphan sweep. Unlike createR2Client it
// needs R2_PRIVATE_BUCKET_NAME set (a bucket name or 'none'): a sweep that
// silently skipped the private bucket would report a clean result.
export function createOrphanSweepR2Client(env: Record<string, string | undefined>): OrphanSweepR2Client {
  const accessKeyId = normalizeText(env.R2_ACCESS_KEY_ID)
  const secretAccessKey = normalizeText(env.R2_SECRET_ACCESS_KEY)
  const endpoint = normalizeText(env.R2_S3_ENDPOINT).replace(/\/+$/, '')
  if (!accessKeyId || !secretAccessKey || !endpoint) {
    throw actionError(500, 'missing_r2_configuration', 'R2 is not configured')
  }
  const privateSetting = parsePrivateBucketSetting(env.R2_PRIVATE_BUCKET_NAME)
  if (!privateSetting.configured) {
    throw actionError(500, 'missing_r2_configuration', 'R2_PRIVATE_BUCKET_NAME must be set (the bucket name or none)')
  }
  const legacy = normalizeText(env.R2_BUCKET_NAME) || R2_BUCKET_NAME
  const buckets = [...new Set([legacy, privateSetting.bucket].filter((b): b is string => Boolean(b)))]
  const s3 = new S3Client({ region: R2_REGION, endpoint, credentials: { accessKeyId, secretAccessKey } })

  return {
    buckets,
    async listTopLevelPrefixes() {
      const names = new Set<string>()
      try {
        for (const bucket of buckets) {
          let token: string | undefined
          do {
            const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Delimiter: '/', ContinuationToken: token, MaxKeys: 1000 }))
            for (const entry of page.CommonPrefixes ?? []) {
              const name = String(entry.Prefix ?? '').replace(/\/$/, '')
              if (name) names.add(name)
            }
            token = page.IsTruncated ? page.NextContinuationToken : undefined
          } while (token)
        }
      } catch (error) {
        const failure = normalizeR2SdkFailure(error, 'R2 list failed')
        throw actionError(failure.status, 'r2_list_failed', failure.message)
      }
      return [...names]
    },
    async listObjects(prefix: string) {
      if (!/^[0-9a-f-]{36}\/$/.test(prefix)) throw actionError(400, 'invalid_prefix', 'Refusing to list a prefix that is not <user_id>/')
      const objects: OrphanSweepObject[] = []
      try {
        for (const bucket of buckets) {
          let token: string | undefined
          do {
            const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }))
            for (const item of page.Contents ?? []) {
              if (item.Key) objects.push({ bucket, key: item.Key, size: Number(item.Size ?? 0) })
            }
            token = page.IsTruncated ? page.NextContinuationToken : undefined
          } while (token)
        }
      } catch (error) {
        const failure = normalizeR2SdkFailure(error, 'R2 list failed')
        throw actionError(failure.status, 'r2_list_failed', failure.message)
      }
      return objects
    },
    async deleteObjects(objects: OrphanSweepObject[]) {
      for (const bucket of buckets) {
        const keys = objects.filter(object => object.bucket === bucket).map(object => object.key)
        for (let i = 0; i < keys.length; i += 1000) {
          let errors = 0
          try {
            const result = await s3.send(new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: keys.slice(i, i + 1000).map(Key => ({ Key })), Quiet: true },
            }))
            errors = result.Errors?.length ?? 0
          } catch (error) {
            const failure = normalizeR2SdkFailure(error, 'R2 delete failed')
            throw actionError(failure.status, 'r2_delete_failed', failure.message)
          }
          if (errors) throw actionError(502, 'r2_delete_partial_failure', `${errors} delete error(s) in ${bucket}; retry the sweep`)
        }
      }
    },
  }
}

async function updateTombstonePurgeMetadata(adminClient: any, imageId: unknown, payload: Record<string, unknown>) {
  const { error } = await adminClient
    .from('observation_images')
    .update(payload)
    .eq('id', imageId)

  if (error) {
    console.error('Failed to update observation_images purge metadata:', error)
    return { ok: false as const }
  }

  return { ok: true as const }
}

export function buildProfileStorageKeys(row: Record<string, unknown>) {
  return [...new Set(buildProfileStorageEntries(row).map(entry => entry.key))]
}

export function buildTombstoneDeleteTargets(storagePath: string, originalStoragePath: string) {
  const paths = new Set<string>()
  const fullPath = normalizeMediaKey(storagePath)
  if (fullPath) {
    paths.add(fullPath)
    for (const variantPath of legacyDerivedVariantPaths(fullPath)) paths.add(variantPath)
  }
  const originalPath = normalizeMediaKey(originalStoragePath)
  if (originalPath) paths.add(originalPath)
  return [...paths]
}

function buildTombstoneSearchText(row: any) {
  return normalizeText([
    row?.id,
    row?.observation_id,
    row?.user_id,
    row?.storage_path,
    row?.original_storage_path,
    row?.original_filename,
    row?.micro_category,
    row?.image_type,
    row?.upload_mode,
    row?.observation_display_name,
    row?.observation_taxon_label,
    row?.observation_date,
    row?.owner_label,
    row?.owner_email,
    row?.owner_username,
    row?.owner_display_name,
    row?.observation?.date,
    row?.observation?.genus,
    row?.observation?.species,
    row?.observation?.common_name,
    row?.observation?.species_guess,
    row?.observation?.author,
    row?.observation?.ai_selected_scientific_name,
    row?.owner?.username,
    row?.owner?.display_name,
    row?.purge_error,
  ].join(' ')).toLowerCase()
}

export function isValidTombstoneUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export function resolveTombstoneLimit(requestBody: Record<string, unknown> | null): number {
  return Math.min(normalizePositiveInteger(requestBody?.limit, PURGE_CANDIDATE_LIMIT), PURGE_CANDIDATE_LIMIT)
}

export function buildTombstoneScopeLabel(options: { userId?: string; observationId: string; storagePath: string; queryText: string }) {
  const parts: string[] = []
  if (options.userId) parts.push(`user:${options.userId}`)
  if (options.observationId) parts.push(`observation:${options.observationId}`)
  else if (options.storagePath) parts.push(`storage_path:${options.storagePath}`)
  else if (options.queryText) parts.push(`query:${options.queryText}`)
  if (!parts.length) return 'all'
  return parts.join('/')
}

export function getRestoreWindowDays(
  env: Record<string, string | undefined>,
  _getEnvValue?: (env: Record<string, string | undefined>) => string | undefined,
) {
  const getter = typeof _getEnvValue === 'function' ? _getEnvValue : (e: Record<string, string | undefined>) => e.ADMIN_TOMBSTONE_RESTORE_WINDOW_DAYS
  const raw = String(getter(env) ?? '').trim()
  // Strict digits only: parseInt would truncate values like "1e2" to 1 and
  // silently shorten the destructive purge window.
  if (!/^\d+$/.test(raw)) return DEFAULT_TOMBSTONE_RESTORE_WINDOW_DAYS
  const parsed = Number.parseInt(raw, 10)
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
  return DEFAULT_TOMBSTONE_RESTORE_WINDOW_DAYS
}

export const TOMBSTONE_PURGE_DISABLED = 'tombstone_purge_disabled'

// Fail closed: the destructive tombstone purge runs only when the server-side
// secret ADMIN_TOMBSTONE_PURGE_ENABLED is exactly "true". Absent, empty or any
// other value disables it. Re-enable only after claim-aware admin-ops (plan
// Stage 0a item 8 / rollout step 4) is deployed and verified.
export function isTombstonePurgeEnabled(env: Record<string, string | undefined> | null | undefined): boolean {
  return String(env?.ADMIN_TOMBSTONE_PURGE_ENABLED ?? '').trim() === 'true'
}

function getPurgeCutoffAt(restoreWindowDays: number) {
  const safeDays = Number.isFinite(restoreWindowDays) && restoreWindowDays > 0 ? restoreWindowDays : DEFAULT_TOMBSTONE_RESTORE_WINDOW_DAYS
  return new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000)
}

function getMediaPublicBaseUrl(env: Record<string, string | undefined>) {
  return normalizeText(env.MEDIA_PUBLIC_BASE_URL ?? env.VITE_MEDIA_BASE_URL).replace(/\/+$/, '')
}

function legacyDerivedVariantPaths(storagePath: string) {
  const normalized = normalizeMediaKey(storagePath)
  if (!normalized) return []
  const parts = normalized.split('/')
  const fileName = stripLegacyVariantPrefixes(parts.pop() || '')
  const dir = parts.join('/')
  return ['thumb', 'thumb_small', 'thumb_medium'].map(prefix => {
    const name = `${prefix}_${fileName}`
    return dir ? `${dir}/${name}` : name
  })
}

function deriveThumbPath(storagePath: unknown) {
  const normalized = normalizeMediaKey(storagePath)
  if (!normalized) return null

  const segments = normalized.split('/').filter(Boolean)
  const fileName = segments.pop()
  if (!fileName) return normalized

  const thumbName = fileName.startsWith('thumb_') ? fileName : `thumb_${fileName}`
  return [...segments, thumbName].join('/')
}

function stripLegacyVariantPrefixes(fileName: string) {
  return String(fileName || '').replace(/^(?:thumb_|medium_|small_|cards_)+/i, '')
}

function normalizeMediaKey(value: unknown) {
  return normalizeText(value).replace(/^\/+/, '')
}

// Retirement delete_keys are stored already normalized by SQL. Keep each
// key byte-for-byte; any value normalizeMediaKey would change (or a
// non-string) is counted as rejected so the caller deletes nothing.
export function canonicalDeleteKeys(values: unknown): { keys: string[]; rejected: number } {
  const keys: string[] = []
  let rejected = 0
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value === 'string' && value.length > 0 && normalizeMediaKey(value) === value) keys.push(value)
    else rejected += 1
  }
  return { keys, rejected }
}

function normalizeRecord(value: unknown) {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    return normalizeRecord(value[0])
  }

  return value as Record<string, unknown>
}

function escapeLike(value: string) {
  return String(value || '')
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_')
}

function normalizeText(value: unknown) {
  return String(value ?? '').trim()
}

function isBlank(value: unknown) {
  return value === null || value === undefined || String(value).trim() === ''
}

function toTimestamp(value: unknown) {
  const date = new Date(String(value ?? ''))
  const time = date.getTime()
  return Number.isFinite(time) ? time : 0
}

function buildOwnerLabel(id: unknown, username: unknown, displayName: unknown, email: unknown) {
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

function buildObservationTaxonLabel(observation: Record<string, unknown> | null | undefined) {
  const scientificName = normalizeText(observation?.ai_selected_scientific_name)
  if (scientificName) return scientificName

  const genus = normalizeText(observation?.genus)
  const species = normalizeText(observation?.species)
  if (genus && species) return `${genus} ${species}`
  if (genus) return genus
  if (species) return species

  const speciesGuess = normalizeText(observation?.species_guess)
  if (speciesGuess) return speciesGuess

  const commonName = normalizeText(observation?.common_name)
  if (commonName) return commonName

  return null
}

function buildObservationDisplayName(observation: Record<string, unknown> | null | undefined) {
  const commonName = normalizeText(observation?.common_name)
  if (commonName) return commonName

  const speciesGuess = normalizeText(observation?.species_guess)
  if (speciesGuess) return speciesGuess

  const taxonLabel = buildObservationTaxonLabel(observation)
  if (taxonLabel) return taxonLabel

  const author = normalizeText(observation?.author)
  if (author) return author

  return null
}

function buildMediaPublicUrl(baseUrl: string | null | undefined, storagePath: unknown) {
  const normalizedBaseUrl = normalizeText(baseUrl).replace(/\/+$/, '')
  const normalizedPath = normalizeMediaKey(storagePath)
  if (!normalizedBaseUrl || !normalizedPath) return null

  return `${normalizedBaseUrl}/${normalizedPath
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/')}`
}

function buildPathTail(storagePath: unknown) {
  const normalized = normalizeMediaKey(storagePath)
  if (!normalized) return null

  const segments = normalized.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? normalized
}

function formatBytes(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const bytes = Number(value)
  if (!Number.isFinite(bytes)) return null

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let amount = Math.abs(bytes)
  let unitIndex = 0

  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024
    unitIndex += 1
  }

  const formatted = amount >= 10 || unitIndex === 0 ? amount.toFixed(0) : amount.toFixed(1)
  return `${bytes < 0 ? '-' : ''}${formatted} ${units[unitIndex]}`
}

export function buildImageIssueFlags(row: Record<string, unknown>, forceDeleted: boolean, restoreWindowDays: number = DEFAULT_TOMBSTONE_RESTORE_WINDOW_DAYS): string[] {
  const storage_path = row?.storage_path
  const image_type = normalizeText(row?.image_type).toLowerCase()

  // 1. Purged
  if (row?.purged_at) return ['permanently_removed']

  // 2. Microscope anchor (metadata-only)
  if (image_type === 'microscope' && !storage_path) return []

  const tombstoned = forceDeleted || Boolean(row?.deleted_at)

  // 3. Active missing storage_path
  if (!tombstoned && isBlank(storage_path)) return ['active_media_missing']

  if (tombstoned) {
    // 4. Purge failed
    if (!isBlank(row?.purge_error) && !row?.purged_at) return ['purge_failed']

    // 5 & 6. No purge error
    if (isBlank(row?.purge_error) && !row?.purged_at) {
      const cutoffDate = new Date(Date.now() - restoreWindowDays * 24 * 60 * 60 * 1000)
      const deletedAtDate = new Date(String(row?.deleted_at ?? ''))
      const deletedAtValid = Number.isFinite(deletedAtDate.getTime())
      if (deletedAtValid && deletedAtDate <= cutoffDate) return ['reclaimable_deleted_media']
      return ['deleted_media_in_restore_window']
    }
  }

  // 7. Active with storage_path but missing stored_bytes
  if (!tombstoned && !isBlank(storage_path) && isBlank(row?.stored_bytes)) return ['size_metadata_unavailable']

  // 8. Healthy
  return []
}

export function buildMediaIssueSeverity(row: Record<string, unknown>, forceDeleted: boolean, restoreWindowDays: number = DEFAULT_TOMBSTONE_RESTORE_WINDOW_DAYS): string | null {
  const flags = buildImageIssueFlags(row, forceDeleted, restoreWindowDays)
  const flag = flags[0]
  switch (flag) {
    case 'permanently_removed': return null
    case undefined: return null
    case 'active_media_missing': return 'critical'
    case 'purge_failed': return 'warning'
    case 'reclaimable_deleted_media': return 'warning'
    case 'deleted_media_in_restore_window': return 'info'
    case 'size_metadata_unavailable': return 'info'
    default: return null
  }
}

function isMetadataOnlyMicroscopeRow(row: Record<string, unknown>) {
  return isBlank(row?.storage_path) && normalizeText(row?.image_type) === 'microscope'
}

export function buildIssueSummary(flags: string[]): string {
  if (!flags.length) return '—'
  const flag = flags[0]
  switch (flag) {
    case 'permanently_removed': return 'Permanently removed — purged from cloud storage.'
    case 'active_media_missing': return 'Active media missing — storage path is unrecorded. Verify or re-upload.'
    case 'purge_failed': return 'Cleanup failed — the file could not be permanently removed. Retry or inspect the purge error.'
    case 'reclaimable_deleted_media': return 'Ready to reclaim — recovery period has elapsed; physical storage can be permanently removed.'
    case 'deleted_media_in_restore_window': return 'Deleted media — recovery period. Cloud file retained temporarily for recovery.'
    case 'size_metadata_unavailable': return 'Size metadata unavailable — the storage object may still be healthy. Verify storage usage to check actual R2 size.'
    default: return String(flag).replaceAll('_', ' ')
  }
}

export function buildMediaRowContext(
  row: Record<string, unknown>,
  options: {
    forceDeleted?: boolean
    mediaPublicBaseUrl?: string | null
    observation?: Record<string, unknown> | null
    ownerProfile?: Record<string, unknown> | null
    ownerEmail?: string | null
    restoreWindowDays?: number
  } = {},
) {
  const observation = normalizeRecord(options.observation ?? row?.observation ?? row?.observations)
  const ownerProfile = normalizeRecord(options.ownerProfile ?? row?.owner ?? row?.profiles ?? row?.profile)
  const ownerId = normalizeText(row?.user_id ?? ownerProfile?.id ?? row?.owner_id ?? row?.profile_id)
  const ownerEmail = normalizeText(options.ownerEmail ?? row?.owner_email ?? row?.user_email ?? row?.email)
  const ownerUsername = normalizeText(ownerProfile?.username ?? row?.owner_username ?? row?.user_username)
  const ownerDisplayName = normalizeText(ownerProfile?.display_name ?? row?.owner_display_name ?? row?.user_display_name)
  const observationId = normalizeText(row?.observation_id ?? observation?.id)
  const observationDate = normalizeText(observation?.date ?? row?.observation_date)
  const observationDisplayName = buildObservationDisplayName(observation)
  const observationTaxonLabel = buildObservationTaxonLabel(observation)
  const storagePath = normalizeMediaKey(row?.storage_path)
  const originalStoragePath = normalizeMediaKey(row?.original_storage_path)
  const fullSizePath = storagePath || originalStoragePath || null
  const thumbnailPath = normalizeMediaKey(row?.thumbnail_path) || deriveThumbPath(fullSizePath)
  const fullSizeUrl = buildMediaPublicUrl(options.mediaPublicBaseUrl, fullSizePath)
  const thumbnailUrl = buildMediaPublicUrl(options.mediaPublicBaseUrl, thumbnailPath)
  const restoreWindowDays = typeof options.restoreWindowDays === 'number' ? options.restoreWindowDays : DEFAULT_TOMBSTONE_RESTORE_WINDOW_DAYS
  const issueFlags = buildImageIssueFlags(row, options.forceDeleted === true, restoreWindowDays)
  const issueSeverity = buildMediaIssueSeverity(row, options.forceDeleted === true, restoreWindowDays)
  const issueSummary = buildIssueSummary(issueFlags)
  const imageStatus = row?.purged_at ? 'purged' : (options.forceDeleted || row?.deleted_at ? 'deleted' : 'active')

  return {
    ...row,
    observation_id: observationId || null,
    observation_display_name: observationDisplayName,
    observation_taxon_label: observationTaxonLabel,
    observation_date: observationDate || null,
    user_id: ownerId || null,
    owner_email: ownerEmail || null,
    owner_username: ownerUsername || null,
    owner_display_name: ownerDisplayName || null,
    owner_label: buildOwnerLabel(ownerId, ownerUsername, ownerDisplayName, ownerEmail),
    storage_path: storagePath || null,
    original_storage_path: originalStoragePath || null,
    full_size_path: fullSizePath,
    thumbnail_path: thumbnailPath,
    full_size_url: fullSizeUrl,
    thumbnail_url: thumbnailUrl,
    storage_tail: buildPathTail(storagePath || originalStoragePath),
    original_storage_tail: buildPathTail(originalStoragePath),
    issue_flags: issueFlags,
    issue_summary: issueSummary,
    issue_severity: issueSeverity,
    image_status: imageStatus,
  }
}

function normalizePositiveInteger(value: unknown, fallback: number) {
  const parsed = Number.parseInt(normalizeText(value), 10)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return fallback
}

/** Exported for testing the commit-path reason gate in recalculateProfileStorageUsage. */
export function validateRecalculateReason(value: unknown): { ok: boolean; code?: string; message?: string } {
  return requireNonEmptyText(value, 'Reason is required')
}

function requireNonEmptyText(value: unknown, message: string): { ok: true; value: string } | { ok: false; code: string; message: string } {
  const text = normalizeText(value)
  if (!text) {
    return { ok: false, code: 'missing_required_field', message }
  }
  return { ok: true, value: text }
}

function resolveProfileId(requestBody: Record<string, unknown> | null) {
  const value = normalizeText(requestBody?.user_id ?? requestBody?.profile_id)
  if (!value) {
    return { ok: false as const, code: 'missing_profile_id', message: 'user_id or profile_id is required' }
  }
  return { ok: true as const, value }
}

async function loadSingleRow(adminClient: any, table: string, column: string, value: string, select: string[]) {
  const { data, error } = await adminClient
    .from(table)
    .select(select.join(', '))
    .eq(column, value)
    .maybeSingle()

  if (error) {
    return {
      ok: false as const,
      response: actionFailureResponse(500, `${table}_read_failed`, `Failed to load ${table}: ${error.message}`),
    }
  }

  if (!data) {
    return {
      ok: false as const,
      response: actionFailureResponse(404, `${table}_not_found`, `${table} row not found`),
    }
  }

  return { ok: true as const, row: data }
}

async function countRows(adminClient: any, table: string, applyFilter?: (query: any) => any) {
  let query = adminClient.from(table).select('id', { count: 'exact', head: true })
  if (applyFilter) {
    query = applyFilter(query)
  }

  const { count, error } = await query
  if (error) {
    throw actionError(500, `${table}_count_failed`, `Failed to count rows in ${table}: ${error.message}`)
  }

  return Number(count ?? 0)
}

async function safeCountRows(adminClient: any, table: string, applyFilter?: (query: any) => any) {
  try {
    return await countRows(adminClient, table, applyFilter)
  } catch (error) {
    console.error(`Failed to count rows in ${table}:`, error)
    return null
  }
}

export function createR2Client(env: Record<string, string | undefined>) {
  const accessKeyId = normalizeText(env.R2_ACCESS_KEY_ID)
  const secretAccessKey = normalizeText(env.R2_SECRET_ACCESS_KEY)
  const s3Endpoint = normalizeText(env.R2_S3_ENDPOINT).replace(/\/+$/, '')
  const legacyBucketName = normalizeText(env.R2_BUCKET_NAME) || R2_BUCKET_NAME
  // Shared with delete-account: 'none' means the Worker binds no private
  // bucket; unset keeps the legacy bucket only (as before).
  const privateBucketName = parsePrivateBucketSetting(env.R2_PRIVATE_BUCKET_NAME).bucket ?? ''

  if (!accessKeyId || !secretAccessKey || !s3Endpoint) {
    throw actionError(500, 'missing_r2_configuration', 'R2 purge is not configured')
  }

  const common = { accessKeyId, secretAccessKey, s3Endpoint }
  const clients = [new R2BatchClient({ ...common, bucketName: legacyBucketName, role: 'legacy' })]
  if (privateBucketName && privateBucketName !== legacyBucketName) {
    clients.push(new R2BatchClient({ ...common, bucketName: privateBucketName, role: 'private' }))
  }
  return new R2MultiBucketClient(clients)
}

async function prepareR2PurgeClient(env: Record<string, string | undefined>, preflightTarget: string) {
  try {
    const client = createR2Client(env)
    await client.assertObjectAccess(preflightTarget)
    return { ok: true as const, client }
  } catch (error) {
    return {
      ok: false as const,
      failure: normalizeActionFailure(error),
    }
  }
}

export type MediaDeleteHooks = {
  beforeDelete?: (key: string, snapshot: { bytes: number; held: boolean }) => Promise<void>
  afterDelete?: (key: string, snapshot: { bytes: number; held: boolean }) => Promise<void>
}

// Mirrors isPrimaryImageKey in cloudflare/r2-upload-worker/src/index.js: the
// key of a logical observation image (not a thumb, an original or a mosaic).
export function isPrimaryMediaKey(key: string): boolean {
  const normalized = String(key || '').replace(/^\/+/, '')
  const filename = normalized.split('/').pop() || ''
  if (!filename || filename.startsWith('thumb_')) return false
  if (normalized.includes('/originals/')) return false
  if (/^spore_mosaic(?:_|\.)/i.test(filename)) return false
  return true
}

const MEDIA_VARIANT_PREFIX = /^(?:thumb_|small_|medium_|cards_|preview_)/

// Quota debits for raw key deletes go through the Worker's per-key ledger
// (public.prepare_media_object_deletion / finalize_media_object_deletion),
// with the size measured in R2 just before the delete. The ledger keeps one
// row per (user, key), so the sweep and the desktop's Worker DELETE of the
// same key debit once between them: whichever runs second finds the object
// gone, prepares 0 bytes and finalizes nothing new. If both measured the
// object before either deleted it, the second prepare does not re-open the
// first one's finalized entry, because the key is retired (20261126120000
// section 13). A crash or a partial bucket failure between the delete and
// the finalize is finished by the next attempt, because prepare keeps the
// larger earlier snapshot of each key until its row is finalized.
//
// The image is debited only on the family's unprefixed primary key (not a
// small_/medium_/cards_/preview_ copy), so at most one image per family, on
// every attempt and whichever of the sweep and the Worker deletes that key.
// If that key is already gone the image is not debited again here; a
// family whose only primary object was a prefixed copy keeps its image
// count until recalculate_profile_storage_usage (the safe direction).
export function isImageLedgerKey(key: string): boolean {
  return isPrimaryMediaKey(key) && !MEDIA_VARIANT_PREFIX.test(key.split('/').pop() || '')
}

export function mediaDeleteLedger(adminClient: any, userId: string, keys: string[]) {
  const hooks: MediaDeleteHooks = {
    beforeDelete: async (key, { bytes, held }) => {
      const imageCount = held && isImageLedgerKey(key) ? 1 : 0
      const { error } = await callRpcWithRetry(adminClient, 'prepare_media_object_deletion', {
        p_user_id: userId,
        p_storage_key: key,
        p_storage_bytes: Math.max(0, Math.trunc(bytes)),
        p_image_count: imageCount,
      })
      if (error) {
        throw actionError(500, 'media_delete_accounting_prepare_failed', error.message || 'prepare_media_object_deletion failed')
      }
    },
    afterDelete: async key => {
      const { error } = await callRpcWithRetry(adminClient, 'finalize_media_object_deletion', {
        p_user_id: userId,
        p_storage_key: key,
      })
      if (error) {
        throw actionError(500, 'media_delete_accounting_finalize_failed', error.message || 'finalize_media_object_deletion failed')
      }
    },
  }
  return { keys, hooks }
}

export class R2MultiBucketClient {
  clients: R2BatchClient[]

  constructor(clients: R2BatchClient[]) {
    this.clients = clients
  }

  async assertObjectAccess(key: string) {
    const results = await Promise.all(this.clients.map(client => client.headObject(key)))
    const failed = results.find(result => !result.ok && result.status !== 404)
    if (failed) {
      throw actionError(failed.status, 'r2_access_check_failed', failed.error || 'R2 object access check failed', {
        role: failed.role,
        operation: 'head',
      })
    }
  }

  async headObject(key: string) {
    const results = await Promise.all(this.clients.map(client => client.headObject(key)))
    const failed = results.find(result => !result.ok && result.status !== 404)
    if (failed) return failed
    const present = results.filter(result => result.ok)
    if (!present.length) {
      return {
        ok: false as const,
        status: 404,
        error: 'Object not found in any configured bucket',
        kind: isOriginalImageKey(key) ? 'original' as const : 'variant' as const,
        role: 'all',
      }
    }
    return {
      ok: true as const,
      status: 200,
      size: Math.max(...present.map(result => Number(result.size || 0))),
      kind: isOriginalImageKey(key) ? 'original' as const : 'variant' as const,
      role: 'logical',
      targets: results.map(result => ({
        role: result.role,
        present: result.ok,
        bytes: result.ok ? result.size : 0,
      })),
    }
  }

  // hooks.beforeDelete runs once per key after every bucket was inspected and
  // before any delete of that key; a throw skips the key's delete. Hooks
  // .afterDelete runs only when the key is gone from every bucket. Both get
  // the key's logical size (the largest copy) and whether any copy existed.
  async deleteObjects(keys: Iterable<string>, hooks: MediaDeleteHooks = {}) {
    const cleaned = [...new Set([...keys].map(key => normalizeMediaKey(key)).filter(Boolean))]
    let logicalBytes = 0
    const targets: Array<Record<string, unknown>> = []
    let firstFailure: ActionFailure | null = null

    for (const key of cleaned) {
      const heads = await Promise.all(this.clients.map(client => client.headObject(key)))
      const headFailure = heads.find(result => !result.ok && result.status !== 404)
      if (headFailure) {
        targets.push({ key, role: headFailure.role, operation: 'head', ok: false, error: headFailure.error })
        firstFailure ??= {
          status: headFailure.status,
          code: 'r2_head_failed',
          message: headFailure.error || 'R2 head failed',
        }
        continue
      }
      const snapshot = {
        bytes: Math.max(0, ...heads.map(result => result.ok ? Number(result.size || 0) : 0)),
        held: heads.some(result => result.ok),
      }
      logicalBytes += snapshot.bytes

      if (hooks.beforeDelete) {
        try {
          await hooks.beforeDelete(key, snapshot)
        } catch (error) {
          const failure = normalizeActionFailure(error)
          firstFailure ??= failure
          targets.push({ key, role: 'all', operation: 'accounting_prepare', ok: false, error: failure.message })
          continue
        }
      }

      const deletes = await Promise.all(this.clients.map(async client => {
        try {
          await client.deleteObject(key)
          return { key, role: client.role, operation: 'delete', ok: true }
        } catch (error) {
          const failure = normalizeActionFailure(error)
          firstFailure ??= failure
          return { key, role: client.role, operation: 'delete', ok: false, error: failure.message }
        }
      }))
      targets.push(...deletes)

      if (hooks.afterDelete && deletes.every(result => result.ok)) {
        try {
          await hooks.afterDelete(key, snapshot)
        } catch (error) {
          const failure = normalizeActionFailure(error)
          firstFailure ??= failure
          targets.push({ key, role: 'all', operation: 'accounting_finalize', ok: false, error: failure.message })
        }
      }
    }

    if (firstFailure) {
      throw actionError(
        firstFailure.status,
        'r2_delete_partial_failure',
        'R2 cleanup was incomplete and can be retried',
        { targets, logicalBytes },
      )
    }
    return { logicalBytes, targets }
  }
}

class R2BatchClient {
  role: 'legacy' | 'private'
  bucketName: string
  client: S3Client

  constructor(config: { accessKeyId: string; secretAccessKey: string; s3Endpoint: string; bucketName: string; role: 'legacy' | 'private' }) {
    this.role = config.role
    this.bucketName = config.bucketName
    this.client = new S3Client({
      region: R2_REGION,
      endpoint: config.s3Endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    })
  }

  async deleteObject(key: string) {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }))
    } catch (error) {
      const failure = normalizeR2SdkFailure(error, 'R2 delete failed')
      throw actionError(failure.status, 'r2_delete_failed', failure.message, {
        role: this.role,
        operation: 'delete',
      })
    }
  }

  async headObject(key: string) {
    const cleaned = normalizeMediaKey(key)
    if (!cleaned) {
      return {
        ok: false as const,
        status: 400,
        error: 'Missing R2 key',
        kind: 'variant' as const,
        role: this.role,
      }
    }

    const kind = isOriginalImageKey(cleaned) ? 'original' : 'variant'
    try {
      const response = await this.client.send(new HeadObjectCommand({ Bucket: this.bucketName, Key: cleaned }))
      const size = Number(response.ContentLength ?? 0)
      return {
        ok: true as const,
        status: response.$metadata.httpStatusCode ?? 200,
        size: Number.isFinite(size) && size > 0 ? Math.trunc(size) : 0,
        kind,
        role: this.role,
      }
    } catch (error) {
      const failure = normalizeR2SdkFailure(error, 'R2 head failed')
      return {
        ok: false as const,
        status: failure.status,
        error: failure.message,
        kind,
        role: this.role,
      }
    }
  }
}

function normalizeR2SdkFailure(error: unknown, fallback: string) {
  const failure = error && typeof error === 'object' ? error as Record<string, any> : {}
  const status = Number(failure.$metadata?.httpStatusCode ?? failure.statusCode ?? 500)
  const code = normalizeText(failure.Code ?? failure.code ?? failure.name)
  const detail = normalizeText(failure.message)
  const suffix = [code, detail].filter(Boolean).join(': ')
  return {
    status: Number.isInteger(status) ? status : 500,
    message: `${fallback}${status ? ` (${status})` : ''}${suffix ? `: ${suffix}` : ''}`.slice(0, 500),
  }
}

function isOriginalImageKey(key: string) {
  const fileName = String(key || '').split('/').pop() || ''
  return !!fileName && !fileName.startsWith('thumb_')
}

function actionFailureResponse(status: number, code: string, message: string, details: Record<string, unknown> | null = null): AdminActionResponse {
  return {
    status,
    body: {
      ok: false,
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
    },
  }
}

function actionError(status: number, code: string, message: string, details: Record<string, unknown> | null = null) {
  const error = new Error(message) as Error & {
    status?: number
    code?: string
    details?: Record<string, unknown> | null
  }
  error.status = status
  error.code = code
  error.details = details
  return error
}

function normalizeActionFailure(error: unknown): ActionFailure {
  const status = getStatus(error) ?? 500
  const code = typeof (error as any)?.code === 'string' && String((error as any).code).trim()
    ? String((error as any).code).trim()
    : 'admin_action_failed'
  const message = error instanceof Error ? error.message : 'Admin action failed'
  const details = typeof (error as any)?.details === 'object' && (error as any)?.details
    ? (error as any).details
    : null

  return { status, code, message, details }
}

function getStatus(error: unknown) {
  const contextStatus = (error as any)?.context?.status
  if (Number.isInteger(contextStatus)) return contextStatus

  const directStatus = (error as any)?.status
  if (Number.isInteger(directStatus)) return directStatus

  return null
}

function cleanJson(value: unknown) {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value))
}

function toDate(value: unknown) {
  const date = new Date(String(value ?? ''))
  return Number.isFinite(date.getTime()) ? date : null
}

// ---------------------------------------------------------------------------
// Stage 3: per-user media storage breakdown
// ---------------------------------------------------------------------------

/**
 * Derives the restore-window cutoff ISO string from a window in days.
 * Extracted so both the snapshot handler and unit tests use the same formula.
 */
export function buildRestoreCutoffIso(windowDays: number): string {
  return new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString()
}

export type MediaStorageBreakdown = {
  active_rows: number | null
  metadata_only_anchor_rows: number | null
  deleted_retained_rows: number | null
  reclaimable_rows: number | null
  restore_window_rows: number | null
  purge_error_rows: number | null
  purged_rows: number | null
  active_recorded_primary_bytes: number | null
  deleted_retained_recorded_primary_bytes: number | null
  reclaimable_recorded_primary_bytes: number | null
  restore_window_recorded_primary_bytes: number | null
  active_unknown_primary_size_rows: number | null
  deleted_retained_unknown_primary_size_rows: number | null
}

/**
 * Calls admin_media_storage_breakdown RPC once for all supplied user IDs and
 * returns a Map<userId, MediaStorageBreakdown>. On RPC error, pushes a warning
 * and returns an empty map (callers must tolerate absent rows).
 */
export async function fetchMediaStorageBreakdown(
  adminClient: any,
  userIds: string[],
  cutoffIso: string,
  warnings: string[],
): Promise<Map<string, MediaStorageBreakdown>> {
  const result = new Map<string, MediaStorageBreakdown>()
  if (userIds.length === 0) return result

  const { data, error } = await adminClient.rpc('admin_media_storage_breakdown', {
    p_user_ids: userIds,
    p_restore_cutoff_at: cutoffIso,
  })

  if (error) {
    warnings.push(`media_storage_breakdown: ${error.message}`)
    return result
  }

  for (const row of data ?? []) {
    const id = String(row.user_id ?? '').trim()
    if (!id) continue
    result.set(id, {
      active_rows: row.active_rows ?? null,
      metadata_only_anchor_rows: row.metadata_only_anchor_rows ?? null,
      deleted_retained_rows: row.deleted_retained_rows ?? null,
      reclaimable_rows: row.reclaimable_rows ?? null,
      restore_window_rows: row.restore_window_rows ?? null,
      purge_error_rows: row.purge_error_rows ?? null,
      purged_rows: row.purged_rows ?? null,
      active_recorded_primary_bytes: row.active_recorded_primary_bytes ?? null,
      deleted_retained_recorded_primary_bytes: row.deleted_retained_recorded_primary_bytes ?? null,
      reclaimable_recorded_primary_bytes: row.reclaimable_recorded_primary_bytes ?? null,
      restore_window_recorded_primary_bytes: row.restore_window_recorded_primary_bytes ?? null,
      active_unknown_primary_size_rows: row.active_unknown_primary_size_rows ?? null,
      deleted_retained_unknown_primary_size_rows: row.deleted_retained_unknown_primary_size_rows ?? null,
    })
  }

  return result
}

/**
 * Pure function: attaches media_storage breakdown to each top-storage-user row.
 * Users without a matching row in the breakdown map receive media_storage: null.
 * The input rows are not mutated; enriched copies are returned.
 */
export function attachMediaStorageBreakdown<T extends { id: string }>(
  users: T[],
  breakdownByUser: Map<string, MediaStorageBreakdown>,
): (T & { media_storage: MediaStorageBreakdown | null })[] {
  return users.map(user => ({
    ...user,
    media_storage: breakdownByUser.get(String(user.id ?? '').trim()) ?? null,
  }))
}

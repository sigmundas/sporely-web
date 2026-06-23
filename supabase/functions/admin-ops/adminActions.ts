const DEFAULT_TOMBSTONE_RESTORE_WINDOW_DAYS = 30
const PURGE_CANDIDATE_LIMIT = 500
const R2_BUCKET_NAME = 'sporely-media'
const R2_REGION = 'auto'
const R2_SERVICE = 's3'

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
      selection: selection.scope,
      counts,
      rows: preview,
      truncated: selection.truncated,
    },
  }
}

async function purgeExpiredTombstonedImages(context: AdminActionContext): Promise<AdminActionResponse> {
  const selection = await loadTombstoneSelection(context.adminClient, context.requestBody, context.env)
  const previewRows = selection.rows.map(row =>
    buildTombstonePreviewRow(row, selection.restoreWindowDays, getMediaPublicBaseUrl(context.env)),
  )
  const eligibleRows = previewRows.filter(row => row.status === 'eligible')
  const warnings: string[] = []

  const beforeSnapshot = {
    restore_window_days: selection.restoreWindowDays,
    restore_cutoff_at: selection.restoreCutoffAt,
    selection: selection.scope,
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
      const rowResults = []
      for (const row of eligibleRows) {
        const result = await purgeSingleTombstoneRow(context, row)
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

  const storageRows = await loadProfileStorageRows(context.adminClient, profileId.value)
  if (!storageRows.ok) {
    return storageRows.response
  }

  const beforeSnapshot = {
    profile: profile.row,
    inventory: {
      observation_image_rows: storageRows.rows.length,
    },
  }

  return await withAdminActionLog({
    adminClient: context.adminClient,
    adminUser: context.adminUser,
    action: 'recalculate_profile_storage_usage',
    targetType: 'profile',
    targetId: profileId.value,
    reason: reason.value,
    requestPayload: context.requestBody,
    beforeSnapshot,
    run: async () => {
      const recalculated = await calculateProfileStorageUsage(context.env, storageRows.rows)
      const currentStorageUsedBytes = Number(profile.row.storage_used_bytes ?? 0)
      const currentImageCount = Number(profile.row.image_count ?? 0)
      const storageDelta = recalculated.storage_used_bytes - currentStorageUsedBytes
      const imageDelta = recalculated.image_count - currentImageCount

      const { data, error } = await context.adminClient.rpc('apply_profile_storage_delta', {
        p_user_id: profile.row.id,
        p_storage_delta: storageDelta,
        p_image_delta: imageDelta,
      })

      if (error) {
        throw actionError(500, 'profile_storage_recalculate_failed', `Failed to update profile storage totals: ${error.message}`)
      }

      const updatedProfile = Array.isArray(data) ? data[0] ?? null : data
      return {
        profile_id: profile.row.id,
        recalculated,
        delta: {
          storage_used_bytes: storageDelta,
          image_count: imageDelta,
        },
        profile: updatedProfile ?? {
          id: profile.row.id,
          total_storage_bytes: recalculated.storage_used_bytes,
          storage_used_bytes: recalculated.storage_used_bytes,
          image_count: recalculated.image_count,
        },
      }
    },
  })
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
  const restoreWindowDays = getRestoreWindowDays(env, requestBody)
  const restoreCutoffAt = getPurgeCutoffAt(restoreWindowDays)
  const limit = normalizePositiveInteger(requestBody?.limit, PURGE_CANDIDATE_LIMIT)
  const observationId = normalizeText(requestBody?.observation_id)
  const storagePath = normalizeText(requestBody?.storage_path)
  const queryText = normalizeText(requestBody?.query)

  let query = adminClient
    .from('observation_images')
    .select(
      'id, observation_id, user_id, storage_path, original_storage_path, original_filename, deleted_at, purged_at, purge_attempted_at, purge_error, created_at, source_width, source_height, stored_width, stored_height, stored_bytes, image_type, micro_category, upload_mode, sort_order, observation:observations!observation_images_observation_id_fkey(id, date, genus, species, common_name, species_guess, author, ai_selected_scientific_name, ai_selected_taxon_id, ai_selected_probability, created_at), owner:profiles!observation_images_user_id_fkey(id, username, display_name)',
    )
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: true })
    .limit(limit)

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

  return {
    rows: filteredRows,
    restoreWindowDays,
    restoreCutoffAt: restoreCutoffAt.toISOString(),
    scope: buildTombstoneScopeLabel({ observationId, storagePath, queryText }),
    truncated: Array.isArray(data) ? data.length >= limit : false,
  }
}

async function loadProfileStorageRows(adminClient: any, profileId: string) {
  const { data, error } = await adminClient
    .from('observation_images')
    .select('id, storage_path, original_storage_path, deleted_at, purged_at, original_filename')
    .eq('user_id', profileId)

  if (error) {
    return {
      ok: false as const,
      response: actionFailureResponse(500, 'profile_storage_rows_failed', `Failed to load profile storage inventory: ${error.message}`),
    }
  }

  return {
    ok: true as const,
    rows: Array.isArray(data) ? data : [],
  }
}

async function calculateProfileStorageUsage(
  env: Record<string, string | undefined>,
  rows: Array<Record<string, unknown>>,
) {
  const client = createR2Client(env)
  const seenKeys = new Set<string>()
  const rowSummaries: Array<Record<string, unknown>> = []
  let storageUsedBytes = 0
  let imageCount = 0
  let missingObjects = 0
  const warnings: string[] = []

  for (const row of rows) {
    const keys = buildProfileStorageKeys(row)
    let rowBytes = 0
    let rowHasOriginalObject = false
    const missingKeys: string[] = []
    const rowErrors: string[] = []

    for (const key of keys) {
      seenKeys.add(key)
      const head = await client.headObject(key)
      if (head.ok) {
        rowBytes += head.size
        if (head.kind === 'original') {
          rowHasOriginalObject = true
        }
        continue
      }

      if (head.status === 404) {
        missingKeys.push(key)
        missingObjects += 1
        continue
      }

      rowErrors.push(`${key}: ${head.error}`)
      warnings.push(`${key}: ${head.error}`)
    }

    if (rowHasOriginalObject) {
      imageCount += 1
    }

    storageUsedBytes += rowBytes
    rowSummaries.push({
      id: row.id ?? null,
      original_filename: row.original_filename ?? null,
      storage_path: row.storage_path ?? null,
      original_storage_path: row.original_storage_path ?? null,
      bytes: rowBytes,
      has_original_object: rowHasOriginalObject,
      missing_keys: missingKeys,
      errors: rowErrors,
    })
  }

  return {
    storage_used_bytes: storageUsedBytes,
    image_count: imageCount,
    checked_objects: seenKeys.size,
    missing_objects: missingObjects,
    warnings,
    rows: rowSummaries,
  }
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

async function purgeSingleTombstoneRow(context: AdminActionContext, row: Record<string, unknown>) {
  const now = new Date().toISOString()
  const rowId = row.id
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

  try {
    const client = createR2Client(context.env)
    await client.deleteObjects(deleteTargets)
  } catch (error) {
    const failure = normalizeActionFailure(error)
    await updateTombstonePurgeMetadata(context.adminClient, rowId, {
      purge_attempted_at: now,
      purge_error: failure.message,
    })
    return {
      ...row,
      status: 'error',
      error: failure.message,
      purge_attempted_at: now,
      purge_error: failure.message,
    }
  }

  const updateResult = await updateTombstonePurgeMetadata(context.adminClient, rowId, {
    purged_at: now,
    purge_attempted_at: now,
    purge_error: null,
  })

  if (!updateResult.ok) {
    return {
      ...row,
      status: 'error',
      error: 'purge_metadata_update_failed',
      purge_attempted_at: now,
      purge_error: 'purge_metadata_update_failed',
    }
  }

  return {
    ...row,
    status: 'purged',
    purged_at: now,
    purge_attempted_at: now,
    purge_error: null,
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

function buildProfileStorageKeys(row: Record<string, unknown>) {
  const keys = new Set<string>()
  for (const rawPath of [row.storage_path, row.original_storage_path]) {
    const normalized = normalizeMediaKey(rawPath)
    if (!normalized) continue
    keys.add(normalized)
    const thumbPath = getVariantPath(normalized, 'thumb')
    if (thumbPath && thumbPath !== normalized) {
      keys.add(thumbPath)
    }
  }
  return [...keys]
}

function buildTombstoneDeleteTargets(storagePath: string, originalStoragePath: string) {
  const paths = new Set<string>()
  for (const path of [storagePath, originalStoragePath]) {
    const normalized = normalizeMediaKey(path)
    if (!normalized) continue
    paths.add(normalized)
    const thumbPath = getVariantPath(normalized, 'thumb')
    if (thumbPath && thumbPath !== normalized) {
      paths.add(thumbPath)
    }
  }
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

function buildTombstoneScopeLabel(options: { observationId: string; storagePath: string; queryText: string }) {
  if (options.observationId) return `observation:${options.observationId}`
  if (options.storagePath) return `storage_path:${options.storagePath}`
  if (options.queryText) return `query:${options.queryText}`
  return 'all'
}

function getRestoreWindowDays(env: Record<string, string | undefined>, requestBody: Record<string, unknown> | null = null) {
  const explicit = normalizePositiveInteger(requestBody?.restore_window_days, DEFAULT_TOMBSTONE_RESTORE_WINDOW_DAYS)
  const envValue = normalizePositiveInteger(env.ADMIN_TOMBSTONE_RESTORE_WINDOW_DAYS, DEFAULT_TOMBSTONE_RESTORE_WINDOW_DAYS)
  return explicit ?? envValue ?? DEFAULT_TOMBSTONE_RESTORE_WINDOW_DAYS
}

function getPurgeCutoffAt(restoreWindowDays: number) {
  const safeDays = Number.isFinite(restoreWindowDays) && restoreWindowDays > 0 ? restoreWindowDays : DEFAULT_TOMBSTONE_RESTORE_WINDOW_DAYS
  return new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000)
}

function getMediaPublicBaseUrl(env: Record<string, string | undefined>) {
  return normalizeText(env.MEDIA_PUBLIC_BASE_URL ?? env.VITE_MEDIA_BASE_URL).replace(/\/+$/, '')
}

function getVariantPath(storagePath: string, variant = 'original') {
  const normalized = normalizeMediaKey(storagePath)
  if (!normalized || variant === 'original') return normalized

  const parts = normalized.split('/')
  const fileName = parts.pop() || ''
  const dir = parts.join('/')
  const variantName = ['thumb', 'small', 'medium', 'cards'].includes(String(variant || '').toLowerCase())
    ? `thumb_${stripLegacyVariantPrefixes(fileName)}`
    : `${variant}_${fileName}`
  return dir ? `${dir}/${variantName}` : variantName
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
  const date = new Date(value ?? '')
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

function buildImageIssueFlags(row: Record<string, unknown>, forceDeleted: boolean) {
  const flags: string[] = []

  if (forceDeleted || row?.deleted_at) {
    flags.push('deleted')
  }

  if (row?.purged_at) {
    flags.push('purged')
  }

  if (!isBlank(row?.purge_error)) {
    flags.push('purge_error')
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

function buildMediaIssueSeverity(row: Record<string, unknown>, forceDeleted: boolean) {
  if (row?.purged_at) {
    return 'info'
  }

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

function buildIssueSummary(flags: string[]) {
  if (!flags.length) return '—'

  return flags
    .map(flag => {
      switch (flag) {
        case 'deleted':
          return 'tombstoned'
        case 'purged':
          return 'purged from r2'
        case 'purge_error':
          return 'purge error'
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

export function buildMediaRowContext(
  row: Record<string, unknown>,
  options: {
    forceDeleted?: boolean
    mediaPublicBaseUrl?: string | null
    observation?: Record<string, unknown> | null
    ownerProfile?: Record<string, unknown> | null
    ownerEmail?: string | null
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
  const issueFlags = buildImageIssueFlags(row, options.forceDeleted === true)
  const issueSeverity = buildMediaIssueSeverity(row, options.forceDeleted === true)
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

function createR2Client(env: Record<string, string | undefined>) {
  const accessKeyId = normalizeText(env.R2_ACCESS_KEY_ID)
  const secretAccessKey = normalizeText(env.R2_SECRET_ACCESS_KEY)
  const s3Endpoint = normalizeText(env.R2_S3_ENDPOINT).replace(/\/+$/, '')
  const bucketName = normalizeText(env.R2_BUCKET_NAME) || R2_BUCKET_NAME

  if (!accessKeyId || !secretAccessKey || !s3Endpoint) {
    throw actionError(500, 'missing_r2_configuration', 'R2 purge is not configured')
  }

  return new R2BatchClient({
    accessKeyId,
    secretAccessKey,
    s3Endpoint,
    bucketName,
  })
}

class R2BatchClient {
  config: {
    accessKeyId: string
    secretAccessKey: string
    s3Endpoint: string
    bucketName: string
  }

  constructor(config: { accessKeyId: string; secretAccessKey: string; s3Endpoint: string; bucketName: string }) {
    this.config = config
  }

  async deleteObjects(keys: Iterable<string>) {
    const cleaned = [...new Set([...keys].map(key => normalizeMediaKey(key)).filter(Boolean))]
    if (!cleaned.length) return

    for (const batch of chunkArray(cleaned, 1000)) {
      const xmlBody = this.buildDeleteXml(batch)
      const payloadHash = await sha256Hex(xmlBody)
      const response = await this.request('POST', '', {
        query: { delete: '' },
        body: xmlBody,
        contentType: 'application/xml',
        payloadHash,
      })
      if (!response.ok) {
        const bodyText = await response.text().catch(() => '')
        throw actionError(
          response.status,
          'r2_delete_failed',
          `R2 delete failed: ${bodyText || response.statusText || 'Delete failed'}`,
        )
      }
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
      }
    }

    const response = await this.request('HEAD', cleaned)
    const kind = isOriginalImageKey(cleaned) ? 'original' : 'variant'
    if (response.ok) {
      const size = Number(response.headers.get('content-length') ?? response.headers.get('Content-Length') ?? 0)
      return {
        ok: true as const,
        status: response.status,
        size: Number.isFinite(size) && size > 0 ? Math.trunc(size) : 0,
        kind,
      }
    }

    const bodyText = await response.text().catch(() => '')
    return {
      ok: false as const,
      status: response.status,
      error: `R2 head failed: ${bodyText || response.statusText || 'Head failed'}`,
      kind,
    }
  }

  async request(
    method: string,
    key: string,
    options: {
      query?: Record<string, string>
      body?: BodyInit | null
      contentType?: string
      payloadHash?: string
    } = {},
  ) {
    const normalizedKey = normalizeMediaKey(key)
    const canonicalUri = this.canonicalUri(normalizedKey)
    const canonicalQuery = this.canonicalQuery(options.query ?? {})
    const bodyBytes = await toUint8Array(options.body)
    const payloadHash = options.payloadHash || (await sha256Hex(bodyBytes))
    const amzDate = toAmzDate(new Date())
    const dateStamp = amzDate.slice(0, 8)
    const endpoint = new URL(this.config.s3Endpoint)
    const headers: Record<string, string> = {
      host: endpoint.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    }
    if (options.contentType) {
      headers['content-type'] = options.contentType
    }

    const signedHeaders = Object.keys(headers).sort()
    const canonicalHeaders = signedHeaders.map(name => `${name}:${normalizeHeaderValue(headers[name])}\n`).join('')
    const canonicalRequest = [
      method.toUpperCase(),
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders.join(';'),
      payloadHash,
    ].join('\n')

    const credentialScope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      await sha256Hex(canonicalRequest),
    ].join('\n')

    const signature = await this.signature(dateStamp, stringToSign)
    const authorization = [
      'AWS4-HMAC-SHA256',
      `Credential=${this.config.accessKeyId}/${credentialScope}`,
      `SignedHeaders=${signedHeaders.join(';')}`,
      `Signature=${signature}`,
    ].join(' ')

    const requestHeaders = new Headers()
    requestHeaders.set('Authorization', authorization)
    requestHeaders.set('x-amz-content-sha256', payloadHash)
    requestHeaders.set('x-amz-date', amzDate)
    if (options.contentType) {
      requestHeaders.set('Content-Type', options.contentType)
    }

    const url = new URL(this.config.s3Endpoint)
    url.pathname = canonicalUri
    url.search = canonicalQuery ? `?${canonicalQuery}` : ''

    return fetch(url.toString(), {
      method: method.toUpperCase(),
      headers: requestHeaders,
      body: bodyBytes.length ? bodyBytes : null,
    })
  }

  canonicalUri(key: string) {
    const segments = [this.config.bucketName]
    if (key) {
      segments.push(...key.split('/').filter(Boolean))
    }
    return `/${segments.map(segment => encodeURIComponent(segment).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')}`
  }

  canonicalQuery(query: Record<string, string>) {
    const items = Object.entries(query).map(([name, value]) => [
      encodeURIComponent(name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`),
      encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`),
    ])
    items.sort(([leftName, leftValue], [rightName, rightValue]) => {
      if (leftName !== rightName) return leftName.localeCompare(rightName)
      return leftValue.localeCompare(rightValue)
    })
    return items.map(([name, value]) => `${name}=${value}`).join('&')
  }

  buildDeleteXml(keys: string[]) {
    const xmlKeys = keys
      .map(key => `<Object><Key>${escapeXml(key)}</Key></Object>`)
      .join('')
    return `<?xml version="1.0" encoding="UTF-8"?><Delete>${xmlKeys}</Delete>`
  }

  async signature(dateStamp: string, stringToSign: string) {
    const kDate = await hmac(`AWS4${this.config.secretAccessKey}`, dateStamp)
    const kRegion = await hmacBytes(kDate, R2_REGION)
    const kService = await hmacBytes(kRegion, R2_SERVICE)
    const kSigning = await hmacBytes(kService, 'aws4_request')
    return toHex(await hmacBytes(kSigning, stringToSign))
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

async function toUint8Array(body: BodyInit | null | undefined) {
  if (body === null || body === undefined) return new Uint8Array()
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  }
  if (body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer())
  }
  return new TextEncoder().encode(String(body))
}

async function sha256Hex(input: string | Uint8Array) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return toHex(new Uint8Array(digest))
}

async function hmac(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)))
}

async function hmacBytes(secretBytes: Uint8Array, message: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)))
}

function toHex(bytes: Uint8Array) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function toAmzDate(date: Date) {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  const seconds = String(date.getUTCSeconds()).padStart(2, '0')
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`
}

function normalizeHeaderValue(value: string) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function escapeXml(value: string) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function cleanJson(value: unknown) {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value))
}

function chunkArray<T>(values: T[], size: number) {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

function toDate(value: unknown) {
  const date = new Date(String(value ?? ''))
  return Number.isFinite(date.getTime()) ? date : null
}

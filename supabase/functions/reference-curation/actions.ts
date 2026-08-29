type RpcClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{
    data: Record<string, unknown> | null
    error: { message?: string; code?: string } | null
  }>
}

type ActionResponse = {
  status: number
  body: Record<string, any>
}

type ActionContext = {
  actorUserId: string
  actorSessionId: string
  adminClient: RpcClient
  requestBody: Record<string, unknown>
}

const MUTATION_ACTIONS = new Set([
  'claim',
  'request_changes',
  'reject',
  'accept_to_draft',
  'edit_draft',
])

const MUTATION_KEYS = new Set([
  'action',
  'request_id',
  'target_id',
  'expected_row_version',
  'candidate_revision',
  'candidate_content_hash',
  'reason',
  'payload',
])

const DUPLICATE_WARNING_KEYS = new Set([
  'action',
  'target_id',
  'candidate_revision',
  'candidate_content_hash',
])

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/
const MAX_REASON_LENGTH = 4000
const MAX_PAYLOAD_BYTES = 65536
const MAX_ASSIGNMENT_REASON_LENGTH = 2048
const MAX_RESPONSE_BYTES = 65536
const MAX_DUPLICATE_WARNINGS = 100
const KNOWN_DOMAIN_STATUSES = new Set([
  'created',
  'updated',
  'no_change',
  'ok',
  'forbidden',
  'account_unavailable',
  'account_deleting',
  'not_found',
  'invalid_payload',
  'invalid_request',
  'invalid_reason',
  'unknown_action',
  'conflict',
  'idempotency_conflict',
  'invalid_state',
  'stale_candidate',
  'candidate_unavailable',
])

export async function handleReferenceCurationAction(
  context: ActionContext,
): Promise<ActionResponse> {
  const action = typeof context.requestBody.action === 'string' ? context.requestBody.action : ''

  if (action === 'duplicate_warnings') {
    return handleDuplicateWarnings(context)
  }
  if (!MUTATION_ACTIONS.has(action)) {
    return failure(400, 'unknown_action', 'Unknown action')
  }
  if (
    !hasExactlyAllowedKeys(context.requestBody, MUTATION_KEYS) ||
    !hasAllKeys(context.requestBody, MUTATION_KEYS) ||
    !isUuid(context.actorUserId) ||
    !isUuid(context.actorSessionId) ||
    !isUuid(context.requestBody.request_id) ||
    !isUuid(context.requestBody.target_id) ||
    !isExpectedRowVersion(action, context.requestBody.expected_row_version, context.requestBody.payload) ||
    !hasValidCandidateIdentity(action, context.requestBody) ||
    !isNullableBoundedReason(context.requestBody.reason) ||
    !isPayload(context.requestBody.payload) ||
    !isActionPayload(action, context.requestBody.payload, context.requestBody.expected_row_version)
  ) {
    return failure(400, 'invalid_payload', 'Invalid request payload')
  }
  if (
    (action === 'request_changes' || action === 'reject' || action === 'edit_draft') &&
    !hasNonEmptyReason(context.requestBody.reason)
  ) {
    return failure(400, 'invalid_payload', 'A reason is required')
  }
  if (
    action === 'accept_to_draft' && Object.keys(context.requestBody.payload as Record<string, unknown>).length > 0 &&
    !hasNonEmptyReason(context.requestBody.reason)
  ) {
    return failure(400, 'invalid_payload', 'A reason is required for explicit linking')
  }

  return callRpc(context.adminClient, 'mutate_reference_curation', {
    p_actor_user_id: context.actorUserId,
    p_actor_session_id: context.actorSessionId,
    p_request_id: context.requestBody.request_id,
    p_action: action,
    p_target_id: context.requestBody.target_id,
    p_expected_row_version: context.requestBody.expected_row_version,
    p_candidate_revision: context.requestBody.candidate_revision,
    p_candidate_content_hash: context.requestBody.candidate_content_hash,
    p_reason: context.requestBody.reason,
    p_payload: context.requestBody.payload,
  })
}

async function handleDuplicateWarnings(context: ActionContext): Promise<ActionResponse> {
  if (
    !hasExactlyAllowedKeys(context.requestBody, DUPLICATE_WARNING_KEYS) ||
    !hasAllKeys(context.requestBody, DUPLICATE_WARNING_KEYS) ||
    !isUuid(context.actorUserId) ||
    !isUuid(context.actorSessionId) ||
    !isUuid(context.requestBody.target_id) ||
    !isPositiveSafeInteger(context.requestBody.candidate_revision) ||
    !isContentHash(context.requestBody.candidate_content_hash)
  ) {
    return failure(400, 'invalid_payload', 'Invalid request payload')
  }

  return callRpc(context.adminClient, 'get_reference_curation_duplicate_warnings', {
    p_actor_user_id: context.actorUserId,
    p_actor_session_id: context.actorSessionId,
    p_submission_id: context.requestBody.target_id,
    p_candidate_revision: context.requestBody.candidate_revision,
    p_candidate_content_hash: context.requestBody.candidate_content_hash,
  })
}

async function callRpc(
  adminClient: RpcClient,
  name: string,
  args: Record<string, unknown>,
): Promise<ActionResponse> {
  let result: Awaited<ReturnType<RpcClient['rpc']>>
  try {
    result = await adminClient.rpc(name, args)
  } catch {
    return failure(500, 'curation_operation_failed', 'Curation operation failed')
  }
  if (result.error || !isRecord(result.data)) {
    return failure(500, 'curation_operation_failed', 'Curation operation failed')
  }

  const domainStatus = typeof result.data.status === 'string' ? result.data.status : 'failed'
  if (!KNOWN_DOMAIN_STATUSES.has(domainStatus)) {
    return failure(500, 'curation_operation_failed', 'Curation operation failed')
  }
  const status = httpStatusForDomainStatus(domainStatus)
  if (status >= 400) {
    return failure(status, domainStatus, publicMessageForStatus(domainStatus))
  }
  const publicResult = validatePublicRpcResult(name, result.data)
  if (!publicResult) {
    return failure(500, 'curation_operation_failed', 'Curation operation failed')
  }
  return {
    status,
    body: {
      ok: true,
      result: publicResult,
    },
  }
}

function httpStatusForDomainStatus(status: string): number {
  if (status === 'created' || status === 'updated' || status === 'no_change' || status === 'ok') {
    return 200
  }
  if (status === 'forbidden' || status === 'account_unavailable' || status === 'account_deleting') {
    return 403
  }
  if (status === 'not_found') return 404
  if (
    status === 'invalid_payload' || status === 'invalid_request' ||
    status === 'invalid_reason' || status === 'unknown_action'
  ) {
    return 400
  }
  if (
    status === 'conflict' || status === 'idempotency_conflict' ||
    status === 'invalid_state' || status === 'stale_candidate' || status === 'candidate_unavailable'
  ) {
    return 409
  }
  return 500
}

function publicMessageForStatus(status: string): string {
  if (status === 'forbidden' || status === 'account_unavailable' || status === 'account_deleting') {
    return 'Access denied'
  }
  if (status === 'not_found') return 'Resource not found'
  if (
    status === 'invalid_payload' || status === 'invalid_request' ||
    status === 'invalid_reason' || status === 'unknown_action'
  ) {
    return 'Invalid request payload'
  }
  if (
    status === 'conflict' || status === 'idempotency_conflict' ||
    status === 'invalid_state' || status === 'stale_candidate' || status === 'candidate_unavailable'
  ) {
    return 'The resource changed; refresh and retry'
  }
  return 'Curation operation failed'
}

function failure(status: number, code: string, message: string): ActionResponse {
  return {
    status,
    body: {
      ok: false,
      error: { code, message },
    },
  }
}

function hasExactlyAllowedKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function hasAllKeys(value: Record<string, unknown>, required: Set<string>): boolean {
  return [...required].every((key) => Object.hasOwn(value, key))
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isExpectedRowVersion(action: string, value: unknown, payload: unknown): value is number {
  if (isPositiveSafeInteger(value)) return true
  return action === 'edit_draft' && value === 0 && isRecord(payload) &&
    payload.target_type === 'treatment_taxa'
}

function isContentHash(value: unknown): value is string {
  return typeof value === 'string' && CONTENT_HASH_PATTERN.test(value)
}

function isNullableBoundedReason(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= MAX_REASON_LENGTH)
}

function hasNonEmptyReason(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPayload(value: unknown): value is Record<string, unknown> {
  return isRecord(value) &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_PAYLOAD_BYTES
}

function hasValidCandidateIdentity(action: string, body: Record<string, unknown>): boolean {
  if (action === 'edit_draft') {
    return body.candidate_revision === null && body.candidate_content_hash === null
  }
  return isPositiveSafeInteger(body.candidate_revision) && isContentHash(body.candidate_content_hash)
}

function isActionPayload(
  action: string,
  payload: unknown,
  expectedRowVersion: unknown,
): payload is Record<string, unknown> {
  if (!isRecord(payload)) return false
  if (action === 'claim' || action === 'request_changes' || action === 'reject') {
    return Object.keys(payload).length === 0
  }
  if (action === 'accept_to_draft') return isAcceptPayload(payload)
  if (action === 'edit_draft') return isDraftEditPayload(payload, expectedRowVersion)
  return false
}

function isAcceptPayload(payload: Record<string, unknown>): boolean {
  const allowed = new Set([
    'existing_curated_work_id',
    'expected_curated_work_row_version',
    'existing_curated_treatment_id',
    'expected_curated_treatment_row_version',
    'existing_curated_measurement_set_id',
    'expected_curated_measurement_set_row_version',
  ])
  if (!hasExactlyAllowedKeys(payload, allowed)) return false
  const pairs = [
    ['existing_curated_work_id', 'expected_curated_work_row_version'],
    ['existing_curated_treatment_id', 'expected_curated_treatment_row_version'],
    ['existing_curated_measurement_set_id', 'expected_curated_measurement_set_row_version'],
  ] as const
  for (const [idKey, versionKey] of pairs) {
    const hasId = Object.hasOwn(payload, idKey)
    const hasVersion = Object.hasOwn(payload, versionKey)
    if (hasId !== hasVersion) return false
    if (hasId && (!isUuid(payload[idKey]) || !isPositiveSafeInteger(payload[versionKey]))) return false
  }
  const treatmentHasWork = !Object.hasOwn(payload, 'existing_curated_treatment_id') ||
    Object.hasOwn(payload, 'existing_curated_work_id')
  const setHasTreatment = !Object.hasOwn(payload, 'existing_curated_measurement_set_id') ||
    Object.hasOwn(payload, 'existing_curated_treatment_id')
  return treatmentHasWork && setHasTreatment
}

function isDraftEditPayload(payload: Record<string, unknown>, expectedRowVersion: unknown): boolean {
  if (
    !hasExactlyAllowedKeys(payload, new Set(['target_type', 'patch'])) ||
    !hasAllKeys(payload, new Set(['target_type', 'patch'])) || !isRecord(payload.patch) ||
    Object.keys(payload.patch).length === 0
  ) return false

  const allowedPatchKeys: Record<string, Set<string>> = {
    work: new Set([
      'type',
      'authors',
      'editors',
      'title',
      'container_title',
      'year',
      'edition',
      'publisher',
      'place',
      'volume',
      'issue',
      'pages',
      'doi',
      'isbn',
      'url',
      'language',
      'short_label',
      'citation_override',
    ]),
    treatment: new Set(['name_as_published', 'page_from', 'page_to', 'locator_text', 'treatment_notes']),
    measurement_set: new Set([
      'character',
      'raw_text',
      'data_kind',
      'length_min',
      'length_core_min',
      'length_core_max',
      'length_max',
      'width_min',
      'width_core_min',
      'width_core_max',
      'width_max',
      'q_min',
      'q_max',
      'q_mean',
      'length_mean',
      'width_mean',
      'sample_size',
      'specimen_count',
      'mount_medium',
      'stain',
      'preparation',
      'measurement_method',
      'notes',
      'raw_points',
    ]),
    treatment_taxa: new Set(['taxon_treatment_id', 'sporely_taxon_id', 'assignment_reason']),
  }
  const targetType = typeof payload.target_type === 'string' ? payload.target_type : ''
  const allowed = allowedPatchKeys[targetType]
  if (!allowed || !hasExactlyAllowedKeys(payload.patch, allowed)) return false
  if (targetType !== 'treatment_taxa') return true

  if (expectedRowVersion === 0) {
    return hasAllKeys(
      payload.patch,
      new Set(['taxon_treatment_id', 'sporely_taxon_id', 'assignment_reason']),
    ) && isUuid(payload.patch.taxon_treatment_id) &&
      isPositiveSafeInteger(payload.patch.sporely_taxon_id) &&
      isBoundedNonEmptyString(payload.patch.assignment_reason, MAX_ASSIGNMENT_REASON_LENGTH)
  }
  return !Object.hasOwn(payload.patch, 'taxon_treatment_id') &&
    (!Object.hasOwn(payload.patch, 'sporely_taxon_id') || isPositiveSafeInteger(payload.patch.sporely_taxon_id)) &&
    (!Object.hasOwn(payload.patch, 'assignment_reason') ||
      isBoundedNonEmptyString(payload.patch.assignment_reason, MAX_ASSIGNMENT_REASON_LENGTH))
}

function isBoundedNonEmptyString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximumLength
}

function validatePublicRpcResult(name: string, data: Record<string, unknown>): Record<string, unknown> | null {
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > MAX_RESPONSE_BYTES) return null
  if (name === 'get_reference_curation_duplicate_warnings') {
    if (
      !hasExactlyAllowedKeys(data, new Set(['status', 'warnings'])) || data.status !== 'ok' ||
      !Array.isArray(data.warnings) || data.warnings.length > MAX_DUPLICATE_WARNINGS
    ) return null
    const allowedKinds = new Set(['exact_doi', 'normalized_isbn', 'exact_bibliography'])
    if (
      !data.warnings.every((warning) =>
        isRecord(warning) && hasExactlyAllowedKeys(warning, new Set(['kind', 'curated_work_id'])) &&
        typeof warning.kind === 'string' && allowedKinds.has(warning.kind) && isUuid(warning.curated_work_id)
      )
    ) return null
    return data
  }

  const allowedMutationKeys = new Set([
    'status',
    'submission_id',
    'target_id',
    'curated_work_id',
    'curated_treatment_id',
    'curated_measurement_set_id',
  ])
  if (!hasExactlyAllowedKeys(data, allowedMutationKeys)) return null
  for (const [key, value] of Object.entries(data)) {
    if (key !== 'status' && !isUuid(value)) return null
  }
  return data
}

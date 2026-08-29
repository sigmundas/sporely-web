type RpcClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{
    data: Record<string, unknown> | null
    error: { message?: string; code?: string } | null
  }>
}

type ReadContext = {
  actorUserId: string
  actorSessionId: string
  adminClient: RpcClient
  requestBody: Record<string, unknown>
}

type ReadResponse = { status: number; body: Record<string, any> }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH_PATTERN = /^[0-9a-f]{64}$/
const QUEUE_STATUSES = new Set([
  'submitted',
  'in_review',
  'changes_requested',
  'rejected',
  'accepted',
  'withdrawn',
])
const CAPABILITY_ROLES = new Set(['reference_reviewer', 'reference_publisher', 'admin'])
const MAX_RESPONSE_BYTES = 256 * 1024

export async function handleReferenceCurationRead(context: ReadContext): Promise<ReadResponse> {
  const action = typeof context.requestBody.action === 'string' ? context.requestBody.action : ''
  if (!isUuid(context.actorUserId) || !isUuid(context.actorSessionId)) {
    return failure(400, 'invalid_payload', 'Invalid request payload')
  }

  if (action === 'capabilities') {
    if (!hasExactKeys(context.requestBody, new Set(['action']))) return invalidPayload()
    return callRead(context, 'get_reference_curation_capabilities', {
      p_actor_user_id: context.actorUserId,
      p_actor_session_id: context.actorSessionId,
    }, action)
  }

  if (action === 'queue') {
    if (!isQueueRequest(context.requestBody)) return invalidPayload()
    return callRead(context, 'list_reference_curation_queue', {
      p_actor_user_id: context.actorUserId,
      p_actor_session_id: context.actorSessionId,
      p_status: context.requestBody.status,
      p_limit: context.requestBody.limit,
      p_after_created_at: context.requestBody.after_created_at,
      p_after_id: context.requestBody.after_id,
    }, action)
  }

  if (action === 'detail') {
    if (
      !hasExactKeys(context.requestBody, new Set(['action', 'target_id'])) ||
      !isUuid(context.requestBody.target_id)
    ) return invalidPayload()
    return callRead(context, 'get_reference_curation_detail', {
      p_actor_user_id: context.actorUserId,
      p_actor_session_id: context.actorSessionId,
      p_submission_id: context.requestBody.target_id,
    }, action)
  }

  return failure(400, 'unknown_action', 'Unknown action')
}

async function callRead(
  context: ReadContext,
  rpcName: string,
  args: Record<string, unknown>,
  action: string,
): Promise<ReadResponse> {
  let result: Awaited<ReturnType<RpcClient['rpc']>>
  try {
    result = await context.adminClient.rpc(rpcName, args)
  } catch {
    return operationFailed()
  }
  if (result.error || !isRecord(result.data)) return operationFailed()
  if (result.data.status === 'forbidden') return failure(403, 'forbidden', 'Access denied')
  if (result.data.status === 'not_found') return failure(404, 'not_found', 'Resource not found')
  if (result.data.status !== 'ok' || !validateReadResult(action, result.data)) return operationFailed()
  return { status: 200, body: { ok: true, result: result.data } }
}

function isQueueRequest(body: Record<string, unknown>): boolean {
  if (!hasExactKeys(body, new Set(['action', 'status', 'limit', 'after_created_at', 'after_id']))) return false
  const status = body.status
  const limit = body.limit
  const afterCreatedAt = body.after_created_at
  const afterId = body.after_id
  return (status === null || (typeof status === 'string' && QUEUE_STATUSES.has(status))) &&
    typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50 &&
    ((afterCreatedAt === null && afterId === null) ||
      (isIsoTimestamp(afterCreatedAt) && isUuid(afterId)))
}

function validateReadResult(action: string, data: Record<string, unknown>): boolean {
  if (encodedSize(data) > MAX_RESPONSE_BYTES || !isCapabilities(data.capabilities)) return false
  if (action === 'capabilities') {
    return hasExactKeys(data, new Set(['status', 'capabilities']))
  }
  if (action === 'queue') {
    return hasExactKeys(data, new Set(['status', 'capabilities', 'items', 'next_cursor'])) &&
      Array.isArray(data.items) && data.items.length <= 50 && data.items.every(isQueueItem) &&
      (data.next_cursor === null || isCursor(data.next_cursor))
  }
  return hasExactKeys(data, new Set(['status', 'capabilities', 'detail'])) &&
    (data.detail === null || (isRecord(data.detail) &&
      hasExactKeys(data.detail, new Set(['submission', 'candidate', 'accepted_graph'])) &&
      isQueueItem(data.detail.submission) && isCandidate(data.detail.candidate) &&
      isAcceptedGraph(data.detail.accepted_graph)))
}

function isCapabilities(value: unknown): boolean {
  return isRecord(value) &&
    hasExactKeys(value, new Set(['actor_user_id', 'role', 'can_review', 'can_publish'])) &&
    isUuid(value.actor_user_id) &&
    (value.role === null || (typeof value.role === 'string' && CAPABILITY_ROLES.has(value.role))) &&
    typeof value.can_review === 'boolean' && typeof value.can_publish === 'boolean'
}

function isQueueItem(value: unknown): boolean {
  if (
    !isRecord(value) || !hasExactKeys(
      value,
      new Set([
        'id',
        'status',
        'row_version',
        'current_candidate_revision',
        'current_content_hash',
        'claimed_by',
        'claimed_at',
        'feedback_text',
        'created_at',
        'updated_at',
        'accepted_curated_measurement_set_id',
      ]),
    )
  ) return false
  return isUuid(value.id) && typeof value.status === 'string' && QUEUE_STATUSES.has(value.status) &&
    isPositiveInteger(value.row_version) && isPositiveInteger(value.current_candidate_revision) &&
    typeof value.current_content_hash === 'string' && HASH_PATTERN.test(value.current_content_hash) &&
    (value.claimed_by === null || isUuid(value.claimed_by)) &&
    (value.claimed_at === null || isIsoTimestamp(value.claimed_at)) &&
    (value.feedback_text === null || (typeof value.feedback_text === 'string' && value.feedback_text.length <= 4000)) &&
    isIsoTimestamp(value.created_at) && isIsoTimestamp(value.updated_at) &&
    (value.accepted_curated_measurement_set_id === null || isUuid(value.accepted_curated_measurement_set_id))
}

function isCandidate(value: unknown): boolean {
  return value === null || (isRecord(value) && hasExactKeys(
    value,
    new Set([
      'schema_version',
      'work',
      'treatment',
      'measurement_set',
    ]),
  ) && value.schema_version === 1 && isRecord(value.work) &&
    hasExactKeys(value.work, CANDIDATE_KEYS.work) && isRecord(value.treatment) &&
    hasExactKeys(value.treatment, CANDIDATE_KEYS.treatment) && isRecord(value.measurement_set) &&
    hasExactKeys(value.measurement_set, CANDIDATE_KEYS.measurement_set))
}

const CANDIDATE_KEYS = {
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
  treatment: new Set(['name_as_published', 'page_from', 'page_to', 'locator_text']),
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
    'raw_points',
  ]),
}

function isAcceptedGraph(value: unknown): boolean {
  if (value === null) return true
  return isRecord(value) &&
    hasExactKeys(value, new Set(['work', 'treatment', 'measurement_set', 'taxon_assignments'])) &&
    isGraphRow(value.work, 'work') && isGraphRow(value.treatment, 'treatment') &&
    isGraphRow(value.measurement_set, 'measurement_set') && Array.isArray(value.taxon_assignments) &&
    value.taxon_assignments.length <= 100 && value.taxon_assignments.every((row) => isGraphRow(row, 'assignment'))
}

const GRAPH_KEYS: Record<string, Set<string>> = {
  work: new Set([
    'id',
    'type',
    'citation_key',
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
    'revision',
    'row_version',
  ]),
  treatment: new Set([
    'id',
    'reference_work_id',
    'name_as_published',
    'page_from',
    'page_to',
    'locator_text',
    'treatment_notes',
    'revision',
    'row_version',
  ]),
  measurement_set: new Set([
    'id',
    'taxon_treatment_id',
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
    'supersedes_id',
    'catalogue_status',
    'latest_bundle_revision',
    'revision',
    'row_version',
  ]),
  assignment: new Set([
    'id',
    'taxon_treatment_id',
    'sporely_taxon_id',
    'canonical_name',
    'assignment_reason',
    'revision',
    'row_version',
  ]),
}

function isGraphRow(value: unknown, kind: keyof typeof GRAPH_KEYS): boolean {
  if (
    !isRecord(value) || !hasExactKeys(value, GRAPH_KEYS[kind]) || !isUuid(value.id) ||
    !isPositiveInteger(value.revision) || !isPositiveInteger(value.row_version)
  ) return false
  if (kind === 'work') return typeof value.title === 'string' && typeof value.short_label === 'string'
  if (kind === 'treatment') return isUuid(value.reference_work_id) && typeof value.name_as_published === 'string'
  if (kind === 'measurement_set') {
    return isUuid(value.taxon_treatment_id) && typeof value.character === 'string' &&
      typeof value.data_kind === 'string' && typeof value.catalogue_status === 'string' &&
      (value.supersedes_id === null || isUuid(value.supersedes_id)) &&
      (value.latest_bundle_revision === null || isPositiveInteger(value.latest_bundle_revision))
  }
  return isUuid(value.taxon_treatment_id) && isPositiveInteger(value.sporely_taxon_id) &&
    typeof value.canonical_name === 'string' && typeof value.assignment_reason === 'string'
}

function isCursor(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, new Set(['created_at', 'id'])) &&
    isIsoTimestamp(value.created_at) && isUuid(value.id)
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.size && actual.every((key) => keys.has(key))
}

function encodedSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function invalidPayload(): ReadResponse {
  return failure(400, 'invalid_payload', 'Invalid request payload')
}

function operationFailed(): ReadResponse {
  return failure(500, 'curation_operation_failed', 'Curation operation failed')
}

function failure(status: number, code: string, message: string): ReadResponse {
  return { status, body: { ok: false, error: { code, message } } }
}

import { assertEquals, assertMatch } from 'jsr:@std/assert@1.0.19'

import { handleReferenceCurationAction } from './actions.ts'

const ACTOR_ID = '10000000-0000-4000-8000-000000000001'
const ACTOR_SESSION_ID = '11000000-0000-4000-8000-000000000001'
const TARGET_ID = '20000000-0000-4000-8000-000000000001'
const REQUEST_ID = '30000000-0000-4000-8000-000000000001'
const CONTENT_HASH = 'a'.repeat(64)

type RpcResult = {
  data: Record<string, unknown> | null
  error: { message: string; code?: string } | null
}

function fakeAdminClient(result: RpcResult = {
  data: { status: 'updated', submission_id: TARGET_ID },
  error: null,
}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  return {
    calls,
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args })
      return result
    },
  }
}

function validMutationBody(overrides: Record<string, unknown> = {}) {
  return {
    action: 'accept_to_draft',
    request_id: REQUEST_ID,
    target_id: TARGET_ID,
    expected_row_version: 4,
    candidate_revision: 2,
    candidate_content_hash: CONTENT_HASH,
    reason: null,
    payload: {},
    ...overrides,
  }
}

Deno.test('accept_to_draft binds the authenticated actor and exact candidate to one mutation RPC', async () => {
  const adminClient = fakeAdminClient()

  const response = await handleReferenceCurationAction({
    actorUserId: ACTOR_ID,
    actorSessionId: ACTOR_SESSION_ID,
    adminClient,
    requestBody: validMutationBody(),
  })

  assertEquals(response.status, 200)
  assertEquals(adminClient.calls, [{
    name: 'mutate_reference_curation',
    args: {
      p_actor_user_id: ACTOR_ID,
      p_actor_session_id: ACTOR_SESSION_ID,
      p_request_id: REQUEST_ID,
      p_action: 'accept_to_draft',
      p_target_id: TARGET_ID,
      p_expected_row_version: 4,
      p_candidate_revision: 2,
      p_candidate_content_hash: CONTENT_HASH,
      p_reason: null,
      p_payload: {},
    },
  }])
})

Deno.test('duplicate warnings use the dedicated read RPC with the authenticated actor', async () => {
  const adminClient = fakeAdminClient({
    data: { status: 'ok', warnings: [] },
    error: null,
  })

  const response = await handleReferenceCurationAction({
    actorUserId: ACTOR_ID,
    actorSessionId: ACTOR_SESSION_ID,
    adminClient,
    requestBody: {
      action: 'duplicate_warnings',
      target_id: TARGET_ID,
      candidate_revision: 2,
      candidate_content_hash: CONTENT_HASH,
    },
  })

  assertEquals(response.status, 200)
  assertEquals(adminClient.calls, [{
    name: 'get_reference_curation_duplicate_warnings',
    args: {
      p_actor_user_id: ACTOR_ID,
      p_actor_session_id: ACTOR_SESSION_ID,
      p_submission_id: TARGET_ID,
      p_candidate_revision: 2,
      p_candidate_content_hash: CONTENT_HASH,
    },
  }])
})

Deno.test('only the five Stage 6c mutation actions route to the mutation RPC', async () => {
  for (const action of ['claim', 'request_changes', 'reject', 'accept_to_draft', 'edit_draft']) {
    const adminClient = fakeAdminClient()
    const editDraft = action === 'edit_draft'
    const response = await handleReferenceCurationAction({
      actorUserId: ACTOR_ID,
      actorSessionId: ACTOR_SESSION_ID,
      adminClient,
      requestBody: validMutationBody({
        action,
        reason: action === 'request_changes' || action === 'reject' || editDraft ? 'Reviewed evidence' : null,
        candidate_revision: editDraft ? null : 2,
        candidate_content_hash: editDraft ? null : CONTENT_HASH,
        payload: editDraft ? { target_type: 'work', patch: { title: 'Reviewed title' } } : {},
      }),
    })

    assertEquals(response.status, 200, action)
    assertEquals(adminClient.calls.length, 1, action)
    assertEquals(adminClient.calls[0].name, 'mutate_reference_curation', action)
    assertEquals(adminClient.calls[0].args.p_action, action, action)
  }
})

Deno.test('publisher and report actions are rejected before any RPC call', async () => {
  for (const action of ['publish', 'deprecate', 'supersede', 'withdraw', 'resolve_report']) {
    const adminClient = fakeAdminClient()
    const response = await handleReferenceCurationAction({
      actorUserId: ACTOR_ID,
      actorSessionId: ACTOR_SESSION_ID,
      adminClient,
      requestBody: validMutationBody({ action }),
    })

    assertEquals(response.status, 400, action)
    assertEquals(response.body.error.code, 'unknown_action', action)
    assertEquals(adminClient.calls.length, 0, action)
  }
})

Deno.test('body-supplied actor or authorization fields fail closed before the RPC', async () => {
  for (
    const forbidden of [
      { actor_user_id: '90000000-0000-4000-8000-000000000009' },
      { actor_session_id: '91000000-0000-4000-8000-000000000009' },
      { session_id: '91000000-0000-4000-8000-000000000009' },
      { user_id: '90000000-0000-4000-8000-000000000009' },
      { role: 'reference_publisher' },
      { is_admin: true },
    ]
  ) {
    const adminClient = fakeAdminClient()
    const response = await handleReferenceCurationAction({
      actorUserId: ACTOR_ID,
      actorSessionId: ACTOR_SESSION_ID,
      adminClient,
      requestBody: { ...validMutationBody(), ...forbidden },
    })

    assertEquals(response.status, 400)
    assertEquals(response.body.error.code, 'invalid_payload')
    assertEquals(adminClient.calls.length, 0)
  }
})

Deno.test('unknown top-level body keys fail closed before the RPC', async () => {
  const adminClient = fakeAdminClient()
  const response = await handleReferenceCurationAction({
    actorUserId: ACTOR_ID,
    actorSessionId: ACTOR_SESSION_ID,
    adminClient,
    requestBody: { ...validMutationBody(), unexpected: 'value' },
  })

  assertEquals(response.status, 400)
  assertEquals(response.body.error.code, 'invalid_payload')
  assertEquals(adminClient.calls.length, 0)
})

Deno.test('invalid identifiers, versions, hashes, reasons, and payloads never reach the RPC', async () => {
  const invalidBodies = [
    validMutationBody({ request_id: 'not-a-uuid' }),
    validMutationBody({ target_id: 'not-a-uuid' }),
    validMutationBody({ expected_row_version: 0 }),
    validMutationBody({ expected_row_version: 1.5 }),
    validMutationBody({ candidate_revision: 0 }),
    validMutationBody({ candidate_content_hash: 'A'.repeat(64) }),
    validMutationBody({ reason: 'x'.repeat(4001) }),
    validMutationBody({ payload: [] }),
  ]

  for (const requestBody of invalidBodies) {
    const adminClient = fakeAdminClient()
    const response = await handleReferenceCurationAction({
      actorUserId: ACTOR_ID,
      actorSessionId: ACTOR_SESSION_ID,
      adminClient,
      requestBody,
    })
    assertEquals(response.status, 400)
    assertEquals(response.body.error.code, 'invalid_payload')
    assertEquals(adminClient.calls.length, 0)
  }
})

Deno.test('request_changes and reject require a non-empty bounded reason', async () => {
  for (const action of ['request_changes', 'reject']) {
    for (const reason of [null, '', '   ']) {
      const adminClient = fakeAdminClient()
      const response = await handleReferenceCurationAction({
        actorUserId: ACTOR_ID,
        actorSessionId: ACTOR_SESSION_ID,
        adminClient,
        requestBody: validMutationBody({ action, reason }),
      })
      assertEquals(response.status, 400)
      assertEquals(response.body.error.code, 'invalid_payload')
      assertEquals(adminClient.calls.length, 0)
    }
  }
})

Deno.test('action payloads use strict per-action allowlists before the RPC', async () => {
  const invalidBodies = [
    validMutationBody({ action: 'claim', payload: { unexpected: true } }),
    validMutationBody({ action: 'request_changes', reason: 'Needs work', payload: { unexpected: true } }),
    validMutationBody({ action: 'reject', reason: 'Unsupported', payload: { unexpected: true } }),
    validMutationBody({ action: 'accept_to_draft', payload: { candidate_json: { private: true } } }),
    validMutationBody({ action: 'accept_to_draft', payload: { existing_curated_work_id: TARGET_ID } }),
    validMutationBody({
      action: 'accept_to_draft',
      reason: null,
      payload: { existing_curated_work_id: TARGET_ID, expected_curated_work_row_version: 1 },
    }),
    validMutationBody({
      action: 'edit_draft',
      candidate_revision: null,
      candidate_content_hash: null,
      reason: null,
      payload: { target_type: 'work', patch: { title: 'Reviewed title' } },
    }),
    validMutationBody({
      action: 'edit_draft',
      candidate_revision: null,
      candidate_content_hash: null,
      reason: 'Move assignment',
      payload: { target_type: 'treatment_taxa', patch: { taxon_treatment_id: TARGET_ID } },
    }),
    validMutationBody({
      action: 'edit_draft',
      expected_row_version: 0,
      candidate_revision: null,
      candidate_content_hash: null,
      reason: 'Incomplete assignment',
      payload: { target_type: 'treatment_taxa', patch: { assignment_reason: 'Exact species' } },
    }),
    validMutationBody({
      action: 'edit_draft',
      expected_row_version: 0,
      candidate_revision: null,
      candidate_content_hash: null,
      reason: 'Invalid assignment',
      payload: {
        target_type: 'treatment_taxa',
        patch: {
          taxon_treatment_id: TARGET_ID,
          sporely_taxon_id: 0,
          assignment_reason: 'Exact species',
        },
      },
    }),
    validMutationBody({
      action: 'edit_draft',
      candidate_revision: null,
      candidate_content_hash: null,
      reason: 'Reject lifecycle fields',
      payload: { target_type: 'work', patch: { catalogue_status: 'published' } },
    }),
    validMutationBody({
      action: 'edit_draft',
      candidate_revision: null,
      candidate_content_hash: null,
      payload: { target_type: 'publication', patch: { title: 'No' } },
    }),
  ]

  for (const requestBody of invalidBodies) {
    const adminClient = fakeAdminClient()
    const response = await handleReferenceCurationAction({
      actorUserId: ACTOR_ID,
      actorSessionId: ACTOR_SESSION_ID,
      adminClient,
      requestBody,
    })
    assertEquals(response.status, 400)
    assertEquals(response.body.error.code, 'invalid_payload')
    assertEquals(adminClient.calls.length, 0)
  }
})

Deno.test('a new treatment-taxon assignment uses the explicit zero-version create token', async () => {
  const adminClient = fakeAdminClient()
  const payload = {
    target_type: 'treatment_taxa',
    patch: {
      taxon_treatment_id: TARGET_ID,
      sporely_taxon_id: 2100000063,
      assignment_reason: 'Exact species',
    },
  }

  const response = await handleReferenceCurationAction({
    actorUserId: ACTOR_ID,
    actorSessionId: ACTOR_SESSION_ID,
    adminClient,
    requestBody: validMutationBody({
      action: 'edit_draft',
      target_id: '40000000-0000-4000-8000-000000000001',
      expected_row_version: 0,
      candidate_revision: null,
      candidate_content_hash: null,
      reason: 'Assign exact species',
      payload,
    }),
  })

  assertEquals(response.status, 200)
  assertEquals(adminClient.calls[0].args.p_expected_row_version, 0)
  assertEquals(adminClient.calls[0].args.p_payload, payload)
})

Deno.test('edit_draft omits candidate fields but preserves its exact typed patch', async () => {
  const adminClient = fakeAdminClient()
  const body = validMutationBody({
    action: 'edit_draft',
    candidate_revision: null,
    candidate_content_hash: null,
    reason: 'Correct title',
    payload: { target_type: 'work', patch: { title: 'Corrected title' } },
  })

  const response = await handleReferenceCurationAction({
    actorUserId: ACTOR_ID,
    actorSessionId: ACTOR_SESSION_ID,
    adminClient,
    requestBody: body,
  })

  assertEquals(response.status, 200)
  assertEquals(adminClient.calls[0].args.p_candidate_revision, null)
  assertEquals(adminClient.calls[0].args.p_candidate_content_hash, null)
  assertEquals(adminClient.calls[0].args.p_payload, body.payload)
})

Deno.test('database domain statuses map to stable HTTP statuses without Edge retries', async () => {
  const cases = [
    ['created', 200],
    ['updated', 200],
    ['no_change', 200],
    ['conflict', 409],
    ['idempotency_conflict', 409],
    ['invalid_state', 409],
    ['forbidden', 403],
    ['account_unavailable', 403],
    ['not_found', 404],
    ['invalid_payload', 400],
    ['invalid_request', 400],
    ['candidate_unavailable', 409],
  ] as const

  for (const [domainStatus, httpStatus] of cases) {
    const adminClient = fakeAdminClient({ data: { status: domainStatus }, error: null })
    const response = await handleReferenceCurationAction({
      actorUserId: ACTOR_ID,
      actorSessionId: ACTOR_SESSION_ID,
      adminClient,
      requestBody: validMutationBody(),
    })
    assertEquals(response.status, httpStatus, domainStatus)
    assertEquals(adminClient.calls.length, 1, domainStatus)
  }
})

Deno.test('transport failures return a sanitized error and do not leak database details', async () => {
  const secretDetail = 'permission denied for private.reference_curation_submissions'
  const adminClient = fakeAdminClient({
    data: null,
    error: { code: '42501', message: secretDetail },
  })

  const response = await handleReferenceCurationAction({
    actorUserId: ACTOR_ID,
    actorSessionId: ACTOR_SESSION_ID,
    adminClient,
    requestBody: validMutationBody(),
  })

  assertEquals(response.status, 500)
  assertEquals(response.body.error.code, 'curation_operation_failed')
  assertEquals(adminClient.calls.length, 1)
  assertEquals(JSON.stringify(response.body).includes(secretDetail), false)
  assertMatch(String(response.body.error.message), /failed/i)
})

Deno.test('unknown or malformed RPC statuses are replaced with a fixed public error', async () => {
  for (const data of [{ status: 'private_sql_detail' }, {}, { status: 123 }]) {
    const adminClient = fakeAdminClient({ data, error: null })
    const response = await handleReferenceCurationAction({
      actorUserId: ACTOR_ID,
      actorSessionId: ACTOR_SESSION_ID,
      adminClient,
      requestBody: validMutationBody(),
    })

    assertEquals(response.status, 500)
    assertEquals(response.body.error.code, 'curation_operation_failed')
    assertEquals(JSON.stringify(response.body).includes('private_sql_detail'), false)
  }
})

Deno.test('successful privileged RPC responses fail closed on expanded or malformed data', async () => {
  const cases = [
    {
      requestBody: validMutationBody(),
      data: { status: 'updated', submission_id: TARGET_ID, contributor_id: ACTOR_ID },
    },
    {
      requestBody: {
        action: 'duplicate_warnings',
        target_id: TARGET_ID,
        candidate_revision: 2,
        candidate_content_hash: CONTENT_HASH,
      },
      data: { status: 'ok', warnings: [{ kind: 'fuzzy_title', curated_work_id: TARGET_ID }] },
    },
  ]

  for (const { requestBody, data } of cases) {
    const adminClient = fakeAdminClient({ data, error: null })
    const response = await handleReferenceCurationAction({
      actorUserId: ACTOR_ID,
      actorSessionId: ACTOR_SESSION_ID,
      adminClient,
      requestBody,
    })

    assertEquals(response.status, 500)
    assertEquals(response.body.error.code, 'curation_operation_failed')
    assertEquals(JSON.stringify(response.body).includes('contributor_id'), false)
    assertEquals(JSON.stringify(response.body).includes('fuzzy_title'), false)
  }
})

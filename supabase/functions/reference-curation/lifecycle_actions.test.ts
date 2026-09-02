import { assertEquals } from 'jsr:@std/assert@1.0.19'

import { handleReferenceCurationAction } from './actions.ts'

const ACTOR_ID = '10000000-0000-4000-8000-000000006d01'
const SESSION_ID = '11000000-0000-4000-8000-000000006d01'
const TARGET_ID = '20000000-0000-4000-8000-000000006d01'
const REQUEST_ID = '30000000-0000-4000-8000-000000006d01'
const PREDECESSOR_ID = '40000000-0000-4000-8000-000000006d01'
const ASSIGNMENT_ID = '50000000-0000-4000-8000-000000006d01'

function fakeAdminClient(data: Record<string, unknown> = {
  status: 'updated',
  target_id: TARGET_ID,
  bundle_revision: 1,
}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  return {
    calls,
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args })
      return { data, error: null }
    },
  }
}

function lifecycleBody(action: string, payload: Record<string, unknown> = {}) {
  return {
    action,
    request_id: REQUEST_ID,
    target_id: TARGET_ID,
    expected_row_version: 3,
    reason: 'Reviewed publication decision.',
    payload,
  }
}

Deno.test('publish routes exact graph CAS to the dedicated lifecycle RPC', async () => {
  const adminClient = fakeAdminClient()
  const requestBody = lifecycleBody('publish', {
    expected_work_row_version: 4,
    expected_treatment_row_version: 5,
    expected_taxon_assignments: [{ id: ASSIGNMENT_ID, row_version: 2 }],
  })

  const response = await handleReferenceCurationAction({
    actorUserId: ACTOR_ID,
    actorSessionId: SESSION_ID,
    adminClient,
    requestBody,
  })

  assertEquals(response.status, 200)
  assertEquals(adminClient.calls, [{
    name: 'mutate_reference_curation_lifecycle',
    args: {
      p_actor_user_id: ACTOR_ID,
      p_actor_session_id: SESSION_ID,
      p_request_id: REQUEST_ID,
      p_action: 'publish',
      p_target_id: TARGET_ID,
      p_expected_row_version: 3,
      p_reason: 'Reviewed publication decision.',
      p_payload: {
        expected_work_row_version: 4,
        expected_treatment_row_version: 5,
        expected_taxon_assignments: [{ id: ASSIGNMENT_ID, row_version: 2 }],
      },
    },
  }])
})

Deno.test('publish canonicalizes valid UUIDs before exact graph comparison', async () => {
  const adminClient = fakeAdminClient()
  const response = await handleReferenceCurationAction({
    actorUserId: ACTOR_ID,
    actorSessionId: SESSION_ID,
    adminClient,
    requestBody: lifecycleBody('publish', {
      expected_work_row_version: 4,
      expected_treatment_row_version: 5,
      expected_taxon_assignments: [{ id: ASSIGNMENT_ID.toUpperCase(), row_version: 2 }],
    }),
  })

  assertEquals(response.status, 200)
  assertEquals(adminClient.calls[0].args.p_payload, {
    expected_work_row_version: 4,
    expected_treatment_row_version: 5,
    expected_taxon_assignments: [{ id: ASSIGNMENT_ID, row_version: 2 }],
  })
})

Deno.test('supersede binds predecessor CAS and successor graph CAS', async () => {
  const adminClient = fakeAdminClient({
    status: 'updated',
    target_id: TARGET_ID,
    predecessor_id: PREDECESSOR_ID,
    bundle_revision: 1,
  })
  const response = await handleReferenceCurationAction({
    actorUserId: ACTOR_ID,
    actorSessionId: SESSION_ID,
    adminClient,
    requestBody: lifecycleBody('supersede', {
      predecessor_id: PREDECESSOR_ID,
      expected_predecessor_row_version: 8,
      expected_work_row_version: 4,
      expected_treatment_row_version: 5,
      expected_taxon_assignments: [{ id: ASSIGNMENT_ID, row_version: 2 }],
    }),
  })

  assertEquals(response.status, 200)
  assertEquals(adminClient.calls[0].name, 'mutate_reference_curation_lifecycle')
  assertEquals(adminClient.calls[0].args.p_payload, {
    predecessor_id: PREDECESSOR_ID,
    expected_predecessor_row_version: 8,
    expected_work_row_version: 4,
    expected_treatment_row_version: 5,
    expected_taxon_assignments: [{ id: ASSIGNMENT_ID, row_version: 2 }],
  })
})

Deno.test('successor restoration binds the existing predecessor CAS', async () => {
  const adminClient = fakeAdminClient()
  const response = await handleReferenceCurationAction({
    actorUserId: ACTOR_ID,
    actorSessionId: SESSION_ID,
    adminClient,
    requestBody: lifecycleBody('publish', {
      predecessor_id: PREDECESSOR_ID.toUpperCase(),
      expected_predecessor_row_version: 9,
      expected_work_row_version: 4,
      expected_treatment_row_version: 5,
      expected_taxon_assignments: [{ id: ASSIGNMENT_ID, row_version: 2 }],
    }),
  })

  assertEquals(response.status, 200)
  assertEquals(adminClient.calls[0].args.p_payload, {
    predecessor_id: PREDECESSOR_ID,
    expected_predecessor_row_version: 9,
    expected_work_row_version: 4,
    expected_treatment_row_version: 5,
    expected_taxon_assignments: [{ id: ASSIGNMENT_ID, row_version: 2 }],
  })
})

Deno.test('deprecate and withdraw route with empty payloads', async () => {
  for (const action of ['deprecate', 'withdraw']) {
    const adminClient = fakeAdminClient({ status: 'updated', target_id: TARGET_ID })
    const response = await handleReferenceCurationAction({
      actorUserId: ACTOR_ID,
      actorSessionId: SESSION_ID,
      adminClient,
      requestBody: lifecycleBody(action),
    })

    assertEquals(response.status, 200)
    assertEquals(adminClient.calls[0].name, 'mutate_reference_curation_lifecycle')
    assertEquals(adminClient.calls[0].args.p_action, action)
    assertEquals(adminClient.calls[0].args.p_payload, {})
  }
})

Deno.test('all lifecycle actions require a reason and strict action payloads', async () => {
  const invalid = [
    lifecycleBody('publish', { expected_work_row_version: 4 }),
    lifecycleBody('publish', {
      expected_work_row_version: 4,
      expected_treatment_row_version: 5,
      expected_taxon_assignments: [
        { id: ASSIGNMENT_ID, row_version: 2 },
        { id: ASSIGNMENT_ID, row_version: 2 },
      ],
    }),
    lifecycleBody('publish', {
      expected_work_row_version: 4,
      expected_treatment_row_version: 5,
      expected_taxon_assignments: [{ id: ASSIGNMENT_ID, row_version: 2 }],
      snapshot_json: { private: true },
    }),
    lifecycleBody('publish', {
      predecessor_id: PREDECESSOR_ID,
      expected_work_row_version: 4,
      expected_treatment_row_version: 5,
      expected_taxon_assignments: [{ id: ASSIGNMENT_ID, row_version: 2 }],
    }),
    lifecycleBody('deprecate', { successor_id: PREDECESSOR_ID }),
    lifecycleBody('withdraw', { unexpected: true }),
    lifecycleBody('supersede', {
      predecessor_id: PREDECESSOR_ID,
      expected_predecessor_row_version: 8,
      expected_work_row_version: 4,
    }),
    { ...lifecycleBody('deprecate'), reason: '   ' },
  ]

  for (const requestBody of invalid) {
    const adminClient = fakeAdminClient()
    const response = await handleReferenceCurationAction({
      actorUserId: ACTOR_ID,
      actorSessionId: SESSION_ID,
      adminClient,
      requestBody,
    })
    assertEquals(response.status, 400)
    assertEquals(response.body.error.code, 'invalid_payload')
    assertEquals(adminClient.calls.length, 0)
  }
})

Deno.test('lifecycle responses fail closed on expanded privileged data', async () => {
  const adminClient = fakeAdminClient({
    status: 'updated',
    target_id: TARGET_ID,
    bundle_revision: 1,
    snapshot_json: { private: true },
  })
  const response = await handleReferenceCurationAction({
    actorUserId: ACTOR_ID,
    actorSessionId: SESSION_ID,
    adminClient,
    requestBody: lifecycleBody('publish', {
      expected_work_row_version: 4,
      expected_treatment_row_version: 5,
      expected_taxon_assignments: [{ id: ASSIGNMENT_ID, row_version: 2 }],
    }),
  })

  assertEquals(response.status, 500)
  assertEquals(response.body.error.code, 'curation_operation_failed')
})

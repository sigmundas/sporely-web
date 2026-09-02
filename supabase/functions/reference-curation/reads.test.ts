import { assertEquals } from 'jsr:@std/assert@1.0.19'

import { handleReferenceCurationRead } from './reads.ts'

const ACTOR_ID = '10000000-0000-4000-8000-000000000001'
const SESSION_ID = '11000000-0000-4000-8000-000000000001'
const SUBMISSION_ID = '20000000-0000-4000-8000-000000000001'
const HASH = 'a'.repeat(64)
const CAPABILITIES = {
  actor_user_id: ACTOR_ID,
  role: 'reference_reviewer',
  can_review: true,
  can_publish: false,
}

function fakeClient(data: Record<string, unknown>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  return {
    calls,
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args })
      return { data, error: null }
    },
  }
}

Deno.test('capabilities read binds the authenticated actor and session', async () => {
  const client = fakeClient({
    status: 'ok',
    capabilities: CAPABILITIES,
  })
  const result = await handleReferenceCurationRead({
    actorUserId: ACTOR_ID,
    actorSessionId: SESSION_ID,
    adminClient: client,
    requestBody: { action: 'capabilities' },
  })

  assertEquals(result.status, 200)
  assertEquals(client.calls, [{
    name: 'get_reference_curation_capabilities',
    args: { p_actor_user_id: ACTOR_ID, p_actor_session_id: SESSION_ID },
  }])
  assertEquals(result.body, {
    ok: true,
    result: {
      status: 'ok',
      capabilities: CAPABILITIES,
    },
  })
})

Deno.test('queue read has strict bounded filters and a deterministic cursor', async () => {
  const item = {
    id: SUBMISSION_ID,
    status: 'submitted',
    row_version: 3,
    current_candidate_revision: 2,
    current_content_hash: HASH,
    claimed_by: null,
    claimed_at: null,
    feedback_text: null,
    created_at: '2026-08-29T10:00:00Z',
    updated_at: '2026-08-29T11:00:00Z',
    accepted_curated_measurement_set_id: null,
  }
  const client = fakeClient({ status: 'ok', capabilities: CAPABILITIES, items: [item], next_cursor: null })
  const body = {
    action: 'queue',
    status: 'submitted',
    limit: 25,
    after_created_at: '2026-08-29T12:00:00Z',
    after_id: SUBMISSION_ID,
  }
  const result = await handleReferenceCurationRead({
    actorUserId: ACTOR_ID,
    actorSessionId: SESSION_ID,
    adminClient: client,
    requestBody: body,
  })

  assertEquals(result.status, 200)
  assertEquals(client.calls, [{
    name: 'list_reference_curation_queue',
    args: {
      p_actor_user_id: ACTOR_ID,
      p_actor_session_id: SESSION_ID,
      p_status: 'submitted',
      p_limit: 25,
      p_after_created_at: '2026-08-29T12:00:00Z',
      p_after_id: SUBMISSION_ID,
    },
  }])
})

Deno.test('detail read returns only the strict candidate and curated graph envelope', async () => {
  const detail = {
    id: SUBMISSION_ID,
    status: 'submitted',
    row_version: 4,
    current_candidate_revision: 2,
    current_content_hash: HASH,
    claimed_by: null,
    claimed_at: null,
    feedback_text: null,
    created_at: '2026-08-29T10:00:00Z',
    updated_at: '2026-08-29T11:00:00Z',
    accepted_curated_measurement_set_id: null,
  }
  const candidate = {
    schema_version: 1,
    work: {
      type: 'article',
      authors: [],
      editors: [],
      title: 'Work',
      container_title: null,
      year: 2026,
      edition: null,
      publisher: null,
      place: null,
      volume: null,
      issue: null,
      pages: null,
      doi: null,
      isbn: null,
      url: null,
      language: null,
      short_label: 'Work 2026',
      citation_override: null,
    },
    treatment: { name_as_published: 'Taxon', page_from: null, page_to: null, locator_text: null },
    measurement_set: {
      character: 'spore_size',
      raw_text: null,
      data_kind: 'range',
      length_min: null,
      length_core_min: 8,
      length_core_max: 10,
      length_max: null,
      width_min: null,
      width_core_min: 5,
      width_core_max: 6,
      width_max: null,
      q_min: null,
      q_max: null,
      q_mean: null,
      length_mean: null,
      width_mean: null,
      sample_size: null,
      specimen_count: null,
      mount_medium: null,
      stain: null,
      preparation: null,
      measurement_method: null,
      raw_points: null,
    },
  }
  const client = fakeClient({
    status: 'ok',
    capabilities: CAPABILITIES,
    detail: { submission: detail, candidate, accepted_graph: null },
  })
  const result = await handleReferenceCurationRead({
    actorUserId: ACTOR_ID,
    actorSessionId: SESSION_ID,
    adminClient: client,
    requestBody: { action: 'detail', target_id: SUBMISSION_ID },
  })

  assertEquals(result.status, 200)
  assertEquals(client.calls[0], {
    name: 'get_reference_curation_detail',
    args: {
      p_actor_user_id: ACTOR_ID,
      p_actor_session_id: SESSION_ID,
      p_submission_id: SUBMISSION_ID,
    },
  })
})

Deno.test('read requests and responses fail closed on unknown keys, bounds, and private expansion', async () => {
  const invalidBodies = [
    { action: 'capabilities', role: 'reference_publisher' },
    { action: 'queue', status: 'submitted', limit: 51, after_created_at: null, after_id: null },
    { action: 'queue', status: 'unknown', limit: 25, after_created_at: null, after_id: null },
    { action: 'queue', status: 'submitted', limit: 25, after_created_at: 'bad', after_id: SUBMISSION_ID },
    { action: 'queue', status: 'submitted', limit: 25, after_created_at: null, after_id: SUBMISSION_ID },
    { action: 'detail', target_id: 'not-a-uuid' },
  ]
  for (const requestBody of invalidBodies) {
    const client = fakeClient({ status: 'ok' })
    const result = await handleReferenceCurationRead({
      actorUserId: ACTOR_ID,
      actorSessionId: SESSION_ID,
      adminClient: client,
      requestBody,
    })
    assertEquals(result.status, 400)
    assertEquals(client.calls.length, 0)
  }

  const client = fakeClient({
    status: 'ok',
    capabilities: CAPABILITIES,
    items: [],
    next_cursor: null,
    contributor_id: ACTOR_ID,
  })
  const result = await handleReferenceCurationRead({
    actorUserId: ACTOR_ID,
    actorSessionId: SESSION_ID,
    adminClient: client,
    requestBody: { action: 'queue', status: 'submitted', limit: 25, after_created_at: null, after_id: null },
  })
  assertEquals(result.status, 500)

  const expandedCandidateClient = fakeClient({
    status: 'ok',
    capabilities: CAPABILITIES,
    detail: {
      submission: {
        id: SUBMISSION_ID,
        status: 'submitted',
        row_version: 1,
        current_candidate_revision: 1,
        current_content_hash: HASH,
        claimed_by: null,
        claimed_at: null,
        feedback_text: null,
        created_at: '2026-08-29T10:00:00Z',
        updated_at: '2026-08-29T10:00:00Z',
        accepted_curated_measurement_set_id: null,
      },
      candidate: {
        schema_version: 1,
        work: { private_owner_id: ACTOR_ID },
        treatment: {},
        measurement_set: {},
      },
      accepted_graph: null,
    },
  })
  const expandedResult = await handleReferenceCurationRead({
    actorUserId: ACTOR_ID,
    actorSessionId: SESSION_ID,
    adminClient: expandedCandidateClient,
    requestBody: { action: 'detail', target_id: SUBMISSION_ID },
  })
  assertEquals(expandedResult.status, 500)
})

Deno.test('read domain denial and missing detail are mapped without leaking RPC errors', async () => {
  for (const [status, http] of [['forbidden', 403], ['not_found', 404]] as const) {
    const client = fakeClient({ status })
    const result = await handleReferenceCurationRead({
      actorUserId: ACTOR_ID,
      actorSessionId: SESSION_ID,
      adminClient: client,
      requestBody: { action: 'detail', target_id: SUBMISSION_ID },
    })
    assertEquals(result.status, http)
    assertEquals(result.body.ok, false)
  }
})

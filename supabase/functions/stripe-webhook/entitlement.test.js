import test from 'node:test'
import assert from 'node:assert/strict'

import {
  handleChargeRefunded,
  handleCheckoutSessionCompleted,
  isPaymentFullyRefunded,
  supabaseUserIdFromSession,
} from './entitlement.js'

const PRO_PRICE = 'price_pro'
const USER = '00000000-0000-4000-8000-0000000000a1'
const OTHER_USER = '00000000-0000-4000-8000-0000000000a2'
const NOW = () => '2026-11-19T12:00:00.000Z'

// In-memory `profiles` table supporting the query shapes entitlement.js uses:
// update(patch).eq(col, val).select('id')[.maybeSingle()] and
// select(cols).eq(col, val).maybeSingle().
function fakeAdmin(rows, { onUpdate } = {}) {
  const profiles = rows.map(row => ({ ...row }))
  const from = table => {
    assert.equal(table, 'profiles')
    return {
      update: patch => ({
        eq: (col, val) => {
          const run = () => {
            const matched = profiles.filter(row => row[col] === val)
            for (const row of matched) Object.assign(row, patch)
            onUpdate?.(patch)
            return matched.map(row => ({ id: row.id }))
          }
          const selected = {
            maybeSingle: async () => ({ data: run()[0] || null, error: null }),
            then: (res, rej) => Promise.resolve({ data: run(), error: null }).then(res, rej),
          }
          return {
            select: () => selected,
            then: (res, rej) => Promise.resolve({ data: run(), error: null }).then(res, rej),
          }
        },
      }),
      select: () => ({
        eq: (col, val) => ({
          maybeSingle: async () => ({ data: profiles.find(row => row[col] === val) || null, error: null }),
        }),
      }),
    }
  }
  return { from, profiles }
}

// Stripe stub. `refundedReads` lists the refund state returned by successive
// paymentIntents.retrieve calls (the last value repeats).
function fakeStripe({ prices = [PRO_PRICE], refundedReads = [false], amountRefunded = null } = {}) {
  let reads = 0
  return {
    reads: () => reads,
    checkout: {
      sessions: {
        listLineItems: async () => ({ data: prices.map(id => ({ price: { id } })) }),
      },
    },
    paymentIntents: {
      retrieve: async (id, opts) => {
        assert.deepEqual(opts, { expand: ['latest_charge'] })
        const refunded = refundedReads[Math.min(reads, refundedReads.length - 1)]
        reads += 1
        return {
          id,
          latest_charge: {
            id: 'ch_1',
            amount: 9900,
            refunded,
            amount_refunded: amountRefunded ?? (refunded ? 9900 : 0),
          },
        }
      },
    },
  }
}

function paidSession(overrides = {}) {
  return {
    id: 'cs_1',
    payment_status: 'paid',
    payment_intent: 'pi_1',
    customer: 'cus_1',
    client_reference_id: USER,
    metadata: { supabase_user_id: USER },
    ...overrides,
  }
}

function freeProfile(id = USER) {
  return { id, cloud_plan: 'free', is_pro: false, billing_status: null, billing_payment_id: null }
}

test('a paid Pro checkout activates Pro', async () => {
  const admin = fakeAdmin([freeProfile()])
  const stripe = fakeStripe()
  const result = await handleCheckoutSessionCompleted({ stripe, admin, proPriceId: PRO_PRICE, now: NOW }, paidSession())
  assert.equal(result.outcome, 'activated')
  assert.equal(admin.profiles[0].is_pro, true)
  assert.equal(admin.profiles[0].cloud_plan, 'pro')
  assert.equal(admin.profiles[0].billing_payment_id, 'pi_1')
  assert.equal(admin.profiles[0].billing_status, 'one_time_active')
  assert.equal(stripe.reads(), 2, 'refund state is read before and after the write')
})

test('a checkout for another price does not grant Pro', async () => {
  const admin = fakeAdmin([freeProfile()])
  const result = await handleCheckoutSessionCompleted(
    { stripe: fakeStripe({ prices: ['price_sticker'] }), admin, proPriceId: PRO_PRICE, now: NOW },
    paidSession(),
  )
  assert.equal(result.outcome, 'ignored_other_product')
  assert.equal(admin.profiles[0].is_pro, false)
})

test('client_reference_id alone (a Payment Link URL parameter) does not name the user', async () => {
  const admin = fakeAdmin([freeProfile(OTHER_USER)])
  const result = await handleCheckoutSessionCompleted(
    { stripe: fakeStripe(), admin, proPriceId: PRO_PRICE, now: NOW },
    paidSession({ client_reference_id: OTHER_USER, metadata: {} }),
  )
  assert.equal(result.outcome, 'ignored_no_user')
  assert.equal(admin.profiles[0].is_pro, false)
  assert.equal(supabaseUserIdFromSession({ client_reference_id: USER }), '')
})

test('a missing Pro price configuration throws so Stripe retries', async () => {
  const admin = fakeAdmin([freeProfile()])
  await assert.rejects(
    handleCheckoutSessionCompleted({ stripe: fakeStripe(), admin, proPriceId: '', now: NOW }, paidSession()),
    /STRIPE_PRO_PRICE_ID/,
  )
  assert.equal(admin.profiles[0].is_pro, false)
})

test('an unpaid checkout does nothing', async () => {
  const admin = fakeAdmin([freeProfile()])
  const result = await handleCheckoutSessionCompleted(
    { stripe: fakeStripe(), admin, proPriceId: PRO_PRICE, now: NOW },
    paidSession({ payment_status: 'unpaid' }),
  )
  assert.equal(result.outcome, 'ignored_unpaid')
  assert.equal(admin.profiles[0].is_pro, false)
})

test('refund before checkout: the late checkout webhook does not activate Pro', async () => {
  const admin = fakeAdmin([freeProfile()])
  // The refund webhook arrives first and finds no stored payment id.
  const refund = await handleChargeRefunded(
    { admin, now: NOW },
    { id: 'ch_1', payment_intent: 'pi_1', refunded: true, amount: 9900, amount_refunded: 9900 },
  )
  assert.equal(refund.outcome, 'no_profile')
  const result = await handleCheckoutSessionCompleted(
    { stripe: fakeStripe({ refundedReads: [true] }), admin, proPriceId: PRO_PRICE, now: NOW },
    paidSession(),
  )
  assert.equal(result.outcome, 'refunded_before_activation')
  assert.equal(admin.profiles[0].is_pro, false)
  assert.equal(admin.profiles[0].cloud_plan, 'free')
})

test('a refunded checkout leaves Pro from another payment untouched', async () => {
  const admin = fakeAdmin([{ id: USER, cloud_plan: 'pro', is_pro: true, billing_status: 'one_time_active', billing_payment_id: 'pi_0' }])
  const result = await handleCheckoutSessionCompleted(
    { stripe: fakeStripe({ refundedReads: [true] }), admin, proPriceId: PRO_PRICE, now: NOW },
    paidSession(),
  )
  assert.equal(result.outcome, 'refunded_before_activation')
  assert.equal(admin.profiles[0].is_pro, true)
  assert.equal(admin.profiles[0].billing_payment_id, 'pi_0')
})

test('refund during activation: the post-write check revokes Pro', async () => {
  const admin = fakeAdmin([freeProfile()])
  const result = await handleCheckoutSessionCompleted(
    { stripe: fakeStripe({ refundedReads: [false, true] }), admin, proPriceId: PRO_PRICE, now: NOW },
    paidSession(),
  )
  assert.equal(result.outcome, 'refunded_during_activation')
  assert.equal(admin.profiles[0].is_pro, false)
  assert.equal(admin.profiles[0].cloud_plan, 'free')
  assert.equal(admin.profiles[0].billing_status, 'one_time_refunded')
})

test('refund after activation revokes Pro', async () => {
  const admin = fakeAdmin([freeProfile()])
  await handleCheckoutSessionCompleted({ stripe: fakeStripe(), admin, proPriceId: PRO_PRICE, now: NOW }, paidSession())
  assert.equal(admin.profiles[0].is_pro, true)
  const result = await handleChargeRefunded(
    { admin, now: NOW },
    { id: 'ch_1', payment_intent: 'pi_1', refunded: true, amount: 9900, amount_refunded: 9900 },
  )
  assert.equal(result.outcome, 'revoked')
  assert.equal(admin.profiles[0].is_pro, false)
  assert.equal(admin.profiles[0].billing_status, 'one_time_refunded')
})

test('a partial refund keeps Pro', async () => {
  const admin = fakeAdmin([{ id: USER, cloud_plan: 'pro', is_pro: true, billing_status: 'one_time_active', billing_payment_id: 'pi_1' }])
  const result = await handleChargeRefunded(
    { admin, now: NOW },
    { id: 'ch_1', payment_intent: 'pi_1', refunded: false, amount: 9900, amount_refunded: 2000 },
  )
  assert.equal(result.outcome, 'ignored_partial')
  assert.equal(admin.profiles[0].is_pro, true)
})

test('isPaymentFullyRefunded treats only a full refund as refunded', async () => {
  assert.equal(await isPaymentFullyRefunded(fakeStripe({ refundedReads: [false], amountRefunded: 2000 }), 'pi_1'), false)
  assert.equal(await isPaymentFullyRefunded(fakeStripe({ refundedReads: [false], amountRefunded: 9900 }), 'pi_1'), true)
  assert.equal(await isPaymentFullyRefunded(fakeStripe({ refundedReads: [true] }), 'pi_1'), true)
})

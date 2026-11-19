// Pro entitlement logic for the stripe-webhook edge function. Plain JS with
// injected `stripe` and `admin` clients so Node tests can exercise it without
// Deno, Stripe or Supabase (same pattern as delete-account/plan.js).
//
// Stripe is the source of truth, not webhook delivery order:
//   * A checkout grants Pro only when its line items include the configured
//     Pro price and it names the user in metadata.supabase_user_id, which only
//     create-pro-checkout sets (a Payment Link buyer can set
//     client_reference_id in the URL, so it is not trusted).
//   * Before and after writing Pro, the payment's charge is re-read. A refund
//     that landed first (its webhook found no profile to revoke) or while the
//     write ran is caught by one of the two reads, whatever order the
//     webhooks arrive in. A retried checkout that sees the refund revokes
//     Pro stored for this payment, in case an earlier attempt wrote Pro and
//     then failed before its post-write check finished.
//   * Only a full refund revokes Pro; a partial refund keeps it.

/**
 * @param {{ stripe: any, admin: any, proPriceId: string, now?: () => string }} deps
 * @param {any} session Stripe.Checkout.Session
 * @returns {Promise<{ outcome: string }>}
 */
export async function handleCheckoutSessionCompleted(deps, session) {
  const { stripe, admin, proPriceId } = deps
  const now = deps.now || (() => new Date().toISOString())
  if (!proPriceId) {
    // Throwing makes Stripe retry once the secret is configured.
    throw new Error('Missing STRIPE_PRO_PRICE_ID')
  }
  if (session?.payment_status !== 'paid') {
    console.log('Ignoring unpaid checkout session:', session?.id, session?.payment_status)
    return { outcome: 'ignored_unpaid' }
  }

  const userId = supabaseUserIdFromSession(session)
  if (!userId) {
    console.warn('checkout.session.completed missing metadata.supabase_user_id:', session.id)
    return { outcome: 'ignored_no_user' }
  }

  const paymentId = stripeObjectId(session.payment_intent)
  if (!paymentId) {
    console.warn('Paid checkout session without a payment intent:', session.id)
    return { outcome: 'ignored_no_payment' }
  }

  if (!await sessionBuysPro(stripe, session.id, proPriceId)) {
    console.warn('Checkout session is not for the Pro price; not granting Pro:', session.id)
    return { outcome: 'ignored_other_product' }
  }

  const customerId = stripeObjectId(session.customer)

  if (await isPaymentFullyRefunded(stripe, paymentId)) {
    // Do not activate. Revoke only a profile that stores THIS payment: an
    // earlier attempt may have written Pro and then failed its post-write
    // check (timeout, revoke error), so Stripe retried. Pro from another
    // payment or an admin grant has a different billing_payment_id and
    // is left untouched.
    await revokeForPayment(admin, paymentId, now)
    console.warn('Skipping activation for a payment that was already refunded:', session.id)
    return { outcome: 'refunded_before_activation' }
  }

  const { data, error } = await admin
    .from('profiles')
    .update({
      cloud_plan: 'pro',
      is_pro: true,
      billing_provider: 'stripe',
      billing_status: 'one_time_active',
      billing_customer_id: customerId,
      billing_payment_id: paymentId,
      billing_checkout_session_id: session.id,
      billing_updated_at: now(),
    })
    .eq('id', userId)
    .select('id')
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to update profile for paid checkout session ${session.id}: ${error.message}`)
  }
  if (!data) {
    console.warn('checkout.session.completed did not match a profile row:', session.id)
    return { outcome: 'no_profile' }
  }

  // A refund issued while the write ran: its webhook may have read the
  // profile before billing_payment_id was stored and found nothing to revoke.
  if (await isPaymentFullyRefunded(stripe, paymentId)) {
    await revokeForPayment(admin, paymentId, now)
    console.warn('Payment was refunded during activation; Pro revoked:', session.id)
    return { outcome: 'refunded_during_activation' }
  }

  return { outcome: 'activated' }
}

/**
 * @param {{ admin: any, now?: () => string }} deps
 * @param {any} charge Stripe.Charge
 */
export async function handleChargeRefunded(deps, charge) {
  const { admin } = deps
  const now = deps.now || (() => new Date().toISOString())
  const paymentId = stripeObjectId(charge?.payment_intent)
  if (!paymentId) {
    console.log('Ignoring refunded charge without payment intent:', charge?.id)
    return { outcome: 'ignored_no_payment' }
  }
  if (charge.refunded !== true) {
    // charge.refunded also fires for partial refunds; those keep Pro.
    console.log('Ignoring partial refund:', charge.id)
    return { outcome: 'ignored_partial' }
  }
  const revoked = await revokeForPayment(admin, paymentId, now)
  if (!revoked) {
    // Nothing stored yet: the checkout webhook re-checks the charge with
    // Stripe before and after activating, so it will not grant Pro.
    console.log('Refunded payment did not match any stored billing_payment_id:', paymentId)
    return { outcome: 'no_profile' }
  }
  return { outcome: 'revoked' }
}

export async function sessionBuysPro(stripe, sessionId, proPriceId) {
  const items = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 100 })
  return (items?.data || []).some(item => stripeObjectId(item?.price) === proPriceId)
}

export async function isPaymentFullyRefunded(stripe, paymentId) {
  const intent = await stripe.paymentIntents.retrieve(paymentId, { expand: ['latest_charge'] })
  const charge = intent?.latest_charge
  if (!charge || typeof charge !== 'object') return false
  if (charge.refunded === true) return true
  const amount = Number(charge.amount || 0)
  return amount > 0 && Number(charge.amount_refunded || 0) >= amount
}

async function revokeForPayment(admin, paymentId, now) {
  const { data, error } = await admin
    .from('profiles')
    .update({
      cloud_plan: 'free',
      is_pro: false,
      billing_provider: 'stripe',
      billing_status: 'one_time_refunded',
      billing_updated_at: now(),
    })
    .eq('billing_payment_id', paymentId)
    .select('id')

  if (error) {
    throw new Error(`Failed to revoke Pro after refund for ${paymentId}: ${error.message}`)
  }
  return Array.isArray(data) ? data.length > 0 : !!data
}

export function supabaseUserIdFromSession(session) {
  const value = session?.metadata?.supabase_user_id
  return typeof value === 'string' ? value.trim() : ''
}

export function stripeObjectId(value) {
  if (typeof value === 'string') return value.trim() || null
  const id = value?.id
  return typeof id === 'string' && id.trim() ? id.trim() : null
}

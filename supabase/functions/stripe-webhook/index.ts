/// <reference lib="dom" />
/// <reference lib="deno.ns" />

import { createClient } from 'jsr:@supabase/supabase-js@2'
import Stripe from 'npm:stripe@16'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const stripeWebhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''
const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? 'sk_test_placeholder')

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

Deno.serve(async req => {
  if (req.method === 'OPTIONS') {
    return new Response('ok')
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  try {
    if (!supabaseUrl || !serviceRoleKey) {
      return new Response('Missing Supabase configuration', { status: 500 })
    }
    if (!stripeWebhookSecret) {
      return new Response('Missing STRIPE_WEBHOOK_SECRET', { status: 500 })
    }

    const signature = req.headers.get('stripe-signature')
    if (!signature) {
      return new Response('Missing Stripe signature', { status: 400 })
    }

    const body = await req.text()

    let event: Stripe.Event
    try {
      event = await stripe.webhooks.constructEventAsync(body, signature, stripeWebhookSecret)
    } catch (error) {
      console.error('Stripe signature verification failed:', error)
      return new Response(`Invalid signature: ${error instanceof Error ? error.message : 'unknown error'}`, { status: 400 })
    }

    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session)
        break
      case 'charge.refunded':
        await handleChargeRefunded(event.data.object as Stripe.Charge)
        break
      default:
        break
    }

    return new Response('ok')
  } catch (error) {
    console.error('stripe-webhook failed:', error)
    return new Response(error instanceof Error ? error.message : 'Unexpected error', { status: 500 })
  }
})

async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session) {
  if (session.payment_status !== 'paid') {
    console.log('Ignoring unpaid checkout session:', session.id, session.payment_status)
    return
  }

  const userId = extractSupabaseUserId(session)
  if (!userId) {
    console.warn('checkout.session.completed missing Supabase user id:', session.id)
    return
  }

  const paymentId = stripeObjectId(session.payment_intent)
  const customerId = stripeObjectId(session.customer)

  if (paymentId) {
    const { data: existingProfile, error: existingProfileError } = await admin
      .from('profiles')
      .select('id, billing_status, billing_payment_id')
      .eq('id', userId)
      .maybeSingle()

    if (existingProfileError) {
      throw new Error(`Failed to load current profile for paid checkout session ${session.id}: ${existingProfileError.message}`)
    }

    if (existingProfile?.billing_status === 'one_time_refunded' && existingProfile.billing_payment_id === paymentId) {
      console.warn('Skipping activation for a payment that was already refunded:', session.id, paymentId)
      return
    }
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
      billing_updated_at: new Date().toISOString(),
    })
    .eq('id', userId)
    .select('id')
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to update profile for paid checkout session ${session.id}: ${error.message}`)
  }
  if (!data) {
    console.warn('checkout.session.completed did not match a profile row:', session.id, userId)
  }
}

async function handleChargeRefunded(charge: Stripe.Charge) {
  const paymentId = stripeObjectId(charge.payment_intent)
  if (!paymentId) {
    console.log('Ignoring refunded charge without payment intent:', charge.id)
    return
  }

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('id, billing_payment_id')
    .eq('billing_payment_id', paymentId)
    .maybeSingle()

  if (profileError) {
    throw new Error(`Failed to load profile for refunded payment ${paymentId}: ${profileError.message}`)
  }
  if (!profile) {
    console.log('Refunded payment did not match any stored billing_payment_id:', paymentId)
    return
  }

  const { data, error } = await admin
    .from('profiles')
    .update({
      cloud_plan: 'free',
      is_pro: false,
      billing_provider: 'stripe',
      billing_status: 'one_time_refunded',
      billing_updated_at: new Date().toISOString(),
    })
    .eq('id', profile.id)
    .select('id')
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to revoke Pro after refund for ${paymentId}: ${error.message}`)
  }
  if (!data) {
    console.warn('charge.refunded did not update a profile row:', paymentId, profile.id)
  }
}

function extractSupabaseUserId(session: Stripe.Checkout.Session) {
  const fromClientReference = typeof session.client_reference_id === 'string' ? session.client_reference_id.trim() : ''
  if (fromClientReference) return fromClientReference

  const metadataUserId = session.metadata?.supabase_user_id
  if (typeof metadataUserId === 'string' && metadataUserId.trim()) {
    return metadataUserId.trim()
  }

  return ''
}

function stripeObjectId(value: string | { id?: string } | null | undefined) {
  if (typeof value === 'string') return value.trim() || null
  const id = value?.id
  return typeof id === 'string' && id.trim() ? id.trim() : null
}

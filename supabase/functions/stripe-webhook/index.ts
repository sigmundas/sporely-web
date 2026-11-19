/// <reference lib="dom" />
/// <reference lib="deno.ns" />

import { createClient } from 'jsr:@supabase/supabase-js@2'
import Stripe from 'npm:stripe@16'
// Plain-JS entitlement logic shared with the Node tests (entitlement.test.js).
import { handleChargeRefunded, handleCheckoutSessionCompleted } from './entitlement.js'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const stripeWebhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''
const stripeProPriceId = Deno.env.get('STRIPE_PRO_PRICE_ID') ?? ''
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
        await handleCheckoutSessionCompleted(
          { stripe, admin, proPriceId: stripeProPriceId },
          event.data.object as Stripe.Checkout.Session,
        )
        break
      case 'charge.refunded':
        await handleChargeRefunded({ admin }, event.data.object as Stripe.Charge)
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

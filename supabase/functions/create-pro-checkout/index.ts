/// <reference lib="dom" />
/// <reference lib="deno.ns" />

import { createClient } from 'jsr:@supabase/supabase-js@2'
import Stripe from 'npm:stripe@16'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
const stripeProPriceId = Deno.env.get('STRIPE_PRO_PRICE_ID') ?? ''
const checkoutSuccessUrl = 'https://sporely.no/pro.html?checkout=success'
const checkoutCancelUrl = 'https://sporely.no/pro.html?checkout=cancel'

const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  try {
    if (!stripe) {
      return json({ error: 'Missing STRIPE_SECRET_KEY' }, 500)
    }
    if (!stripeProPriceId) {
      return json({ error: 'Missing STRIPE_PRO_PRICE_ID' }, 500)
    }
    if (!supabaseUrl || !supabaseAnonKey) {
      return json({ error: 'Missing Supabase configuration' }, 500)
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ error: 'Missing Authorization header' }, 401)
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    })

    const { data: { user }, error: userError } = await userClient.auth.getUser()
    if (userError || !user) {
      return json({ error: 'Unauthorized' }, 401)
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: stripeProPriceId, quantity: 1 }],
      success_url: checkoutSuccessUrl,
      cancel_url: checkoutCancelUrl,
      client_reference_id: user.id,
      metadata: {
        supabase_user_id: user.id,
      },
      customer_email: user.email ?? undefined,
    })

    if (!checkoutSession.url) {
      return json({ error: 'Stripe did not return a checkout URL' }, 500)
    }

    return json({ url: checkoutSession.url })
  } catch (error) {
    console.error('create-pro-checkout failed:', error)
    return json({ error: error instanceof Error ? error.message : 'Unexpected error' }, 500)
  }
})

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  })
}

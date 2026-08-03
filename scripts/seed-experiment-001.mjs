#!/usr/bin/env node
// Seeds Experiment 001: pass-to-table latency vs. plate clearance and
// satisfaction. This is a NATURAL experiment - nothing is manipulated;
// pass-to-table latency already varies every service, we just measure it
// (table_sessions.pass_time + clearance_pct, added in 008_pass_to_table.sql).
// Because there is no manipulation, it needs no staff behaviour change and
// no partner permission beyond data access - it is the designated first
// experiment precisely because it is already running.
//
// Requires the Supabase SERVICE ROLE key (bypasses RLS by design, same as
// scripts/seed-demo.mjs and scripts/seed-experiment-templates.mjs) - never
// expose this key to the browser.
//
// Usage:
//   node scripts/seed-experiment-001.mjs --restaurant-id=<uuid>
//   RESTAURANT_ID=<uuid> node scripts/seed-experiment-001.mjs
//
// Env vars (from .env.local if present, or the real environment):
//   NEXT_PUBLIC_SUPABASE_URL       (required)
//   SUPABASE_SERVICE_ROLE_KEY      (required - Project Settings -> API -> service_role)

import { createClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'node:fs'

function loadDotEnvLocal() {
  if (!existsSync('.env.local')) return
  const text = readFileSync('.env.local', 'utf-8')
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

loadDotEnvLocal()

const restaurantIdArg = process.argv.find((a) => a.startsWith('--restaurant-id='))
const RESTAURANT_ID = restaurantIdArg ? restaurantIdArg.split('=')[1] : process.env.RESTAURANT_ID
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n' +
      'Set them in .env.local (service role key: Supabase Dashboard -> Project Settings -> API) and re-run.'
  )
  process.exit(1)
}

if (!RESTAURANT_ID) {
  console.error(
    'Missing restaurant id. Pass --restaurant-id=<uuid> or set RESTAURANT_ID env var.'
  )
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const EXPERIMENT_NAME = 'Experiment 001: pass-to-table latency vs. plate clearance'

const EXPERIMENT = {
  experiment_name: EXPERIMENT_NAME,
  hypothesis:
    'Longer pass-to-table latency (time between a dish leaving the kitchen pass and reaching the ' +
    'table) reduces plate clearance: every additional minute of latency lowers clearance_pct, because ' +
    'the dish cools through its intended perceptual window before the first bite (aroma volatility ' +
    'falls with temperature, and TRPM5-mediated sweetness/umami response drops as food cools - ' +
    'Talavera et al. 2005, Nature). Prediction: sessions in the slowest latency quartile show at ' +
    'least 10 percentage points lower clearance_pct than the fastest quartile, controlling for ' +
    'daypart, day-of-week and party size.',
  variable_changed:
    'none - natural experiment. Pass-to-table latency (table_sessions.pass_time vs. serve/first-order ' +
    'timing) is observed, not manipulated. Staff behaviour is unchanged.',
  control_condition:
    'Fastest pass-to-table latency quartile (observed, not assigned).',
  test_condition:
    'Slowest pass-to-table latency quartile (observed, not assigned).',
  randomization_unit: 'session',
  primary_metric: 'clearance_pct',
  secondary_metrics: [
    'return_rate', // mandatory on every experiment - DB check enforces this
    'dwell_time',
    'order_value',
    'dessert_count',
  ],
  min_detectable_effect: 10.0, // percentage points of clearance_pct, slowest vs fastest quartile
  status: 'planned',
}

async function main() {
  const { data: restaurant, error: findErr } = await supabase
    .from('restaurants')
    .select('id, name')
    .eq('id', RESTAURANT_ID)
    .maybeSingle()
  if (findErr) throw findErr
  if (!restaurant) {
    console.error(`No restaurant found with id=${RESTAURANT_ID}`)
    process.exit(1)
  }

  // Idempotent: don't create a duplicate Experiment 001 on re-run.
  const { data: existing, error: existErr } = await supabase
    .from('experiments')
    .select('id')
    .eq('restaurant_id', RESTAURANT_ID)
    .eq('experiment_name', EXPERIMENT_NAME)
    .maybeSingle()
  if (existErr) throw existErr
  if (existing) {
    console.log(`Experiment 001 already exists for ${restaurant.name} (id=${existing.id}); nothing to do.`)
    return
  }

  const { data: experiment, error: insertErr } = await supabase
    .from('experiments')
    .insert({
      restaurant_id: RESTAURANT_ID,
      ...EXPERIMENT,
      start_time: new Date().toISOString(), // placeholder until the owner starts it; status stays 'planned'
    })
    .select('id')
    .single()
  if (insertErr) throw insertErr

  // Observed-quartile "arms". These are analysis strata, not assigned
  // treatments - is_control marks the fastest quartile as the comparison
  // baseline. No experiment_assignments rows are created: assignment is by
  // observation at analysis time, which is what makes this zero-friction.
  const { error: armErr } = await supabase.from('experiment_treatments').insert([
    {
      experiment_id: experiment.id,
      label: 'Fastest latency quartile (observed)',
      is_control: true,
      config: { observed_stratum: 'pass_to_table_latency_q1' },
    },
    {
      experiment_id: experiment.id,
      label: 'Slowest latency quartile (observed)',
      is_control: false,
      config: { observed_stratum: 'pass_to_table_latency_q4' },
    },
  ])
  if (armErr) throw armErr

  console.log(`Seeded "${EXPERIMENT_NAME}" for ${restaurant.name} (id=${experiment.id}).`)
  console.log('Next steps:')
  console.log('  1. Apply migration 008_pass_to_table.sql (adds pass_time + clearance_pct).')
  console.log('  2. Have kitchen/bussing staff log pass_time and clearance_pct per session.')
  console.log('  3. Start the experiment from /experiments when logging is consistent.')
}

main().catch((err) => {
  console.error('Failed to seed Experiment 001:', err.message)
  process.exit(1)
})

#!/usr/bin/env node
// Seeds a set of pre-built, unrun (status: 'planned') experiment templates
// for one restaurant, covering the atmospherics variables MEZA already
// tracks (music, temperature, lighting, queue visibility, wait-time
// experience). Gives a new restaurant owner a concrete, falsifiable
// starting point instead of a blank experiment form - none of these are
// run automatically; the owner still starts/ends them from the
// /experiments page when ready.
//
// Requires the Supabase SERVICE ROLE key (bypasses RLS by design, same as
// scripts/seed-demo.mjs and cv_pipeline/occupancy_detector.py) - never
// expose this key to the browser.
//
// Usage:
//   node scripts/seed-experiment-templates.mjs --restaurant-id=<uuid>
//   RESTAURANT_ID=<uuid> node scripts/seed-experiment-templates.mjs
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

// Each hypothesis is a specific, falsifiable statement - not "test music"
// but a concrete predicted direction and outcome metric, matching the
// variables already tracked in environment_snapshots/table_sessions/
// occupancy_snapshots so results can actually be measured from real data
// once run.
const TEMPLATES = [
  {
    experiment_name: 'Slower music tempo during dinner service',
    hypothesis:
      'Reducing music tempo from upbeat (>120 BPM) to slow/ambient (<90 BPM) during 7-10pm dinner service ' +
      'increases average dwell time per table by at least 10% and increases table turnover revenue per hour ' +
      'despite longer occupancy, because higher order values per table more than offset fewer seatings.',
    variable_changed: 'music_genre / music tempo (proxy for music_volume + genre logged in environment_snapshots)',
    control_condition: 'Current upbeat playlist (>120 BPM) played at usual volume during 7-10pm.',
    test_condition: 'Slow/ambient playlist (<90 BPM) at the same volume during 7-10pm, all else unchanged.',
    primary_metric: 'dwell_time',
  },
  {
    experiment_name: 'Lower indoor temperature during peak hours',
    hypothesis:
      'Lowering indoor temperature from ~26-28°C to ~22-24°C during peak occupancy hours increases average ' +
      'dwell time by at least 5 minutes per table and increases beverage sales per table by at least 15%, ' +
      'because guests are more comfortable lingering in a cooler room.',
    variable_changed: 'temperature (environment_snapshots.temperature)',
    control_condition: 'AC setpoint left at current level (~26-28°C) during peak hours.',
    test_condition: 'AC setpoint lowered to ~22-24°C during the same peak hours, all else unchanged.',
    primary_metric: 'drink_count',
  },
  {
    experiment_name: 'Warmer, dimmer lighting in the evening',
    hypothesis:
      'Switching evening lighting from bright/cool (>70 brightness, >4000K) to warm/dim (<40 brightness, ' +
      '<3000K) increases average dwell time by at least 10% and improves guests\' perceived quality of the ' +
      'space, measurable as higher average order value per table (a common proxy for perceived experience ' +
      'quality when no direct survey data exists).',
    variable_changed: 'lighting_brightness / lighting_temperature (environment_snapshots)',
    control_condition: 'Current bright/cool lighting (>70 brightness, >4000K) after 6pm.',
    test_condition: 'Warm/dim lighting (<40 brightness, <3000K) after 6pm, all else unchanged.',
    primary_metric: 'order_value',
  },
  {
    experiment_name: 'Visible queue/wait display at the entrance',
    hypothesis:
      'Displaying a real-time queue length and estimated wait time at the entrance (vs. no visible wait ' +
      'information) increases walk-in conversion rate (people_count who join the queue vs. who see it and ' +
      'leave) by at least 10%, because a known, bounded wait is less discouraging than an unknown one.',
    variable_changed: 'presence of a queue/wait-time display at the entrance (not a tracked column - log ' +
      'manually via special_event or an operational note for the test window)',
    control_condition: 'No visible wait-time information; guests estimate the queue themselves.',
    test_condition: 'A screen or sign showing current queue_length and estimated wait_time at the entrance.',
    primary_metric: 'walk_in_conversion_rate',
  },
  {
    experiment_name: 'Occupied waiting experience vs. idle waiting',
    hypothesis:
      'Giving waiting guests something to do (a menu preview, a small seated waiting area with charging ' +
      'points, or a QR-code ordering preview) instead of unoccupied standing wait reduces abandonment rate ' +
      '(guests who leave the queue before being seated) by at least 15% at the same average wait_time.',
    variable_changed: 'waiting experience design (not a tracked column - measure via queue_length entering ' +
      'vs. people_count actually seated for the test window)',
    control_condition: 'Guests wait standing with no activity or seating provided.',
    test_condition: 'Guests wait with a seated area, menu preview, and QR ordering preview available.',
    primary_metric: 'queue_abandonment_rate',
  },
]

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

  const now = new Date().toISOString()
  const rows = TEMPLATES.map((t) => ({
    restaurant_id: RESTAURANT_ID,
    experiment_name: t.experiment_name,
    hypothesis: t.hypothesis,
    variable_changed: t.variable_changed,
    control_condition: t.control_condition,
    test_condition: t.test_condition,
    start_time: now, // placeholder: experiment hasn't actually started - status stays 'planned' until the owner runs it
    status: 'planned',
    // Required since 007_experiment_lab.sql. All five templates are
    // room-wide atmospherics levers, so they randomize at the day level;
    // secondary_metrics is left to its DB default ('{return_rate}').
    randomization_unit: 'day',
    primary_metric: t.primary_metric,
  }))

  const { data: inserted, error: insertErr } = await supabase
    .from('experiments')
    .insert(rows)
    .select('id, experiment_name')
  if (insertErr) throw insertErr

  console.log(`Seeded ${inserted.length} experiment template(s) for ${restaurant.name}:`)
  for (const exp of inserted) {
    console.log(`  - ${exp.experiment_name}`)
  }
}

main().catch((err) => {
  console.error('Failed to seed experiment templates:', err.message)
  process.exit(1)
})

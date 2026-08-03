#!/usr/bin/env node
// Seeds (or re-seeds) a read-only demo restaurant with 60 days of realistic
// synthetic occupancy, environment, and revenue data, plus a demo auth
// account that can sign in and view it. Safe to re-run: it wipes and
// regenerates only the one restaurant flagged is_demo = true for the demo
// account, never touches real customer data.
//
// Requires the Supabase SERVICE ROLE key (bypasses RLS by design, same as
// cv_pipeline/occupancy_detector.py) - never expose this key to the browser.
//
// Usage:
//   node scripts/seed-demo.mjs
//
// Env vars (from .env.local if present, or the real environment):
//   NEXT_PUBLIC_SUPABASE_URL       (required)
//   SUPABASE_SERVICE_ROLE_KEY      (required - Project Settings -> API -> service_role)
//   DEMO_EMAIL                     (default: demo@meza.app)
//   DEMO_PASSWORD                  (default: MezaDemo2026!)

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

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const DEMO_EMAIL = process.env.DEMO_EMAIL || 'demo@meza.app'
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'MezaDemo2026!'
const DEMO_RESTAURANT_NAME = 'Meza Demo Bistro'

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n' +
      'Set them in .env.local (service role key: Supabase Dashboard -> Project Settings -> API) and re-run.'
  )
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const DAY_MS = 24 * 60 * 60 * 1000
const rand = (min, max) => min + Math.random() * (max - min)
const randInt = (min, max) => Math.floor(rand(min, max + 1))
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

const MENU = [
  { name: 'Margherita Pizza', category: 'Mains', price: 420 },
  { name: 'Butter Chicken', category: 'Mains', price: 480 },
  { name: 'Paneer Tikka Wrap', category: 'Mains', price: 320 },
  { name: 'Truffle Fries', category: 'Sides', price: 220 },
  { name: 'Caesar Salad', category: 'Sides', price: 280 },
  { name: 'Tiramisu', category: 'Dessert', price: 260 },
  { name: 'Chocolate Lava Cake', category: 'Dessert', price: 240 },
  { name: 'Craft Lemonade', category: 'Drink', price: 180 },
  { name: 'House Red Wine (Glass)', category: 'Drink', price: 350 },
  { name: 'Espresso Martini', category: 'Drink', price: 420 },
  { name: 'Masala Chai', category: 'Drink', price: 90 },
]

async function findOrCreateDemoUser() {
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    email_confirm: true,
    user_metadata: { is_demo_account: true },
  })
  if (!createErr && created?.user) return created.user

  // Already exists - look it up.
  let page = 1
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    const match = data.users.find((u) => u.email === DEMO_EMAIL)
    if (match) return match
    if (data.users.length < 200) break
    page += 1
  }
  throw new Error(`Could not create or find demo user ${DEMO_EMAIL}: ${createErr?.message}`)
}

async function findOrCreateDemoRestaurant(ownerId) {
  const { data: existing, error: findErr } = await supabase
    .from('restaurants')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('is_demo', true)
    .maybeSingle()
  if (findErr) throw findErr
  if (existing) return existing

  const { data: created, error: createErr } = await supabase
    .from('restaurants')
    .insert({
      owner_id: ownerId,
      name: DEMO_RESTAURANT_NAME,
      location: 'Bandra West, Mumbai',
      timezone: 'Asia/Kolkata',
      max_capacity: 18,
      is_demo: true,
    })
    .select()
    .single()
  if (createErr) throw createErr
  return created
}

async function wipeDemoData(restaurantId) {
  const { data: experiments } = await supabase
    .from('experiments')
    .select('id')
    .eq('restaurant_id', restaurantId)

  await supabase.from('occupancy_snapshots').delete().eq('restaurant_id', restaurantId)
  await supabase.from('table_sessions').delete().eq('restaurant_id', restaurantId)
  await supabase.from('environment_snapshots').delete().eq('restaurant_id', restaurantId)
  await supabase.from('operational_snapshots').delete().eq('restaurant_id', restaurantId)
  await supabase.from('recommendations').delete().eq('restaurant_id', restaurantId)
  await supabase.from('pos_orders').delete().eq('restaurant_id', restaurantId)
  if (experiments?.length) {
    await supabase.from('experiments').delete().eq('restaurant_id', restaurantId)
  }
  await supabase.from('cameras').delete().eq('restaurant_id', restaurantId)
}

async function insertBatched(table, rows, chunkSize = 500) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize)
    const { error } = await supabase.from(table).insert(chunk)
    if (error) throw new Error(`Insert into ${table} failed: ${error.message}`)
  }
}

// Occupancy shape: closed before 08:00 / after 23:00, lunch peak 12-14,
// dinner peak 19-22, weekends busier than weekdays, with jitter.
function occupancyForHour(hour, isWeekend) {
  if (hour < 8 || hour > 23) return null
  let base
  if (hour >= 12 && hour <= 14) base = isWeekend ? 78 : 62
  else if (hour >= 19 && hour <= 22) base = isWeekend ? 92 : 74
  else if (hour >= 8 && hour <= 11) base = 18
  else if (hour >= 15 && hour <= 18) base = 30
  else base = 25
  const occupancy = clamp(Math.round(base + rand(-10, 10)), 3, 100)
  const totalTables = 18
  const occupiedTables = clamp(Math.round((occupancy / 100) * totalTables), 0, totalTables)
  const peopleCount = clamp(Math.round(occupiedTables * rand(1.8, 3.2)), 0, totalTables * 4)
  const queueLength = occupancy > 85 ? randInt(1, 9) : occupancy > 70 ? randInt(0, 3) : 0
  const waitTime = queueLength * randInt(2, 4)
  return {
    occupancy_percentage: occupancy,
    occupied_tables: occupiedTables,
    available_tables: totalTables - occupiedTables,
    people_count: peopleCount,
    queue_length: queueLength,
    wait_time: waitTime,
    total_tables: totalTables,
  }
}

function buildOrderForSession(startTime) {
  const itemCount = randInt(2, 5)
  const items = []
  let hasDessert = false
  let hasDrink = false
  for (let i = 0; i < itemCount; i++) {
    const menuItem = pick(MENU)
    const quantity = randInt(1, 2)
    if (menuItem.category === 'Dessert') hasDessert = true
    if (menuItem.category === 'Drink') hasDrink = true
    items.push({
      item_name: menuItem.name,
      category: menuItem.category,
      quantity,
      price: menuItem.price,
      total: menuItem.price * quantity,
      is_dessert: menuItem.category === 'Dessert',
      is_drink: menuItem.category === 'Drink',
    })
  }
  const totalAmount = items.reduce((sum, i) => sum + i.total, 0)
  return { items, totalAmount, hasDessert, hasDrink }
}

async function seedDayData(restaurantId, dayOffset, now, tableSessions, occupancySnapshots, environmentSnapshots, posOrders, orderItemsByExternalId) {
  const dayStart = new Date(now.getTime() - dayOffset * DAY_MS)
  dayStart.setHours(0, 0, 0, 0)
  const dow = dayStart.getDay()
  const isWeekend = dow === 0 || dow === 5 || dow === 6

  for (let hour = 8; hour <= 23; hour++) {
    const shape = occupancyForHour(hour, isWeekend)
    if (!shape) continue
    const ts = new Date(dayStart)
    ts.setHours(hour, randInt(0, 59), 0, 0)
    if (ts > now) continue
    occupancySnapshots.push({ restaurant_id: restaurantId, timestamp: ts.toISOString(), ...shape })

    // Table sessions + POS orders roughly proportional to occupied tables.
    const sessionsThisHour = Math.round(shape.occupied_tables * rand(0.3, 0.6))
    for (let s = 0; s < sessionsThisHour; s++) {
      const startTime = new Date(ts.getTime() + randInt(0, 50) * 60000)
      if (startTime > now) continue
      const dwellTime = randInt(35, 95)
      const endTime = new Date(startTime.getTime() + dwellTime * 60000)
      const { items, totalAmount, hasDessert, hasDrink } = buildOrderForSession(startTime)
      const partySize = randInt(1, 6)

      tableSessions.push({
        restaurant_id: restaurantId,
        table_number: randInt(1, 18),
        party_size: partySize,
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString(),
        dwell_time: dwellTime,
        order_value: totalAmount,
        item_count: items.length,
        dessert_count: hasDessert ? 1 : 0,
        drink_count: hasDrink ? 1 : 0,
      })

      const externalId = `DEMO-${startTime.getTime()}-${s}`
      posOrders.push({
        restaurant_id: restaurantId,
        external_id: externalId,
        timestamp: startTime.toISOString(),
        order_type: 'DINE_IN',
        channel: rand(0, 1) > 0.85 ? 'ONLINE' : 'DIRECT',
        subtotal: totalAmount,
        tax: Math.round(totalAmount * 0.05),
        discount: 0,
        total_amount: totalAmount,
        payment_method: pick(['UPI', 'CARD', 'CASH']),
        guest_count: partySize,
        table_number: randInt(1, 18),
        status: 'COMPLETED',
      })
      orderItemsByExternalId.set(externalId, items)
    }
  }

  // ~2 environment readings/day: afternoon and evening.
  const baseTemp = 26 + 4 * Math.sin((dayOffset / 60) * Math.PI * 2)
  for (const hour of [14, 20]) {
    const ts = new Date(dayStart)
    ts.setHours(hour, randInt(0, 40), 0, 0)
    if (ts > now) continue
    environmentSnapshots.push({
      restaurant_id: restaurantId,
      timestamp: ts.toISOString(),
      temperature: Math.round((baseTemp + rand(-2, 2)) * 10) / 10,
      humidity: Math.round(rand(45, 80) * 10) / 10,
      weather: pick(['clear', 'clear', 'cloudy', 'rainy']),
      rainfall: Math.random() < 0.15,
      music_genre: hour >= 19 ? pick(['jazz', 'lofi', 'acoustic']) : pick(['ambient', 'pop']),
      music_volume: Math.round(rand(3, 7) * 10) / 10,
      lighting_brightness: hour >= 19 ? rand(30, 55) : rand(60, 90),
      lighting_temperature: hour >= 19 ? randInt(2200, 2900) : randInt(3500, 4500),
      promotion_active: isWeekend && Math.random() < 0.2,
      special_event: Math.random() < 0.03 ? pick(['Live acoustic set', 'Chef tasting night']) : null,
      staff_count: isWeekend ? randInt(7, 10) : randInt(5, 8),
    })
  }
}

async function seed() {
  console.log(`Seeding demo data against ${SUPABASE_URL} ...`)

  const user = await findOrCreateDemoUser()
  console.log(`Demo auth user: ${user.email} (${user.id})`)

  const restaurant = await findOrCreateDemoRestaurant(user.id)
  console.log(`Demo restaurant: ${restaurant.name} (${restaurant.id})`)

  console.log('Wiping previous demo data...')
  await wipeDemoData(restaurant.id)

  const now = new Date()
  const occupancySnapshots = []
  const tableSessions = []
  const environmentSnapshots = []
  const posOrders = []
  const orderItemsByExternalId = new Map()

  console.log('Generating 60 days of synthetic data...')
  for (let dayOffset = 59; dayOffset >= 0; dayOffset--) {
    await seedDayData(
      restaurant.id,
      dayOffset,
      now,
      tableSessions,
      occupancySnapshots,
      environmentSnapshots,
      posOrders,
      orderItemsByExternalId
    )
  }

  console.log(
    `Inserting ${occupancySnapshots.length} occupancy snapshots, ${environmentSnapshots.length} environment snapshots, ${tableSessions.length} table sessions, ${posOrders.length} orders...`
  )
  await insertBatched('occupancy_snapshots', occupancySnapshots)
  await insertBatched('environment_snapshots', environmentSnapshots)
  await insertBatched('table_sessions', tableSessions)

  // Orders need their generated id back to insert line items, so these go
  // one at a time via upsert-style insert+select rather than a blind batch.
  let orderCount = 0
  let itemCount = 0
  for (let i = 0; i < posOrders.length; i += 200) {
    const chunk = posOrders.slice(i, i + 200)
    const { data: inserted, error } = await supabase.from('pos_orders').insert(chunk).select('id, external_id')
    if (error) throw new Error(`Insert into pos_orders failed: ${error.message}`)
    orderCount += inserted.length

    const itemRows = []
    for (const order of inserted) {
      const items = orderItemsByExternalId.get(order.external_id) || []
      for (const item of items) {
        itemRows.push({ order_id: order.id, ...item })
      }
    }
    if (itemRows.length) {
      await insertBatched('pos_order_items', itemRows)
      itemCount += itemRows.length
    }
  }
  console.log(`Inserted ${orderCount} orders with ${itemCount} line items.`)

  // Experiments + one completed result, so /experiments and the dashboard
  // "active experiments" card both have something real to show.
  const experimentStart = new Date(now.getTime() - 45 * DAY_MS)
  const experimentEnd = new Date(now.getTime() - 31 * DAY_MS)
  const { data: completedExperiment, error: expErr } = await supabase
    .from('experiments')
    .insert({
      restaurant_id: restaurant.id,
      experiment_name: 'Jazz Music Evening Trial',
      hypothesis: 'Playing jazz music between 7-9pm increases average order value and dwell time.',
      variable_changed: 'music_genre',
      control_condition: 'Regular pop playlist',
      test_condition: 'Curated jazz playlist at volume 5',
      start_time: experimentStart.toISOString(),
      end_time: experimentEnd.toISOString(),
      status: 'completed',
      // Required since 007_experiment_lab.sql (room-wide music lever ->
      // day-level randomization); secondary_metrics defaults to '{return_rate}'.
      randomization_unit: 'day',
      primary_metric: 'order_value',
    })
    .select()
    .single()
  if (expErr) throw expErr

  await supabase.from('experiment_results').insert({
    experiment_id: completedExperiment.id,
    revenue_delta: 8400,
    average_order_value_delta: 65,
    dwell_time_delta: 9,
    dessert_delta: 0.4,
    drink_delta: 0.6,
    confidence_score: 87,
    measured_at: experimentEnd.toISOString(),
  })

  await supabase.from('experiments').insert({
    restaurant_id: restaurant.id,
    experiment_name: 'Weekend Lighting Dimming Test',
    hypothesis: 'Dimmer, warmer lighting on weekend evenings increases dessert attach rate.',
    variable_changed: 'lighting',
    control_condition: 'Standard 4000K brightness 80%',
    test_condition: 'Warm 2400K brightness 40% after 7pm',
    start_time: new Date(now.getTime() - 6 * DAY_MS).toISOString(),
    end_time: null,
    status: 'active',
    randomization_unit: 'day',
    primary_metric: 'dessert_count',
  })

  // Recommendations - a mix of implemented and pending, matching what the
  // /recommendations page renders.
  await insertBatched('recommendations', [
    {
      restaurant_id: restaurant.id,
      timestamp: new Date(now.getTime() - 3 * DAY_MS).toISOString(),
      recommendation:
        'Queue length peaks Friday-Saturday 7-9pm (avg 6 parties waiting). Consider opening a reservation window for that slot to smooth demand.',
      confidence: 82,
      expected_revenue_impact: 12000,
      implemented: false,
      implemented_at: null,
    },
    {
      restaurant_id: restaurant.id,
      timestamp: new Date(now.getTime() - 10 * DAY_MS).toISOString(),
      recommendation:
        'Dessert attach rate is 22% lower on weekday lunches than dinner. Try a lunch-only dessert combo offer.',
      confidence: 68,
      expected_revenue_impact: 5200,
      implemented: false,
      implemented_at: null,
    },
    {
      restaurant_id: restaurant.id,
      timestamp: new Date(now.getTime() - 20 * DAY_MS).toISOString(),
      recommendation:
        'Jazz music trial showed a statistically significant +65 AOV lift. Roll out jazz as the standing 7-9pm playlist.',
      confidence: 87,
      expected_revenue_impact: 8400,
      implemented: true,
      implemented_at: new Date(now.getTime() - 18 * DAY_MS).toISOString(),
    },
    {
      restaurant_id: restaurant.id,
      timestamp: new Date(now.getTime() - 35 * DAY_MS).toISOString(),
      recommendation:
        'Staff count drops to 5 during the Friday dinner rush while occupancy exceeds 85%. Add one server for that shift.',
      confidence: 74,
      expected_revenue_impact: 6000,
      implemented: true,
      implemented_at: new Date(now.getTime() - 30 * DAY_MS).toISOString(),
    },
  ])

  console.log('\nDemo seed complete.')
  console.log(`  Restaurant: ${restaurant.name} (${restaurant.id})`)
  console.log(`  Sign in:    ${DEMO_EMAIL} / ${DEMO_PASSWORD}`)
  console.log('  This account is read-only - all writes are blocked by RLS (is_demo = true).')
}

seed().catch((err) => {
  console.error('Demo seed failed:', err)
  process.exit(1)
})

#!/usr/bin/env tsx
// The spec's own Definition of Done: three synthetic venues run end to
// end through the real pipeline - ingest (raw CSV text, through the
// actual generic mapper) -> profile -> analyze -> report. This is the
// acceptance test, not a demo in the marketing sense.
//
// What this DOES exercise for real: lib/csv-ingest.ts (CSV parsing,
// column mapping, PII scrub), lib/data-quality.ts (the profiler),
// lib/analysis.ts (all three modules, capability-gated), lib/report.ts
// (headline selection / no-leak-found path) - the actual logic, not a
// re-implementation of it.
//
// What this does NOT exercise: the Supabase persistence layer and HTTP
// routes (app/api/ingest, app/api/reports) - that needs a live Supabase
// project with supabase/migrations/001_initial_schema.sql applied, which
// this sandbox doesn't have credentials for. Cross-tenant RLS was
// already proven for real against this exact schema, with real per-role
// Postgres sessions (not just read over), during Step 1 - see that
// session's verification notes; not re-duplicated here since it doesn't
// depend on anything built since.

import Papa from 'papaparse'
import { ingestRows, type ColumnMapping } from '../lib/csv-ingest'
import { computeDataQualityProfile, type BillForProfile, type ItemForProfile } from '../lib/data-quality'
import {
  computeAttachRateLeak,
  computeMenuMixLeak,
  computeTurnoverDwellLeak,
  type BillForAnalysis,
  type ItemForAnalysis,
  type DishCostForAnalysis,
} from '../lib/analysis'
import { buildReportContent } from '../lib/report'

const MAPPING: ColumnMapping = {
  external_bill_id: 'Bill No',
  opened_at: 'Order Time',
  settled_at: 'Closed Time',
  table_ref: 'Table',
  gross: 'Bill Total',
  item_name_raw: 'Item',
  category: 'Category',
  qty: 'Qty',
  price: 'Rate',
  payment_type: 'Payment Mode',
}

let failures = 0
function check(condition: boolean, message: string) {
  if (condition) {
    console.log(`  OK: ${message}`)
  } else {
    console.error(`  FAIL: ${message}`)
    failures++
  }
}

function csvRow(fields: Record<string, string>): Record<string, string> {
  return fields
}

function toCsvText(rows: Record<string, string>[]): string {
  return Papa.unparse(rows)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
function dt(day: number, hour: number, minute: number): string {
  // Plain local-looking timestamp string, as a real POS export would have
  // it (no timezone marker) - Date() parses this as local time, which is
  // exactly the ambiguity real CSV exports have. Using 'UTC' as the
  // venue timezone downstream keeps this test deterministic regardless
  // of the machine running it.
  return `2026-02-${pad(day + 1)} ${pad(hour)}:${pad(minute)}:00`
}

function runPipeline(bills: BillForProfile[] & BillForAnalysis[], items: (ItemForProfile & ItemForAnalysis)[], dishCosts: DishCostForAnalysis[]) {
  const profile = computeDataQualityProfile(bills, items)
  const mask = profile.capability_mask

  const attachRate = mask.attach_rate.allowed ? computeAttachRateLeak(bills, items, 'UTC') : null
  const menuMix = mask.menu_mix.allowed ? computeMenuMixLeak(items, dishCosts, profile.history_depth_days ?? 0) : null
  const turnoverDwell = mask.turnover_dwell.allowed ? computeTurnoverDwellLeak(bills, 'UTC') : null

  const content = buildReportContent(mask, { attach_rate: attachRate, menu_mix: menuMix, turnover_dwell: turnoverDwell })
  return { profile, content }
}

// ============================================================
// VENUE 1: normal, live-timestamp venue with a planted attach-rate leak
// of a known ground-truth size. Ground truth is computed analytically
// from the same generation parameters, independently of the pipeline.
// ============================================================
console.log('\n=== Venue 1: normal venue, planted attach-rate leak ===')
{
  const rows: Record<string, string>[] = []
  let lowCount = 0
  let lowDessertCount = 0
  const dessertPrice = 250
  // Real per-bill records for an honest, independent ground-truth
  // calculation below (mirroring the module's own tercile-band
  // methodology on the real generated numbers, rather than a naive
  // whole-group approximation that ignores tercile "mid-band" spillover
  // at the low/high boundary - a first version of this test's ground
  // truth landed outside +/-25% for exactly that reason).
  const groundTruthRows: { gross: number; hasDessert: boolean }[] = []

  for (let day = 0; day < 30; day++) {
    // 4/day (not 3) so combined with the 4 high-spend bills below, this
    // venue clears the 50 bills/week report floor (8/day x 30d = 240
    // total = 56/week) - the first version of this test used 3+3/day
    // (42/week), which fell below the floor and suppressed every module
    // including the one this venue is supposed to demonstrate. That's
    // this test correctly proving the floor works, not a module bug.
    for (let i = 0; i < 4; i++) {
      const gross = 350 + ((day * 37 + i * 13) % 100)
      const opened = dt(day, 19, i * 10)
      const hasDessert = i === 0 && day % 10 === 0
      // 'Bill Total' is mapped to gross explicitly (see MAPPING) so the
      // bill total is independent of which items are on it - a bill's
      // spend-band is never partly caused by its own dessert order.
      rows.push(csvRow({
        'Bill No': `L-${day}-${i}`, 'Customer Name': 'Rohan Sharma', 'Phone': '9876543210',
        'Order Time': opened, 'Closed Time': '', 'Table': `T${i}`, 'Bill Total': String(gross),
        'Item': 'Main', 'Category': 'Mains', 'Qty': '1', 'Rate': String(gross), 'Payment Mode': 'UPI',
      }))
      lowCount++
      groundTruthRows.push({ gross, hasDessert })
      if (hasDessert) {
        rows.push(csvRow({
          'Bill No': `L-${day}-${i}`, 'Customer Name': 'Rohan Sharma', 'Phone': '9876543210',
          'Order Time': opened, 'Closed Time': '', 'Table': `T${i}`, 'Bill Total': String(gross),
          'Item': 'Tiramisu', 'Category': 'Dessert', 'Qty': '1', 'Rate': String(dessertPrice), 'Payment Mode': 'UPI',
        }))
        lowDessertCount++
      }
    }
    for (let i = 0; i < 4; i++) {
      const gross = 1500 + ((day * 41 + i * 17) % 200)
      const opened = dt(day, 20, i * 10)
      const hasDessert = i < 3
      rows.push(csvRow({
        'Bill No': `H-${day}-${i}`, 'Customer Name': 'Priya Nair', 'Phone': '9123456780',
        'Order Time': opened, 'Closed Time': '', 'Table': `T${i + 10}`, 'Bill Total': String(gross),
        'Item': 'Main', 'Category': 'Mains', 'Qty': '2', 'Rate': String(gross / 2), 'Payment Mode': 'Card',
      }))
      groundTruthRows.push({ gross, hasDessert })
      if (hasDessert) {
        rows.push(csvRow({
          'Bill No': `H-${day}-${i}`, 'Customer Name': 'Priya Nair', 'Phone': '9123456780',
          'Order Time': opened, 'Closed Time': '', 'Table': `T${i + 10}`, 'Bill Total': String(gross),
          'Item': 'Tiramisu', 'Category': 'Dessert', 'Qty': '1', 'Rate': String(dessertPrice), 'Payment Mode': 'Card',
        }))
      }
    }
  }

  const csvText = toCsvText(rows)
  const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true })
  const ingestResult = ingestRows(parsed.data, MAPPING)

  const serializedBills = JSON.stringify(ingestResult.bills)
  check(!serializedBills.includes('Rohan Sharma') && !serializedBills.includes('9876543210'), 'PII (name/phone) does not reach ingest output')
  check(ingestResult.rowsRejected === 0, `no rows rejected (got ${ingestResult.rowsRejected})`)

  const bills: (BillForProfile & BillForAnalysis)[] = ingestResult.bills.map((b) => ({
    opened_at: b.opened_at, settled_at: b.settled_at, table_ref: b.table_ref, gross: b.gross,
  }))
  const items: (ItemForProfile & ItemForAnalysis)[] = []
  ingestResult.bills.forEach((b, bi) => {
    b.items.forEach((it) => items.push({
      bill_index: bi, item_name_raw: it.item_name_raw, item_name_norm: it.item_name_raw.toLowerCase(),
      category: it.category, qty: it.qty, price: it.price,
    }))
  })

  const { profile, content } = runPipeline(bills, items, [])
  check(profile.timestamps_live === null, 'no settled_at data recorded (as generated) -> timestamps_live is null, not guessed')
  check(content.headline !== null, 'a headline finding was found')
  check(content.headline?.rule === 'attach_rate', `headline rule is attach_rate (got ${content.headline?.rule})`)

  // Ground truth: an honest, INDEPENDENT replication of the module's own
  // tercile-band methodology (same well-defined approach - split into
  // thirds by gross, compare the two extreme bands - applied here to the
  // real generated numbers directly, never calling into lib/analysis.ts).
  // A naive "compare the whole low-designed group to the whole
  // high-designed group" approximation ignores that ~1/3 of each group's
  // edge bills land in the 'mid' tercile rather than 'low'/'high' - this
  // computes the gap over the SAME segment definition the module actually
  // uses, so the comparison is apples to apples.
  const sortedGT = [...groundTruthRows.map((r) => r.gross)].sort((a, b) => a - b)
  const lowCutGT = sortedGT[Math.floor(sortedGT.length / 3)]
  const highCutGT = sortedGT[Math.floor((2 * sortedGT.length) / 3)]
  const lowBandGT = groundTruthRows.filter((r) => r.gross <= lowCutGT)
  const highBandGT = groundTruthRows.filter((r) => r.gross > highCutGT)
  const lowRate = lowBandGT.filter((r) => r.hasDessert).length / lowBandGT.length
  const highRate = highBandGT.filter((r) => r.hasDessert).length / highBandGT.length
  const gap = highRate - lowRate
  const coversPerMonth = (lowBandGT.length / 30) * 30
  const groundTruth = Math.round(gap * coversPerMonth * dessertPrice)

  if (content.headline) {
    const actual = content.headline.size_inr_month
    const withinTolerance = Math.abs(actual - groundTruth) / groundTruth <= 0.25
    check(withinTolerance, `planted leak sized within +/-25% of ground truth (ground truth Rs.${groundTruth}/mo, got Rs.${actual}/mo)`)
  }
}

// ============================================================
// VENUE 2: batch-settled venue - bills open through the evening but all
// settle in a tight window at closing.
// ============================================================
console.log('\n=== Venue 2: batch-settled venue ===')
{
  const rows: Record<string, string>[] = []
  for (let day = 0; day < 20; day++) {
    for (let i = 0; i < 10; i++) {
      const openHour = 19 + Math.floor(i / 3)
      const opened = dt(day, openHour, (i % 3) * 20)
      const settled = dt(day, 23, i) // all settle 23:00-23:09, regardless of when they opened
      rows.push(csvRow({
        'Bill No': `B-${day}-${i}`, 'Customer Name': 'Anon', 'Phone': '',
        'Order Time': opened, 'Closed Time': settled, 'Table': `T${i % 8}`,
        'Item': 'Main', 'Category': 'Mains', 'Qty': '1', 'Rate': '400', 'Payment Mode': 'Cash',
      }))
    }
  }
  const csvText = toCsvText(rows)
  const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true })
  const ingestResult = ingestRows(parsed.data, MAPPING)

  const bills: (BillForProfile & BillForAnalysis)[] = ingestResult.bills.map((b) => ({
    opened_at: b.opened_at, settled_at: b.settled_at, table_ref: b.table_ref, gross: b.gross,
  }))
  const items: (ItemForProfile & ItemForAnalysis)[] = []
  ingestResult.bills.forEach((b, bi) => b.items.forEach((it) => items.push({
    bill_index: bi, item_name_raw: it.item_name_raw, item_name_norm: it.item_name_raw.toLowerCase(),
    category: it.category, qty: it.qty, price: it.price,
  })))

  const { profile, content } = runPipeline(bills, items, [])
  check(profile.timestamps_live === false, `batch settlement detected (timestamps_live === false, got ${profile.timestamps_live})`)
  const turnoverEntry = content.checked.find((c) => c.rule === 'turnover_dwell')
  check(turnoverEntry?.status === 'suppressed', `turnover_dwell suppressed (got ${turnoverEntry?.status})`)
  check(
    turnoverEntry?.reason === 'Table-time analysis not possible: bills are entered together at closing, so individual table timings aren\'t real.',
    'suppression reason is the exact owner-readable sentence from the spec'
  )
}

// ============================================================
// VENUE 3: clean venue, no planted leak - "no leak found" must fire.
// ============================================================
console.log('\n=== Venue 3: clean venue, no planted leak ===')
{
  // A murmur3-style avalanche mix, so two values derived from the same
  // (day, i) pair are NOT correlated - the first version of this venue
  // computed both `gross` and `hasDessert` from simple modular arithmetic
  // sharing the variable `i` (e.g. i*3 and i%3), which silently produces
  // real structural correlation (0% vs 91.6% attach rate - not noise).
  // That's exactly the kind of accidental confound the analysis modules
  // are supposed to detect, so the test data has to genuinely not have
  // one for this venue to prove the "no leak found" path.
  function mix(seed: number): number {
    let x = seed | 0
    x = Math.imul(x ^ (x >>> 16), 2246822507)
    x = Math.imul(x ^ (x >>> 13), 3266489909)
    x = (x ^ (x >>> 16)) >>> 0
    return x
  }

  const rows: Record<string, string>[] = []
  for (let day = 0; day < 30; day++) {
    for (let i = 0; i < 60; i++) {
      const seed = day * 1000 + i
      const hour = 12 + (mix(seed) % 10)
      const gross = 400 + (mix(seed * 3 + 1) % 800) // independent draw, continuous spread
      const openMinute = mix(seed * 7 + 2) % 60
      const opened = dt(day, hour, openMinute)
      const settled = dt(day, hour, Math.min(59, openMinute + 40))
      const hasDessert = mix(seed * 13 + 3) % 3 === 0 // independent draw, same ~33% rate everywhere
      rows.push(csvRow({
        'Bill No': `C-${day}-${i}`, 'Customer Name': 'Anon', 'Phone': '',
        'Order Time': opened, 'Closed Time': settled, 'Table': `T${i % 12}`,
        'Item': 'Main', 'Category': 'Mains', 'Qty': '1', 'Rate': String(gross), 'Payment Mode': 'UPI',
      }))
      if (hasDessert) {
        rows.push(csvRow({
          'Bill No': `C-${day}-${i}`, 'Customer Name': 'Anon', 'Phone': '',
          'Order Time': opened, 'Closed Time': settled, 'Table': `T${i % 12}`,
          'Item': 'Tiramisu', 'Category': 'Dessert', 'Qty': '1', 'Rate': '250', 'Payment Mode': 'UPI',
        }))
      }
    }
  }
  const csvText = toCsvText(rows)
  const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true })
  const ingestResult = ingestRows(parsed.data, MAPPING)

  const bills: (BillForProfile & BillForAnalysis)[] = ingestResult.bills.map((b) => ({
    opened_at: b.opened_at, settled_at: b.settled_at, table_ref: b.table_ref, gross: b.gross,
  }))
  const items: (ItemForProfile & ItemForAnalysis)[] = []
  ingestResult.bills.forEach((b, bi) => b.items.forEach((it) => items.push({
    bill_index: bi, item_name_raw: it.item_name_raw, item_name_norm: it.item_name_raw.toLowerCase(),
    category: it.category, qty: it.qty, price: it.price,
  })))

  // No dish_costs recorded for this venue either - menu_mix should be
  // insufficient_data, not a fabricated finding.
  const { content } = runPipeline(bills, items, [])
  check(content.headline === null, `"no leak found" fires - headline is null (got ${JSON.stringify(content.headline)})`)
  check(
    content.checked.every((c) => c.status !== 'candidate'),
    'no module produced a candidate finding for the clean venue'
  )
}

console.log(failures === 0 ? '\nAll three synthetic venues passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)

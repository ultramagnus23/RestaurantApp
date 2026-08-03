#!/usr/bin/env tsx
// Proves the data quality profiler tells live vs. batch-settled billing
// apart correctly, and that the report-level floor genuinely suppresses
// everything below it - the spec's own acceptance criteria for this
// module, run directly rather than assumed from reading the code.

import { computeDataQualityProfile, MIN_HISTORY_DAYS, MIN_WEEKLY_VOLUME, type BillForProfile } from '../lib/data-quality'

function fail(message: string): never {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

function iso(day: number, hour: number, minute: number): string {
  const d = new Date(Date.UTC(2026, 0, 1 + day, hour, minute, 0))
  return d.toISOString()
}

// --- Venue A: live billing, plenty of volume/history. Each bill settles
// 45-90 minutes after it opens, spread through the evening. ---
const liveBills: BillForProfile[] = []
for (let day = 0; day < 20; day++) {
  for (let i = 0; i < 10; i++) {
    const openHour = 19 + Math.floor(i / 3)
    const openMinute = (i % 3) * 20
    const dwellMinutes = 45 + i * 4
    const opened = iso(day, openHour, openMinute)
    const openedDate = new Date(opened)
    const settled = new Date(openedDate.getTime() + dwellMinutes * 60_000).toISOString()
    liveBills.push({ opened_at: opened, settled_at: settled, table_ref: `T${(i % 8) + 1}` })
  }
}
const liveProfile = computeDataQualityProfile(liveBills, [])
if (liveProfile.timestamps_live !== true) {
  fail(`live venue: expected timestamps_live=true, got ${liveProfile.timestamps_live}. Evidence: ${JSON.stringify(liveProfile.timestamps_evidence)}`)
}
if (!liveProfile.capability_mask.turnover_dwell.allowed) {
  fail(`live venue: expected turnover_dwell allowed, got suppressed: ${liveProfile.capability_mask.turnover_dwell.reason}`)
}
console.log(`PASS: live venue detected correctly (${liveBills.length} bills, ${liveProfile.history_depth_days}d, ${liveProfile.weekly_volume}/wk)`)

// --- Venue B: batch-settled. Bills open throughout the evening (spread
// over ~3 hours) but all settle within a 10-minute window at closing -
// the exact real-world pattern the spec describes. ---
const batchBills: BillForProfile[] = []
for (let day = 0; day < 20; day++) {
  for (let i = 0; i < 10; i++) {
    const openHour = 19 + Math.floor(i / 3) // spreads opened_at over ~3 hours
    const openMinute = (i % 3) * 20
    const opened = iso(day, openHour, openMinute)
    const settled = iso(day, 23, i) // all settle between 23:00 and 23:09
    batchBills.push({ opened_at: opened, settled_at: settled, table_ref: `T${(i % 8) + 1}` })
  }
}
const batchProfile = computeDataQualityProfile(batchBills, [])
if (batchProfile.timestamps_live !== false) {
  fail(`batch venue: expected timestamps_live=false, got ${batchProfile.timestamps_live}. Evidence: ${JSON.stringify(batchProfile.timestamps_evidence)}`)
}
if (batchProfile.capability_mask.turnover_dwell.allowed) {
  fail('batch venue: expected turnover_dwell suppressed, but it was allowed')
}
const expectedSentence = 'Table-time analysis not possible: bills are entered together at closing, so individual table timings aren\'t real.'
if (batchProfile.capability_mask.turnover_dwell.reason !== expectedSentence) {
  fail(`batch venue: suppression reason doesn't match the spec's exact wording. Got: "${batchProfile.capability_mask.turnover_dwell.reason}"`)
}
console.log('PASS: batch-settled venue detected correctly, turnover_dwell suppressed with the spec\'s exact sentence')

// --- Venue C: clean data quality-wise, but too little volume/history -
// the report-level floor must suppress everything, not just some modules. ---
const thinBills: BillForProfile[] = []
for (let day = 0; day < 5; day++) {
  for (let i = 0; i < 3; i++) {
    const opened = iso(day, 19 + i, 0)
    const settled = iso(day, 19 + i, 50)
    thinBills.push({ opened_at: opened, settled_at: settled, table_ref: `T${i + 1}` })
  }
}
const thinProfile = computeDataQualityProfile(thinBills, [])
if (thinProfile.capability_mask.attach_rate.allowed || thinProfile.capability_mask.menu_mix.allowed || thinProfile.capability_mask.turnover_dwell.allowed) {
  fail(`thin venue: expected every module suppressed by the report floor (${MIN_HISTORY_DAYS}d/${MIN_WEEKLY_VOLUME} per wk), got: ${JSON.stringify(thinProfile.capability_mask)}`)
}
console.log(`PASS: thin venue (${thinProfile.history_depth_days}d, ${thinProfile.weekly_volume}/wk) suppresses every module via the report floor`)

// --- Item name consistency: near-duplicate names should be flagged. ---
const itemsWithDupes = [
  { item_name_norm: 'butter chicken' },
  { item_name_norm: 'butter chicke' }, // 1-char typo of the above
  { item_name_norm: 'masala chai' },
  { item_name_norm: 'tiramisu' },
]
const consistency = computeDataQualityProfile([], itemsWithDupes).item_name_consistency_pct
if (consistency === null || consistency >= 100) {
  fail(`expected item_name_consistency_pct to reflect the planted near-duplicate, got ${consistency}`)
}
console.log(`PASS: near-duplicate item names lower consistency score (${consistency}%)`)

console.log('\nAll data quality profiler checks passed.')

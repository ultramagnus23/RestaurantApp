#!/usr/bin/env tsx
// Proves the report orchestration: picks the single highest-size headline
// among candidates, records suppressed modules with their mask reason
// without ever running them, and - the spec's own required, tested path -
// genuinely says "no leak found" when nothing clears the floor, rather
// than defaulting to some number.

import { buildReportContent, recommendedAction } from '../lib/report'
import type { LeakFinding } from '../lib/analysis'
import type { CapabilityMask } from '../lib/data-quality'

function fail(message: string): never {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

function makeFinding(rule: LeakFinding['rule'], size: number): LeakFinding {
  return {
    rule,
    scope: `test scope for ${rule}`,
    size_inr_month: size,
    confidence: 80,
    evidence: rule === 'attach_rate' ? { category: 'dessert', daypart: 'dinner', underperforming_band: 'low' }
      : rule === 'menu_mix' ? { dish: 'Test Dish' }
      : { hour: 20 },
    status: 'candidate',
  }
}

const allAllowed: CapabilityMask = {
  attach_rate: { allowed: true, reason: null },
  menu_mix: { allowed: true, reason: null },
  turnover_dwell: { allowed: true, reason: null },
}

// --- Headline picks the LARGEST candidate, not the first one checked. ---
const content1 = buildReportContent(allAllowed, {
  attach_rate: makeFinding('attach_rate', 5000),
  menu_mix: makeFinding('menu_mix', 20000),
  turnover_dwell: makeFinding('turnover_dwell', 8000),
})
if (content1.headline?.rule !== 'menu_mix' || content1.headline.size_inr_month !== 20000) {
  fail(`expected menu_mix (Rs.20000) as the headline, got ${content1.headline?.rule} (Rs.${content1.headline?.size_inr_month})`)
}
if (!content1.recommended_action?.includes('Test Dish')) {
  fail(`expected the recommended action to reference the headline finding, got: ${content1.recommended_action}`)
}
console.log(`PASS: headline picks the largest candidate (${content1.headline.rule}, Rs.${content1.headline.size_inr_month}/month)`)

// --- "No leak found" - THE required path: nothing clears the floor, and
// the headline must be genuinely null, not a zero or a guess. ---
const content2 = buildReportContent(allAllowed, {
  attach_rate: { status: 'insufficient_data', reason: 'not enough segments' },
  menu_mix: { status: 'insufficient_data', reason: 'no dish costs' },
  turnover_dwell: { status: 'insufficient_data', reason: 'no dwell data' },
})
if (content2.headline !== null) {
  fail(`expected headline to be null (no leak found), got a finding: ${JSON.stringify(content2.headline)}`)
}
if (content2.recommended_action !== null) {
  fail(`expected no recommended action when there's no headline, got: ${content2.recommended_action}`)
}
if (content2.checked.some((c) => c.status === 'candidate')) {
  fail('expected zero candidates in the "no leak found" case')
}
console.log('PASS: "no leak found" path fires correctly when nothing clears the floor - headline is null, not zero')

// --- Suppressed modules are recorded with the mask's reason, never run. ---
const gatedMask: CapabilityMask = {
  attach_rate: { allowed: true, reason: null },
  menu_mix: { allowed: true, reason: null },
  turnover_dwell: { allowed: false, reason: 'Table-time analysis not possible: bills are entered together at closing, so individual table timings aren\'t real.' },
}
const content3 = buildReportContent(gatedMask, {
  attach_rate: makeFinding('attach_rate', 3000),
  menu_mix: { status: 'insufficient_data', reason: 'no dish costs' },
  turnover_dwell: null,
})
const turnoverEntry = content3.checked.find((c) => c.rule === 'turnover_dwell')
if (turnoverEntry?.status !== 'suppressed' || !turnoverEntry.reason?.includes('entered together at closing')) {
  fail(`expected turnover_dwell recorded as suppressed with the mask's exact reason, got: ${JSON.stringify(turnoverEntry)}`)
}
console.log('PASS: gated module recorded as suppressed with the capability mask\'s own reason, never invoked')

console.log('\nAll report orchestration checks passed.')

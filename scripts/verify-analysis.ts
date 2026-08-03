#!/usr/bin/env tsx
// Proves each analysis module finds a planted leak of roughly the right
// size, and correctly returns insufficient_data rather than a number
// when a module's floor isn't cleared - never a fabricated finding.

import {
  computeAttachRateLeak,
  computeMenuMixLeak,
  computeTurnoverDwellLeak,
  type BillForAnalysis,
  type ItemForAnalysis,
  type DishCostForAnalysis,
} from '../lib/analysis'

function fail(message: string): never {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

function iso(day: number, hour: number, minute: number): string {
  return new Date(Date.UTC(2026, 0, 1 + day, hour, minute, 0)).toISOString()
}

// ============================================================
// Attach-rate: plant a real gap between low-spend and high-spend dinner
// bills' dessert attach rate, and confirm it's found and roughly sized.
// ============================================================
const bills: BillForAnalysis[] = []
const items: ItemForAnalysis[] = []
let billIdx = 0

for (let day = 0; day < 30; day++) {
  // 3 low-spend dinner bills/day, gross jittered 350-450: ~10% dessert attach
  for (let i = 0; i < 3; i++) {
    const gross = 350 + ((day * 37 + i * 13) % 100)
    bills.push({ opened_at: iso(day, 19, i * 10), settled_at: null, table_ref: `T${i}`, gross })
    const hasDessert = i === 0 && day % 10 === 0 // ~10% attach
    items.push({ bill_index: billIdx, item_name_raw: 'Main', item_name_norm: 'main', category: 'Mains', qty: 1, price: gross })
    if (hasDessert) {
      items.push({ bill_index: billIdx, item_name_raw: 'Tiramisu', item_name_norm: 'tiramisu', category: 'Dessert', qty: 1, price: 250 })
    }
    billIdx++
  }
  // 3 high-spend dinner bills/day, gross jittered 1500-1700: 60%+ dessert attach (the reference band)
  for (let i = 0; i < 3; i++) {
    const gross = 1500 + ((day * 41 + i * 17) % 200)
    bills.push({ opened_at: iso(day, 20, i * 10), settled_at: null, table_ref: `T${i + 10}`, gross })
    items.push({ bill_index: billIdx, item_name_raw: 'Main', item_name_norm: 'main', category: 'Mains', qty: 2, price: gross / 2 })
    const hasDessert = i < 2 // 2/3 = ~67% attach, comfortably a real gap
    if (hasDessert) {
      items.push({ bill_index: billIdx, item_name_raw: 'Tiramisu', item_name_norm: 'tiramisu', category: 'Dessert', qty: 1, price: 250 })
    }
    billIdx++
  }
}

const attachResult = computeAttachRateLeak(bills, items, 'UTC')
if (attachResult.status !== 'candidate') {
  fail(`attach-rate: expected a candidate finding, got insufficient_data: ${(attachResult as any).reason}`)
}
if (attachResult.rule !== 'attach_rate' || attachResult.evidence.category !== 'dessert') {
  fail(`attach-rate: expected a dessert attach-rate finding, got: ${JSON.stringify(attachResult.evidence)}`)
}
if (attachResult.size_inr_month <= 0) {
  fail(`attach-rate: expected a positive size, got ${attachResult.size_inr_month}`)
}
console.log(`PASS: attach-rate leak found - ${attachResult.scope}, Rs.${attachResult.size_inr_month}/month`)
console.log(`  ${attachResult.evidence.arithmetic}`)

// Insufficient data: too few bills overall.
const tinyAttach = computeAttachRateLeak(bills.slice(0, 10), items.filter((i) => i.bill_index < 10), 'UTC')
if (tinyAttach.status !== 'insufficient_data') {
  fail('attach-rate: expected insufficient_data with too few bills, got a candidate finding')
}
console.log('PASS: attach-rate correctly returns insufficient_data below the sample floor')

// ============================================================
// Menu-mix: plant a high-velocity, low-margin "plowhorse" dish.
// ============================================================
const dishCosts: DishCostForAnalysis[] = [
  { item: 'Butter Chicken', cost: 380, price: 480 }, // low margin (100), plant as plowhorse via high velocity below
  { item: 'Truffle Fries', cost: 60, price: 220 }, // high margin (160), low velocity
  { item: 'Masala Chai', cost: 20, price: 90 }, // high margin (70), high velocity -> Star, not a plowhorse
  { item: 'Caesar Salad', cost: 150, price: 280 }, // mid margin (130), mid velocity
]
const menuItems: ItemForAnalysis[] = []
let mi = 0
for (let day = 0; day < 30; day++) {
  for (let i = 0; i < 8; i++) {
    menuItems.push({ bill_index: mi++, item_name_raw: 'Butter Chicken', item_name_norm: 'butter chicken', category: 'Mains', qty: 1, price: 480 }) // high velocity, low margin
  }
  for (let i = 0; i < 6; i++) {
    menuItems.push({ bill_index: mi++, item_name_raw: 'Masala Chai', item_name_norm: 'masala chai', category: 'Drink', qty: 1, price: 90 }) // high velocity, high margin
  }
  for (let i = 0; i < 1; i++) {
    menuItems.push({ bill_index: mi++, item_name_raw: 'Truffle Fries', item_name_norm: 'truffle fries', category: 'Sides', qty: 1, price: 220 }) // low velocity, high margin
  }
  for (let i = 0; i < 2; i++) {
    menuItems.push({ bill_index: mi++, item_name_raw: 'Caesar Salad', item_name_norm: 'caesar salad', category: 'Sides', qty: 1, price: 280 })
  }
}

const menuResult = computeMenuMixLeak(menuItems, dishCosts, 30)
if (menuResult.status !== 'candidate') {
  fail(`menu-mix: expected a candidate finding, got insufficient_data: ${(menuResult as any).reason}`)
}
if (!menuResult.scope.includes('Butter Chicken')) {
  fail(`menu-mix: expected Butter Chicken (the planted plowhorse) as the target, got scope: ${menuResult.scope}`)
}
console.log(`PASS: menu-mix leak found - ${menuResult.scope}, Rs.${menuResult.size_inr_month}/month`)
console.log(`  ${menuResult.evidence.assumption}`)

const noDishCosts = computeMenuMixLeak(menuItems, [], 30)
if (noDishCosts.status !== 'insufficient_data') {
  fail('menu-mix: expected insufficient_data with zero dish costs recorded')
}
console.log('PASS: menu-mix correctly returns insufficient_data with no dish costs recorded')

// ============================================================
// Turnover/dwell: plant a slow peak hour vs. the venue's typical dwell.
// ============================================================
const dwellBills: BillForAnalysis[] = []
for (let day = 0; day < 30; day++) {
  // Typical bills: ~45 min dwell, spread across every service hour
  // (including 20:00) - this is the majority pattern, so it anchors the
  // venue-wide median at ~45min.
  for (let hour = 18; hour <= 22; hour++) {
    for (let i = 0; i < 10; i++) {
      const opened = iso(day, hour, (i * 6) % 60)
      const settled = new Date(new Date(opened).getTime() + 45 * 60_000).toISOString()
      dwellBills.push({ opened_at: opened, settled_at: settled, table_ref: `T${i % 8}`, gross: 500 })
    }
  }
  // On top of that, 20:00 ALSO gets a batch of extra slow bills (~80min) -
  // a minority overall, but enough to pull 20:00's own median well above
  // the venue-wide one.
  for (let i = 0; i < 20; i++) {
    const opened = iso(day, 20, 30 + (i % 30))
    const settled = new Date(new Date(opened).getTime() + 80 * 60_000).toISOString()
    dwellBills.push({ opened_at: opened, settled_at: settled, table_ref: `T${i % 8}`, gross: 600 })
  }
}

const turnoverResult = computeTurnoverDwellLeak(dwellBills, 'UTC')
if (turnoverResult.status !== 'candidate') {
  fail(`turnover-dwell: expected a candidate finding, got insufficient_data: ${(turnoverResult as any).reason}`)
}
if (turnoverResult.evidence.hour !== 20) {
  fail(`turnover-dwell: expected the planted slow hour (20:00), got hour ${turnoverResult.evidence.hour}`)
}
console.log(`PASS: turnover/dwell leak found - ${turnoverResult.scope}, Rs.${turnoverResult.size_inr_month}/month`)
console.log(`  ${turnoverResult.evidence.arithmetic}`)

const noDwellData = computeTurnoverDwellLeak(dwellBills.map((b) => ({ ...b, settled_at: null })), 'UTC')
if (noDwellData.status !== 'insufficient_data') {
  fail('turnover-dwell: expected insufficient_data with no settled_at data at all')
}
console.log('PASS: turnover/dwell correctly returns insufficient_data with no usable dwell data')

console.log('\nAll analysis module checks passed.')

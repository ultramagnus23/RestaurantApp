// The three analysis modules, and only these three (per the spec: "no
// more"). Each declares its own minimum sample size and returns
// 'insufficient_data' rather than a number below it - never a fabricated
// finding. All segment cuts (spend bands, dayparts) are venue-relative,
// computed from this venue's own distribution, never a hardcoded global
// constant.

export type BillForAnalysis = {
  opened_at: string
  settled_at: string | null
  table_ref: string | null
  gross: number
}

export type ItemForAnalysis = {
  bill_index: number // index into the bills array this item belongs to
  item_name_raw: string
  item_name_norm: string | null
  category: string | null
  qty: number
  price: number
}

export type DishCostForAnalysis = {
  item: string
  cost: number
  price: number
}

export type LeakFinding = {
  rule: 'attach_rate' | 'menu_mix' | 'turnover_dwell'
  scope: string
  size_inr_month: number
  confidence: number // 0-100, plain-language-adjacent (not a fabricated p-value)
  evidence: Record<string, unknown>
  // Always 'candidate' - a constructed LeakFinding is never the
  // insufficient-data case, which returns a separate, disjoint shape
  // instead (see each compute*Leak function's return type). Keeping this
  // a single-value literal, not a union with 'insufficient_data', is
  // what lets callers discriminate the two shapes cleanly.
  status: 'candidate'
}

const MIN_SEGMENT_N = 30
const MIN_GAP_PP = 0.10
const MIN_Z = 1.65
const MIN_DISH_UNITS = 10
const DAYS_PER_MONTH = 30
export const DEFAULT_TIMEZONE = 'Asia/Kolkata' // matches restaurants.timezone's own default

// Dayparts and peak-hour analysis are inherently about the venue's LOCAL
// clock time, not UTC or whatever timezone a server happens to run in.
// bills.opened_at/settled_at are stored as UTC ISO timestamps (correct
// for storage), so every place this module reads an "hour of day" must
// convert through the venue's own timezone explicitly - using the
// server's local getHours() here was a real bug caught by testing: it
// would silently misclassify every bill's daypart/hour depending on
// which timezone the server process happens to run in, exactly the kind
// of quiet timestamp corruption these tools are supposed to catch, not
// cause.
function localHour(iso: string, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' })
  return parseInt(formatter.format(new Date(iso)), 10)
}

function daypart(iso: string, timezone: string): 'lunch' | 'dinner' | 'other' {
  const hour = localHour(iso, timezone)
  if (hour >= 11 && hour < 16) return 'lunch'
  if (hour >= 18 && hour < 24) return 'dinner'
  return 'other'
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// Venue-relative spend bands: terciles of this venue's own gross
// distribution, not a fixed rupee cutoff that would mean something
// different at every venue.
function spendBand(gross: number, sortedGrosses: number[]): 'low' | 'mid' | 'high' {
  const n = sortedGrosses.length
  const lowCut = sortedGrosses[Math.floor(n / 3)]
  const highCut = sortedGrosses[Math.floor((2 * n) / 3)]
  if (gross <= lowCut) return 'low'
  if (gross <= highCut) return 'mid'
  return 'high'
}

function historyDays(bills: BillForAnalysis[]): number {
  if (bills.length === 0) return 0
  const times = bills.map((b) => new Date(b.opened_at).getTime())
  return Math.max(1, Math.round((Math.max(...times) - Math.min(...times)) / (1000 * 60 * 60 * 24)) + 1)
}

// One-sided two-proportion z-test: is p1 (reference) significantly
// higher than p2 (underperforming segment)? Real, checkable arithmetic -
// not a fabricated confidence number.
function twoProportionZ(x1: number, n1: number, x2: number, n2: number): number {
  const p1 = x1 / n1
  const p2 = x2 / n2
  const pooled = (x1 + x2) / (n1 + n2)
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2))
  if (se === 0) return 0
  return (p1 - p2) / se
}

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  dessert: ['dessert', 'sweet'],
  beverage: ['drink', 'beverage', 'bar', 'bev'],
  starter: ['starter', 'appetizer', 'appetiser', 'snack'],
}

function classifyCategory(raw: string | null): string | null {
  if (!raw) return null
  const v = raw.toLowerCase()
  for (const [group, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((k) => v.includes(k))) return group
  }
  return null
}

/**
 * Attach-rate leak: for each attach category (dessert/beverage/starter),
 * within each daypart, compares the venue's own spend bands against the
 * best-performing band in that same daypart. Sizing: gap x covers/month
 * x median category price.
 */
export function computeAttachRateLeak(
  bills: BillForAnalysis[],
  items: ItemForAnalysis[],
  timezone: string = DEFAULT_TIMEZONE
): LeakFinding | { status: 'insufficient_data'; reason: string } {
  if (bills.length < MIN_SEGMENT_N * 2) {
    return { status: 'insufficient_data', reason: `Needs at least ${MIN_SEGMENT_N * 2} bills to compare spend-band segments; has ${bills.length}.` }
  }

  const days = historyDays(bills)

  const billHasCategory = new Map<number, Set<string>>()
  for (const item of items) {
    const group = classifyCategory(item.category)
    if (!group) continue
    if (!billHasCategory.has(item.bill_index)) billHasCategory.set(item.bill_index, new Set())
    billHasCategory.get(item.bill_index)!.add(group)
  }

  const categoryPrices: Record<string, number[]> = {}
  for (const item of items) {
    const group = classifyCategory(item.category)
    if (!group) continue
    ;(categoryPrices[group] ??= []).push(item.price)
  }

  // Per-bill spend attributable to each category, so it can be excluded
  // from that category's own spend-band basis below. Without this, a
  // bill's gross (whether mapped from a bill-total column or, more
  // acutely, derived by summing item lines - see lib/csv-ingest.ts's
  // gross_source) mechanically includes the very item being tested for
  // attachment. That makes "having dessert" partly CAUSE "being
  // classified as higher spend," which is circular, not a real segment
  // difference - caught by this module producing an obviously spurious
  // 44.5-point gap on synthetic data specifically constructed to have no
  // real one (see scripts/demo.ts's Venue 3).
  const categorySpendByBill = new Map<number, Record<string, number>>()
  for (const item of items) {
    const group = classifyCategory(item.category)
    if (!group) continue
    if (!categorySpendByBill.has(item.bill_index)) categorySpendByBill.set(item.bill_index, {})
    const rec = categorySpendByBill.get(item.bill_index)!
    rec[group] = (rec[group] ?? 0) + item.qty * item.price
  }

  let best: LeakFinding | null = null

  for (const group of Object.keys(CATEGORY_KEYWORDS)) {
    if (!categoryPrices[group] || categoryPrices[group].length === 0) continue

    // Spend-band basis for THIS category: gross minus whatever this bill
    // spent on the category being tested. Recomputed per category since
    // the exclusion differs by group.
    const adjustedGross = bills.map((b, i) => b.gross - (categorySpendByBill.get(i)?.[group] ?? 0))
    const sortedAdjustedGrosses = [...adjustedGross].sort((a, b) => a - b)

    for (const dp of ['lunch', 'dinner'] as const) {
      const segmentBills = bills
        .map((b, i) => ({ bill: b, index: i }))
        .filter(({ bill }) => daypart(bill.opened_at, timezone) === dp)

      const byBand: Record<'low' | 'mid' | 'high', { n: number; attached: number }> = {
        low: { n: 0, attached: 0 },
        mid: { n: 0, attached: 0 },
        high: { n: 0, attached: 0 },
      }
      for (const { index } of segmentBills) {
        const band = spendBand(adjustedGross[index], sortedAdjustedGrosses)
        byBand[band].n += 1
        if (billHasCategory.get(index)?.has(group)) byBand[band].attached += 1
      }

      const bands = (['low', 'mid', 'high'] as const).filter((b) => byBand[b].n >= MIN_SEGMENT_N)
      if (bands.length < 2) continue

      const rates = bands.map((b) => ({ band: b, rate: byBand[b].attached / byBand[b].n, n: byBand[b].n, attached: byBand[b].attached }))
      const reference = rates.reduce((a, b) => (b.rate > a.rate ? b : a))

      for (const candidate of rates) {
        if (candidate.band === reference.band) continue
        const gap = reference.rate - candidate.rate
        if (gap < MIN_GAP_PP) continue
        const z = twoProportionZ(reference.attached, reference.n, candidate.attached, candidate.n)
        if (z < MIN_Z) continue

        const medianPrice = median(categoryPrices[group])
        const coversPerMonth = (candidate.n / days) * DAYS_PER_MONTH
        const sizeInrMonth = Math.round(gap * coversPerMonth * medianPrice)

        const finding: LeakFinding = {
          rule: 'attach_rate',
          scope: `${dp} / ${candidate.band}-spend bills, ${group} attach`,
          size_inr_month: sizeInrMonth,
          confidence: Math.min(99, Math.round((1 - 2 * (1 - normalCdf(z))) * 100)),
          evidence: {
            daypart: dp,
            category: group,
            reference_band: reference.band,
            reference_attach_rate_pct: Math.round(reference.rate * 1000) / 10,
            reference_n: reference.n,
            underperforming_band: candidate.band,
            underperforming_attach_rate_pct: Math.round(candidate.rate * 1000) / 10,
            underperforming_n: candidate.n,
            gap_pp: Math.round(gap * 1000) / 10,
            z_score: Math.round(z * 100) / 100,
            median_category_price: medianPrice,
            covers_per_month: Math.round(coversPerMonth),
            arithmetic: `${Math.round(gap * 1000) / 10}pp gap x ${Math.round(coversPerMonth)} covers/month x Rs.${medianPrice} median ${group} price = Rs.${sizeInrMonth}/month`,
          },
          status: 'candidate',
        }
        if (!best || finding.size_inr_month > best.size_inr_month) best = finding
      }
    }
  }

  return best ?? { status: 'insufficient_data', reason: 'No spend-band gap in any daypart cleared the significance/size floor.' }
}

// Standard normal CDF (Abramowitz & Stegun approximation) - used only to
// render a plain confidence percentage next to the z-score, not as a
// substitute for showing the z-score itself.
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989423 * Math.exp((-z * z) / 2)
  let prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  if (z > 0) prob = 1 - prob
  return 1 - prob
}

/**
 * Menu-mix leak: classic engineering quadrant (margin x velocity),
 * venue-relative medians as the quadrant cut lines, only over dishes
 * with cost data. Sizing is a stated-assumption price-shift scenario on
 * the highest-velocity Plowhorse (high velocity, low margin) dish.
 */
export function computeMenuMixLeak(
  items: ItemForAnalysis[],
  dishCosts: DishCostForAnalysis[],
  historyDepthDays: number
): LeakFinding | { status: 'insufficient_data'; reason: string } {
  if (dishCosts.length === 0) {
    return { status: 'insufficient_data', reason: 'No dish costs recorded yet - add at least a few dishes on the Dish Costs page.' }
  }
  if (historyDepthDays <= 0) {
    return { status: 'insufficient_data', reason: 'No bill history to compute dish velocity from.' }
  }

  const costByItem = new Map(dishCosts.map((d) => [d.item.trim().toLowerCase(), d]))
  const velocityByItem = new Map<string, number>()
  for (const item of items) {
    const key = (item.item_name_norm ?? item.item_name_raw.trim().toLowerCase())
    if (!costByItem.has(key)) continue
    velocityByItem.set(key, (velocityByItem.get(key) ?? 0) + item.qty)
  }

  const dishStats = Array.from(costByItem.entries())
    .map(([key, dish]) => ({
      item: dish.item,
      margin: dish.price - dish.cost,
      unitsSold: velocityByItem.get(key) ?? 0,
    }))
    .filter((d) => d.unitsSold >= MIN_DISH_UNITS)

  if (dishStats.length < 4) {
    return { status: 'insufficient_data', reason: `Only ${dishStats.length} dish(es) with cost data have at least ${MIN_DISH_UNITS} units sold - need more to compare a quadrant.` }
  }

  const medianMargin = median(dishStats.map((d) => d.margin))
  const medianVelocity = median(dishStats.map((d) => d.unitsSold))

  const plowhorses = dishStats.filter((d) => d.margin <= medianMargin && d.unitsSold > medianVelocity)
  if (plowhorses.length === 0) {
    return { status: 'insufficient_data', reason: 'No high-velocity, low-margin dish (a "plowhorse") found among the recorded dishes.' }
  }

  const target = plowhorses.reduce((a, b) => (b.unitsSold > a.unitsSold ? b : a))
  const unitsPerMonth = (target.unitsSold / historyDepthDays) * DAYS_PER_MONTH
  const ASSUMED_PRICE_INCREASE_PCT = 0.05
  const priceIncrease = costByItem.get(target.item.trim().toLowerCase())!.price * ASSUMED_PRICE_INCREASE_PCT
  const sizeInrMonth = Math.round(unitsPerMonth * priceIncrease)

  return {
    rule: 'menu_mix',
    scope: `"${target.item}" (high-velocity, below-median-margin dish)`,
    size_inr_month: sizeInrMonth,
    confidence: 60, // scenario-based, deliberately not dressed up as a statistical confidence
    evidence: {
      dish: target.item,
      current_margin: Math.round(target.margin * 100) / 100,
      median_margin_across_recorded_dishes: Math.round(medianMargin * 100) / 100,
      units_sold_observed: target.unitsSold,
      units_per_month: Math.round(unitsPerMonth),
      assumption: `Assumes a ${ASSUMED_PRICE_INCREASE_PCT * 100}% price increase with NO drop in volume - a scenario, not a prediction.`,
      arithmetic: `${Math.round(unitsPerMonth)} units/month x Rs.${Math.round(priceIncrease * 100) / 100} price increase = Rs.${sizeInrMonth}/month`,
    },
    status: 'candidate',
  }
}

/**
 * Turnover/dwell leak: gated by the caller on capability_mask.turnover_dwell
 * before this is even invoked. Finds the busiest hour whose median dwell
 * runs meaningfully longer than the venue's overall median, and sizes a
 * stated-assumption "if this hour matched the venue's typical dwell"
 * scenario.
 */
export function computeTurnoverDwellLeak(
  bills: BillForAnalysis[],
  timezone: string = DEFAULT_TIMEZONE
): LeakFinding | { status: 'insufficient_data'; reason: string } {
  const withDwell = bills
    .filter((b) => b.settled_at && b.table_ref)
    .map((b) => ({
      hour: localHour(b.opened_at, timezone),
      dwellMinutes: (new Date(b.settled_at!).getTime() - new Date(b.opened_at).getTime()) / 60_000,
      gross: b.gross,
    }))
    .filter((b) => b.dwellMinutes > 0 && b.dwellMinutes < 6 * 60) // guard against bad data (e.g. settled_at before opened_at, or >6h)

  if (withDwell.length < MIN_SEGMENT_N) {
    return { status: 'insufficient_data', reason: `Only ${withDwell.length} bills have usable dwell time; needs at least ${MIN_SEGMENT_N}.` }
  }

  const venueMedianDwell = median(withDwell.map((b) => b.dwellMinutes))
  const days = historyDays(bills)

  const byHour = new Map<number, typeof withDwell>()
  for (const b of withDwell) {
    if (!byHour.has(b.hour)) byHour.set(b.hour, [])
    byHour.get(b.hour)!.push(b)
  }

  let worst: { hour: number; n: number; medianDwell: number; medianGross: number } | null = null
  for (const [hour, group] of byHour) {
    if (group.length < 20) continue
    const hourMedianDwell = median(group.map((b) => b.dwellMinutes))
    if (hourMedianDwell - venueMedianDwell < 15) continue
    if (!worst || group.length > worst.n) {
      worst = { hour, n: group.length, medianDwell: hourMedianDwell, medianGross: median(group.map((b) => b.gross)) }
    }
  }

  if (!worst) {
    return { status: 'insufficient_data', reason: 'No hour runs meaningfully longer than the venue\'s typical dwell time.' }
  }

  const extraMinutes = worst.medianDwell - venueMedianDwell
  const billsPerMonthAtHour = (worst.n / days) * DAYS_PER_MONTH
  const potentialExtraTurns = (extraMinutes / venueMedianDwell) * billsPerMonthAtHour
  const sizeInrMonth = Math.round(potentialExtraTurns * worst.medianGross)

  return {
    rule: 'turnover_dwell',
    scope: `${worst.hour}:00-${worst.hour + 1}:00 (busiest slow hour)`,
    size_inr_month: sizeInrMonth,
    confidence: 55,
    evidence: {
      hour: worst.hour,
      bills_observed_this_hour: worst.n,
      median_dwell_this_hour_minutes: Math.round(worst.medianDwell),
      venue_median_dwell_minutes: Math.round(venueMedianDwell),
      extra_minutes: Math.round(extraMinutes),
      median_bill_gross_this_hour: worst.medianGross,
      assumption: 'Assumes freed dwell time converts proportionally into additional table-turns at this hour\'s typical bill size - a scenario, not a guarantee.',
      arithmetic: `(${Math.round(extraMinutes)} extra min / ${Math.round(venueMedianDwell)} min typical) x ${Math.round(billsPerMonthAtHour)} bills/month at this hour x Rs.${worst.medianGross} median bill = Rs.${sizeInrMonth}/month`,
    },
    status: 'candidate',
  }
}

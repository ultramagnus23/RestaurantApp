// Computes the data quality profile automatically after every ingest.
// The capability_mask is what later analysis modules check before
// running - and its suppression reasons are written for an owner, not an
// engineer, since they get printed verbatim on the one-pager (per the
// spec's own example: "Table-time analysis not possible: bills are
// entered together at closing, so individual table timings aren't real.").

export type BillForProfile = {
  opened_at: string // ISO
  settled_at: string | null
  table_ref: string | null
}

export type ItemForProfile = {
  item_name_norm: string | null
}

export type CapabilityEntry = { allowed: boolean; reason: string | null }

export type CapabilityMask = {
  attach_rate: CapabilityEntry
  menu_mix: CapabilityEntry
  turnover_dwell: CapabilityEntry
}

export type DataQualityProfile = {
  timestamps_live: boolean | null
  timestamps_evidence: Record<string, unknown>
  table_ref_coverage_pct: number | null
  item_name_consistency_pct: number | null
  history_depth_days: number | null
  weekly_volume: number | null
  capability_mask: CapabilityMask
}

// Report-level floor: below this, nothing runs at all - the whole report
// says "insufficient data" rather than building findings on too thin a
// base. Proposed and confirmed as this tool's default.
export const MIN_HISTORY_DAYS = 14
export const MIN_WEEKLY_VOLUME = 50
export const MIN_TABLE_REF_COVERAGE_PCT = 70

function minutesSinceMidnight(iso: string): number {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}

function dateKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10)
}

// Small, dependency-free Levenshtein distance - used only to flag likely
// duplicate item names (typos/case variants), not for anything that
// touches money.
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const prev = new Array(n + 1)
  const curr = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j]
  }
  return prev[n]
}

function detectTimestampsLive(bills: BillForProfile[]): { live: boolean | null; evidence: Record<string, unknown> } {
  const withSettled = bills.filter((b) => b.settled_at)
  const settledCoverage = bills.length > 0 ? withSettled.length / bills.length : 0

  if (bills.length === 0 || settledCoverage < 0.5) {
    return {
      live: null,
      evidence: {
        reason: 'Most bills don\'t have a settlement time recorded, so live vs. batch billing can\'t be determined.',
        settled_coverage_pct: Math.round(settledCoverage * 1000) / 10,
        bills_with_settled_at: withSettled.length,
        total_bills: bills.length,
      },
    }
  }

  const byDay = new Map<string, BillForProfile[]>()
  for (const b of withSettled) {
    const key = dateKey(b.opened_at)
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key)!.push(b)
  }

  let qualifyingDays = 0
  let batchDays = 0
  let sampleBatchDay: Record<string, unknown> | null = null

  for (const [day, dayBills] of byDay) {
    if (dayBills.length < 5) continue
    qualifyingDays += 1
    const settledMinutes = dayBills.map((b) => minutesSinceMidnight(b.settled_at!))
    const openedMinutes = dayBills.map((b) => minutesSinceMidnight(b.opened_at))
    const settledRange = Math.max(...settledMinutes) - Math.min(...settledMinutes)
    const openedRange = Math.max(...openedMinutes) - Math.min(...openedMinutes)
    const isBatchDay = settledRange <= 30 && openedRange >= 90
    if (isBatchDay) {
      batchDays += 1
      if (!sampleBatchDay) {
        sampleBatchDay = { date: day, settled_range_minutes: settledRange, opened_range_minutes: openedRange, bill_count: dayBills.length }
      }
    }
  }

  if (qualifyingDays === 0) {
    return {
      live: null,
      evidence: {
        reason: 'No single day has enough bills with a settlement time recorded to tell live vs. batch billing apart.',
        qualifying_days: 0,
      },
    }
  }

  const batchDayFraction = batchDays / qualifyingDays
  const live = batchDayFraction < 0.3

  return {
    live,
    evidence: {
      qualifying_days: qualifyingDays,
      batch_days: batchDays,
      batch_day_fraction: Math.round(batchDayFraction * 1000) / 1000,
      threshold: 0.3,
      sample_batch_day: sampleBatchDay,
    },
  }
}

function computeItemNameConsistency(items: ItemForProfile[]): number | null {
  const distinctNames = Array.from(new Set(items.map((i) => i.item_name_norm).filter((n): n is string => !!n)))
  if (distinctNames.length < 2) return null

  let flaggedCount = 0
  const flagged = new Set<string>()
  for (let i = 0; i < distinctNames.length; i++) {
    if (flagged.has(distinctNames[i])) continue
    for (let j = i + 1; j < distinctNames.length; j++) {
      const a = distinctNames[i]
      const b = distinctNames[j]
      const maxLen = Math.max(a.length, b.length)
      if (maxLen === 0) continue
      const similarity = 1 - levenshtein(a, b) / maxLen
      if (similarity >= 0.8 && a !== b) {
        flagged.add(a)
        flagged.add(b)
      }
    }
  }
  flaggedCount = flagged.size
  const duplicateCandidateRate = flaggedCount / distinctNames.length
  return Math.round((1 - duplicateCandidateRate) * 1000) / 10
}

export function computeDataQualityProfile(bills: BillForProfile[], items: ItemForProfile[]): DataQualityProfile {
  const { live: timestampsLive, evidence: timestampsEvidence } = detectTimestampsLive(bills)

  const withTableRef = bills.filter((b) => b.table_ref && b.table_ref.trim())
  const tableRefCoveragePct = bills.length > 0 ? Math.round((withTableRef.length / bills.length) * 1000) / 10 : null

  const itemNameConsistencyPct = computeItemNameConsistency(items)

  let historyDepthDays: number | null = null
  let weeklyVolume: number | null = null
  if (bills.length > 0) {
    const days = bills.map((b) => new Date(b.opened_at).getTime())
    const minDay = Math.min(...days)
    const maxDay = Math.max(...days)
    historyDepthDays = Math.max(1, Math.round((maxDay - minDay) / (1000 * 60 * 60 * 24)) + 1)
    weeklyVolume = Math.round((bills.length / (historyDepthDays / 7)) * 10) / 10
  }

  const reportFloorOk =
    historyDepthDays !== null &&
    historyDepthDays >= MIN_HISTORY_DAYS &&
    weeklyVolume !== null &&
    weeklyVolume >= MIN_WEEKLY_VOLUME

  const reportFloorReason = !reportFloorOk
    ? `Not enough data yet: needs at least ${MIN_HISTORY_DAYS} days of history and ${MIN_WEEKLY_VOLUME} bills/week on average (currently ${historyDepthDays ?? 0} day(s), ${weeklyVolume ?? 0}/week).`
    : null

  const capabilityMask: CapabilityMask = {
    attach_rate: reportFloorOk ? { allowed: true, reason: null } : { allowed: false, reason: reportFloorReason },
    menu_mix: reportFloorOk ? { allowed: true, reason: null } : { allowed: false, reason: reportFloorReason },
    turnover_dwell: (() => {
      if (!reportFloorOk) return { allowed: false, reason: reportFloorReason }
      if (timestampsLive === null) {
        return {
          allowed: false,
          reason: 'Not enough settlement-time data recorded yet to tell whether billing is live or batch-entered.',
        }
      }
      if (timestampsLive === false) {
        return {
          allowed: false,
          reason: 'Table-time analysis not possible: bills are entered together at closing, so individual table timings aren\'t real.',
        }
      }
      if (tableRefCoveragePct === null || tableRefCoveragePct < MIN_TABLE_REF_COVERAGE_PCT) {
        return {
          allowed: false,
          reason: `Too few bills have a table recorded (${tableRefCoveragePct ?? 0}% do) to size turnover by table.`,
        }
      }
      return { allowed: true, reason: null }
    })(),
  }

  return {
    timestamps_live: timestampsLive,
    timestamps_evidence: timestampsEvidence,
    table_ref_coverage_pct: tableRefCoveragePct,
    item_name_consistency_pct: itemNameConsistencyPct,
    history_depth_days: historyDepthDays,
    weekly_volume: weeklyVolume,
    capability_mask: capabilityMask,
  }
}

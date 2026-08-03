// Orchestrates the three analysis modules into a single report: picks the
// one headline finding (if any clears its floor), records what was
// checked and suppressed and why, and generates a concrete, reversible,
// staff-executable recommended action. "No leak found" is a real,
// intentional path here, not an afterthought - per the spec, if nothing
// clears the floor the headline says so plainly.

import type { CapabilityMask } from './data-quality'
import type { LeakFinding } from './analysis'

export type ModuleOutcome =
  | LeakFinding
  | { rule: 'attach_rate' | 'menu_mix' | 'turnover_dwell'; status: 'insufficient_data'; reason: string }
  | { rule: 'attach_rate' | 'menu_mix' | 'turnover_dwell'; status: 'suppressed'; reason: string }

export type ReportContent = {
  headline: LeakFinding | null // null = "no fixable leak found in this data"
  checked: { rule: string; status: string; reason: string | null; size_inr_month: number | null }[]
  recommended_action: string | null
}

export function recommendedAction(finding: LeakFinding): string {
  switch (finding.rule) {
    case 'attach_rate': {
      const category = finding.evidence.category as string
      const dp = finding.evidence.daypart as string
      const band = finding.evidence.underperforming_band as string
      return `Have serving staff verbally offer ${category} to ${band}-spend tables during ${dp} service this week - no menu or system change needed. Compare next week's ${category} attach rate for that segment.`
    }
    case 'menu_mix': {
      const dish = finding.evidence.dish as string
      return `Raise "${dish}"'s price on the menu this week (the assumption above is a modest, reversible increase). Watch next week's unit sales to confirm volume holds before making it permanent.`
    }
    case 'turnover_dwell': {
      const hour = finding.evidence.hour as number
      return `Have a host or manager proactively check on tables seated after ${hour}:00 once they pass the venue's typical dwell time this week - a dessert offer or check-drop nudge, reversible immediately, no system change.`
    }
  }
}

/**
 * Picks the single headline finding (highest size_inr_month among
 * candidates) and records every module's outcome for the "what was
 * checked and suppressed" section. Modules gated off by capability_mask
 * are recorded as 'suppressed' with the mask's own plain-language reason,
 * without ever being run - there is nothing to compute if the mask says no.
 */
export function buildReportContent(
  capabilityMask: CapabilityMask,
  outcomes: {
    attach_rate: LeakFinding | { status: 'insufficient_data'; reason: string } | null
    menu_mix: LeakFinding | { status: 'insufficient_data'; reason: string } | null
    turnover_dwell: LeakFinding | { status: 'insufficient_data'; reason: string } | null
  }
): ReportContent {
  const checked: ReportContent['checked'] = []
  const candidates: LeakFinding[] = []

  for (const rule of ['attach_rate', 'menu_mix', 'turnover_dwell'] as const) {
    const mask = capabilityMask[rule]
    if (!mask.allowed) {
      checked.push({ rule, status: 'suppressed', reason: mask.reason, size_inr_month: null })
      continue
    }
    const outcome = outcomes[rule]
    if (!outcome) {
      checked.push({ rule, status: 'insufficient_data', reason: 'Not run.', size_inr_month: null })
      continue
    }
    if (outcome.status === 'candidate') {
      checked.push({ rule, status: 'candidate', reason: null, size_inr_month: outcome.size_inr_month })
      candidates.push(outcome)
    } else {
      checked.push({ rule, status: 'insufficient_data', reason: outcome.reason, size_inr_month: null })
    }
  }

  const headline = candidates.length > 0 ? candidates.reduce((a, b) => (b.size_inr_month > a.size_inr_month ? b : a)) : null

  return {
    headline,
    checked,
    recommended_action: headline ? recommendedAction(headline) : null,
  }
}

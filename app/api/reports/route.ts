import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import {
  computeAttachRateLeak,
  computeMenuMixLeak,
  computeTurnoverDwellLeak,
  type BillForAnalysis,
  type ItemForAnalysis,
  type DishCostForAnalysis,
} from '@/lib/analysis'
import { buildReportContent } from '@/lib/report'
import type { CapabilityMask } from '@/lib/data-quality'

export async function GET(req: Request) {
  try {
    const supabase = getServerSupabase(req)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const restaurantId = searchParams.get('restaurantId')
    if (!restaurantId) {
      return NextResponse.json({ error: 'restaurantId required' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('reports')
      .select('id, status, generated_at, reviewed_at, delivered_at, headline_finding_id, snapshot')
      .eq('restaurant_id', restaurantId)
      .order('generated_at', { ascending: false })

    if (error) throw error

    return NextResponse.json({ success: true, data })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

// Generates a new report: runs the three analysis modules (gated by the
// latest data quality profile's capability_mask - a suppressed module is
// never invoked, not just hidden after the fact), picks the single
// headline finding if any clears its floor, and freezes the result into
// a reports row so what's reviewed/delivered can't silently drift if the
// underlying bills change later.
export async function POST(req: Request) {
  try {
    const supabase = getServerSupabase(req)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const restaurantId = body.restaurantId as string
    if (!restaurantId) {
      return NextResponse.json({ error: 'restaurantId required' }, { status: 400 })
    }

    const { data: restaurant, error: restaurantError } = await supabase
      .from('restaurants')
      .select('timezone')
      .eq('id', restaurantId)
      .single()
    if (restaurantError) throw restaurantError

    const { data: profile, error: profileError } = await supabase
      .from('data_quality_profiles')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (profileError) throw profileError
    if (!profile) {
      return NextResponse.json({ error: 'No data yet - import a CSV first.' }, { status: 400 })
    }

    const mask = profile.capability_mask as CapabilityMask

    const { data: billRows, error: billsError } = await supabase
      .from('bills')
      .select('id, opened_at, settled_at, table_ref, gross')
      .eq('restaurant_id', restaurantId)
    if (billsError) throw billsError

    const bills: BillForAnalysis[] = (billRows ?? []).map((b: any) => ({
      opened_at: b.opened_at,
      settled_at: b.settled_at,
      table_ref: b.table_ref,
      gross: Number(b.gross),
    }))
    const billIndexById = new Map((billRows ?? []).map((b: any, i: number) => [b.id, i]))
    const billIds = (billRows ?? []).map((b: any) => b.id)

    const { data: itemRows, error: itemsError } = billIds.length
      ? await supabase.from('bill_items').select('bill_id, item_name_raw, item_name_norm, category, qty, price').in('bill_id', billIds)
      : { data: [], error: null }
    if (itemsError) throw itemsError

    const items: ItemForAnalysis[] = (itemRows ?? []).map((it: any) => ({
      bill_index: billIndexById.get(it.bill_id) ?? -1,
      item_name_raw: it.item_name_raw,
      item_name_norm: it.item_name_norm,
      category: it.category,
      qty: Number(it.qty),
      price: Number(it.price),
    }))

    const { data: dishCostRows, error: dishCostsError } = await supabase
      .from('dish_costs')
      .select('item, cost, price')
      .eq('restaurant_id', restaurantId)
    if (dishCostsError) throw dishCostsError
    const dishCosts: DishCostForAnalysis[] = (dishCostRows ?? []).map((d: any) => ({
      item: d.item,
      cost: Number(d.cost),
      price: Number(d.price),
    }))

    const timezone = restaurant?.timezone || 'Asia/Kolkata'

    const attachRateOutcome = mask.attach_rate.allowed ? computeAttachRateLeak(bills, items, timezone) : null
    const menuMixOutcome = mask.menu_mix.allowed ? computeMenuMixLeak(items, dishCosts, profile.history_depth_days ?? 0) : null
    const turnoverDwellOutcome = mask.turnover_dwell.allowed ? computeTurnoverDwellLeak(bills, timezone) : null

    const content = buildReportContent(mask, {
      attach_rate: attachRateOutcome,
      menu_mix: menuMixOutcome,
      turnover_dwell: turnoverDwellOutcome,
    })

    // Persist every module's outcome to leak_findings (candidate,
    // insufficient_data, or suppressed) - an audit trail of what was
    // actually checked, not just the winning headline.
    const findingRows = content.checked.map((c) => {
      const fullFinding =
        (attachRateOutcome && attachRateOutcome.status === 'candidate' && c.rule === 'attach_rate' && attachRateOutcome) ||
        (menuMixOutcome && menuMixOutcome.status === 'candidate' && c.rule === 'menu_mix' && menuMixOutcome) ||
        (turnoverDwellOutcome && turnoverDwellOutcome.status === 'candidate' && c.rule === 'turnover_dwell' && turnoverDwellOutcome) ||
        null
      return {
        restaurant_id: restaurantId,
        rule: c.rule,
        scope: fullFinding ? fullFinding.scope : null,
        size_inr_month: c.size_inr_month,
        confidence: fullFinding ? fullFinding.confidence : null,
        evidence: fullFinding ? fullFinding.evidence : { reason: c.reason },
        status: c.status,
      }
    })

    const { data: insertedFindings, error: findingsError } = await supabase
      .from('leak_findings')
      .insert(findingRows)
      .select('id, rule, status')
    if (findingsError) throw findingsError

    const headlineFindingRow = content.headline
      ? insertedFindings.find((f: any) => f.rule === content.headline!.rule && f.status === 'candidate')
      : null

    const { data: report, error: reportError } = await supabase
      .from('reports')
      .insert({
        restaurant_id: restaurantId,
        status: 'draft',
        headline_finding_id: headlineFindingRow?.id ?? null,
        snapshot: {
          headline: content.headline,
          checked: content.checked,
          recommended_action: content.recommended_action,
          profile: {
            timestamps_live: profile.timestamps_live,
            table_ref_coverage_pct: profile.table_ref_coverage_pct,
            item_name_consistency_pct: profile.item_name_consistency_pct,
            history_depth_days: profile.history_depth_days,
            weekly_volume: profile.weekly_volume,
          },
        },
      })
      .select()
      .single()
    if (reportError) throw reportError

    return NextResponse.json({ success: true, data: report })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

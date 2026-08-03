import { NextResponse } from 'next/server'
import Papa from 'papaparse'
import { getServerSupabase } from '@/lib/supabase'
import { ingestRows, missingRequiredFields, type ColumnMapping } from '@/lib/csv-ingest'
import { computeDataQualityProfile } from '@/lib/data-quality'

// Returns the saved column mapping for a venue, if one exists, so the
// upload page can auto-apply it on re-upload instead of re-asking.
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
      .from('venue_column_maps')
      .select('mapping')
      .eq('restaurant_id', restaurantId)
      .maybeSingle()

    if (error) throw error

    return NextResponse.json({ success: true, data: data?.mapping ?? null })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

// Ingests a CSV: the server re-parses the file itself (never trusts a
// client-computed bill/item breakdown, only the client's column mapping
// choice), scrubs PII structurally (the canonical schema has no name/
// phone destination at all - see lib/csv-ingest.ts), upserts bills
// idempotently on (restaurant_id, external_bill_id), and logs the batch
// to ingestion_batches with rejected-row reasons.
export async function POST(req: Request) {
  try {
    const supabase = getServerSupabase(req)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const formData = await req.formData()
    const file = formData.get('file') as File | null
    const restaurantId = formData.get('restaurantId') as string | null
    const mappingRaw = formData.get('mapping') as string | null

    if (!file || !restaurantId || !mappingRaw) {
      return NextResponse.json({ error: 'file, restaurantId, and mapping are required' }, { status: 400 })
    }

    let mapping: ColumnMapping
    try {
      mapping = JSON.parse(mappingRaw)
    } catch {
      return NextResponse.json({ error: 'mapping must be valid JSON' }, { status: 400 })
    }

    const missing = missingRequiredFields(mapping)
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `Missing required field mapping(s): ${missing.join(', ')}` },
        { status: 400 }
      )
    }

    const text = await file.text()
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true })

    if (parsed.data.length === 0) {
      return NextResponse.json({ error: 'CSV has no data rows' }, { status: 400 })
    }

    const result = ingestRows(parsed.data, mapping)

    // Upsert bills idempotently - a re-ingest of the same file (or an
    // overlapping export window) must not create duplicates, per the
    // spec's idempotent-re-ingest requirement.
    let billsWritten = 0
    for (const bill of result.bills) {
      const { data: billRow, error: billError } = await supabase
        .from('bills')
        .upsert(
          {
            restaurant_id: restaurantId,
            external_bill_id: bill.external_bill_id,
            opened_at: bill.opened_at,
            settled_at: bill.settled_at,
            table_ref: bill.table_ref,
            gross: bill.gross,
            discount: bill.discount,
            payment_type: bill.payment_type,
          },
          { onConflict: 'restaurant_id,external_bill_id' }
        )
        .select('id')
        .single()

      if (billError) throw billError
      billsWritten += 1

      // Replace this bill's items wholesale rather than trying to diff/
      // upsert individual lines (items have no stable external key) -
      // simple, correct, and idempotent: re-ingesting the same file
      // always converges to the same end state.
      const { error: deleteError } = await supabase.from('bill_items').delete().eq('bill_id', billRow.id)
      if (deleteError) throw deleteError

      if (bill.items.length > 0) {
        const { error: itemsError } = await supabase.from('bill_items').insert(
          bill.items.map((item) => ({
            bill_id: billRow.id,
            item_name_raw: item.item_name_raw,
            item_name_norm: item.item_name_raw.trim().toLowerCase(),
            category: item.category,
            qty: item.qty,
            price: item.price,
          }))
        )
        if (itemsError) throw itemsError
      }
    }

    // Save/update the mapping so re-uploads auto-apply it.
    await supabase
      .from('venue_column_maps')
      .upsert({ restaurant_id: restaurantId, mapping }, { onConflict: 'restaurant_id' })

    const { data: batch, error: batchError } = await supabase
      .from('ingestion_batches')
      .insert({
        restaurant_id: restaurantId,
        filename: file.name,
        rows_in: result.rowsIn,
        rows_parsed: result.rowsParsed,
        rows_rejected: result.rowsRejected,
        rejection_reasons: result.rejections,
      })
      .select()
      .single()

    if (batchError) throw batchError

    // Data quality profile runs automatically after every ingest, over
    // the venue's FULL history (not just this batch) - history depth and
    // weekly volume are meaningless computed over a single upload.
    const { data: allBills, error: billsFetchError } = await supabase
      .from('bills')
      .select('id, opened_at, settled_at, table_ref')
      .eq('restaurant_id', restaurantId)
    if (billsFetchError) throw billsFetchError

    const billIds = (allBills ?? []).map((b: any) => b.id)
    const { data: allItems, error: itemsFetchError } = billIds.length
      ? await supabase.from('bill_items').select('item_name_norm').in('bill_id', billIds)
      : { data: [], error: null }
    if (itemsFetchError) throw itemsFetchError

    const profile = computeDataQualityProfile(allBills ?? [], allItems ?? [])

    const { error: profileError } = await supabase.from('data_quality_profiles').insert({
      restaurant_id: restaurantId,
      timestamps_live: profile.timestamps_live,
      timestamps_evidence: profile.timestamps_evidence,
      table_ref_coverage_pct: profile.table_ref_coverage_pct,
      item_name_consistency_pct: profile.item_name_consistency_pct,
      history_depth_days: profile.history_depth_days,
      weekly_volume: profile.weekly_volume,
      capability_mask: profile.capability_mask,
    })
    if (profileError) throw profileError

    return NextResponse.json({
      success: true,
      data: {
        batch,
        billsWritten,
        rowsIn: result.rowsIn,
        rowsParsed: result.rowsParsed,
        rowsRejected: result.rowsRejected,
        rejections: result.rejections,
        profile,
      },
    })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

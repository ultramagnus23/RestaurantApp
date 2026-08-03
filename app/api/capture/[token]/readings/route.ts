import { NextResponse } from 'next/server'
import { getServiceSupabase, resolveDevice, touchDevice } from '@/lib/device-auth'

// music_tempo_bpm added for the Ingestion Automation phase
// (supabase/migrations/013_ingestion_automation.sql added it to streams'
// signal_type check). Nothing in the current capture loop sends it yet -
// accepting the type doesn't imply a producer exists. temp_c is
// deliberately excluded and explicitly rejected below: iOS Safari has no
// ambient temperature sensor, and silently accepting a field the phone
// can't actually produce would fabricate a reading. (The original spec's
// sound_db/lux_est field-name mapping turned out to be unnecessary on
// inspection - components/capture/useCaptureLoop.ts already sends the
// canonical sound_level_dba/light_level names directly.)
const SIGNAL_TYPES = new Set([
  'sound_level_dba',
  'sound_spectrum',
  'light_level',
  'light_color_temp',
  'vibration',
  'occupancy_count',
  'zone_occupancy',
  'music_tempo_bpm',
])

const REJECTED_SIGNAL_TYPES = new Set(['temp_c'])

// Readings whose device-reported timestamp differs from server time by
// more than this are flagged skew_suspect, never dropped - see
// 013_ingestion_automation.sql.
const SKEW_TOLERANCE_MS = 60_000

type IncomingReading = { signal_type: string; timestamp: string; value: unknown }

// Batched ingestion from the phone capture page's IndexedDB queue flush
// (every 15-30s) - not from a live per-sample connection, so a Wi-Fi drop
// just delays a batch rather than losing samples, as long as the page's
// own retry/backoff eventually succeeds.
export async function POST(req: Request, { params }: { params: { token: string } }) {
  try {
    const supabase = getServiceSupabase()
    const device = await resolveDevice(supabase, params.token)
    if (!device) {
      return NextResponse.json({ success: false, error: 'Invalid or revoked link' }, { status: 404 })
    }

    const body = await req.json()
    const readings: IncomingReading[] = Array.isArray(body.readings) ? body.readings : []
    if (readings.length === 0) {
      return NextResponse.json({ success: true, data: { accepted: 0 } })
    }

    const signalTypes = Array.from(new Set(readings.map((r) => r.signal_type)))

    const rejected = signalTypes.filter((t) => REJECTED_SIGNAL_TYPES.has(t))
    if (rejected.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: `Rejected signal_type(s): ${rejected.join(', ')} - iOS Safari exposes no ambient temperature sensor, so this can't be a genuine phone reading.`,
        },
        { status: 400 }
      )
    }

    const invalid = signalTypes.filter((t) => !SIGNAL_TYPES.has(t))
    if (invalid.length > 0) {
      return NextResponse.json(
        { success: false, error: `Unknown signal_type(s): ${invalid.join(', ')}` },
        { status: 400 }
      )
    }

    // Ensure a streams row exists for every (device, signal_type) pair in
    // this batch - no generic upsert helper exists elsewhere in the
    // codebase, so this stays a small local routine rather than a new
    // abstraction (see PIVOT_AUDIT.md: no ingestion layer predates this one).
    const { data: streamRows, error: streamError } = await supabase
      .from('streams')
      .upsert(
        signalTypes.map((signal_type) => ({ device_id: device.id, signal_type })),
        { onConflict: 'device_id,signal_type', ignoreDuplicates: false }
      )
      .select('id, signal_type')

    if (streamError) throw streamError

    const streamIdByType = new Map(streamRows.map((s) => [s.signal_type, s.id]))

    // Skew check: the phone's own clock vs the server's, at the moment
    // this batch actually arrives (not per-reading arrival, since they're
    // batched - a reasonable approximation given readings in one batch
    // were captured within the same ~15-30s flush window). Flagged, never
    // dropped - alignment can exclude a flagged reading without losing
    // the fact that something was reported. See 013_ingestion_automation.sql.
    const serverNow = Date.now()
    const rows = readings.map((r) => {
      const readingMs = new Date(r.timestamp).getTime()
      const skewSuspect = !Number.isFinite(readingMs) || Math.abs(readingMs - serverNow) > SKEW_TOLERANCE_MS
      return {
        stream_id: streamIdByType.get(r.signal_type)!,
        timestamp: r.timestamp,
        value_json: typeof r.value === 'object' && r.value !== null ? r.value : { value: r.value },
        skew_suspect: skewSuspect,
      }
    })

    const { error: insertError } = await supabase.from('readings').insert(rows)
    if (insertError) throw insertError

    await touchDevice(supabase, device)

    // Best-effort heartbeat into the unified freshness table - matches
    // occupancy_detector.py's per-zone upserts (cv_pipeline/occupancy_detector.py).
    // Never fails the request if this write fails.
    await supabase
      .from('source_health')
      .upsert(
        {
          restaurant_id: device.restaurant_id,
          source_type: 'phone',
          source_key: device.id,
          status: 'healthy',
          last_success_at: new Date().toISOString(),
          last_error: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'restaurant_id,source_type,source_key' }
      )

    return NextResponse.json({ success: true, data: { accepted: rows.length } })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

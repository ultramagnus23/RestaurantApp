import { NextResponse } from 'next/server'
import { getServiceSupabase, resolveDevice, touchDevice } from '@/lib/device-auth'

const CATEGORIES = new Set([
  'music',
  'lighting',
  'temperature',
  'scent',
  'layout',
  'table_materials',
  'menu',
  'service_protocol',
  'other',
])

// The two-tap intervention log, same token as sensor capture. Attributed
// to the device (logged_by_device_id), not a named owner - there is no
// Supabase user session on this page (see
// supabase/migrations/010_intervention_device_attribution.sql).
export async function POST(req: Request, { params }: { params: { token: string } }) {
  try {
    const supabase = getServiceSupabase()
    const device = await resolveDevice(supabase, params.token)
    if (!device) {
      return NextResponse.json({ success: false, error: 'Invalid or revoked link' }, { status: 404 })
    }

    const body = await req.json()
    const { category, description, zone_ids } = body

    if (!category || !CATEGORIES.has(category)) {
      return NextResponse.json({ success: false, error: 'Invalid category' }, { status: 400 })
    }

    const { data: intervention, error } = await supabase
      .from('interventions')
      .insert({
        restaurant_id: device.restaurant_id,
        category,
        description: description || null,
        zone_ids: Array.isArray(zone_ids) ? zone_ids : device.zone_id ? [device.zone_id] : [],
        logged_by_device_id: device.id,
      })
      .select()
      .single()

    if (error) throw error

    await touchDevice(supabase, device)

    return NextResponse.json({ success: true, data: intervention })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

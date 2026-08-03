import { NextResponse } from 'next/server'
import { getServiceSupabase, resolveDevice } from '@/lib/device-auth'

// Public, unauthenticated - the only auth is the token itself. Deliberately
// returns the minimum needed to render the onboard screen: no owner PII, no
// sibling devices, no restaurant_id beyond what identifies the venue name.
export async function GET(_req: Request, { params }: { params: { token: string } }) {
  try {
    const supabase = getServiceSupabase()
    const device = await resolveDevice(supabase, params.token)

    if (!device) {
      // Same response whether the token never existed or was revoked -
      // don't leak which.
      return NextResponse.json({ success: false, error: 'Invalid or revoked link' }, { status: 404 })
    }

    const [{ data: restaurant }, { data: zone }] = await Promise.all([
      supabase.from('restaurants').select('name').eq('id', device.restaurant_id).single(),
      device.zone_id
        ? supabase.from('zones').select('name').eq('id', device.zone_id).single()
        : Promise.resolve({ data: null }),
    ])

    return NextResponse.json({
      success: true,
      data: {
        restaurant_name: restaurant?.name ?? null,
        zone_name: zone?.name ?? null,
        device_type: device.device_type,
        status: device.status,
      },
    })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

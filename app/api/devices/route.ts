import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { generateDeviceToken } from '@/lib/device-auth'

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

    const { data: devices, error } = await supabase
      .from('devices')
      .select('*, zones(name)')
      .eq('restaurant_id', restaurantId)
      .order('created_at', { ascending: false })

    if (error) throw error

    return NextResponse.json({ success: true, data: devices })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const supabase = getServerSupabase(req)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const { restaurant_id, device_type, zone_id } = body

    if (!restaurant_id || !device_type) {
      return NextResponse.json(
        { error: 'restaurant_id and device_type are required' },
        { status: 400 }
      )
    }

    const { data: device, error } = await supabase
      .from('devices')
      .insert({
        restaurant_id,
        device_type,
        zone_id: zone_id || null,
        token: generateDeviceToken(),
      })
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ success: true, data: device })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

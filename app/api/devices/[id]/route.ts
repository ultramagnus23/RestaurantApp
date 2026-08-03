import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'
import { generateDeviceToken } from '@/lib/device-auth'
import type { SupabaseClient } from '@supabase/supabase-js'

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const supabase = getServerSupabase(req)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = params
    const body = await req.json()
    const update: Record<string, any> = {}
    if ('zone_id' in body) update.zone_id = body.zone_id
    if ('status' in body) update.status = body.status
    // rotate_token: true regenerates the token (e.g. after a lost/reset
    // phone) - the old QR code and any link derived from it stop working
    // immediately, since capture routes look the token up fresh each call.
    if (body.rotate_token) update.token = generateDeviceToken()

    const { data: device, error } = await supabase
      .from('devices')
      .update(update)
      .eq('id', id)
      .eq('restaurant_id', await getRestaurantId(supabase, user.id))
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ success: true, data: device })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    const supabase = getServerSupabase(req)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = params

    const { error } = await supabase
      .from('devices')
      .delete()
      .eq('id', id)
      .eq('restaurant_id', await getRestaurantId(supabase, user.id))

    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

async function getRestaurantId(supabase: SupabaseClient, ownerId: string) {
  const { data } = await supabase
    .from('restaurants')
    .select('id')
    .eq('owner_id', ownerId)
    .single()
  return data?.id
}

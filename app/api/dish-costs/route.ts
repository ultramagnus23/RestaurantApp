import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

// Up to ~15 dishes - the spec's own cap. Enforced here (app-layer, not a
// hard DB constraint) since it's a soft usability limit, not a safety one.
const MAX_DISH_COSTS = 15

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
      .from('dish_costs')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .order('created_at', { ascending: true })

    if (error) throw error

    return NextResponse.json({ success: true, data })
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
    const { restaurant_id, item, cost, price } = body

    if (!restaurant_id || !item || cost === undefined || price === undefined) {
      return NextResponse.json({ error: 'restaurant_id, item, cost, and price are required' }, { status: 400 })
    }
    if (Number(cost) < 0 || Number(price) < 0) {
      return NextResponse.json({ error: 'cost and price must not be negative' }, { status: 400 })
    }

    const { count, error: countError } = await supabase
      .from('dish_costs')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurant_id)
    if (countError) throw countError
    if ((count ?? 0) >= MAX_DISH_COSTS) {
      return NextResponse.json(
        { error: `Up to ${MAX_DISH_COSTS} dishes only - remove one before adding another.` },
        { status: 400 }
      )
    }

    const { data, error } = await supabase
      .from('dish_costs')
      .insert({ restaurant_id, item, cost, price })
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ success: true, data })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

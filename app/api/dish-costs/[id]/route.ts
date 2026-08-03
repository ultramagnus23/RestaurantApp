import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const supabase = getServerSupabase(req)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const { item, cost, price } = body
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (item !== undefined) update.item = item
    if (cost !== undefined) {
      if (Number(cost) < 0) return NextResponse.json({ error: 'cost must not be negative' }, { status: 400 })
      update.cost = cost
    }
    if (price !== undefined) {
      if (Number(price) < 0) return NextResponse.json({ error: 'price must not be negative' }, { status: 400 })
      update.price = price
    }

    const { data, error } = await supabase
      .from('dish_costs')
      .update(update)
      .eq('id', params.id)
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ success: true, data })
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

    const { error } = await supabase.from('dish_costs').delete().eq('id', params.id)
    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

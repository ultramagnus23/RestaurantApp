import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

export async function GET(req: Request) {
  try {
    const supabase = getServerSupabase(req)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const restaurantId = searchParams.get('restaurantId')
    const status = searchParams.get('status')

    if (!restaurantId) {
      return NextResponse.json({ error: 'restaurantId required' }, { status: 400 })
    }

    let query = supabase
      .from('experiments')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .order('created_at', { ascending: false })

    if (status) {
      query = query.eq('status', status)
    }

    const { data: experiments, error } = await query
    if (error) throw error

    return NextResponse.json({ success: true, data: experiments })
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
    const { restaurant_id, ...data } = body

    if (!restaurant_id) {
      return NextResponse.json({ error: 'restaurant_id required' }, { status: 400 })
    }

    // return_rate is a mandatory secondary metric (a treatment that raises
    // tonight's bill but cuts return visits must always be visible) -
    // enforced for real by experiments_secondary_metrics_return_rate_check
    // in 007_experiment_lab.sql; defaulted here so callers that only care
    // about their own primary metric don't have to know that.
    const secondary_metrics: string[] = Array.isArray(data.secondary_metrics)
      ? data.secondary_metrics
      : []
    if (!secondary_metrics.includes('return_rate')) {
      secondary_metrics.push('return_rate')
    }

    const { data: experiment, error } = await supabase
      .from('experiments')
      .insert({ ...data, secondary_metrics, restaurant_id })
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ success: true, data: experiment })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

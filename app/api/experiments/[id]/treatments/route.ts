import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

// Treatments (arms) for a single experiment, e.g. control vs. slow-tempo
// playlist, or a thermal arm carrying config.hold_temp_c. The danger-zone
// guard (fn_check_thermal_danger_zone in 007_experiment_lab.sql) rejects
// unsafe hold_temp_c values at the DB layer regardless of what's sent here.

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const supabase = getServerSupabase(req)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: treatments, error } = await supabase
      .from('experiment_treatments')
      .select('*')
      .eq('experiment_id', params.id)
      .order('created_at', { ascending: true })

    if (error) throw error

    return NextResponse.json({ success: true, data: treatments })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const supabase = getServerSupabase(req)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const { label, is_control, config } = body

    if (!label) {
      return NextResponse.json({ error: 'label required' }, { status: 400 })
    }

    const { data: treatment, error } = await supabase
      .from('experiment_treatments')
      .insert({ experiment_id: params.id, label, is_control, config })
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ success: true, data: treatment })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

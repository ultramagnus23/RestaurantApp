import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

// Unit-level treatment assignments (day/table/dish/session, per the parent
// experiment's randomization_unit). The DB rejects a wrongly-shaped unit_key
// outright (fn_check_assignment_unit, 007_experiment_lab.sql). What the DB
// can't cheaply check is a *cross-experiment* conflict - e.g. this table
// assignment landing on a day when a different day-level lever in the same
// category (music, lighting, ...) is also running on the same restaurant.
// That's a soft heuristic on free-text `variable_changed`, not a hard safety
// invariant, so it's an advisory warning here rather than a DB trigger - see
// conversation with Chaitanya, 2026-07-13 (cut from v1 as a hard block).

const ROOM_WIDE_CATEGORIES: Record<string, RegExp> = {
  music: /music|tempo|playlist|volume/i,
  lighting: /light|lux|brightness/i,
  temperature: /temperature|ac\b|thermostat/i,
}

function categorize(variableChanged: string): string | null {
  for (const [category, pattern] of Object.entries(ROOM_WIDE_CATEGORIES)) {
    if (pattern.test(variableChanged)) return category
  }
  return null
}

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const supabase = getServerSupabase(req)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: assignments, error } = await supabase
      .from('experiment_assignments')
      .select('*')
      .eq('experiment_id', params.id)
      .order('assigned_for', { ascending: false })

    if (error) throw error

    return NextResponse.json({ success: true, data: assignments })
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
    const { treatment_id, unit_key, assigned_for } = body

    if (!treatment_id || !unit_key) {
      return NextResponse.json({ error: 'treatment_id and unit_key required' }, { status: 400 })
    }

    const { data: experiment, error: expError } = await supabase
      .from('experiments')
      .select('restaurant_id, variable_changed, randomization_unit')
      .eq('id', params.id)
      .single()
    if (expError) throw expError

    const { data: assignment, error } = await supabase
      .from('experiment_assignments')
      .insert({ experiment_id: params.id, treatment_id, unit_key, assigned_for })
      .select()
      .single()

    if (error) throw error

    let warning: string | null = null
    if (experiment.randomization_unit === 'table' || experiment.randomization_unit === 'dish') {
      const category = categorize(experiment.variable_changed)
      if (category) {
        const day = (assigned_for ?? new Date().toISOString()).slice(0, 10)
        const { data: siblings } = await supabase
          .from('experiments')
          .select('id, experiment_name, variable_changed')
          .eq('restaurant_id', experiment.restaurant_id)
          .eq('randomization_unit', 'day')
          .eq('status', 'running')
          .neq('id', params.id)
          .lte('start_time', `${day}T23:59:59Z`)
          .or(`end_time.is.null,end_time.gte.${day}T00:00:00Z`)

        const conflicting = (siblings ?? []).filter((s) => categorize(s.variable_changed) === category)
        if (conflicting.length > 0) {
          warning =
            `Advisory: this ${experiment.randomization_unit}-level assignment on ${day} overlaps ` +
            `${conflicting.length} running day-level experiment(s) in the "${category}" category ` +
            `(${conflicting.map((c) => c.experiment_name).join(', ')}). If "${experiment.variable_changed}" ` +
            `is actually room-wide, it should be a day-level experiment instead.`
        }
      }
    }

    return NextResponse.json({ success: true, data: assignment, warning })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

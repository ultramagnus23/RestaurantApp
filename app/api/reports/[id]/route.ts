import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const supabase = getServerSupabase(req)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data, error } = await supabase.from('reports').select('*').eq('id', params.id).single()
    if (error) throw error

    return NextResponse.json({ success: true, data })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

// draft -> reviewed -> delivered only. Each transition is an explicit
// manual action from the one-pager's own UI - nothing anywhere advances
// a report automatically, per ground rule 5. Enforced server-side, not
// just hidden in the UI: skipping straight to delivered, or moving
// backward, is rejected.
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ['reviewed'],
  reviewed: ['delivered'],
  delivered: [],
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const supabase = getServerSupabase(req)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const nextStatus = body.status as string

    const { data: current, error: fetchError } = await supabase
      .from('reports')
      .select('status')
      .eq('id', params.id)
      .single()
    if (fetchError) throw fetchError

    if (!ALLOWED_TRANSITIONS[current.status]?.includes(nextStatus)) {
      return NextResponse.json(
        { error: `Cannot move a report from "${current.status}" to "${nextStatus}".` },
        { status: 400 }
      )
    }

    const update: Record<string, unknown> = { status: nextStatus }
    if (nextStatus === 'reviewed') update.reviewed_at = new Date().toISOString()
    if (nextStatus === 'delivered') update.delivered_at = new Date().toISOString()

    const { data, error } = await supabase
      .from('reports')
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

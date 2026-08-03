import { NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase'

// Staff-facing compliance confirmation for a treatment assignment - e.g.
// confirming the assigned playlist was actually played, or the plate warmer
// was actually on. Treatment assignment and measured reality are different
// things; never assume compliance.

export async function PATCH(
  req: Request,
  { params }: { params: { id: string; assignmentId: string } }
) {
  try {
    const supabase = getServerSupabase(req)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const { compliance_confirmed, compliance_note } = body

    const { data: assignment, error } = await supabase
      .from('experiment_assignments')
      .update({ compliance_confirmed, compliance_note })
      .eq('id', params.assignmentId)
      .eq('experiment_id', params.id)
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ success: true, data: assignment })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

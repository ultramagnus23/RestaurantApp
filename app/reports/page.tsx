'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth-provider'
import { useStore } from '@/lib/store'
import { api } from '@/lib/api-client'
import { AppShell } from '@/components/AppShell'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

type Report = {
  id: string
  status: 'draft' | 'reviewed' | 'delivered'
  generated_at: string
  snapshot: { headline: any; recommended_action: string | null }
}

export default function ReportsPage() {
  const { user } = useAuth()
  const router = useRouter()
  const { selectedRestaurant } = useStore()
  const [reports, setReports] = useState<Report[]>([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    if (!selectedRestaurant) return
    setLoading(true)
    try {
      const res = await api.getReports(selectedRestaurant.id)
      if (res.success) setReports(res.data)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!user) {
      router.push('/signin')
      return
    }
    if (!selectedRestaurant) {
      router.push('/create-restaurant')
      return
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, selectedRestaurant])

  const handleGenerate = async () => {
    if (!selectedRestaurant) return
    setGenerating(true)
    setError(null)
    try {
      const res = await api.generateReport(selectedRestaurant.id)
      if (res.success) {
        router.push(`/reports/${res.data.id}`)
      } else {
        setError(res.error)
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <AppShell
      title="Reports"
      description="Each report checks your data and finds at most one sized leak."
      headerActions={
        <Button onClick={handleGenerate} disabled={generating}>
          {generating ? 'Generating...' : 'Generate report'}
        </Button>
      }
    >
      {error && <div className="text-sm p-3 rounded-md bg-destructive/10 text-destructive">{error}</div>}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : reports.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No reports yet. Import a CSV, add dish costs, then generate your first report.
          </CardContent>
        </Card>
      ) : (
        <div className="divide-y divide-border border-y border-border">
          {reports.map((r) => (
            <button
              key={r.id}
              onClick={() => router.push(`/reports/${r.id}`)}
              className="flex w-full items-center justify-between gap-4 px-1 py-3 text-left hover:bg-accent/50 transition-colors"
            >
              <div className="min-w-0">
                <p className="text-sm truncate">
                  {r.snapshot.headline ? r.snapshot.headline.scope : 'No leak found in this data'}
                </p>
                <p className="text-xs text-muted-foreground">{new Date(r.generated_at).toLocaleString()}</p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {r.snapshot.headline && (
                  <span className="font-mono text-sm tabular-nums">₹{r.snapshot.headline.size_inr_month}/mo</span>
                )}
                <span className="text-xs uppercase tracking-wide text-muted-foreground">{r.status}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </AppShell>
  )
}

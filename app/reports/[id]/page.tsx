'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api } from '@/lib/api-client'
import { Button } from '@/components/ui/button'

type CheckedRow = { rule: string; status: string; reason: string | null; size_inr_month: number | null }

type Report = {
  id: string
  status: 'draft' | 'reviewed' | 'delivered'
  generated_at: string
  reviewed_at: string | null
  delivered_at: string | null
  snapshot: {
    headline: any | null
    checked: CheckedRow[]
    recommended_action: string | null
    profile: {
      timestamps_live: boolean | null
      table_ref_coverage_pct: number | null
      item_name_consistency_pct: number | null
      history_depth_days: number | null
      weekly_volume: number | null
    }
  }
}

const RULE_LABELS: Record<string, string> = {
  attach_rate: 'Attach rate',
  menu_mix: 'Menu mix',
  turnover_dwell: 'Turnover / dwell',
}

export default function OnePagerPage() {
  const params = useParams<{ id: string }>()
  const [report, setReport] = useState<Report | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const res = await api.getReport(params.id)
    if (res.success) setReport(res.data)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id])

  const advance = async (status: 'reviewed' | 'delivered') => {
    setBusy(true)
    try {
      const res = await api.updateReportStatus(params.id, status)
      if (res.success) setReport(res.data)
    } finally {
      setBusy(false)
    }
  }

  if (!report) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">Loading...</div>
  }

  const { snapshot } = report
  const headline = snapshot.headline

  return (
    <div className="min-h-screen bg-background">
      {/* Status bar - not part of the document, hidden on print. This is
          the only manual-action UI on the page: draft -> reviewed ->
          delivered, each an explicit click, nothing automatic. */}
      <div className="no-print sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-background px-6 py-3">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          Status: <span className="text-foreground">{report.status}</span>
        </span>
        <div className="flex gap-2">
          {report.status === 'draft' && (
            <Button size="sm" onClick={() => advance('reviewed')} disabled={busy}>
              Mark reviewed
            </Button>
          )}
          {report.status === 'reviewed' && (
            <Button size="sm" onClick={() => advance('delivered')} disabled={busy}>
              Deliver
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => window.print()}>
            Print / Save PDF
          </Button>
        </div>
      </div>

      {/* The document itself. */}
      <div className="max-w-2xl mx-auto px-8 py-10 print:py-0">
        <header className="mb-8 pb-4 border-b border-border">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Meza — revenue leak report</p>
          <p className="text-xs text-muted-foreground mt-1">Generated {new Date(report.generated_at).toLocaleString()}</p>
        </header>

        {/* Headline */}
        <section className="mb-8">
          {headline ? (
            <>
              <h1 className="font-display text-2xl font-semibold leading-tight">
                {RULE_LABELS[headline.rule]}: {headline.scope}
              </h1>
              <p className="font-mono text-4xl tabular-nums mt-3">
                ₹{headline.size_inr_month.toLocaleString('en-IN')}<span className="text-lg text-muted-foreground">/month</span>
              </p>
            </>
          ) : (
            <h1 className="font-display text-2xl font-semibold leading-tight">
              No fixable leak found in this data.
            </h1>
          )}
        </section>

        {/* Evidence + arithmetic */}
        {headline && (
          <section className="mb-8">
            <h2 className="text-sm font-medium mb-2 text-muted-foreground uppercase tracking-wide">Evidence</h2>
            <div className="border border-border rounded-md p-4 space-y-1.5 text-sm font-mono">
              {Object.entries(headline.evidence)
                .filter(([key]) => key !== 'arithmetic' && key !== 'assumption')
                .map(([key, value]) => (
                  <div key={key} className="flex justify-between gap-4">
                    <span className="text-muted-foreground">{key.replace(/_/g, ' ')}</span>
                    <span>{String(value)}</span>
                  </div>
                ))}
            </div>
            {(headline.evidence.arithmetic || headline.evidence.assumption) && (
              <p className="text-sm text-muted-foreground mt-2 font-mono">
                {headline.evidence.arithmetic}
                {headline.evidence.assumption && <><br />{headline.evidence.assumption}</>}
              </p>
            )}
          </section>
        )}

        {/* What was checked and suppressed */}
        <section className="mb-8">
          <h2 className="text-sm font-medium mb-2 text-muted-foreground uppercase tracking-wide">What was checked</h2>
          <div className="divide-y divide-border border-y border-border text-sm">
            {snapshot.checked.map((c) => (
              <div key={c.rule} className="py-2.5">
                <div className="flex justify-between">
                  <span>{RULE_LABELS[c.rule]}</span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {c.status === 'candidate' ? `₹${c.size_inr_month?.toLocaleString('en-IN')}/mo` : c.status}
                  </span>
                </div>
                {c.reason && <p className="text-xs text-muted-foreground mt-1">{c.reason}</p>}
              </div>
            ))}
          </div>
        </section>

        {/* Recommended action */}
        {snapshot.recommended_action && (
          <section className="mb-8">
            <h2 className="text-sm font-medium mb-2 text-muted-foreground uppercase tracking-wide">Recommended action</h2>
            <p className="text-sm border border-border rounded-md p-4">{snapshot.recommended_action}</p>
          </section>
        )}

        <footer className="text-xs text-muted-foreground border-t border-border pt-4 mt-10">
          Data quality: {snapshot.profile.history_depth_days} day(s) of history, ~{snapshot.profile.weekly_volume} bills/week,{' '}
          {snapshot.profile.table_ref_coverage_pct}% of bills have a table recorded.
        </footer>
      </div>

      <style jsx global>{`
        @media print {
          .no-print {
            display: none !important;
          }
        }
      `}</style>
    </div>
  )
}

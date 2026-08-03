'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Papa from 'papaparse'
import { useAuth } from '@/components/auth-provider'
import { useStore } from '@/lib/store'
import { api } from '@/lib/api-client'
import { AppShell } from '@/components/AppShell'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { UploadCloud, FileText, CheckCircle2, XCircle } from 'lucide-react'
import {
  ALL_FIELDS,
  REQUIRED_FIELDS,
  type CanonicalField,
  type ColumnMapping,
} from '@/lib/csv-ingest'

const FIELD_LABELS: Record<CanonicalField, string> = {
  external_bill_id: 'Bill / order ID',
  opened_at: 'Bill opened time',
  settled_at: 'Bill settled/closed time',
  table_ref: 'Table reference',
  gross: 'Bill total (gross)',
  discount: 'Discount',
  payment_type: 'Payment mode',
  item_name_raw: 'Item name',
  qty: 'Quantity',
  price: 'Item price',
  category: 'Item category',
}

const FIELD_HELP: Partial<Record<CanonicalField, string>> = {
  gross: 'Optional — if not mapped, Meza computes it from item price x quantity.',
  qty: 'Optional — defaults to 1 if not mapped.',
}

type Step = 'pick' | 'map' | 'result'

export default function UploadPage() {
  const { user } = useAuth()
  const router = useRouter()
  const { selectedRestaurant } = useStore()
  const [step, setStep] = useState<Step>('pick')
  const [file, setFile] = useState<File | null>(null)
  const [headers, setHeaders] = useState<string[]>([])
  const [previewRows, setPreviewRows] = useState<Record<string, string>[]>([])
  const [mapping, setMapping] = useState<ColumnMapping>({})
  const [savedMapping, setSavedMapping] = useState<ColumnMapping | null>(null)
  const [ingesting, setIngesting] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!user) {
      router.push('/signin')
      return
    }
    if (!selectedRestaurant) {
      router.push('/create-restaurant')
      return
    }
    api
      .getColumnMap(selectedRestaurant.id)
      .then((res) => {
        if (res.success && res.data) setSavedMapping(res.data)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, selectedRestaurant])

  const handleFileChosen = (chosen: File | null) => {
    setFile(chosen)
    setResult(null)
    setError(null)
    if (!chosen) return

    chosen.text().then((text) => {
      const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true, preview: 6 })
      const detectedHeaders = parsed.meta.fields ?? []
      setHeaders(detectedHeaders)
      setPreviewRows(parsed.data.slice(0, 5))

      // Auto-apply the saved mapping only if every one of its source
      // columns is actually present in this file - otherwise fall
      // through to manual mapping rather than silently mis-mapping.
      if (savedMapping && Object.values(savedMapping).every((col) => !col || detectedHeaders.includes(col as string))) {
        setMapping(savedMapping)
        setStep('map')
      } else {
        // Best-effort starting guess: exact case-insensitive header match
        // per field, so the owner is confirming/adjusting, not starting
        // from a completely blank form. Never silently trusted without
        // this confirm step, though.
        const guess: ColumnMapping = {}
        for (const field of ALL_FIELDS) {
          const match = detectedHeaders.find((h) => h.trim().toLowerCase() === field.replace(/_/g, ' '))
          if (match) guess[field] = match
        }
        setMapping(guess)
        setStep('map')
      }
    })
  }

  const missingRequired = REQUIRED_FIELDS.filter((f) => !mapping[f])

  const handleIngest = async () => {
    if (!file || !selectedRestaurant || missingRequired.length > 0) return
    setIngesting(true)
    setError(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('restaurantId', selectedRestaurant.id)
      formData.append('mapping', JSON.stringify(mapping))
      const res = await api.ingestCsv(formData)
      if (res.success) {
        setResult(res.data)
        setStep('result')
      } else {
        setError(res.error || 'Ingest failed')
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIngesting(false)
    }
  }

  const reset = () => {
    setStep('pick')
    setFile(null)
    setHeaders([])
    setPreviewRows([])
    setMapping({})
    setResult(null)
    setError(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <AppShell
      title="Import POS data"
      description={`Upload a CSV export from your POS for ${selectedRestaurant?.name ?? 'this restaurant'}.`}
    >
      {step === 'pick' && (
        <Card>
          <CardHeader>
            <CardTitle>Upload CSV</CardTitle>
            <CardDescription>Any export works — you&apos;ll map its columns next.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <label
              htmlFor="csv-file"
              className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-border rounded-md p-10 cursor-pointer hover:bg-accent/50 transition-colors"
            >
              <UploadCloud className="w-8 h-8 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Click to choose a .csv file, or drag it here</span>
              <input
                id="csv-file"
                ref={inputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => handleFileChosen(e.target.files?.[0] ?? null)}
              />
            </label>
          </CardContent>
        </Card>
      )}

      {step === 'map' && file && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="w-4 h-4" /> {file.name}
              </CardTitle>
              <CardDescription>
                Map each field to a column in your file. Fields marked required must be mapped before importing.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="divide-y divide-border border-y border-border">
                {ALL_FIELDS.map((field) => (
                  <div key={field} className="flex items-center justify-between gap-4 px-1 py-3">
                    <div>
                      <span className="text-sm">
                        {FIELD_LABELS[field]}
                        {REQUIRED_FIELDS.includes(field) && <span className="text-destructive ml-1">*</span>}
                      </span>
                      {FIELD_HELP[field] && (
                        <p className="text-xs text-muted-foreground mt-0.5">{FIELD_HELP[field]}</p>
                      )}
                    </div>
                    <select
                      className="w-56 px-2 py-1.5 rounded-md border bg-background text-sm shrink-0"
                      value={mapping[field] ?? ''}
                      onChange={(e) =>
                        setMapping((m) => ({ ...m, [field]: e.target.value || undefined }))
                      }
                    >
                      <option value="">— not present —</option>
                      {headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {previewRows.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Preview</CardTitle>
                <CardDescription>First {previewRows.length} rows of your file</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="text-xs w-full">
                  <thead>
                    <tr className="border-b border-border">
                      {headers.map((h) => (
                        <th key={h} className="text-left py-1.5 pr-4 font-medium whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="text-muted-foreground">
                    {previewRows.map((row, i) => (
                      <tr key={i} className="border-b border-border/50">
                        {headers.map((h) => (
                          <td key={h} className="py-1.5 pr-4 whitespace-nowrap">
                            {row[h]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {error && (
            <div className="flex items-center gap-2 text-sm p-3 rounded-md bg-destructive/10 text-destructive">
              <XCircle className="w-4 h-4" /> {error}
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={handleIngest} disabled={ingesting || missingRequired.length > 0}>
              {ingesting
                ? 'Importing...'
                : missingRequired.length > 0
                  ? `Map ${missingRequired.length} more required field(s)`
                  : 'Import'}
            </Button>
            <Button variant="outline" onClick={reset} disabled={ingesting}>
              Cancel
            </Button>
          </div>
        </>
      )}

      {step === 'result' && result && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-success" /> Import complete
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <div className="text-muted-foreground text-xs">Rows in file</div>
                <div className="font-mono text-lg tabular-nums">{result.rowsIn}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Rows parsed</div>
                <div className="font-mono text-lg tabular-nums">{result.rowsParsed}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Rows rejected</div>
                <div className="font-mono text-lg tabular-nums">{result.rowsRejected}</div>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">{result.billsWritten} bill(s) written.</p>

            {result.rejections?.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">Rejected rows</p>
                <div className="divide-y divide-border border-y border-border max-h-64 overflow-y-auto">
                  {result.rejections.map((r: any, i: number) => (
                    <div key={i} className="flex gap-3 py-2 text-xs">
                      <span className="font-mono text-muted-foreground shrink-0">row {r.row_number}</span>
                      <span>{r.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <Button onClick={reset}>Import another file</Button>
          </CardContent>
        </Card>
      )}
    </AppShell>
  )
}

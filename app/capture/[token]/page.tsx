'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { useCaptureLoop } from '@/components/capture/useCaptureLoop'
import { toast } from 'sonner'
import { Toaster } from 'sonner'

type DeviceInfo = {
  restaurant_name: string | null
  zone_name: string | null
  device_type: string
  status: string
}

const CATEGORIES: { value: string; label: string }[] = [
  { value: 'music', label: 'Music' },
  { value: 'lighting', label: 'Lighting' },
  { value: 'temperature', label: 'Temperature' },
  { value: 'scent', label: 'Scent' },
  { value: 'layout', label: 'Layout' },
  { value: 'table_materials', label: 'Table materials' },
  { value: 'menu', label: 'Menu' },
  { value: 'service_protocol', label: 'Service' },
  { value: 'other', label: 'Other' },
]

export default function CapturePage() {
  const params = useParams<{ token: string }>()
  const token = params.token
  const { status, requestMic, requestCamera, requestMotion, requestWakeLock, calibrateQuiet, start, stop } =
    useCaptureLoop(token)

  const [loading, setLoading] = useState(true)
  const [device, setDevice] = useState<DeviceInfo | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [step, setStep] = useState<'onboard' | 'permissions' | 'capturing'>('onboard')
  const [checklist, setChecklist] = useState({ plugged: false, stable: false, unobstructed: false, screenOn: false })
  const [tab, setTab] = useState<'status' | 'log'>('status')
  const [logCategory, setLogCategory] = useState<string | null>(null)
  const [logNote, setLogNote] = useState('')
  const [logging, setLogging] = useState(false)

  useEffect(() => {
    fetch(`/api/capture/${token}`)
      .then((r) => r.json())
      .then((res) => {
        if (res.success) setDevice(res.data)
        else setInvalid(true)
      })
      .catch(() => setInvalid(true))
      .finally(() => setLoading(false))
  }, [token])

  const allPermissionsResolved =
    status.micPermission !== 'idle' && status.cameraPermission !== 'idle' && status.motionPermission !== 'idle'
  const checklistComplete = Object.values(checklist).every(Boolean)

  const runPermissionSequence = async () => {
    setStep('permissions')
    await requestMic()
    await requestCamera()
    await requestMotion()
    await requestWakeLock()
  }

  const beginCapture = async () => {
    await start()
    setStep('capturing')
  }

  const submitIntervention = async () => {
    if (!logCategory) return
    try {
      setLogging(true)
      const res = await fetch(`/api/capture/${token}/interventions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: logCategory, description: logNote || undefined }),
      })
      const json = await res.json()
      if (!json.success) throw new Error(json.error || 'Failed to log')
      toast.success('Logged')
      setLogCategory(null)
      setLogNote('')
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setLogging(false)
    }
  }

  if (loading) {
    return <FullScreenCenter>Loading...</FullScreenCenter>
  }

  if (invalid || !device) {
    return (
      <FullScreenCenter>
        <p className="text-lg font-medium">This link isn&apos;t valid.</p>
        <p className="text-sm text-muted-foreground mt-2">Ask the restaurant owner for a new QR code.</p>
      </FullScreenCenter>
    )
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <Toaster position="top-center" />
      <header className="px-5 py-4 border-b border-border">
        <p className="text-xs text-muted-foreground uppercase tracking-wider">Meza capture</p>
        <h1 className="text-lg font-display font-semibold">
          {device.restaurant_name}
          {device.zone_name ? ` · ${device.zone_name}` : ''}
        </h1>
      </header>

      {step === 'onboard' && (
        <div className="flex-1 flex flex-col justify-center px-6 py-10 max-w-sm mx-auto w-full space-y-6">
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              This page turns this phone into a sound, light, and vibration sensor for this room. No app
              install, no account. Only the numbers computed on this phone ever leave it - raw audio and
              video are never recorded or uploaded.
            </p>
          </div>
          <Button size="lg" className="w-full" onClick={runPermissionSequence}>
            Start capture
          </Button>
        </div>
      )}

      {step === 'permissions' && (
        <div className="flex-1 flex flex-col justify-center px-6 py-10 max-w-sm mx-auto w-full space-y-6">
          <div className="space-y-3 text-sm">
            <PermissionRow label="Microphone" hint="Estimates sound level - never records audio." state={status.micPermission} />
            <PermissionRow label="Camera" hint="Samples light level from the frame - never saves images." state={status.cameraPermission} />
            <PermissionRow label="Motion" hint="Estimates room bustle from the phone's accelerometer." state={status.motionPermission} />
            {status.wakeLockSupported ? (
              <PermissionRow
                label="Keep screen on"
                hint="Stops the phone from sleeping mid-capture."
                state={status.wakeLockActive ? 'granted' : 'idle'}
              />
            ) : (
              <p className="text-xs text-warning">
                This browser can&apos;t keep the screen on automatically - please disable auto-lock in
                Settings before leaving the phone.
              </p>
            )}
          </div>

          {allPermissionsResolved && (
            <div className="space-y-3 pt-2 border-t border-border">
              <p className="text-xs text-muted-foreground">Before you leave the phone, confirm:</p>
              {(
                [
                  ['plugged', 'Phone is plugged in'],
                  ['stable', 'Phone is placed stably (not in a pocket)'],
                  ['unobstructed', 'Camera lens is unobstructed'],
                  ['screenOn', 'Screen will stay on (see above if unsupported)'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="w-5 h-5 rounded"
                    checked={checklist[key]}
                    onChange={(e) => setChecklist((c) => ({ ...c, [key]: e.target.checked }))}
                  />
                  {label}
                </label>
              ))}

              {status.micPermission === 'granted' && (
                <Button variant="outline" size="sm" onClick={calibrateQuiet} className="w-full">
                  Calibrate quiet baseline (optional - tap in a quiet moment)
                </Button>
              )}

              <Button size="lg" className="w-full" disabled={!checklistComplete} onClick={beginCapture}>
                Begin capture
              </Button>
            </div>
          )}
        </div>
      )}

      {step === 'capturing' && (
        <div className="flex-1 flex flex-col">
          <div className="flex border-b border-border">
            <TabButton active={tab === 'status'} onClick={() => setTab('status')}>
              Status
            </TabButton>
            <TabButton active={tab === 'log'} onClick={() => setTab('log')}>
              Log a change
            </TabButton>
          </div>

          {tab === 'status' && (
            <div className="flex-1 px-6 py-8 max-w-sm mx-auto w-full space-y-6">
              <div className="text-center">
                <p className="text-4xl font-mono tabular-nums font-semibold text-success">Capturing</p>
                <p className="text-xs text-muted-foreground mt-1">uptime {formatUptime(status.uptimeSeconds)}</p>
              </div>
              <div className="divide-y divide-border border-y border-border">
                <StatRow label="Captured" value={status.capturedCount} />
                <StatRow label="Uploaded" value={status.uploadedCount} />
                <StatRow label="Buffered (pending upload)" value={status.bufferedCount} />
                <StatRow
                  label="Sound level"
                  value={status.lastSoundLevel != null ? `${status.lastSoundLevel.toFixed(1)} (relative)` : '--'}
                />
                <StatRow label="Light level" value={status.lastLightLevel != null ? status.lastLightLevel.toFixed(0) : '--'} />
              </div>
              {status.lastFlushError && (
                <p className="text-xs text-warning">
                  Last upload attempt failed ({status.lastFlushError}) - retrying automatically. Nothing is
                  lost; readings stay buffered on this phone.
                </p>
              )}
              <Button variant="outline" className="w-full" onClick={stop}>
                Stop capture
              </Button>
            </div>
          )}

          {tab === 'log' && (
            <div className="flex-1 px-6 py-8 max-w-sm mx-auto w-full space-y-5">
              <p className="text-sm text-muted-foreground">What changed?</p>
              <div className="grid grid-cols-3 gap-2">
                {CATEGORIES.map((c) => (
                  <button
                    key={c.value}
                    onClick={() => setLogCategory(c.value)}
                    className={`rounded-md border px-2 py-3 text-xs font-medium transition-colors ${
                      logCategory === c.value
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              <input
                type="text"
                placeholder="One-line note (optional)"
                value={logNote}
                onChange={(e) => setLogNote(e.target.value)}
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                maxLength={140}
              />
              <Button className="w-full" disabled={!logCategory || logging} onClick={submitIntervention}>
                {logging ? 'Logging...' : 'Log it'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function FullScreenCenter({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center px-6 text-center">
      {children}
    </div>
  )
}

function PermissionRow({
  label,
  hint,
  state,
}: {
  label: string
  hint: string
  state: 'idle' | 'granted' | 'denied' | 'unsupported'
}) {
  const stateLabel = { idle: 'Requesting...', granted: 'Granted', denied: 'Denied', unsupported: 'Unsupported' }[state]
  const stateColor =
    state === 'granted' ? 'text-success' : state === 'denied' ? 'text-destructive' : 'text-muted-foreground'
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <span className={`text-xs font-mono shrink-0 ${stateColor}`}>{stateLabel}</span>
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-3 text-sm font-medium border-b-2 transition-colors ${
        active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground'
      }`}
    >
      {children}
    </button>
  )
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between py-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </div>
  )
}

function formatUptime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}

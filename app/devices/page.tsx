'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import QRCode from 'qrcode'
import { useAuth } from '@/components/auth-provider'
import { useStore } from '@/lib/store'
import { api } from '@/lib/api-client'
import { AppShell } from '@/components/AppShell'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Smartphone, Video, Trash2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

type Device = {
  id: string
  restaurant_id: string
  device_type: 'phone' | 'cctv_bridge'
  zone_id: string | null
  token: string
  status: 'pending' | 'active' | 'offline'
  last_seen_at: string | null
  created_at: string
  zones: { name: string } | null
}

function captureUrl(token: string) {
  const base = process.env.NEXT_PUBLIC_APP_URL || (typeof window !== 'undefined' ? window.location.origin : '')
  return `${base}/capture/${token}`
}

function timeAgo(iso: string | null) {
  if (!iso) return 'never'
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export default function DevicesPage() {
  const { user } = useAuth()
  const router = useRouter()
  const { selectedRestaurant } = useStore()
  const [loading, setLoading] = useState(true)
  const [devices, setDevices] = useState<Device[]>([])
  const [creating, setCreating] = useState(false)
  const [qrByToken, setQrByToken] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!user) {
      router.push('/signin')
      return
    }
    if (!selectedRestaurant) {
      router.push('/dashboard')
      return
    }
    loadDevices()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, selectedRestaurant])

  const loadDevices = async () => {
    if (!selectedRestaurant) return
    try {
      setLoading(true)
      const res = await api.getDevices({ restaurantId: selectedRestaurant.id })
      if (res.success) {
        setDevices(res.data)
        // Generate QR codes client-side (qrcode encoding only, no network
        // call) for any newly-loaded device that doesn't have one cached yet.
        for (const device of res.data as Device[]) {
          if (!qrByToken[device.token]) {
            QRCode.toDataURL(captureUrl(device.token), { margin: 1, width: 220 }).then((url) => {
              setQrByToken((prev) => ({ ...prev, [device.token]: url }))
            })
          }
        }
      }
    } catch (error: any) {
      console.error('Devices load error:', error)
      toast.error('Failed to load devices', { description: error.message })
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = async (device_type: 'phone' | 'cctv_bridge') => {
    if (!selectedRestaurant) return
    try {
      setCreating(true)
      await api.createDevice({ restaurant_id: selectedRestaurant.id, device_type })
      await loadDevices()
    } catch (error: any) {
      toast.error(error.message)
    } finally {
      setCreating(false)
    }
  }

  const handleRotateToken = async (device: Device) => {
    if (!confirm('Rotate this device\'s token? The current QR code and link stop working immediately.')) return
    try {
      await api.updateDevice(device.id, { rotate_token: true })
      await loadDevices()
    } catch (error: any) {
      toast.error(error.message)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Remove this device? Readings it already sent are kept.')) return
    try {
      await api.deleteDevice(id)
      loadDevices()
    } catch (error: any) {
      toast.error(error.message)
    }
  }

  return (
    <AppShell
      title="Devices"
      description="Register a phone as a live sound/light/vibration sensor, or a laptop running the CCTV bridge — no app install, just a QR code."
    >
      {loading ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : (
        <>
        <Card>
          <CardHeader>
            <CardTitle>Add a device</CardTitle>
            <CardDescription>
              A phone captures sound, light, and vibration from an on-device web page. A CCTV bridge
              is a script run on a laptop/box on the venue network — see /cameras for that setup.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button onClick={() => handleCreate('phone')} disabled={creating}>
              <Smartphone className="w-4 h-4 mr-2" />
              {creating ? 'Adding...' : 'Add phone'}
            </Button>
            <Button variant="outline" onClick={() => handleCreate('cctv_bridge')} disabled={creating}>
              <Video className="w-4 h-4 mr-2" />
              Add CCTV bridge
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Registered devices</CardTitle>
            <CardDescription>{devices.length} device(s) for this restaurant</CardDescription>
          </CardHeader>
          <CardContent>
            {devices.length === 0 ? (
              <p className="text-sm text-muted-foreground">No devices registered yet.</p>
            ) : (
              <div className="space-y-4">
                {devices.map((device) => (
                  <div key={device.id} className="border border-border rounded-md p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3">
                        {device.device_type === 'phone' ? (
                          <Smartphone className="w-5 h-5 text-primary mt-0.5" />
                        ) : (
                          <Video className="w-5 h-5 text-primary mt-0.5" />
                        )}
                        <div>
                          <p className="font-medium">
                            {device.device_type === 'phone' ? 'Phone capture' : 'CCTV bridge'}
                            {device.zones?.name ? ` — ${device.zones.name}` : ''}
                          </p>
                          <p className="text-xs text-muted-foreground font-mono tabular-nums">
                            last seen: {timeAgo(device.last_seen_at)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={
                            device.status === 'active' ? 'success' : device.status === 'offline' ? 'danger' : 'outline'
                          }
                        >
                          {device.status}
                        </Badge>
                        <Button size="sm" variant="ghost" onClick={() => handleRotateToken(device)} title="Rotate token">
                          <RefreshCw className="w-4 h-4" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => handleDelete(device.id)}>
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                    </div>

                    {device.device_type === 'phone' && (
                      <div className="mt-4 flex items-center gap-4">
                        {qrByToken[device.token] && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={qrByToken[device.token]}
                            alt="Scan with the phone's camera to open the capture page"
                            className="w-28 h-28 border border-border rounded-md"
                          />
                        )}
                        <div className="text-xs text-muted-foreground space-y-1">
                          <p>Scan with the phone&apos;s camera app — no app install, opens straight in Safari.</p>
                          <p className="font-mono break-all">{captureUrl(device.token)}</p>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        </>
      )}
    </AppShell>
  )
}

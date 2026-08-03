'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth-provider'
import { useStore } from '@/lib/store'
import { api } from '@/lib/api-client'
import { AppShell } from '@/components/AppShell'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Trash2 } from 'lucide-react'

const MAX_DISHES = 15

type DishCost = { id: string; item: string; cost: number; price: number }

export default function DishCostsPage() {
  const { user } = useAuth()
  const router = useRouter()
  const { selectedRestaurant } = useStore()
  const [dishes, setDishes] = useState<DishCost[]>([])
  const [loading, setLoading] = useState(true)
  const [item, setItem] = useState('')
  const [cost, setCost] = useState('')
  const [price, setPrice] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    if (!selectedRestaurant) return
    setLoading(true)
    try {
      const res = await api.getDishCosts(selectedRestaurant.id)
      if (res.success) setDishes(res.data)
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

  const handleAdd = async () => {
    if (!selectedRestaurant || !item.trim()) return
    const costNum = Number(cost)
    const priceNum = Number(price)
    if (!Number.isFinite(costNum) || !Number.isFinite(priceNum) || costNum < 0 || priceNum < 0) {
      setError('Cost and price must be non-negative numbers.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await api.createDishCost({ restaurant_id: selectedRestaurant.id, item: item.trim(), cost: costNum, price: priceNum })
      if (res.success) {
        setItem('')
        setCost('')
        setPrice('')
        await load()
      } else {
        setError(res.error)
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    await api.deleteDishCost(id)
    await load()
  }

  return (
    <AppShell
      title="Dish costs"
      description="Up to 15 dishes. This is the only cost data Meza has — margins are never inferred or estimated."
    >
      <Card>
        <CardHeader>
          <CardTitle>Add a dish</CardTitle>
          <CardDescription>{dishes.length}/{MAX_DISHES} dishes recorded</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <Input placeholder="Dish name" value={item} onChange={(e) => setItem(e.target.value)} className="sm:col-span-2" />
            <Input placeholder="Cost (₹)" type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} />
            <Input placeholder="Menu price (₹)" type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button onClick={handleAdd} disabled={saving || !item.trim() || !cost || !price || dishes.length >= MAX_DISHES}>
            {dishes.length >= MAX_DISHES ? `Limit of ${MAX_DISHES} reached` : saving ? 'Adding...' : 'Add dish'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recorded dishes</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : dishes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No dishes recorded yet.</p>
          ) : (
            <div className="divide-y divide-border border-y border-border">
              {dishes.map((d) => {
                const margin = d.price > 0 ? Math.round(((d.price - d.cost) / d.price) * 1000) / 10 : null
                return (
                  <div key={d.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span className="flex-1 truncate">{d.item}</span>
                    <span className="font-mono tabular-nums text-muted-foreground w-24 text-right">₹{d.cost}</span>
                    <span className="font-mono tabular-nums text-muted-foreground w-24 text-right">₹{d.price}</span>
                    <span className="font-mono tabular-nums w-20 text-right">{margin !== null ? `${margin}%` : '—'}</span>
                    <button onClick={() => handleDelete(d.id)} className="text-muted-foreground hover:text-destructive shrink-0">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </AppShell>
  )
}

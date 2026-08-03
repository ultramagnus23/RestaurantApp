'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth-provider'
import { useStore } from '@/lib/store'
import { api } from '@/lib/api-client'
import { AppShell } from '@/components/AppShell'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import {
  FlaskConical,
  Plus,
  Play,
  CheckCircle,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

export default function ExperimentsPage() {
  const { user } = useAuth()
  const router = useRouter()
  const { selectedRestaurant } = useStore()
  const [loading, setLoading] = useState(true)
  const [experiments, setExperiments] = useState<any[]>([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({
    experiment_name: '',
    hypothesis: '',
    variable_changed: 'temperature',
    control_condition: '',
    test_condition: '',
    start_time: '',
    end_time: '',
    randomization_unit: 'day',
    primary_metric: 'order_value',
  })

  useEffect(() => {
    if (!user) {
      router.push('/signin')
      return
    }
    if (!selectedRestaurant) {
      router.push('/dashboard')
      return
    }
    loadExperiments()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, selectedRestaurant])

  const loadExperiments = async () => {
    if (!selectedRestaurant) return
    try {
      setLoading(true)
      const res = await api.getExperiments({ restaurantId: selectedRestaurant.id })
      if (res.success) {
        setExperiments(res.data)
      }
    } catch (error: any) {
      console.error('Experiments load error:', error)
      toast.error('Failed to load experiments', { description: error.message })
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = async () => {
    if (!selectedRestaurant) return
    try {
      await api.createExperiment({
        restaurant_id: selectedRestaurant.id,
        ...form,
      })
      setShowForm(false)
      setForm({
        experiment_name: '',
        hypothesis: '',
        variable_changed: 'temperature',
        control_condition: '',
        test_condition: '',
        start_time: '',
        end_time: '',
        randomization_unit: 'day',
        primary_metric: 'order_value',
      })
      loadExperiments()
    } catch (error: any) {
      toast.error(error.message)
    }
  }

  const handleStatusChange = async (id: string, status: string) => {
    try {
      await api.updateExperiment(id, { status })
      loadExperiments()
    } catch (error: any) {
      toast.error(error.message)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this experiment?')) return
    try {
      await api.deleteExperiment(id)
      loadExperiments()
    } catch (error: any) {
      toast.error('Failed to delete experiment', { description: error.message })
    }
  }

  return (
    <AppShell
      title="Experiments"
      description="Design and track experiments to optimize your environment"
      headerActions={
        <Button onClick={() => setShowForm(!showForm)}>
          <Plus className="w-4 h-4 mr-2" />
          New Experiment
        </Button>
      }
    >
      {loading ? (
        <div className="grid gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : (
        <>
        {showForm && (
          <Card>
            <CardHeader>
              <CardTitle>Create Experiment</CardTitle>
              <CardDescription>
                Define your hypothesis and test conditions
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Experiment Name</Label>
                  <Input
                    placeholder="e.g., Jazz Music Evening Trial"
                    value={form.experiment_name}
                    onChange={(e) => setForm({ ...form, experiment_name: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Variable Changed</Label>
                  <select
                    className="w-full px-3 py-2 rounded-md border bg-background text-sm"
                    value={form.variable_changed}
                    onChange={(e) => setForm({ ...form, variable_changed: e.target.value })}
                  >
                    <option value="temperature">Temperature</option>
                    <option value="music_genre">Music Genre</option>
                    <option value="music_volume">Music Volume</option>
                    <option value="lighting">Lighting</option>
                    <option value="staffing">Staffing</option>
                    <option value="promotion">Promotion</option>
                  </select>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Hypothesis</Label>
                <Textarea
                  placeholder="e.g., Playing jazz music between 6PM-9PM will increase average order value by 12%"
                  value={form.hypothesis}
                  onChange={(e) => setForm({ ...form, hypothesis: e.target.value })}
                  rows={3}
                />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Control Condition</Label>
                  <Input
                    placeholder="e.g., No music or pop music"
                    value={form.control_condition}
                    onChange={(e) => setForm({ ...form, control_condition: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Test Condition</Label>
                  <Input
                    placeholder="e.g., Jazz music at volume 5"
                    value={form.test_condition}
                    onChange={(e) => setForm({ ...form, test_condition: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Randomization Unit</Label>
                  <select
                    className="w-full px-3 py-2 rounded-md border bg-background text-sm"
                    value={form.randomization_unit}
                    onChange={(e) => setForm({ ...form, randomization_unit: e.target.value })}
                  >
                    <option value="day">Day (room-wide levers: music, lighting, temperature)</option>
                    <option value="session">Session</option>
                    <option value="table">Table (menu, plateware, plate temperature)</option>
                    <option value="dish">Dish</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>Primary Metric</Label>
                  <select
                    className="w-full px-3 py-2 rounded-md border bg-background text-sm"
                    value={form.primary_metric}
                    onChange={(e) => setForm({ ...form, primary_metric: e.target.value })}
                  >
                    <option value="order_value">Average order value</option>
                    <option value="dwell_time">Dwell time</option>
                    <option value="dessert_count">Dessert attach</option>
                    <option value="drink_count">Beverage attach</option>
                    <option value="clearance_pct">Plate clearance %</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Locked once the experiment starts — pick before collecting data.
                  </p>
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Start Time</Label>
                  <Input
                    type="datetime-local"
                    value={form.start_time}
                    onChange={(e) => setForm({ ...form, start_time: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>End Time</Label>
                  <Input
                    type="datetime-local"
                    value={form.end_time}
                    onChange={(e) => setForm({ ...form, end_time: e.target.value })}
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button onClick={handleCreate}>Create Experiment</Button>
                <Button variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-4">
          {experiments.map((exp) => (
            <Card key={exp.id}>
              <CardContent className="pt-6">
                <div className="flex items-start justify-between">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">{exp.experiment_name}</h3>
                      <Badge
                        variant={
                          exp.status === 'active' ? 'success' :
                          exp.status === 'completed' ? 'default' :
                          exp.status === 'aborted' ? 'danger' : 'outline'
                        }
                      >
                        {exp.status}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">{exp.hypothesis}</p>
                    <div className="text-xs text-muted-foreground space-y-1">
                      <p><strong>Variable:</strong> {exp.variable_changed}</p>
                      <p><strong>Control:</strong> {exp.control_condition || '--'}</p>
                      <p><strong>Test:</strong> {exp.test_condition || '--'}</p>
                      <p><strong>Period:</strong> {new Date(exp.start_time).toLocaleDateString()} - {exp.end_time ? new Date(exp.end_time).toLocaleDateString() : 'Ongoing'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {exp.status === 'planned' && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleStatusChange(exp.id, 'active')}
                        >
                          <Play className="w-3 h-3 mr-1" />
                          Start
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleDelete(exp.id)}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </>
                    )}
                    {exp.status === 'active' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleStatusChange(exp.id, 'completed')}
                      >
                        <CheckCircle className="w-3 h-3 mr-1" />
                        Complete
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {experiments.length === 0 && !showForm && (
          <Card>
            <CardContent className="py-12 text-center">
              <FlaskConical className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
              <p className="text-muted-foreground">No experiments yet. Create your first experiment to start optimizing.</p>
            </CardContent>
          </Card>
        )}
        </>
      )}
    </AppShell>
  )
}

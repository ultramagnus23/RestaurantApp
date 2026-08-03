import { supabase } from './supabase'

export async function fetchAPI<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession()

  const isFormData = options?.body instanceof FormData

  const response = await fetch(`/api${endpoint}`, {
    ...options,
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...options?.headers,
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'An error occurred' }))
    throw new Error(error.message || `API Error: ${response.status}`)
  }

  return response.json()
}

// Trimmed for the diagnostic-tool rebuild (see the "Final Build" plan
// discussion) - methods for the old occupancy/environment/experiments/
// recommendations/cameras/dashboard product are archived (archive/legacy
// branch), not part of this product.
export const api = {
  // Restaurants
  getRestaurants: () => fetchAPI<any>('/restaurants'),
  createRestaurant: (data: { name: string; location: string; timezone?: string }) =>
    fetchAPI<any>('/restaurants', { method: 'POST', body: JSON.stringify(data) }),
  getRestaurant: (id: string) => fetchAPI<any>(`/restaurants/${id}`),
  updateRestaurant: (id: string, data: any) =>
    fetchAPI<any>(`/restaurants/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // CSV ingest (Step 2: interactive column mapping, PII scrub, idempotent re-ingest)
  getColumnMap: (restaurantId: string) =>
    fetchAPI<any>(`/ingest?restaurantId=${encodeURIComponent(restaurantId)}`),
  ingestCsv: (formData: FormData) =>
    fetchAPI<any>('/ingest', { method: 'POST', body: formData }),

  // Dish costs (Step 4: manual entry, the only cost data that exists)
  getDishCosts: (restaurantId: string) =>
    fetchAPI<any>(`/dish-costs?restaurantId=${encodeURIComponent(restaurantId)}`),
  createDishCost: (data: { restaurant_id: string; item: string; cost: number; price: number }) =>
    fetchAPI<any>('/dish-costs', { method: 'POST', body: JSON.stringify(data) }),
  updateDishCost: (id: string, data: { item?: string; cost?: number; price?: number }) =>
    fetchAPI<any>(`/dish-costs/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteDishCost: (id: string) =>
    fetchAPI<any>(`/dish-costs/${id}`, { method: 'DELETE' }),

  // Reports (Steps 6-7: the one-pager)
  getReports: (restaurantId: string) =>
    fetchAPI<any>(`/reports?restaurantId=${encodeURIComponent(restaurantId)}`),
  generateReport: (restaurantId: string) =>
    fetchAPI<any>('/reports', { method: 'POST', body: JSON.stringify({ restaurantId }) }),
  getReport: (id: string) => fetchAPI<any>(`/reports/${id}`),
  updateReportStatus: (id: string, status: 'reviewed' | 'delivered') =>
    fetchAPI<any>(`/reports/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),

  // Devices (Phase 2 phone-sensing pivot - see PIVOT_AUDIT.md)
  getDevices: (params: { restaurantId: string }) =>
    fetchAPI<any>(`/devices?${new URLSearchParams(params as any)}`),
  createDevice: (data: { restaurant_id: string; device_type: 'phone' | 'cctv_bridge'; zone_id?: string | null }) =>
    fetchAPI<any>('/devices', { method: 'POST', body: JSON.stringify(data) }),
  updateDevice: (id: string, data: { zone_id?: string | null; status?: string; rotate_token?: boolean }) =>
    fetchAPI<any>(`/devices/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteDevice: (id: string) =>
    fetchAPI<any>(`/devices/${id}`, { method: 'DELETE' }),

  // Auth
  getSession: () => fetchAPI<any>('/auth/session'),
  signIn: (email: string, password: string) =>
    fetchAPI<any>('/auth/signin', { method: 'POST', body: JSON.stringify({ email, password }) }),
  signUp: (email: string, password: string) =>
    fetchAPI<any>('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password }) }),
  signOut: () =>
    fetchAPI<any>('/auth/signout', { method: 'POST' }),
}

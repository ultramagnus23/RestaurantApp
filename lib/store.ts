import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Restaurant } from './types'

interface AppState {
  selectedRestaurantId: string | null
  setSelectedRestaurantId: (id: string | null) => void

  selectedRestaurant: Restaurant | null
  setSelectedRestaurant: (restaurant: Restaurant | null) => void

  isLoading: boolean
  setIsLoading: (loading: boolean) => void

  theme: 'dark' | 'light'
  setTheme: (theme: 'dark' | 'light') => void
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      selectedRestaurantId: null,
      setSelectedRestaurantId: (id) => set({ selectedRestaurantId: id }),

      selectedRestaurant: null,
      setSelectedRestaurant: (restaurant) => set({ selectedRestaurant: restaurant }),

      isLoading: false,
      setIsLoading: (loading) => set({ isLoading: loading }),

      theme: 'dark',
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: 'meza-storage',
    },
  ),
)

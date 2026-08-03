'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAuth } from '@/components/auth-provider'
import { useStore } from '@/lib/store'
import { api } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  FlaskConical,
  UploadCloud,
  UtensilsCrossed,
  FileText,
  LogOut,
  Building2,
  ChevronsUpDown,
  Menu,
  X,
  Smartphone,
} from 'lucide-react'

const NAV_ITEMS = [
  { href: '/experiments', label: 'Experiments', icon: FlaskConical },
  { href: '/devices', label: 'Devices', icon: Smartphone },
  { href: '/upload', label: 'Import POS data', icon: UploadCloud },
  { href: '/dish-costs', label: 'Dish costs', icon: UtensilsCrossed },
  { href: '/reports', label: 'Reports', icon: FileText },
]

function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="flex-1 space-y-0.5 px-3">
      {NAV_ITEMS.map((item) => {
        const active = pathname === item.href
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors duration-150',
              active
                ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                : 'text-sidebar-foreground/65 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
            )}
          >
            <item.icon
              className={cn('h-4 w-4 shrink-0', active && 'text-primary')}
              strokeWidth={2}
            />
            <span className="truncate">{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

export function AppShell({
  title,
  description,
  headerActions,
  children,
}: {
  title: string
  description?: string
  headerActions?: React.ReactNode
  children: React.ReactNode
}) {
  const { user, signOut } = useAuth()
  const pathname = usePathname()
  const { selectedRestaurant, setSelectedRestaurant } = useStore()
  const [restaurants, setRestaurants] = useState<any[]>([])
  const [showPicker, setShowPicker] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  useEffect(() => {
    api
      .getRestaurants()
      .then((res) => {
        if (res.success) setRestaurants(res.data)
      })
      .catch(() => {})
  }, [])

  const sidebarContent = (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 px-4 pb-3 pt-5">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground font-display font-bold text-xs">
          M
        </div>
        <span className="font-display font-semibold text-[13px] tracking-wide">MEZA</span>
      </div>
      <NavLinks pathname={pathname} onNavigate={() => setMobileNavOpen(false)} />
      <div className="p-3 border-t border-sidebar-border">
        <button
          onClick={() => signOut()}
          className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] text-sidebar-foreground/65 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground transition-colors duration-150"
        >
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-medium">
            {user?.email?.[0]?.toUpperCase() || '?'}
          </div>
          <span className="truncate flex-1 text-left">{user?.email}</span>
          <LogOut className="h-3.5 w-3.5 shrink-0" />
        </button>
      </div>
    </div>
  )

  return (
    <div className="flex min-h-screen">
      {/* Desktop rail - solid, no vibrancy/blur; a floor plan's edge wall,
          not a floating glass panel. */}
      <aside className="hidden md:block w-56 shrink-0 border-r border-sidebar-border">
        <div className="fixed h-screen w-56">{sidebarContent}</div>
      </aside>

      {/* Mobile rail */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0"
            style={{ backgroundColor: 'oklch(0.15 0.02 50 / 0.55)' }}
            onClick={() => setMobileNavOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-64">
            <div className="relative h-full">
              {sidebarContent}
              <button
                onClick={() => setMobileNavOpen(false)}
                className="absolute right-3 top-4 text-sidebar-foreground/70 hover:text-sidebar-foreground"
                aria-label="Close menu"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex flex-1 flex-col min-w-0">
        <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-border bg-background px-4 py-3 sm:px-6">
          <button
            className="md:hidden text-muted-foreground hover:text-foreground"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-[15px] font-display font-semibold tracking-tight truncate">{title}</h1>
              {selectedRestaurant && restaurants.length > 0 && (
                <div className="relative">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 gap-1 px-2 text-xs rounded-full"
                    onClick={() => setShowPicker(!showPicker)}
                  >
                    <Building2 className="w-3 h-3" />
                    {selectedRestaurant.name}
                    <ChevronsUpDown className="w-3 h-3 text-muted-foreground" />
                  </Button>
                  {showPicker && (
                    <div className="absolute left-0 top-full z-20 mt-1 min-w-40 rounded-md border border-border bg-popover p-1 shadow-sm">
                      {restaurants.map((r) => (
                        <button
                          key={r.id}
                          onClick={() => {
                            setSelectedRestaurant(r)
                            setShowPicker(false)
                          }}
                          className={cn(
                            'block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent',
                            r.id === selectedRestaurant.id && 'text-primary',
                          )}
                        >
                          {r.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            {description && <p className="text-[13px] text-muted-foreground mt-0.5">{description}</p>}
          </div>
          {headerActions && <div className="flex items-center gap-2">{headerActions}</div>}
        </header>
        <main className="flex-1 p-4 sm:p-6 space-y-6">{children}</main>
      </div>
    </div>
  )
}

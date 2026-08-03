# Meza Launch Checklist

Verified against the repo on 2026-07-16 (every item below was checked against
actual code/config, not assumed). Corrections to the original draft are
called out inline where the repo turned out to differ from the assumption.

This checklist covers the **original product** (occupancy/environment/
revenue analytics, manual + CSV + optional CV ingestion). It predates the
phone-sensing pivot (`PIVOT_AUDIT.md`, migrations 007-011: experiment lab,
zones/devices/streams/readings, interventions, phone capture page). If the
pivot's features are in scope for this launch, add "apply migrations
007-011" and a real HTTPS deploy (not a dev tunnel) to the blockers below —
not included here since that scope wasn't confirmed as part of this launch.

## Blockers to fix before going live

- [ ] Create a real Supabase project.
- [ ] Run the schema migrations, **in order** — correction: `supabase/setup.sql`
      only covers migrations 001-003 (its own header says so:
      `-- MEZA: combined schema setup (001 + 002 + 003)`). There is no single
      combined file for 004-006. The full sequence for the original product is:
      `supabase/setup.sql`, then `supabase/migrations/004_sensor_fields.sql`,
      `005_recommendation_rule_key.sql`, `006_widen_lighting_temperature.sql`
      individually. (Skip 007-011 unless you're also launching the pivot
      features — see note above.)
- [ ] Set `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or the
      newer `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — both are accepted, see
      `.env.example`) on Vercel/Render.
- [ ] Supabase Auth → turn on **Confirm Email**, set **Site URL** to the real
      domain.
- [ ] Deploy, run one full test cycle: signup → create restaurant → upload
      CSV → dashboard loads.

## Security/reliability hardening

- [ ] Enable Supabase's built-in auth rate limiting (signin/signup spam
      protection). Confirmed still needed: no throttling code exists
      anywhere in the app layer (`app/api/auth/signin/route.ts`,
      `app/api/auth/signup/route.ts` are plain handlers with no rate
      limiting; no `middleware.ts` exists in the repo at all). This has to
      be a Supabase-project-level setting, not app code.
- [ ] Add error monitoring (Sentry client + API routes). Confirmed still
      needed: no `sentry.*.config.*`, no `instrumentation.ts`, no Sentry
      dependency in `package.json`.
- [ ] Build password reset page (Supabase supports it server-side via
      `resetPasswordForEmail()`, no UI exists yet). Confirmed still needed:
      no reset/forgot-password route anywhere under `app/`.
- [ ] Add file-size/row cap + batch inserts on `/api/pos-orders` CSV upload.
      Confirmed still needed, with exact locations: orders are inserted
      one-by-one in a loop (`app/api/pos-orders/route.ts:106-121`), items
      likewise (`:128-145`), and there is no file-size or row-count cap —
      `file.text()` reads the whole upload unconditionally and `Papa.parse`
      has no row limit set. A large CSV is both a slow request and an
      unbounded cost/DoS vector against Supabase's request quota.

## POS data ingestion (Petpooja/other)

- [ ] Get a sample Petpooja CSV export, map its columns to Meza's expected
      format. Confirmed: zero references to Petpooja anywhere in the repo —
      this is entirely new work, not a partially-started integration.
- [ ] Write an adapter script for that mapping.
- [ ] Upload via the existing `/upload` page (works today, no new code
      needed) — confirmed accurate, `app/upload/page.tsx` → `POST
      /api/pos-orders` is fully wired and format-agnostic as long as the
      adapter produces Meza's expected CSV columns.
- [ ] (Later) Apply for Petpooja partner API access for live sync — not
      urgent.

## Not blockers, skip for now

- [ ] CV pipeline (optional hardware add-on, use manual entry instead) —
      still accurate for the original product: the dashboard, revenue
      analytics, experiments, and recommendations all work with zero
      camera hardware. **One update since the original note**: as of the
      phone-sensing pivot, `cv_pipeline/occupancy_detector.py` now also
      writes per-table session detection and zone-occupancy data into the
      same `devices`/`streams`/`readings`/`table_sessions` model the phone
      capture page uses (see `cv_pipeline/README.md`). It's still an
      optional *alternate data source* into that shared model, not a hard
      dependency of anything — the phone capture page and manual entry
      both work without it — but it's no longer accurate to describe it as
      only "the legacy occupancy logger."
- [ ] Multi-user/team roles (single-owner model fine for one restaurant) —
      confirmed unchanged: `restaurants.owner_id` is still the only
      ownership model, no roles table exists through migration 011.
- [ ] README screenshots (cosmetic) — confirmed still placeholder:
      `docs/screenshots/` doesn't exist yet, README's Screenshots section
      still has placeholder instructions rather than real images.

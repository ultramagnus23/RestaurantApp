# Pivot Audit — Phone Sensing + Experimentation Engine

Date: 2026-07-14. This audits the codebase against the pivot: dedicated per-venue
sensor hardware is replaced by (a) a single iPhone running an on-device web
capture page for sound/light/vibration, and (b) the venue's existing CCTV
for occupancy/zone counting. Everything else becomes a manually logged
**intervention**. This document is Phase 0 of a 7-phase pivot; only Phase 0
(this audit + cleanup) and Phase 1 (data model, see
`supabase/migrations/009_pivot_data_model.sql`) are executed as of this
writing. Phases 2-7 are roadmap only — see the bottom of this file.

## Corrections to initial assumptions

The pivot brief that kicked this off assumed two things that turned out to
be false when checked against the actual code. Recording them here so
nobody re-derives the wrong starting point later:

1. **"The camera pipeline does face detection only."** False.
   `cv_pipeline/occupancy_detector.py` already uses Ultralytics YOLOv8n
   filtered to COCO class 0 (person only) — see `load_detector()` and
   `detect_people()`. Its own docstring says it *replaced* an older Caffe
   SSD face/person detector (also documented in `docs/ML_AUDIT.md`). There
   is no face detection anywhere in this repo. The real gap for the pivot
   isn't the detection model, it's that occupancy is written as a single
   flat percentage (`occupancy_snapshots`) with no per-zone breakdown,
   because `cameras.table_regions` is a JSONB array of axis-aligned
   rectangles, not a polygon/zone table.

2. **"`table_sessions` has no writer."** Half-true. There is a fully built,
   auth-gated, RLS-scoped POST route (`app/api/table-sessions/route.ts`)
   and a client wrapper (`lib/api-client.ts`'s `insertTableSession()`) —
   but nothing in the app ever calls it. It's writer-*orphaned*, not
   writer-*less*. The Phase 3 session-detection job should call this
   existing path rather than building a second one.

## Keep / Replace / Delete

### Keep as-is
- `cv_pipeline/occupancy_detector.py` and its Docker/systemd deployment —
  correct foundation for Phase 3 (CCTV zone occupancy). Needs zone-mapping
  added later, not a rewrite.
- `edge_sensors/weather_fetch.py` — real, working OpenWeatherMap
  integration for outdoor weather/AQI. Orthogonal to the pivot; a phone in
  the dining room doesn't replace outdoor weather data.
- `app/api/table-sessions/route.ts` — real, correct, just needs a caller
  (Phase 3).
- `getServerSupabase`/`getServiceSupabase` split (`lib/supabase.ts`), the
  `is_writable_*` RLS demo-mode helper pattern (`003_demo_mode.sql`), the
  sequential migration-numbering convention. All reused as-is for the new
  tables in migration 009.
- `experiments` / `experiment_treatments` / `experiment_assignments`
  (migration 007) — the formal randomized-arm experiment model with its
  danger-zone and primary-metric-lock triggers is untouched. The new
  `interventions` table (below) is deliberately a separate, lighter
  concept for fast operator logging, linked to formal experiments via a
  new `experiments.linked_intervention_ids` column rather than folded in.

### Replace (later phases, not this pass)
- `cameras.table_regions` (flat rectangles) — Phase 1 adds a proper
  `zones` table alongside it without breaking the existing `/cameras`
  page. A later phase migrates rectangles into zone polygons and retires
  `table_regions` once nothing depends on it.
- Whole-app UI — `DESIGN.md` already earmarks a floor-plan feature
  ("Phase B, deferred by explicit user choice," `DESIGN.md:80-86`); this
  pivot un-defers it. Not touched this pass.

### Delete / Park
- `edge_sensors/collector.py` — **parked to `edge_sensors/legacy/collector.py`**
  (git-moved, not deleted, so history is preserved). It implements 5
  hardware sensor adapters (temp/humidity, CO2, PM2.5, lux, sound level)
  wired to a Raspberry Pi; every real adapter raised `NotImplementedError`
  and only `--mock` mode ever worked, so nothing operational is lost.
  `edge_sensors/README.md` and `requirements.txt` updated to reflect that
  only `weather_fetch.py` is active. Do not build against the legacy file.

## No existing ingestion abstraction

There is no transport-agnostic event-store/ingestion layer anywhere in
this codebase — every table has its own bespoke route and field allowlist
(`app/api/environment/route.ts`'s fixed `NUMERIC_FIELDS` array is
typical). The new `streams`/`readings` tables (migration 009) are the
first transport-agnostic ingestion primitive in the codebase. Nothing
existing needs to migrate onto it; it's built clean for Phase 2/3 to use.

## What Phase 1 adds (this pass)

See `supabase/migrations/009_pivot_data_model.sql`:
- `zones` — polygon regions per restaurant, additive alongside `cameras.table_regions`.
- `devices` — registered phone / cctv_bridge capture sources, token-based.
- `streams` — one per (device, signal_type).
- `readings` + `readings_rollup_1m` — append-heavy raw readings and a
  1-minute rollup table for dashboard queries (rollup computation job is
  Phase 2/3 work, not built this pass).
- `interventions` — the lightweight two-tap operator log.
- `experiments.linked_intervention_ids` — additive column linking formal
  experiments to the interventions that constitute their treatment.

`table_sessions` gets no schema change this pass — its production writer
depends on zone-occupancy data from `readings`/`streams` that doesn't
exist yet (Phase 3).

## Roadmap (not built this pass)

- **Phase 2** — phone capture page: QR device-token onboarding (no
  existing precedent — greenfield auth), on-device Web Audio (sound),
  canvas frame sampling (light), DeviceMotion (vibration), IndexedDB
  buffering, Wake Lock. Needs a real iPhone + Safari to verify; not
  something that can be headlessly verified.
- **Phase 3** — CCTV bridge script (ffmpeg snapshot → ingestion API),
  zone-occupancy mapping (replacing flat `occupancy_snapshots` writes with
  per-zone `readings`), session-detection job that finally calls the
  existing `table_sessions` POST route.
- **Phase 4** — experiment engine analysis (matched-window before/after
  comparisons, confound guardrails, the 9-experiment template catalogue).
- **Phase 5** — PAD (arousal/pleasure) interpretation layer, clearly
  labeled as derived, never presented as a direct measurement.
- **Phase 6** — UI rebuild: live SVG floor plan (un-deferring
  `DESIGN.md`'s Phase B), Devices view, Streams view, two-tap intervention
  logger.
- **Phase 7** — end-to-end verification with a real iPhone and a real (or
  synthetic ffmpeg) RTSP stream, `RUNBOOK.md`.

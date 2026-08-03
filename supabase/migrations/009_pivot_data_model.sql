-- ============================================
-- PIVOT DATA MODEL: ZONES, DEVICES, STREAMS, READINGS, INTERVENTIONS
-- ============================================
-- Phase 1 of the phone-sensing pivot - see PIVOT_AUDIT.md at the repo
-- root. Dedicated per-venue sensor hardware is replaced by (a) a phone
-- running an on-device web capture page for sound/light/vibration, and
-- (b) the venue's existing CCTV for occupancy/zone counting. Everything
-- else the phone can't sense becomes a manually logged intervention.
--
-- `restaurants` continues to serve as the venue table (no rename, matches
-- the existing convention). RLS follows the established pattern from
-- 001/003: SELECT via owner-chain, writes via the is_writable_* demo-mode
-- helper functions from 003_demo_mode.sql so the demo restaurant stays
-- read-only at the DB layer.

-- ============================================
-- ZONES
-- ============================================
-- Polygon regions per restaurant, additive alongside the existing flat
-- cameras.table_regions rectangles (002_cameras.sql) - not a replacement
-- yet. A later phase migrates table_regions into zone polygons.

create table zones (
    id uuid primary key default gen_random_uuid(),
    restaurant_id uuid not null references restaurants(id) on delete cascade,
    name text not null,
    -- Fractional (0-1) polygon points, camera-frame-relative: [{"x":0.1,"y":0.2}, ...]
    polygon jsonb not null,
    camera_id uuid references cameras(id) on delete set null,
    created_at timestamptz not null default now()
);

create index idx_zones_restaurant on zones(restaurant_id);

alter table zones enable row level security;

create policy "Owners can view their zones"
    on zones for select
    using (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

create policy "Owners can manage their zones"
    on zones for all
    using (is_writable_restaurant(restaurant_id, auth.uid()))
    with check (is_writable_restaurant(restaurant_id, auth.uid()));

-- ============================================
-- DEVICES
-- ============================================
-- Registered capture sources: a phone running the capture page, or a
-- laptop/box running the CCTV bridge script. `token` is the signed
-- device token carried in the QR code payload - generation is Phase 2;
-- here it's just an opaque unique credential the device presents.

create table devices (
    id uuid primary key default gen_random_uuid(),
    restaurant_id uuid not null references restaurants(id) on delete cascade,
    device_type text not null check (device_type in ('phone', 'cctv_bridge')),
    zone_id uuid references zones(id) on delete set null,
    token text not null unique,
    status text not null default 'pending' check (status in ('pending', 'active', 'offline')),
    last_seen_at timestamptz,
    created_at timestamptz not null default now()
);

create index idx_devices_restaurant on devices(restaurant_id);

alter table devices enable row level security;

create policy "Owners can view their devices"
    on devices for select
    using (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

create policy "Owners can manage their devices"
    on devices for all
    using (is_writable_restaurant(restaurant_id, auth.uid()))
    with check (is_writable_restaurant(restaurant_id, auth.uid()));

-- ============================================
-- STREAMS
-- ============================================
-- One per (device, signal_type). Phone signal types: sound_level_dba,
-- sound_spectrum, light_level, light_color_temp, vibration. CCTV bridge:
-- occupancy_count, zone_occupancy.

create table streams (
    id uuid primary key default gen_random_uuid(),
    device_id uuid not null references devices(id) on delete cascade,
    signal_type text not null check (signal_type in (
        'sound_level_dba', 'sound_spectrum', 'light_level', 'light_color_temp',
        'vibration', 'occupancy_count', 'zone_occupancy'
    )),
    created_at timestamptz not null default now(),
    unique (device_id, signal_type)
);

create index idx_streams_device on streams(device_id);

alter table streams enable row level security;

-- Ownership chain: streams -> devices -> restaurants. Mirrors the
-- experiment_treatments -> experiments -> restaurants pattern in
-- 007_experiment_lab.sql.

create policy "Owners can view their streams"
    on streams for select
    using (device_id in (
        select id from devices where restaurant_id in (
            select id from restaurants where owner_id = auth.uid()
        )
    ));

create policy "Owners can manage their streams"
    on streams for all
    using (device_id in (
        select id from devices where restaurant_id in (
            select id from restaurants where owner_id = auth.uid() and is_demo = false
        )
    ))
    with check (device_id in (
        select id from devices where restaurant_id in (
            select id from restaurants where owner_id = auth.uid() and is_demo = false
        )
    ));

-- ============================================
-- READINGS
-- ============================================
-- Append-heavy raw readings. Phones upload 1 Hz on-device aggregates
-- batched every 15-30s (Phase 2); each batch becomes one or more rows
-- here. value_json shape depends on signal_type (e.g. a scalar for
-- sound_level_dba, a band array for sound_spectrum).

create table readings (
    id uuid primary key default gen_random_uuid(),
    stream_id uuid not null references streams(id) on delete cascade,
    timestamp timestamptz not null,
    value_json jsonb not null,
    created_at timestamptz not null default now()
);

create index idx_readings_stream_time on readings(stream_id, timestamp desc);

alter table readings enable row level security;

create policy "Owners can view their readings"
    on readings for select
    using (stream_id in (
        select s.id from streams s
        join devices d on d.id = s.device_id
        join restaurants r on r.id = d.restaurant_id
        where r.owner_id = auth.uid()
    ));

create policy "Owners can insert readings"
    on readings for insert
    with check (stream_id in (
        select s.id from streams s
        join devices d on d.id = s.device_id
        join restaurants r on r.id = d.restaurant_id
        where r.owner_id = auth.uid() and r.is_demo = false
    ));

-- ============================================
-- READINGS ROLLUP (1-minute)
-- ============================================
-- Rollup computation is Phase 2/3 work (not built this pass) - this
-- table exists now so Phase 1 doesn't need a follow-up migration once
-- that job is written.

create table readings_rollup_1m (
    stream_id uuid not null references streams(id) on delete cascade,
    minute timestamptz not null,
    mean numeric(10,3),
    p50 numeric(10,3),
    p95 numeric(10,3),
    sample_count integer not null,
    primary key (stream_id, minute)
);

alter table readings_rollup_1m enable row level security;

create policy "Owners can view their readings rollups"
    on readings_rollup_1m for select
    using (stream_id in (
        select s.id from streams s
        join devices d on d.id = s.device_id
        join restaurants r on r.id = d.restaurant_id
        where r.owner_id = auth.uid()
    ));

create policy "Owners can manage their readings rollups"
    on readings_rollup_1m for all
    using (stream_id in (
        select s.id from streams s
        join devices d on d.id = s.device_id
        join restaurants r on r.id = d.restaurant_id
        where r.owner_id = auth.uid() and r.is_demo = false
    ))
    with check (stream_id in (
        select s.id from streams s
        join devices d on d.id = s.device_id
        join restaurants r on r.id = d.restaurant_id
        where r.owner_id = auth.uid() and r.is_demo = false
    ));

-- ============================================
-- INTERVENTIONS
-- ============================================
-- The lightweight two-tap operator log: "I turned the AC down", "swapped
-- to the jazz playlist". Deliberately separate from experiments/
-- experiment_treatments (007_experiment_lab.sql), which model formal
-- randomized arms with DB-enforced safety triggers - interventions are
-- fast, unstructured, and everything the phone/CCTV can't sense
-- (temperature, scent, materials, layout, menu) routes through here.

create table interventions (
    id uuid primary key default gen_random_uuid(),
    restaurant_id uuid not null references restaurants(id) on delete cascade,
    timestamp timestamptz not null default now(),
    category text not null check (category in (
        'music', 'lighting', 'temperature', 'scent', 'layout',
        'table_materials', 'menu', 'service_protocol', 'other'
    )),
    description text,
    zone_ids uuid[] not null default '{}',
    logged_by uuid not null references auth.users(id),
    created_at timestamptz not null default now()
);

create index idx_interventions_restaurant_time on interventions(restaurant_id, timestamp desc);

alter table interventions enable row level security;

create policy "Owners can view their interventions"
    on interventions for select
    using (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

create policy "Owners can manage their interventions"
    on interventions for all
    using (is_writable_restaurant(restaurant_id, auth.uid()))
    with check (is_writable_restaurant(restaurant_id, auth.uid()));

-- ============================================
-- EXPERIMENTS: LINK TO INTERVENTIONS
-- ============================================
-- Additive column so a formal experiment (007_experiment_lab.sql) can
-- point at the interventions that constitute its treatment, without
-- touching the existing treatments/assignments/trigger machinery.

alter table experiments add column linked_intervention_ids uuid[] not null default '{}';

-- ============================================
-- INGESTION AUTOMATION: SOURCE_HEALTH, SKEW FLAGGING, INTERRUPTED
-- SESSIONS, ADAPTIVE POLL SCHEDULING, ALIGNMENT VIEW
-- ============================================
-- Reconciled against the actual repo, not the prompt's assumed state -
-- see the "Ingestion Automation" plan discussion. Only §1 (schema) and
-- §2 (SessionTracker writer) of the prior Data Spine phase were actually
-- built; this migration both finishes that phase's deferred alignment
-- view and adds this phase's genuinely new freshness/skew tracking.

-- ============================================
-- A. TABLE_SESSIONS: 'interrupted' STATUS
-- ============================================
-- A session whose zone/camera goes stale for too long must not stay open
-- forever, and must not be closed with a guessed end_time (that would be
-- fabricating data) - 'interrupted' is the honest "we don't know when it
-- really ended" state.

alter table table_sessions drop constraint table_sessions_status_check;
alter table table_sessions add constraint table_sessions_status_check
    check (status in ('open', 'closed', 'merged', 'interrupted'));

-- fn_sync_table_session_status (012_data_spine.sql) must not silently
-- overwrite an interrupted mark back to open/closed the next time
-- anything touches the row - widen its exemption to match 'merged'.
create or replace function fn_sync_table_session_status()
returns trigger as $$
begin
    if new.status not in ('merged', 'interrupted') then
        new.status := case when new.end_time is null then 'open' else 'closed' end;
    end if;
    return new;
end;
$$ language plpgsql;

-- ============================================
-- B. SKEW FLAGGING
-- ============================================
-- Flagged, never dropped, per the ground rules - a flagged-but-stored
-- reading lets alignment exclude it later without losing the fact that
-- something was reported. Applies only to readings/pos_orders, which
-- have a genuine second clock (device/POS-server) distinct from Meza's
-- own server clock. table_sessions is server-authored on one clock
-- (occupancy_detector.py's own process time for both the detection and
-- the HTTP POST), so it has no skew concept to flag.

alter table readings add column skew_suspect boolean not null default false;
alter table pos_orders add column skew_suspect boolean not null default false;

-- ============================================
-- C. SOURCE_HEALTH (new, unified)
-- ============================================
-- One place to answer "is anything stale right now," derived from - not
-- replacing - the three freshness signals that already exist scattered
-- across pos_sync_state.last_synced_at, devices.last_seen_at, and
-- cameras.last_snapshot_at.

create table source_health (
    id uuid primary key default gen_random_uuid(),
    restaurant_id uuid not null references restaurants(id) on delete cascade,
    source_type text not null check (source_type in ('pos', 'cctv_zone', 'phone')),
    -- provider name for 'pos', zone_id (as text) for 'cctv_zone', device_id (as text) for 'phone'
    source_key text not null,
    last_success_at timestamptz,
    status text not null default 'healthy' check (status in ('healthy', 'stale', 'error')),
    last_error text,
    updated_at timestamptz not null default now(),
    unique (restaurant_id, source_type, source_key)
);

create index idx_source_health_restaurant on source_health(restaurant_id);

alter table source_health enable row level security;

create policy "Owners can view their source health"
    on source_health for select
    using (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

-- Writes come from server-side jobs (service-role client: the worker
-- process, occupancy_detector.py, the capture route) - same pattern as
-- ingestion_log. No insert/update policy for regular users.

-- ============================================
-- D. ADAPTIVE POLL SCHEDULING
-- ============================================

alter table pos_sync_state add column next_poll_at timestamptz;

-- ============================================
-- E. ALIGNMENT VIEW
-- ============================================
-- The substrate later phases read from. Plain view, not materialized -
-- at current (demo-scale) data volumes this has zero refresh lag and is
-- the simplest correct choice; materializing on a schedule is a real
-- optimization to make later if/when query latency actually becomes a
-- problem at real volume, not something to guess a cadence for against
-- near-zero rows today. Pure join + aggregate for the join grain itself -
-- no derived metrics beyond that.

-- Grain is deliberately NOT a single flat (restaurant, zone, hour) grid.
-- pos_orders has no zone_id - revenue is restaurant-wide, not per-zone -
-- so smearing a restaurant-hour's revenue across every zone active that
-- hour would let a naive sum over zone rows double- (or N-times-) count
-- it. Zone rows (zone_id not null) carry session/reading aggregates only;
-- a separate zone_id-null row per restaurant-hour carries POS aggregates.
-- This is the honest shape for what's actually joinable, not a forced
-- single grid.

create view v_restaurant_hourly_activity as
with zone_hours as (
    select distinct restaurant_id, zone_id, date_trunc('hour', start_time) as hour_bucket
    from table_sessions
    where zone_id is not null
    union
    select distinct d.restaurant_id, d.zone_id, date_trunc('hour', r.timestamp) as hour_bucket
    from readings r
    join streams s on s.id = r.stream_id
    join devices d on d.id = s.device_id
    where d.zone_id is not null
),
sessions_agg as (
    select
        restaurant_id,
        zone_id,
        date_trunc('hour', start_time) as hour_bucket,
        count(*) as session_count,
        avg(dwell_time) as avg_dwell_minutes,
        avg(occupancy_estimate) as avg_occupancy_estimate
    from table_sessions
    where zone_id is not null
    group by restaurant_id, zone_id, date_trunc('hour', start_time)
),
readings_agg as (
    -- value_json shape varies by signal_type: scalar phone readings
    -- (sound_level_dba, light_level, etc.) store {"value": N}
    -- (app/api/capture/[token]/readings/route.ts), occupancy_count
    -- stores {"count": N} (cv_pipeline/occupancy_detector.py). Both are
    -- genuinely scalar and safe to average; zone_occupancy ({"zones": {...}})
    -- and sound_spectrum (a band array/object) are inherently multi-value
    -- and intentionally yield null here rather than a meaningless
    -- collapsed number - the coalesce doesn't reach for a third key to
    -- force a value out of those.
    select
        d.restaurant_id,
        d.zone_id,
        s.signal_type,
        date_trunc('hour', r.timestamp) as hour_bucket,
        avg(coalesce((r.value_json->>'value')::numeric, (r.value_json->>'count')::numeric)) as mean_value,
        count(*) as sample_count
    from readings r
    join streams s on s.id = r.stream_id
    join devices d on d.id = s.device_id
    where not r.skew_suspect and d.zone_id is not null
    group by d.restaurant_id, d.zone_id, s.signal_type, date_trunc('hour', r.timestamp)
),
pos_agg as (
    select
        restaurant_id,
        date_trunc('hour', timestamp) as hour_bucket,
        sum(total_amount) as gross_revenue,
        count(*) as order_count
    from pos_orders
    where status = 'COMPLETED' and not skew_suspect
    group by restaurant_id, date_trunc('hour', timestamp)
)
select
    zh.restaurant_id,
    zh.zone_id,
    zh.hour_bucket,
    sa.session_count,
    sa.avg_dwell_minutes,
    sa.avg_occupancy_estimate,
    ra.signal_type,
    ra.mean_value as reading_mean_value,
    ra.sample_count as reading_sample_count,
    null::numeric as gross_revenue,
    null::bigint as order_count
from zone_hours zh
left join sessions_agg sa
    on sa.restaurant_id = zh.restaurant_id and sa.zone_id = zh.zone_id and sa.hour_bucket = zh.hour_bucket
left join readings_agg ra
    on ra.restaurant_id = zh.restaurant_id and ra.zone_id = zh.zone_id and ra.hour_bucket = zh.hour_bucket
union all
select
    restaurant_id,
    null::uuid as zone_id,
    hour_bucket,
    null::bigint as session_count,
    null::numeric as avg_dwell_minutes,
    null::numeric as avg_occupancy_estimate,
    null::text as signal_type,
    null::numeric as reading_mean_value,
    null::bigint as reading_sample_count,
    gross_revenue,
    order_count
from pos_agg;

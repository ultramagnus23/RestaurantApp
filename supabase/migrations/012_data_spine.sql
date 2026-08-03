-- ============================================
-- DATA SPINE: ZONE UNIFICATION, SESSION CONFIDENCE, POS PROVENANCE,
-- SYNC STATE, INGESTION LOG, PARTITIONED READINGS
-- ============================================
-- Reconciled against the actual repo (not built from a blank spec) - see
-- the "Data Spine" plan discussion. Extends existing tables (zones,
-- table_sessions, streams, pos_orders) rather than duplicating them with
-- parallel tables of a different shape. Only three tables here are
-- genuinely new: pos_sync_state, ingestion_log, pos_credentials.

-- ============================================
-- A. ZONES: TYPE CLASSIFICATION + BACKFILL FROM table_regions
-- ============================================
-- Unifies the two previously-parallel zone-config formats
-- (cameras.table_regions rectangles, zones.polygon room areas) into one
-- going forward: every table_regions rectangle becomes a type='table'
-- zone (as a degenerate 4-point polygon), so table_sessions can finally
-- reference a real zone_id instead of a bare table_number.

alter table zones add column type text
    check (type in ('table', 'queue', 'bar', 'entry', 'floor'));

-- Backfill: one type='table' zone per existing table_regions entry.
-- Existing room-area zones (already inserted rows, if any) are left with
-- type = null rather than guessed - a wrong guess is worse than an
-- honest gap here.
insert into zones (restaurant_id, name, polygon, camera_id, type)
select
    c.restaurant_id,
    'Table ' || (region->>'table_number'),
    jsonb_build_array(
        jsonb_build_object('x', (region->>'x1')::numeric, 'y', (region->>'y1')::numeric),
        jsonb_build_object('x', (region->>'x2')::numeric, 'y', (region->>'y1')::numeric),
        jsonb_build_object('x', (region->>'x2')::numeric, 'y', (region->>'y2')::numeric),
        jsonb_build_object('x', (region->>'x1')::numeric, 'y', (region->>'y2')::numeric)
    ),
    c.id,
    'table'
from cameras c, jsonb_array_elements(c.table_regions) as region
where c.table_regions is not null and jsonb_array_length(c.table_regions) > 0;

-- ============================================
-- B. TABLE_SESSIONS: ZONE LINK + CONFIDENCE-BEARING OCCUPANCY + LIFECYCLE
-- ============================================
-- Keeps start_time/end_time as-is rather than renaming to started_at/
-- ended_at (touches SessionTracker, the dashboard, recommendation-engine,
-- seed scripts, and the table-sessions API route for no behavioral gain).

alter table table_sessions add column zone_id uuid references zones(id) on delete set null;

-- occupancy_estimate/detection_confidence are distinct from party_size:
-- party_size is manual/POS-reported, these are CV-derived and nullable by
-- default - never fabricated when there's no detection to back them.
alter table table_sessions add column occupancy_estimate numeric(4,1);
alter table table_sessions add column detection_confidence numeric(4,3)
    check (detection_confidence is null or (detection_confidence >= 0 and detection_confidence <= 1));

alter table table_sessions add column source text;
update table_sessions set source = 'manual' where source is null;
alter table table_sessions alter column source set not null;
alter table table_sessions alter column source set default 'manual';
alter table table_sessions add constraint table_sessions_source_check
    check (source in ('cctv', 'manual'));

alter table table_sessions add column status text;
update table_sessions set status = case when end_time is null then 'open' else 'closed' end
    where status is null;
alter table table_sessions alter column status set not null;
alter table table_sessions alter column status set default 'closed';
alter table table_sessions add constraint table_sessions_status_check
    check (status in ('open', 'closed', 'merged'));

-- Column default alone isn't enough: it only applies when a caller omits
-- status entirely, and every future insert/update path (SessionTracker,
-- the manual table-sessions API route, seed scripts) would otherwise need
-- to remember to derive it from end_time correctly every time. Verified
-- this gap directly against a real Postgres instance while testing this
-- migration - a row inserted with end_time null and status omitted got
-- the literal 'closed' default despite being an open session. A trigger
-- makes status always consistent with end_time, at every call site,
-- without relying on any of them to get it right. 'merged' is the one
-- state that can't be derived from end_time alone, so it passes through
-- unchanged.
create or replace function fn_sync_table_session_status()
returns trigger as $$
begin
    if new.status is distinct from 'merged' then
        new.status := case when new.end_time is null then 'open' else 'closed' end;
    end if;
    return new;
end;
$$ language plpgsql;

create trigger trg_sync_table_session_status
    before insert or update on table_sessions
    for each row execute function fn_sync_table_session_status();

create index idx_table_sessions_restaurant_zone_time
    on table_sessions(restaurant_id, zone_id, start_time);

-- ============================================
-- C. STREAMS: ADD music_tempo_bpm SIGNAL TYPE
-- ============================================
-- sound_db/lux_est from the phone adapter map onto the *existing*
-- sound_level_dba/light_level types at the adapter layer, not as new
-- duplicate types. temp_c is deliberately not added here - no phone
-- sensor produces it; see app/api/capture/[token]/readings/route.ts.

alter table streams drop constraint streams_signal_type_check;
alter table streams add constraint streams_signal_type_check
    check (signal_type in (
        'sound_level_dba', 'sound_spectrum', 'light_level', 'light_color_temp',
        'vibration', 'occupancy_count', 'zone_occupancy', 'music_tempo_bpm'
    ));

-- ============================================
-- D. POS_ORDERS: PROVENANCE + IDEMPOTENCY
-- ============================================

alter table pos_orders add column pos_provider text;
update pos_orders set pos_provider = 'csv' where pos_provider is null;
alter table pos_orders alter column pos_provider set not null;
alter table pos_orders alter column pos_provider set default 'csv';

alter table pos_orders add column raw_payload jsonb;

-- Postgres unique constraints permit multiple nulls, so CSV rows without
-- a stable external_id don't collide with each other.
alter table pos_orders add constraint pos_orders_provider_external_unique
    unique (pos_provider, external_id);

-- ============================================
-- E. POS_SYNC_STATE (new)
-- ============================================

create table pos_sync_state (
    pos_provider text not null,
    restaurant_id uuid not null references restaurants(id) on delete cascade,
    last_synced_at timestamptz,
    cursor text,
    status text not null default 'idle' check (status in ('idle', 'syncing', 'error')),
    primary key (pos_provider, restaurant_id)
);

alter table pos_sync_state enable row level security;

create policy "Owners can view their pos sync state"
    on pos_sync_state for select
    using (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

create policy "Owners can manage their pos sync state"
    on pos_sync_state for all
    using (is_writable_restaurant(restaurant_id, auth.uid()))
    with check (is_writable_restaurant(restaurant_id, auth.uid()));

-- ============================================
-- F. INGESTION_LOG (new)
-- ============================================
-- restaurant_id is nullable: some ingestion runs (e.g. a cron sweep
-- across all restaurants before per-restaurant work starts) don't have a
-- single restaurant to scope to yet.

create table ingestion_log (
    id uuid primary key default gen_random_uuid(),
    source text not null,
    restaurant_id uuid references restaurants(id) on delete cascade,
    rows_in integer not null default 0,
    rows_written integer not null default 0,
    rows_skipped integer not null default 0,
    error text,
    ran_at timestamptz not null default now()
);

create index idx_ingestion_log_restaurant_time on ingestion_log(restaurant_id, ran_at desc)
    where restaurant_id is not null;

alter table ingestion_log enable row level security;

create policy "Owners can view their ingestion log"
    on ingestion_log for select
    using (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

-- Writes come from server-side ingestion jobs (service-role client,
-- bypasses RLS by design - same pattern as cv_pipeline/edge_sensors). No
-- insert policy for regular users; this table is observability output,
-- not something a restaurant owner writes to directly.

-- ============================================
-- G. POS_CREDENTIALS (new)
-- ============================================
-- Required for RistaAdapter to be real for more than one tenant - env
-- vars only work for a single deployment-wide credential, but Meza is
-- multi-tenant and each restaurant has its own Rista account.
--
-- SECURITY NOTE: api_key/api_secret are stored as plain columns behind
-- owner-only RLS, not encrypted at rest. Proper encryption (Supabase
-- Vault / pgsodium) is flagged as necessary follow-up hardening, not
-- built in this pass - matching this codebase's existing pattern of
-- scoping security work honestly rather than half-implementing crypto.
-- Do not treat this table as sufficient for real customer credentials
-- without that follow-up.

create table pos_credentials (
    id uuid primary key default gen_random_uuid(),
    restaurant_id uuid not null references restaurants(id) on delete cascade,
    provider text not null check (provider in ('rista', 'petpooja', 'posist')),
    api_key text,
    api_secret text,
    created_at timestamptz not null default now(),
    unique (restaurant_id, provider)
);

alter table pos_credentials enable row level security;

create policy "Owners can view their pos credentials"
    on pos_credentials for select
    using (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

create policy "Owners can manage their pos credentials"
    on pos_credentials for all
    using (is_writable_restaurant(restaurant_id, auth.uid()))
    with check (is_writable_restaurant(restaurant_id, auth.uid()));

-- ============================================
-- H. READINGS: CONVERT TO MONTHLY RANGE PARTITIONING
-- ============================================
-- readings is the actual high-frequency time-series (sensor_readings
-- equivalent) - the only table partitioned this pass. table_sessions/
-- pos_orders partitioning is deferred; the prompt's own "as they grow"
-- phrasing scopes it that way, and both have real FK dependents
-- (experiment_treatments, pos_order_items) that make converting them
-- later, non-trivial surgery not justified at current (demo-scale)
-- volume.
--
-- Monthly range over restaurant_id list-partitioning: dashboard/insight
-- queries are always time-windowed ("last N days"), so time-range
-- partitioning gives pruning benefits queries actually hit, and monthly
-- partitions support clean data lifecycle (old partitions droppable).
-- restaurant_id partitioning would need an unbounded, ever-growing
-- partition count as restaurants are added and doesn't help queries that
-- are already restaurant_id-scoped by RLS regardless.
--
-- Partitioned tables require the partition key in every unique index, so
-- readings' primary key becomes composite (id, timestamp) instead of
-- bare id. Checked: nothing in this codebase queries/references
-- readings.id in isolation (only ever alongside stream_id/timestamp), so
-- this has no known call-site impact.
--
-- RLS policies apply automatically to every partition in Postgres 12+ -
-- no per-partition policy duplication needed.

alter table readings rename to readings_old;
-- Renaming a table does not rename its indexes - without this, the new
-- index below collides with the old one's name (index names are unique
-- per schema, not per table).
alter index idx_readings_stream_time rename to idx_readings_stream_time_old;

create table readings (
    id uuid not null default gen_random_uuid(),
    stream_id uuid not null references streams(id) on delete cascade,
    timestamp timestamptz not null,
    value_json jsonb not null,
    created_at timestamptz not null default now(),
    primary key (id, timestamp)
) partition by range (timestamp);

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

-- Bootstrap partitions: previous month through 3 months ahead, plus a
-- default catch-all so an out-of-range insert never fails outright.
-- Creating future partitions on an ongoing basis is a maintenance job,
-- not built this pass (noted as follow-up, same as the readings_rollup_1m
-- computation job).
do $$
declare
    month_start date;
    partition_name text;
begin
    for i in -1..3 loop
        month_start := date_trunc('month', now())::date + (i || ' months')::interval;
        partition_name := 'readings_' || to_char(month_start, 'YYYY_MM');
        execute format(
            'create table if not exists %I partition of readings for values from (%L) to (%L)',
            partition_name, month_start, month_start + interval '1 month'
        );
    end loop;
end $$;

-- Default partition must exist before migrating old data - any row whose
-- timestamp falls outside the bootstrapped ±1/+3 month range above needs
-- somewhere to land, or the insert below fails outright.
create table readings_default partition of readings default;

-- Migrate existing rows from the old (unpartitioned) table, then drop it.
insert into readings (id, stream_id, timestamp, value_json, created_at)
select id, stream_id, timestamp, value_json, created_at from readings_old;

drop table readings_old;

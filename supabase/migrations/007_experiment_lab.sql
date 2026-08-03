-- ============================================
-- MEZA LAB: EXPERIMENT ENGINE UPGRADE
-- ============================================
-- Upgrades the existing single-arm before/after `experiments` table into a
-- randomized, multi-arm experimentation engine: treatments (arms), unit-level
-- assignments with compliance tracking, and a thermal reading chain. See
-- docs discussion "Meza as the Lab" for the research/product rationale.
--
-- Two safety invariants are enforced as triggers, not app-layer checks, so
-- they cannot be bypassed by a script hitting Postgres directly:
--   1. No treatment may claim a hold temperature inside the FDA/USDA
--      "danger zone" (4-60 C).
--   2. A primary_metric cannot be changed once an experiment has left the
--      'planned' status (pre-registration lock).

-- ============================================
-- A. EXTEND EXISTING `experiments` TABLE
-- ============================================

alter table experiments add column if not exists randomization_unit text;

-- Backfill: every experiment created before this migration was a room-wide
-- atmospherics change (music/lighting/temperature toggled for a service
-- window), i.e. day-level randomization - see scripts/seed-experiment-templates.mjs.
update experiments set randomization_unit = 'day' where randomization_unit is null;

alter table experiments alter column randomization_unit set not null;
alter table experiments add constraint experiments_randomization_unit_check
    check (randomization_unit in ('session', 'day', 'table', 'dish'));

alter table experiments add column if not exists primary_metric text;

-- Backfill placeholder for pre-Lab experiments; the real value going forward
-- must be supplied at creation time (see app/api/experiments/route.ts).
update experiments set primary_metric = 'revenue_delta' where primary_metric is null;

alter table experiments alter column primary_metric set not null;
alter table experiments add column if not exists primary_metric_locked_at timestamptz;

-- Default includes 'return_rate' so the check below can never be violated by
-- an insert that simply omits the column - return rate is the metric of
-- record on every experiment (a treatment that raises tonight's bill but
-- cuts return visits must always be visible).
alter table experiments add column if not exists secondary_metrics text[] not null default '{return_rate}';

alter table experiments add constraint experiments_secondary_metrics_return_rate_check
    check ('return_rate' = any(secondary_metrics));

alter table experiments add column if not exists min_detectable_effect numeric(6,3);

-- Fixes app/api/experiments/route.ts's `.order('created_at', ...)`, which
-- previously referenced a column that did not exist on this table.
alter table experiments add column if not exists created_at timestamptz not null default now();

-- ============================================
-- B. EXPERIMENT TREATMENTS (ARMS)
-- ============================================

create table experiment_treatments (
    id uuid primary key default gen_random_uuid(),
    experiment_id uuid not null references experiments(id) on delete cascade,
    label text not null,
    is_control boolean not null default false,
    -- Freeform per-lever config, e.g. {"tempo_bpm_max": 90} for a music arm
    -- or {"hold_temp_c": 4} for a thermal arm. `hold_temp_c`, when present,
    -- is the one key the danger-zone trigger below inspects.
    config jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index idx_experiment_treatments_experiment on experiment_treatments(experiment_id);

alter table experiment_treatments enable row level security;

create policy "Owners can view their experiment treatments"
    on experiment_treatments for select
    using (experiment_id in (
        select id from experiments where restaurant_id in (
            select id from restaurants where owner_id = auth.uid()
        )
    ));

-- Writes use is_writable_experiment (003_demo_mode.sql) so the demo
-- account stays read-only, matching every other table's write policies.
create policy "Owners can manage their experiment treatments"
    on experiment_treatments for all
    using (is_writable_experiment(experiment_id, auth.uid()))
    with check (is_writable_experiment(experiment_id, auth.uid()));

-- ============================================
-- C. EXPERIMENT ASSIGNMENTS (RANDOMIZATION UNITS)
-- ============================================

create table experiment_assignments (
    id uuid primary key default gen_random_uuid(),
    experiment_id uuid not null references experiments(id) on delete cascade,
    treatment_id uuid not null references experiment_treatments(id) on delete cascade,
    -- Shape depends on the parent experiment's randomization_unit:
    -- 'day' -> ISO date ('2026-07-14'), 'table' -> table number ('12'),
    -- 'dish' -> dish name, 'session' -> a session/ticket identifier.
    -- Validated against experiments.randomization_unit by a trigger below.
    unit_key text not null,
    assigned_for timestamptz not null default now(),
    compliance_confirmed boolean not null default false,
    compliance_note text,
    created_at timestamptz not null default now(),
    unique (experiment_id, unit_key)
);

create index idx_experiment_assignments_experiment on experiment_assignments(experiment_id);
create index idx_experiment_assignments_treatment on experiment_assignments(treatment_id);

alter table experiment_assignments enable row level security;

create policy "Owners can view their experiment assignments"
    on experiment_assignments for select
    using (experiment_id in (
        select id from experiments where restaurant_id in (
            select id from restaurants where owner_id = auth.uid()
        )
    ));

create policy "Owners can manage their experiment assignments"
    on experiment_assignments for all
    using (is_writable_experiment(experiment_id, auth.uid()))
    with check (is_writable_experiment(experiment_id, auth.uid()));

-- ============================================
-- D. THERMAL READINGS
-- ============================================

create table thermal_readings (
    id uuid primary key default gen_random_uuid(),
    restaurant_id uuid not null references restaurants(id) on delete cascade,
    experiment_id uuid references experiments(id) on delete set null,
    table_number integer,
    dish_name text,
    stage text not null check (stage in ('at_pass', 'at_table')),
    temp_c numeric(5,2) not null,
    recorded_at timestamptz not null default now(),
    source text not null default 'ir_manual' check (source in ('ir_manual', 'ir_sensor')),
    created_at timestamptz not null default now()
);

create index idx_thermal_readings_restaurant_time on thermal_readings(restaurant_id, recorded_at desc);
create index idx_thermal_readings_experiment on thermal_readings(experiment_id) where experiment_id is not null;

alter table thermal_readings enable row level security;

create policy "Owners can view their thermal readings"
    on thermal_readings for select
    using (restaurant_id in (
        select id from restaurants where owner_id = auth.uid()
    ));

create policy "Owners can insert thermal readings"
    on thermal_readings for insert
    with check (is_writable_restaurant(restaurant_id, auth.uid()));

-- ============================================
-- E. SAFETY TRIGGER 1: THERMAL DANGER-ZONE GUARD
-- ============================================
-- FDA/USDA: food must be hot-held at >=60 C or cold-held at <=4-5 C. Holding
-- between 4 C and 60 C ("the danger zone") lets bacteria double in ~20 min.
-- This must be impossible to bypass via direct DB access, hence a trigger
-- rather than an app-layer check - see conversation with Chaitanya, 2026-07-13.

create or replace function fn_check_thermal_danger_zone()
returns trigger as $$
declare
    v_temp numeric;
begin
    v_temp := (new.config->>'hold_temp_c')::numeric;
    if v_temp is not null and v_temp > 4 and v_temp < 60 then
        raise exception
            'Unsafe hold temperature %°C: food cannot be held between 4°C and 60°C '
            '(the FDA/USDA "danger zone" - bacteria can double in ~20 minutes). '
            'Hot-hold at >=60°C or cold-hold at <=4°C.', v_temp
            using errcode = '23514'; -- check_violation
    end if;
    return new;
end;
$$ language plpgsql;

create trigger trg_check_thermal_danger_zone
    before insert or update on experiment_treatments
    for each row execute function fn_check_thermal_danger_zone();

-- ============================================
-- F. SAFETY TRIGGER 2: PRIMARY METRIC LOCK
-- ============================================
-- A pre-registered primary metric must not change once an experiment has
-- left 'planned' status, to prevent post-hoc metric shopping.

create or replace function fn_lock_primary_metric()
returns trigger as $$
begin
    if new.status <> 'planned' and new.primary_metric is distinct from old.primary_metric then
        raise exception
            'primary_metric is locked once an experiment leaves "planned" status '
            '(current status: %). Pre-registered metric: %.', new.status, old.primary_metric
            using errcode = '23514';
    end if;

    if old.status = 'planned' and new.status <> 'planned' and new.primary_metric_locked_at is null then
        new.primary_metric_locked_at := now();
    end if;

    return new;
end;
$$ language plpgsql;

create trigger trg_lock_primary_metric
    before update on experiments
    for each row execute function fn_lock_primary_metric();

-- ============================================
-- G. ASSIGNMENT UNIT-SHAPE GUARD
-- ============================================
-- Prevents a room-wide lever (randomization_unit='day') from receiving a
-- table-level assignment or vice versa, by validating unit_key's shape
-- against the parent experiment's declared randomization_unit.

create or replace function fn_check_assignment_unit()
returns trigger as $$
declare
    v_unit text;
begin
    select randomization_unit into v_unit from experiments where id = new.experiment_id;

    if v_unit is null then
        raise exception 'experiment % not found', new.experiment_id;
    end if;

    if v_unit = 'day' and new.unit_key !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception
            'experiment % is randomized at the day level; unit_key must be an ISO date '
            '(YYYY-MM-DD), got %', new.experiment_id, new.unit_key
            using errcode = '23514';
    elsif v_unit = 'table' and new.unit_key !~ '^\d+$' then
        raise exception
            'experiment % is randomized at the table level; unit_key must be a table '
            'number, got %', new.experiment_id, new.unit_key
            using errcode = '23514';
    elsif v_unit in ('dish', 'session') and length(trim(new.unit_key)) = 0 then
        raise exception
            'experiment % requires a non-empty unit_key for %-level randomization',
            new.experiment_id, v_unit
            using errcode = '23514';
    end if;

    return new;
end;
$$ language plpgsql;

create trigger trg_check_assignment_unit
    before insert or update on experiment_assignments
    for each row execute function fn_check_assignment_unit();

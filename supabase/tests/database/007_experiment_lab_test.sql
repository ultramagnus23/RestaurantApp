-- pgTAP tests for supabase/migrations/007_experiment_lab.sql
-- Run with the Supabase CLI: `supabase test db` (requires Docker; if you
-- haven't already, `supabase init` once to generate config.toml, then
-- `supabase start` before the first run).
--
-- Covers the two safety triggers that must never be bypassable:
--   1. Thermal danger-zone guard on experiment_treatments.config->>'hold_temp_c'
--   2. primary_metric lock on experiments once status leaves 'planned'
-- Plus the mandatory-return_rate check and the assignment unit-shape guard.
--
-- Note on test (e) as originally specified ("reject an experiment_treatments
-- row missing return_rate from secondary_metrics"): secondary_metrics lives
-- on `experiments`, not `experiment_treatments` (see 007_experiment_lab.sql
-- section A) - there is no secondary_metrics column on experiment_treatments
-- to violate. This test instead exercises an `experiments` insert missing
-- return_rate, which is where the constraint actually lives.

begin;
select plan(8);

create extension if not exists pgtap;

-- ============================================
-- FIXTURES
-- ============================================

insert into auth.users (id, instance_id, aud, role, email)
values (
    '11111111-1111-1111-1111-111111111111',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'owner@test.local'
)
on conflict (id) do nothing;

insert into restaurants (id, owner_id, name, location)
values (
    '22222222-2222-2222-2222-222222222222',
    '11111111-1111-1111-1111-111111111111',
    'Test Restaurant',
    'Test City'
);

insert into experiments (
    id, restaurant_id, experiment_name, hypothesis, variable_changed,
    start_time, randomization_unit, primary_metric
)
values (
    '33333333-3333-3333-3333-333333333333',
    '22222222-2222-2222-2222-222222222222',
    'Test Experiment',
    'Test hypothesis',
    'test_variable',
    now(),
    'day',
    'dwell_time_delta'
);

-- ============================================
-- (a) reject hold_temp_c inside the danger zone (4 < temp < 60)
-- ============================================

select throws_ok(
    $$insert into experiment_treatments (experiment_id, label, config)
      values ('33333333-3333-3333-3333-333333333333', 'Bad arm', '{"hold_temp_c": 30}'::jsonb)$$,
    '23514',
    null,
    'rejects hold_temp_c=30 (inside the 4-60C danger zone)'
);

-- ============================================
-- (b) allow 3 (cold-hold safe) and 65 (hot-hold safe)
-- ============================================

select lives_ok(
    $$insert into experiment_treatments (experiment_id, label, config)
      values ('33333333-3333-3333-3333-333333333333', 'Cold arm', '{"hold_temp_c": 3}'::jsonb)$$,
    'allows hold_temp_c=3 (cold-hold safe)'
);

select lives_ok(
    $$insert into experiment_treatments (experiment_id, label, config)
      values ('33333333-3333-3333-3333-333333333333', 'Hot arm', '{"hold_temp_c": 65}'::jsonb)$$,
    'allows hold_temp_c=65 (hot-hold safe)'
);

-- ============================================
-- (c) reject changing primary_metric after status leaves 'planned'
-- ============================================

update experiments set status = 'running'
    where id = '33333333-3333-3333-3333-333333333333';

select throws_ok(
    $$update experiments set primary_metric = 'revenue_delta'
      where id = '33333333-3333-3333-3333-333333333333'$$,
    '23514',
    null,
    'rejects primary_metric change after status left planned'
);

-- ============================================
-- (d) allow changing secondary_metrics after the primary_metric lock
-- ============================================

select lives_ok(
    $$update experiments set secondary_metrics = array['return_rate', 'dwell_time_delta']
      where id = '33333333-3333-3333-3333-333333333333'$$,
    'allows secondary_metrics change after primary_metric lock'
);

-- ============================================
-- (e) reject an experiments insert missing return_rate in secondary_metrics
-- (relocated from experiment_treatments - see header note)
-- ============================================

select throws_ok(
    $$insert into experiments (
        restaurant_id, experiment_name, hypothesis, variable_changed,
        start_time, randomization_unit, primary_metric, secondary_metrics
      ) values (
        '22222222-2222-2222-2222-222222222222', 'No return rate exp', 'h', 'v',
        now(), 'day', 'dwell_time_delta', array['dessert_delta']
      )$$,
    '23514',
    null,
    'rejects experiments insert whose secondary_metrics omits return_rate'
);

-- ============================================
-- Bonus: assignment unit-shape guard (section G)
-- ============================================

insert into experiment_treatments (id, experiment_id, label, config)
values (
    '44444444-4444-4444-4444-444444444444',
    '33333333-3333-3333-3333-333333333333',
    'Control',
    '{}'::jsonb
);

select throws_ok(
    $$insert into experiment_assignments (experiment_id, treatment_id, unit_key)
      values ('33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', '12')$$,
    '23514',
    null,
    'rejects a table-shaped unit_key on a day-randomized experiment'
);

select lives_ok(
    $$insert into experiment_assignments (experiment_id, treatment_id, unit_key)
      values ('33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', '2026-07-14')$$,
    'allows an ISO-date unit_key on a day-randomized experiment'
);

select * from finish();
rollback;

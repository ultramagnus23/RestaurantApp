-- ============================================
-- EXPERIMENT 001 INSTRUMENTATION: PASS-TO-TABLE
-- ============================================
-- The smallest possible addition for Experiment 001 (pass-to-table latency
-- vs. plate clearance and satisfaction): two nullable, staff-entered columns
-- on table_sessions. No new table, no CV work.
--
--   pass_time     when the dish left the kitchen pass (KDS tap / POS webhook)
--   clearance_pct bussing-staff estimate of how much of the plate was eaten
--
-- Pass-to-table latency is then derivable as the gap between pass_time and
-- the table's serve/first-bite proxy; nothing here manipulates the diner -
-- this is pure measurement of variation that already occurs.

alter table table_sessions
    add column pass_time timestamptz,
    add column clearance_pct numeric(5,2)
        check (clearance_pct is null or (clearance_pct >= 0 and clearance_pct <= 100));

comment on column table_sessions.pass_time is
    'When the (first/hero) dish left the kitchen pass. Staff-logged; nullable because most historical sessions predate this instrumentation.';
comment on column table_sessions.clearance_pct is
    'Bussing-staff estimate (0-100) of how much of the plate was consumed. Proxy for satisfaction that does not rely on self-report.';

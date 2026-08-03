-- ============================================
-- INTERVENTIONS: DEVICE ATTRIBUTION
-- ============================================
-- Phase 2 of the phone-sensing pivot (see PIVOT_AUDIT.md) puts the
-- intervention logger on the same unauthenticated, token-based capture
-- page as sensor capture - there is no Supabase user session to satisfy
-- interventions.logged_by (not null references auth.users). Interventions
-- logged from the phone attribute to the device instead of a named owner.

alter table interventions alter column logged_by drop not null;

alter table interventions add column logged_by_device_id uuid references devices(id) on delete set null;

alter table interventions add constraint interventions_logged_by_check
    check (logged_by is not null or logged_by_device_id is not null);

create index idx_interventions_device on interventions(logged_by_device_id) where logged_by_device_id is not null;

-- RLS: interventions logged via a device token are inserted using the
-- service-role client (app/api/capture/[token]/interventions/route.ts),
-- which bypasses RLS by design - same pattern as cv_pipeline and
-- edge_sensors/weather_fetch.py writing on behalf of an unattended
-- device. No policy change needed; the existing owner-chain SELECT/write
-- policies from 009_pivot_data_model.sql already cover the owner's view
-- of device-logged interventions.

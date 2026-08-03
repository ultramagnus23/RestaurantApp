-- ============================================
-- DEVICES: CAMERA LINK
-- ============================================
-- Phase 3 of the phone-sensing pivot (see PIVOT_AUDIT.md) extends
-- cv_pipeline/occupancy_detector.py to write zone_occupancy readings
-- through the same streams/readings model phones use (Phase 1). That
-- requires a devices row for each camera to satisfy streams.device_id.
-- occupancy_detector.py auto-provisions this row on startup, looked up
-- deterministically by camera_id - a direct column is simpler and more
-- reliable than trying to infer the link through zone_id.

alter table devices add column camera_id uuid references cameras(id) on delete set null;

create index idx_devices_camera on devices(camera_id) where camera_id is not null;

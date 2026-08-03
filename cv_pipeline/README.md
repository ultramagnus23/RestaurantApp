# MEZA Occupancy CV Pipeline (optional hardware add-on)

**This is optional.** MEZA's dashboard, revenue analytics, experiments, and
recommendations all work without any camera — occupancy can also be logged
manually or backfilled. This pipeline is the automated way to fill
`occupancy_snapshots` from real CCTV instead of by hand; skip this whole
directory if you don't have camera hardware to point at a restaurant yet.

Runs on edge hardware (Raspberry Pi 4 / Jetson Nano) next to a restaurant's
existing CCTV system. Detects people in an RTSP stream, maps them onto
configured table/queue regions, and posts anonymous occupancy metadata to
Supabase. **No image is ever stored or transmitted** — each frame is
discarded immediately after processing.

As of the phone-sensing pivot (see `PIVOT_AUDIT.md`), this script also:
- Tracks **per-table** occupied/empty state (not just a count) and runs a
  debounced session-detection state machine that opens/closes
  `table_sessions` rows automatically — configurable via
  `SESSION_START_MINUTES` (default 3) and `SESSION_END_MINUTES` (default
  10).
- Maps detections onto **zone polygons** (`zones` table, configured
  separately from the rectangular `table_regions`) and posts
  `zone_occupancy`/`occupancy_count` readings through the same
  `streams`/`readings` model the phone capture page uses, auto-registering
  a `devices` row (`device_type='cctv_bridge'`) for itself on first run.

## Try it without hardware: `--simulate`

Every install path below requires a real RTSP camera and a downloaded
detector model. To test the *ingestion path* — the camera registration flow,
the `cameras` table wiring, the Supabase write, the dashboard reflecting new
data — without any of that, run:

```bash
CAMERA_ID=<camera id from /cameras> \
SUPABASE_URL=https://your-project.supabase.co \
SUPABASE_SERVICE_KEY=<service role key> \
python occupancy_detector.py --simulate
```

`--simulate` skips opening the RTSP stream and loading the detector model
entirely (opencv-python doesn't even need to be installed for this mode —
only `requests`). It posts a realistic synthetic snapshot on the configured
interval, shaped like a real lunch/dinner rush (busier at 12-2pm and
7-10pm, busier on weekends), through the exact same reporting codepath a
real camera uses — so it's a genuine test of the pipeline, not a mock of it.

## Why this is modular per restaurant / per camera

Nothing camera-specific lives in this Python file. A restaurant registers
its cameras (RTSP URL, table regions, queue region) from the MEZA dashboard
at `/cameras`, which writes to the `cameras` table (see
`supabase/migrations/002_cameras.sql`). This script reads that
configuration at startup by `CAMERA_ID` and re-fetches nothing camera- or
restaurant-specific from anywhere else — so the same script, unmodified,
runs any camera at any restaurant. To add a new camera, add a row from the
dashboard and start a new process with that camera's id; to change table
layout, edit the regions on the dashboard and restart the process.

## One-time setup

1. Register the camera and its table regions in the MEZA dashboard
   (`/cameras`) — note the camera's id shown there.
2. Install dependencies: `pip install -r requirements.txt`
3. Get the YOLOv8n detector weights (`yolov8n.pt`), not bundled in the
   repo:
   - **Offline/edge install (recommended):** download once from a machine
     with internet access - `python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')"` -
     then copy the resulting `yolov8n.pt` into this directory.
   - **Online install:** skip this step - `occupancy_detector.py` falls
     back to `ultralytics`' own auto-download on first run if
     `yolov8n.pt` isn't found locally (requires internet access on that
     first run only).

## Running

```bash
CAMERA_ID=<camera id from the dashboard> \
SUPABASE_URL=https://your-project.supabase.co \
SUPABASE_SERVICE_KEY=<service role key> \
python occupancy_detector.py
```

Run one process per camera. `SUPABASE_SERVICE_KEY` is a privileged
credential — keep it on the edge device only, never in a browser bundle or
committed to source control (it bypasses Row Level Security by design so
the pipeline can write on behalf of any restaurant it's configured for).

Optional env vars: `SESSION_START_MINUTES` / `SESSION_END_MINUTES` tune
how long a table must stay occupied/empty before a session opens/closes -
defaults (3 / 10) are a starting guess, not validated against real service
pace (no labeled pilot data exists yet - see `EVALUATION.md`).

## Multiple restaurants / multiple cameras

Each restaurant's owner manages their own cameras from their own MEZA
account (RLS-isolated). Each edge device only needs the `CAMERA_ID`(s) for
the cameras physically at that site — there is no cross-restaurant
configuration to manage centrally beyond issuing/rotating the service key.

## Accuracy note

The bundled detector is YOLOv8n (Ultralytics), a real, actively-maintained
person-detection model - but still generic and pretrained on COCO, not
fine-tuned for restaurant CCTV angles. **No accuracy number for this
pipeline is claimed anywhere in this repo** - validate it against a pilot
site's labeled footage before relying on these numbers operationally. See
`EVALUATION.md` in this directory for how to run that validation, and
`docs/ML_AUDIT.md` in the main repo for the full assessment and
recommended next steps (fine-tuning, evaluation harness) before wider
rollout.

## Deployment

See the `Dockerfile` in this directory to containerize this pipeline, and
`meza-occupancy-detector@.service` for a systemd template unit example for
a non-containerized install directly on a Pi. Both run one process per
camera (`CAMERA_ID` selects which).

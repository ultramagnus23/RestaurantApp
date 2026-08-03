"""
CV Pipeline for Anonymous Occupancy Detection (OPTIONAL hardware add-on)
Runs on edge device (Raspberry Pi / Jetson Nano), one process per camera.
Processes CCTV RTSP stream - outputs metadata only, no image storage.

MEZA works fully without this: occupancy data can also be logged from the
dashboard forms, and this script has a --simulate mode (below) that posts
realistic fake occupancy events without any camera, RTSP feed, or detector
model - useful for demos, dev, and testing the ingestion path end-to-end.

Nothing camera- or restaurant-specific is hardcoded here. All configuration
(RTSP URL, table ROI regions, queue region, zone polygons, snapshot
interval) is fetched from the `cameras`/`zones` tables in Supabase at
startup, keyed by CAMERA_ID. This lets one restaurant register any number
of cameras from the MEZA dashboard (/cameras) and point this same script
at each of them by passing a different CAMERA_ID - no code changes
required per install.

Phase 3 of the phone-sensing pivot (see PIVOT_AUDIT.md) added three
capabilities on top of the original occupancy-percentage detector, all
reusing the same per-cycle detect_people() call - no extra frames, no
extra detection passes:
  - Per-table occupied/empty tracking (detect_table_occupancy used to only
    return a count; session detection needs to know WHICH table changed).
  - Zone-polygon occupancy (point-in-polygon against zones.polygon,
    alongside the existing rectangle table_regions), written through the
    streams/readings model phones use (signal_type='zone_occupancy',
    'occupancy_count') - this script auto-provisions one `devices` row
    per camera (device_type='cctv_bridge') so it has something to key
    streams.device_id against, same pattern as the Phase 2 capture page.
  - A debounced session-detection state machine (SessionTracker) that
    finally gives `table_sessions` a real production writer: sustained
    occupancy starts a session, sustained emptiness ends it. Debounce
    thresholds (SESSION_START_MINUTES/SESSION_END_MINUTES) are
    configurable, not hardcoded - restaurant service pace varies and this
    can't be tuned empirically without labeled pilot data (same honesty
    caveat cv_pipeline/EVALUATION.md already states about the detector
    itself).

The Data Spine pass (supabase/migrations/012_data_spine.sql) extended
this further:
  - SessionTracker now rehydrates open sessions from table_sessions on
    startup instead of trusting in-process state alone - restart-safe by
    construction, not just documented as a limitation. A restart no
    longer risks opening a duplicate session for a table that already has
    one open.
  - detect_table_occupancy returns an occupancy_estimate (count of person
    detections in the table's region) and detection_confidence (mean
    YOLO box confidence among them, null when the table reads empty -
    never a fabricated 0.0 standing in for "no detection") alongside the
    occupied/empty boolean. SessionTracker writes these onto the open
    session every cycle - the latest reading, not an average, so it's
    honestly "as of last detection" rather than implying a computed
    aggregate. table_sessions.zone_id is set at session start via a
    table_number -> zone_id map built from the type='table' zones the
    012 migration backfilled from table_regions.

Required environment variables:
  CAMERA_ID            - id of the row in the `cameras` table to run
  SUPABASE_URL          - e.g. https://your-project.supabase.co
  SUPABASE_SERVICE_KEY  - service role key (edge device only - never ship
                           this to a browser or commit it to source control)

Optional:
  SESSION_START_MINUTES  - minutes a table must stay occupied before a
                            table_sessions row starts (default 3)
  SESSION_END_MINUTES    - minutes a table must stay empty before that
                            session closes (default 10)

Run (real camera, requires opencv-python + downloaded detector model):
  CAMERA_ID=<uuid> SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
    python occupancy_detector.py

Run against a recorded file instead of a live RTSP stream (cv2.VideoCapture
accepts a local path transparently - this overrides the camera's
configured rtsp_url for this run only, no DB edit needed):
  CAMERA_ID=<uuid> SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
    python occupancy_detector.py --source /path/to/recording.mp4

Run (no hardware, no opencv required - posts synthetic snapshots):
  CAMERA_ID=<uuid> SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
    python occupancy_detector.py --simulate
"""

import argparse
import os
import random
import secrets
import sys
import time
import json
from datetime import datetime

import requests


class ConfigError(RuntimeError):
    pass


def load_camera_config(supabase_url: str, service_key: str, camera_id: str) -> dict:
    """Fetch this camera's connection + ROI config from the `cameras` table."""
    resp = requests.get(
        f"{supabase_url}/rest/v1/cameras",
        params={"id": f"eq.{camera_id}", "select": "*"},
        headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
        },
        timeout=10,
    )
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        raise ConfigError(f"No camera found with id={camera_id}")
    return rows[0]


def load_zones(supabase_url: str, service_key: str, camera_id: str) -> list:
    """Fetch zone polygons configured for this camera (zones.camera_id).
    Zones themselves are created via direct SQL / a future /zones UI, not
    by this script - an empty list here just means zone occupancy won't
    fire, same "not configured -> skip" pattern as table_regions/queue_region."""
    resp = requests.get(
        f"{supabase_url}/rest/v1/zones",
        params={"camera_id": f"eq.{camera_id}", "select": "*"},
        headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
        },
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


def get_or_create_device(supabase_url: str, service_key: str, restaurant_id: str, camera_id: str) -> dict:
    """Look up (or auto-provision) the cctv_bridge devices row for this
    camera, so zone/occupancy readings can reference streams.device_id.
    The generated token is unused by this script - the service-role key
    remains the real credential, matching every sibling write in this
    file. It exists only so a device row is indistinguishable in shape
    from a phone's, for anything downstream that lists devices."""
    headers = {"apikey": service_key, "Authorization": f"Bearer {service_key}"}
    resp = requests.get(
        f"{supabase_url}/rest/v1/devices",
        params={"camera_id": f"eq.{camera_id}", "select": "*"},
        headers=headers,
        timeout=10,
    )
    resp.raise_for_status()
    rows = resp.json()
    if rows:
        return rows[0]

    resp = requests.post(
        f"{supabase_url}/rest/v1/devices",
        headers={**headers, "Content-Type": "application/json", "Prefer": "return=representation"},
        data=json.dumps({
            "restaurant_id": restaurant_id,
            "device_type": "cctv_bridge",
            "camera_id": camera_id,
            "token": secrets.token_urlsafe(24),
            "status": "active",
        }),
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()[0]


def report_camera_status(supabase_url: str, service_key: str, camera_id: str, **fields):
    """Best-effort status/error reporting back to the cameras table (non-fatal on failure)."""
    try:
        requests.patch(
            f"{supabase_url}/rest/v1/cameras",
            params={"id": f"eq.{camera_id}"},
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            data=json.dumps(fields),
            timeout=10,
        )
    except Exception as e:
        print(f"[warn] failed to report camera status: {e}")


def point_in_polygon(x: float, y: float, polygon_px: list) -> bool:
    """Ray-casting point-in-polygon test. polygon_px is a list of (x, y)
    tuples in the same coordinate space (pixels) as x, y."""
    if len(polygon_px) < 3:
        return False
    inside = False
    n = len(polygon_px)
    j = n - 1
    for i in range(n):
        xi, yi = polygon_px[i]
        xj, yj = polygon_px[j]
        if (yi > y) != (yj > y):
            x_intersect = (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi
            if x < x_intersect:
                inside = not inside
        j = i
    return inside


def ensure_table_zones(supabase_url: str, service_key: str, restaurant_id: str,
                        camera_id: str, table_regions: list, zones: list) -> list:
    """Create a type='table' zone for any table_regions entry that doesn't
    already have a matching zone. 012_data_spine.sql's zones backfill was a
    one-time INSERT over cameras that existed at migration time - a camera
    registered afterward would otherwise never get its table_regions
    turned into zones, silently breaking table_number -> zone_id linking
    (and therefore per-table source_health) for it. Returns the full zone
    list including any newly created ones."""
    existing_map = build_table_zone_map(table_regions, zones)
    headers = {
        "apikey": service_key, "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json", "Prefer": "return=representation",
    }
    created = []
    for table in table_regions:
        table_number = table["table_number"]
        if table_number in existing_map:
            continue
        polygon = [
            {"x": table["x1"], "y": table["y1"]},
            {"x": table["x2"], "y": table["y1"]},
            {"x": table["x2"], "y": table["y2"]},
            {"x": table["x1"], "y": table["y2"]},
        ]
        try:
            resp = requests.post(
                f"{supabase_url}/rest/v1/zones",
                headers=headers,
                data=json.dumps({
                    "restaurant_id": restaurant_id,
                    "name": f"Table {table_number}",
                    "polygon": polygon,
                    "camera_id": camera_id,
                    "type": "table",
                }),
                timeout=10,
            )
            resp.raise_for_status()
            row = resp.json()[0]
            created.append(row)
            print(f"[info] created zone '{row['name']}' for table {table_number} (no prior zone matched)")
        except Exception as e:
            print(f"[warn] failed to create zone for table {table_number}: {e}")
    return zones + created


def upsert_source_health(supabase_url: str, service_key: str, restaurant_id: str,
                          source_type: str, source_key: str, status: str, last_error: str = None):
    """Best-effort upsert into source_health - observability, not the
    primary write path, so failures here are logged and swallowed rather
    than interrupting detection (same philosophy as report_camera_status)."""
    now = datetime.now().isoformat()
    payload = {
        "restaurant_id": restaurant_id,
        "source_type": source_type,
        "source_key": str(source_key),
        "status": status,
        "updated_at": now,
        "last_error": last_error,
    }
    if status == "healthy":
        payload["last_success_at"] = now
    try:
        requests.post(
            f"{supabase_url}/rest/v1/source_health",
            params={"on_conflict": "restaurant_id,source_type,source_key"},
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates",
            },
            data=json.dumps(payload),
            timeout=10,
        )
    except Exception as e:
        print(f"[warn] failed to upsert source_health for {source_type}/{source_key}: {e}")


def build_table_zone_map(table_regions: list, zones: list) -> dict:
    """Match type='table' zones back to a table_number via their bounding
    rectangle. zones has no table_number column - the 012_data_spine.sql
    backfill produced zones whose polygon corners exactly match the
    originating table_regions rectangle, so a direct (tolerant) coordinate
    comparison is a reliable match, not a guess."""
    zone_map = {}
    table_zones = [z for z in zones if z.get("type") == "table" and len(z.get("polygon") or []) == 4]
    for table in table_regions:
        for zone in table_zones:
            xs = [pt["x"] for pt in zone["polygon"]]
            ys = [pt["y"] for pt in zone["polygon"]]
            if (
                abs(min(xs) - table["x1"]) < 1e-6 and abs(max(xs) - table["x2"]) < 1e-6
                and abs(min(ys) - table["y1"]) < 1e-6 and abs(max(ys) - table["y2"]) < 1e-6
            ):
                zone_map[table["table_number"]] = zone["id"]
                break
    return zone_map


def _parse_iso(ts: str) -> datetime:
    # table_sessions.start_time comes back from PostgREST as
    # '2026-07-16T10:30:00+00:00' - Python's fromisoformat handles this
    # directly on 3.11+; the replace handles the 'Z' suffix some Postgres
    # configs emit instead, for portability to older 3.x.
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


class SessionTracker:
    """Debounced per-table occupied/empty state machine that gives
    table_sessions a real, restart-safe writer. Sustained occupancy
    (>= start_seconds) opens a session; sustained emptiness
    (>= end_seconds) closes it.

    Restart-safety: on construction, rehydrates from any status='open'
    table_sessions rows already in the DB for this restaurant's tables,
    rather than trusting in-process state alone. Without this, a process
    restart while a table was mid-session would have no memory of the
    already-open row and could open a duplicate on the next debounced
    transition - this is exactly the gap closed here."""

    def __init__(self, supabase_url, service_key, restaurant_id, start_minutes, end_minutes,
                 table_numbers=None, zone_id_by_table=None):
        self.supabase_url = supabase_url
        self.service_key = service_key
        self.restaurant_id = restaurant_id
        self.start_seconds = start_minutes * 60
        self.end_seconds = end_minutes * 60
        self.zone_id_by_table = zone_id_by_table or {}
        self.tables = {}  # table_number -> state dict
        self._rehydrate(table_numbers or [])

    def _rehydrate(self, table_numbers):
        """Fetch open sessions for this restaurant's tables and resume
        tracking them as already-confirmed-occupied, instead of starting
        fresh and risking a duplicate session on the next transition."""
        if not table_numbers:
            return
        try:
            resp = requests.get(
                f"{self.supabase_url}/rest/v1/table_sessions",
                params={
                    "restaurant_id": f"eq.{self.restaurant_id}",
                    "status": "eq.open",
                    "select": "id,table_number,start_time",
                },
                headers=self._headers(None),
                timeout=10,
            )
            resp.raise_for_status()
            open_sessions = resp.json()
        except Exception as e:
            print(f"[warn] failed to rehydrate open sessions, starting fresh: {e}")
            return

        now = datetime.now()
        table_set = set(table_numbers)
        resumed = 0
        for row in open_sessions:
            table_number = row["table_number"]
            if table_number not in table_set:
                continue  # a different camera's table, or a manually-opened session
            self.tables[table_number] = {
                "confirmed_occupied": True,
                "candidate": True,
                "candidate_since": now,
                "session_id": row["id"],
                "session_start": _parse_iso(row["start_time"]),
            }
            resumed += 1
        if resumed:
            print(f"[session] rehydrated {resumed} already-open session(s) on startup")

    def update(self, table_occupancy: dict, now: datetime):
        """table_occupancy: {table_number: {'occupied': bool, 'estimate': int, 'confidence': float|None}}"""
        for table_number, state in table_occupancy.items():
            occupied = state["occupied"]
            t = self.tables.setdefault(table_number, {
                "confirmed_occupied": False,
                "candidate": occupied,
                "candidate_since": now,
                "session_id": None,
                "session_start": None,
            })
            if occupied != t["candidate"]:
                t["candidate"] = occupied
                t["candidate_since"] = now

            elapsed = (now - t["candidate_since"]).total_seconds()

            if occupied and not t["confirmed_occupied"] and elapsed >= self.start_seconds:
                t["confirmed_occupied"] = True
                t["session_start"] = now
                t["session_id"] = self._start_session(table_number, now, state)
            elif not occupied and t["confirmed_occupied"] and elapsed >= self.end_seconds:
                t["confirmed_occupied"] = False
                if t["session_id"]:
                    self._end_session(t["session_id"], t["session_start"], now)
                t["session_id"] = None
                t["session_start"] = None
            elif occupied and t["confirmed_occupied"] and t["session_id"]:
                # Session already open - refresh occupancy_estimate/
                # detection_confidence with the latest reading rather than
                # only ever setting them once at open.
                self._update_occupancy(t["session_id"], state)

    def _headers(self, prefer):
        headers = {
            "apikey": self.service_key,
            "Authorization": f"Bearer {self.service_key}",
        }
        if prefer is not None:
            headers["Content-Type"] = "application/json"
            headers["Prefer"] = prefer
        return headers

    def _start_session(self, table_number, start_time, state):
        try:
            payload = {
                "restaurant_id": self.restaurant_id,
                "table_number": table_number,
                "start_time": start_time.isoformat(),
                "source": "cctv",
                "occupancy_estimate": state.get("estimate"),
                "detection_confidence": state.get("confidence"),
            }
            zone_id = self.zone_id_by_table.get(table_number)
            if zone_id:
                payload["zone_id"] = zone_id
            resp = requests.post(
                f"{self.supabase_url}/rest/v1/table_sessions",
                headers=self._headers("return=representation"),
                data=json.dumps(payload),
                timeout=10,
            )
            if resp.status_code in (200, 201):
                row = resp.json()[0]
                print(f"[session] table {table_number} occupied - session {row['id']} started")
                return row["id"]
            print(f"[warn] failed to start session for table {table_number}: {resp.status_code} {resp.text}")
        except Exception as e:
            print(f"[warn] error starting session for table {table_number}: {e}")
        return None

    def _update_occupancy(self, session_id, state):
        try:
            resp = requests.patch(
                f"{self.supabase_url}/rest/v1/table_sessions",
                params={"id": f"eq.{session_id}"},
                headers=self._headers("return=minimal"),
                data=json.dumps({
                    "occupancy_estimate": state.get("estimate"),
                    "detection_confidence": state.get("confidence"),
                }),
                timeout=10,
            )
            if resp.status_code not in (200, 204):
                print(f"[warn] failed to refresh occupancy for session {session_id}: {resp.status_code} {resp.text}")
        except Exception as e:
            print(f"[warn] error refreshing occupancy for session {session_id}: {e}")

    def _end_session(self, session_id, start_time, end_time):
        dwell_minutes = round((end_time - start_time).total_seconds() / 60)
        try:
            resp = requests.patch(
                f"{self.supabase_url}/rest/v1/table_sessions",
                params={"id": f"eq.{session_id}"},
                headers=self._headers("return=minimal"),
                data=json.dumps({"end_time": end_time.isoformat(), "dwell_time": dwell_minutes}),
                timeout=10,
            )
            if resp.status_code not in (200, 204):
                print(f"[warn] failed to end session {session_id}: {resp.status_code} {resp.text}")
            else:
                print(f"[session] session {session_id} ended, dwell {dwell_minutes}m")
        except Exception as e:
            print(f"[warn] error ending session {session_id}: {e}")


class OccupancyDetector:
    def __init__(self, config: dict, supabase_url: str, supabase_key: str, simulate: bool = False,
                 session_start_minutes: float = 3, session_end_minutes: float = 10, source: str = None):
        self.config = config
        self.supabase_url = supabase_url
        self.supabase_key = supabase_key
        self.simulate = simulate

        self.camera_id = config["id"]
        self.restaurant_id = config["restaurant_id"]
        # --source overrides the camera's configured rtsp_url for this run
        # only (e.g. a local recorded file for testing) - cv2.VideoCapture
        # accepts a local path transparently, no DB edit needed.
        self.rtsp_url = source or config["rtsp_url"]
        self.snapshot_interval = config.get("snapshot_interval_seconds") or 300
        self.table_regions = config.get("table_regions") or []
        self.queue_region = config.get("queue_region")

        if not self.table_regions:
            print("[warn] this camera has no table_regions configured - "
                  "occupancy_percentage will always be 0. Configure table "
                  "regions from the MEZA dashboard's Cameras page.")

        self.zones = load_zones(supabase_url, supabase_key, self.camera_id)
        if self.table_regions:
            # Backfills any table_regions entry with no matching zone yet -
            # covers cameras registered after 012_data_spine.sql's one-time
            # migration-time backfill ran. Note this means zone_occupancy
            # readings will also include type='table' zones going forward -
            # redundant with occupancy_count/table_sessions for those
            # tables, but harmless, and keeping one zone list is simpler
            # than maintaining a second table-only one.
            self.zones = ensure_table_zones(
                supabase_url, supabase_key, self.restaurant_id, self.camera_id,
                self.table_regions, self.zones,
            )
        if not self.zones:
            print("[info] no zones configured for this camera - zone_occupancy readings will not be sent.")

        self.device = get_or_create_device(supabase_url, supabase_key, self.restaurant_id, self.camera_id)
        self.device_id = self.device["id"]
        self._stream_ids = {}

        zone_id_by_table = build_table_zone_map(self.table_regions, self.zones)
        table_numbers = [t["table_number"] for t in self.table_regions]
        self.session_tracker = SessionTracker(
            supabase_url, supabase_key, self.restaurant_id,
            session_start_minutes, session_end_minutes,
            table_numbers=table_numbers, zone_id_by_table=zone_id_by_table,
        )

        if self.simulate:
            # No camera, no RTSP connection, no detector model - just posts
            # realistic synthetic snapshots on the same interval/reporting
            # codepath a real camera would use.
            self.cap = None
            self.person_detector = None
        else:
            # Imported lazily so --simulate works on a machine with no
            # opencv-python installed at all (e.g. a laptop, not the Pi).
            import cv2
            self.cv2 = cv2
            self.cap = cv2.VideoCapture(self.rtsp_url)
            if not self.cap.isOpened():
                raise ValueError(f"Cannot open video source: {self.rtsp_url}")
            self.person_detector = self.load_detector()

    def load_detector(self):
        """Load person detection model: YOLOv8n (Ultralytics), CPU-friendly.

        Replaces the previous generic Caffe SSD face/person detector (see
        docs/ML_AUDIT.md for why) with a real, actively-maintained
        person-detection model. Still generic/pretrained on COCO, not
        fine-tuned on restaurant CCTV footage - see EVALUATION.md before
        trusting its numbers operationally.

        Looks for yolov8n.pt in this directory first (recommended for
        offline/edge installs - see README for the one-time download step).
        If not present, falls back to ultralytics' own auto-download, which
        requires internet access on first run.
        """
        try:
            from ultralytics import YOLO
        except ImportError as e:
            raise ConfigError(
                "ultralytics is not installed. Run: pip install ultralytics "
                "(see cv_pipeline/requirements.txt)."
            ) from e

        model_dir = os.path.dirname(os.path.abspath(__file__))
        local_weights = os.path.join(model_dir, "yolov8n.pt")
        model_source = local_weights if os.path.exists(local_weights) else "yolov8n.pt"
        try:
            return YOLO(model_source)
        except Exception as e:
            raise ConfigError(
                f"Failed to load YOLOv8 model ({model_source}): {e}. For an "
                "offline/edge install, download yolov8n.pt once (see "
                "cv_pipeline/README.md) and place it in this directory."
            ) from e

    def detect_people(self, frame):
        """Detect people in frame using YOLOv8 (COCO class 0 = person)."""
        results = self.person_detector.predict(frame, classes=[0], conf=0.5, verbose=False)

        people = []
        for result in results:
            for box in result.boxes:
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                people.append({
                    'x': (x1 + x2) / 2,
                    'y': (y1 + y2) / 2,
                    'confidence': float(box.conf[0]),
                })

        return people

    def generate_simulated_snapshot(self):
        """Fake occupancy shaped like a real lunch/dinner-rush restaurant day,
        used only in --simulate mode. No camera, no frame, no detector.
        Also synthesizes per-table occupied/empty booleans and per-zone
        counts (not just the aggregate snapshot) so --simulate exercises
        the exact same session-detection and zone-reading code paths a
        real camera would."""
        now = datetime.now()
        hour = now.hour + now.minute / 60
        is_weekend = now.weekday() >= 4  # Fri/Sat/Sun

        if hour >= 12 and hour <= 14:
            base = 78 if is_weekend else 62
        elif hour >= 19 and hour <= 22:
            base = 92 if is_weekend else 74
        elif 8 <= hour <= 11:
            base = 18
        elif 15 <= hour <= 18:
            base = 30
        else:
            base = 25

        occupancy_percentage = max(3, min(100, base + random.uniform(-10, 10)))
        total_tables = len(self.table_regions) or 12
        occupied_tables = round((occupancy_percentage / 100) * total_tables)
        occupied_tables = max(0, min(total_tables, occupied_tables))
        available_tables = total_tables - occupied_tables
        people_count = max(0, round(occupied_tables * random.uniform(1.8, 3.2)))
        queue_length = (
            random.randint(1, 9) if occupancy_percentage > 85
            else random.randint(0, 3) if occupancy_percentage > 70
            else 0
        )
        wait_time = queue_length * random.randint(2, 4)

        snapshot = {
            'restaurant_id': self.restaurant_id,
            'timestamp': now.isoformat(),
            'occupancy_percentage': round(occupancy_percentage, 2),
            'occupied_tables': occupied_tables,
            'available_tables': available_tables,
            'people_count': people_count,
            'queue_length': queue_length,
            'wait_time': wait_time,
            'total_tables': total_tables,
        }

        table_numbers = (
            [t.get('table_number', i + 1) for i, t in enumerate(self.table_regions)]
            or list(range(1, total_tables + 1))
        )
        occupied_set = set(random.sample(table_numbers, min(occupied_tables, len(table_numbers)))) if table_numbers else set()
        # Synthetic estimate/confidence, same shape a real camera produces,
        # so --simulate exercises the exact same session-writer code path
        # (including the occupancy_estimate/detection_confidence fields).
        table_occupancy = {
            tn: {
                'occupied': tn in occupied_set,
                'estimate': random.randint(1, 4) if tn in occupied_set else 0,
                'confidence': round(random.uniform(0.55, 0.95), 3) if tn in occupied_set else None,
            }
            for tn in table_numbers
        }

        zone_counts = {}
        for zone in self.zones:
            zone_counts[zone['id']] = round(people_count * random.uniform(0.2, 0.6) / max(len(self.zones), 1))

        return snapshot, table_occupancy, zone_counts

    def detect_table_occupancy(self, people, frame):
        """Per-table occupied/empty state, keyed by table_number, each
        carrying an occupancy_estimate (count of person detections whose
        centroid falls in the table's region) and detection_confidence
        (mean YOLO box confidence among them). confidence is null when the
        table reads empty - never a fabricated 0.0 standing in for "no
        detection". Session detection needs to know WHICH table
        transitioned, not just an aggregate count."""
        h, w = frame.shape[:2]
        occupancy = {}

        for table in self.table_regions:
            x1 = int(table['x1'] * w)
            y1 = int(table['y1'] * h)
            x2 = int(table['x2'] * w)
            y2 = int(table['y2'] * h)

            in_region = [
                person for person in people
                if x1 <= person['x'] <= x2 and y1 <= person['y'] <= y2
            ]
            confidence = (
                round(sum(p['confidence'] for p in in_region) / len(in_region), 3)
                if in_region else None
            )
            occupancy[table['table_number']] = {
                'occupied': len(in_region) > 0,
                'estimate': len(in_region),
                'confidence': confidence,
            }

        return occupancy

    def detect_zone_occupancy(self, people, frame):
        """Point-in-polygon person count per configured zone. Returns
        {zone_id: count} - empty dict if this camera has no zones."""
        if not self.zones:
            return {}

        h, w = frame.shape[:2]
        counts = {}
        for zone in self.zones:
            polygon_px = [(pt['x'] * w, pt['y'] * h) for pt in zone['polygon']]
            counts[zone['id']] = sum(
                1 for person in people if point_in_polygon(person['x'], person['y'], polygon_px)
            )
        return counts

    def detect_queue(self, people, frame):
        """Detect queue length near entrance, if this camera tracks a queue region"""
        if not self.queue_region:
            return 0

        h, w = frame.shape[:2]
        qx1 = int(self.queue_region['x1'] * w)
        qy1 = int(self.queue_region['y1'] * h)
        qx2 = int(self.queue_region['x2'] * w)
        qy2 = int(self.queue_region['y2'] * h)

        return sum(
            1 for person in people
            if qx1 <= person['x'] <= qx2 and qy1 <= person['y'] <= qy2
        )

    def capture_snapshot(self):
        """Capture and process a single frame (or a fake one, in --simulate
        mode). Returns (snapshot, table_occupancy, zone_counts)."""
        if self.simulate:
            return self.generate_simulated_snapshot()

        ret, frame = self.cap.read()
        if not ret:
            return None, {}, {}

        people = self.detect_people(frame)
        table_occupancy = self.detect_table_occupancy(people, frame)
        occupied_tables = sum(1 for state in table_occupancy.values() if state['occupied'])
        total_tables = len(table_occupancy)
        available_tables = total_tables - occupied_tables
        queue_length = self.detect_queue(people, frame)
        zone_counts = self.detect_zone_occupancy(people, frame)

        occupancy_percentage = (occupied_tables / total_tables * 100) if total_tables > 0 else 0
        people_count = len(people)
        wait_time = max(0, queue_length * 3)  # ~3 min per person in queue, heuristic

        snapshot = {
            'restaurant_id': self.restaurant_id,
            'timestamp': datetime.now().isoformat(),
            'occupancy_percentage': round(occupancy_percentage, 2),
            'occupied_tables': occupied_tables,
            'available_tables': available_tables,
            'people_count': people_count,
            'queue_length': queue_length,
            'wait_time': wait_time,
            'total_tables': total_tables,
        }

        # IMPORTANT: Frame is discarded immediately after processing.
        # No image is stored or transmitted.
        del frame

        return snapshot, table_occupancy, zone_counts

    def send_to_supabase(self, snapshot):
        """Send occupancy data to Supabase"""
        if not snapshot:
            return False

        try:
            response = requests.post(
                f"{self.supabase_url}/rest/v1/occupancy_snapshots",
                headers={
                    'apikey': self.supabase_key,
                    'Authorization': f'Bearer {self.supabase_key}',
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation',
                },
                data=json.dumps(snapshot),
                timeout=10
            )

            if response.status_code in (200, 201):
                print(f"[{datetime.now()}] Snapshot sent: {snapshot['occupancy_percentage']}% occupancy, "
                      f"{snapshot['people_count']} people, queue: {snapshot['queue_length']}")
                report_camera_status(
                    self.supabase_url, self.supabase_key, self.camera_id,
                    status='active', last_snapshot_at=snapshot['timestamp'], last_error=None,
                )
                return True

            print(f"Failed to send snapshot: {response.status_code} - {response.text}")
            report_camera_status(
                self.supabase_url, self.supabase_key, self.camera_id,
                status='error', last_error=f"{response.status_code}: {response.text}"[:500],
            )
            return False
        except Exception as e:
            print(f"Error sending snapshot: {e}")
            report_camera_status(
                self.supabase_url, self.supabase_key, self.camera_id,
                status='error', last_error=str(e)[:500],
            )
            return False

    def ensure_stream(self, signal_type: str):
        """Get-or-create the (device_id, signal_type) stream row, cached
        per process so this is one round-trip on first use, not every cycle."""
        if signal_type in self._stream_ids:
            return self._stream_ids[signal_type]

        headers = {"apikey": self.supabase_key, "Authorization": f"Bearer {self.supabase_key}"}
        try:
            resp = requests.get(
                f"{self.supabase_url}/rest/v1/streams",
                params={"device_id": f"eq.{self.device_id}", "signal_type": f"eq.{signal_type}", "select": "id"},
                headers=headers,
                timeout=10,
            )
            resp.raise_for_status()
            rows = resp.json()
            if rows:
                self._stream_ids[signal_type] = rows[0]["id"]
                return self._stream_ids[signal_type]

            resp = requests.post(
                f"{self.supabase_url}/rest/v1/streams",
                headers={**headers, "Content-Type": "application/json", "Prefer": "return=representation"},
                data=json.dumps({"device_id": self.device_id, "signal_type": signal_type}),
                timeout=10,
            )
            resp.raise_for_status()
            self._stream_ids[signal_type] = resp.json()[0]["id"]
            return self._stream_ids[signal_type]
        except Exception as e:
            print(f"[warn] failed to ensure stream for {signal_type}: {e}")
            return None

    def send_reading(self, signal_type: str, timestamp: str, value: dict):
        """Insert one readings row. A single 'zone_occupancy' reading
        carries every zone's count in value_json (not one stream per
        zone) - streams.(device_id, signal_type) is unique per device, so
        this is the correct shape for a camera with multiple zones."""
        stream_id = self.ensure_stream(signal_type)
        if not stream_id:
            return
        try:
            requests.post(
                f"{self.supabase_url}/rest/v1/readings",
                headers={
                    "apikey": self.supabase_key,
                    "Authorization": f"Bearer {self.supabase_key}",
                    "Content-Type": "application/json",
                    "Prefer": "return=minimal",
                },
                data=json.dumps({"stream_id": stream_id, "timestamp": timestamp, "value_json": value}),
                timeout=10,
            )
        except Exception as e:
            print(f"[warn] failed to send {signal_type} reading: {e}")

    def run(self):
        """Main loop"""
        print("Starting occupancy detection pipeline..."
              + (" [SIMULATE MODE - no camera, synthetic data]" if self.simulate else ""))
        print(f"Camera: {self.config.get('name', self.camera_id)}")
        print(f"Restaurant: {self.restaurant_id}")
        print(f"Device: {self.device_id}")
        if not self.simulate:
            print(f"RTSP stream: {self.rtsp_url}")
        print(f"Snapshot interval: {self.snapshot_interval}s")
        print(f"Tracking {len(self.table_regions)} table(s)"
              + (", plus queue region" if self.queue_region else "")
              + (f", {len(self.zones)} zone(s)" if self.zones else ""))
        print(f"Session detection: start after {self.session_tracker.start_seconds / 60:.1f}m occupied, "
              f"end after {self.session_tracker.end_seconds / 60:.1f}m empty")
        print("Privacy: frames processed in memory, never stored\n")

        snapshot_count = 0

        while True:
            try:
                snapshot, table_occupancy, zone_counts = self.capture_snapshot()
                if snapshot:
                    if self.send_to_supabase(snapshot):
                        snapshot_count += 1

                    self.send_reading('occupancy_count', snapshot['timestamp'], {'count': snapshot['people_count']})
                    if zone_counts:
                        self.send_reading('zone_occupancy', snapshot['timestamp'], {'zones': zone_counts})

                    if table_occupancy:
                        self.session_tracker.update(table_occupancy, datetime.now())

                    # Per-zone health heartbeat - a successful cycle means
                    # every zone this camera tracks is healthy, whatever
                    # its occupancy count. Dropped frames are handled below.
                    for zone in self.zones:
                        upsert_source_health(
                            self.supabase_url, self.supabase_key, self.restaurant_id,
                            'cctv_zone', zone['id'], 'healthy',
                        )
                elif not self.simulate:
                    # capture_snapshot returned None: a dropped/unreadable
                    # frame. Not necessarily any one zone's fault, so flag
                    # all of this camera's zones rather than guessing which
                    # one - a stale flag here is a prompt to check the
                    # camera, not a precise per-zone diagnosis.
                    for zone in self.zones:
                        upsert_source_health(
                            self.supabase_url, self.supabase_key, self.restaurant_id,
                            'cctv_zone', zone['id'], 'error', 'dropped frame (cap.read() returned False)',
                        )

                time.sleep(self.snapshot_interval)

            except KeyboardInterrupt:
                print(f"\nStopped. Total snapshots: {snapshot_count}")
                break
            except Exception as e:
                print(f"Error: {e}")
                report_camera_status(
                    self.supabase_url, self.supabase_key, self.camera_id,
                    status='error', last_error=str(e)[:500],
                )
                for zone in self.zones:
                    upsert_source_health(
                        self.supabase_url, self.supabase_key, self.restaurant_id,
                        'cctv_zone', zone['id'], 'error', str(e)[:500],
                    )
                time.sleep(10)  # Wait before retrying

        if self.cap is not None:
            self.cap.release()


def main():
    parser = argparse.ArgumentParser(description="MEZA occupancy CV pipeline")
    parser.add_argument(
        "--simulate",
        action="store_true",
        help="Post realistic fake occupancy snapshots instead of reading a camera - "
             "no RTSP stream, opencv, or detector model required. Useful for demos, "
             "dev, and exercising the ingestion path without a Pi.",
    )
    parser.add_argument(
        "--source",
        default=None,
        help="Override this camera's configured rtsp_url for this run only - a "
             "local file path works (cv2.VideoCapture accepts one transparently), "
             "so the real detector/session-writer path can be tested against a "
             "recorded video without editing the camera's DB row. Ignored with --simulate.",
    )
    args = parser.parse_args()

    camera_id = os.environ.get("CAMERA_ID")
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    session_start_minutes = float(os.environ.get("SESSION_START_MINUTES", "3"))
    session_end_minutes = float(os.environ.get("SESSION_END_MINUTES", "10"))

    if not camera_id or not supabase_url or not supabase_key:
        print(
            "Missing required environment variables. Set CAMERA_ID, "
            "SUPABASE_URL and SUPABASE_SERVICE_KEY (see this file's "
            "module docstring for details).",
            file=sys.stderr,
        )
        sys.exit(1)

    config = load_camera_config(supabase_url, supabase_key, camera_id)
    detector = OccupancyDetector(
        config, supabase_url, supabase_key, simulate=args.simulate,
        session_start_minutes=session_start_minutes, session_end_minutes=session_end_minutes,
        source=args.source,
    )
    detector.run()


if __name__ == '__main__':
    main()

"""
PARKED (2026-07-14): superseded by the phone-based sensing pivot - see
PIVOT_AUDIT.md at the repo root. This script assumed dedicated per-venue
I2C/UART sensor hardware (SHT31, SCD30, PMS5003, BH1750, an I2S mic) wired
to a Raspberry Pi at each site. That assumption is dead: sound and light
are now captured by a phone's on-device web page (Phase 2 of the pivot),
and temperature/humidity/CO2/PM2.5 have no phone-sensing equivalent, so
they move to the `interventions` log as owner-reported changes instead of
continuous sensor readings. Every adapter class below still raised
NotImplementedError for its real hardware path (only --mock ever worked),
so nothing operational is being removed - kept here for reference. Do not
wire this back up; build the phone capture page instead.

Original docstring follows, unmodified:
---
Edge Sensor Collector for Atmospherics (OPTIONAL hardware add-on)
Runs on edge device (Raspberry Pi), one process per restaurant site,
alongside (not instead of) cv_pipeline/occupancy_detector.py if that's
also deployed there.

Reads indoor atmospherics from real sensors and posts one
environment_snapshots row per cycle with source='sensor'. MEZA works fully
without this: the same table can be populated by hand from the
/environment dashboard page. This script is the automated way to fill it
from real hardware instead.

Like cv_pipeline/occupancy_detector.py, this posts directly to the
Supabase REST API using a service-role key rather than through the
Next.js /api/environment route: an unattended edge device has no
restaurant-owner browser session to authenticate with, so it needs the
same privileged, RLS-bypassing credential the CV pipeline already uses.
The Next.js route (app/api/environment/route.ts) remains the path for
the dashboard's manual-entry form and any future authenticated caller.

Hardware read paths are hidden behind small adapter classes (one per
sensor) so the collection loop, payload assembly, and posting logic can
be exercised with --mock and no hardware attached at all - useful for
demos, dev, and CI.

Required environment variables:
  RESTAURANT_ID         - id of the row in the `restaurants` table to post to
  SUPABASE_URL          - e.g. https://your-project.supabase.co
  SUPABASE_SERVICE_KEY  - service role key (edge device only - never ship
                           this to a browser or commit it to source control)

Optional:
  SNAPSHOT_INTERVAL_SECONDS  - reading cycle interval, default 300

Run (real hardware, requires smbus2/pyserial and wired sensors - see README):
  RESTAURANT_ID=<uuid> SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
    python collector.py

Run (no hardware - posts clearly-labeled synthetic readings):
  RESTAURANT_ID=<uuid> SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
    python collector.py --mock
"""

import argparse
import json
import os
import random
import sys
import time
from datetime import datetime

import requests


class ConfigError(RuntimeError):
    pass


# ============================================================
# Sensor adapters
# ============================================================
# Each adapter exposes a single read() -> value|None method. `None` means
# "this sensor failed to read this cycle" - the collector omits that field
# from the payload rather than posting a fabricated number. Real adapters
# are stubs: filling in the actual I2C/UART register logic is a hardware
# bring-up task per sensor model, intentionally left as a clearly marked
# TODO rather than guessed at, since wiring/addressing varies by board.

class TempHumiditySensor:
    """SHT31 or DHT22 over I2C/GPIO."""

    def read(self):
        raise NotImplementedError(
            "Wire up SHT31 (I2C, e.g. via adafruit-circuitpython-sht31d) or "
            "DHT22 (GPIO, e.g. via adafruit-circuitpython-dht) here. "
            "Return (temperature_c, humidity_pct) or (None, None) on failure."
        )


class CO2Sensor:
    """SCD30 or SCD41 over I2C."""

    def read(self):
        raise NotImplementedError(
            "Wire up SCD30/SCD41 here (e.g. via adafruit-circuitpython-scd30 "
            "or sensirion-i2c-scd4x). Return co2_ppm or None on failure."
        )


class PM25Sensor:
    """Plantower PMS5003 over UART."""

    def read(self):
        raise NotImplementedError(
            "Wire up PMS5003 here (pyserial UART read of the PMS5003 frame "
            "protocol). Return pm25_ugm3 or None on failure."
        )


class LuxSensor:
    """BH1750 over I2C."""

    def read(self):
        raise NotImplementedError(
            "Wire up BH1750 here (e.g. via smbus2 direct register read, or "
            "adafruit-circuitpython-bh1750). Return lux or None on failure."
        )


class SoundLevelSensor:
    """I2S MEMS mic -> dB(A)."""

    def read(self):
        raise NotImplementedError(
            "Wire up an I2S MEMS mic (e.g. via sounddevice/pyaudio capturing "
            "a short buffer) and compute an A-weighted RMS dB level here. "
            "Return sound_level_db or None on failure."
        )


class MockTempHumiditySensor:
    def read(self):
        return round(random.uniform(21, 31), 1), round(random.uniform(45, 75), 1)


class MockCO2Sensor:
    def read(self):
        return round(random.uniform(450, 1400), 1)


class MockPM25Sensor:
    def read(self):
        return round(random.uniform(8, 60), 1)


class MockLuxSensor:
    def read(self):
        return round(random.uniform(80, 600), 1)


class MockSoundLevelSensor:
    def read(self):
        return round(random.uniform(45, 78), 1)


# ============================================================
# Collector
# ============================================================

class SensorCollector:
    def __init__(self, restaurant_id, supabase_url, supabase_key, mock=False,
                 interval_seconds=300):
        self.restaurant_id = restaurant_id
        self.supabase_url = supabase_url
        self.supabase_key = supabase_key
        self.mock = mock
        self.interval_seconds = interval_seconds

        if mock:
            self.temp_humidity = MockTempHumiditySensor()
            self.co2 = MockCO2Sensor()
            self.pm25 = MockPM25Sensor()
            self.lux = MockLuxSensor()
            self.sound = MockSoundLevelSensor()
        else:
            self.temp_humidity = TempHumiditySensor()
            self.co2 = CO2Sensor()
            self.pm25 = PM25Sensor()
            self.lux = LuxSensor()
            self.sound = SoundLevelSensor()

    def _read(self, label, fn):
        """Best-effort single sensor read: log and return None on failure
        rather than crashing the whole cycle over one bad sensor."""
        prefix = "[MOCK] " if self.mock else ""
        try:
            return fn()
        except NotImplementedError as e:
            print(f"{prefix}[warn] {label} not wired up: {e}")
            return None
        except Exception as e:
            print(f"{prefix}[warn] {label} read failed: {e}")
            return None

    def build_payload(self):
        temperature, humidity = self._read("temp/humidity", self.temp_humidity.read) or (None, None)
        co2_ppm = self._read("co2", self.co2.read)
        pm25_ugm3 = self._read("pm2.5", self.pm25.read)
        lux = self._read("lux", self.lux.read)
        sound_level_db = self._read("sound level", self.sound.read)

        payload = {
            "restaurant_id": self.restaurant_id,
            "timestamp": datetime.now().isoformat(),
            "temperature": temperature,
            "humidity": humidity,
            "co2_ppm": co2_ppm,
            "pm25_ugm3": pm25_ugm3,
            "lux": lux,
            "sound_level_db": sound_level_db,
            "source": "sensor",
        }

        if self.mock:
            print(f"[MOCK] readings this cycle: "
                  f"temp={temperature}C humidity={humidity}% co2={co2_ppm}ppm "
                  f"pm2.5={pm25_ugm3}ug/m3 lux={lux} sound={sound_level_db}dB")

        return payload

    def post_snapshot(self, payload):
        prefix = "[MOCK] " if self.mock else ""
        try:
            response = requests.post(
                f"{self.supabase_url}/rest/v1/environment_snapshots",
                headers={
                    "apikey": self.supabase_key,
                    "Authorization": f"Bearer {self.supabase_key}",
                    "Content-Type": "application/json",
                    "Prefer": "return=representation",
                },
                data=json.dumps(payload),
                timeout=10,
            )
            if response.status_code in (200, 201):
                print(f"{prefix}[{datetime.now()}] snapshot posted (source=sensor)")
                return True
            print(f"{prefix}Failed to post snapshot: {response.status_code} - {response.text}")
            return False
        except Exception as e:
            print(f"{prefix}Error posting snapshot: {e}")
            return False

    def run(self):
        print("Starting edge sensor collector..."
              + (" [MOCK MODE - synthetic readings, not real hardware]" if self.mock else ""))
        print(f"Restaurant: {self.restaurant_id}")
        print(f"Snapshot interval: {self.interval_seconds}s\n")

        cycle_count = 0
        while True:
            try:
                payload = self.build_payload()
                if self.post_snapshot(payload):
                    cycle_count += 1
                time.sleep(self.interval_seconds)
            except KeyboardInterrupt:
                print(f"\nStopped. Total cycles posted: {cycle_count}")
                break
            except Exception as e:
                print(f"Error: {e}")
                time.sleep(10)


def main():
    parser = argparse.ArgumentParser(description="MEZA edge sensor collector")
    parser.add_argument(
        "--mock",
        action="store_true",
        help="Generate plausible-but-synthetic sensor readings instead of reading "
             "real hardware. Every log line and payload is clearly prefixed/labeled "
             "so mock data can never be confused with a real sensor reading "
             "downstream. Useful for demos, dev, and exercising the ingestion path "
             "without a Pi or any sensors wired up.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Post a single reading cycle and exit, instead of looping forever. "
             "Useful for testing and for running this from an external scheduler "
             "(e.g. cron) instead of as a long-running service.",
    )
    args = parser.parse_args()

    restaurant_id = os.environ.get("RESTAURANT_ID")
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    interval_seconds = int(os.environ.get("SNAPSHOT_INTERVAL_SECONDS", "300"))

    if not restaurant_id or not supabase_url or not supabase_key:
        print(
            "Missing required environment variables. Set RESTAURANT_ID, "
            "SUPABASE_URL and SUPABASE_SERVICE_KEY (see this file's module "
            "docstring for details).",
            file=sys.stderr,
        )
        sys.exit(1)

    collector = SensorCollector(
        restaurant_id, supabase_url, supabase_key,
        mock=args.mock, interval_seconds=interval_seconds,
    )

    if args.once:
        payload = collector.build_payload()
        collector.post_snapshot(payload)
    else:
        collector.run()


if __name__ == "__main__":
    main()

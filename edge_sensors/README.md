# MEZA Edge Sensors

**This is optional.** MEZA's dashboard, revenue analytics, experiments, and
recommendations all work without any of this — environmental data can also
be logged manually from the `/environment` dashboard page.

`collector.py` (indoor atmospherics off wired I2C/UART sensors — temp/
humidity, CO2, PM2.5, lux, sound level) has been **parked** in `legacy/`
as of the phone-based sensing pivot (2026-07-14) — see `PIVOT_AUDIT.md` at
the repo root. It assumed dedicated per-venue hardware wired to a
Raspberry Pi at each site; that assumption is dead. Sound and light are
now captured by a phone's on-device web capture page instead (see the
pivot plan), and temperature/humidity/CO2/PM2.5 have no phone-sensing
equivalent — they move to the `interventions` log as owner-reported
changes rather than continuous sensor readings. Do not build against
`legacy/collector.py`; it's kept for reference only.

**`weather_fetch.py`** is unaffected by the pivot and remains active — a
short-lived, cron-style script that looks up outdoor weather/AQI for the
restaurant's `location` via OpenWeatherMap and posts `weather`/
`rainfall`/`outdoor_aqi` to `environment_snapshots` with
`source: 'weather_api'`. Nothing about outdoor conditions changes with
indoor sensing hardware going away.

## One-time setup

1. Note your restaurant's id from the MEZA dashboard.
2. Sign up for a free OpenWeatherMap API key at
   https://openweathermap.org/api.
3. Install dependencies: `pip install -r requirements.txt` (just
   `requests` — `weather_fetch.py` needs nothing else).

## Running

```bash
# One-shot weather/AQI fetch (schedule via cron, not a long-running service)
RESTAURANT_ID=<uuid> SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
  OPENWEATHERMAP_API_KEY=... python weather_fetch.py
```

`SUPABASE_SERVICE_KEY` is a privileged credential — keep it on the edge
device only, never in a browser bundle or committed to source control
(same rule as `cv_pipeline`; it bypasses Row Level Security by design so
this script can write on behalf of the restaurant it's configured for,
since there's no restaurant-owner browser session for an unattended
device to use).

### crontab example (weather_fetch.py)

```
*/30 * * * * cd /opt/meza/edge_sensors && \
  RESTAURANT_ID=<uuid> SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
  OPENWEATHERMAP_API_KEY=... python3 weather_fetch.py >> weather_fetch.log 2>&1
```

## Why `source` matters

Every row `weather_fetch.py` writes sets `environment_snapshots.source`
(`'weather_api'`, or `'sensor'` historically from the now-parked
`legacy/collector.py`) so manual, sensor, and weather-API data are always
distinguishable later — see `supabase/migrations/004_sensor_fields.sql`.
Don't post without setting `source` explicitly if you extend this script.

## AQI scale note

`outdoor_aqi` as populated by `weather_fetch.py` is OpenWeatherMap's own
1-5 Air Quality Index (1=Good … 5=Very Poor), **not** the US EPA 0-500
AQI scale that's more commonly displayed to consumers. Converting to the
EPA scale requires the full per-pollutant breakpoint table, which isn't
implemented here — see `fetch_aqi()` in `weather_fetch.py`. Don't display
this number to a restaurant owner as an EPA AQI without either doing that
conversion or clearly labeling it as OpenWeatherMap's index.

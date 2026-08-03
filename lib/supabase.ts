import { createClient } from '@supabase/supabase-js'

// Real values must be set in the deployment platform (Vercel/Render env
// vars) or .env.local. The fallbacks below only exist so `next build` can
// evaluate route modules without real credentials (e.g. CI, preview
// builds); isSupabaseConfigured gates runtime behavior.
const envUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
// Supabase is transitioning from "anon" keys to "publishable" keys
// (sb_publishable_...). Both work identically with supabase-js; accept
// either env var name so dashboard copy-paste of the new naming works.
const envAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

export const isSupabaseConfigured =
  !!envUrl && /^https?:\/\//.test(envUrl) && !!envAnonKey

const supabaseUrl = isSupabaseConfigured ? (envUrl as string) : 'https://placeholder.supabase.co'
const supabaseAnonKey = isSupabaseConfigured ? (envAnonKey as string) : 'placeholder-anon-key'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Per-request server client: forwards the caller's access token so
// auth.getUser()/auth.uid() and RLS resolve correctly. Never share a
// single client instance across requests on the server - session state
// must not leak between concurrent users.
export function getServerSupabase(req: Request) {
  if (!isSupabaseConfigured) {
    throw new Error(
      'Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY'
    )
  }
  const authHeader = req.headers.get('authorization') ?? undefined
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: authHeader ? { headers: { Authorization: authHeader } } : {},
    auth: { persistSession: false },
  })
}

// Privileged server-only client for trusted backend jobs that have no
// restaurant-owner session to forward (e.g. the recommendation engine cron
// route). Bypasses RLS by design - never expose SUPABASE_SERVICE_ROLE_KEY
// to the browser, and never call this from a route that handles a
// user-supplied restaurant_id without itself checking authorization first.
export function getServiceSupabase() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!isSupabaseConfigured || !serviceKey) {
    throw new Error(
      'Service Supabase client is not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'
    )
  }
  return createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
}

// A percentage-of-frame ROI box: 0-1 fractions of frame width/height,
// matching cv_pipeline/occupancy_detector.py's TABLE_REGIONS/QUEUE_REGION format.
export type CameraRegion = {
  x1: number
  y1: number
  x2: number
  y2: number
}

export type CameraTableRegion = CameraRegion & {
  table_number: number
}

// A fractional (0-1), camera-frame-relative polygon point for zones.polygon.
export type ZonePoint = {
  x: number
  y: number
}

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      restaurants: {
        Row: {
          id: string
          owner_id: string
          name: string
          location: string
          timezone: string
          max_capacity: number | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_id: string
          name: string
          location: string
          timezone?: string
          max_capacity?: number | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          owner_id?: string
          name?: string
          location?: string
          timezone?: string
          max_capacity?: number | null
          created_at?: string
          updated_at?: string
        }
      }
      occupancy_snapshots: {
        Row: {
          id: string
          restaurant_id: string
          timestamp: string
          occupancy_percentage: number | null
          occupied_tables: number | null
          available_tables: number | null
          people_count: number | null
          queue_length: number | null
          wait_time: number | null
          total_tables: number | null
        }
        Insert: {
          id?: string
          restaurant_id: string
          timestamp?: string
          occupancy_percentage?: number | null
          occupied_tables?: number | null
          available_tables?: number | null
          people_count?: number | null
          queue_length?: number | null
          wait_time?: number | null
          total_tables?: number | null
        }
        Update: {
          id?: string
          restaurant_id?: string
          timestamp?: string
          occupancy_percentage?: number | null
          occupied_tables?: number | null
          available_tables?: number | null
          people_count?: number | null
          queue_length?: number | null
          wait_time?: number | null
          total_tables?: number | null
        }
      }
      table_sessions: {
        Row: {
          id: string
          restaurant_id: string
          table_number: number
          party_size: number | null
          start_time: string
          end_time: string | null
          dwell_time: number | null
          order_value: number | null
          item_count: number | null
          dessert_count: number
          drink_count: number
          pass_time: string | null
          clearance_pct: number | null
          zone_id: string | null
          occupancy_estimate: number | null
          detection_confidence: number | null
          source: 'cctv' | 'manual'
          // status is DB-derived from end_time by a trigger
          // (fn_sync_table_session_status, updated in 013_ingestion_automation.sql)
          // on every insert/update - open iff end_time is null. 'merged'
          // and 'interrupted' are the two values the trigger can't derive
          // and passes through as-is - 'interrupted' is set by the
          // ingestion worker when a session's zone goes stale beyond a
          // timeout, never a guessed end_time.
          status: 'open' | 'closed' | 'merged' | 'interrupted'
        }
        Insert: {
          id?: string
          restaurant_id: string
          table_number: number
          party_size?: number | null
          start_time: string
          end_time?: string | null
          dwell_time?: number | null
          order_value?: number | null
          item_count?: number | null
          dessert_count?: number
          drink_count?: number
          pass_time?: string | null
          // 0-100, bussing-staff estimate; checked at the DB layer (008_pass_to_table.sql)
          clearance_pct?: number | null
          zone_id?: string | null
          occupancy_estimate?: number | null
          detection_confidence?: number | null
          source?: 'cctv' | 'manual'
          status?: 'open' | 'closed' | 'merged' | 'interrupted'
        }
        Update: {
          id?: string
          restaurant_id?: string
          table_number?: number
          party_size?: number | null
          start_time?: string
          end_time?: string | null
          dwell_time?: number | null
          order_value?: number | null
          item_count?: number | null
          dessert_count?: number
          drink_count?: number
          pass_time?: string | null
          clearance_pct?: number | null
          zone_id?: string | null
          occupancy_estimate?: number | null
          detection_confidence?: number | null
          source?: 'cctv' | 'manual'
          status?: 'open' | 'closed' | 'merged' | 'interrupted'
        }
      }
      environment_snapshots: {
        Row: {
          id: string
          restaurant_id: string
          timestamp: string
          temperature: number | null
          humidity: number | null
          weather: string | null
          rainfall: boolean
          music_genre: string | null
          music_volume: number | null
          lighting_brightness: number | null
          lighting_temperature: number | null
          promotion_active: boolean
          special_event: string | null
          staff_count: number | null
          co2_ppm: number | null
          pm25_ugm3: number | null
          outdoor_aqi: number | null
          lux: number | null
          sound_level_db: number | null
          source: 'manual' | 'sensor' | 'weather_api'
        }
        Insert: {
          id?: string
          restaurant_id: string
          timestamp?: string
          temperature?: number | null
          humidity?: number | null
          weather?: string | null
          rainfall?: boolean
          music_genre?: string | null
          music_volume?: number | null
          lighting_brightness?: number | null
          lighting_temperature?: number | null
          promotion_active?: boolean
          special_event?: string | null
          staff_count?: number | null
          co2_ppm?: number | null
          pm25_ugm3?: number | null
          outdoor_aqi?: number | null
          lux?: number | null
          sound_level_db?: number | null
          source?: 'manual' | 'sensor' | 'weather_api'
        }
        Update: {
          id?: string
          restaurant_id?: string
          timestamp?: string
          temperature?: number | null
          humidity?: number | null
          weather?: string | null
          rainfall?: boolean
          music_genre?: string | null
          music_volume?: number | null
          lighting_brightness?: number | null
          lighting_temperature?: number | null
          promotion_active?: boolean
          special_event?: string | null
          staff_count?: number | null
          co2_ppm?: number | null
          pm25_ugm3?: number | null
          outdoor_aqi?: number | null
          lux?: number | null
          sound_level_db?: number | null
          source?: 'manual' | 'sensor' | 'weather_api'
        }
      }
      operational_snapshots: {
        Row: {
          id: string
          restaurant_id: string
          timestamp: string
          staff_count: number | null
          kitchen_load: number | null
          service_time: number | null
          order_prep_time: number | null
        }
        Insert: {
          id?: string
          restaurant_id: string
          timestamp?: string
          staff_count?: number | null
          kitchen_load?: number | null
          service_time?: number | null
          order_prep_time?: number | null
        }
        Update: {
          id?: string
          restaurant_id?: string
          timestamp?: string
          staff_count?: number | null
          kitchen_load?: number | null
          service_time?: number | null
          order_prep_time?: number | null
        }
      }
      experiments: {
        Row: {
          id: string
          restaurant_id: string
          experiment_name: string
          hypothesis: string
          variable_changed: string
          control_condition: string | null
          test_condition: string | null
          start_time: string
          end_time: string | null
          status: string
          randomization_unit: 'session' | 'day' | 'table' | 'dish'
          primary_metric: string
          primary_metric_locked_at: string | null
          secondary_metrics: string[]
          min_detectable_effect: number | null
          created_at: string
          // Links to interventions() rows that constitute this experiment's
          // treatment - see 009_pivot_data_model.sql.
          linked_intervention_ids: string[]
        }
        Insert: {
          id?: string
          restaurant_id: string
          experiment_name: string
          hypothesis: string
          variable_changed: string
          control_condition?: string | null
          test_condition?: string | null
          start_time: string
          end_time?: string | null
          status?: string
          randomization_unit: 'session' | 'day' | 'table' | 'dish'
          primary_metric: string
          primary_metric_locked_at?: string | null
          // Must include 'return_rate' - enforced by
          // experiments_secondary_metrics_return_rate_check (007_experiment_lab.sql).
          secondary_metrics: string[]
          min_detectable_effect?: number | null
          created_at?: string
          linked_intervention_ids?: string[]
        }
        Update: {
          id?: string
          restaurant_id?: string
          experiment_name?: string
          hypothesis?: string
          variable_changed?: string
          control_condition?: string | null
          test_condition?: string | null
          start_time?: string
          end_time?: string | null
          status?: string
          randomization_unit?: 'session' | 'day' | 'table' | 'dish'
          // primary_metric is rejected by fn_lock_primary_metric() once
          // status is not 'planned' - see 007_experiment_lab.sql section F.
          primary_metric?: string
          primary_metric_locked_at?: string | null
          secondary_metrics?: string[]
          min_detectable_effect?: number | null
          created_at?: string
          linked_intervention_ids?: string[]
        }
      }
      experiment_treatments: {
        Row: {
          id: string
          experiment_id: string
          label: string
          is_control: boolean
          config: Json
          created_at: string
        }
        Insert: {
          id?: string
          experiment_id: string
          label: string
          is_control?: boolean
          // config.hold_temp_c, when present, is validated by
          // fn_check_thermal_danger_zone() - must be <=4 or >=60.
          config?: Json
          created_at?: string
        }
        Update: {
          id?: string
          experiment_id?: string
          label?: string
          is_control?: boolean
          config?: Json
          created_at?: string
        }
      }
      experiment_assignments: {
        Row: {
          id: string
          experiment_id: string
          treatment_id: string
          unit_key: string
          assigned_for: string
          compliance_confirmed: boolean
          compliance_note: string | null
          created_at: string
        }
        Insert: {
          id?: string
          experiment_id: string
          treatment_id: string
          // Shape must match the parent experiment's randomization_unit
          // (validated by fn_check_assignment_unit()): ISO date for 'day',
          // numeric table number for 'table', non-empty text for 'dish'/'session'.
          unit_key: string
          assigned_for?: string
          compliance_confirmed?: boolean
          compliance_note?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          experiment_id?: string
          treatment_id?: string
          unit_key?: string
          assigned_for?: string
          compliance_confirmed?: boolean
          compliance_note?: string | null
          created_at?: string
        }
      }
      thermal_readings: {
        Row: {
          id: string
          restaurant_id: string
          experiment_id: string | null
          table_number: number | null
          dish_name: string | null
          stage: 'at_pass' | 'at_table'
          temp_c: number
          recorded_at: string
          source: 'ir_manual' | 'ir_sensor'
          created_at: string
        }
        Insert: {
          id?: string
          restaurant_id: string
          experiment_id?: string | null
          table_number?: number | null
          dish_name?: string | null
          stage: 'at_pass' | 'at_table'
          temp_c: number
          recorded_at?: string
          source?: 'ir_manual' | 'ir_sensor'
          created_at?: string
        }
        Update: {
          id?: string
          restaurant_id?: string
          experiment_id?: string | null
          table_number?: number | null
          dish_name?: string | null
          stage?: 'at_pass' | 'at_table'
          temp_c?: number
          recorded_at?: string
          source?: 'ir_manual' | 'ir_sensor'
          created_at?: string
        }
      }
      experiment_results: {
        Row: {
          id: string
          experiment_id: string
          revenue_delta: number | null
          average_order_value_delta: number | null
          dwell_time_delta: number | null
          dessert_delta: number | null
          drink_delta: number | null
          confidence_score: number | null
          measured_at: string
        }
        Insert: {
          id?: string
          experiment_id: string
          revenue_delta?: number | null
          average_order_value_delta?: number | null
          dwell_time_delta?: number | null
          dessert_delta?: number | null
          drink_delta?: number | null
          confidence_score?: number | null
          measured_at?: string
        }
        Update: {
          id?: string
          experiment_id?: string
          revenue_delta?: number | null
          average_order_value_delta?: number | null
          dwell_time_delta?: number | null
          dessert_delta?: number | null
          drink_delta?: number | null
          confidence_score?: number | null
          measured_at?: string
        }
      }
      recommendations: {
        Row: {
          id: string
          restaurant_id: string
          timestamp: string
          recommendation: string
          rule_key: string | null
          confidence: number | null
          expected_revenue_impact: number | null
          implemented: boolean
          implemented_at: string | null
        }
        Insert: {
          id?: string
          restaurant_id: string
          timestamp?: string
          recommendation: string
          rule_key?: string | null
          confidence?: number | null
          expected_revenue_impact?: number | null
          implemented?: boolean
          implemented_at?: string | null
        }
        Update: {
          id?: string
          restaurant_id?: string
          timestamp?: string
          recommendation?: string
          rule_key?: string | null
          confidence?: number | null
          expected_revenue_impact?: number | null
          implemented?: boolean
          implemented_at?: string | null
        }
      }
      pos_orders: {
        Row: {
          id: string
          restaurant_id: string
          external_id: string | null
          timestamp: string
          order_type: string
          channel: string
          subtotal: number
          tax: number
          discount: number
          total_amount: number
          payment_method: string | null
          guest_count: number | null
          table_number: number | null
          status: string
          created_at: string
          // 'csv' for pre-spine rows (backfilled), 'rista'/'petpooja'/'posist' for adapter ingestion.
          pos_provider: string
          raw_payload: Json | null
          // true when |timestamp - server now()| exceeds the configured
          // skew tolerance - the POS server's own clock vs Meza's. See
          // 013_ingestion_automation.sql.
          skew_suspect: boolean
        }
        Insert: {
          id?: string
          restaurant_id: string
          external_id?: string | null
          timestamp?: string
          order_type?: string
          channel?: string
          subtotal?: number
          tax?: number
          discount?: number
          total_amount: number
          payment_method?: string | null
          guest_count?: number | null
          table_number?: number | null
          status?: string
          created_at?: string
          // Unique with external_id (nulls don't collide) - the idempotency
          // key adapters upsert against. See 012_data_spine.sql section D.
          pos_provider?: string
          raw_payload?: Json | null
          skew_suspect?: boolean
        }
        Update: {
          id?: string
          restaurant_id?: string
          external_id?: string | null
          timestamp?: string
          order_type?: string
          channel?: string
          subtotal?: number
          tax?: number
          discount?: number
          total_amount?: number
          payment_method?: string | null
          guest_count?: number | null
          table_number?: number | null
          status?: string
          created_at?: string
          pos_provider?: string
          raw_payload?: Json | null
          skew_suspect?: boolean
        }
      }
      pos_order_items: {
        Row: {
          id: string
          order_id: string
          item_name: string
          category: string | null
          quantity: number
          price: number
          total: number
          is_dessert: boolean
          is_drink: boolean
          created_at: string
        }
        Insert: {
          id?: string
          order_id: string
          item_name: string
          category?: string | null
          quantity: number
          price: number
          total: number
          is_dessert?: boolean
          is_drink?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          order_id?: string
          item_name?: string
          category?: string | null
          quantity?: number
          price?: number
          total?: number
          is_dessert?: boolean
          is_drink?: boolean
          created_at?: string
        }
      }
      cameras: {
        Row: {
          id: string
          restaurant_id: string
          name: string
          rtsp_url: string
          status: 'active' | 'inactive' | 'error'
          snapshot_interval_seconds: number
          fps: number
          table_regions: CameraTableRegion[]
          queue_region: CameraRegion | null
          last_snapshot_at: string | null
          last_error: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          restaurant_id: string
          name: string
          rtsp_url: string
          status?: 'active' | 'inactive' | 'error'
          snapshot_interval_seconds?: number
          fps?: number
          table_regions?: CameraTableRegion[]
          queue_region?: CameraRegion | null
          last_snapshot_at?: string | null
          last_error?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          restaurant_id?: string
          name?: string
          rtsp_url?: string
          status?: 'active' | 'inactive' | 'error'
          snapshot_interval_seconds?: number
          fps?: number
          table_regions?: CameraTableRegion[]
          queue_region?: CameraRegion | null
          last_snapshot_at?: string | null
          last_error?: string | null
          created_at?: string
          updated_at?: string
        }
      }
      zones: {
        Row: {
          id: string
          restaurant_id: string
          name: string
          polygon: ZonePoint[]
          camera_id: string | null
          created_at: string
          // null for pre-spine room-area zones never classified - not
          // guessed, see 012_data_spine.sql section A.
          type: 'table' | 'queue' | 'bar' | 'entry' | 'floor' | null
        }
        Insert: {
          id?: string
          restaurant_id: string
          name: string
          polygon: ZonePoint[]
          camera_id?: string | null
          created_at?: string
          type?: 'table' | 'queue' | 'bar' | 'entry' | 'floor' | null
        }
        Update: {
          id?: string
          restaurant_id?: string
          name?: string
          polygon?: ZonePoint[]
          camera_id?: string | null
          created_at?: string
          type?: 'table' | 'queue' | 'bar' | 'entry' | 'floor' | null
        }
      }
      devices: {
        Row: {
          id: string
          restaurant_id: string
          device_type: 'phone' | 'cctv_bridge'
          zone_id: string | null
          token: string
          status: 'pending' | 'active' | 'offline'
          last_seen_at: string | null
          created_at: string
          // Set for cctv_bridge devices auto-provisioned by
          // occupancy_detector.py - see 011_device_camera_link.sql.
          camera_id: string | null
        }
        Insert: {
          id?: string
          restaurant_id: string
          device_type: 'phone' | 'cctv_bridge'
          zone_id?: string | null
          token: string
          status?: 'pending' | 'active' | 'offline'
          last_seen_at?: string | null
          created_at?: string
          camera_id?: string | null
        }
        Update: {
          id?: string
          restaurant_id?: string
          device_type?: 'phone' | 'cctv_bridge'
          zone_id?: string | null
          token?: string
          status?: 'pending' | 'active' | 'offline'
          last_seen_at?: string | null
          created_at?: string
          camera_id?: string | null
        }
      }
      streams: {
        Row: {
          id: string
          device_id: string
          signal_type:
            | 'sound_level_dba'
            | 'sound_spectrum'
            | 'light_level'
            | 'light_color_temp'
            | 'vibration'
            | 'occupancy_count'
            | 'zone_occupancy'
            | 'music_tempo_bpm'
          created_at: string
        }
        Insert: {
          id?: string
          device_id: string
          signal_type:
            | 'sound_level_dba'
            | 'sound_spectrum'
            | 'light_level'
            | 'light_color_temp'
            | 'vibration'
            | 'occupancy_count'
            | 'zone_occupancy'
            | 'music_tempo_bpm'
          created_at?: string
        }
        Update: {
          id?: string
          device_id?: string
          signal_type?:
            | 'sound_level_dba'
            | 'sound_spectrum'
            | 'light_level'
            | 'light_color_temp'
            | 'vibration'
            | 'occupancy_count'
            | 'zone_occupancy'
            | 'music_tempo_bpm'
          created_at?: string
        }
      }
      readings: {
        Row: {
          id: string
          stream_id: string
          // recorded_at equivalent (device/client-reported) - see
          // 013_ingestion_automation.sql's timestamp-mapping note.
          timestamp: string
          value_json: Json
          // ingested_at equivalent (server insert time).
          created_at: string
          // true when |timestamp - server now()| > the configured skew
          // tolerance (default 60s) at insert time - flagged, never
          // dropped, so alignment can exclude it without losing the fact
          // that something was reported. See 013_ingestion_automation.sql.
          skew_suspect: boolean
        }
        Insert: {
          id?: string
          stream_id: string
          timestamp: string
          value_json: Json
          created_at?: string
          skew_suspect?: boolean
        }
        Update: {
          id?: string
          stream_id?: string
          timestamp?: string
          value_json?: Json
          created_at?: string
          skew_suspect?: boolean
        }
      }
      readings_rollup_1m: {
        Row: {
          stream_id: string
          minute: string
          mean: number | null
          p50: number | null
          p95: number | null
          sample_count: number
        }
        Insert: {
          stream_id: string
          minute: string
          mean?: number | null
          p50?: number | null
          p95?: number | null
          sample_count: number
        }
        Update: {
          stream_id?: string
          minute?: string
          mean?: number | null
          p50?: number | null
          p95?: number | null
          sample_count?: number
        }
      }
      interventions: {
        Row: {
          id: string
          restaurant_id: string
          timestamp: string
          category:
            | 'music'
            | 'lighting'
            | 'temperature'
            | 'scent'
            | 'layout'
            | 'table_materials'
            | 'menu'
            | 'service_protocol'
            | 'other'
          description: string | null
          zone_ids: string[]
          // At least one of logged_by/logged_by_device_id is set - enforced
          // by interventions_logged_by_check (010_intervention_device_attribution.sql).
          logged_by: string | null
          logged_by_device_id: string | null
          created_at: string
        }
        Insert: {
          id?: string
          restaurant_id: string
          timestamp?: string
          category:
            | 'music'
            | 'lighting'
            | 'temperature'
            | 'scent'
            | 'layout'
            | 'table_materials'
            | 'menu'
            | 'service_protocol'
            | 'other'
          description?: string | null
          zone_ids?: string[]
          logged_by?: string | null
          logged_by_device_id?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          restaurant_id?: string
          timestamp?: string
          category?:
            | 'music'
            | 'lighting'
            | 'temperature'
            | 'scent'
            | 'layout'
            | 'table_materials'
            | 'menu'
            | 'service_protocol'
            | 'other'
          description?: string | null
          zone_ids?: string[]
          logged_by?: string | null
          logged_by_device_id?: string | null
          created_at?: string
        }
      }
      pos_sync_state: {
        Row: {
          pos_provider: string
          restaurant_id: string
          last_synced_at: string | null
          cursor: string | null
          status: 'idle' | 'syncing' | 'error'
          // Adaptive cadence: worker computes this from restaurants.timezone
          // service hours (frequent during service, hourly overnight) -
          // see 013_ingestion_automation.sql.
          next_poll_at: string | null
        }
        Insert: {
          pos_provider: string
          restaurant_id: string
          last_synced_at?: string | null
          cursor?: string | null
          status?: 'idle' | 'syncing' | 'error'
          next_poll_at?: string | null
        }
        Update: {
          pos_provider?: string
          restaurant_id?: string
          last_synced_at?: string | null
          cursor?: string | null
          status?: 'idle' | 'syncing' | 'error'
          next_poll_at?: string | null
        }
      }
      source_health: {
        Row: {
          id: string
          restaurant_id: string
          source_type: 'pos' | 'cctv_zone' | 'phone'
          // provider name for 'pos', zone_id for 'cctv_zone', device_id for 'phone' - always text
          source_key: string
          last_success_at: string | null
          status: 'healthy' | 'stale' | 'error'
          last_error: string | null
          updated_at: string
        }
        Insert: {
          id?: string
          restaurant_id: string
          source_type: 'pos' | 'cctv_zone' | 'phone'
          source_key: string
          last_success_at?: string | null
          status?: 'healthy' | 'stale' | 'error'
          last_error?: string | null
          updated_at?: string
        }
        Update: {
          id?: string
          restaurant_id?: string
          source_type?: 'pos' | 'cctv_zone' | 'phone'
          source_key?: string
          last_success_at?: string | null
          status?: 'healthy' | 'stale' | 'error'
          last_error?: string | null
          updated_at?: string
        }
      }
      ingestion_log: {
        Row: {
          id: string
          source: string
          restaurant_id: string | null
          rows_in: number
          rows_written: number
          rows_skipped: number
          error: string | null
          ran_at: string
        }
        Insert: {
          id?: string
          source: string
          restaurant_id?: string | null
          rows_in?: number
          rows_written?: number
          rows_skipped?: number
          error?: string | null
          ran_at?: string
        }
        Update: {
          id?: string
          source?: string
          restaurant_id?: string | null
          rows_in?: number
          rows_written?: number
          rows_skipped?: number
          error?: string | null
          ran_at?: string
        }
      }
      pos_credentials: {
        Row: {
          id: string
          restaurant_id: string
          provider: 'rista' | 'petpooja' | 'posist'
          // Plain columns behind owner-only RLS, not encrypted at rest -
          // see the SECURITY NOTE in 012_data_spine.sql section G.
          api_key: string | null
          api_secret: string | null
          created_at: string
        }
        Insert: {
          id?: string
          restaurant_id: string
          provider: 'rista' | 'petpooja' | 'posist'
          api_key?: string | null
          api_secret?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          restaurant_id?: string
          provider?: 'rista' | 'petpooja' | 'posist'
          api_key?: string | null
          api_secret?: string | null
          created_at?: string
        }
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_restaurant_ids_for_user: {
        Args: Record<string, never>
        Returns: string[]
      }
    }
    Enums: {
      [_ in never]: never
    }
  }
}

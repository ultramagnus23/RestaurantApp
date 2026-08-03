import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase'

export type Device = Database['public']['Tables']['devices']['Row']

// Shared token lookup for every capture/[token] route. Device tokens are
// opaque, high-entropy random strings (see generateDeviceToken) validated
// by a DB lookup, not signature verification - revocation is just
// rotating/deleting the row. Every route re-derives the device (and
// restaurant_id) from the token itself; never trust a client-supplied
// restaurant_id from an unauthenticated caller.
//
// `supabase` is intentionally untyped (matches every other route in this
// codebase - getServerSupabase/getServiceSupabase return plain
// SupabaseClient, not SupabaseClient<Database>), so this accepts the
// broad client type rather than fighting that convention.
export async function resolveDevice(
  supabase: SupabaseClient,
  token: string
): Promise<Device | null> {
  if (!token) return null
  const { data, error } = await supabase
    .from('devices')
    .select('*')
    .eq('token', token)
    .maybeSingle()
  if (error || !data) return null
  return data
}

// Marks a device as having just been heard from - flips 'pending' to
// 'active' on first successful capture-page call, and always bumps
// last_seen_at. Best-effort: callers should not fail the request if this
// update fails.
export async function touchDevice(supabase: SupabaseClient, device: Device) {
  await supabase
    .from('devices')
    .update({
      last_seen_at: new Date().toISOString(),
      status: device.status === 'pending' ? 'active' : device.status,
    })
    .eq('id', device.id)
}

export function generateDeviceToken(): string {
  // Node's built-in crypto (no new dependency) - 24 random bytes,
  // base64url so it's safe to embed directly in a URL path segment.
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Buffer.from(bytes).toString('base64url')
}

// Every capture route needs a service-role client (no restaurant-owner
// session exists for an unauthenticated device) - same pattern as
// app/api/cron/recommendations/route.ts and the Python edge scripts.
// Re-exported here so capture routes don't need to know about
// getServiceSupabase's env-var requirements directly.
export { getServiceSupabase } from '@/lib/supabase'

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role client for server-only routes (CRM/GPS webhooks, cron jobs)
 * that must bypass RLS. Never import this from a Client Component or
 * anywhere the bundle could reach the browser.
 */
export function createServiceClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

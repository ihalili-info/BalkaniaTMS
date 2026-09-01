-- Supabase Security Advisor clean-up — the findings that are real and safe to
-- fix. The rest are assessed and left (see the notes at the bottom).

-- ===========================================================================
-- 1. function_search_path_mutable — stamp_driver_assignment (migration 0011)
-- ===========================================================================
--
-- Every other function in this schema pins `search_path`; 0011's trigger
-- function was the one that slipped through. Without it, a role that can
-- create objects in a schema earlier on the function's resolved path could
-- shadow `now()` and have it run with the trigger's privileges. It touches
-- nothing schema-qualified, but the fix is one line.

ALTER FUNCTION public.stamp_driver_assignment() SET search_path = public;

-- ===========================================================================
-- 2. SECURITY DEFINER functions reachable over the REST API
-- ===========================================================================

-- handle_new_user() is a trigger function on auth.users and nothing else. A
-- trigger fires regardless of the triggering role's EXECUTE privilege, so
-- taking it off the API surface entirely costs nothing. Called directly it
-- would error on the undefined NEW record anyway — this just removes the
-- /rest/v1/rpc/handle_new_user endpoint.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated, PUBLIC;

-- current_role_name() and is_admin() are helpers the RLS policies call. They
-- must stay callable by `authenticated` — a policy evaluates its functions as
-- the querying role, and revoking that breaks every policy that uses them.
-- But no policy is `TO anon`, so anon never needs them: close that endpoint.
-- (For anon they only ever returned NULL anyway — auth.uid() is null — so this
-- is tidiness, not a plugged leak.)
REVOKE EXECUTE ON FUNCTION public.current_role_name() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_role_name() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- st_estimatedextent is a PostGIS C function that happens to be SECURITY
-- DEFINER (it reads pg_statistic). Nothing in this app calls it. Taking it off
-- the API surface clears six findings. Guarded: if PostGIS is owned by a role
-- we are not a member of, the REVOKE is not ours to make — skip it and dismiss
-- those findings instead.
DO $$
BEGIN
  REVOKE EXECUTE ON FUNCTION public.st_estimatedextent(text, text)
    FROM anon, authenticated, PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.st_estimatedextent(text, text, text)
    FROM anon, authenticated, PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.st_estimatedextent(text, text, text, boolean)
    FROM anon, authenticated, PUBLIC;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'st_estimatedextent revoke skipped (%). Dismiss these in the Advisor.', SQLERRM;
END $$;

-- ===========================================================================
-- Assessed and deliberately NOT changed
-- ===========================================================================
--
-- * rls_policy_always_true on trucks / drivers / orders / loads / load_items /
--   stop_visits / geocode_cache — the `<table>_authenticated USING (true)`
--   policies are the design (migration 0004): two roles, both trusted staff
--   provisioned by an admin, sharing one dispatch board. There is no per-user
--   row ownership to enforce here. The access control that matters is on
--   `integration_settings` (admin only) and `profiles` (own row, role pinned),
--   and those are real policies. Revisit only if per-user data isolation
--   becomes a requirement.
--
-- * extension_in_public (postgis) and rls_disabled_in_public on
--   spatial_ref_sys — PostGIS lives in `public`. The real fix is `ALTER
--   EXTENSION postgis SET SCHEMA extensions`, disruptive on a live database
--   with geography columns and not worth the risk here. spatial_ref_sys is the
--   read-only EPSG registry; it holds no business data. Dismiss these.
--   (The st_estimatedextent findings are handled above where permissions
--   allow, otherwise dismiss those too.)
--
-- * auth_leaked_password_protection — a dashboard toggle, not SQL:
--   Authentication -> Policies -> enable "Leaked password protection".
--   Worth doing now that /account lets users set their own password.

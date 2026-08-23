-- Authentication and roles.
--
-- Two roles today:
--   * `admin`      — every module, including Integrations
--   * `dispatcher`  — every module except Integrations
--
-- Adding a role is a value in the CHECK plus a row in the module registry
-- (`web/src/lib/auth/roles.ts`). Nothing else should branch on role by name.
--
-- The app hides modules a role cannot use, but hiding a nav item is a
-- convenience, never the control. The control is here: policies on the tables,
-- so a hand-rolled PostgREST call from a dispatcher's browser is refused by
-- the database rather than by the UI that did not render a link.

-- ===========================================================================
-- 1. Profiles — the row that ties a Supabase Auth user to a role
-- ===========================================================================

CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'dispatcher'
    CHECK (role IN ('admin', 'dispatcher')),
  -- Which terminal this person dispatches from; shown in the app shell.
  depot TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Every authenticated user gets a profile, defaulting to the *lower* privilege.
-- Defaulting to 'admin' would mean a new signup silently gains access to
-- integration credentials.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, role)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data ->> 'full_name',
    'dispatcher'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Backfill for users who already existed.
--
-- The trigger above only fires on INSERT, so anyone created in the Supabase
-- dashboard *before* this migration ran has no profile — and with RLS on, no
-- profile means no role, which means locked out of everything. Idempotent, so
-- it is safe on a fresh database too (where it simply finds nothing).
INSERT INTO public.profiles (id, full_name, role)
SELECT
  u.id,
  COALESCE(u.raw_user_meta_data ->> 'full_name', split_part(u.email, '@', 1)),
  'dispatcher'
FROM auth.users u
ON CONFLICT (id) DO NOTHING;

-- Bootstrap the first admin.
--
-- Someone has to be able to reach Integrations, and nobody can promote
-- themselves — `profiles_update_self` pins `role` to its existing value. That
-- is deliberate, and it means the first admin must be set here rather than in
-- the app. Change the address to suit; re-running is harmless.
UPDATE public.profiles p
   SET role = 'admin',
       depot = 'Ballymount Terminal, Dublin'
  FROM auth.users u
 WHERE u.id = p.id
   AND lower(u.email) = 'admin@balkania.ie';

UPDATE public.profiles p
   SET depot = 'Ballymount Terminal, Dublin'
  FROM auth.users u
 WHERE u.id = p.id
   AND lower(u.email) = 'dispatch@balkania.ie';

-- ===========================================================================
-- 2. Role helpers
-- ===========================================================================
--
-- SECURITY DEFINER so a policy on `profiles` can call it without recursing
-- into `profiles`' own RLS. STABLE so the planner calls it once per statement.

CREATE OR REPLACE FUNCTION public.current_role_name()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.current_role_name() = 'admin', FALSE);
$$;

-- ===========================================================================
-- 3. Integration settings — the thing the Integrations module actually gates
-- ===========================================================================
--
-- Secrets stay in environment variables and never reach this table; `config`
-- holds non-secret connector settings (endpoints, toggles, retention windows)
-- plus a redacted status. That way an accidental read leaks preferences, not
-- credentials.

CREATE TABLE integration_settings (
  connector_id TEXT PRIMARY KEY,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===========================================================================
-- 4. Row Level Security
-- ===========================================================================

ALTER TABLE profiles             ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucks               ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers              ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders               ENABLE ROW LEVEL SECURITY;
ALTER TABLE loads                ENABLE ROW LEVEL SECURITY;
ALTER TABLE load_items           ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications        ENABLE ROW LEVEL SECURITY;

-- --- profiles -------------------------------------------------------------
-- Everyone sees their own row; admins see and manage the whole team. Nobody
-- may edit their own `role` — that would make every restriction voluntary.

CREATE POLICY profiles_select_self ON profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.is_admin());

CREATE POLICY profiles_update_self ON profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND role = (SELECT p.role FROM profiles p WHERE p.id = auth.uid())
  );

CREATE POLICY profiles_admin_all ON profiles
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- --- integration settings: admin only, read included ----------------------
-- This is the whole point of the Integrations restriction. A dispatcher gets
-- zero rows here, whatever the UI does.

CREATE POLICY integration_settings_admin_only ON integration_settings
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- --- operational data: both roles ----------------------------------------
-- Dispatchers do the day-to-day work, so they read and write these freely.
-- Tightening a specific table later means replacing that table's policy, not
-- restructuring this file.

CREATE POLICY trucks_authenticated ON trucks
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY drivers_authenticated ON drivers
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY orders_authenticated ON orders
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY loads_authenticated ON loads
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY load_items_authenticated ON load_items
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);

-- Notifications are the alert log — personal data. Readable by the team, but
-- only the service role writes them, because a row here asserts that a message
-- was actually sent to a customer.
CREATE POLICY notifications_read ON notifications
  FOR SELECT TO authenticated USING (TRUE);

-- Note: the service-role key used by the webhook and cron routes bypasses RLS
-- entirely. That is intended — those routes have no user session. Keep that key
-- server-only; `lib/supabase/service.ts` must never be imported into a client
-- component.

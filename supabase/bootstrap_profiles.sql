-- Run this in the Supabase SQL editor.
--
-- Why it exists separately from migration 0004: the profile backfill was added
-- to 0004 *after* the migrations may already have been applied. If 0004 ran
-- before that edit, the two users created in the dashboard have no `profiles`
-- row — and with RLS on, no profile means no role, which means signed in but
-- locked out of everything, admin included.
--
-- Safe to run repeatedly, and safe to run even if 0004 already did this work.

-- ---------------------------------------------------------------------------
-- 1. What does it look like right now?
-- ---------------------------------------------------------------------------
SELECT
  u.email,
  p.id IS NOT NULL AS has_profile,
  p.role,
  p.depot
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
ORDER BY u.email;

-- ---------------------------------------------------------------------------
-- 2. Give every auth user a profile. Lower privilege by default — a missing
--    profile must never become an admin by accident.
-- ---------------------------------------------------------------------------
INSERT INTO public.profiles (id, full_name, role)
SELECT
  u.id,
  COALESCE(u.raw_user_meta_data ->> 'full_name', split_part(u.email, '@', 1)),
  'dispatcher'
FROM auth.users u
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Bootstrap the admin.
--
--    This cannot be done from inside the app: `profiles_update_self` pins
--    `role` to its existing value, so nobody can promote themselves. That is
--    the point of the policy, and it is why the first admin is set here.
-- ---------------------------------------------------------------------------
UPDATE public.profiles p
   SET role = 'admin',
       depot = 'Ballymount Terminal, Dublin',
       full_name = COALESCE(p.full_name, 'Admin')
  FROM auth.users u
 WHERE u.id = p.id
   AND lower(u.email) = 'admin@balkania.ie';

UPDATE public.profiles p
   SET depot = 'Ballymount Terminal, Dublin',
       full_name = COALESCE(p.full_name, 'Dispatch')
  FROM auth.users u
 WHERE u.id = p.id
   AND lower(u.email) = 'dispatch@balkania.ie';

-- ---------------------------------------------------------------------------
-- 4. Confirm. Expect exactly one admin and one dispatcher.
-- ---------------------------------------------------------------------------
SELECT u.email, p.role, p.depot
FROM public.profiles p
JOIN auth.users u ON u.id = p.id
ORDER BY p.role, u.email;

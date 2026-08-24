-- Why can admin@balkania.ie not see Integrations?
--
-- Run this ONE query first. The Supabase SQL editor only shows the last
-- result set, so run it on its own before running bootstrap_profiles.sql.

SELECT
  u.email,
  u.id                                   AS auth_user_id,
  (p.id IS NOT NULL)                     AS has_profile_row,
  p.role,
  CASE
    WHEN p.id IS NULL              THEN 'NO PROFILE ROW -> app defaults to dispatcher. Run bootstrap_profiles.sql.'
    WHEN p.role = 'admin'          THEN 'OK - should see Integrations. If not, sign out and back in.'
    WHEN p.role = 'dispatcher'     THEN 'Role is dispatcher. Run bootstrap_profiles.sql to promote.'
    ELSE                                'Unexpected role: ' || p.role
  END                                    AS diagnosis
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
ORDER BY u.email;

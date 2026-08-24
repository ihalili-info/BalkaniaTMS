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
    WHEN p.id IS NULL
      THEN 'NO PROFILE ROW -> app defaults to dispatcher. Run bootstrap_profiles.sql.'
    WHEN p.role = 'admin'
      THEN 'OK - sees every module. Sign out and back in if the nav looks stale.'
    -- Only flag a dispatcher as wrong if this address is meant to be an admin.
    -- Most accounts SHOULD be dispatchers; saying otherwise sends people off
    -- promoting staff who were already correct.
    WHEN p.role = 'dispatcher' AND lower(u.email) LIKE 'admin@%'
      THEN 'Expected admin but is dispatcher -> promote this one.'
    WHEN p.role = 'dispatcher'
      THEN 'OK - dispatcher. Every module except Integrations. No action needed.'
    ELSE 'Unexpected role: ' || p.role
  END                                    AS diagnosis
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
ORDER BY u.email;

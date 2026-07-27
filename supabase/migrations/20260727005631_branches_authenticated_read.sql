-- Logged-in users (e.g. tech app sessions) could not read branches: the only
-- policy was "anon full access". Branches is reference data and anon can
-- already read everything, so authenticated read is strictly narrower.
-- Needed by lib/auth/tech-scope.ts (follow-up-only branch check).
create policy "authenticated read" on public.branches
  for select to authenticated using (true);

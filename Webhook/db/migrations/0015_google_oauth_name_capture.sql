-- Teach handle_new_user to find a name in Google's metadata, not just the
-- `first_name` our own magic-link modal sets.
--
-- signInWithOtp lets us choose the metadata key, so 0010 could just read
-- raw_user_meta_data->>'first_name'. An OAuth provider chooses its own keys:
-- Google sends given_name, family_name, name, and full_name, and never
-- first_name. Left alone, every Google signup would land a profile with
-- first_name null, and Profile.tsx's `profile?.first_name || email` greeting
-- would fall back to addressing people by their email address.
--
-- Note this trigger fires on INSERT into auth.users, i.e. genuinely new
-- accounts only. An existing magic-link user who later signs in with Google
-- gets their Google identity linked to the SAME auth.users row (Supabase
-- links automatically when the email matches and is verified), so no row is
-- inserted, this doesn't run, and their existing name is left alone. That's
-- the intent: never overwrite a name someone typed themselves.

BEGIN;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  launch_reviews constant int      := 10;
  launch_window  constant interval := interval '90 days';
  meta           jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  -- Supabase populates full_name for most providers and passes Google's own
  -- `name` through as well; treat either as the same fact.
  whole_name     text  := nullif(trim(coalesce(meta->>'full_name', meta->>'name')), '');
  space_at       int;
  resolved_first text;
  resolved_last  text;
begin
  -- Our own modal's key wins, then Google's structured field, then the first
  -- token of the display name as a last resort.
  resolved_first := coalesce(
    nullif(trim(meta->>'first_name'), ''),
    nullif(trim(meta->>'given_name'), ''),
    nullif(split_part(coalesce(whole_name, ''), ' ', 1), '')
  );

  resolved_last := nullif(trim(meta->>'family_name'), '');

  -- Only split a display name that actually has a space in it. Without this
  -- guard a single-word name would set last_name to the same value as
  -- first_name. Everything after the FIRST space, so a multi-part surname
  -- like "Van Der Molen" survives intact.
  if resolved_last is null and whole_name is not null then
    space_at := position(' ' in whole_name);
    if space_at > 0 then
      resolved_last := nullif(trim(substring(whole_name from space_at + 1)), '');
    end if;
  end if;

  insert into public.profiles (
    id, email, review_slug, reviews_limit, access_expires_at, first_name, last_name
  )
  values (
    new.id,
    new.email,
    public.generate_review_slug(),
    launch_reviews,
    now() + launch_window,
    resolved_first,
    resolved_last
  );
  return new;
end;
$$;

COMMIT;

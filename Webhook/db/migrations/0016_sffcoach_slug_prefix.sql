-- Rebrand the review-address prefix from "ffcoach" (0004) to "sffcoach", to
-- match the Stay Fully Funded name. New signups get addresses like
-- sffcoach2a9c6b94@review.stayfullyfunded.com. Existing slugs are untouched;
-- only future signups get the new prefix.
-- Applied live via Supabase MCP on 2026-08-05; recorded here for parity.

begin;

create or replace function public.generate_review_slug()
returns text
language plpgsql
as $$
declare
  candidate text;
  taken     boolean;
begin
  loop
    -- 'sffcoach' brand prefix (Stay Fully Funded, was 'ffcoach') + 8 random
    -- lowercase hex chars from a uuid.
    candidate := 'sffcoach' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
    select exists(select 1 from public.profiles where review_slug = candidate) into taken;
    exit when not taken;
  end loop;
  return candidate;
end;
$$;

commit;

# Build Spec — Phase 2: Brand Rename Code & Content Changes

> # ⚠️ PARTIALLY IMPLEMENTED — mostly settled, two footnotes below
>
> **Status as of Aug 2026.** Tasks 3, 4, 6, 7 and 8 shipped and are live on
> `main`.
>
> **Task 5's dual-domain inbound filter was never built, and it turns out it
> doesn't need to be.** This spec called it "the one real logic change" and
> "load-bearing" on the assumption that `review.foreverfunded.org`'s live MX
> record meant mail to it could still reach the Worker. Checked directly
> against Postmark: **Sending & Receiving Domains has a single "Inbound
> domain" field, not a list**, and the Activity log shows zero hits, ever,
> for the old address. Postmark's inbound routing is per-Server with one
> Inbound domain; a live MX record alone doesn't matter if that domain isn't
> the one currently mapped there — the platform rejects it upstream, before
> anything reaches `inbound.js`. So the rename was already a hard cutover at
> the inbound-mail layer specifically, whether or not this task ran.
>
> A real, separate bug WAS found and fixed along the way: multi-recipient
> parsing in `resolveReviewRecipient` (`Webhook/lib/email.js`) now checks
> `OriginalRecipient` and Cc/Bcc, and only falls back to guessing from the
> raw `To` string when there are no structured recipients at all. The
> previous fallback took the *first* address in a multi-recipient `To`,
> which for an ESP send-to-self-and-review-address pattern silently resolved
> to the wrong token — a real defect, just orthogonal to which domain was
> involved. An earlier version of this fix also added a
> `LEGACY_REVIEW_DOMAINS` acceptance list and an in-report notice for mail
> arriving at the old domain; both were removed once the above made clear
> that code path is unreachable on this platform, not dormant insurance.
>
> **Task 1 / Checkpoint 5's "do not merge, do not push to the default branch"
> was not honored.** Commits `98678b0`, `474ea82`, `d08f630` are on `main`.
> The `rename/stay-fully-funded` branch still exists and now differs from
> `main` by a single file.
>
> **Task 9's "do not rename any file" was overridden** for the framework doc.
> Files still carrying the old brand in their name: `forever-funded-framework.md`,
> `Course/forever-funded-lesson-0{1,2,3,4}-*.md`,
> `Course/forever-funded-email-coach-framework.md`,
> `Website/forever-funded-coach-landing-copy.md`,
> `Website/forever-funded-landing-build-spec.md`,
> `Website/src/assets/forever-funded-logo-final.svg`, and the
> `Website/public/forever-funded-mark-*` set.
>
> **Not a defect:** `Webhook/wrangler.toml`'s `name = "forever-funded-email-coach"`
> and the `forever-funded-email-coach.brett-66b.workers.dev` URL in
> `Website/src/lib/constants.ts` are intentionally unchanged (category C).
> Renaming the Worker would break both Postmark and, later, the Stripe webhook.
>
> Task 7's `login@auth.foreverfunded.org` change has no target in the repo —
> it's dashboard-only config.

**For:** Claude Code
**Goal:** Rename the brand from "Forever Funded" (foreverfunded.org) to "Stay Fully
Funded" (stayfullyfunded.com) across the repo, on a branch, with nothing deployed.
Infrastructure for the new domain is already live and verified — this task is code
and content only.

---

## Hard rules (read before making any edit)

1. **Targeted find-and-replace only. Never hand back a full replacement file.**
   This repo's Worker code uses ES-module style (`export default`, `env` bindings).
   Full-file rewrites have twice been returned in Node/CommonJS style and crashed
   the live Worker. Every edit in this spec is a string-level or block-level
   replacement inside an existing file. Do not restructure, reformat, or
   "modernize" any file you touch.

2. **Do not deploy anything.** All work happens on a branch. Deployment is a
   separate, later phase performed by Brett.

3. **Do not rename the Worker, the Supabase project, or the Pages project.**
   The Worker URL is the target of both the Postmark inbound webhook and the
   Supabase DB webhook. Renaming it breaks both. These identifiers are not
   user-facing. Leave them exactly as they are, including any occurrences of the
   string `forever-funded` inside Worker names, project refs, or `*.workers.dev`
   URLs. See "Strings that must NOT change" below.

4. **Stop at each checkpoint** and report back before continuing.

---

## Context you need

- **Old brand:** "Forever Funded" · old domain: `foreverfunded.org`
- **New brand:** "Stay Fully Funded" · new domain: `stayfullyfunded.com`
- **Parent brand:** "Fully Funded" (used only where a parent-brand reference
  already exists; do not introduce new uses)
- **Product name:** "Stay Fully Funded Email Coach"
- **Old review address domain:** `@review.foreverfunded.org`
- **New review address domain:** `@review.stayfullyfunded.com`
- **Old auth/sending subdomain:** `auth.foreverfunded.org`
- **New auth/sending subdomain:** `auth.stayfullyfunded.com`
- **Legal entity:** unchanged — VMX Media. Do not alter entity names in legal
  pages, only brand and domain references.

**Grace period:** 60+ days. The Worker must accept inbound mail at BOTH the old
and new review domains for the entire grace period. This is load-bearing — if the
old domain is dropped early, a user sending a draft to their existing address gets
a silent bounce.

---

## Task 1 — Create the branch

Create a branch off the current default branch named `rename/stay-fully-funded`.
All subsequent work lands here.

**CHECKPOINT 1:** Confirm branch created and report the base commit.

---

## Task 2 — Inventory before editing

Run a full repo search (including `Course/` and `Webhook/` subfolders, all file
types, excluding `node_modules` and `.git`) for each of these, case-insensitive
where appropriate:

- `Forever Funded`
- `forever-funded`
- `foreverfunded`
- `ForeverFunded`
- `FOREVER_FUNDED`

Produce a report grouped by file, with line numbers and the matched line, and
classify each hit into one of:

- **(A) Brand string** — user-facing product/brand name → will change
- **(B) Domain string** — a `foreverfunded.org` reference → will change
- **(C) Infrastructure identifier** — Worker name, `*.workers.dev` URL, Supabase
  project ref, Pages project name, GitHub repo name → **must NOT change**
- **(D) Filename** — a file whose *name* contains the old brand → see Task 9
- **(E) Uncertain** — flag for Brett rather than guessing

**CHECKPOINT 2:** Present the classified inventory. Do not make any edits until
Brett confirms the classification, particularly every item in category (C) and
(E). This inventory is the safety net for the whole task.

---

## Task 3 — Frontend brand and domain strings

For each file the inventory flagged as (A) or (B) in the frontend:

- Replace `Forever Funded` → `Stay Fully Funded`
- Replace `foreverfunded.org` → `stayfullyfunded.com`

Cover, at minimum: nav, hero copy, footer, page titles, `<meta>` description,
Open Graph tags (`og:title`, `og:site_name`, `og:url`, `og:image` alt), Twitter
card tags, favicon/manifest names and alt text, any `<title>` elements, and any
JSON-LD or structured-data blocks.

Do each as a discrete find-and-replace. Do not rewrite surrounding markup.

---

## Task 4 — Review-address domain in the `/profile` display

The `/profile` page composes the user's review address by appending a hardcoded
domain suffix to the stored `review_slug`. Find that suffix string and change it:

- `review.foreverfunded.org` → `review.stayfullyfunded.com`

Note: the slug itself is stored per-user in the database and needs no migration —
every existing slug works unchanged at the new domain. Do not touch slug
generation, storage, or any database logic.

---

## Task 5 — Worker inbound filter (dual-domain, the one real logic change)

This is the only edit in this spec that is not a pure string swap.

The Worker resolves the inbound recipient by filtering Postmark's `ToFull` array
to addresses at the review domain, then using the localpart as the slug. It
currently matches a single hardcoded domain (`@review.foreverfunded.org`).

**Change it to accept both domains, treating them as fully equivalent** — same
profile lookup, same quota handling, same report, no difference in behavior and no
note appended for old-domain senders.

Implementation guidance:

- Introduce a small constant array of accepted review domains near the existing
  domain constant, e.g. two entries: the new domain and the old one.
- Change the recipient filter to match if the address ends with *any* entry in
  that array.
- Keep the existing localpart extraction and slug lookup unchanged.
- Preserve the file's existing ES-module style and formatting exactly.
- Add a brief comment on the old-domain entry noting it is a grace-period
  allowance to be removed after the grace period ends (Phase 6), so it is not
  mistaken for permanent config.

Do not change any other Worker behavior: no changes to quota checks, the Anthropic
call, report generation, error handling, or the Postmark send path.

**CHECKPOINT 3:** Show the before and after of this specific edit as a diff, and
confirm the file still parses. Wait for approval before continuing.

---

## Task 6 — Coach system prompt (lives in TWO places)

The Coach's brand name appears inside a long prompt string, not an obvious config
value, which makes it easy to miss. It must be changed in both locations:

1. **The framework markdown document** at the project root (the email coach
   framework file). The prompt opens with a line naming the Coach.
2. **The `COACH_SYSTEM_PROMPT` string inside `lib/coachPrompt.js`.**

In both, replace:

- `Forever Funded Email Coach` → `Stay Fully Funded Email Coach`

Then search both files for any remaining `Forever Funded` occurrences (the brand
may appear more than once in the prompt body) and replace those too.

For `lib/coachPrompt.js`: this is a targeted string edit inside an existing
template literal. Do not reformat the prompt, re-wrap lines, or alter any other
prompt content — the prompt is calibrated and every other word in it should remain
byte-identical.

**CHECKPOINT 4:** Report every line changed in both files, and confirm no other
prompt content was altered.

---

## Task 7 — Email templates and report output

Update brand and domain references in:

- The welcome email template
- The login / magic-link email template
- `lib/reportTemplate.js` — the fixed wrapper applied to every Coach report:
  brand name, any domain references, footer
- The report/PDF referral footer line: `Reviewed with the Forever Funded Email
  Coach` → `Reviewed with the Stay Fully Funded Email Coach`

Also update the Supabase custom SMTP sender address wherever it appears as a
string in the repo (the dashboard-side change is Brett's, in a later phase):

- `login@auth.foreverfunded.org` → `login@auth.stayfullyfunded.com`

`reportTemplate.js` controls the single consistent visual style for all reports.
Change only brand and domain strings in it. Do not alter any styling, layout, CSS,
or structure.

---

## Task 8 — Legal pages

In the privacy policy and terms of service:

- Replace brand references: `Forever Funded` → `Stay Fully Funded`
- Replace domain references: `foreverfunded.org` → `stayfullyfunded.com`
- Update any contact email addresses at the old domain to the new domain
- **Leave the legal entity name unchanged.** The operating entity remains VMX
  Media. If the pages name VMX Media, that stays exactly as-is.

---

## Task 9 — Filenames containing the old brand

Some files are *named* with the old brand (for example, the email coach framework
markdown document). Renaming files is riskier than editing their contents, because
imports, build config, or external references may point at them.

**Do not rename any file in this task.** Instead, produce a list of files whose
names contain `forever-funded` or `foreverfunded`, and for each note whether
anything in the repo imports or references it by name. Present that list for
Brett's decision.

---

## Task 10 — Sweep for anything missed

Re-run the same searches from Task 2. Every remaining hit must be either:

- an item in category (C) that must not change (Worker name, `*.workers.dev` URL,
  Supabase project ref, Pages/GitHub project names), or
- a filename from Task 9 awaiting a decision, or
- something explicitly approved to remain.

Report anything else.

---

## Strings that must NOT change

Do not modify any of these, even though they contain the old brand:

- The Cloudflare Worker name and its `*.workers.dev` URL
- The Supabase project ref and its `*.supabase.co` URL
- The Cloudflare Pages project name and its `*.pages.dev` subdomain
- The GitHub repository name
- Any webhook URL pointing at the Worker (Postmark inbound, Supabase DB webhook)
- Historical content: changelog entries, commit messages, dated notes

These are internal identifiers, invisible to users once a custom domain is
attached. Renaming them breaks live webhooks and buys nothing.

---

## Task 11 — Pre-deploy verification (do not deploy)

On the branch, with nothing pushed live:

1. Run the local boot / dev server and confirm the app starts without errors.
2. Confirm the Worker file parses and, if a local Worker dev command exists, that
   it boots.
3. Confirm the Postmark inbound webhook URL in config still points at the
   unchanged Worker URL.
4. Grep the built output (if a build step exists) for `foreverfunded` and report
   any hits outside the allowed list above.

**CHECKPOINT 5 (final):** Report:

- Full list of files changed, with a one-line summary per file
- The complete diff for `lib/coachPrompt.js` and the Worker inbound filter
- Local boot result
- Any remaining `foreverfunded` occurrences and why each is allowed
- Filename decisions still outstanding from Task 9

Then stop. Do not merge, do not push to the default branch, do not deploy.

---

## Out of scope for this task

For clarity, none of the following belong in this phase:

- Deploying to Cloudflare Pages or attaching the custom domain
- Any Supabase dashboard changes (Auth URL configuration, custom SMTP sender)
- Any database migration or SQL (there is none needed — slugs are unchanged)
- Any DNS or Postmark changes (already complete and verified)
- Removing the old-domain branch from the Worker filter (that is Phase 6, after
  the 60-day grace period)
- Logo and brand asset files (pending the designer)

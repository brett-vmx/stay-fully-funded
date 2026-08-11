# Claude Design brief: Stay Fully Funded design system

Paste everything below the line into Claude Design. It is written to be
self-contained: it carries the real token values from `Website/src/index.css`
and the real component patterns from `Website/src/components/`, so nothing has
to be inferred or invented.

Upload these four files alongside the prompt (from `Website/public/`):
`SFF-Logo-transparent.png`, `SFF-Logo-white.png`,
`SFF-Logo-transparent-white.png`, `SFF-Logo-green-white.png`.

---

## Project

**Stay Fully Funded** is a product for ministry workers and missionaries who
write supporter update emails. The live product is an AI **Email Coach**: you
send it a draft, and about 83 seconds later it emails back a personal,
point-by-point review. It checks 22 best practices and 26 common mistakes. A
**Course** teaching the same framework is coming later and will inherit this
same design system.

The audience is not designers or startup people. They are working ministry
staff, many of them overseas, often not young, reading on phones with poor
connections. The product's whole promise is helping them sound more like
themselves, not more like software.

## What I need

A **design system** I can apply consistently across the marketing site,
transactional emails, the Coach's generated report, social images, and later
the Course.

Then, as the first artifact produced from it: a **1200×630 Open Graph image**
(details at the end).

## Brand personality

Warm, plain, specific. A seasoned ministry mentor talking to a peer, not a
SaaS dashboard, not a startup landing page, not a church bulletin. Confident
and calm. Nothing slick, nothing corporate, nothing cute.

The visual language already leans toward soft emerald bands, generous
whitespace, heavy rounded shapes, and a warm near-white background rather than
stark white or beige.

## Existing tokens (fixed, please build on them)

These are the live CSS custom properties. Treat the hex values as canonical.

### Color

**Brand (emerald)**
| Token | Hex | Role |
|---|---|---|
| `primary` | `#059669` | brand, primary buttons, accent words in headings |
| `primary-dark` | `#047857` | hover, links, text on light, dark section bands |
| `primary-light` | `#10b981` | accent / highlight |

**Accents (internally called "Forest Hearth")**
| Token | Hex | Role |
|---|---|---|
| `brick` | `#852525` | errors, "needs fixing" state |
| `brown` | `#662b00` | text on camel |
| `camel` | `#e6a373` | warm band background, "coming soon" badges |

**Ink & neutrals**
| Token | Hex | Role |
|---|---|---|
| `ink` | `#17231d` | body text, a dark warm green-charcoal, deliberately not black |
| `muted` | `#5b665f` | secondary text |
| `bg` | `#fcfcfb` | page background: clean near-white, explicitly NOT beige |
| `surface` | `#ffffff` | cards |
| `border` | `#e8e8e2` | hairlines |

**Section band tints** (pale, low saturation, used to alternate down a page so
it never reads as a wall of white cards)
| Token | Hex |
|---|---|
| `band-emerald` | `#f0faf6` |
| `band-tan` | `#fbf3ea` |
| `band-brick` | `#fbf1f0` |

The report uses a three-state severity language that should be formalized:
✅ good (emerald) · 🟠 worth considering (camel/brown) · 🔴 needs fixing (brick).

### Type

- **Headings:** Outfit, weights 500, 600, 700
- **Body:** Inter, weights 400, 500, 600
- Headings use `text-wrap: balance`
- Eyebrows: Outfit, `0.875rem`, semibold, uppercase, letter-spacing `0.14em`,
  usually in `primary-dark`

### Shape & depth

- Border radius in active use, by frequency: **fully rounded** (all buttons and
  pills), **`1rem`** (cards, the default), `0.75rem`, `0.5rem`
- Buttons are **always fully rounded**, never square or slightly-rounded
- Shadows are soft and restrained: a small default, a medium on hover
- Some emphasis cards use a **2px solid ink border** plus a `primary/30` ring,
  which is a distinctive existing pattern worth keeping
- Focus ring: 2px solid `primary`, 2px offset

## Existing component patterns to codify

- **Buttons:** 5 variants: `primary` (emerald fill, white text),
  `ghost`, `outline` (ink border on white), and two for use on dark emerald
  surfaces: `onDark` (white fill) and `onDarkMuted` (pale emerald fill). Three
  sizes. All pill-shaped.
- **Section bands:** full-bleed tinted background + centered `max-w-6xl`
  container, tints cycling down the page.
- **Pills / badges:** low-opacity tinted background with a darker text color
  of the same hue. Example: emerald at 15% with `primary-dark` text; camel at
  30% with `brown` text.
- **Cards:** white surface, hairline border, `1rem` radius, soft shadow.
- **Usage meter, checklists, severity rows:** see the three-state language above.

## Logo

Four variants exist (attached). The mark is an abstract emerald "X"/envelope
form with a light-to-dark gradient:

| File | Use |
|---|---|
| `SFF-Logo-transparent.png` | primary. Gradient mark, transparent, on light backgrounds |
| `SFF-Logo-transparent-white.png` | solid white mark, transparent. Use on dark/colored backgrounds |
| `SFF-Logo-white.png` | mark on a solid white square. Needs rounded corners applied |
| `SFF-Logo-green-white.png` | white mark on a solid `#059669` square. App icon / favicon |

Please define clear rules for: minimum size, clear space, which variant on
which background, and what not to do (no recoloring, no stretching, no drop
shadows on the mark, no placing the transparent gradient variant on dark).

## Copy rules (these are strict)

- **Never use em dashes (—).** They read as AI-written, which actively
  undermines a product whose promise is helping people sound like themselves.
  Use a comma, period, colon, or parentheses instead. En dashes in number
  ranges ("3–4 pages") are fine.
- Avoid other AI tells: hedging ("it's worth noting"), inflated transitions
  ("moreover", "furthermore"), and tricolon overload.
- Sentence case for most UI. Headline style is short declaratives, often with a
  key word in emerald: "Send your email to Coach **first.**"

## Deliverables

1. **Color system:** the tokens above organized into semantic roles, with any
   gaps filled (success/warning/error, disabled, overlays).

   I have already measured the main pairings. Everything passes **WCAG AA** for
   normal text except one, and it is the important one:

   | Pairing | Ratio | Verdict |
   |---|---|---|
   | `ink` on `bg` | 15.80:1 | pass |
   | `muted` on `bg` | 5.83:1 | pass |
   | `brown` on `camel` | 5.16:1 | pass |
   | `primary-dark` on `band-emerald` | 5.15:1 | pass |
   | white on `primary-dark` | 5.48:1 | pass |
   | **white on `primary`** | **3.77:1** | **fails AA for normal text** |

   That last row is the primary button (`bg-primary` + white label), which is
   the main call to action on the site. No button size reaches the WCAG
   large-text threshold, so it fails at every size. Please propose a fix and
   show what it does to the rest of the system. The obvious candidate is
   promoting `primary-dark` (`#047857`, 5.48:1) to the button fill, but that
   collides with the current hover state, so the hover would need rethinking
   too. If you have a better answer that keeps `#059669` as the brand color
   while making the CTA accessible, I would rather have that.
2. **Type scale:** a real ramp (display through caption) with size, weight,
   line-height, and letter-spacing for each, in both desktop and mobile.
3. **Spacing & layout:** base unit, spacing scale, container widths, breakpoints.
4. **Component specs:** buttons (all 5 variants × 3 sizes × default/hover/
   active/focus/disabled), cards, badges/pills, form inputs, section bands.
5. **Logo usage rules:** as described above.
6. **Iconography & illustration direction:** the existing hero illustration is
   flat, geometric, friendly, with rounded forms and no outlines. Codify that.
7. **Social/OG template:** a reusable layout, not just one image.

## First artifact: the Open Graph image

Produce a **1200×630 PNG**.

It must contain:
- The new mark (use the appropriate variant for whatever background you choose)
- The words **Stay Fully Funded**
- The tagline **Send your email to Coach first.** With "first." in emerald if
  the background makes that legible

Constraints:
- Keep all text and the logo inside a safe area with roughly 100px of margin.
  Several platforms crop toward center, and Twitter's `summary_large_image`
  trims the edges.
- This gets viewed as a **small thumbnail** in Slack, iMessage, and LinkedIn
  far more often than at full size. Type must stay legible at about 400px wide.
  Err large.
- Must work on both light and dark chat backgrounds, so avoid relying on
  transparency, so give it a solid background.
- No em dash anywhere in it.

Context worth knowing: the image this replaces was dark slate with a small
green glyph and two lines of centered text, and it was too quiet at thumbnail
size. Feel free to go bolder and more emerald-forward.

Please also give me the **reusable template** behind it, so I can generate
matching images later for the Course launch and blog posts.

---

## Round 2 feedback: the first OG image is too detailed

The first `SFF-OG-image.png` you produced is a dense recreation of the hero
section (logo, eyebrow badge, full headline, two body paragraphs, both
best-practices/mistakes checklist cards, the character illustration, a CTA
button, and the URL) all packed into 1200×630. It reads well at full size, but
an OG image is judged at thumbnail size, not full size, and at thumbnail size
almost none of that content survives.

I resized it down to real link-preview widths to check. Attached are both
crops:

- At 400px wide (roughly a Slack or iMessage preview), both paragraphs and all
  four checklist rows in each card are already illegible, just gray texture.
- At 240px wide (a common mobile chat width), only "Stay Fully Funded" and the
  bold headline survive. Everything else, both paragraphs, both cards, the
  illustration's detail, and the URL at the bottom, is unreadable noise.

Three concrete problems to fix:

1. **Far too much content for the format.** Please cut this down to: the mark,
   "Stay Fully Funded", and the tagline "Send your email to Coach first." Drop
   the eyebrow badge, both paragraphs, both checklist cards, the character
   illustration (or shrink it to a small accent, not a co-equal focal point),
   the CTA button, and the URL. An OG image needs to be recognized in under a
   second, not read.
2. **Wrong dimensions.** It came out 1181×630, not the requested 1200×630 (19px
   short on width). Please deliver exact pixel dimensions this time. Some
   platforms will letterbox or stretch a mismatched size.
3. **Not enough safe margin.** The illustration and the "stayfullyfunded.com"
   text both sit close to the edge. Twitter's `summary_large_image` format and
   some other platforms crop toward center, so anything within roughly 100px
   of any edge is at risk of being clipped. Please pull everything well inside
   that margin.

Please regenerate at exactly 1200×630 with a much simpler layout, and check it
yourself at a small preview size before sending it back.

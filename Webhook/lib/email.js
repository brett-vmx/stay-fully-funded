// Small, pure helper functions for parsing the inbound email. Kept separate
// from api/inbound.js so each piece is easy to test on its own with sample
// strings, without needing a real Postmark payload.

/**
 * Given a raw "To" field like "Some Name <7k92mx@review.stayfullyfunded.com>"
 * or just "7k92mx@review.stayfullyfunded.com", return the lowercase localpart
 * ("7k92mx"), or null if it doesn't look like a valid address.
 *
 * We match on the recipient (not the sender) because ESP test-sends often
 * come FROM a platform address like "...@mailchimpapp.com" — the token in
 * the TO address is the one thing that's reliably the subscriber's own.
 */
export function extractToken(toField) {
  if (!toField) return null;
  const match = toField.match(/<?([a-zA-Z0-9._-]+)@[^>]+>?/);
  if (!match) return null;
  return match[1].toLowerCase();
}

/**
 * Works out which of OUR addresses an inbound message actually arrived at,
 * and the review token inside it. Returns { address, token, guessed }, all
 * null/false when nothing usable was found.
 *
 * `acceptedDomains` takes a list for generality, but in practice there is
 * exactly one: Postmark's inbound routing is per-Server with a single
 * Inbound domain field (verified in the dashboard, not inferred from DNS),
 * so a retired review domain never reaches this webhook at all — Postmark
 * rejects it upstream regardless of what its MX records still say. There is
 * no dual-domain grace period on this platform; changing the inbound domain
 * is a hard cutover, confirmed against Postmark's own Activity log (zero
 * hits for a retired domain, ever).
 *
 * Resolution order:
 *   1. OriginalRecipient — the envelope RCPT TO, unambiguous when it's ours.
 *      Some Postmark configurations put the inbound.postmarkapp.com form here
 *      instead, which simply won't match and falls through.
 *   2. Any structured recipient (To/Cc/Bcc) on an accepted domain. Cc and Bcc
 *      matter: some ESPs put the review address on Bcc, where it never shows
 *      up in ToFull at all.
 *   3. ONLY when there were no structured recipients whatsoever (a malformed
 *      payload), guess from the raw To string — flagged as `guessed: true`.
 *
 * Step 3 is deliberately narrow. Guessing whenever nothing matched previously
 * caused a real bug: extractToken takes the FIRST address in the string, and
 * an ESP test-send addressed to both the writer and their review address
 * yields the writer's own localpart — a plausible-looking token that matches
 * no profile, so the submission vanishes with no report and no error. That
 * failure mode is independent of which domain is in play.
 */
export function resolveReviewRecipient(payload, acceptedDomains) {
  const domains = (acceptedDomains || []).filter(Boolean).map((d) => d.toLowerCase());
  const onOurDomain = (addr) =>
    typeof addr === 'string' && domains.some((d) => addr.toLowerCase().endsWith('@' + d));

  const recipients = [payload?.ToFull, payload?.CcFull, payload?.BccFull]
    .filter(Array.isArray)
    .flat()
    .map((r) => r?.Email)
    .filter((e) => typeof e === 'string' && e);

  const address =
    (onOurDomain(payload?.OriginalRecipient) && payload.OriginalRecipient) ||
    recipients.find(onOurDomain) ||
    null;

  if (address) return { address, token: extractToken(address), guessed: false };

  if (recipients.length === 0) {
    const token = extractToken(payload?.To);
    if (token) return { address: null, token, guessed: true };
  }

  return { address: null, token: null, guessed: false };
}

// Header-block field names that show up in a forwarded email's routing
// metadata (From/Date/Subject/To, in whatever order/subset a given mail
// client emits) — never letter content, always stripped before the Coach
// sees it.
const FORWARD_HEADER_FIELD = /^(from|to|cc|bcc|sent|date|subject|reply-to):\s*\S/i;

/**
 * Locates a forwarded-message header block using the markers mail clients
 * insert automatically the moment someone hits "forward" — no custom
 * delimiter for the writer to learn. Recognizes:
 *  - Gmail's "---------- Forwarded message ---------" divider
 *  - Apple Mail's "Begin forwarded message:" line
 *  - Outlook-style: no divider/intro line at all, just a bare
 *    From:/Sent:(or Date:)/To:/Subject: block starting the forwarded content
 *
 * Returns null if none of these are found (an ordinary, non-forwarded body).
 * Otherwise returns { markerStart, headerEnd }, character offsets into a
 * body whose line endings have already been normalized to '\n': everything
 * before markerStart is the writer's own note (if any); everything from
 * headerEnd onward is the actual forwarded letter.
 */
function findForwardedHeaderBlock(normalizedBody) {
  const dividerMatch = normalizedBody.match(/^[ \t]*-{3,}[ \t]*forwarded message[ \t]*-{3,}[ \t]*$/im);
  const appleMatch = normalizedBody.match(/^[ \t]*begin forwarded message:[ \t]*$/im);

  let markerStart;
  let scanFrom;

  if (dividerMatch) {
    markerStart = dividerMatch.index;
    scanFrom = dividerMatch.index + dividerMatch[0].length;
  } else if (appleMatch) {
    markerStart = appleMatch.index;
    scanFrom = appleMatch.index + appleMatch[0].length;
  } else {
    const bareStart = findBareHeaderBlockStart(normalizedBody);
    if (bareStart === null) return null;
    markerStart = bareStart;
    scanFrom = bareStart;
  }

  return { markerStart, headerEnd: findHeaderBlockEnd(normalizedBody, scanFrom) };
}

/**
 * Outlook (and some other clients) insert no divider or intro line at all —
 * just the bare header block. Detected by finding a "From:" line confirmed
 * by Sent:/Date:, To:, and Subject: lines nearby (within the next few
 * lines), so an ordinary letter that happens to start a line with "From:" in
 * plain prose isn't misdetected as a forward.
 */
function findBareHeaderBlockStart(normalizedBody) {
  const lines = normalizedBody.split('\n');
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    if (/^from:\s*\S/i.test(lines[i])) {
      const window = lines.slice(i + 1, i + 8);
      const hasDateOrSent = window.some((l) => /^(sent|date):\s*\S/i.test(l));
      const hasTo = window.some((l) => /^to:\s*\S/i.test(l));
      const hasSubject = window.some((l) => /^subject:\s*\S/i.test(l));
      if (hasDateOrSent && hasTo && hasSubject) return offset;
    }
    offset += lines[i].length + 1;
  }
  return null;
}

/**
 * From a header block's start, walks forward past the marker/header field
 * lines and any blank lines between them, stopping at the first line that's
 * neither — that's where the actual forwarded letter begins. If the body
 * ends before any such line, the "letter" is simply empty.
 */
function findHeaderBlockEnd(normalizedBody, scanFrom) {
  const lines = normalizedBody.slice(scanFrom).split('\n');
  let offset = scanFrom;

  for (const line of lines) {
    if (line.trim() === '' || FORWARD_HEADER_FIELD.test(line)) {
      offset += line.length + 1;
      continue;
    }
    return offset;
  }
  return normalizedBody.length;
}

/**
 * Deterministic forward detection — never ask the model to guess this.
 * Checks an Fwd:/FW: subject prefix, plus any of the forwarded-message
 * markers findForwardedHeaderBlock recognizes (Gmail, Apple Mail, or a bare
 * Outlook-style header block).
 */
export function isForwarded(subject, textBody) {
  const subjectLooksForwarded = /^\s*(fwd|fw)\s*:/i.test(subject || '');
  const normalized = (textBody || '').replace(/\r\n/g, '\n');
  const bodyHasForwardedHeader = findForwardedHeaderBlock(normalized) !== null;
  return subjectLooksForwarded || bodyHasForwardedHeader;
}

const FORWARD_SUBJECT_PREFIX = /^\s*(fwd|fw)\s*:\s*/i;
const REPLY_SUBJECT_PREFIX = /^\s*re\s*:\s*/i;
// Leading ESP test markers, e.g. "[test] " or "[TEST][Draft] ". Mailchimp and
// friends prepend these ahead of anything the mail client added, so a
// forwarded test send arrives as "[test] Fwd: Real Subject" — the Fwd sits in
// second position, where a leading-anchored strip would miss it.
const BRACKETED_MARKERS = /^\s*(\[[^\]]{1,24}\]\s*)+/;

/**
 * Strips the client-injected "Fwd:"/"FW:" prefixes off a forwarded subject so
 * the Coach grades the subject line the writer actually chose, not the one
 * their mail client rewrote on the way in (see coachPrompt.js's subject-line
 * criterion, which treats these the same as an ESP's "[test]" marker).
 *
 * Loops rather than stripping once: isForwarded only needs to match a single
 * prefix to return true, but "Fwd: Fwd: Bearing Fruit" needs both removed or
 * the Coach still sees a prefix it will grade.
 *
 * "Re:" is stripped ONLY when another forward prefix still follows it, i.e.
 * it's interior noise in a Fwd/Re chain. A trailing "Re:" is left alone —
 * that one may be a subject the writer genuinely typed, and this function
 * removes routing artifacts, not the writer's own words.
 *
 * A leading ESP test marker ("[test] Fwd: Real Subject") is set aside first
 * and re-attached afterward, so the Fwd is still removed even though it isn't
 * in first position. The marker itself is left in place: coachPrompt.js
 * already tells the Coach to ignore it, and it's the ESP's text, not a
 * routing artifact this function owns.
 *
 * Callers keep using the raw subject for the stored record; this is only for
 * what the Coach evaluates and what the report email is titled after.
 */
export function stripForwardPrefix(subject) {
  const raw = subject || '';
  const markerMatch = raw.match(BRACKETED_MARKERS);
  const marker = markerMatch ? markerMatch[0].trim() : '';
  let out = marker ? raw.slice(markerMatch[0].length) : raw;
  for (;;) {
    if (FORWARD_SUBJECT_PREFIX.test(out)) {
      out = out.replace(FORWARD_SUBJECT_PREFIX, '');
      continue;
    }
    // Interior "Re:" — only drop it if the chain continues with another Fwd.
    if (REPLY_SUBJECT_PREFIX.test(out)) {
      const afterReply = out.replace(REPLY_SUBJECT_PREFIX, '');
      if (FORWARD_SUBJECT_PREFIX.test(afterReply)) {
        out = afterReply;
        continue;
      }
    }
    out = out.trim();
    return marker ? `${marker} ${out}`.trim() : out;
  }
}

/**
 * Splits writer-supplied context from the actual letter using the
 * "--- COACH CONTEXT ---" delimiter convention (see framework doc,
 * "Writer-supplied context"). Everything above the line is background for
 * the Coach; everything below is the letter to evaluate.
 *
 * If the delimiter isn't present, the whole body is treated as the letter
 * and context is null.
 */
export function splitContext(textBody) {
  if (!textBody) return { context: null, letter: '' };

  const delimiterPattern = /-{2,}\s*coach context\s*-{2,}/i;
  const match = textBody.match(delimiterPattern);

  if (!match) {
    return { context: null, letter: textBody.trim() };
  }

  const splitIndex = match.index + match[0].length;
  const context = textBody.slice(0, match.index).trim();
  const letter = textBody.slice(splitIndex).trim();

  return { context: context || null, letter };
}

/**
 * Splits a forwarded submission into the writer's own note (everything
 * typed above the forwarded-message marker, if anything) and the actual
 * letter (everything after the marker + header block — pure routing
 * metadata, never letter content). See findForwardedHeaderBlock for the
 * markers recognized.
 *
 * `found: false` means no forwarded marker was detected — the body is
 * returned unchanged as `letter`, exactly like a non-forwarded submission,
 * so ordinary letters are completely unaffected by this function's
 * existence.
 */
export function splitForwardedNote(textBody) {
  if (!textBody) return { note: null, letter: textBody || '', found: false };

  const normalized = textBody.replace(/\r\n/g, '\n');
  const block = findForwardedHeaderBlock(normalized);
  if (!block) return { note: null, letter: textBody, found: false };

  const note = normalized.slice(0, block.markerStart).trim();
  const letter = normalized.slice(block.headerEnd).trim();
  return { note: note || null, letter, found: true };
}

/**
 * Full body parse for a submission: composes two independent conventions
 * into one { context, letter } result.
 *  1. An explicit "--- COACH CONTEXT ---" delimiter, if the writer typed one
 *     (splitContext) — always wins as the source of `context` when present.
 *  2. A forwarded-message header block (splitForwardedNote) — if found and
 *     #1 didn't already supply context, anything the writer typed above the
 *     marker becomes context automatically. Either way, once a forwarded
 *     header block is found, it (and the marker) are stripped from `letter`
 *     — that's routing metadata, never content to evaluate — regardless of
 *     which convention ended up supplying `context`.
 */
export function parseSubmissionBody(textBody) {
  const { context: explicitContext, letter: afterExplicitSplit } = splitContext(textBody);
  const { note: forwardedNote, letter: afterForwardSplit, found } = splitForwardedNote(afterExplicitSplit);

  return {
    context: explicitContext || forwardedNote,
    letter: found ? afterForwardSplit : afterExplicitSplit,
  };
}

/** Rough word count — good enough for a read-time estimate, not precise typesetting. */
export function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Estimated read time in whole minutes, using ~220 wpm as a middle-of-the-range estimate. */
export function estimateReadMinutes(wordCount) {
  const WORDS_PER_MINUTE = 220;
  return Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE));
}

/** Byte size of the HTML body — this is what Gmail's ~102KB clip threshold actually measures. */
export function htmlByteSize(html) {
  if (!html) return 0;
  // TextEncoder is the web-standard way to measure UTF-8 bytes (Node's
  // Buffer isn't available in the Workers runtime).
  return new TextEncoder().encode(html).length;
}

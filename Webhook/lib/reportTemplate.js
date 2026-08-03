// The single source of the report's visual style. The Coach returns bare
// semantic HTML (headings, paragraphs, blockquotes, lists, the status dots);
// this wraps it in one consistent, understated look. Change the report's
// appearance here and every report inherits it — the model never styles
// anything itself.
//
// Design intent (per Brett's choices): reads like a thoughtful letter, not a
// dashboard. The status dots (🟢🟠🔴) are the ONLY color. Everything else is
// quiet — one system font, comfortable spacing, bold-but-not-loud headings,
// "The one thing" stands out by bold heading alone (no box).

export function wrapReport(coachHtml) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background:#ffffff;">
  <div style="
    max-width: 640px;
    margin: 0 auto;
    padding: 28px 22px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 16px;
    line-height: 1.55;
    color: #1a1a1a;
  ">
${coachHtml}
  </div>
</body>
</html>`;
}

/**
 * A lightweight <style>-free approach: because many email clients strip
 * <style> blocks and <head> CSS, the wrapper above sets the base font/color
 * inline on the container div. For the handful of element-level touches we
 * want (heading weight/size, blockquote indent, spacing), we inject a small
 * scoped <style> too — modern Gmail/Apple Mail honor it, and clients that
 * strip it simply fall back to clean default HTML, which still looks fine.
 *
 * If you ever see a client render this poorly, the safe fallback is to move
 * these rules to inline styles on each element — but that's only worth doing
 * if a real client actually breaks.
 */
export function wrapReportWithStyles(coachHtml) {
  const styles = `
    .ff-report h2 {
      font-size: 19px;
      font-weight: 700;
      color: #1a1a1a;
      margin: 8px 0 16px;
    }
    .ff-report hr {
      border: none;
      border-top: 1px solid #e0e0e0;
      margin: 40px 0 32px;
    }
    .ff-report h3 {
      font-size: 16px;
      font-weight: 700;
      color: #1a1a1a;
      margin: 32px 0 8px;
    }
    .ff-report p { margin: 0 0 14px; }
    .ff-report ul {
      list-style: none;
      margin: 0 0 14px;
      padding-left: 16px;
    }
    .ff-report li { margin: 0 0 12px; }
    .ff-report blockquote {
      margin: 0 0 16px;
      padding: 2px 0 2px 16px;
      border-left: 3px solid #d8d8d8;
      color: #333333;
      font-style: italic;
    }
    .ff-report .ff-note {
      background: #f6f4ef;
      border-left: 3px solid #c9b98f;
      padding: 12px 16px;
      margin: 0 0 24px;
      border-radius: 3px;
    }
    /* Brand green, matching the "Talk to Coach" box appended in postmark.js.
       Green reads as system chrome here; the tan .ff-note above is about the
       letter itself, so keeping them visually distinct matters. */
    .ff-report .ff-legacy {
      background: #f0faf6;
      border-left: 3px solid #059669;
      padding: 12px 16px;
      margin: 0 0 24px;
      border-radius: 3px;
    }
    .ff-report .ff-legacy p { margin: 0; }
    .ff-report .ff-legacy p + p { margin-top: 4px; }
  `.trim();

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${styles}</style>
</head>
<body style="margin:0; padding:0; background:#ffffff;">
  <div class="ff-report" style="
    max-width: 640px;
    margin: 0 auto;
    padding: 28px 22px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 16px;
    line-height: 1.55;
    color: #1a1a1a;
  ">
${coachHtml}
  </div>
</body>
</html>`;
}

/**
 * Per coachPrompt.js's forwarded-email instructions, the Coach opens its
 * report with one plain, unstyled <p> disclaiming that forwarding can affect
 * visual feedback — the prompt explicitly tells it "Do not style this note —
 * the wrapper will set it off visually." This is that promotion: it finds
 * that first paragraph and gives it the `.ff-note` callout treatment defined
 * above, instead of leaving it as plain body text.
 *
 * Only call this when the submission was actually forwarded — otherwise the
 * report's real opening line (Zone 1's warm one-line opener) would get
 * mistaken for the note and styled incorrectly.
 */
export function promoteForwardedNote(coachHtml, isForwardedEmail) {
  if (!isForwardedEmail) return coachHtml;
  return coachHtml.replace(/<p>/i, '<p class="ff-note">');
}

/**
 * Prepends a "your review address changed" callout when the submission
 * arrived at a retired review domain (see LEGACY_REVIEW_DOMAINS in
 * api/inbound.js). Pass a falsy `newAddress` and nothing is added.
 *
 * The writer still gets their full report — they asked for coaching, not
 * homework, and bouncing the mail or replying with instructions instead would
 * cost them the draft they just sent. The notice rides along so the stale
 * address actually gets updated in their email tool, which is the only thing
 * that ever lets us retire the old domain.
 *
 * ORDER MATTERS: call this AFTER promoteForwardedNote, never before.
 * That function promotes the FIRST <p> in the document to the .ff-note
 * callout, so a notice prepended ahead of it would steal the styling meant
 * for the Coach's forwarding disclaimer.
 */
export function prependLegacyAddressNotice(coachHtml, newAddress) {
  if (!newAddress) return coachHtml;
  return `<div class="ff-legacy">
  <p><strong>Your review address has changed.</strong></p>
  <p>This came in to your old address, which still works for now. When you get a chance, update the test address saved in your email tool to <strong>${newAddress}</strong>. The old one will be retired before long.</p>
</div>
${coachHtml}`;
}

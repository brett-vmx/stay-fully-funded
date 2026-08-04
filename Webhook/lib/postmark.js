// Sending via Postmark's REST API directly with fetch. The `postmark` npm
// package is built on Node-specific HTTP plumbing that isn't reliable in the
// Cloudflare Workers runtime — but the package is just a thin wrapper around
// this same https://api.postmarkapp.com/email endpoint, so calling it
// directly sends the exact same email.

async function postmarkSend(env, message) {
  const resp = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': env.POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify(message),
  });

  if (!resp.ok) {
    // Postmark returns a JSON body explaining the failure (e.g. unverified
    // sender, bad token). Surface it so the Worker log shows the real cause.
    const detail = await resp.text();
    throw new Error(`Postmark send failed (HTTP ${resp.status}): ${detail}`);
  }
}

/**
 * Sends the finished coaching report to the subscriber's REGISTERED account
 * email — never back to whatever address the submission arrived from,
 * since ESP test-sends often come from a platform address, not the
 * subscriber's own inbox.
 */
export async function sendReport(env, { toEmail, originalSubject, reportHtml }) {
  await postmarkSend(env, {
    From: `Stay Fully Funded Coach <${env.FROM_EMAIL}>`,
    To: toEmail,
    Subject: `Here's your report on "${originalSubject || 'your draft'}"`,
    HtmlBody: addChatHint(reportHtml),
    MessageStream: 'outbound', // adjust if you named your transactional stream differently
  });
}

/**
 * Additive to the emailed copy only (part-d-chat-addendum.md) — points
 * readers who only ever see the report in their inbox back to the portal's
 * Reports tab, where View / Talk to Coach / Download now live. Not applied to
 * the stored report_body itself, so the in-app view and PDF download stay
 * exactly as generated.
 *
 * Styled as a callout box matching the same left-border + tinted-background
 * structural pattern as the forwarded-email note (see reportTemplate.js's
 * `.ff-note` class), in the brand green instead of that box's tan/olive.
 * Uses fully inline styles rather than a shared CSS class: this gets
 * appended after the document's own <style> block already exists, and many
 * email clients strip <style> blocks anyway (same reasoning as the PDF's
 * inline-styled referral footer in api/report-pdf.js).
 *
 * Inserted INSIDE reportTemplate.js's `.ff-report` container (before its
 * closing </div>, not after it) so it inherits that container's left/right
 * padding and font-family — same alignment and font as the rest of the
 * report — rather than sitting flush against the page edge in a fallback
 * font, which is what appending after </div> would do.
 */
function addChatHint(reportHtml) {
  const hint = `
    <div style="margin-top:24px; padding:12px 16px; background:#f0faf6; border-left:3px solid #059669; border-radius:3px;">
      <p style="margin:0 0 4px; font-weight:700; color:#1a1a1a;">Talk to Coach</p>
      <p style="margin:0; color:#1a1a1a;">Want to talk to Coach about this report? Use the Reports tab in your account.</p>
    </div>`;
  return /<\/div>\s*<\/body>/i.test(reportHtml)
    ? reportHtml.replace(/<\/div>(\s*)<\/body>/i, (_match, trailingSpace) => `${hint}\n  </div>${trailingSpace}</body>`)
    : reportHtml.replace('</body>', `${hint}</body>`);
}

/**
 * Sent instead of a report when a trial subscriber has used up their
 * "1 free email + 2 revisions" allowance. Keep this warm, not a bare
 * paywall notice — it's still a touchpoint with someone who liked the
 * product enough to hit the limit.
 */
/**
 * Sent once, right after a v2 signup provisions a profile (see
 * db/migrations/0002_profiles_reviews.sql's handle_new_user trigger). Gives
 * the person the one thing they need to actually use the product: their
 * unique review address.
 */
export async function sendWelcomeEmail(env, { toEmail, reviewAddress }) {
  await postmarkSend(env, {
    From: `Stay Fully Funded Coach <${env.FROM_EMAIL}>`,
    To: toEmail,
    Subject: 'Your Email Coach is ready',
    HtmlBody: `
      <p>Hi there,</p>
      <p>Your Stay Fully Funded Email Coach is ready to go! Send any draft
      supporter email to this personal review email address below, and
      you'll get a full report back in a couple of minutes:</p>
      <p><strong>${reviewAddress}</strong></p>
      <p>Warmly,<br>The Stay Fully Funded Team</p>
    `,
    MessageStream: 'outbound',
  });
}

export async function sendTrialLimitEmail(env, { toEmail }) {
  await postmarkSend(env, {
    From: `Stay Fully Funded Coach <${env.FROM_EMAIL}>`,
    To: toEmail,
    Subject: "You've used your free Email Coach reviews",
    HtmlBody: `
      <p>Hi there,</p>
      <p>You've used up your free trial email reviews with our Stay Fully Funded
      Email Coach. We hope you saw your email drafts improve!</p>
      <p>Ready for unlimited reviews? <a href="https://stayfullyfunded.com/coach">
      Upgrade here</a> to keep sending your drafts to our Email Coach before
      every send.</p>
      <p>Warmly,<br>The Stay Fully Funded Team</p>
    `,
    MessageStream: 'outbound',
  });
}

// Subject/body pairs for the expiry reminder cron (see api/inbound.js's
// runExpiryReminderSweep and stripe-billing-build-spec.md Part 8). The
// subject strings match get_expiry_reminder_candidates()'s milestone values
// exactly, so a typo here fails loudly (undefined subject) rather than
// sending a blank one.
const EXPIRY_REMINDER_COPY = {
  '7_days_before': {
    subject: 'Your Stay Fully Funded access ends in 7 days',
    body: `<p>Your access to the Stay Fully Funded Email Coach ends in about a week.</p>
      <p>If you'd like to keep sending your drafts through before every send, you can
      pick a plan any time from your account.</p>`,
  },
  '3_days_before': {
    subject: 'Your Stay Fully Funded access ends in 3 days',
    body: `<p>Your access to the Stay Fully Funded Email Coach ends in a few days.</p>
      <p>If you'd like to keep it going, you can pick a plan any time from your account.</p>`,
  },
  day_of: {
    subject: 'Your Stay Fully Funded access ends today',
    body: `<p>Your access to the Stay Fully Funded Email Coach ends today.</p>
      <p>If you'd like to keep sending your drafts through before every send, you can
      pick a plan any time from your account.</p>`,
  },
  '1_week_after': {
    subject: "It's been a week. Your access has expired.",
    body: `<p>It's been about a week since your Stay Fully Funded access ended.</p>
      <p>Whenever you're ready to pick it back up, your account is right where you left it.</p>`,
  },
  '1_month_after': {
    subject: "It's been a month. Pick up where you left off.",
    body: `<p>It's been about a month since your Stay Fully Funded access ended.</p>
      <p>Whenever you're ready to pick it back up, your account is right where you left it.</p>`,
  },
};

/**
 * Sent by the daily expiry-reminder cron, never by anything the writer
 * triggers directly. Links to the Subscription tab, NOT a raw Stripe
 * Checkout link — the reader needs to be authenticated first, so the link
 * goes to a page that can then create the right session for whatever they
 * choose to do (subscribe, resubscribe, manage an existing plan).
 */
export async function sendExpiryReminderEmail(env, { toEmail, milestone }) {
  const copy = EXPIRY_REMINDER_COPY[milestone];
  if (!copy) throw new Error(`sendExpiryReminderEmail: unknown milestone "${milestone}"`);

  await postmarkSend(env, {
    From: `Stay Fully Funded Coach <${env.FROM_EMAIL}>`,
    To: toEmail,
    Subject: copy.subject,
    HtmlBody: `
      <p>Hi there,</p>
      ${copy.body}
      <p><a href="https://stayfullyfunded.com/profile?tab=subscription">View your account</a></p>
      <p>Warmly,<br>The Stay Fully Funded Team</p>
    `,
    MessageStream: 'outbound',
  });
}

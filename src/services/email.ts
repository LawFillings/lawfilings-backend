/**
 * Sends transactional email via Resend's HTTP API. Needs RESEND_API_KEY set in the environment;
 * FRONTEND_URL is the public address of the web app, used to build the reset link.
 *
 * Raw SMTP (the previous approach) doesn't work from Render: its outbound network can't complete
 * a connection to Gmail's SMTP servers on any port (confirmed with both 587 and 465, both timing
 * out identically) — an HTTP API sidesteps that entirely, since it just talks plain HTTPS.
 */
import { Resend } from 'resend';
import { getPasswordResetEmailCopy } from './emailTranslations.js';

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';
// A subdomain, not the root domain — its DNS records are independent of the root domain's
// existing Google Workspace records, so verifying it can't affect admin@lawfilings.in mail.
const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS ?? 'LawFilings <noreply@updates.lawfilings.in>';

function getClient() {
  return new Resend(process.env.RESEND_API_KEY);
}

/** Fails loudly to the caller; routes/auth.ts logs the failure without revealing it to the requester. */
export async function sendPasswordResetEmail(to: string, fullName: string, rawToken: string, language?: string) {
  const resetUrl = `${FRONTEND_URL}/?reset=${rawToken}`;
  const copy = getPasswordResetEmailCopy(language);
  const greeting = copy.greeting(fullName);
  const dirAttr = copy.rtl ? ' dir="rtl"' : '';
  const { error } = await getClient().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: copy.subject,
    text: `${greeting}\n\n${copy.intro}\n${resetUrl}\n\n${copy.expiryNote} ${copy.ignoreNote}`,
    html: `<div${dirAttr}><p>${greeting}</p><p>${copy.intro}</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>${copy.expiryNote} ${copy.ignoreNote}</p></div>`,
  });
  if (error) {
    throw new Error(`Resend error (${error.name}): ${error.message}`);
  }
}

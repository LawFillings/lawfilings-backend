/**
 * Sends transactional email via Resend's HTTP API. Needs RESEND_API_KEY set in the environment;
 * FRONTEND_URL is the public address of the web app, used to build the reset link.
 *
 * Raw SMTP (the previous approach) doesn't work from Render: its outbound network can't complete
 * a connection to Gmail's SMTP servers on any port (confirmed with both 587 and 465, both timing
 * out identically) — an HTTP API sidesteps that entirely, since it just talks plain HTTPS.
 */
import { Resend } from 'resend';

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';
// A subdomain, not the root domain — its DNS records are independent of the root domain's
// existing Google Workspace records, so verifying it can't affect admin@lawfilings.in mail.
const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS ?? 'LawFilings <noreply@updates.lawfilings.in>';

function getClient() {
  return new Resend(process.env.RESEND_API_KEY);
}

/** Fails loudly to the caller; routes/auth.ts logs the failure without revealing it to the requester. */
export async function sendPasswordResetEmail(to: string, fullName: string, rawToken: string) {
  const resetUrl = `${FRONTEND_URL}/?reset=${rawToken}`;
  const { error } = await getClient().emails.send({
    from: FROM_ADDRESS,
    to,
    subject: 'Reset your LawFilings password',
    text: `Hi ${fullName},\n\nWe received a request to reset your LawFilings password. Set a new one here:\n${resetUrl}\n\nThis link expires in 1 hour and can be used once. If you didn't ask for this, you can ignore this email — your password won't change.`,
    html: `<p>Hi ${fullName},</p><p>We received a request to reset your LawFilings password. Set a new one here:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 1 hour and can be used once. If you didn't ask for this, you can ignore this email — your password won't change.</p>`,
  });
  if (error) {
    throw new Error(`Resend error (${error.name}): ${error.message}`);
  }
}

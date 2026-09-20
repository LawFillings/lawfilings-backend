/**
 * Sends transactional email via SMTP through the platform's own Google Workspace account,
 * rather than a dedicated third-party transactional-email provider. Needs SMTP_USER and
 * SMTP_APP_PASSWORD (a Google app password) set in the environment; FRONTEND_URL is the public
 * address of the web app, used to build the reset link.
 */
import nodemailer from 'nodemailer';

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

function getTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT ?? 465),
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_APP_PASSWORD,
    },
  });
}

/** Fails loudly to the caller; routes/auth.ts logs the failure without revealing it to the requester. */
export async function sendPasswordResetEmail(to: string, fullName: string, rawToken: string) {
  const resetUrl = `${FRONTEND_URL}/?reset=${rawToken}`;
  await getTransport().sendMail({
    from: `LawFilings <${process.env.SMTP_USER}>`,
    to,
    subject: 'Reset your LawFilings password',
    text: `Hi ${fullName},\n\nWe received a request to reset your LawFilings password. Set a new one here:\n${resetUrl}\n\nThis link expires in 1 hour and can be used once. If you didn't ask for this, you can ignore this email — your password won't change.`,
    html: `<p>Hi ${fullName},</p><p>We received a request to reset your LawFilings password. Set a new one here:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 1 hour and can be used once. If you didn't ask for this, you can ignore this email — your password won't change.</p>`,
  });
}

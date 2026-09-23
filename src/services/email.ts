/**
 * Sends transactional email via SMTP through the platform's own Google Workspace account,
 * rather than a dedicated third-party transactional-email provider. Needs SMTP_USER and
 * SMTP_APP_PASSWORD (a Google app password) set in the environment; FRONTEND_URL is the public
 * address of the web app, used to build the reset link.
 */
import dns from 'node:dns';
import net from 'node:net';
import nodemailer from 'nodemailer';

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

/**
 * Nodemailer resolves its own SMTP host, and before it even attempts an IPv4 lookup it checks
 * whether the container's own network interfaces report an IPv4 address (see nodemailer's
 * shared/index.js `isFamilySupported`) — on Render's containers that check comes back false, so
 * it skips straight to AAAA and connects over IPv6, which Render's outbound network can't route
 * (ENETUNREACH). dns.setDefaultResultOrder('ipv4first') doesn't help: nodemailer calls
 * dns.resolve4/resolve6 directly, which that setting doesn't affect. Resolving the A record
 * ourselves and connecting to that literal IP (with servername set for correct TLS/SNI) sidesteps
 * nodemailer's family check entirely, since a literal IP host skips its resolution step.
 */
async function resolveIPv4(host: string): Promise<string> {
  if (net.isIP(host)) return host;
  const addresses = await dns.promises.resolve4(host);
  if (!addresses[0]) throw new Error(`No IPv4 address found for ${host}`);
  return addresses[0];
}

async function getTransport() {
  const host = process.env.SMTP_HOST ?? 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT ?? 587);
  const ipv4Host = await resolveIPv4(host);
  return nodemailer.createTransport({
    host: ipv4Host,
    servername: host,
    port,
    // Port 465 is implicit TLS; port 587 (the default here) uses STARTTLS instead.
    // Some hosts block outbound 465, so 587 is the more portable default.
    secure: port === 465,
    requireTLS: port !== 465,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_APP_PASSWORD,
    },
  });
}

/** Fails loudly to the caller; routes/auth.ts logs the failure without revealing it to the requester. */
export async function sendPasswordResetEmail(to: string, fullName: string, rawToken: string) {
  const resetUrl = `${FRONTEND_URL}/?reset=${rawToken}`;
  const transport = await getTransport();
  await transport.sendMail({
    from: `LawFilings <${process.env.SMTP_USER}>`,
    to,
    subject: 'Reset your LawFilings password',
    text: `Hi ${fullName},\n\nWe received a request to reset your LawFilings password. Set a new one here:\n${resetUrl}\n\nThis link expires in 1 hour and can be used once. If you didn't ask for this, you can ignore this email — your password won't change.`,
    html: `<p>Hi ${fullName},</p><p>We received a request to reset your LawFilings password. Set a new one here:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 1 hour and can be used once. If you didn't ask for this, you can ignore this email — your password won't change.</p>`,
  });
}

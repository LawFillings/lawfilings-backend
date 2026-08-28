import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { AuthedRequest } from './auth.js';

/** Applied to every request as a baseline — generous, just stops a runaway script or basic DoS
 *  probing from ever reaching the database/Anthropic calls below. */
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

/** Signup/login only — credential stuffing and spam-account creation both look like a burst of
 *  requests from one IP, so this is IP-keyed (there's no user session yet to key on). */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — please wait a few minutes and try again.' },
});

/** AI copilot endpoints — each call is a real Anthropic API request, so this is keyed per
 *  authenticated user (not IP) to give every account its own budget rather than letting one
 *  script exhaust a shared IP-wide allowance while a real user next to it gets throttled too.
 *  Must run after requireAuth so req.userId is already set. */
export const copilotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  // ipKeyGenerator normalizes IPv6 addresses (collapses to a /64) so this can't be trivially
  // bypassed by rotating the low bits of an IPv6 address the way a raw req.ip comparison could.
  keyGenerator: (req) => (req as AuthedRequest).userId ?? ipKeyGenerator(req.ip ?? 'unknown'),
  message: { error: 'Drafting-assist rate limit reached for this account — please try again in a while.' },
});

/** Law Library "Ask a question" — unlike the copilot endpoints above, this is deliberately
 *  reachable with no account (the Library is "free, no account needed"), so there's no userId to
 *  key on and this has to be IP-based only. Each call is still a real, billed Anthropic request,
 *  so it gets its own budget rather than sharing the generous general-purpose globalLimiter. */
export const lawLibraryAiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
  message: { error: 'Too many questions from this connection in the last hour — please try again later.' },
});

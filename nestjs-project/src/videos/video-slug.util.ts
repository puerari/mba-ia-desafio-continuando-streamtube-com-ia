import { randomBytes } from 'node:crypto';

/**
 * 64 URL-safe symbols. The size matters: 256 is an exact multiple of 64, so
 * masking a random byte with `& 63` samples the alphabet uniformly — no modulo
 * bias and no rejection loop.
 */
export const VIDEO_SLUG_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

export const VIDEO_SLUG_LENGTH = 11;

/**
 * Bounded retry budget for the unique-constraint collision on `videos.slug`.
 * The database index is the authoritative guarantee of uniqueness; this is
 * only how many times we are willing to redraw before giving up.
 */
export const MAX_SLUG_ATTEMPTS = 5;

/** Generates an 11-character URL-safe public identifier for a video. */
export function generateVideoSlug(): string {
  const bytes = randomBytes(VIDEO_SLUG_LENGTH);
  let slug = '';

  for (let i = 0; i < VIDEO_SLUG_LENGTH; i++) {
    slug += VIDEO_SLUG_ALPHABET[bytes[i] & 63];
  }

  return slug;
}

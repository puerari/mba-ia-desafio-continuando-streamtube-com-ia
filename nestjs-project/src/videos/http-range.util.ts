import { RangeNotSatisfiableException } from './exceptions/video.exceptions';

export interface ByteRange {
  start: number;
  end: number;
}

const SINGLE_BYTE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * Parses a single-range `Range` header against a known object size.
 *
 * Returns `null` when the whole object should be served — either no header was
 * sent, or the header is one RFC 9110 allows a server to ignore (a syntax it
 * does not understand, or a multi-range request this endpoint does not serve).
 * Throws `RangeNotSatisfiableException` only for a syntactically valid range
 * that falls outside the object, which is the one case that must answer 416.
 */
export function parseRangeHeader(
  header: string | undefined,
  totalLength: number,
): ByteRange | null {
  if (!header) return null;

  const match = SINGLE_BYTE_RANGE.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;

  // "bytes=-500" — the last 500 bytes.
  if (rawStart === '') {
    if (rawEnd === '') return null;
    const suffixLength = Number(rawEnd);
    if (suffixLength === 0) {
      throw new RangeNotSatisfiableException(totalLength);
    }
    const start = Math.max(0, totalLength - suffixLength);
    return { start, end: totalLength - 1 };
  }

  const start = Number(rawStart);
  if (start >= totalLength) {
    throw new RangeNotSatisfiableException(totalLength);
  }

  // "bytes=500-" — from 500 to the end.
  const end = rawEnd === '' ? totalLength - 1 : Number(rawEnd);
  if (end < start) {
    throw new RangeNotSatisfiableException(totalLength);
  }

  return { start, end: Math.min(end, totalLength - 1) };
}

export function formatContentRange(
  range: ByteRange,
  totalLength: number,
): string {
  return `bytes ${range.start}-${range.end}/${totalLength}`;
}

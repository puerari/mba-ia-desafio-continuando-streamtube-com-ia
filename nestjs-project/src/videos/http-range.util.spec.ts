import { RangeNotSatisfiableException } from './exceptions/video.exceptions';
import { formatContentRange, parseRangeHeader } from './http-range.util';

const TOTAL = 1000;

describe('parseRangeHeader', () => {
  it('returns null when no Range header is sent', () => {
    expect(parseRangeHeader(undefined, TOTAL)).toBeNull();
  });

  it('parses a closed range', () => {
    expect(parseRangeHeader('bytes=0-99', TOTAL)).toEqual({
      start: 0,
      end: 99,
    });
  });

  it('parses an open-ended range to the last byte', () => {
    expect(parseRangeHeader('bytes=500-', TOTAL)).toEqual({
      start: 500,
      end: 999,
    });
  });

  it('parses a suffix range as the last N bytes', () => {
    expect(parseRangeHeader('bytes=-100', TOTAL)).toEqual({
      start: 900,
      end: 999,
    });
  });

  it('clamps a suffix longer than the object to the whole object', () => {
    expect(parseRangeHeader('bytes=-5000', TOTAL)).toEqual({
      start: 0,
      end: 999,
    });
  });

  it('clamps an end beyond the object to the last byte', () => {
    expect(parseRangeHeader('bytes=900-99999', TOTAL)).toEqual({
      start: 900,
      end: 999,
    });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseRangeHeader('  bytes=0-9  ', TOTAL)).toEqual({
      start: 0,
      end: 9,
    });
  });

  it('serves the whole object for a syntax it does not understand', () => {
    // RFC 9110 allows a server to ignore a Range it cannot parse.
    expect(parseRangeHeader('items=0-10', TOTAL)).toBeNull();
    expect(parseRangeHeader('bytes=abc-def', TOTAL)).toBeNull();
    expect(parseRangeHeader('bytes=', TOTAL)).toBeNull();
    expect(parseRangeHeader('bytes=-', TOTAL)).toBeNull();
  });

  it('serves the whole object for a multi-range request', () => {
    // This endpoint does not produce multipart/byteranges.
    expect(parseRangeHeader('bytes=0-10,20-30', TOTAL)).toBeNull();
  });

  it('throws when the start is at or beyond the object size', () => {
    expect(() => parseRangeHeader('bytes=1000-', TOTAL)).toThrow(
      RangeNotSatisfiableException,
    );
    expect(() => parseRangeHeader('bytes=5000-6000', TOTAL)).toThrow(
      RangeNotSatisfiableException,
    );
  });

  it('throws when the end precedes the start', () => {
    expect(() => parseRangeHeader('bytes=500-100', TOTAL)).toThrow(
      RangeNotSatisfiableException,
    );
  });

  it('throws for a zero-length suffix range', () => {
    expect(() => parseRangeHeader('bytes=-0', TOTAL)).toThrow(
      RangeNotSatisfiableException,
    );
  });

  it('carries the object size on the exception so a 416 can report it', () => {
    try {
      parseRangeHeader('bytes=2000-', TOTAL);
      fail('expected a RangeNotSatisfiableException');
    } catch (error) {
      expect(error).toBeInstanceOf(RangeNotSatisfiableException);
      expect((error as RangeNotSatisfiableException).totalLength).toBe(TOTAL);
    }
  });

  it('handles a single-byte object', () => {
    expect(parseRangeHeader('bytes=0-0', 1)).toEqual({ start: 0, end: 0 });
    expect(() => parseRangeHeader('bytes=1-', 1)).toThrow(
      RangeNotSatisfiableException,
    );
  });
});

describe('formatContentRange', () => {
  it('renders the RFC 9110 form', () => {
    expect(formatContentRange({ start: 0, end: 99 }, TOTAL)).toBe(
      'bytes 0-99/1000',
    );
  });
});

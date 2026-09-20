import {
  generateVideoSlug,
  VIDEO_SLUG_ALPHABET,
  VIDEO_SLUG_LENGTH,
} from './video-slug.util';

describe('generateVideoSlug', () => {
  it('produces a slug of exactly the declared length', () => {
    expect(generateVideoSlug()).toHaveLength(VIDEO_SLUG_LENGTH);
  });

  it('uses only characters from the declared URL-safe alphabet', () => {
    const allowed = new Set(VIDEO_SLUG_ALPHABET);

    for (let i = 0; i < 500; i++) {
      for (const char of generateVideoSlug()) {
        expect(allowed.has(char)).toBe(true);
      }
    }
  });

  it('produces no duplicates across 10,000 draws', () => {
    const slugs = new Set<string>();

    for (let i = 0; i < 10_000; i++) {
      slugs.add(generateVideoSlug());
    }

    expect(slugs.size).toBe(10_000);
  });

  it('samples the whole alphabet rather than collapsing into a subrange', () => {
    // Guards against a masking bug (e.g. `& 15`) that would still produce
    // valid-looking slugs while silently destroying the entropy.
    const seen = new Set<string>();

    for (let i = 0; i < 2_000; i++) {
      for (const char of generateVideoSlug()) {
        seen.add(char);
      }
    }

    expect(seen.size).toBe(VIDEO_SLUG_ALPHABET.length);
  });

  it('exposes an alphabet whose size divides 256 evenly', () => {
    // The uniformity of `byte & 63` depends on this.
    expect(256 % VIDEO_SLUG_ALPHABET.length).toBe(0);
    expect(new Set(VIDEO_SLUG_ALPHABET).size).toBe(VIDEO_SLUG_ALPHABET.length);
  });
});

/**
 * Object key layout for the videos domain (per phase-03-videos/TD-03).
 *
 * A single bucket holds both prefixes; splitting them into separate buckets
 * later is a configuration change, not a redesign.
 */
export const VIDEO_SOURCE_PREFIX = 'videos';
export const VIDEO_THUMBNAIL_PREFIX = 'thumbnails';

export function videoSourceKey(videoId: string, extension: string): string {
  return `${VIDEO_SOURCE_PREFIX}/${videoId}/source${extension}`;
}

export function videoThumbnailKey(videoId: string): string {
  return `${VIDEO_THUMBNAIL_PREFIX}/${videoId}/default.jpg`;
}

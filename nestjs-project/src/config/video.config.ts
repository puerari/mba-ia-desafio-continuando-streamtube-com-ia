import { registerAs } from '@nestjs/config';

export default registerAs('video', () => ({
  // 10GiB — the ceiling from the project plan.
  maxSizeBytes: parseInt(process.env.VIDEO_MAX_SIZE_BYTES || '10737418240', 10),
  // 64MiB per part: 160 parts for a 10GiB upload, well under S3's 10,000-part
  // cap and above its 5MiB minimum part size.
  uploadPartSizeBytes: parseInt(
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES || '67108864',
    10,
  ),
  uploadUrlTtlSeconds: parseInt(
    process.env.VIDEO_UPLOAD_URL_TTL_SECONDS || '3600',
    10,
  ),
  // Seek 10% into the video so the frame is not a black lead-in.
  thumbnailPositionRatio: parseFloat(
    process.env.VIDEO_THUMBNAIL_POSITION_RATIO || '0.1',
  ),
  thumbnailWidth: parseInt(process.env.VIDEO_THUMBNAIL_WIDTH || '1280', 10),
}));

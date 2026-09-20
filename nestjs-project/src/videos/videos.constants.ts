export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const VIDEO_PROCESSING_JOB = 'process-video';

/**
 * Container formats accepted at upload time. The list is deliberately short —
 * every entry here has to be something ffprobe/ffmpeg in the worker image can
 * actually read.
 */
export const ALLOWED_VIDEO_CONTENT_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
] as const;

/** Extension used for the stored source object, per declared content type. */
export const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
};

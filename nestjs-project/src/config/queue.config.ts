import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  attempts: parseInt(process.env.VIDEO_QUEUE_ATTEMPTS || '3', 10),
  backoffDelayMs: parseInt(process.env.VIDEO_QUEUE_BACKOFF_MS || '5000', 10),
  // A multi-gigabyte download plus probe plus thumbnail can take minutes; a
  // lock shorter than the job makes BullMQ redeliver work that is still running.
  lockDurationMs: parseInt(
    process.env.VIDEO_QUEUE_LOCK_DURATION_MS || '600000',
    10,
  ),
  concurrency: parseInt(process.env.VIDEO_QUEUE_CONCURRENCY || '1', 10),
}));

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Job } from 'bullmq';
import queueConfig from '../../config/queue.config';
import videoConfig from '../../config/video.config';
import { FfmpegService } from '../../media/ffmpeg.service';
import { StorageService } from '../../storage/storage.service';
import { VideoStatus } from '../entities/video.entity';
import { videoThumbnailKey } from '../video-storage-keys';
import { VIDEO_PROCESSING_QUEUE } from '../videos.constants';
import { VideosService } from '../videos.service';
import type { VideoProcessingJobData } from './video-processing.types';

/**
 * Worker options are read at class-definition time, so they cannot be
 * injected. The `registerAs` factory is used as a plain function instead —
 * the same dual-purpose pattern `data-source.ts` uses for the TypeORM CLI
 * (phase-01-configuracao-base/TD-04).
 *
 * This is why `worker.main.ts` imports `dotenv/config` before anything else:
 * without it `.env` would not be loaded yet when this line runs, and the
 * factory would silently fall back to its defaults.
 */
const workerOptions = queueConfig();

/**
 * Consumes the processing queue in the video-worker container.
 *
 * Concurrency and lock duration are the two knobs that matter here: the work
 * is CPU- and IO-bound, and a lock shorter than an FFmpeg run makes BullMQ
 * redeliver a job that is still running.
 */
@Injectable()
@Processor(VIDEO_PROCESSING_QUEUE, {
  concurrency: workerOptions.concurrency,
  lockDuration: workerOptions.lockDurationMs,
})
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
    @Inject(queueConfig.KEY)
    private readonly queue: ConfigType<typeof queueConfig>,
  ) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videosService.findByIdOrFail(videoId);

    // BullMQ delivers at-least-once: a redelivery of an already-processed
    // video is a no-op rather than a second FFmpeg run.
    if (video.status === VideoStatus.READY) {
      this.logger.log(`Video ${videoId} is already ready — skipping`);
      return;
    }

    const workDir = await mkdtemp(join(tmpdir(), 'video-'));
    const sourcePath = join(workDir, 'source');
    const thumbnailPath = join(workDir, 'thumbnail.jpg');

    try {
      this.logger.log(`Processing video ${videoId}`);
      await this.storageService.downloadToFile(video.storage_key, sourcePath);

      const metadata = await this.ffmpegService.probe(sourcePath);

      await this.ffmpegService.extractThumbnail(
        sourcePath,
        thumbnailPath,
        metadata.durationSeconds * this.config.thumbnailPositionRatio,
        this.config.thumbnailWidth,
      );

      const thumbnailKey = videoThumbnailKey(videoId);
      await this.storageService.putObject(
        thumbnailKey,
        await readFile(thumbnailPath),
        'image/jpeg',
      );

      await this.videosService.markReady(videoId, metadata, thumbnailKey);
      this.logger.log(
        `Video ${videoId} is ready (${metadata.width}x${metadata.height}, ${metadata.durationSeconds}s)`,
      );
    } finally {
      // Always — a multi-gigabyte source left behind would fill the worker's
      // disk within a handful of failures.
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * Fires on EVERY failed attempt, not just the last one. Writing the terminal
   * state here without the guard would make the status column claim a video
   * failed while BullMQ is still retrying it.
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessingJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? this.queue.attempts;
    if (job.attemptsMade < maxAttempts) {
      this.logger.warn(
        `Video ${job.data.videoId} attempt ${job.attemptsMade}/${maxAttempts} failed: ${error.message}`,
      );
      return;
    }

    this.logger.error(
      `Video ${job.data.videoId} failed permanently: ${error.message}`,
    );
    await this.videosService.markFailed(job.data.videoId, error.message);
  }
}

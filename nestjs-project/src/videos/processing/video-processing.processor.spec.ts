import { readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Job } from 'bullmq';
import { Video, VideoStatus } from '../entities/video.entity';
import { VideoProcessingProcessor } from './video-processing.processor';
import type { VideoProcessingJobData } from './video-processing.types';

const videoConfig = {
  maxSizeBytes: 10 * 1024 * 1024 * 1024,
  uploadPartSizeBytes: 64 * 1024 * 1024,
  uploadUrlTtlSeconds: 3600,
  thumbnailPositionRatio: 0.1,
  thumbnailWidth: 1280,
};

const queueConfig = {
  host: 'redis',
  port: 6379,
  attempts: 3,
  backoffDelayMs: 5000,
  lockDurationMs: 600000,
  concurrency: 1,
};

const metadata = {
  durationSeconds: 20,
  width: 1920,
  height: 1080,
  videoCodec: 'h264',
  bitrate: 900_000,
};

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-id',
    storage_key: 'videos/video-id/source.mp4',
    status: VideoStatus.PROCESSING,
    ...overrides,
  } as Video;
}

function makeJob(
  overrides: Partial<Job<VideoProcessingJobData>> = {},
): Job<VideoProcessingJobData> {
  return {
    data: { videoId: 'video-id' },
    attemptsMade: 1,
    opts: { attempts: 3 },
    ...overrides,
  } as Job<VideoProcessingJobData>;
}

function build(
  overrides: {
    videos?: any;
    storage?: any;
    ffmpeg?: any;
  } = {},
) {
  const videos = overrides.videos ?? {
    findByIdOrFail: jest.fn().mockResolvedValue(makeVideo()),
    markReady: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };
  const storage = overrides.storage ?? {
    downloadToFile: jest.fn().mockResolvedValue(undefined),
    putObject: jest.fn().mockResolvedValue(undefined),
  };
  const ffmpeg = overrides.ffmpeg ?? {
    probe: jest.fn().mockResolvedValue(metadata),
    extractThumbnail: jest.fn().mockResolvedValue(undefined),
  };

  const processor = new VideoProcessingProcessor(
    videos,
    storage,
    ffmpeg,
    videoConfig,
    queueConfig,
  );

  return { processor, videos, storage, ffmpeg };
}

/** Temp dirs the processor creates are named `video-*` under the OS tmpdir. */
async function countWorkDirs(): Promise<number> {
  const entries = await readdir(tmpdir());
  return entries.filter((entry) => entry.startsWith('video-')).length;
}

describe('VideoProcessingProcessor', () => {
  describe('process', () => {
    it('downloads, probes, thumbnails and marks the video ready in order', async () => {
      const { processor, videos, storage, ffmpeg } = build();
      const order: string[] = [];

      storage.downloadToFile.mockImplementation(async () => {
        order.push('download');
      });
      ffmpeg.probe.mockImplementation(async () => {
        order.push('probe');
        return metadata;
      });
      ffmpeg.extractThumbnail.mockImplementation(async () => {
        order.push('thumbnail');
      });
      storage.putObject.mockImplementation(async () => {
        order.push('put');
      });
      videos.markReady.mockImplementation(async () => {
        order.push('ready');
      });

      // The thumbnail file must exist for readFile to succeed, so let the
      // real extractThumbnail stand in by writing it.
      ffmpeg.extractThumbnail.mockImplementation(async (
        _src: string,
        out: string,
      ) => {
        order.push('thumbnail');
        
        await writeFile(out, Buffer.from('jpeg-bytes'));
      });

      await processor.process(makeJob());

      expect(order).toEqual([
        'download',
        'probe',
        'thumbnail',
        'put',
        'ready',
      ]);
    });

    it('seeks the thumbnail to the configured fraction of the duration', async () => {
      const { processor, ffmpeg } = build();
      ffmpeg.extractThumbnail.mockImplementation(async (
        _src: string,
        out: string,
      ) => {
        
        await writeFile(out, Buffer.from('jpeg'));
      });

      await processor.process(makeJob());

      expect(ffmpeg.extractThumbnail).toHaveBeenCalledWith(
        expect.stringContaining('source'),
        expect.stringContaining('thumbnail.jpg'),
        20 * 0.1,
        1280,
      );
    });

    it('stores the thumbnail under the video thumbnail key', async () => {
      const { processor, storage, ffmpeg, videos } = build();
      ffmpeg.extractThumbnail.mockImplementation(async (
        _src: string,
        out: string,
      ) => {
        
        await writeFile(out, Buffer.from('jpeg'));
      });

      await processor.process(makeJob());

      expect(storage.putObject).toHaveBeenCalledWith(
        'thumbnails/video-id/default.jpg',
        expect.any(Buffer),
        'image/jpeg',
      );
      expect(videos.markReady).toHaveBeenCalledWith(
        'video-id',
        metadata,
        'thumbnails/video-id/default.jpg',
      );
    });

    it('short-circuits a redelivered job for an already-ready video', async () => {
      const { processor, storage, ffmpeg, videos } = build({
        videos: {
          findByIdOrFail: jest
            .fn()
            .mockResolvedValue(makeVideo({ status: VideoStatus.READY })),
          markReady: jest.fn(),
          markFailed: jest.fn(),
        },
      });

      await processor.process(makeJob());

      expect(storage.downloadToFile).not.toHaveBeenCalled();
      expect(ffmpeg.probe).not.toHaveBeenCalled();
      expect(videos.markReady).not.toHaveBeenCalled();
    });

    it('propagates a probe failure so BullMQ can retry', async () => {
      const { processor } = build({
        storage: {
          downloadToFile: jest.fn().mockResolvedValue(undefined),
          putObject: jest.fn(),
        },
        ffmpeg: {
          probe: jest.fn().mockRejectedValue(new Error('not a video')),
          extractThumbnail: jest.fn(),
        },
      });

      await expect(processor.process(makeJob())).rejects.toThrow(
        'not a video',
      );
    });

    it('removes its work directory even when processing throws', async () => {
      const before = await countWorkDirs();
      const { processor } = build({
        storage: {
          downloadToFile: jest
            .fn()
            .mockRejectedValue(new Error('download failed')),
          putObject: jest.fn(),
        },
      });

      await expect(processor.process(makeJob())).rejects.toThrow(
        'download failed',
      );

      expect(await countWorkDirs()).toBe(before);
    });

    it('removes its work directory on the success path', async () => {
      const before = await countWorkDirs();
      const { processor, ffmpeg } = build();
      ffmpeg.extractThumbnail.mockImplementation(async (
        _src: string,
        out: string,
      ) => {
        
        await writeFile(out, Buffer.from('jpeg'));
      });

      await processor.process(makeJob());

      expect(await countWorkDirs()).toBe(before);
    });
  });

  describe('onFailed', () => {
    it('stays quiet while retries remain', async () => {
      const { processor, videos } = build();

      await processor.onFailed(
        makeJob({ attemptsMade: 1, opts: { attempts: 3 } as any }),
        new Error('transient'),
      );

      expect(videos.markFailed).not.toHaveBeenCalled();
    });

    it('stays quiet on the penultimate attempt', async () => {
      const { processor, videos } = build();

      await processor.onFailed(
        makeJob({ attemptsMade: 2, opts: { attempts: 3 } as any }),
        new Error('transient'),
      );

      expect(videos.markFailed).not.toHaveBeenCalled();
    });

    it('writes the terminal failure once the budget is exhausted', async () => {
      const { processor, videos } = build();

      await processor.onFailed(
        makeJob({ attemptsMade: 3, opts: { attempts: 3 } as any }),
        new Error('ffprobe exploded'),
      );

      expect(videos.markFailed).toHaveBeenCalledWith(
        'video-id',
        'ffprobe exploded',
      );
    });

    it('falls back to the configured attempt count when the job carries none', async () => {
      const { processor, videos } = build();

      await processor.onFailed(
        makeJob({ attemptsMade: 3, opts: {} as any }),
        new Error('boom'),
      );

      expect(videos.markFailed).toHaveBeenCalledWith('video-id', 'boom');
    });

    it('ignores a failure event with no job attached', async () => {
      const { processor, videos } = build();

      await processor.onFailed(undefined, new Error('orphan'));

      expect(videos.markFailed).not.toHaveBeenCalled();
    });
  });
});

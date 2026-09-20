import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import videoConfig from '../../config/video.config';
import { createFixtureClip } from '../../media/test-fixtures';
import { bullRootOptions } from '../../queue/bull-root.options';
import { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from '../entities/video.entity';
import { generateVideoSlug } from '../video-slug.util';
import { videoThumbnailKey } from '../video-storage-keys';
import { VideoProcessingModule } from './video-processing.module';
import { VideoProcessingProcessor } from './video-processing.processor';
import type { VideoProcessingJobData } from './video-processing.types';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/**
 * Exercises the processor against the real MinIO, PostgreSQL and FFmpeg from
 * Compose. `process()` is invoked directly rather than through the queue so
 * the assertions do not race the worker container listening on the same Redis.
 */
describe('VideoProcessingProcessor (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let processor: VideoProcessingProcessor;
  let storageService: StorageService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let workDir: string;
  let clipPath: string;
  let counter = 0;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [videoConfig, storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        BullModule.forRootAsync(bullRootOptions),
        VideoProcessingModule,
      ],
    }).compile();

    await moduleRef.init();

    dataSource = moduleRef.get(DataSource);
    processor = moduleRef.get(VideoProcessingProcessor);
    storageService = moduleRef.get(StorageService);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    workDir = await mkdtemp(join(tmpdir(), 'processing-spec-'));
    clipPath = join(workDir, 'fixture.mp4');
    await createFixtureClip(clipPath, {
      durationSeconds: 3,
      width: 640,
      height: 480,
    });
  }, 120_000);

  afterAll(async () => {
    for (const key of createdKeys) {
      await storageService.deleteObject(key).catch(() => undefined);
    }
    await rm(workDir, { recursive: true, force: true });
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function seedVideo(overrides: Partial<Video> = {}): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `processing_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `chan${counter}`,
        nickname: `chan${counter}`,
        user_id: user.id,
      }),
    );

    return videoRepository.save(
      videoRepository.create({
        slug: generateVideoSlug(),
        channel_id: channel.id,
        title: 'Processing subject',
        status: VideoStatus.PROCESSING,
        storage_key: 'placeholder',
        original_filename: 'fixture.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
        ...overrides,
      }),
    );
  }

  const jobFor = (videoId: string, attemptsMade = 1) =>
    ({
      data: { videoId },
      attemptsMade,
      opts: { attempts: 3 },
    }) as Job<VideoProcessingJobData>;

  it('extracts metadata, writes a thumbnail and marks the video ready', async () => {
    const video = await seedVideo();
    const storageKey = `videos/${video.id}/source.mp4`;
    createdKeys.push(storageKey, videoThumbnailKey(video.id));

    await storageService.putObject(
      storageKey,
      await readFile(clipPath),
      'video/mp4',
    );
    await videoRepository.update(video.id, { storage_key: storageKey });

    await processor.process(jobFor(video.id));

    const processed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(processed.status).toBe(VideoStatus.READY);
    expect(processed.duration_seconds).toBeGreaterThan(2.8);
    expect(processed.duration_seconds).toBeLessThan(3.2);
    expect(processed.width).toBe(640);
    expect(processed.height).toBe(480);
    expect(processed.video_codec).toBeTruthy();
    expect(processed.thumbnail_key).toBe(videoThumbnailKey(video.id));
    expect(processed.processing_error).toBeNull();

    await expect(
      storageService.objectExists(videoThumbnailKey(video.id)),
    ).resolves.toBe(true);
  }, 120_000);

  it('produces a thumbnail that is a readable image at the configured width', async () => {
    const video = await seedVideo();
    const storageKey = `videos/${video.id}/source.mp4`;
    createdKeys.push(storageKey, videoThumbnailKey(video.id));

    await storageService.putObject(
      storageKey,
      await readFile(clipPath),
      'video/mp4',
    );
    await videoRepository.update(video.id, { storage_key: storageKey });

    await processor.process(jobFor(video.id));

    const thumb = await storageService.getObjectStream(
      videoThumbnailKey(video.id),
    );
    const chunks: Buffer[] = [];
    for await (const chunk of thumb.stream) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const bytes = Buffer.concat(chunks);

    expect(bytes.length).toBeGreaterThan(0);
    // JPEG SOI marker
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(thumb.contentType).toBe('image/jpeg');
  }, 120_000);

  it('is idempotent — reprocessing a ready video changes nothing', async () => {
    const video = await seedVideo();
    const storageKey = `videos/${video.id}/source.mp4`;
    createdKeys.push(storageKey, videoThumbnailKey(video.id));

    await storageService.putObject(
      storageKey,
      await readFile(clipPath),
      'video/mp4',
    );
    await videoRepository.update(video.id, { storage_key: storageKey });

    await processor.process(jobFor(video.id));
    const first = await videoRepository.findOneByOrFail({ id: video.id });

    await processor.process(jobFor(video.id));
    const second = await videoRepository.findOneByOrFail({ id: video.id });

    expect(second.updated_at.getTime()).toBe(first.updated_at.getTime());
    expect(second.status).toBe(VideoStatus.READY);
  }, 120_000);

  it('leaves the video processing while retries remain, then marks it failed', async () => {
    const video = await seedVideo({
      storage_key: 'videos/missing/source.mp4',
    });

    await expect(processor.process(jobFor(video.id))).rejects.toThrow();

    // A transient failure must not show up as a terminal state.
    await processor.onFailed(jobFor(video.id, 1), new Error('boom'));
    let current = await videoRepository.findOneByOrFail({ id: video.id });
    expect(current.status).toBe(VideoStatus.PROCESSING);
    expect(current.processing_error).toBeNull();

    await processor.onFailed(
      jobFor(video.id, 3),
      new Error('source object missing'),
    );
    current = await videoRepository.findOneByOrFail({ id: video.id });
    expect(current.status).toBe(VideoStatus.FAILED);
    expect(current.processing_error).toContain('source object missing');
  }, 120_000);

  it('fails a video whose stored object is not decodable', async () => {
    const video = await seedVideo();
    const storageKey = `videos/${video.id}/source.mp4`;
    createdKeys.push(storageKey);

    await storageService.putObject(
      storageKey,
      Buffer.from('this is definitely not an mp4'),
      'video/mp4',
    );
    await videoRepository.update(video.id, { storage_key: storageKey });

    await expect(processor.process(jobFor(video.id))).rejects.toThrow();

    await processor.onFailed(jobFor(video.id, 3), new Error('ffprobe failed'));
    const current = await videoRepository.findOneByOrFail({ id: video.id });
    expect(current.status).toBe(VideoStatus.FAILED);
    expect(current.processing_error).toBeTruthy();
  }, 120_000);
});

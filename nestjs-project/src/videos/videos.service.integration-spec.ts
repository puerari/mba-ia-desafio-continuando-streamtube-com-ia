import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { bullRootOptions } from '../queue/bull-root.options';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import {
  ChannelNotFoundException,
  InvalidVideoStateException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoTooLargeException,
} from './exceptions/video.exceptions';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/**
 * Runs against the real PostgreSQL and MinIO containers: the presigned URLs
 * produced here are uploaded to for real, which is the only way to prove the
 * handshake actually works end to end.
 */
describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let videosService: VideosService;
  let storageService: StorageService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let counter = 0;
  const createdKeys: string[] = [];
  const originalPartSize = process.env.VIDEO_UPLOAD_PART_SIZE_BYTES;

  beforeAll(async () => {
    // 5MiB is S3's floor for a non-final part. Using it here keeps a genuine
    // multi-part upload down to ~5MiB of traffic instead of the 64MiB the
    // production default would force.
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES = String(5 * 1024 * 1024);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [videoConfig, storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        BullModule.forRootAsync(bullRootOptions),
        VideosModule,
      ],
    }).compile();

    await moduleRef.init();

    dataSource = moduleRef.get(DataSource);
    videosService = moduleRef.get(VideosService);
    storageService = moduleRef.get(StorageService);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    // The video-worker container shares this Redis. Pausing keeps it from
    // consuming the jobs this suite enqueues, which would otherwise race every
    // assertion about the queue's contents.
    await queue.pause();
  }, 60_000);

  afterAll(async () => {
    for (const key of createdKeys) {
      await storageService.deleteObject(key).catch(() => undefined);
    }
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.resume().catch(() => undefined);
    await moduleRef.close();

    if (originalPartSize === undefined) {
      delete process.env.VIDEO_UPLOAD_PART_SIZE_BYTES;
    } else {
      process.env.VIDEO_UPLOAD_PART_SIZE_BYTES = originalPartSize;
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(true);
  });

  async function createChannelForUser(): Promise<{
    userId: string;
    channelId: string;
  }> {
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_svc_${++counter}@example.com`,
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
    return { userId: user.id, channelId: channel.id };
  }

  const validDto = {
    title: 'Integration clip',
    filename: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 1024,
  };

  describe('initUpload', () => {
    it('persists a draft row with the multipart handle before any bytes exist', async () => {
      const { userId, channelId } = await createChannelForUser();

      const result = await videosService.initUpload(userId, validDto);
      createdKeys.push(result.storage_key);

      const persisted = await videoRepository.findOneByOrFail({
        id: result.video_id,
      });

      expect(persisted.status).toBe(VideoStatus.DRAFT);
      expect(persisted.channel_id).toBe(channelId);
      expect(persisted.title).toBe('Integration clip');
      expect(persisted.slug).toBe(result.slug);
      expect(persisted.slug).toHaveLength(11);
      expect(persisted.upload_id).toBe(result.upload_id);
      expect(persisted.storage_key).toBe(
        `videos/${result.video_id}/source.mp4`,
      );
      expect(persisted.duration_seconds).toBeNull();
      expect(persisted.thumbnail_key).toBeNull();
    });

    it('returns presigned URLs that storage actually accepts', async () => {
      const { userId } = await createChannelForUser();
      const fiveMiB = 5 * 1024 * 1024;

      const result = await videosService.initUpload(userId, {
        ...validDto,
        size_bytes: fiveMiB,
      });
      createdKeys.push(result.storage_key);

      expect(result.parts).toHaveLength(1);

      const response = await fetch(result.parts[0].url, {
        method: 'PUT',
        body: Buffer.alloc(fiveMiB, 'v'),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('etag')).toBeTruthy();
    }, 60_000);

    it('issues distinct slugs across concurrent initiations', async () => {
      const { userId } = await createChannelForUser();

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          videosService.initUpload(userId, validDto),
        ),
      );
      results.forEach((r) => createdKeys.push(r.storage_key));

      const slugs = new Set(results.map((r) => r.slug));
      expect(slugs.size).toBe(5);
    }, 60_000);

    it('rejects an oversize declaration without creating a row', async () => {
      const { userId } = await createChannelForUser();

      await expect(
        videosService.initUpload(userId, {
          ...validDto,
          size_bytes: 11 * 1024 * 1024 * 1024,
        }),
      ).rejects.toBeInstanceOf(VideoTooLargeException);

      await expect(videoRepository.count()).resolves.toBe(0);
    });

    it('rejects a user without a channel', async () => {
      const user = await userRepository.save(
        userRepository.create({
          email: `no_channel_${++counter}@example.com`,
          password: 'hashed',
        }),
      );

      await expect(
        videosService.initUpload(user.id, validDto),
      ).rejects.toBeInstanceOf(ChannelNotFoundException);

      await expect(videoRepository.count()).resolves.toBe(0);
    });
  });

  describe('completeUpload', () => {
    const FIVE_MIB = 5 * 1024 * 1024;

    /** Runs a real two-part upload and returns the handshake plus its owner. */
    async function uploadTwoParts(): Promise<{
      userId: string;
      videoId: string;
      storageKey: string;
      parts: { part_number: number; etag: string }[];
      totalBytes: number;
    }> {
      const { userId } = await createChannelForUser();
      const first = Buffer.alloc(FIVE_MIB, 'a');
      const second = Buffer.from('tail-bytes');

      const init = await videosService.initUpload(userId, {
        ...validDto,
        size_bytes: first.length + second.length,
      });
      createdKeys.push(init.storage_key);

      const parts: { part_number: number; etag: string }[] = [];
      for (const [index, part] of init.parts.entries()) {
        const response = await fetch(part.url, {
          method: 'PUT',
          body: index === 0 ? first : second,
        });
        parts.push({
          part_number: part.part_number,
          etag: response.headers.get('etag')!,
        });
      }

      return {
        userId,
        videoId: init.video_id,
        storageKey: init.storage_key,
        parts,
        totalBytes: first.length + second.length,
      };
    }

    it('assembles the object, marks the video processing and enqueues one job', async () => {
      const { userId, videoId, storageKey, parts, totalBytes } =
        await uploadTwoParts();

      const result = await videosService.completeUpload(userId, videoId, {
        parts,
      });

      expect(result.status).toBe(VideoStatus.PROCESSING);

      const persisted = await videoRepository.findOneByOrFail({ id: videoId });
      expect(persisted.status).toBe(VideoStatus.PROCESSING);
      expect(persisted.upload_id).toBeNull();

      const stored = await storageService.getObjectStream(storageKey);
      expect(stored.contentLength).toBe(totalBytes);
      stored.stream.destroy();

      const waiting = await queue.getJobs(['waiting', 'paused', 'delayed']);
      expect(waiting).toHaveLength(1);
      expect(waiting[0].data).toEqual({ videoId });
      expect(waiting[0].name).toBe('process-video');
    }, 90_000);

    it('rejects a second completion and does not enqueue twice', async () => {
      const { userId, videoId, parts } = await uploadTwoParts();

      await videosService.completeUpload(userId, videoId, { parts });

      await expect(
        videosService.completeUpload(userId, videoId, { parts }),
      ).rejects.toBeInstanceOf(InvalidVideoStateException);

      const jobs = await queue.getJobs(['waiting', 'paused', 'delayed']);
      expect(jobs).toHaveLength(1);
    }, 90_000);

    it('rejects completion by a different user', async () => {
      const { videoId, parts } = await uploadTwoParts();
      const other = await createChannelForUser();

      await expect(
        videosService.completeUpload(other.userId, videoId, { parts }),
      ).rejects.toBeInstanceOf(VideoNotOwnedException);

      const persisted = await videoRepository.findOneByOrFail({ id: videoId });
      expect(persisted.status).toBe(VideoStatus.DRAFT);
    }, 90_000);

    it('rejects an unknown video id', async () => {
      const { userId } = await createChannelForUser();

      await expect(
        videosService.completeUpload(
          userId,
          '00000000-0000-0000-0000-000000000000',
          { parts: [{ part_number: 1, etag: '"x"' }] },
        ),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });
});

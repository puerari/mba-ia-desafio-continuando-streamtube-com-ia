import { QueryFailedError } from 'typeorm';
import { Video, VideoStatus } from './entities/video.entity';
import {
  ChannelNotFoundException,
  InvalidVideoStateException,
  SlugGenerationFailedException,
  UnsupportedVideoTypeException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoTooLargeException,
} from './exceptions/video.exceptions';
import { VideosService } from './videos.service';

const TEN_GIB = 10 * 1024 * 1024 * 1024;
const SIXTY_FOUR_MIB = 64 * 1024 * 1024;

const videoConfig = {
  maxSizeBytes: TEN_GIB,
  uploadPartSizeBytes: SIXTY_FOUR_MIB,
  uploadUrlTtlSeconds: 3600,
  thumbnailPositionRatio: 0.1,
  thumbnailWidth: 1280,
};

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-id',
    slug: 'abcdefghijk',
    channel_id: 'channel-id',
    title: 'A video',
    status: VideoStatus.DRAFT,
    storage_key: '',
    thumbnail_key: null,
    original_filename: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 1024,
    duration_seconds: null,
    width: null,
    height: null,
    video_codec: null,
    bitrate: null,
    upload_id: null,
    processing_error: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Video;
}

function makeSlugViolation(): QueryFailedError {
  const error = new QueryFailedError(
    'INSERT',
    [],
    new Error(),
  ) as QueryFailedError & { code: string; detail: string };
  error.code = '23505';
  error.detail = 'Key (slug)=(abcdefghijk) already exists.';
  return error;
}

function makeRepository(overrides: Record<string, jest.Mock> = {}): any {
  return {
    create: jest.fn((entity: Partial<Video>) => makeVideo(entity)),
    save: jest.fn((entity: Video) => Promise.resolve(entity)),
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeChannelsService(channel: unknown = { id: 'channel-id' }): any {
  return { findByUserId: jest.fn().mockResolvedValue(channel) };
}

function makeStorageService(overrides: Record<string, jest.Mock> = {}): any {
  return {
    createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
    getPresignedPartUrls: jest
      .fn()
      .mockImplementation((_key, _uploadId, partCount: number) =>
        Promise.resolve(
          Array.from({ length: partCount }, (_, i) => ({
            partNumber: i + 1,
            url: `https://storage.test/part-${i + 1}`,
          })),
        ),
      ),
    ...overrides,
  };
}

function makeQueue(overrides: Record<string, jest.Mock> = {}): any {
  return {
    add: jest.fn().mockResolvedValue({ id: 'job-id' }),
    ...overrides,
  };
}

function makeService(
  overrides: {
    repository?: any;
    channels?: any;
    storage?: any;
    queue?: any;
  } = {},
): {
  service: VideosService;
  repository: any;
  channels: any;
  storage: any;
  queue: any;
} {
  const repository = overrides.repository ?? makeRepository();
  const channels = overrides.channels ?? makeChannelsService();
  const storage = overrides.storage ?? makeStorageService();
  const queue = overrides.queue ?? makeQueue();

  return {
    service: new VideosService(
      repository,
      channels,
      storage,
      videoConfig,
      queue,
    ),
    repository,
    channels,
    storage,
    queue,
  };
}

const validDto = {
  title: 'My clip',
  filename: 'clip.mp4',
  content_type: 'video/mp4',
  size_bytes: 1024,
};

describe('VideosService', () => {
  describe('initUpload', () => {
    it('rejects a file above the configured maximum before touching storage', async () => {
      const { service, storage, repository } = makeService();

      await expect(
        service.initUpload('user-id', {
          ...validDto,
          size_bytes: TEN_GIB + 1,
        }),
      ).rejects.toBeInstanceOf(VideoTooLargeException);

      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('accepts a file exactly at the configured maximum', async () => {
      const { service } = makeService();

      await expect(
        service.initUpload('user-id', { ...validDto, size_bytes: TEN_GIB }),
      ).resolves.toMatchObject({ upload_id: 'upload-id' });
    });

    it('rejects a content type outside the allowlist', async () => {
      const { service, storage } = makeService();

      await expect(
        service.initUpload('user-id', {
          ...validDto,
          content_type: 'application/zip',
        }),
      ).rejects.toBeInstanceOf(UnsupportedVideoTypeException);

      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('throws when the authenticated user has no channel', async () => {
      const { service, storage } = makeService({
        channels: makeChannelsService(null),
      });

      await expect(
        service.initUpload('user-id', validDto),
      ).rejects.toBeInstanceOf(ChannelNotFoundException);

      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('pre-registers the video as a draft owned by the user channel', async () => {
      const { service, repository } = makeService();

      await service.initUpload('user-id', validDto);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'channel-id',
          title: 'My clip',
          original_filename: 'clip.mp4',
          content_type: 'video/mp4',
          size_bytes: 1024,
        }),
      );
      // status is left to the column default — draft
      expect(repository.create.mock.calls[0][0]).not.toHaveProperty('status');
    });

    it('derives the storage key from the video id and the content type', async () => {
      const { service, storage } = makeService();

      const result = await service.initUpload('user-id', validDto);

      expect(result.storage_key).toBe('videos/video-id/source.mp4');
      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        'videos/video-id/source.mp4',
        'video/mp4',
      );
    });

    it('computes the part count from the configured part size', async () => {
      const { service } = makeService();

      const result = await service.initUpload('user-id', {
        ...validDto,
        size_bytes: SIXTY_FOUR_MIB * 2 + 1,
      });

      expect(result.part_size).toBe(SIXTY_FOUR_MIB);
      expect(result.part_count).toBe(3);
      expect(result.parts).toHaveLength(3);
      expect(result.parts.map((p) => p.part_number)).toEqual([1, 2, 3]);
    });

    it('asks storage for exactly one presigned URL per part', async () => {
      const { service, storage } = makeService();

      await service.initUpload('user-id', {
        ...validDto,
        size_bytes: SIXTY_FOUR_MIB,
      });

      expect(storage.getPresignedPartUrls).toHaveBeenCalledWith(
        'videos/video-id/source.mp4',
        'upload-id',
        1,
        3600,
      );
    });

    it('redraws the slug when the unique index rejects it', async () => {
      const repository = makeRepository({
        save: jest
          .fn()
          .mockRejectedValueOnce(makeSlugViolation())
          .mockImplementation((entity: Video) => Promise.resolve(entity)),
      });
      const { service } = makeService({ repository });

      await expect(
        service.initUpload('user-id', validDto),
      ).resolves.toMatchObject({ video_id: 'video-id' });

      // first draft attempt + successful retry + the storage_key update
      expect(repository.save).toHaveBeenCalledTimes(3);
    });

    it('gives up after the retry budget is exhausted', async () => {
      const repository = makeRepository({
        save: jest.fn().mockRejectedValue(makeSlugViolation()),
      });
      const { service } = makeService({ repository });

      await expect(
        service.initUpload('user-id', validDto),
      ).rejects.toBeInstanceOf(SlugGenerationFailedException);
    });

    it('re-throws a non-slug database error instead of retrying', async () => {
      const repository = makeRepository({
        save: jest.fn().mockRejectedValue(new Error('connection lost')),
      });
      const { service } = makeService({ repository });

      await expect(service.initUpload('user-id', validDto)).rejects.toThrow(
        'connection lost',
      );
      expect(repository.save).toHaveBeenCalledTimes(1);
    });

    it('persists the storage key and upload id on the draft', async () => {
      const { service, repository } = makeService();

      await service.initUpload('user-id', validDto);

      const lastSaved = repository.save.mock.calls.at(-1)[0] as Video;
      expect(lastSaved.storage_key).toBe('videos/video-id/source.mp4');
      expect(lastSaved.upload_id).toBe('upload-id');
    });
  });

  describe('completeUpload', () => {
    const parts = [{ part_number: 1, etag: '"abc"' }];

    const draftInStorage = (overrides: Partial<Video> = {}): Video =>
      makeVideo({
        status: VideoStatus.DRAFT,
        upload_id: 'upload-id',
        storage_key: 'videos/video-id/source.mp4',
        channel: { user_id: 'user-id' } as any,
        ...overrides,
      });

    function completing(video: Video | null) {
      const repository = makeRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const storage = makeStorageService({
        completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      });
      return makeService({ repository, storage });
    }

    it('throws when the video does not exist', async () => {
      const { service, storage } = completing(null);

      await expect(
        service.completeUpload('user-id', 'video-id', { parts }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);

      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('throws when the caller does not own the video', async () => {
      const { service, storage, queue } = completing(
        draftInStorage({ channel: { user_id: 'someone-else' } as any }),
      );

      await expect(
        service.completeUpload('user-id', 'video-id', { parts }),
      ).rejects.toBeInstanceOf(VideoNotOwnedException);

      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('throws when the video is no longer a draft', async () => {
      const { service, queue } = completing(
        draftInStorage({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.completeUpload('user-id', 'video-id', { parts }),
      ).rejects.toBeInstanceOf(InvalidVideoStateException);

      expect(queue.add).not.toHaveBeenCalled();
    });

    it('throws when the multipart handle is already cleared', async () => {
      const { service } = completing(draftInStorage({ upload_id: null }));

      await expect(
        service.completeUpload('user-id', 'video-id', { parts }),
      ).rejects.toBeInstanceOf(InvalidVideoStateException);
    });

    it('assembles the object, flips the status and clears the handle', async () => {
      const { service, storage, repository } = completing(draftInStorage());

      const result = await service.completeUpload('user-id', 'video-id', {
        parts: [
          { part_number: 2, etag: '"two"' },
          { part_number: 1, etag: '"one"' },
        ],
      });

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-id/source.mp4',
        'upload-id',
        [
          { partNumber: 2, etag: '"two"' },
          { partNumber: 1, etag: '"one"' },
        ],
      );

      const saved = repository.save.mock.calls.at(-1)[0] as Video;
      expect(saved.status).toBe(VideoStatus.PROCESSING);
      expect(saved.upload_id).toBeNull();
      expect(result).toEqual({
        id: 'video-id',
        slug: 'abcdefghijk',
        status: VideoStatus.PROCESSING,
      });
    });

    it('enqueues exactly one job carrying only the video id', async () => {
      const { service, queue } = completing(draftInStorage());

      await service.completeUpload('user-id', 'video-id', { parts });

      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith('process-video', {
        videoId: 'video-id',
      });
    });

    it('does not enqueue when the status write fails', async () => {
      const repository = makeRepository({
        findOne: jest.fn().mockResolvedValue(draftInStorage()),
        save: jest.fn().mockRejectedValue(new Error('write failed')),
      });
      const { service, queue } = makeService({
        repository,
        storage: makeStorageService({
          completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
        }),
      });

      await expect(
        service.completeUpload('user-id', 'video-id', { parts }),
      ).rejects.toThrow('write failed');

      // The job must never outrun the commit it describes.
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('does not touch the queue when storage assembly fails', async () => {
      const repository = makeRepository({
        findOne: jest.fn().mockResolvedValue(draftInStorage()),
      });
      const { service, queue } = makeService({
        repository,
        storage: makeStorageService({
          completeMultipartUpload: jest
            .fn()
            .mockRejectedValue(new Error('storage failed')),
        }),
      });

      await expect(
        service.completeUpload('user-id', 'video-id', { parts }),
      ).rejects.toThrow('storage failed');

      expect(queue.add).not.toHaveBeenCalled();
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  describe('findReadyBySlug', () => {
    const readyVideo = makeVideo({
      status: VideoStatus.READY,
      channel: { id: 'channel-id' } as any,
    });

    it('loads the video together with its channel', async () => {
      const repository = makeRepository({
        findOne: jest.fn().mockResolvedValue(readyVideo),
      });
      const { service } = makeService({ repository });

      await expect(service.findReadyBySlug('abcdefghijk')).resolves.toBe(
        readyVideo,
      );
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { slug: 'abcdefghijk' },
        relations: ['channel'],
      });
    });

    it('throws for an unknown slug', async () => {
      const repository = makeRepository({
        findOne: jest.fn().mockResolvedValue(null),
      });
      const { service } = makeService({ repository });

      await expect(
        service.findReadyBySlug('nonexistent'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'hides a %s video behind the same not-found error',
      async (status) => {
        const repository = makeRepository({
          findOne: jest.fn().mockResolvedValue(makeVideo({ status })),
        });
        const { service } = makeService({ repository });

        await expect(
          service.findReadyBySlug('abcdefghijk'),
        ).rejects.toBeInstanceOf(VideoNotFoundException);
      },
    );
  });

  describe('findByChannelUser', () => {
    it('returns the channel videos newest first', async () => {
      const videos = [makeVideo({ id: 'newer' }), makeVideo({ id: 'older' })];
      const repository = makeRepository({
        find: jest.fn().mockResolvedValue(videos),
      });
      const { service } = makeService({ repository });

      await expect(service.findByChannelUser('user-id')).resolves.toBe(videos);
      expect(repository.find).toHaveBeenCalledWith({
        where: { channel_id: 'channel-id' },
        order: { created_at: 'DESC' },
      });
    });

    it('throws when the user has no channel', async () => {
      const { service } = makeService({
        channels: makeChannelsService(null),
      });

      await expect(service.findByChannelUser('user-id')).rejects.toBeInstanceOf(
        ChannelNotFoundException,
      );
    });
  });

  describe('worker transitions', () => {
    it('markReady writes the metadata and clears any previous error', async () => {
      const repository = makeRepository({
        update: jest.fn().mockResolvedValue(undefined),
      });
      const { service } = makeService({ repository });

      await service.markReady(
        'video-id',
        {
          durationSeconds: 12.5,
          width: 1920,
          height: 1080,
          videoCodec: 'h264',
          bitrate: 1000,
        },
        'thumbnails/video-id/default.jpg',
      );

      expect(repository.update).toHaveBeenCalledWith('video-id', {
        status: VideoStatus.READY,
        duration_seconds: 12.5,
        width: 1920,
        height: 1080,
        video_codec: 'h264',
        bitrate: 1000,
        thumbnail_key: 'thumbnails/video-id/default.jpg',
        processing_error: null,
      });
    });

    it('markFailed records the reason alongside the failed status', async () => {
      const repository = makeRepository({
        update: jest.fn().mockResolvedValue(undefined),
      });
      const { service } = makeService({ repository });

      await service.markFailed('video-id', 'ffprobe exploded');

      expect(repository.update).toHaveBeenCalledWith('video-id', {
        status: VideoStatus.FAILED,
        processing_error: 'ffprobe exploded',
      });
    });

    it('findByIdOrFail throws for an unknown id', async () => {
      const repository = makeRepository({
        findOne: jest.fn().mockResolvedValue(null),
      });
      const { service } = makeService({ repository });

      await expect(service.findByIdOrFail('nope')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });
  });
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { FfmpegService } from '../src/media/ffmpeg.service';
import { createFixtureClip } from '../src/media/test-fixtures';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { videoThumbnailKey } from '../src/videos/video-storage-keys';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;
  let ffmpeg: FfmpegService;
  let workDir: string;
  let clipPath: string;
  let clipBytes: Buffer;
  let counter = 0;
  const createdKeys: string[] = [];

  const validInit = {
    title: 'My clip',
    filename: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 1024,
  };

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storageService = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    // The video-worker container listens on this same Redis. Pausing stops it
    // from picking up the jobs this suite enqueues and flipping rows to
    // ready/failed underneath the assertions.
    await queue.pause();

    ffmpeg = new FfmpegService();
    workDir = await mkdtemp(join(tmpdir(), 'videos-e2e-'));
    clipPath = join(workDir, 'fixture.mp4');
    await createFixtureClip(clipPath, {
      durationSeconds: 2,
      width: 320,
      height: 240,
    });
    clipBytes = await readFile(clipPath);
  }, 120_000);

  afterAll(async () => {
    for (const key of createdKeys) {
      await storageService.deleteObject(key).catch(() => undefined);
    }
    await rm(workDir, { recursive: true, force: true });
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.resume().catch(() => undefined);
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(true);
    // The inherited ThrottlerGuard is a global APP_GUARD with a 10 req/min
    // budget; without clearing its storage the suite trips over itself.
    throttlerStorage.storage.clear();
  });

  async function signUp(): Promise<string> {
    const email = `videos_e2e_${++counter}@example.com`;
    const password = 'password123';

    const authService = app.get(AuthService);
    const mailService = (authService as any).mailService;
    let confirmationToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        confirmationToken = t;
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken });

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    return login.body.access_token as string;
  }

  /** Runs the whole handshake: init, PUT the single part, return the handles. */
  async function uploadFile(
    token: string,
    body: Buffer = Buffer.from('fake-video-bytes'),
  ): Promise<{
    videoId: string;
    slug: string;
    parts: { part_number: number; etag: string }[];
  }> {
    const init = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validInit, size_bytes: body.length });

    createdKeys.push(init.body.storage_key);

    const parts: { part_number: number; etag: string }[] = [];
    for (const part of init.body.parts) {
      // new Uint8Array(...) because BodyInit wants a BufferSource backed by an
      // ArrayBuffer, and readFile hands back Buffer<ArrayBufferLike>.
      const response = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(body),
      });
      parts.push({
        part_number: part.part_number,
        etag: response.headers.get('etag')!,
      });
    }

    return { videoId: init.body.video_id, slug: init.body.slug, parts };
  }

  /**
   * Publishes a video the way the worker would: a real clip assembled in
   * storage, a real JPEG thumbnail, and the row flipped to `ready`.
   *
   * The worker itself is covered by `video-processing.integration-spec.ts`;
   * seeding here keeps the read-endpoint assertions deterministic instead of
   * waiting on the container that shares this Redis.
   */
  async function publishVideo(token: string): Promise<{
    videoId: string;
    slug: string;
    sizeBytes: number;
  }> {
    const { videoId, slug, parts } = await uploadFile(token, clipBytes);

    await request(app.getHttpServer())
      .post(`/videos/${videoId}/uploads/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts });

    const thumbnailPath = join(workDir, `${videoId}.jpg`);
    await ffmpeg.extractThumbnail(clipPath, thumbnailPath, 0.2, 320);
    const thumbnailKey = videoThumbnailKey(videoId);
    await storageService.putObject(
      thumbnailKey,
      await readFile(thumbnailPath),
      'image/jpeg',
    );
    createdKeys.push(thumbnailKey);

    await videoRepository.update(videoId, {
      status: VideoStatus.READY,
      duration_seconds: 2,
      width: 320,
      height: 240,
      video_codec: 'h264',
      thumbnail_key: thumbnailKey,
    });

    return { videoId, slug, sizeBytes: clipBytes.length };
  }

  describe('POST /videos/uploads', () => {
    it('returns 201 with the presigned multipart handshake', async () => {
      const token = await signUp();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send(validInit);

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        part_size: 64 * 1024 * 1024,
        part_count: 1,
        expires_in: 3600,
      });
      expect(res.body.video_id).toEqual(expect.any(String));
      expect(res.body.slug).toHaveLength(11);
      expect(res.body.upload_id).toEqual(expect.any(String));
      expect(res.body.parts).toHaveLength(1);
      expect(res.body.parts[0]).toMatchObject({ part_number: 1 });
      expect(res.body.parts[0].url).toContain('uploadId=');

      createdKeys.push(res.body.storage_key);
    });

    it('pre-registers the video as a draft at upload start', async () => {
      const token = await signUp();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send(validInit);
      createdKeys.push(res.body.storage_key);

      const persisted = await videoRepository.findOneByOrFail({
        id: res.body.video_id,
      });
      expect(persisted.status).toBe('draft');
      expect(persisted.title).toBe('My clip');
    });

    it('returns 401 without an access token', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .send(validInit);

      expect(res.status).toBe(401);
    });

    it('returns 400 when the body fails validation', async () => {
      const token = await signUp();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: '', filename: 'a.mp4', content_type: 'video/mp4' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when an unknown property is sent', async () => {
      const token = await signUp();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...validInit, visibility: 'public' });

      expect(res.status).toBe(400);
    });

    it('returns 413 VIDEO_TOO_LARGE above the configured maximum', async () => {
      const token = await signUp();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...validInit, size_bytes: 11 * 1024 * 1024 * 1024 });

      expect(res.status).toBe(413);
      expect(res.body.error).toBe('VIDEO_TOO_LARGE');
    });

    it('returns 415 UNSUPPORTED_VIDEO_TYPE for a non-video content type', async () => {
      const token = await signUp();

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...validInit, content_type: 'application/zip' });

      expect(res.status).toBe(415);
      expect(res.body.error).toBe('UNSUPPORTED_VIDEO_TYPE');
    });

    it('issues a distinct slug per upload', async () => {
      const token = await signUp();

      const first = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send(validInit);
      const second = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send(validInit);

      createdKeys.push(first.body.storage_key, second.body.storage_key);
      expect(first.body.slug).not.toBe(second.body.slug);
    });
  });

  describe('POST /videos/:id/uploads/complete', () => {
    it('returns 200 and moves the video to processing', async () => {
      const token = await signUp();
      const { videoId, parts } = await uploadFile(token);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/uploads/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: videoId, status: 'processing' });

      const persisted = await videoRepository.findOneByOrFail({ id: videoId });
      expect(persisted.status).toBe('processing');
      expect(persisted.upload_id).toBeNull();
    }, 60_000);

    it('enqueues the processing job carrying only the video id', async () => {
      const token = await signUp();
      const { videoId, parts } = await uploadFile(token);

      await request(app.getHttpServer())
        .post(`/videos/${videoId}/uploads/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts });

      const jobs = await queue.getJobs(['waiting', 'delayed']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].data).toEqual({ videoId });
    }, 60_000);

    it('returns 409 INVALID_VIDEO_STATE on a duplicate completion', async () => {
      const token = await signUp();
      const { videoId, parts } = await uploadFile(token);

      await request(app.getHttpServer())
        .post(`/videos/${videoId}/uploads/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts });

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/uploads/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('INVALID_VIDEO_STATE');

      const jobs = await queue.getJobs(['waiting', 'delayed']);
      expect(jobs).toHaveLength(1);
    }, 60_000);

    it('returns 403 VIDEO_NOT_OWNED for another user video', async () => {
      const owner = await signUp();
      const { videoId, parts } = await uploadFile(owner);
      const intruder = await signUp();

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/uploads/complete`)
        .set('Authorization', `Bearer ${intruder}`)
        .send({ parts });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('VIDEO_NOT_OWNED');
    }, 60_000);

    it('returns 404 VIDEO_NOT_FOUND for an unknown id', async () => {
      const token = await signUp();

      const res = await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/uploads/complete')
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ part_number: 1, etag: '"x"' }] });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 400 for a malformed id', async () => {
      const token = await signUp();

      const res = await request(app.getHttpServer())
        .post('/videos/not-a-uuid/uploads/complete')
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ part_number: 1, etag: '"x"' }] });

      expect(res.status).toBe(400);
    });

    it('returns 400 for an empty parts array', async () => {
      const token = await signUp();
      const { videoId } = await uploadFile(token);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/uploads/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    }, 60_000);

    it('returns 401 without an access token', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/uploads/complete')
        .send({ parts: [{ part_number: 1, etag: '"x"' }] });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /videos/me', () => {
    it('returns the caller videos in every status, newest first', async () => {
      const token = await signUp();
      const first = await uploadFile(token);
      const second = await uploadFile(token);

      const res = await request(app.getHttpServer())
        .get('/videos/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body.map((v: { id: string }) => v.id)).toEqual([
        second.videoId,
        first.videoId,
      ]);
      expect(res.body[0]).toMatchObject({ status: 'draft' });
      expect(res.body[0]).toHaveProperty('processing_error', null);
    }, 90_000);

    it('never leaks another channel videos', async () => {
      const owner = await signUp();
      await uploadFile(owner);
      const stranger = await signUp();

      const res = await request(app.getHttpServer())
        .get('/videos/me')
        .set('Authorization', `Bearer ${stranger}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    }, 60_000);

    it('resolves to the listing route rather than the slug route', async () => {
      const token = await signUp();

      const res = await request(app.getHttpServer())
        .get('/videos/me')
        .set('Authorization', `Bearer ${token}`);

      // The slug route would have answered 404 VIDEO_NOT_FOUND for "me".
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns 401 without an access token', async () => {
      const res = await request(app.getHttpServer()).get('/videos/me');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /videos/:slug', () => {
    it('returns the public projection to an anonymous caller', async () => {
      const token = await signUp();
      const { videoId, slug } = await publishVideo(token);

      const res = await request(app.getHttpServer()).get(`/videos/${slug}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: videoId,
        slug,
        status: 'ready',
        width: 320,
        height: 240,
        thumbnail_url: `/videos/${slug}/thumbnail`,
      });
      expect(res.body.channel).toMatchObject({
        nickname: expect.any(String),
      });
      // The bucket stays private: no storage URL is ever exposed.
      expect(JSON.stringify(res.body)).not.toContain('minio');
      expect(res.body).not.toHaveProperty('storage_key');
    }, 120_000);

    it('returns 404 for an unknown slug', async () => {
      const res = await request(app.getHttpServer()).get('/videos/doesnotexi');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 404 for a video that is not ready, hiding its existence', async () => {
      const token = await signUp();
      const { slug } = await uploadFile(token);

      const res = await request(app.getHttpServer()).get(`/videos/${slug}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    }, 60_000);
  });

  describe('GET /videos/:slug/thumbnail', () => {
    it('serves the generated JPEG through the API', async () => {
      const token = await signUp();
      const { slug } = await publishVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}/thumbnail`)
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('image/jpeg');
      const body = res.body as Buffer;
      expect(body.length).toBeGreaterThan(0);
      // JPEG SOI marker
      expect(body[0]).toBe(0xff);
      expect(body[1]).toBe(0xd8);
    }, 120_000);

    it('returns 404 for a video that is not ready', async () => {
      const token = await signUp();
      const { slug } = await uploadFile(token);

      const res = await request(app.getHttpServer()).get(
        `/videos/${slug}/thumbnail`,
      );

      expect(res.status).toBe(404);
    }, 60_000);
  });

  describe('GET /videos/:slug/stream', () => {
    const asBuffer = (req: request.Test) =>
      req.buffer(true).parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    it('returns 206 with exactly the requested byte range', async () => {
      const token = await signUp();
      const { slug, sizeBytes } = await publishVideo(token);

      const res = await asBuffer(
        request(app.getHttpServer())
          .get(`/videos/${slug}/stream`)
          .set('Range', 'bytes=0-99'),
      );

      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes 0-99/${sizeBytes}`);
      expect(res.headers['content-length']).toBe('100');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect((res.body as Buffer).length).toBe(100);
    }, 120_000);

    it('returns the exact bytes the range asked for', async () => {
      const token = await signUp();
      const { slug } = await publishVideo(token);

      const res = await asBuffer(
        request(app.getHttpServer())
          .get(`/videos/${slug}/stream`)
          .set('Range', 'bytes=10-19'),
      );

      expect(res.status).toBe(206);
      expect((res.body as Buffer).equals(clipBytes.subarray(10, 20))).toBe(
        true,
      );
    }, 120_000);

    it('returns 200 with the whole body when no Range is sent', async () => {
      const token = await signUp();
      const { slug, sizeBytes } = await publishVideo(token);

      const res = await asBuffer(
        request(app.getHttpServer()).get(`/videos/${slug}/stream`),
      );

      expect(res.status).toBe(200);
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-length']).toBe(String(sizeBytes));
      expect((res.body as Buffer).length).toBe(sizeBytes);
    }, 120_000);

    it('serves an open-ended range to the end of the file', async () => {
      const token = await signUp();
      const { slug, sizeBytes } = await publishVideo(token);

      const res = await asBuffer(
        request(app.getHttpServer())
          .get(`/videos/${slug}/stream`)
          .set('Range', `bytes=${sizeBytes - 10}-`),
      );

      expect(res.status).toBe(206);
      expect((res.body as Buffer).length).toBe(10);
    }, 120_000);

    it('returns 416 with the current length for an out-of-bounds range', async () => {
      const token = await signUp();
      const { slug, sizeBytes } = await publishVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .set('Range', `bytes=${sizeBytes + 1000}-`);

      expect(res.status).toBe(416);
      expect(res.headers['content-range']).toBe(`bytes */${sizeBytes}`);
    }, 120_000);

    it('works anonymously and is not rate limited', async () => {
      const token = await signUp();
      const { slug } = await publishVideo(token);

      // Well past the inherited 10 req/min throttle budget.
      for (let i = 0; i < 15; i++) {
        const res = await request(app.getHttpServer())
          .get(`/videos/${slug}/stream`)
          .set('Range', 'bytes=0-9');
        expect(res.status).toBe(206);
      }
    }, 120_000);

    it('returns 404 for a video that is not ready', async () => {
      const token = await signUp();
      const { slug } = await uploadFile(token);

      const res = await request(app.getHttpServer()).get(
        `/videos/${slug}/stream`,
      );

      expect(res.status).toBe(404);
    }, 60_000);
  });

  describe('GET /videos/:slug/download', () => {
    it('serves the file as an attachment named after the title', async () => {
      const token = await signUp();
      const { slug, sizeBytes } = await publishVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${slug}/download`)
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="My-clip.mp4"',
      );
      expect((res.body as Buffer).length).toBe(sizeBytes);
      expect((res.body as Buffer).equals(clipBytes)).toBe(true);
    }, 120_000);

    it('returns 404 for a video that is not ready', async () => {
      const token = await signUp();
      const { slug } = await uploadFile(token);

      const res = await request(app.getHttpServer()).get(
        `/videos/${slug}/download`,
      );

      expect(res.status).toBe(404);
    }, 60_000);
  });
});

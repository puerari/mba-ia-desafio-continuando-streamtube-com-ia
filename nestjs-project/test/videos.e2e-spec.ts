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
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;
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
  }, 60_000);

  afterAll(async () => {
    for (const key of createdKeys) {
      await storageService.deleteObject(key).catch(() => undefined);
    }
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
      const response = await fetch(part.url, { method: 'PUT', body });
      parts.push({
        part_number: part.part_number,
        etag: response.headers.get('etag')!,
      });
    }

    return { videoId: init.body.video_id, slug: init.body.slug, parts };
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

      const jobs = await queue.getJobs(['waiting', 'paused', 'delayed']);
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

      const jobs = await queue.getJobs(['waiting', 'paused', 'delayed']);
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
});

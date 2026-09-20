import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';
import type { UploadedPart } from './storage.types';

/**
 * Exercises the real MinIO container from Compose. Mocking the S3 client here
 * would prove nothing: the failures this adapter is exposed to — presigned
 * signature mismatches, path-style addressing, range semantics — only appear
 * against a real S3 implementation.
 */
describe('StorageService (integration)', () => {
  const MIN_PART_SIZE = 5 * 1024 * 1024; // S3 floor for every part but the last
  let moduleRef: TestingModule;
  let storage: StorageService;
  const createdKeys: string[] = [];

  const readAll = async (
    stream: NodeJS.ReadableStream,
  ): Promise<Buffer<ArrayBuffer>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks) as Buffer<ArrayBuffer>;
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    // init() runs onModuleInit, which is where ensureBucket lives.
    await moduleRef.init();
    storage = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await storage.deleteObject(key).catch(() => undefined);
    }
    await moduleRef.close();
  });

  const trackKey = (key: string): string => {
    createdKeys.push(key);
    return key;
  };

  describe('ensureBucket', () => {
    it('is idempotent — a second call on an existing bucket is a no-op', async () => {
      await expect(storage.ensureBucket()).resolves.toBeUndefined();
      await expect(storage.ensureBucket()).resolves.toBeUndefined();
    });
  });

  describe('putObject / objectExists / deleteObject', () => {
    it('writes, reports existence, and removes an object', async () => {
      const key = trackKey(`test/${randomUUID()}/simple.txt`);

      await storage.putObject(key, Buffer.from('hello'), 'text/plain');
      await expect(storage.objectExists(key)).resolves.toBe(true);

      await storage.deleteObject(key);
      await expect(storage.objectExists(key)).resolves.toBe(false);
    });
  });

  describe('multipart upload through presigned URLs', () => {
    it('initialises, presigns, uploads each part and completes into a readable object', async () => {
      const key = trackKey(`test/${randomUUID()}/multipart.bin`);
      const firstPart = Buffer.alloc(MIN_PART_SIZE, 'a');
      const secondPart = Buffer.alloc(1024, 'b');
      const expected = Buffer.concat([firstPart, secondPart]);

      const uploadId = await storage.createMultipartUpload(
        key,
        'application/octet-stream',
      );
      expect(uploadId).toBeTruthy();

      const presigned = await storage.getPresignedPartUrls(
        key,
        uploadId,
        2,
        3600,
      );
      expect(presigned).toHaveLength(2);
      expect(presigned.map((p) => p.partNumber)).toEqual([1, 2]);

      const uploaded: UploadedPart[] = [];
      for (const [index, part] of presigned.entries()) {
        const body = index === 0 ? firstPart : secondPart;
        const response = await fetch(part.url, { method: 'PUT', body });
        expect(response.status).toBe(200);

        const etag = response.headers.get('etag');
        expect(etag).toBeTruthy();
        uploaded.push({ partNumber: part.partNumber, etag: etag! });
      }

      await storage.completeMultipartUpload(key, uploadId, uploaded);

      const { stream, contentLength } = await storage.getObjectStream(key);
      const body = await readAll(stream);

      expect(contentLength).toBe(expected.length);
      expect(body.length).toBe(expected.length);
      expect(body.equals(expected)).toBe(true);
    }, 60_000);

    it('accepts parts supplied out of order and still assembles them correctly', async () => {
      const key = trackKey(`test/${randomUUID()}/ordered.bin`);
      const firstPart = Buffer.alloc(MIN_PART_SIZE, 'x');
      const secondPart = Buffer.from('tail');

      const uploadId = await storage.createMultipartUpload(
        key,
        'application/octet-stream',
      );
      const presigned = await storage.getPresignedPartUrls(
        key,
        uploadId,
        2,
        3600,
      );

      const uploaded: UploadedPart[] = [];
      for (const [index, part] of presigned.entries()) {
        const response = await fetch(part.url, {
          method: 'PUT',
          body: index === 0 ? firstPart : secondPart,
        });
        uploaded.push({
          partNumber: part.partNumber,
          etag: response.headers.get('etag')!,
        });
      }

      await storage.completeMultipartUpload(key, uploadId, uploaded.reverse());

      const { stream } = await storage.getObjectStream(key);
      const body = await readAll(stream);
      expect(body.subarray(-4).toString()).toBe('tail');
    }, 60_000);

    it('abortMultipartUpload discards an unfinished upload', async () => {
      const key = `test/${randomUUID()}/aborted.bin`;
      const uploadId = await storage.createMultipartUpload(
        key,
        'application/octet-stream',
      );

      await expect(
        storage.abortMultipartUpload(key, uploadId),
      ).resolves.toBeUndefined();
      await expect(storage.objectExists(key)).resolves.toBe(false);
    });
  });

  describe('getObjectStream', () => {
    const payload = Buffer.from('0123456789abcdefghij');
    let key: string;

    beforeAll(async () => {
      key = trackKey(`test/${randomUUID()}/ranged.txt`);
      await storage.putObject(key, payload, 'text/plain');
    });

    it('returns the whole object when no range is given', async () => {
      const result = await storage.getObjectStream(key);

      expect(result.contentLength).toBe(payload.length);
      expect(result.totalLength).toBe(payload.length);
      expect(result.contentRange).toBeUndefined();
      expect((await readAll(result.stream)).equals(payload)).toBe(true);
    });

    it('returns only the requested slice and reports the full size', async () => {
      const result = await storage.getObjectStream(key, 'bytes=0-9');

      expect(result.contentLength).toBe(10);
      expect(result.contentRange).toBe(`bytes 0-9/${payload.length}`);
      // totalLength must come from ContentRange, not from the slice length
      expect(result.totalLength).toBe(payload.length);
      expect((await readAll(result.stream)).toString()).toBe('0123456789');
    });

    it('supports an open-ended range', async () => {
      const result = await storage.getObjectStream(key, 'bytes=10-');

      expect(result.contentLength).toBe(payload.length - 10);
      expect(result.totalLength).toBe(payload.length);
      expect((await readAll(result.stream)).toString()).toBe('abcdefghij');
    });

    it('propagates a missing-key error instead of returning an empty result', async () => {
      await expect(
        storage.getObjectStream(`test/${randomUUID()}/missing.txt`),
      ).rejects.toThrow();
    });
  });

  describe('downloadToFile', () => {
    it('streams an object onto the local filesystem', async () => {
      const key = trackKey(`test/${randomUUID()}/download.txt`);
      const payload = Buffer.from('downloaded-content');
      await storage.putObject(key, payload, 'text/plain');

      const dir = await mkdtemp(join(tmpdir(), 'storage-test-'));
      const destination = join(dir, 'out.txt');

      try {
        await storage.downloadToFile(key, destination);
        expect((await readFile(destination)).equals(payload)).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

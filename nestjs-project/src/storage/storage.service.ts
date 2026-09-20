import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3_CLIENT } from './storage.constants';
import type {
  ObjectStreamResult,
  PresignedPart,
  UploadedPart,
} from './storage.types';

/**
 * Generic S3-compatible object storage port. Knows nothing about videos — the
 * key layout is owned by the domain module that stores the objects.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(S3_CLIENT) private readonly client: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  /** Creates the configured bucket when it does not exist yet. Idempotent. */
  async ensureBucket(): Promise<void> {
    const Bucket = this.config.bucket;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket }));
      this.logger.log(`Created storage bucket "${Bucket}"`);
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const response = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );

    if (!response.UploadId) {
      throw new Error(`Storage did not return an UploadId for key "${key}"`);
    }

    return response.UploadId;
  }

  /**
   * One presigned `UploadPart` URL per part, in ascending order. Part numbers
   * are 1-based, per the S3 API.
   */
  async getPresignedPartUrls(
    key: string,
    uploadId: string,
    partCount: number,
    expiresInSeconds: number,
  ): Promise<PresignedPart[]> {
    const parts: PresignedPart[] = [];

    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const url = await getSignedUrl(
        this.client,
        new UploadPartCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: expiresInSeconds },
      );
      parts.push({ partNumber, url });
    }

    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);

    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: ordered.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /**
   * Reads an object, optionally a byte range. The caller's `Range` header is
   * forwarded verbatim; storage does the range arithmetic.
   *
   * The returned stream MUST be consumed or destroyed — an unread S3 body
   * holds its socket open and eventually exhausts the connection pool.
   */
  async getObjectStream(
    key: string,
    range?: string,
  ): Promise<ObjectStreamResult> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ...(range ? { Range: range } : {}),
      }),
    );

    const contentLength = response.ContentLength ?? 0;

    return {
      stream: response.Body as Readable,
      contentLength,
      // On a ranged read ContentLength is the slice size, so the true object
      // size has to come out of `bytes <start>-<end>/<total>`.
      totalLength: parseTotalLength(response.ContentRange) ?? contentLength,
      contentRange: response.ContentRange,
      contentType: response.ContentType,
    };
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }

  /** Size of an object in bytes, without fetching its body. */
  async getObjectSize(key: string): Promise<number> {
    const response = await this.client.send(
      new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    return response.ContentLength ?? 0;
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Streams an object to a local file. The worker stages the source this way
   * because ffprobe needs random access to read container metadata.
   */
  async downloadToFile(key: string, destinationPath: string): Promise<void> {
    const { stream } = await this.getObjectStream(key);
    await pipeline(stream, createWriteStream(destinationPath));
  }
}

/** Extracts `<total>` from a `bytes <start>-<end>/<total>` header. */
function parseTotalLength(contentRange?: string): number | undefined {
  if (!contentRange) return undefined;
  const total = contentRange.split('/')[1];
  if (!total || total === '*') return undefined;
  const parsed = Number(total);
  return Number.isFinite(parsed) ? parsed : undefined;
}

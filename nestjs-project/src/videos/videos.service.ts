import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isUniqueViolationOnColumn } from '../common/database/pg-error.util';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitUploadDto } from './dto/init-upload.dto';
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
import type { VideoProcessingJobData } from './processing/video-processing.types';
import {
  ALLOWED_VIDEO_CONTENT_TYPES,
  CONTENT_TYPE_EXTENSIONS,
  VIDEO_PROCESSING_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';
import { generateVideoSlug, MAX_SLUG_ATTEMPTS } from './video-slug.util';
import { videoSourceKey } from './video-storage-keys';

const SLUG_COLUMN = 'slug';

export interface InitUploadResult {
  video_id: string;
  slug: string;
  upload_id: string;
  storage_key: string;
  part_size: number;
  part_count: number;
  expires_in: number;
  parts: { part_number: number; url: string }[];
}

export interface CompleteUploadResult {
  id: string;
  slug: string;
  status: VideoStatus;
}

/** Metadata the worker extracts and hands back on success. */
export interface VideoProcessingMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  bitrate: number | null;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue<VideoProcessingJobData>,
  ) {}

  /**
   * Opens the upload handshake: validates the declared file, pre-registers the
   * video as a draft, opens the multipart upload in storage and hands back one
   * presigned URL per part.
   *
   * No file bytes reach the API — the client uploads parts straight to storage.
   */
  async initUpload(
    userId: string,
    dto: InitUploadDto,
  ): Promise<InitUploadResult> {
    if (dto.size_bytes > this.config.maxSizeBytes) {
      throw new VideoTooLargeException();
    }

    if (!this.isAllowedContentType(dto.content_type)) {
      throw new UnsupportedVideoTypeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const video = await this.createDraft(channel.id, dto);

    const extension = CONTENT_TYPE_EXTENSIONS[dto.content_type];
    const storageKey = videoSourceKey(video.id, extension);
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.content_type,
    );

    video.storage_key = storageKey;
    video.upload_id = uploadId;
    await this.videoRepository.save(video);

    const partSize = this.config.uploadPartSizeBytes;
    const partCount = Math.ceil(dto.size_bytes / partSize);
    const expiresIn = this.config.uploadUrlTtlSeconds;

    const parts = await this.storageService.getPresignedPartUrls(
      storageKey,
      uploadId,
      partCount,
      expiresIn,
    );

    return {
      video_id: video.id,
      slug: video.slug,
      upload_id: uploadId,
      storage_key: storageKey,
      part_size: partSize,
      part_count: partCount,
      expires_in: expiresIn,
      parts: parts.map((part) => ({
        part_number: part.partNumber,
        url: part.url,
      })),
    };
  }

  /**
   * Closes the handshake: assembles the object in storage, moves the video to
   * `processing` and queues it for the worker.
   *
   * The job is enqueued only after the status write commits. Redis does not
   * participate in the database transaction, so enqueueing first could hand
   * the worker a video the database still calls a draft.
   */
  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    if (video.channel.user_id !== userId) {
      throw new VideoNotOwnedException();
    }

    // Guards a duplicate completion: a second call finds the video already out
    // of `draft` and stops before touching storage or the queue.
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new InvalidVideoStateException();
    }

    await this.storageService.completeMultipartUpload(
      video.storage_key,
      video.upload_id,
      dto.parts.map((part) => ({
        partNumber: part.part_number,
        etag: part.etag,
      })),
    );

    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    await this.videoRepository.save(video);

    await this.processingQueue.add(VIDEO_PROCESSING_JOB, {
      videoId: video.id,
    });

    return { id: video.id, slug: video.slug, status: video.status };
  }

  /** Loads a video for the worker, which addresses it by id. */
  async findByIdOrFail(videoId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    return video;
  }

  /** Terminal success transition, written by the worker. */
  async markReady(
    videoId: string,
    metadata: VideoProcessingMetadata,
    thumbnailKey: string,
  ): Promise<void> {
    await this.videoRepository.update(videoId, {
      status: VideoStatus.READY,
      duration_seconds: metadata.durationSeconds,
      width: metadata.width,
      height: metadata.height,
      video_codec: metadata.videoCodec,
      bitrate: metadata.bitrate,
      thumbnail_key: thumbnailKey,
      processing_error: null,
    });
  }

  /**
   * Terminal failure transition. Only called once BullMQ has exhausted its
   * attempts — while retries remain the row must keep saying `processing`.
   */
  async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videoRepository.update(videoId, {
      status: VideoStatus.FAILED,
      processing_error: reason,
    });
  }

  private isAllowedContentType(contentType: string): boolean {
    return (ALLOWED_VIDEO_CONTENT_TYPES as readonly string[]).includes(
      contentType,
    );
  }

  /**
   * Persists the draft, redrawing the slug on a unique violation. The database
   * index is the authoritative guarantee of uniqueness; this loop only decides
   * how many times we redraw before giving up.
   *
   * `storage_key` is filled in right after, once the generated id is known.
   */
  private async createDraft(
    channelId: string,
    dto: InitUploadDto,
  ): Promise<Video> {
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            slug: generateVideoSlug(),
            channel_id: channelId,
            title: dto.title,
            storage_key: '',
            original_filename: dto.filename,
            content_type: dto.content_type,
            size_bytes: dto.size_bytes,
          }),
        );
      } catch (error) {
        if (!isUniqueViolationOnColumn(error, SLUG_COLUMN)) {
          throw error;
        }
      }
    }

    throw new SlugGenerationFailedException();
  }
}

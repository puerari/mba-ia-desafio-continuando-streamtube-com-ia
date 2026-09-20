import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitUploadDto } from './dto/init-upload.dto';
import {
  OwnedVideoResponseDto,
  VideoResponseDto,
} from './dto/video-response.dto';
import {
  RangeNotSatisfiableException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';
import { formatContentRange, parseRangeHeader } from './http-range.util';
import type { ByteRange } from './http-range.util';
import { CONTENT_TYPE_EXTENSIONS } from './videos.constants';
import { VideosService } from './videos.service';
import type { CompleteUploadResult, InitUploadResult } from './videos.service';

/** Keeps a title usable as a filename in a Content-Disposition header. */
function toSafeFilename(title: string): string {
  const cleaned = title
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 100);
  return cleaned.length > 0 ? cleaned : 'video';
}

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
  ) {}

  @Post('uploads')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft and returns a presigned multipart upload handshake. The file itself never passes through the API — the client uploads each part straight to object storage.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    schema: {
      properties: {
        video_id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        upload_id: { type: 'string' },
        storage_key: { type: 'string' },
        part_size: { type: 'integer' },
        part_count: { type: 'integer' },
        expires_in: { type: 'integer' },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              part_number: { type: 'integer' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'The authenticated user has no channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Video exceeds the maximum allowed size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'Unsupported video content type',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitUploadDto,
  ): Promise<InitUploadResult> {
    return this.videosService.initUpload(user.sub, dto);
  }

  @Post(':id/uploads/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Finish a video upload',
    description:
      'Assembles the uploaded parts into the final object and queues the video for processing. The video moves from draft to processing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed and processing queued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in a state that allows completion',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(user.sub, id, dto);
  }

  // Declared before @Get(':slug'): Express matches in declaration order and
  // would otherwise read "me" as a slug.
  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List the authenticated channel videos',
    description:
      'Returns the caller own videos in every status, newest first, including the processing error of a failed one.',
  })
  @ApiOkResponse({ type: [OwnedVideoResponseDto] })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'The authenticated user has no channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listOwn(
    @CurrentUser() user: JwtPayload,
  ): Promise<OwnedVideoResponseDto[]> {
    const videos = await this.videosService.findByChannelUser(user.sub);
    return videos.map((video) => OwnedVideoResponseDto.fromEntity(video));
  }

  @Public()
  @Get(':slug')
  @ApiParam({ name: 'slug', example: 'aB3dEfGhIjK' })
  @ApiOperation({
    summary: 'Get a published video',
    description:
      'Public metadata for a ready video. A video that is still processing answers 404, exactly like an unknown slug.',
  })
  @ApiOkResponse({ type: VideoResponseDto })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findBySlug(@Param('slug') slug: string): Promise<VideoResponseDto> {
    return VideoResponseDto.fromEntity(
      await this.videosService.findReadyBySlug(slug),
    );
  }

  @Public()
  @SkipThrottle()
  @Get(':slug/thumbnail')
  @ApiParam({ name: 'slug', example: 'aB3dEfGhIjK' })
  @ApiOperation({
    summary: 'Get the generated thumbnail',
    description:
      'Streams the JPEG generated during processing. The storage bucket stays private — the image is always served through the API.',
  })
  @ApiResponse({ status: 200, description: 'JPEG image' })
  @ApiResponse({
    status: 404,
    description: 'Video not found, not ready, or without a thumbnail',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async streamThumbnail(
    @Param('slug') slug: string,
    @Res() res: Response,
  ): Promise<void> {
    const video = await this.videosService.findReadyBySlug(slug);
    if (!video.thumbnail_key) {
      throw new VideoNotFoundException();
    }

    const object = await this.storageService.getObjectStream(
      video.thumbnail_key,
    );

    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', object.contentType ?? 'image/jpeg');
    res.setHeader('Content-Length', object.contentLength);
    res.setHeader('Cache-Control', 'public, max-age=86400');

    this.pipeAndCleanUp(object.stream, res);
  }

  @Public()
  @SkipThrottle()
  @Get(':slug/stream')
  @ApiParam({ name: 'slug', example: 'aB3dEfGhIjK' })
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Honours HTTP Range so playback starts without downloading the whole file. A request with a Range answers 206 Partial Content; without one, 200 with the full body.',
  })
  @ApiResponse({ status: 200, description: 'Full video body' })
  @ApiResponse({ status: 206, description: 'Requested byte range' })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 416,
    description: 'Requested range is not satisfiable',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async streamVideo(
    @Param('slug') slug: string,
    @Headers('range') rangeHeader: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const video = await this.videosService.findReadyBySlug(slug);
    const totalLength = await this.storageService.getObjectSize(
      video.storage_key,
    );

    let range: ByteRange | null;
    try {
      range = parseRangeHeader(rangeHeader, totalLength);
    } catch (error) {
      if (error instanceof RangeNotSatisfiableException) {
        // RFC 9110: a 416 must state the current length. Headers set here
        // survive into the response the domain exception filter writes.
        res.setHeader('Content-Range', `bytes */${totalLength}`);
        res.setHeader('Accept-Ranges', 'bytes');
      }
      throw error;
    }

    const object = await this.storageService.getObjectStream(
      video.storage_key,
      range ? `bytes=${range.start}-${range.end}` : undefined,
    );

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', object.contentType ?? video.content_type);

    if (range) {
      res.status(HttpStatus.PARTIAL_CONTENT);
      res.setHeader('Content-Range', formatContentRange(range, totalLength));
      res.setHeader('Content-Length', range.end - range.start + 1);
    } else {
      res.status(HttpStatus.OK);
      res.setHeader('Content-Length', totalLength);
    }

    this.pipeAndCleanUp(object.stream, res);
  }

  @Public()
  @SkipThrottle()
  @Get(':slug/download')
  @ApiParam({ name: 'slug', example: 'aB3dEfGhIjK' })
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Serves the stored file as an attachment, with a filename derived from the video title.',
  })
  @ApiResponse({ status: 200, description: 'Video file as an attachment' })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async downloadVideo(
    @Param('slug') slug: string,
    @Res() res: Response,
  ): Promise<void> {
    const video = await this.videosService.findReadyBySlug(slug);
    const object = await this.storageService.getObjectStream(video.storage_key);

    const extension = CONTENT_TYPE_EXTENSIONS[video.content_type] ?? '';
    const filename = `${toSafeFilename(video.title)}${extension}`;

    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', object.contentType ?? video.content_type);
    res.setHeader('Content-Length', object.contentLength);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    this.pipeAndCleanUp(object.stream, res);
  }

  /**
   * Pipes a storage body to the response and destroys it if the client goes
   * away. An unconsumed S3 stream holds its socket open, and a handful of
   * abandoned seeks would exhaust the connection pool.
   */
  private pipeAndCleanUp(stream: NodeJS.ReadableStream, res: Response): void {
    const source = stream as NodeJS.ReadableStream & {
      destroy?: (error?: Error) => void;
    };

    res.on('close', () => {
      if (!res.writableEnded) {
        source.destroy?.();
      }
    });

    source.pipe(res);
  }
}

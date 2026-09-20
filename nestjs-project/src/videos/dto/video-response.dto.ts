import { ApiProperty } from '@nestjs/swagger';
import { Video, VideoStatus } from '../entities/video.entity';

class VideoChannelDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'johndoe' })
  nickname: string;

  @ApiProperty({ example: 'John Doe' })
  name: string;
}

/** Public projection of a ready video. Never exposes a storage URL. */
export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aB3dEfGhIjK' })
  slug: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.READY })
  status: VideoStatus;

  @ApiProperty({ nullable: true, example: 128.5 })
  duration_seconds: number | null;

  @ApiProperty({ nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({
    description: 'API route that serves the generated thumbnail',
    example: '/videos/aB3dEfGhIjK/thumbnail',
  })
  thumbnail_url: string;

  @ApiProperty({ type: VideoChannelDto })
  channel: VideoChannelDto;

  @ApiProperty()
  created_at: Date;

  static fromEntity(video: Video): VideoResponseDto {
    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      duration_seconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      // Points at this API, not at the bucket: storage stays private.
      thumbnail_url: `/videos/${video.slug}/thumbnail`,
      channel: {
        id: video.channel.id,
        nickname: video.channel.nickname,
        name: video.channel.name,
      },
      created_at: video.created_at,
    };
  }
}

/** Owner-facing projection: includes non-ready videos and the failure reason. */
export class OwnedVideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  slug: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ nullable: true })
  duration_seconds: number | null;

  @ApiProperty({ nullable: true })
  processing_error: string | null;

  @ApiProperty()
  created_at: Date;

  static fromEntity(video: Video): OwnedVideoResponseDto {
    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      duration_seconds: video.duration_seconds,
      processing_error: video.processing_error,
      created_at: video.created_at,
    };
  }
}

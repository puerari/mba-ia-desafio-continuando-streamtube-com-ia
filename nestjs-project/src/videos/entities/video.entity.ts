import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

/**
 * Postgres returns `bigint` and `numeric` as strings to avoid silent precision
 * loss. Both columns here are comfortably inside Number.MAX_SAFE_INTEGER
 * (10GiB is ~1.07e10), so a transformer keeps the entity's public shape
 * numeric instead of leaking the driver's representation.
 */
const numericTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Public URL identifier — see video-slug.util.ts. */
  @Column({ type: 'varchar', length: 16, unique: true })
  slug: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Index()
  @Column({ type: 'enum', enum: VideoStatus, default: VideoStatus.DRAFT })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 512 })
  storage_key: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 128 })
  content_type: string;

  @Column({ type: 'bigint', transformer: numericTransformer })
  size_bytes: number;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 3,
    nullable: true,
    transformer: numericTransformer,
  })
  duration_seconds: number | null;

  @Column({ type: 'int', nullable: true })
  width: number | null;

  @Column({ type: 'int', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  video_codec: string | null;

  @Column({ type: 'int', nullable: true })
  bitrate: number | null;

  /** S3 multipart handle; cleared once the upload is completed. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  /** Written only after the retry budget is exhausted — see TD-08. */
  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
